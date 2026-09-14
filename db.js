/**
 * db.js — SQLite 数据层
 * 表: keys(卡密) / sessions(会话) / logs(日志) / photos(作品)
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT UNIQUE NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  max_uses    INTEGER NOT NULL DEFAULT 1,   -- 0 = 不限次数
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,                          -- NULL = 永不过期 (ISO 字符串)
  status      TEXT NOT NULL DEFAULT 'active',-- active | banned
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT UNIQUE NOT NULL,
  key_id     INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id     INTEGER,
  key_text   TEXT,
  action     TEXT NOT NULL,   -- generate/redeem/redeem_fail/heartbeat_kick/ban/unban/delete/expire_block
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  title    TEXT NOT NULL,
  filename TEXT NOT NULL,
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(key_id);
`);

const now = () => new Date().toISOString();

/* ---------------- 卡密 ---------------- */
const stmts = {
  insertKey: db.prepare(`INSERT INTO keys (key, note, max_uses, expires_at, created_at)
                         VALUES (@key, @note, @max_uses, @expires_at, @created_at)`),
  getKeyByText: db.prepare(`SELECT * FROM keys WHERE key = ?`),
  getKeyById: db.prepare(`SELECT * FROM keys WHERE id = ?`),
  listKeys: db.prepare(`SELECT * FROM keys ORDER BY id DESC`),
  incUsed: db.prepare(`UPDATE keys SET used_count = used_count + 1 WHERE id = ?`),
  setStatus: db.prepare(`UPDATE keys SET status = ? WHERE id = ?`),
  deleteKey: db.prepare(`DELETE FROM keys WHERE id = ?`),

  insertSession: db.prepare(`INSERT INTO sessions (token, key_id, ip, user_agent, created_at, last_seen, active)
                             VALUES (@token, @key_id, @ip, @user_agent, @created_at, @last_seen, 1)`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE token = ?`),
  touchSession: db.prepare(`UPDATE sessions SET last_seen = ? WHERE token = ?`),
  deactivateByKey: db.prepare(`UPDATE sessions SET active = 0 WHERE key_id = ?`),
  deactivateSession: db.prepare(`UPDATE sessions SET active = 0 WHERE token = ?`),

  insertLog: db.prepare(`INSERT INTO logs (key_id, key_text, action, detail, ip, created_at)
                         VALUES (@key_id, @key_text, @action, @detail, @ip, @created_at)`),
  listLogs: db.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT ? OFFSET ?`),
  countLogs: db.prepare(`SELECT COUNT(*) AS c FROM logs`),

  listPhotos: db.prepare(`SELECT * FROM photos ORDER BY sort, id`),
  getPhoto: db.prepare(`SELECT * FROM photos WHERE id = ?`),
  insertPhoto: db.prepare(`INSERT INTO photos (title, filename, sort) VALUES (?, ?, ?)`),
  countPhotos: db.prepare(`SELECT COUNT(*) AS c FROM photos`),
};

/* ---------------- 工具函数 ---------------- */
function log(action, { keyId = null, keyText = null, detail = '', ip = '' } = {}) {
  stmts.insertLog.run({ key_id: keyId, key_text: keyText, action, detail, ip, created_at: now() });
}

/** 检查卡密当前是否可用, 返回 { ok, reason } */
function checkKeyUsable(k) {
  if (!k) return { ok: false, reason: 'invalid' };
  if (k.status === 'banned') return { ok: false, reason: 'banned' };
  if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (k.max_uses > 0 && k.used_count >= k.max_uses) return { ok: false, reason: 'exhausted' };
  return { ok: true };
}

module.exports = { db, stmts, now, log, checkKeyUsable };
