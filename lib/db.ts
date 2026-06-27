import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

// 仮想資金の初期値（円）
export const DEFAULT_INITIAL_CASH = 1_000_000;

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "sim.db");

let _db: DatabaseSync | null = null;

/**
 * SQLite 接続のシングルトン。初回アクセス時にマイグレーションと seed を行う。
 */
export function getDb(): DatabaseSync {
  if (_db) return _db;

  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  seed(db);
  _db = db;
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cash_jpy REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio (
      ticker        TEXT PRIMARY KEY,
      shares        REAL NOT NULL,
      avg_cost_jpy  REAL NOT NULL,
      market        TEXT NOT NULL DEFAULT 'US'
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker       TEXT NOT NULL,
      action       TEXT NOT NULL,          -- BUY | SELL
      shares       REAL NOT NULL,
      price        REAL NOT NULL,          -- 現地通貨建ての約定単価
      price_jpy    REAL NOT NULL,          -- 円換算した約定単価
      total_jpy    REAL NOT NULL,          -- 円換算した約定総額（コスト込みの受払額）
      fee_jpy      REAL NOT NULL DEFAULT 0,-- 取引コスト（手数料＋スプレッド）円
      realized_pnl_jpy REAL,               -- SELL時の確定損益（円、コスト控除後）。BUYはNULL
      source       TEXT NOT NULL,          -- AI | MANUAL
      ai_reasoning TEXT,                   -- AI判断の理由（あれば）
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      ticker   TEXT PRIMARY KEY,
      market   TEXT NOT NULL DEFAULT 'US',
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      total_value_jpy REAL NOT NULL,
      cash_jpy        REAL NOT NULL,
      benchmark_value_jpy REAL,            -- 同額をSPYでbuy&holdした場合の評価額（円）
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 売買サイクルのログ（フィードバック分析用）
    CREATE TABLE IF NOT EXISTS cycle_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at      TEXT NOT NULL DEFAULT (datetime('now')),
      engine      TEXT NOT NULL,           -- rule | llm
      risk_off    INTEGER NOT NULL DEFAULT 0, -- レジーム: リスクオフなら1
      market_open INTEGER NOT NULL DEFAULT 1, -- 米国市場が開いていたか
      screened    TEXT,                    -- スクリーニング結果(JSON配列)
      decisions   INTEGER NOT NULL DEFAULT 0, -- 判断件数
      executed    INTEGER NOT NULL DEFAULT 0, -- 約定件数
      total_value_jpy REAL,                -- サイクル後の総資産
      cash_jpy    REAL,                    -- サイクル後の現金
      note        TEXT
    );

    -- 各判断の詳細ログ（HOLD・却下も含む全件・後から検証するため指標も保存）
    CREATE TABLE IF NOT EXISTS decision_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at      TEXT NOT NULL DEFAULT (datetime('now')),
      ticker      TEXT NOT NULL,
      action      TEXT NOT NULL,           -- BUY | SELL | HOLD
      shares      REAL NOT NULL DEFAULT 0,
      executed    INTEGER NOT NULL DEFAULT 0,
      reject_reason TEXT,
      reasoning   TEXT,
      price_jpy   REAL,                    -- 判断時の円換算価格
      rsi14       REAL,
      sma20       REAL,
      sma50       REAL,
      mom_pct     REAL,                    -- 20日モメンタム
      day_ret     REAL,                    -- 前日単日リターン
      pnl_pct     REAL                     -- 保有銘柄の含み損益率（SELL/HOLD時）
    );
  `);

  // 既存DBへの後付けマイグレーション（列が無ければ追加）
  addColumnIfMissing(db, "transactions", "fee_jpy", "REAL NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "transactions", "realized_pnl_jpy", "REAL");
  addColumnIfMissing(db, "equity_snapshots", "benchmark_value_jpy", "REAL");
}

/** テーブルに指定列が無ければ ALTER TABLE で追加する。 */
function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  def: string,
) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

function seed(db: DatabaseSync) {
  const row = db.prepare("SELECT COUNT(*) AS c FROM account").get() as {
    c: number;
  };
  if (row.c === 0) {
    db.prepare("INSERT INTO account (id, cash_jpy) VALUES (1, ?)").run(
      DEFAULT_INITIAL_CASH,
    );
  }

  // 既定の設定値
  const defaults: Record<string, string> = {
    auto_enabled: "false",
    interval_minutes: "60",
    initial_cash: String(DEFAULT_INITIAL_CASH),
  };
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
  );
  for (const [k, v] of Object.entries(defaults)) upsert.run(k, v);

  // 初期ウォッチリスト（スクリーナー未実行時のフォールバック用・米国株のみ）
  // 注: 自動売買は米国市場時間に動くため、日本株は約定タイミングが不適切。
  const wlCount = db.prepare("SELECT COUNT(*) AS c FROM watchlist").get() as {
    c: number;
  };
  if (wlCount.c === 0) {
    const insWl = db.prepare(
      "INSERT INTO watchlist (ticker, market) VALUES (?, ?)",
    );
    insWl.run("AAPL", "US");
    insWl.run("NVDA", "US");
    insWl.run("SPY", "US");
  }
}

/* ---------- 設定ヘルパ ---------- */

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

/* ---------- フィードバック用ログ ---------- */

export interface DecisionLogRow {
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  shares: number;
  executed: boolean;
  rejectReason?: string | null;
  reasoning?: string | null;
  priceJpy?: number | null;
  rsi14?: number | null;
  sma20?: number | null;
  sma50?: number | null;
  momPct?: number | null;
  dayRet?: number | null;
  pnlPct?: number | null;
}

export function logDecision(d: DecisionLogRow): void {
  getDb()
    .prepare(
      `INSERT INTO decision_log
        (ticker, action, shares, executed, reject_reason, reasoning, price_jpy, rsi14, sma20, sma50, mom_pct, day_ret, pnl_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.ticker, d.action, d.shares, d.executed ? 1 : 0,
      d.rejectReason ?? null, d.reasoning ?? null, d.priceJpy ?? null,
      d.rsi14 ?? null, d.sma20 ?? null, d.sma50 ?? null,
      d.momPct ?? null, d.dayRet ?? null, d.pnlPct ?? null,
    );
}

export function logCycle(c: {
  engine: string;
  riskOff: boolean;
  marketOpen: boolean;
  screened: string[];
  decisions: number;
  executed: number;
  totalValueJpy: number;
  cashJpy: number;
  note?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO cycle_log
        (engine, risk_off, market_open, screened, decisions, executed, total_value_jpy, cash_jpy, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.engine, c.riskOff ? 1 : 0, c.marketOpen ? 1 : 0,
      JSON.stringify(c.screened), c.decisions, c.executed,
      c.totalValueJpy, c.cashJpy, c.note ?? null,
    );
}
