import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type PersistedBoard = {
  id: string
  name: string
  categories: unknown
  questionSets: unknown
}

export type PersistedRoom = {
  code: string
  boardId: string
  gameName: string
  gameStarted: boolean
  round: 1 | 2 | 3
  boardControlTeamId: string | null
  teams: unknown
  playedQuestionIds: string[]
  mediaByQuestion: unknown
  finalCategory: string
  finalPrompt: string
  finalRevealed: boolean
  finalWagers: Record<string, number>
  finalAnswers: Record<string, string>
  finalScoredTeamIds: string[]
}

const databasePath = join(process.cwd(), 'data', 'jeopardy.sqlite')
mkdirSync(dirname(databasePath), { recursive: true })
const db = new DatabaseSync(databasePath)

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    question_sets_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    game_name TEXT NOT NULL,
    game_started INTEGER NOT NULL,
    round INTEGER NOT NULL,
    board_control_team_id TEXT,
    teams_json TEXT NOT NULL,
    played_question_ids_json TEXT NOT NULL,
    media_by_question_json TEXT NOT NULL,
    final_category TEXT NOT NULL DEFAULT 'Final Jeopardy',
    final_prompt TEXT NOT NULL DEFAULT '',
    final_revealed INTEGER NOT NULL DEFAULT 0,
    final_wagers_json TEXT NOT NULL DEFAULT '{}',
    final_answers_json TEXT NOT NULL DEFAULT '{}',
    final_scored_team_ids_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
`)

for (const statement of [
  "ALTER TABLE rooms ADD COLUMN final_category TEXT NOT NULL DEFAULT 'Final Jeopardy'",
  "ALTER TABLE rooms ADD COLUMN final_prompt TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE rooms ADD COLUMN final_revealed INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE rooms ADD COLUMN final_wagers_json TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE rooms ADD COLUMN final_answers_json TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE rooms ADD COLUMN final_scored_team_ids_json TEXT NOT NULL DEFAULT '[]'",
]) {
  try { db.exec(statement) } catch { /* Existing databases already have this column. */ }
}

export function saveBoard(board: PersistedBoard) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO boards (id, name, categories_json, question_sets_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      categories_json = excluded.categories_json,
      question_sets_json = excluded.question_sets_json,
      updated_at = excluded.updated_at
  `).run(board.id, board.name, JSON.stringify(board.categories), JSON.stringify(board.questionSets), now, now)
}

export function loadBoard(id: string) {
  const row = db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    id: String(row.id),
    name: String(row.name),
    categories: JSON.parse(String(row.categories_json)),
    questionSets: JSON.parse(String(row.question_sets_json)),
  } satisfies PersistedBoard
}

export function loadLatestBoard() {
  const row = db.prepare('SELECT id FROM boards ORDER BY updated_at DESC LIMIT 1').get() as { id?: string } | undefined
  return row?.id ? loadBoard(row.id) : undefined
}

export function listBoards() {
  const rows = db.prepare('SELECT id, name, created_at, updated_at FROM boards ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }))
}

export function deleteBoard(id: string) {
  db.prepare('DELETE FROM boards WHERE id = ?').run(id)
}

export function deleteRoom(code: string) {
  db.prepare('DELETE FROM rooms WHERE code = ?').run(code)
}

export function deleteExpiredRooms(cutoff: string) {
  const rows = db.prepare('SELECT code FROM rooms WHERE updated_at < ?').all(cutoff) as Array<{ code: string }>
  db.prepare('DELETE FROM rooms WHERE updated_at < ?').run(cutoff)
  return rows.map((row) => row.code)
}

export function listReferencedMediaUrls() {
  const urls = new Set<string>()
  const rows = db.prepare('SELECT question_sets_json, media_by_question_json FROM boards JOIN rooms ON rooms.board_id = boards.id').all() as Array<{ question_sets_json: string; media_by_question_json: string }>
  const boardRows = db.prepare('SELECT question_sets_json FROM boards').all() as Array<{ question_sets_json: string }>
  for (const row of [...rows, ...boardRows]) {
    for (const value of [row.question_sets_json, 'media_by_question_json' in row ? row.media_by_question_json : undefined]) {
      if (typeof value !== 'string') continue
      for (const match of value.matchAll(/\/media\/[a-f0-9-]+\.[a-z0-9]+/gi)) urls.add(match[0])
    }
  }
  return urls
}

export function saveRoom(room: PersistedRoom) {
  db.prepare(`
    INSERT INTO rooms (code, board_id, game_name, game_started, round, board_control_team_id, teams_json, played_question_ids_json, media_by_question_json, final_category, final_prompt, final_revealed, final_wagers_json, final_answers_json, final_scored_team_ids_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      board_id = excluded.board_id,
      game_name = excluded.game_name,
      game_started = excluded.game_started,
      round = excluded.round,
      board_control_team_id = excluded.board_control_team_id,
      teams_json = excluded.teams_json,
      played_question_ids_json = excluded.played_question_ids_json,
      media_by_question_json = excluded.media_by_question_json,
      final_category = excluded.final_category,
      final_prompt = excluded.final_prompt,
      final_revealed = excluded.final_revealed,
      final_wagers_json = excluded.final_wagers_json,
      final_answers_json = excluded.final_answers_json,
      final_scored_team_ids_json = excluded.final_scored_team_ids_json,
      updated_at = excluded.updated_at
  `).run(
    room.code,
    room.boardId,
    room.gameName,
    room.gameStarted ? 1 : 0,
    room.round,
    room.boardControlTeamId,
    JSON.stringify(room.teams),
    JSON.stringify(room.playedQuestionIds),
    JSON.stringify(room.mediaByQuestion),
    room.finalCategory,
    room.finalPrompt,
    room.finalRevealed ? 1 : 0,
    JSON.stringify(room.finalWagers),
    JSON.stringify(room.finalAnswers),
    JSON.stringify(room.finalScoredTeamIds),
    new Date().toISOString(),
  )
}

export function loadRoom(code: string) {
  const row = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    code: String(row.code),
    boardId: String(row.board_id),
    gameName: String(row.game_name),
    gameStarted: Boolean(row.game_started),
    round: Number(row.round) as 1 | 2 | 3,
    boardControlTeamId: row.board_control_team_id == null ? null : String(row.board_control_team_id),
    teams: JSON.parse(String(row.teams_json)),
    playedQuestionIds: JSON.parse(String(row.played_question_ids_json)),
    mediaByQuestion: JSON.parse(String(row.media_by_question_json)),
    finalCategory: String(row.final_category ?? 'Final Jeopardy'),
    finalPrompt: String(row.final_prompt ?? ''),
    finalRevealed: Boolean(row.final_revealed),
    finalWagers: JSON.parse(String(row.final_wagers_json ?? '{}')),
    finalAnswers: JSON.parse(String(row.final_answers_json ?? '{}')),
    finalScoredTeamIds: JSON.parse(String(row.final_scored_team_ids_json ?? '[]')),
  } satisfies PersistedRoom
}
