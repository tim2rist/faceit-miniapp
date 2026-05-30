import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize DB file at root directory
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new DatabaseSync(dbPath);

// Enable WAL mode for performance
db.exec('PRAGMA journal_mode = WAL');

// Initialize database schema
export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      faceit_nickname TEXT NOT NULL,
      faceit_player_id TEXT NOT NULL,
      last_elo INTEGER,
      day_start_elo INTEGER
    );

    CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS match_elos (
      player_id TEXT,
      match_id TEXT,
      elo INTEGER,
      finished_at INTEGER,
      PRIMARY KEY (player_id, match_id)
    );
  `);

  // Migrate existing tables if they don't have the day_start_elo column
  try {
    db.exec(`ALTER TABLE users ADD COLUMN day_start_elo INTEGER`);
  } catch (e) {
    // Column already exists, ignore error
  }
}

// User CRUD Helpers
export function saveUser(telegramId, faceitNickname, faceitPlayerId, lastElo = null) {
  const stmt = db.prepare(`
    INSERT INTO users (telegram_id, faceit_nickname, faceit_player_id, last_elo, day_start_elo)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      faceit_nickname = excluded.faceit_nickname,
      faceit_player_id = excluded.faceit_player_id,
      last_elo = COALESCE(excluded.last_elo, users.last_elo),
      day_start_elo = COALESCE(excluded.day_start_elo, users.day_start_elo)
  `);
  return stmt.run(telegramId, faceitNickname, faceitPlayerId, lastElo, lastElo);
}

export function getUserByTelegramId(telegramId) {
  const stmt = db.prepare(`SELECT * FROM users WHERE telegram_id = ?`);
  return stmt.get(telegramId);
}

export function getAllUsers() {
  const stmt = db.prepare(`SELECT * FROM users`);
  return stmt.all();
}

export function updateUserElo(telegramId, lastElo) {
  const stmt = db.prepare(`UPDATE users SET last_elo = ? WHERE telegram_id = ?`);
  return stmt.run(lastElo, telegramId);
}

export function shiftDayStartElo(telegramId, newDayStartElo) {
  const stmt = db.prepare(`
    UPDATE users 
    SET last_elo = day_start_elo,
        day_start_elo = ?
    WHERE telegram_id = ?
  `);
  return stmt.run(newDayStartElo, telegramId);
}

export function deleteUser(telegramId) {
  const stmt = db.prepare(`DELETE FROM users WHERE telegram_id = ?`);
  return stmt.run(telegramId);
}

export function deleteUserByNickname(nickname) {
  const stmt = db.prepare(`DELETE FROM users WHERE faceit_nickname = ? COLLATE NOCASE`);
  const result = stmt.run(nickname);
  return result.changes;
}

// Chat Track CRUD Helpers
export function saveChat(chatId) {
  const stmt = db.prepare(`
    INSERT INTO chats (chat_id)
    VALUES (?)
    ON CONFLICT(chat_id) DO NOTHING
  `);
  return stmt.run(chatId);
}

export function getAllChats() {
  const stmt = db.prepare(`SELECT * FROM chats`);
  return stmt.all();
}

export function deleteChat(chatId) {
  const stmt = db.prepare(`DELETE FROM chats WHERE chat_id = ?`);
  return stmt.run(chatId);
}

// Match Elos CRUD Helpers
export function saveMatchElo(playerId, matchId, elo, finishedAt) {
  const stmt = db.prepare(`
    INSERT INTO match_elos (player_id, match_id, elo, finished_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(player_id, match_id) DO UPDATE SET
      elo = excluded.elo,
      finished_at = excluded.finished_at
  `);
  return stmt.run(playerId, matchId, elo, finishedAt);
}

export function getMatchElo(playerId, matchId) {
  const stmt = db.prepare(`SELECT elo FROM match_elos WHERE player_id = ? AND match_id = ?`);
  const row = stmt.get(playerId, matchId);
  return row ? row.elo : null;
}

export function getLatestMatchEloBefore(playerId, timestamp) {
  const stmt = db.prepare(`
    SELECT elo FROM match_elos 
    WHERE player_id = ? AND finished_at < ? 
    ORDER BY finished_at DESC LIMIT 1
  `);
  const row = stmt.get(playerId, timestamp);
  return row ? row.elo : null;
}

export function getLatestMatchEloBetween(playerId, startTimestamp, endTimestamp) {
  const stmt = db.prepare(`
    SELECT elo FROM match_elos 
    WHERE player_id = ? AND finished_at >= ? AND finished_at <= ? 
    ORDER BY finished_at DESC LIMIT 1
  `);
  const row = stmt.get(playerId, startTimestamp, endTimestamp);
  return row ? row.elo : null;
}

// Run schema initialization immediately on load
initDb();
