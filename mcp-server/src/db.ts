import sqlite3 from 'sqlite3'
import { open, Database } from 'sqlite'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_PATH = path.join(__dirname, '..', 'database.sqlite')

let db: Database | null = null

export async function initDb(): Promise<Database> {
  if (db) return db

  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  })

  // Create settings table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `)

  // Create chat_history table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT,
      message TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Set default settings if not exists
  const defaultSettings = {
    provider: 'groq',
    api_key: '',
    endpoint: 'https://api.groq.com/openai/v1',
    model: 'llama3-8b-8192',
    system_prompt: 'Anda adalah Hiyori, asisten virtual Live2D yang ramah, sopan, dan ekspresif. Jawab pertanyaan pengguna dalam bahasa Indonesia yang natural, hangat, dan menyenangkan. Selalu jawab dengan format JSON terstruktur yang berisi teks respon Anda ("text"), emosi ekspresi wajah ("expression": salah satu dari: happy/sad/angry/surprised/neutral/shy/wink/excited), dan gerakan animasi tubuh ("motion": salah satu dari: Tap@Body/Flick@Body/Idle/Flick/FlickDown/FlickUp/Tap/Dance/Jump/Shake/Nod). Contoh format respons:\n{\n  "text": "Halo! Ada yang bisa saya bantu hari ini?",\n  "expression": "happy",\n  "motion": "Tap@Body"\n}',
  }

  for (const [key, val] of Object.entries(defaultSettings)) {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', key)
    if (!row) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', key, val)
    }
  }

  // Automatic migration: update outdated default system prompts
  const currentPromptRow = await db.get('SELECT value FROM settings WHERE key = ?', 'system_prompt')
  if (currentPromptRow) {
    const curVal = currentPromptRow.value || ''
    if (curVal.includes('TapBody/Idle/Flick/dsb') || !curVal.includes('Dance/Jump/Shake/Nod')) {
      console.error('[DB] Stale default system prompt detected. Migrating to the new one containing Dance/Jump/Shake/Nod...')
      await db.run('UPDATE settings SET value = ? WHERE key = ?', defaultSettings.system_prompt, 'system_prompt')
    }
  }

  console.error('[DB] SQLite Database initialized at:', DB_PATH)
  return db
}

export async function getSetting(key: string): Promise<string> {
  const database = await initDb()
  const row = await database.get('SELECT value FROM settings WHERE key = ?', key)
  return row ? row.value : ''
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const database = await initDb()
  const rows = await database.all('SELECT key, value FROM settings')
  const settings: Record<string, string> = {}
  for (const row of rows) {
    settings[row.key] = row.value
  }
  return settings
}

export async function setSetting(key: string, value: string): Promise<void> {
  const database = await initDb()
  await database.run(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    key,
    value
  )
}

export async function saveChatMessage(sender: 'user' | 'assistant', message: string): Promise<void> {
  const database = await initDb()
  await database.run(
    'INSERT INTO chat_history (sender, message) VALUES (?, ?)',
    sender,
    message
  )
}

export async function getRecentChatHistory(limit = 10): Promise<Array<{ sender: string; message: string }>> {
  const database = await initDb()
  const rows = await database.all(
    'SELECT sender, message FROM chat_history ORDER BY id DESC LIMIT ?',
    limit
  )
  // Reverse to make it chronological
  return rows.reverse()
}

export async function clearChatHistory(): Promise<void> {
  const database = await initDb()
  await database.run('DELETE FROM chat_history')
}
