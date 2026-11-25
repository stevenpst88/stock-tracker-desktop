import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { app } from 'electron';
import { SCHEMA_SQL } from './schema';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function initDatabase(): DatabaseSync {
  const dbPath = path.join(app.getPath('userData'), 'stock-tracker.db');
  db = new DatabaseSync(dbPath);
  // Enable WAL mode and foreign keys via separate pragma statements
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);

  // Migration v2: 修正 BUY 的 net_amount 計算（舊：-(gross - fee)，新：-(gross + fee)）
  const m2 = db.prepare('SELECT value FROM settings WHERE key = ?').get('migration_v2_buy_net') as { value: string } | undefined;
  if (!m2) {
    db.exec(`
      UPDATE transactions
      SET net_amount = -(shares * price_per_share + brokerage_fee)
      WHERE type = 'BUY'
    `);
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('migration_v2_buy_net', 'done');
    console.log('[DB] Migration v2: BUY net_amount corrected');
  }

  // Migration v3: （已停用）原本會插入 8 支預設雷達股
  // 拿掉的原因：那些股票 + 目標價 + 個人化備註是初版開發測試資料，
  // 不應該強加給新使用者。新裝的 app 應該是真正的空狀態，
  // 由使用者自己用「+ 新增股票」建立。
  // 仍寫入 settings 標記避免之後改回時意外又跑一次。
  const m3 = db.prepare('SELECT value FROM settings WHERE key = ?').get('migration_v3_radar_defaults') as { value: string } | undefined;
  if (!m3) {
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('migration_v3_radar_defaults', 'skipped');
    console.log('[DB] Migration v3: skipped (no default stocks inserted)');
  }

  // Migration v4: target_shares 從「張」改為「股」單位（× 1000）
  // 之前 UI 顯示「目標 N 張」但 DB 欄位名是 target_shares，現在統一用股
  const m4 = db.prepare('SELECT value FROM settings WHERE key = ?').get('migration_v4_target_shares_to_股') as { value: string } | undefined;
  if (!m4) {
    db.exec(`
      UPDATE radar_stocks
      SET target_shares = target_shares * 1000
      WHERE target_shares IS NOT NULL
    `);
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('migration_v4_target_shares_to_股', 'done');
    console.log('[DB] Migration v4: target_shares 張 → 股 (×1000)');
  }

  return db;
}

export function getSetting(key: string): string | null {
  const stmt = getDb().prepare('SELECT value FROM settings WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run(key, value);
}
