/**
 * 数据库层：使用 Node 内置 node:sqlite，零第三方依赖。
 * 数据文件位于 data/bookmark.db（WAL 模式），首次启动自动建表。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, '..', 'data');
export const DB_PATH = join(DATA_DIR, 'bookmark.db');

let db = null;

/** 建表与迁移（用 PRAGMA user_version 记录 schema 版本，便于后续演进） */
function migrate(database) {
  const migrations = [
    // v1: 初始表结构
    `
    CREATE TABLE IF NOT EXISTS categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      title           TEXT NOT NULL,
      url             TEXT NOT NULL,
      notes           TEXT NOT NULL DEFAULT '',
      tags            TEXT NOT NULL DEFAULT '',
      favicon         TEXT NOT NULL DEFAULT '',
      click_count     INTEGER NOT NULL DEFAULT 0,
      last_visited_at TEXT,
      health_status   TEXT NOT NULL DEFAULT 'unknown',
      health_code     INTEGER,
      last_checked_at TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_category ON bookmarks(category_id);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_health  ON bookmarks(health_status);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_clicks  ON bookmarks(click_count DESC);

    CREATE TABLE IF NOT EXISTS visits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      visited_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_visits_bookmark ON visits(bookmark_id);
    `,
  ];

  const current = database.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < migrations.length; v++) {
    database.exec(migrations[v]);
    database.exec(`PRAGMA user_version = ${v + 1}`);
  }
}

/** 打开（或创建）数据库并完成迁移。幂等，可重复调用。 */
export function initDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function getDb() {
  if (!db) initDb();
  return db;
}
