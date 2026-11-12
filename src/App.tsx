import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import './App.css'

type Team = {
  id: number | string
  name: string
  score: number
  color: string
  connected: boolean
}

type Question = {
  id: string
  value: number
  prompt: string
  answer: string
  boost?: boolean
  played?: boolean
  media?: { type: 'image' | 'video'; url: string }
}

type Category = {
  id: number
  name: string
}

type SavedBoard = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

type Route = { role: 'entry' | 'host' | 'board' | 'team' | 'join'; teamId?: string }

function createClientId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getRoute(): Route {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  if (path === '/') return { role: 'entry' }
  if (path === '/board') return { role: 'board' }
  if (path === '/team') return { role: 'join' }
  const teamMatch = path.match(/^\/team\/([^/]+)$/)
  if (teamMatch) return { role: 'team', teamId: teamMatch[1] }
  return { role: 'host' }
}

const colors = ['#d96c4b', '#4b8fd9', '#42a583', '#9c6ade', '#d2a53e', '#e26b9a']

const initialTeams: Team[] = [
  { id: 1, name: 'Team Alpha', score: 2400, color: colors[0], connected: true },
  { id: 2, name: 'The Brain Trust', score: 1800, color: colors[1], connected: true },
  { id: 3, name: 'Quiz Khalifa', score: 1200, color: colors[2], connected: true },
]

const initialCategories: Category[] = [
  { id: 0, name: 'World & Culture' },
  { id: 1, name: 'Science Lab' },
  { id: 2, name: 'Pop Culture' },
  { id: 3, name: 'History' },
]

function makeQuestions(round: number, categories: Category[]): Question[] {
  return categories.flatMap((category, categoryIndex) =>
  [100, 200, 300, 400, 500].map((value, rowIndex) => ({
    id: `${round}-${categoryIndex}-${rowIndex}`,
    value: round === 2 ? value * 2 : value,
    prompt: `Round ${round}: ${category.name} for ${round === 2 ? value * 2 : value}`,
    answer: 'The correct answer will appear here.',
    boost: categoryIndex === 2 && rowIndex === 2,
  })),
  )
}

function completeQuestionSets(questionSets: Record<number, Question[]>, categories: Category[]) {
  return {
    1: questionSets[1]?.length ? questionSets[1] : makeQuestions(1, categories),
    2: questionSets[2]?.length ? questionSets[2] : makeQuestions(2, categories),
  }
}

function mediaSource(url: string) {
  if (!url.startsWith('/media/')) return url
  return `${window.location.protocol}//${window.location.hostname}:8787${url}`
}

function App() {
  const [route, setRoute] = useState<Route>(getRoute)
  const [gameName, setGameName] = useState('Friday Night Trivia')
  const [roomCode, setRoomCode] = useState('')
  const [gameStarted, setGameStarted] = useState(false)
  const [boardControlTeamId, setBoardControlTeamId] = useState<number | string | null>(null)
  const [teams, setTeams] = useState(initialTeams)
  const [categories, setCategories] = useState(initialCategories)
  const [questionSets, setQuestionSets] = useState<Record<number, Question[]>>({
    1: makeQuestions(1, initialCategories),
    2: makeQuestions(2, initialCategories),
  })
  const [activeQuestion, setActiveQuestion] = useState<Question | null>(null)
  const [buzzerOpen, setBuzzerOpen] = useState(false)
  const [timerExpiresAt, setTimerExpiresAt] = useState<number | null>(null)
  const [remainingSeconds, setRemainingSeconds] = useState(0)
  const [buzzedTeamId, setBuzzedTeamId] = useState<number | string | null>(null)
  const [lockedOutTeamIds, setLockedOutTeamIds] = useState<Array<number | string>>([])
  const [selectedTeamId, setSelectedTeamId] = useState<number | string | null>(null)
  const [wager, setWager] = useState('')
  const [round, setRound] = useState<1 | 2 | 3>(1)
  const [finalCategory, setFinalCategory] = useState('Ancient Civilizations')
  const [finalPrompt, setFinalPrompt] = useState('')
  const [finalAnswer, setFinalAnswer] = useState('')
  const [finalRevealed, setFinalRevealed] = useState(false)
  const [finalWagers, setFinalWagers] = useState<Record<string, string>>({})
  const [finalWager, setFinalWager] = useState('')
  const [finalWagerSaved, setFinalWagerSaved] = useState(false)
  const [finalScoredTeamIds, setFinalScoredTeamIds] = useState<string[]>([])
  const [finalAnswers, setFinalAnswers] = useState<Record<string, string>>({})
  const [finalWinnerId, setFinalWinnerId] = useState<string | null>(null)
  const [isAddingTeam, setIsAddingTeam] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [joinTeamName, setJoinTeamName] = useState('')
  const [isEditingBoard, setIsEditingBoard] = useState(false)
  const [roomError, setRoomError] = useState('')
  const [mediaError, setMediaError] = useState('')
  const [savedBoards, setSavedBoards] = useState<SavedBoard[]>([])
  const [scoreDrafts, setScoreDrafts] = useState<Record<string, string>>({})
  const [showSavedBoards, setShowSavedBoards] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'offline' | 'connecting' | 'connected'>('offline')
  const [connectionMessage, setConnectionMessage] = useState('')
  const socketRef = useRef<WebSocket | null>(null)
  const questionSetsRef = useRef(questionSets)
  const boardIdRef = useRef<string>(createClientId())

  const questions = questionSets[round === 3 ? 1 : round]
  const answeredCount = questions.filter((question) => question.played).length
  const boostQuestion = questions.find((question) => question.boost && !question.played)
  const sortedTeams = useMemo(() => [...teams].sort((a, b) => b.score - a.score), [teams])
  const selectedTeam = teams.find((team) => String(team.id) === route.teamId) ?? teams[0] ?? {
    id: route.teamId ?? 'unknown',
    name: 'Your team',
    score: 0,
    color: colors[0],
    connected: false,
  }
  const boardControlTeam = teams.find((team) => String(team.id) === String(boardControlTeamId))
  const selectedTeamLockedOut = selectedTeam
    ? lockedOutTeamIds.some((id) => String(id) === String(selectedTeam.id))
    : false

  useEffect(() => {
    questionSetsRef.current = questionSets
  }, [questionSets])

  useEffect(() => {
    if (route.role !== 'host' && route.role !== 'board' && route.role !== 'team') return
    let active = true
    let retryTimer: number | undefined
    let currentSocket: WebSocket | null = null
    const connect = () => {
      if (!active) return
      setConnectionStatus('connecting')
      const socket = new WebSocket(`ws://${window.location.hostname}:8787`)
      currentSocket = socket
      socketRef.current = socket
      socket.onopen = () => {
        setConnectionStatus('connected')
        setConnectionMessage('')
        if (route.role === 'host') socket.send(JSON.stringify({ type: 'room:create' }))
        if (route.role === 'board') socket.send(JSON.stringify({ type: 'room:join', code: new URLSearchParams(window.location.search).get('room') ?? '', role: 'board' }))
        if (route.role === 'team') {
          const params = new URLSearchParams(window.location.search)
          socket.send(JSON.stringify({ type: 'room:join', code: params.get('room') ?? '', role: 'team', teamId: route.teamId, name: params.get('name') ?? undefined }))
        }
      }
      socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as {
        type: string
        payload: {
          code?: string
          teams?: Team[]
          gameName?: string
          gameStarted?: boolean
          round?: 1 | 2 | 3
          boardControlTeamId?: string | number | null
          playedQuestionIds?: string[]
          activeQuestionId?: string | null
          message?: string
          media?: boolean
          firstBuzz?: { teamId: string } | null
          buzzerOpen?: boolean
          lockedOutTeamIds?: string[]
          mediaByQuestion?: Record<string, { type: 'image' | 'video'; url: string }>
          timerExpiresAt?: number | null
          boardId?: string
          categories?: Category[]
          questionSets?: Record<number, Question[]>
          category?: string
          prompt?: string
          revealed?: boolean
          wagers?: Record<string, number>
          teamId?: string
          correct?: boolean
          amount?: number
          answers?: Record<string, string>
          complete?: boolean
          winner?: string | null
          finalWinnerId?: string | null
          finalCategory?: string
          finalPrompt?: string
          boards?: SavedBoard[]
          board?: { id: string; name: string; categories: Category[]; questionSets: Record<number, Question[]> }
        }
      }
      if (message.type === 'room:created' || message.type === 'room:joined') {
        if (message.payload.code) setRoomCode(message.payload.code)
        if (message.payload.teams) setTeams(message.payload.teams)
        if (message.payload.gameName) setGameName(message.payload.gameName)
        if (message.payload.boardId) boardIdRef.current = message.payload.boardId
        if (message.payload.categories?.length) setCategories(message.payload.categories)
        if (message.payload.questionSets && Object.keys(message.payload.questionSets).length) setQuestionSets(completeQuestionSets(message.payload.questionSets, message.payload.categories?.length ? message.payload.categories : categories))
        if (message.type === 'room:created' && route.role === 'host') {
          socket.send(JSON.stringify({ type: 'board:list' }))
          syncBoard(
            message.payload.categories?.length ? message.payload.categories : categories,
            message.payload.questionSets && Object.keys(message.payload.questionSets).length ? message.payload.questionSets : questionSets,
            message.payload.gameName ?? gameName,
          )
        }
      }
      if (message.type === 'board:list') {
        setSavedBoards(message.payload.boards ?? [])
      }
      if (message.type === 'final:state') {
        if (message.payload.category) setFinalCategory(message.payload.category)
        if (message.payload.prompt !== undefined) setFinalPrompt(message.payload.prompt)
        if (message.payload.revealed !== undefined) setFinalRevealed(message.payload.revealed)
      }
      if (message.type === 'final:wagers' && message.payload.wagers) {
        setFinalWagers(Object.fromEntries(Object.entries(message.payload.wagers).map(([id, amount]) => [id, String(amount)])))
      }
      if (message.type === 'final:answers' && message.payload.answers) setFinalAnswers(message.payload.answers)
      if (message.type === 'final:wager:saved') {
        setFinalWager(String(message.payload.amount ?? 0))
        setFinalWagerSaved(true)
      }
      if (message.type === 'final:score' && message.payload.teamId) {
        setFinalScoredTeamIds((current) => [...new Set([...current, message.payload.teamId as string])])
        if (message.payload.complete) setFinalWinnerId(message.payload.winner ?? null)
      }
      if (message.type === 'room:ended') {
        setRoomError(message.payload.message ?? 'The host ended this game.')
        setGameStarted(false)
        setActiveQuestion(null)
        setFinalWinnerId(null)
        setFinalScoredTeamIds([])
        navigate('/')
      }
      if (message.type === 'board:loaded' && message.payload.board) {
        const board = message.payload.board
        boardIdRef.current = board.id
        setGameName(board.name)
        setCategories(board.categories)
        setQuestionSets(completeQuestionSets(board.questionSets, board.categories))
        setGameStarted(false)
        setActiveQuestion(null)
        setFinalWinnerId(null)
        setFinalScoredTeamIds([])
        setShowSavedBoards(false)
      }
      if (message.type === 'error') {
        if (message.payload.media) setMediaError(message.payload.message ?? 'Unable to save media.')
        else setRoomError(message.payload.message ?? 'Unable to join this room.')
        setConnectionStatus('connected')
      }
      if (message.type === 'room:state' || message.type === 'buzzer:opened' || message.type === 'buzzer:pressed' || message.type === 'buzzer:closed') {
        if (message.payload.teams) setTeams(message.payload.teams)
        if (message.payload.gameName) setGameName(message.payload.gameName)
        if (message.payload.gameStarted !== undefined) setGameStarted(message.payload.gameStarted)
        if (message.payload.round) setRound(message.payload.round)
        if (message.payload.boardControlTeamId !== undefined) setBoardControlTeamId(message.payload.boardControlTeamId)
        if (message.payload.buzzerOpen !== undefined) setBuzzerOpen(message.payload.buzzerOpen)
        if (message.payload.timerExpiresAt !== undefined) setTimerExpiresAt(message.payload.timerExpiresAt)
        if (message.payload.lockedOutTeamIds) setLockedOutTeamIds(message.payload.lockedOutTeamIds)
        if (message.payload.firstBuzz !== undefined) setBuzzedTeamId(message.payload.firstBuzz?.teamId ?? null)
        if (message.payload.finalWinnerId !== undefined) setFinalWinnerId(message.payload.finalWinnerId)
        if (message.payload.finalCategory !== undefined) setFinalCategory(message.payload.finalCategory)
        if (message.payload.finalPrompt !== undefined) setFinalPrompt(message.payload.finalPrompt)
        if (message.payload.mediaByQuestion) {
          setQuestionSets((current) => Object.fromEntries(
            Object.entries(current).map(([setRound, setQuestions]) => [
              setRound,
              setQuestions.map((question) => ({
                ...question,
                media: message.payload.mediaByQuestion?.[question.id],
              })),
            ]),
          ))
        }
        if (message.payload.boardId) boardIdRef.current = message.payload.boardId
        if (message.payload.categories?.length) setCategories(message.payload.categories)
        if (message.payload.questionSets && Object.keys(message.payload.questionSets).length) setQuestionSets(completeQuestionSets(message.payload.questionSets, message.payload.categories?.length ? message.payload.categories : categories))
        if (message.payload.playedQuestionIds) {
          setQuestionSets((current) => Object.fromEntries(
            Object.entries(current).map(([setRound, setQuestions]) => [
              setRound,
              setQuestions.map((question) => ({
                ...question,
                played: message.payload.playedQuestionIds?.includes(question.id) ?? question.played,
              })),
            ]),
          ))
        }
        if (message.payload.activeQuestionId) {
          const remoteQuestion = Object.values(questionSetsRef.current).flat().find((question) => question.id === message.payload.activeQuestionId)
          if (remoteQuestion) setActiveQuestion(remoteQuestion)
        } else if (message.payload.activeQuestionId === null) {
          setActiveQuestion(null)
          setBuzzedTeamId(null)
          setBuzzerOpen(false)
          setTimerExpiresAt(null)
        }
      }
      if (message.type === 'buzzer:pressed') setBuzzedTeamId(message.payload.firstBuzz?.teamId ?? null)
      }
      socket.onerror = () => {
        setConnectionStatus('offline')
        setConnectionMessage('Connection lost. Retrying…')
      }
      socket.onclose = () => {
        if (!active) return
        setConnectionStatus('offline')
        setConnectionMessage('Connection lost. Retrying…')
        if (route.role !== 'host') retryTimer = window.setTimeout(connect, 1500)
      }
    }
    connect()
    return () => {
      active = false
      if (retryTimer) window.clearTimeout(retryTimer)
      currentSocket?.close()
      socketRef.current = null
    }
  }, [route.role, route.teamId])

  useEffect(() => {
    if (!timerExpiresAt) return
    const updateTimer = () => {
      setRemainingSeconds(Math.max(0, Math.ceil((timerExpiresAt - Date.now()) / 1000)))
    }
    updateTimer()
    const interval = window.setInterval(updateTimer, 250)
    return () => window.clearInterval(interval)
  }, [timerExpiresAt])

  function navigate(path: string) {
    window.history.pushState({}, '', path)
    setRoute(getRoute())
  }

  function openQuestion(question: Question) {
    if (question.played) return
    setActiveQuestion(question)
    setBuzzerOpen(false)
    setTimerExpiresAt(null)
    setBuzzedTeamId(null)
    setLockedOutTeamIds([])
    setSelectedTeamId(null)
    setWager('')
    socketRef.current?.send(JSON.stringify({ type: 'question:open', questionId: question.id }))
  }

  function switchRound(nextRound: 1 | 2 | 3) {
    setActiveQuestion(null)
    setBuzzerOpen(false)
    setTimerExpiresAt(null)
    setRound(nextRound)
    setFinalRevealed(false)
    setFinalWagers({})
    socketRef.current?.send(JSON.stringify({ type: 'round:set', round: nextRound }))
  }

  function pressBuzzer() {
    if (!selectedTeam?.id) return
    if (!buzzerOpen) return
    setBuzzedTeamId(selectedTeam.id)
    socketRef.current?.send(JSON.stringify({ type: 'buzzer:press', teamId: String(selectedTeam.id) }))
  }

  function unlockBuzzer() {
    if (!activeQuestion || activeQuestion.boost) return
    setBuzzerOpen(true)
    socketRef.current?.send(JSON.stringify({ type: 'buzzer:open', questionId: activeQuestion.id }))
  }

  function closeQuestion() {
    setActiveQuestion(null)
    setBuzzerOpen(false)
    setTimerExpiresAt(null)
    socketRef.current?.send(JSON.stringify({ type: 'buzzer:close' }))
  }

  function markQuestion(answeredCorrectly: boolean) {
    if (!activeQuestion) return
    const teamId = activeQuestion.boost ? selectedTeamId : buzzedTeamId
    if (!teamId) return
    const selectedTeam = teams.find((team) => team.id === teamId)
    const maxWager = selectedTeam && selectedTeam.score > 0 ? selectedTeam.score : 1000
    const pointsWager = activeQuestion.boost ? Math.min(Math.max(Number(wager) || 0, 0), maxWager) : activeQuestion.value
    const points = answeredCorrectly ? pointsWager : -pointsWager

    socketRef.current?.send(JSON.stringify({
      type: 'question:resolve',
      questionId: activeQuestion.id,
      teamId: String(teamId),
      points,
      correct: answeredCorrectly,
      allowUnbuzzed: activeQuestion.boost,
    }))
    if (!answeredCorrectly && !activeQuestion.boost) {
      setBuzzedTeamId(null)
      return
    }
    if (answeredCorrectly || activeQuestion.boost) {
      setQuestionSets((current) => ({
        ...current,
        [round]: current[round].map((question) =>
          question.id === activeQuestion.id ? { ...question, played: true } : question,
        ),
      }))
      setActiveQuestion(null)
    }
  }

  function addTeam() {
    const name = newTeamName.trim()
    if (!name) return
    setTeams((current) => [
      ...current,
      { id: Date.now(), name, score: 0, color: colors[current.length % colors.length], connected: true },
    ])
    setNewTeamName('')
    setIsAddingTeam(false)
  }

  function joinRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = joinTeamName.trim()
    if (!name) return
    if (!roomCode.trim()) return
    const team = {
      id: Date.now(),
      name,
      score: 0,
      color: colors[teams.length % colors.length],
      connected: true,
    }

    setTeams((current) => [...current, team])
    setJoinTeamName('')
    const normalizedCode = roomCode.replace(/-/g, '').toUpperCase()
    setRoomError('')
    navigate(`/team/${team.id}?room=${encodeURIComponent(normalizedCode)}&name=${encodeURIComponent(name)}`)
  }

  function enterRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!roomCode.trim()) return
    navigate('/team')
  }

  function startGame() {
    const normalizedCode = roomCode.replace(/-/g, '').toUpperCase()
    if (!normalizedCode) {
      setRoomError('The room is still connecting. Try again in a moment.')
      return
    }
    setGameStarted(true)
    const startingTeam = teams[Math.floor(Math.random() * teams.length)]
    if (startingTeam) setBoardControlTeamId(startingTeam.id)
    socketRef.current?.send(JSON.stringify({ type: 'game:start', gameName }))
  }

  function endGame() {
    if (!window.confirm('End this game for everyone? The saved board will remain available.')) return
    socketRef.current?.send(JSON.stringify({ type: 'room:end' }))
  }

  function loadSavedBoard(boardId: string) {
    socketRef.current?.send(JSON.stringify({ type: 'board:load', boardId }))
  }

  function deleteSavedBoard(boardId: string) {
    socketRef.current?.send(JSON.stringify({ type: 'board:delete', boardId }))
  }

  function createNewBoard() {
    const nextCategories = initialCategories.map((category) => ({ ...category }))
    const nextQuestionSets = {
      1: makeQuestions(1, nextCategories),
      2: makeQuestions(2, nextCategories),
    }
    boardIdRef.current = createClientId()
    setGameName('New Jeopardy Game')
    setCategories(nextCategories)
    setQuestionSets(nextQuestionSets)
    setGameStarted(false)
    setActiveQuestion(null)
    setRound(1)
    setFinalWinnerId(null)
    setFinalScoredTeamIds([])
    syncBoard(nextCategories, nextQuestionSets, 'New Jeopardy Game')
    setShowSavedBoards(false)
    socketRef.current?.send(JSON.stringify({ type: 'board:list' }))
  }

  function scoreFinal(teamId: number | string, correct: boolean) {
    socketRef.current?.send(JSON.stringify({ type: 'final:score', teamId: String(teamId), correct }))
  }

  function updateTeamScore(teamId: number | string, value: string) {
    const score = Number(value)
    if (!Number.isSafeInteger(score)) {
      setRoomError('Enter a whole-number score.')
      return
    }
    const normalizedTeamId = String(teamId)
    socketRef.current?.send(JSON.stringify({ type: 'team:score', teamId: normalizedTeamId, score }))
    setScoreDrafts((current) => ({ ...current, [normalizedTeamId]: String(score) }))
    setRoomError('')
  }

  function saveFinalSetup() {
    socketRef.current?.send(JSON.stringify({
      type: 'final:setup',
      category: finalCategory,
      prompt: finalPrompt,
      answer: finalAnswer,
    }))
  }

  function revealFinalQuestion() {
    saveFinalSetup()
    socketRef.current?.send(JSON.stringify({ type: 'final:reveal' }))
  }

  function submitFinalWager() {
    const amount = Math.max(Number(finalWager) || 0, 0)
    socketRef.current?.send(JSON.stringify({ type: 'final:wager', amount }))
    setFinalWagerSaved(false)
  }

  function submitFinalAnswer() {
    socketRef.current?.send(JSON.stringify({ type: 'final:answer', answer: finalAnswer }))
    setFinalAnswer('')
  }

  function updateCategory(categoryId: number, name: string) {
    const nextCategories = categories.map((category) => category.id === categoryId ? { ...category, name } : category)
    setCategories(nextCategories)
    syncBoard(nextCategories, questionSets)
  }

  function updateQuestion(questionId: string, changes: Partial<Question>) {
    const nextQuestionSets = Object.fromEntries(
      Object.entries(questionSets).map(([setRound, setQuestions]) => [
        setRound,
        setQuestions.map((question) => question.id === questionId ? { ...question, ...changes } : question),
      ]),
    ) as Record<number, Question[]>
    setQuestionSets(nextQuestionSets)
    syncBoard(categories, nextQuestionSets)
  }

  function syncBoard(nextCategories: Category[], nextQuestionSets: Record<number, Question[]>, nextGameName = gameName) {
    if (route.role !== 'host' || socketRef.current?.readyState !== WebSocket.OPEN) return
    socketRef.current.send(JSON.stringify({
      type: 'board:sync',
      boardId: boardIdRef.current,
      gameName: nextGameName,
      categories: nextCategories,
      questionSets: nextQuestionSets,
    }))
  }

  function updateQuestionMedia(questionId: string, media?: Question['media']) {
    setMediaError('')
    updateQuestion(questionId, { media })
    socketRef.current?.send(JSON.stringify({ type: 'question:media', questionId, media }))
  }

  function uploadQuestionMedia(questionId: string, file: File) {
    const type = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : null
    if (!type) {
      setMediaError('Choose an image or video file.')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setMediaError('Media files must be 8 MB or smaller.')
      return
    }
    setMediaError('')
    const reader = new FileReader()
    reader.onload = () => updateQuestionMedia(questionId, { type, url: String(reader.result) })
    reader.readAsDataURL(file)
  }

  function toggleBoost(questionId: string) {
    const nextQuestionSets = Object.fromEntries(
      Object.entries(questionSets).map(([setRound, setQuestions]) => [
        setRound,
        setQuestions.map((question) => ({ ...question, boost: question.id === questionId ? true : question.boost && question.id === questionId })),
      ]),
    ) as Record<number, Question[]>
    setQuestionSets(nextQuestionSets)
    syncBoard(categories, nextQuestionSets)
  }

  return (
    <main className={`app-shell ${route.role === 'board' ? 'board-shell' : ''}`}>
      {route.role !== 'board' && <header className="topbar">
        <div className="brand">
          <div className="brand-mark">J!</div>
          <div>
            <strong>JEOPARDY<span>+</span></strong>
            <small>{route.role === 'host' ? 'HOST CONTROL' : route.role === 'entry' || route.role === 'join' ? 'ROOM ENTRY' : 'TEAM BUZZER'}</small>
          </div>
        </div>
        <div className="room-status">
          <span className={`live-dot ${connectionStatus === 'connected' ? '' : 'offline-dot'}`} /> {connectionStatus === 'connected' ? 'LIVE ROOM' : connectionStatus === 'connecting' ? 'CONNECTING' : 'OFFLINE'}
          <b className="room-code-display">{roomCode || '...'}</b>
          {route.role === 'host' && (
            <>
              <button className="view-switch" onClick={() => navigate(`/board?room=${encodeURIComponent(roomCode)}`)}>Board display</button>
              <button className="icon-button" aria-label="Settings">⚙</button>
            </>
          )}
          {route.role === 'team' && <span className="team-route-label">TEAM VIEW</span>}
          {route.role === 'join' && <span className="team-route-label">JOIN ROOM</span>}
        </div>
      </header>}
      {connectionMessage && route.role !== 'entry' && route.role !== 'join' && (
        <div className="connection-banner" role="status">{connectionMessage}</div>
      )}

      <div className="content">
        {route.role === 'entry' ? (
          <section className="entry-view">
            <form className="entry-card" onSubmit={enterRoom}>
              <div className="join-mark">J!</div>
              <div className="eyebrow">JOIN A LIVE GAME</div>
              <h1>Ready to play?</h1>
              <p>Enter the room details shown on the host's screen.</p>
              <label className="join-label" htmlFor="room-code">Room code</label>
              <input id="room-code" className="join-input room-code-input" value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/-/g, '').toUpperCase())} placeholder="AB12CD" maxLength={6} />
              {roomError && <div className="room-error">{roomError}</div>}
              <div className="entry-game-name"><span>GAME</span><strong>{gameName}</strong></div>
              <button className="join-button" type="submit" disabled={!roomCode.trim()}>Continue</button>
              <button className="leave-room" type="button" onClick={() => navigate('/host')}>Create a host room</button>
            </form>
          </section>
        ) : route.role === 'board' && round === 3 ? (
          <section className="board-only-view final-board-view">
            <div className="board-display-heading">
              <div><div className="eyebrow">FINAL JEOPARDY</div><h1>{finalCategory}</h1></div>
              <span className="progress">Final round</span>
            </div>
            <section className="board-panel final-display-card">
              {finalWinnerId ? (
                <>
                  <div className="eyebrow">GAME COMPLETE</div>
                  <h2>{teams.find((team) => String(team.id) === finalWinnerId)?.name ?? 'Winner'}</h2>
                  <div className="winner-score">{teams.find((team) => String(team.id) === finalWinnerId)?.score.toLocaleString() ?? '0'} points</div>
                  <div className="final-results-list">
                    {[...teams].sort((a, b) => b.score - a.score).map((team, index) => <div key={team.id}><span>{index + 1}</span><strong>{team.name}</strong><b>{team.score.toLocaleString()} pts</b></div>)}
                  </div>
                </>
              ) : (
                <>
                  <div className="eyebrow">FINAL CATEGORY</div>
                  <h2>{finalCategory}</h2>
                  {finalRevealed && <div className="final-question">{finalPrompt}</div>}
                </>
              )}
            </section>
          </section>
        ) : route.role === 'board' ? (
          <section className="board-only-view">
            <div className="board-display-heading">
              <div>
                <div className="eyebrow">{gameName.toUpperCase()} · ROUND {round}</div>
                <h1>{gameName}</h1>
              </div>
              <div className="board-display-status">
                {boardControlTeam && <span className="control-badge">✦ {boardControlTeam.name} chooses</span>}
                <span className="progress">{answeredCount} / {questions.length} answered</span>
              </div>
            </div>
            <section className="board-panel">
              <div className="board">
                {categories.map((category, categoryIndex) => (
                  <div className="category-column" key={category.id}>
                    <div className="category-title">{category.name}</div>
                    {questions.filter((question) => question.id.split('-')[1] === String(categoryIndex)).map((question) => (
                      <button
                        className={`question-tile ${question.played ? 'played' : ''}`}
                        key={question.id}
                        disabled={question.played}
                        onClick={() => openQuestion(question)}
                      >
                        {question.played ? '—' : `${question.value} pts`}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </section>
            {activeQuestion && (
              <section className="public-question">
                <span className="eyebrow">QUESTION</span>
                <h2>{activeQuestion.prompt}</h2>
                {activeQuestion.media && (
                  activeQuestion.media.type === 'image'
                    ? <img className="question-media" src={mediaSource(activeQuestion.media.url)} alt="Question media" />
                    : <video className="question-media" src={mediaSource(activeQuestion.media.url)} controls />
                )}
                {round === 3 && (
                  <div className="team-question">
                    <strong>Final Jeopardy</strong>
                    {finalRevealed ? <div>{finalPrompt}</div> : <div>Wait for the host to reveal the final question.</div>}
                    <input type="number" min="0" value={finalWager} onChange={(event) => setFinalWager(event.target.value)} placeholder="Your wager" disabled={finalRevealed} />
                    <button className="team-buzzer" onClick={submitFinalWager} disabled={finalRevealed}>Submit wager</button>
                    <input value={finalAnswer} onChange={(event) => setFinalAnswer(event.target.value)} placeholder="Your answer" disabled={!finalRevealed} />
                    <button className="team-buzzer" onClick={submitFinalAnswer} disabled={!finalRevealed || !finalAnswer.trim()}>Submit answer</button>
                    {finalWagerSaved && <small>Wager submitted privately.</small>}
                  </div>
                )}
                {buzzerOpen && <div className="question-timer">{remainingSeconds}s</div>}
              </section>
            )}
          </section>
        ) : route.role === 'join' ? (
          <section className="team-view">
            <form className="team-view-card join-card" onSubmit={joinRoom}>
              <div className="join-mark">J!</div>
              <div className="eyebrow">JOIN ROOM · {roomCode || '------'}</div>
              <h1>Choose your team name</h1>
              <p>Enter the name your team will use during this game.</p>
              <label className="join-label" htmlFor="join-team-name">Team name</label>
              <input
                id="join-team-name"
                className="join-input"
                autoFocus
                value={joinTeamName}
                onChange={(event) => setJoinTeamName(event.target.value)}
                placeholder="e.g. The Quiz Masters"
                maxLength={32}
              />
              <button className="join-button" type="submit" disabled={!joinTeamName.trim()}>Join game</button>
              <button className="leave-room" type="button" onClick={() => navigate('/host')}>Back to host</button>
            </form>
          </section>
        ) : route.role === 'team' ? (
          <section className="team-view">
            <div className="team-view-card">
              {!gameStarted ? (
                <>
                  <div className="join-mark">J!</div>
                  <div className="eyebrow">WAITING FOR HOST · {gameName.toUpperCase()}</div>
                  <h1>{selectedTeam.name}</h1>
                  <p>The game has not started yet. These teams are in the room:</p>
                  <div className="waiting-teams">{teams.map((team) => <div key={team.id}><span className="team-avatar" style={{ backgroundColor: team.color }}>{team.name.charAt(0)}</span><strong>{team.name}</strong><small>{team.connected ? 'Joined' : 'Offline'}</small></div>)}</div>
                  <div className="waiting-status"><span className="live-dot" /> Waiting for the host to start</div>
                </>
              ) : (
                <>
                  <div className="team-avatar large-avatar" style={{ backgroundColor: selectedTeam.color }}>{selectedTeam.name.charAt(0)}</div>
                  <div className="eyebrow">JOINED ROOM · {gameName.toUpperCase()}</div>
                  <h1>{selectedTeam.name}</h1>
                  <div className="team-score">{selectedTeam.score.toLocaleString()} <small>points</small></div>
                  {finalWinnerId ? (
                    <div className="team-complete">
                      <div className="eyebrow">GAME COMPLETE</div>
                      <h2>{String(selectedTeam.id) === finalWinnerId ? 'You won!' : `${teams.find((team) => String(team.id) === finalWinnerId)?.name ?? 'Another team'} won`}</h2>
                      <p>Final standings are shown on the board.</p>
                      <button className="join-button" onClick={() => navigate('/')}>Return to lobby</button>
                    </div>
                  ) : (
                    <>
                  {activeQuestion && (
                    <div className="team-question">
                      <div>{activeQuestion.prompt}</div>
                      {activeQuestion.media && (
                        activeQuestion.media.type === 'image'
                          ? <img className="question-media" src={mediaSource(activeQuestion.media.url)} alt="Question media" />
                          : <video className="question-media" src={mediaSource(activeQuestion.media.url)} controls />
                      )}
                      {buzzerOpen && <div className="question-timer">{remainingSeconds}s remaining</div>}
                    </div>
                  )}
                  <p>{activeQuestion ? (selectedTeamLockedOut ? 'You are locked out for this question.' : buzzerOpen ? 'Your buzzer is active. Be the fastest team.' : 'The host is reading the question.') : 'Wait for the host to open a question.'}</p>
                  <button className="team-buzzer" onClick={pressBuzzer} disabled={!activeQuestion || !buzzerOpen || selectedTeamLockedOut || buzzedTeamId !== null}>
                    {buzzedTeamId === selectedTeam.id ? 'BUZZ REGISTERED' : buzzedTeamId !== null ? 'BUZZER TAKEN' : selectedTeamLockedOut ? 'LOCKED OUT' : buzzerOpen ? 'BUZZ IN' : 'WAITING FOR HOST'}
                  </button>
                    </>
                  )}
                </>
              )}
              <button className="leave-room" onClick={() => navigate('/host')}>Leave room</button>
            </div>
          </section>
        ) : (
        <>
        <section className="page-heading">
          <div>
            <div className="eyebrow">{round === 3 ? 'FINAL JEOPARDY' : `${gameName.toUpperCase()} · ROUND ${round}`}</div>
            {route.role === 'host' && !gameStarted ? (
              <input className="game-title-input" value={gameName} onChange={(event) => {
                const nextName = event.target.value
                setGameName(nextName)
                syncBoard(categories, questionSets, nextName)
              }} aria-label="Game name" />
            ) : <h1>{round === 3 ? finalCategory : 'General Knowledge'}</h1>}
          </div>
          <div className="heading-actions">
            <button className={`secondary-button ${round === 1 ? 'selected-round' : ''}`} onClick={() => switchRound(1)}>Round 1</button>
            <button className={`secondary-button ${round === 2 ? 'selected-round' : ''}`} onClick={() => switchRound(2)}>Round 2</button>
            <button className={`secondary-button ${round === 3 ? 'selected-round final-button' : ''}`} onClick={() => switchRound(3)}>Final Jeopardy</button>
            <button className="secondary-button" onClick={() => setIsEditingBoard((value) => !value)}>✎ <span>{isEditingBoard ? 'Done editing' : 'Edit board'}</span></button>
            {!gameStarted && <button className="start-button" onClick={startGame}>Start game →</button>}
            {gameStarted && <button className="danger-button" onClick={endGame}>End game</button>}
            <button className="primary-button" onClick={createNewBoard}>＋ <span>New game</span></button>
          </div>
        </section>
        <section className="saved-boards board-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">SAVED BOARDS</span><h2>Previous games</h2></div>
            <button className="secondary-button" onClick={() => {
              setShowSavedBoards((value) => !value)
              if (!showSavedBoards) socketRef.current?.send(JSON.stringify({ type: 'board:list' }))
            }}>{showSavedBoards ? 'Hide boards' : 'Show boards'}</button>
          </div>
          {showSavedBoards && (
            savedBoards.length ? (
              <div className="saved-board-list">
                {savedBoards.map((board) => (
                  <div className={`saved-board-row ${board.id === boardIdRef.current ? 'selected' : ''}`} key={board.id}>
                    <div><strong>{board.name}</strong><small>Updated {new Date(board.updatedAt).toLocaleString()}</small></div>
                    <div className="saved-board-actions">
                      <button className="secondary-button" onClick={() => loadSavedBoard(board.id)} disabled={board.id === boardIdRef.current}>Load</button>
                      <button className="danger-button" onClick={() => deleteSavedBoard(board.id)} disabled={board.id === boardIdRef.current}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="saved-board-empty">No saved boards yet. Edit this board or create a new game to save one.</p>
          )}
        </section>
        {boardControlTeam && (
          <div className="control-banner">
            <span className="control-icon">✦</span>
            <div><strong>{boardControlTeam.name}</strong><span>controls the board and chooses the next question</span></div>
          </div>
        )}

        {round === 3 ? (
          <section className="final-host-layout">
            <section className="board-panel final-setup-card">
              <div className="panel-heading"><div><span className="eyebrow">FINAL JEOPARDY</span><h2>Final round setup</h2></div></div>
              <label className="join-label" htmlFor="final-category">Category</label>
              <input id="final-category" className="join-input" value={finalCategory} onChange={(event) => setFinalCategory(event.target.value)} />
              <label className="join-label" htmlFor="final-prompt">Final question</label>
              <textarea id="final-prompt" className="join-input final-prompt-input" value={finalPrompt} onChange={(event) => setFinalPrompt(event.target.value)} placeholder="Enter the Final Jeopardy question" />
              <label className="join-label" htmlFor="final-answer">Answer</label>
              <input id="final-answer" className="join-input" value={finalAnswer} onChange={(event) => setFinalAnswer(event.target.value)} placeholder="Host-only answer" />
              <div className="final-category-preview"><span className="eyebrow">CATEGORY REVEAL</span><strong>{finalCategory}</strong></div>
              <button className="secondary-button" onClick={saveFinalSetup}>Save final setup</button>
              <button className="primary-button reveal-final" onClick={revealFinalQuestion}>{finalRevealed ? 'Question revealed' : 'Reveal final question'}</button>
              {finalRevealed && <div className="answer-preview final-answer">Host answer: {finalAnswer || 'Not entered'}</div>}
            </section>
            <section className="board-panel">
              <div className="panel-heading"><div><span className="eyebrow">FINAL WAGERS</span><h2>Settle the game</h2></div></div>
              <div className="final-wager-list">
                {teams.map((team) => (
                  <div className="final-wager-row" key={team.id}>
                    <div className="team-avatar" style={{ backgroundColor: team.color }}>{team.name.charAt(0)}</div>
                    <strong>{team.name}<small>Max {Math.max(team.score, 0).toLocaleString()} pts{finalAnswers[String(team.id)] ? ` · ${finalAnswers[String(team.id)]}` : ''}</small></strong>
                    <input type="number" readOnly placeholder="Wager" value={finalWagers[String(team.id)] ?? ''} />
                    <button className="final-correct" disabled={finalScoredTeamIds.includes(String(team.id))} onClick={() => scoreFinal(team.id, true)}>✓</button>
                    <button className="final-wrong" disabled={finalScoredTeamIds.includes(String(team.id))} onClick={() => scoreFinal(team.id, false)}>✕</button>
                  </div>
                ))}
              </div>
              {finalWinnerId && (
                <div className="game-complete-card">
                  <div className="eyebrow">GAME COMPLETE</div>
                  <strong>{teams.find((team) => String(team.id) === finalWinnerId)?.name ?? 'Winner'} wins</strong>
                  <span>{teams.find((team) => String(team.id) === finalWinnerId)?.score.toLocaleString() ?? '0'} points</span>
                  <button className="primary-button" onClick={createNewBoard}>Play another game</button>
                </div>
              )}
            </section>
          </section>
        ) : (
        <>
        {isEditingBoard && (
          <section className="board-editor board-panel">
            <div className="panel-heading">
              <div><span className="eyebrow">BOARD EDITOR</span><h2>Edit Round {round}</h2></div>
              <span className="progress">Changes are saved in this game</span>
            </div>
            <div className="editor-grid">
              {categories.map((category, categoryIndex) => (
                <div className="editor-category" key={category.id}>
                  <input value={category.name} onChange={(event) => updateCategory(category.id, event.target.value)} aria-label={`Category ${categoryIndex + 1} name`} />
                  {questions.filter((question) => question.id.split('-')[1] === String(categoryIndex)).map((question) => (
                    <div className="editor-question" key={question.id}>
                      <input type="number" value={question.value} onChange={(event) => updateQuestion(question.id, { value: Number(event.target.value) })} aria-label="Point value" />
                      <input value={question.prompt} onChange={(event) => updateQuestion(question.id, { prompt: event.target.value })} aria-label="Question text" />
                      <input value={question.answer} onChange={(event) => updateQuestion(question.id, { answer: event.target.value })} aria-label="Answer" />
                      <button className={question.boost ? 'boost-toggle selected' : 'boost-toggle'} onClick={() => toggleBoost(question.id)} type="button">{question.boost ? 'BOOST' : 'Set boost'}</button>
                      <select value={question.media?.type ?? ''} onChange={(event) => updateQuestionMedia(question.id, event.target.value && question.media?.url ? { type: event.target.value as 'image' | 'video', url: question.media.url } : undefined)} aria-label="Media type">
                        <option value="">No media</option>
                        <option value="image">Image</option>
                        <option value="video">Video</option>
                      </select>
                      <input value={question.media?.url ?? ''} onChange={(event) => updateQuestionMedia(question.id, question.media?.type && event.target.value.trim() ? { type: question.media.type, url: event.target.value.trim() } : undefined)} placeholder="Media URL" aria-label="Media URL" />
                      <input type="file" accept="image/*,video/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadQuestionMedia(question.id, file) }} aria-label="Upload question media" />
                      {question.media && <button className="media-remove" type="button" onClick={() => updateQuestionMedia(question.id)}>Remove</button>}
                      {question.media && (
                        question.media.type === 'image'
                          ? <img className="editor-media-preview" src={mediaSource(question.media.url)} alt="Attached question media preview" />
                          : <video className="editor-media-preview" src={mediaSource(question.media.url)} controls />
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {mediaError && <div className="media-error">{mediaError}</div>}
          </section>
        )}
        <section className="score-strip">
          <div className="section-label"><span>LIVE SCOREBOARD</span><em>{teams.length} teams connected</em></div>
          <div className="score-list">
            {sortedTeams.map((team, index) => (
              <article className={`score-card ${index === 0 ? 'leader' : ''}`} key={team.id}>
                <div className="team-avatar" style={{ backgroundColor: team.color }}>{team.name.charAt(0)}</div>
                <div className="team-info">
                  <strong>{team.name}</strong>
                  <span><i className={team.connected ? 'online' : ''} /> {team.connected ? 'Connected' : 'Offline'}</span>
                  <button className="team-link" onClick={() => navigate(`/team/${team.id}?room=${encodeURIComponent(roomCode)}&name=${encodeURIComponent(team.name)}`)}>Open team view ↗</button>
                </div>
                <b className="score">{team.score.toLocaleString()}<small> pts</small></b>
                {route.role === 'host' && (
                  <div className="score-edit">
                    <input
                      type="number"
                      step="1"
                      value={scoreDrafts[team.id] ?? String(team.score)}
                      onChange={(event) => setScoreDrafts((current) => ({ ...current, [team.id]: event.target.value }))}
                      aria-label={`${team.name} score`}
                    />
                    <button className="secondary-button" onClick={() => updateTeamScore(team.id, scoreDrafts[team.id] ?? String(team.score))}>Set</button>
                  </div>
                )}
                {index === 0 && <span className="leader-tag">LEADING</span>}
              </article>
            ))}
            {isAddingTeam ? (
              <form className="add-team-card" onSubmit={(event) => { event.preventDefault(); addTeam() }}>
                <input autoFocus value={newTeamName} onChange={(event) => setNewTeamName(event.target.value)} placeholder="Team name" />
                <button type="submit">Add</button>
              </form>
            ) : (
              <button className="add-team-card add-team-button" onClick={() => setIsAddingTeam(true)}>
                <span>＋</span><strong>Add team</strong><small>Unlimited teams</small>
              </button>
            )}
          </div>
        </section>

        <div className={`game-layout ${gameStarted ? 'game-started' : ''}`}>
          <section className="board-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">QUESTION BOARD</span>
                <h2>Choose a category</h2>
              </div>
              <span className="progress">{answeredCount} / {questions.length} answered</span>
            </div>
            <div className="board">
              {categories.map((category, categoryIndex) => (
                <div className="category-column" key={category.id}>
                  <div className="category-title">{category.name}</div>
                  {questions.filter((question) => question.id.split('-')[1] === String(categoryIndex)).map((question) => (
                    <button
                      className={`question-tile ${question.played ? 'played' : ''} ${question.boost ? 'boost-tile' : ''}`}
                      key={question.id}
                      disabled={question.played}
                      onClick={() => openQuestion(question)}
                    >
                      {!gameStarted && question.boost && <span className="boost-chip">BOOST</span>}
                      {question.played ? '—' : `${question.value} pts`}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="board-footer"><span className="key-hint">⌘</span> Click a tile to reveal the question {!gameStarted && <><span className="footer-divider" /> <span className="mini-boost">✦</span> Boost question</>}</div>
          </section>

          <aside className="side-panel">
            <div className="panel-heading">
              <div><span className="eyebrow">GAME TOOLS</span><h2>Host controls</h2></div>
            </div>
            <div className="tool-card buzzer-tool">
              <div className="tool-icon">◉</div>
              <div><strong>Buzzer status</strong><span>{!activeQuestion ? 'Waiting for a question' : buzzerOpen ? 'Buzzers are active' : 'Locked until host unlocks'}</span></div>
              <span className={`status-pill ${buzzerOpen ? 'active' : ''}`}>{buzzerOpen ? 'ACTIVE' : activeQuestion ? 'LOCKED' : 'IDLE'}</span>
            </div>
            <div className="tool-card">
              <div className="tool-icon video-icon">▶</div>
              <div><strong>Media library</strong><span>Add image or video questions</span></div>
              <button className="small-arrow">→</button>
            </div>
            <div className="boost-callout">
              <div className="boost-icon">✦</div>
              <div><strong>Boost question</strong><span>{boostQuestion ? `Available · ${boostQuestion.value} pts tile` : 'Used this round'}</span></div>
              <b>{boostQuestion ? '1' : '0'}<small> left</small></b>
            </div>
            <button className="end-round" onClick={() => switchRound(round === 1 ? 2 : 3)}>End round <span>→</span></button>
          </aside>
        </div>
        </>
        )}
        </>
        )}
      </div>

      {route.role === 'host' && activeQuestion && (
        <div className="modal-backdrop" role="presentation">
          <div className="question-modal" role="dialog" aria-modal="true" aria-labelledby="question-title">
            <button className="close-modal" onClick={closeQuestion} aria-label="Close question">×</button>
            <div className="modal-meta"><span>{activeQuestion.boost ? '✦ BOOST QUESTION' : 'QUESTION'}</span><b>{activeQuestion.value} POINTS</b></div>
            <h2 id="question-title">{activeQuestion.prompt}</h2>
            {activeQuestion.media && (
              activeQuestion.media.type === 'image'
                ? <img className="question-media" src={mediaSource(activeQuestion.media.url)} alt="Question media" />
                : <video className="question-media" src={mediaSource(activeQuestion.media.url)} controls />
            )}
            <div className="host-answer"><span className="eyebrow">ANSWER</span><strong>{activeQuestion.answer}</strong></div>
            {activeQuestion.boost ? (
              <div className="team-select">
                <label htmlFor="team-select">Which team selected this boost?</label>
                <select id="team-select" value={selectedTeamId ?? ''} onChange={(event) => setSelectedTeamId(Number(event.target.value))}>
                  <option value="" disabled>Select a team</option>
                  {teams.map((team) => {
                    const maxWager = team.score > 0 ? team.score : 1000
                    return <option value={team.id} key={team.id}>{team.name} · max wager {maxWager.toLocaleString()} pts</option>
                  })}
                </select>
                {selectedTeamId && (
                  <input
                    className="wager-input"
                    type="number"
                    min="0"
                    max={(teams.find((team) => team.id === selectedTeamId)?.score ?? 0) > 0 ? teams.find((team) => team.id === selectedTeamId)?.score : 1000}
                    value={wager}
                    onChange={(event) => setWager(event.target.value)}
                    placeholder="Enter wager"
                  />
                )}
              </div>
            ) : (
              <div className="buzzer-area">
                {!buzzerOpen ? (
                  <button className="unlock-button" onClick={unlockBuzzer}>Unlock buzzer</button>
                ) : buzzedTeamId ? (
                  <strong className="buzzed-team" style={{ color: teams.find((team) => team.id === buzzedTeamId)?.color }}>
                    {teams.find((team) => team.id === buzzedTeamId)?.name} buzzed in!
                  </strong>
                ) : (
                  <span className="buzzer-label">BUZZERS UNLOCKED — WAITING FOR A TEAM</span>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button className="wrong-button" disabled={!buzzedTeamId && !selectedTeamId} onClick={() => markQuestion(false)}>✕ Incorrect</button>
              <button className="correct-button" disabled={!buzzedTeamId && !selectedTeamId} onClick={() => markQuestion(true)}>✓ Correct</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
