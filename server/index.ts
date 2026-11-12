import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { deleteBoard, deleteExpiredRooms, deleteRoom, listBoards, listReferencedMediaUrls, loadBoard, loadLatestBoard, loadRoom, saveBoard, saveRoom } from './persistence.ts'
import { isStoredMediaUrl, mediaContentType, readStoredMedia, removeOrphanedMedia, removeStoredMedia, storeDataUrl } from './media.ts'

type Team = { id: string; name: string; score: number; connected: boolean }
type Client = { socket: WebSocket; role: 'host' | 'board' | 'team'; teamId?: string; roomCode?: string }
type Room = {
  code: string
  hostId: string | null
  gameName: string
  gameStarted: boolean
  round: 1 | 2 | 3
  boardControlTeamId: string | null
  teams: Team[]
  activeQuestionId: string | null
  playedQuestionIds: string[]
  buzzerOpen: boolean
  buzzes: { teamId: string; receivedAt: number }[]
  lockedOutTeamIds: string[]
  mediaByQuestion: Record<string, { type: 'image' | 'video'; url: string }>
  timerExpiresAt: number | null
  timer?: ReturnType<typeof setTimeout>
  boardId: string
  categories: unknown
  questionSets: unknown
  finalCategory: string
  finalPrompt: string
  finalRevealed: boolean
  finalWagers: Record<string, number>
  finalAnswers: Record<string, string>
  finalScoredTeamIds: string[]
}

type Message =
  | { type: 'room:create' }
  | { type: 'room:join'; code: string; role: Client['role']; teamId?: string; name?: string }
  | { type: 'game:start'; gameName?: string }
  | { type: 'round:set'; round: 1 | 2 | 3 }
  | { type: 'question:open'; questionId: string }
  | { type: 'question:resolve'; questionId: string; teamId: string; points: number; correct: boolean }
  | { type: 'buzzer:open'; questionId: string }
  | { type: 'buzzer:press'; teamId: string }
  | { type: 'buzzer:close' }
  | { type: 'question:media'; questionId: string; media?: { type: 'image' | 'video'; url: string } }
  | { type: 'board:sync'; boardId: string; gameName: string; categories: unknown; questionSets: unknown }
  | { type: 'board:list' }
  | { type: 'board:load'; boardId: string }
  | { type: 'board:delete'; boardId: string }
  | { type: 'final:setup'; category: string; prompt: string; answer: string }
  | { type: 'final:wager'; amount: number }
  | { type: 'final:reveal' }
  | { type: 'final:answer'; answer: string }
  | { type: 'final:score'; teamId: string; correct: boolean }
  | { type: 'team:score'; teamId: string; score: number }
  | { type: 'room:end' }

const rooms = new Map<string, Room>()
const clients = new Map<string, Client>()
const MAX_MEDIA_URL_LENGTH = 8 * 1024 * 1024

function send(socket: WebSocket, type: string, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, payload }))
}

function roomState(room: Room) {
  return {
    code: room.code,
    teams: room.teams,
    activeQuestionId: room.activeQuestionId,
    gameName: room.gameName,
    gameStarted: room.gameStarted,
    round: room.round,
    boardControlTeamId: room.boardControlTeamId,
    playedQuestionIds: room.playedQuestionIds,
    buzzerOpen: room.buzzerOpen,
    firstBuzz: room.buzzes[0] ?? null,
    lockedOutTeamIds: room.lockedOutTeamIds,
    mediaByQuestion: room.mediaByQuestion,
    finalCategory: room.finalCategory,
    finalPrompt: room.finalRevealed ? room.finalPrompt : '',
    finalRevealed: room.finalRevealed,
    finalScoredTeamIds: room.finalScoredTeamIds,
    finalWinnerId: room.finalScoredTeamIds.length === room.teams.length && room.teams.length > 0
      ? [...room.teams].sort((a, b) => b.score - a.score)[0]?.id ?? null
      : null,
    timerExpiresAt: room.timerExpiresAt,
    boardId: room.boardId,
    categories: room.categories,
    questionSets: room.questionSets,
  }
}

function persistRoom(room: Room) {
  saveRoom({
    code: room.code,
    boardId: room.boardId,
    gameName: room.gameName,
    gameStarted: room.gameStarted,
    round: room.round,
    boardControlTeamId: room.boardControlTeamId,
    teams: room.teams,
    playedQuestionIds: room.playedQuestionIds,
    mediaByQuestion: room.mediaByQuestion,
    finalCategory: room.finalCategory,
    finalPrompt: room.finalPrompt,
    finalRevealed: room.finalRevealed,
    finalWagers: room.finalWagers,
    finalScoredTeamIds: room.finalScoredTeamIds,
    finalAnswers: room.finalAnswers,
  })
}

function broadcast(room: Room, type: string, payload: unknown) {
  for (const client of clients.values()) {
    if (client.socket.readyState === WebSocket.OPEN) send(client.socket, type, payload)
  }
}

function clearQuestionTimer(room: Room) {
  if (room.timer) clearTimeout(room.timer)
  room.timer = undefined
  room.timerExpiresAt = null
}

function resetFinal(room: Room) {
  room.finalCategory = 'Final Jeopardy'
  room.finalPrompt = ''
  room.finalRevealed = false
  room.finalWagers = {}
  room.finalAnswers = {}
  room.finalScoredTeamIds = []
}

function expireQuestion(room: Room, questionId: string) {
  if (room.activeQuestionId !== questionId) return
  clearQuestionTimer(room)
  if (!room.playedQuestionIds.includes(questionId)) room.playedQuestionIds.push(questionId)
  room.activeQuestionId = null
  room.buzzerOpen = false
  room.buzzes = []
  room.lockedOutTeamIds = []
  broadcast(room, 'room:state', roomState(room))
  persistRoom(room)
}

function getRoom(code: string) {
  return rooms.get(code.replace(/-/g, '').toUpperCase())
}

function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  do {
    const bytes = randomBytes(6)
    code = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
  } while (rooms.has(code))
  return code
}

const ROOM_RETENTION_DAYS = Number(process.env.ROOM_RETENTION_DAYS ?? 30)

function cleanupRooms() {
  const cutoff = new Date(Date.now() - ROOM_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const expiredCodes = deleteExpiredRooms(cutoff)
  for (const code of expiredCodes) rooms.delete(code)
  removeOrphanedMedia(listReferencedMediaUrls())
}

cleanupRooms()
setInterval(cleanupRooms, 60 * 60 * 1000)

const MAX_MEDIA_BYTES = 8 * 1024 * 1024

function sanitizeQuestionSets(questionSets: unknown) {
  if (!questionSets || typeof questionSets !== 'object') return {}
  return Object.fromEntries(Object.entries(questionSets).map(([round, questions]) => [
    round,
    Array.isArray(questions)
      ? questions.map((question) => {
        if (!question || typeof question !== 'object') return question
        const copy = { ...question } as { media?: { type: 'image' | 'video'; url: string } }
        if (copy.media?.url.startsWith('data:')) delete copy.media
        return copy
      })
      : [],
  ]))
}

function setQuestionMedia(
  questionSets: unknown,
  questionId: string,
  media?: { type: 'image' | 'video'; url: string },
) {
  const sanitized = sanitizeQuestionSets(questionSets)
  return Object.fromEntries(Object.entries(sanitized).map(([round, questions]) => [
    round,
    (questions as Array<{ id?: string; media?: { type: 'image' | 'video'; url: string } }>).map((question) => (
      question.id === questionId
        ? media ? { ...question, media } : (({ media: _media, ...withoutMedia }) => withoutMedia)(question)
        : question
    )),
  ]))
}

function mediaByQuestion(questionSets: unknown) {
  const result: Record<string, { type: 'image' | 'video'; url: string }> = {}
  for (const questions of Object.values(sanitizeQuestionSets(questionSets))) {
    for (const question of questions as Array<{ id?: string; media?: { type: 'image' | 'video'; url: string } }>) {
      if (question.id && question.media) result[question.id] = question.media
    }
  }
  return result
}

function findQuestionMedia(questionSets: unknown, questionId: string) {
  return mediaByQuestion(questionSets)[questionId]
}

const httpServer = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (!pathname.startsWith('/media/')) {
    response.writeHead(404)
    response.end('Not found')
    return
  }
  const filename = pathname.slice('/media/'.length)
  const content = readStoredMedia(filename)
  const contentType = mediaContentType(filename)
  if (!content || !contentType) {
    response.writeHead(404)
    response.end('Media not found')
    return
  }
  response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' })
  response.end(content)
})
const server = new WebSocketServer({ server: httpServer })

server.on('connection', (socket) => {
  const clientId = randomUUID()
  socket.on('message', (raw) => {
    let message: Message
    try {
      message = JSON.parse(raw.toString()) as Message
    } catch {
      send(socket, 'error', { message: 'Invalid message format.' })
      return
    }

    if (message.type === 'room:create') {
      const code = createRoomCode()
      const savedBoard = loadLatestBoard()
      const questionSets = savedBoard?.questionSets ?? {}
      const room: Room = { code, hostId: clientId, gameName: savedBoard?.name || 'Friday Night Trivia', gameStarted: false, round: 1, boardControlTeamId: null, teams: [], activeQuestionId: null, playedQuestionIds: [], buzzerOpen: false, buzzes: [], lockedOutTeamIds: [], mediaByQuestion: mediaByQuestion(questionSets), timerExpiresAt: null, boardId: randomUUID(), categories: savedBoard?.categories ?? [], questionSets, finalCategory: 'Final Jeopardy', finalPrompt: '', finalRevealed: false, finalWagers: {}, finalAnswers: {}, finalScoredTeamIds: [] }
      rooms.set(code, room)
      saveBoard({ id: room.boardId, name: room.gameName, categories: room.categories, questionSets: room.questionSets })
      persistRoom(room)
      clients.set(clientId, { socket, role: 'host', roomCode: code })
      send(socket, 'room:created', roomState(room))
      return
    }

    if (message.type === 'room:join') {
      const room = getRoom(message.code)
      const restored = room ?? loadRoom(message.code.replace(/-/g, '').toUpperCase())
      let joinedRoom: Room | undefined = room
      if (!room) {
        if (!restored) {
          send(socket, 'error', { message: 'Room not found.' })
          return
        }
        const savedBoard = loadBoard(restored.boardId)
        if (!savedBoard) {
          send(socket, 'error', { message: 'Saved board not found.' })
          return
        }
        const restoredRoom: Room = {
          code: restored.code,
          hostId: null,
          gameName: restored.gameName,
          gameStarted: restored.gameStarted,
          round: restored.round,
          boardControlTeamId: restored.boardControlTeamId,
          teams: restored.teams as Team[],
          activeQuestionId: null,
          playedQuestionIds: restored.playedQuestionIds,
          buzzerOpen: false,
          buzzes: [],
          lockedOutTeamIds: [],
          mediaByQuestion: {
            ...mediaByQuestion(savedBoard.questionSets),
            ...(restored.mediaByQuestion as Record<string, { type: 'image' | 'video'; url: string }>),
          },
          timerExpiresAt: null,
          boardId: restored.boardId,
          categories: savedBoard.categories,
          questionSets: savedBoard.questionSets,
          finalCategory: restored.finalCategory,
          finalPrompt: restored.finalPrompt,
          finalRevealed: restored.finalRevealed,
          finalWagers: restored.finalWagers,
          finalAnswers: restored.finalAnswers,
          finalScoredTeamIds: restored.finalScoredTeamIds,
        }
        rooms.set(restoredRoom.code, restoredRoom)
        joinedRoom = restoredRoom
      }
      if (!joinedRoom) return
      if (message.role === 'host' && joinedRoom.hostId && joinedRoom.hostId !== clientId) {
        send(socket, 'error', { message: 'This room already has a host.' })
        return
      }
      let teamId = message.teamId
      if (message.role === 'team') {
        teamId = teamId ? String(teamId) : randomUUID()
        const existing = joinedRoom.teams.find((team) => team.id === teamId)
        if (existing) existing.connected = true
        else joinedRoom.teams.push({ id: teamId, name: message.name?.trim() || 'New team', score: 0, connected: true })
      }
      clients.set(clientId, { socket, role: message.role, teamId, roomCode: joinedRoom.code })
      if (message.role === 'host') joinedRoom.hostId = clientId
      persistRoom(joinedRoom)
      send(socket, 'room:joined', {
        ...roomState(joinedRoom),
        teamId,
        ...(message.role === 'team' && teamId ? {
          finalWager: joinedRoom.finalWagers[teamId],
          finalAnswer: joinedRoom.finalAnswers[teamId],
        } : {}),
      })
      broadcast(joinedRoom, 'room:state', roomState(joinedRoom))
    }

    const client = clients.get(clientId)
    if (!client) {
      send(socket, 'error', { message: 'Join a room first.' })
      return
    }
    const room = [...rooms.values()].find((candidate) =>
      candidate.code === client.roomCode
        && (candidate.hostId === clientId || client.role === 'board' || (client.teamId && candidate.teams.some((team) => team.id === client.teamId))),
    )
    if (!room) {
      send(socket, 'error', { message: 'Room session expired.' })
      return
    }

    if (message.type === 'room:end' && client.role === 'host') {
      const roomClients = [...clients.entries()].filter(([id]) => {
        const candidate = clients.get(id)
        return candidate && (
          candidate.socket === client.socket
          || (candidate.teamId && room.teams.some((team) => team.id === candidate.teamId))
        )
      })
      clearQuestionTimer(room)
      deleteRoom(room.code)
      rooms.delete(room.code)
      for (const [id, roomClient] of roomClients) {
        send(roomClient.socket, 'room:ended', { message: 'The host ended this game.' })
        if (roomClient.socket !== client.socket) roomClient.socket.close()
        clients.delete(id)
      }
      client.socket.close()
    } else if (message.type === 'final:setup' && client.role === 'host') {
      if (room.finalRevealed) {
        send(client.socket, 'error', { message: 'The final question has already been revealed.' })
        return
      }
      room.finalCategory = message.category.trim() || 'Final Jeopardy'
      room.finalPrompt = message.prompt.trim()
      persistRoom(room)
      broadcast(room, 'final:state', { category: room.finalCategory, prompt: '', revealed: false })
    } else if (message.type === 'final:wager' && client.role === 'team' && client.teamId) {
      const team = room.teams.find((candidate) => candidate.id === client.teamId)
      if (!team || room.finalRevealed) return
      const maxWager = team.score > 0 ? team.score : 1000
      const amount = Math.min(Math.max(Math.floor(message.amount) || 0, 0), maxWager)
      room.finalWagers[team.id] = amount
      persistRoom(room)
      send(client.socket, 'final:wager:saved', { amount })
      if (room.hostId) {
        const host = [...clients.entries()].find(([id]) => id === room.hostId)
        if (host) send(host[1].socket, 'final:wagers', { wagers: room.finalWagers })
      }
    } else if (message.type === 'final:answer' && client.role === 'team' && client.teamId) {
      if (!room.finalRevealed || !room.finalPrompt.trim()) return
      room.finalAnswers[client.teamId] = message.answer.trim().slice(0, 500)
      persistRoom(room)
      send(client.socket, 'final:answer:saved', {})
      if (room.hostId) {
        const host = [...clients.entries()].find(([id]) => id === room.hostId)
        if (host) send(host[1].socket, 'final:answers', { answers: room.finalAnswers })
      }
    } else if (message.type === 'final:reveal' && client.role === 'host') {
      if (!room.finalPrompt.trim()) {
        send(client.socket, 'error', { message: 'Enter the Final Jeopardy question first.' })
        return
      }
      room.round = 3
      room.finalRevealed = true
      persistRoom(room)
      broadcast(room, 'final:state', { category: room.finalCategory, prompt: room.finalPrompt, revealed: true })
    } else if (message.type === 'final:score' && client.role === 'host') {
      const team = room.teams.find((candidate) => candidate.id === message.teamId)
      if (!team || room.finalScoredTeamIds.includes(team.id) || !room.finalRevealed) return
      const wager = room.finalWagers[team.id] ?? 0
      team.score += message.correct ? wager : -wager
      room.finalScoredTeamIds.push(team.id)
      persistRoom(room)
      broadcast(room, 'room:state', roomState(room))
      const complete = room.finalScoredTeamIds.length === room.teams.length
      broadcast(room, 'final:score', { teamId: team.id, correct: message.correct, wager, teams: room.teams, complete, winner: complete ? [...room.teams].sort((a, b) => b.score - a.score)[0]?.id ?? null : null })
    } else if (message.type === 'team:score' && client.role === 'host') {
      const team = room.teams.find((candidate) => candidate.id === message.teamId)
      if (!team || !Number.isSafeInteger(message.score)) {
        send(client.socket, 'error', { message: 'Enter a whole-number score.' })
        return
      }
      team.score = message.score
      persistRoom(room)
      broadcast(room, 'room:state', roomState(room))
    } else if (message.type === 'board:list' && client.role === 'host') {
      send(client.socket, 'board:list', { boards: listBoards() })
    } else if (message.type === 'board:load' && client.role === 'host') {
      const board = loadBoard(message.boardId)
      if (!board) {
        send(client.socket, 'error', { message: 'Saved board not found.' })
        return
      }
      room.boardId = board.id
      room.gameName = board.name
      room.categories = board.categories
      room.questionSets = board.questionSets
      clearQuestionTimer(room)
      room.activeQuestionId = null
      room.playedQuestionIds = []
      room.gameStarted = false
      room.round = 1
      room.buzzerOpen = false
      room.buzzes = []
      room.lockedOutTeamIds = []
      resetFinal(room)
      persistRoom(room)
      broadcast(room, 'room:state', roomState(room))
      send(client.socket, 'board:loaded', { board })
    } else if (message.type === 'board:delete' && client.role === 'host') {
      if (message.boardId === room.boardId) {
        send(client.socket, 'error', { message: 'The active board cannot be deleted.' })
        return
      }
      const board = loadBoard(message.boardId)
      if (board) {
        for (const media of Object.values(mediaByQuestion(board.questionSets))) removeStoredMedia(media.url)
      }
      deleteBoard(message.boardId)
      send(client.socket, 'board:list', { boards: listBoards() })
    } else if (message.type === 'game:start' && client.role === 'host') {
      room.gameStarted = true
      if (message.gameName?.trim()) room.gameName = message.gameName.trim()
      room.boardControlTeamId = room.teams.length
        ? room.teams[Math.floor(Math.random() * room.teams.length)].id
        : null
      broadcast(room, 'room:state', roomState(room))
      persistRoom(room)
    } else if (message.type === 'board:sync' && client.role === 'host') {
      const questionSets = sanitizeQuestionSets(message.questionSets)
      if (message.boardId !== room.boardId) {
        clearQuestionTimer(room)
        room.gameStarted = false
        room.round = 1
        room.activeQuestionId = null
        room.playedQuestionIds = []
        room.buzzerOpen = false
        room.buzzes = []
        room.lockedOutTeamIds = []
        resetFinal(room)
      }
      room.boardId = message.boardId
      room.gameName = message.gameName
      room.categories = message.categories
      room.questionSets = questionSets
      saveBoard({ id: room.boardId, name: room.gameName, categories: room.categories, questionSets: room.questionSets })
      persistRoom(room)
      broadcast(room, 'room:state', roomState(room))
      send(client.socket, 'board:list', { boards: listBoards() })
    } else if (message.type === 'question:media' && client.role === 'host') {
      let media = message.media
      try {
        if (media?.url.startsWith('data:')) media = storeDataUrl(media.type, media.url, MAX_MEDIA_BYTES)
        if (media && (
          media.url.length > MAX_MEDIA_URL_LENGTH
          || (!media.url.startsWith('http://') && !media.url.startsWith('https://') && !isStoredMediaUrl(media.url))
        )) throw new Error('Media must be a supported image/video URL under 8 MB.')
      } catch (error) {
        send(client.socket, 'error', { message: error instanceof Error ? error.message : 'Unable to save media.', media: true })
        return
      }
      const previousMedia = room.mediaByQuestion[message.questionId] ?? findQuestionMedia(room.questionSets, message.questionId)
      if (previousMedia && previousMedia.url !== media?.url) removeStoredMedia(previousMedia.url)
      if (media) {
        room.mediaByQuestion[message.questionId] = media
        room.questionSets = setQuestionMedia(room.questionSets, message.questionId, media)
      } else {
        delete room.mediaByQuestion[message.questionId]
        room.questionSets = setQuestionMedia(room.questionSets, message.questionId, undefined)
      }
      saveBoard({ id: room.boardId, name: room.gameName, categories: room.categories, questionSets: room.questionSets })
      broadcast(room, 'room:state', roomState(room))
      send(client.socket, 'question:media:saved', { questionId: message.questionId, media })
      persistRoom(room)
    } else if (message.type === 'round:set' && client.role === 'host') {
      room.round = message.round
      clearQuestionTimer(room)
      room.activeQuestionId = null
      room.buzzerOpen = false
      room.lockedOutTeamIds = []
      broadcast(room, 'room:state', roomState(room))
      persistRoom(room)
    } else if (message.type === 'question:open' && (client.role === 'host' || client.role === 'board')) {
      if (room.playedQuestionIds.includes(message.questionId)) return
      clearQuestionTimer(room)
      room.activeQuestionId = message.questionId
      room.buzzerOpen = false
      room.buzzes = []
      room.lockedOutTeamIds = []
      broadcast(room, 'room:state', roomState(room))
      persistRoom(room)
    } else if (message.type === 'question:resolve' && client.role === 'host') {
      if (room.activeQuestionId !== message.questionId) return
      const team = room.teams.find((candidate) => candidate.id === message.teamId)
      if (!team || room.lockedOutTeamIds.includes(team.id)) return
      const roundQuestions = sanitizeQuestionSets(room.questionSets)[room.round]
      const question = Array.isArray(roundQuestions)
        ? roundQuestions.find((candidate: { id?: string }) => candidate?.id === message.questionId)
        : undefined
      const isBoost = question?.boost === true
      if (isBoost) {
        const maxWager = team.score > 0 ? team.score : 1000
        if (!Number.isSafeInteger(message.points) || Math.abs(message.points) > maxWager || (message.correct ? message.points < 0 : message.points > 0)) {
          send(client.socket, 'error', { message: `Boost wager must be a whole number between 0 and ${maxWager}.` })
          return
        }
      } else if (!room.buzzes.some((buzz) => buzz.teamId === team.id)) return
      team.score += message.points
      if (message.correct || isBoost) {
        clearQuestionTimer(room)
        if (!room.playedQuestionIds.includes(message.questionId)) room.playedQuestionIds.push(message.questionId)
        if (message.correct) room.boardControlTeamId = message.teamId
        room.activeQuestionId = null
        room.buzzerOpen = false
        room.buzzes = []
        room.lockedOutTeamIds = []
      } else {
        room.lockedOutTeamIds.push(team.id)
        room.buzzes = []
        room.buzzerOpen = true
      }
      persistRoom(room)
      broadcast(room, 'room:state', roomState(room))
    } else if (message.type === 'buzzer:open' && client.role === 'host') {
      if (room.activeQuestionId !== message.questionId) return
      room.activeQuestionId = message.questionId
      room.buzzerOpen = true
      room.buzzes = []
      clearQuestionTimer(room)
      room.timerExpiresAt = Date.now() + 45_000
      room.timer = setTimeout(() => expireQuestion(room, message.questionId), 45_000)
      broadcast(room, 'buzzer:opened', roomState(room))
    } else if (message.type === 'buzzer:press' && client.role === 'team' && client.teamId && room.buzzerOpen) {
      if (room.lockedOutTeamIds.includes(client.teamId)) return
      if (room.buzzes.some((buzz) => buzz.teamId === client.teamId)) return
      const buzz = { teamId: client.teamId, receivedAt: Date.now() }
      room.buzzes.push(buzz)
      room.buzzes.sort((a, b) => a.receivedAt - b.receivedAt)
      broadcast(room, 'buzzer:pressed', { ...roomState(room), firstBuzz: room.buzzes[0] })
    } else if (message.type === 'buzzer:close' && client.role === 'host') {
      expireQuestion(room, room.activeQuestionId ?? '')
    }
  })

  socket.on('close', () => {
    const client = clients.get(clientId)
    if (client?.teamId) {
      for (const room of rooms.values()) {
        const team = room.teams.find((candidate) => candidate.id === client.teamId)
        if (team) {
          team.connected = false
          broadcast(room, 'room:state', roomState(room))
          persistRoom(room)
        }
      }
    }
    clients.delete(clientId)
  })
})

httpServer.listen(8787, () => {
  console.log('Jeopardy WebSocket/media server listening on port 8787')
})
