export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stocks (
  code        TEXT    NOT NULL PRIMARY KEY,
  name        TEXT    NOT NULL,
  market      TEXT    NOT NULL CHECK (market IN ('TWSE','OTC','ETF')),
  currency    TEXT    NOT NULL DEFAULT 'TWD',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code      TEXT    NOT NULL REFERENCES stocks(code),
  type            TEXT    NOT NULL CHECK (type IN ('BUY','SELL','DIVIDEND')),
  date            TEXT    NOT NULL,
  shares          REAL    NOT NULL CHECK (shares > 0),
  price_per_share REAL    NOT NULL CHECK (price_per_share >= 0),
  brokerage_fee   REAL    NOT NULL DEFAULT 0,
  transaction_tax REAL    NOT NULL DEFAULT 0,
  net_amount      REAL    NOT NULL,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_txn_stock_date ON transactions(stock_code, date);
CREATE INDEX IF NOT EXISTS idx_txn_type       ON transactions(type);

CREATE TABLE IF NOT EXISTS fifo_lots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id   INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  stock_code       TEXT    NOT NULL,
  purchase_date    TEXT    NOT NULL,
  original_shares  REAL    NOT NULL,
  remaining_shares REAL    NOT NULL,
  cost_per_share   REAL    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lot_stock ON fifo_lots(stock_code, purchase_date);

CREATE TABLE IF NOT EXISTS realized_pnl (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sell_txn_id     INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  lot_id          INTEGER NOT NULL REFERENCES fifo_lots(id),
  stock_code      TEXT    NOT NULL,
  sell_date       TEXT    NOT NULL,
  shares_sold     REAL    NOT NULL,
  cost_per_share  REAL    NOT NULL,
  sell_price      REAL    NOT NULL,
  gross_profit    REAL    NOT NULL,
  brokerage_fee   REAL    NOT NULL,
  transaction_tax REAL    NOT NULL,
  net_profit      REAL    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rpnl_stock ON realized_pnl(stock_code, sell_date);

CREATE TABLE IF NOT EXISTS price_cache (
  stock_code   TEXT NOT NULL PRIMARY KEY,
  provider     TEXT NOT NULL DEFAULT 'yahoo',
  price        REAL NOT NULL,
  change_abs   REAL,
  change_pct   REAL,
  volume       INTEGER,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('price_provider', 'yahoo'),
  ('cache_ttl_seconds', '900'),
  ('brokerage_fee_rate', '0.001425'),
  ('transaction_tax_rate', '0.003');

CREATE TABLE IF NOT EXISTS radar_stocks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code    TEXT    NOT NULL,
  stock_name    TEXT    NOT NULL,
  market        TEXT    NOT NULL DEFAULT 'TWSE',
  buy_at        REAL,
  stop_loss     REAL,
  target_shares INTEGER,
  note          TEXT,
  remark        TEXT,
  is_holding    INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS radar_inst_cache (
  stock_code  TEXT    NOT NULL PRIMARY KEY,
  date        TEXT    NOT NULL,
  foreign_net INTEGER NOT NULL DEFAULT 0,
  trust_net   INTEGER NOT NULL DEFAULT 0,
  dealer_net  INTEGER NOT NULL DEFAULT 0,
  total_net   INTEGER NOT NULL DEFAULT 0,
  fetched_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS radar_inst_history (
  stock_code  TEXT    NOT NULL,
  date        TEXT    NOT NULL,
  foreign_net INTEGER NOT NULL DEFAULT 0,
  trust_net   INTEGER NOT NULL DEFAULT 0,
  dealer_net  INTEGER NOT NULL DEFAULT 0,
  total_net   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (stock_code, date)
);

CREATE INDEX IF NOT EXISTS idx_inst_history_stock_date
  ON radar_inst_history(stock_code, date DESC);

CREATE TABLE IF NOT EXISTS radar_margin_cache (
  stock_code     TEXT    NOT NULL PRIMARY KEY,
  date           TEXT    NOT NULL,
  margin_balance INTEGER NOT NULL DEFAULT 0,  -- 融資餘額（張）
  margin_change  INTEGER NOT NULL DEFAULT 0,  -- 融資增減
  short_balance  INTEGER NOT NULL DEFAULT 0,  -- 融券餘額（張）
  short_change   INTEGER NOT NULL DEFAULT 0,  -- 融券增減
  fetched_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS radar_fundamental_cache (
  stock_code      TEXT NOT NULL PRIMARY KEY,
  pe              REAL,
  eps             REAL,
  dividend_yield  REAL,    -- 百分比，5.0 = 5%
  market_cap      REAL,    -- 市值（元）
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS radar_backtest_cache (
  stock_code             TEXT NOT NULL PRIMARY KEY,
  green_signal_count     INTEGER NOT NULL DEFAULT 0,
  green_win_rate_5d      REAL,    -- 0-100 百分比
  green_avg_return_5d    REAL,
  green_win_rate_10d     REAL,
  green_avg_return_10d   REAL,
  fetched_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI 過往建議紀錄（讓 AI 下次跑分析時可以自我對帳）
CREATE TABLE IF NOT EXISTS ai_recommendations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code      TEXT    NOT NULL,
  mode            TEXT    NOT NULL,   -- premarket / intraday / postclose
  provider        TEXT    NOT NULL,   -- claude / gemini
  buy_at          REAL,
  stop_loss       REAL,
  target_shares   INTEGER,
  confidence      INTEGER,
  note            TEXT,
  price_at_rec    REAL,               -- 建議時的市價（用來算「預測準不準」）
  recommended_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_rec_date ON ai_recommendations(recommended_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_rec_stock ON ai_recommendations(stock_code, recommended_at DESC);
`;
