const Database = require('better-sqlite3');
const path = require('path');

// 数据目录：优先取环境变量 DATA_DIR（Docker 卷挂载点），默认回退到本目录 data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'soraika.db');

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── 表结构 ──

db.exec(`
  CREATE TABLE IF NOT EXISTS anime (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    bgm_id INTEGER,
    poster TEXT,
    rating REAL,
    tags TEXT,
    studio TEXT,
    summary TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS downloads (
    hash TEXT PRIMARY KEY,
    anime_name TEXT NOT NULL,
    season INTEGER NOT NULL DEFAULT 1,
    episode INTEGER,
    save_path TEXT,
    magnet TEXT,
    poster TEXT,
    rating REAL,
    anime_tags TEXT,
    studio TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ── migration：旧表缺 poster/rating/anime_tags/studio 列自动补 ──
const dlCols = db.prepare("PRAGMA table_info('downloads')").all().map(c => c.name);
if (!dlCols.includes('poster')) db.exec("ALTER TABLE downloads ADD COLUMN poster TEXT");
if (!dlCols.includes('rating')) db.exec("ALTER TABLE downloads ADD COLUMN rating REAL");
if (!dlCols.includes('anime_tags')) db.exec("ALTER TABLE downloads ADD COLUMN anime_tags TEXT");
if (!dlCols.includes('studio')) db.exec("ALTER TABLE downloads ADD COLUMN studio TEXT");

// 修复已有脏数据：从 save_path 重新提取正确的 anime_name
db.exec(`
  UPDATE downloads SET anime_name = CASE
    WHEN save_path LIKE '%/%' THEN substr(save_path, 1, instr(save_path, '/') - 1)
    ELSE save_path
  END
  WHERE anime_name LIKE 'SE%' OR anime_name = ''
`);

// ── anime ──

function upsertAnime(name, meta = {}) {
  const existing = db.prepare('SELECT id FROM anime WHERE name = ?').get(name);
  if (existing) {
    db.prepare(`
      UPDATE anime SET bgm_id = COALESCE(?, bgm_id), poster = COALESCE(?, poster),
        rating = COALESCE(?, rating), tags = COALESCE(?, tags), studio = COALESCE(?, studio),
        summary = COALESCE(?, summary), updated_at = strftime('%s','now')
      WHERE name = ?
    `).run(meta.bgmId || null, meta.poster || null, meta.rating || null,
      meta.tags || null, meta.studio || null, meta.summary || null, name);
  } else {
    db.prepare(`
      INSERT INTO anime (name, bgm_id, poster, rating, tags, studio, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, meta.bgmId || null, meta.poster || null, meta.rating || null,
      meta.tags || null, meta.studio || null, meta.summary || null);
  }
}

function getAnime(name) {
  return db.prepare('SELECT * FROM anime WHERE name = ?').get(name) || null;
}

function getAllAnime() {
  return db.prepare('SELECT * FROM anime ORDER BY updated_at DESC').all();
}

// ── downloads ──

function insertDownload({ hash, animeName, season, episode, savePath, magnet, poster, rating, animeTags, studio } = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO downloads
      (hash, anime_name, season, episode, save_path, magnet, poster, rating, anime_tags, studio, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
  `).run(hash, animeName, season, episode, savePath, magnet, poster || null, rating || null, animeTags || null, studio || null);
}

function getDownloads() {
  return db.prepare(`
    SELECT * FROM downloads ORDER BY created_at DESC
  `).all();
}

module.exports = { upsertAnime, getAnime, getAllAnime, insertDownload, getDownloads };