import { getDb } from "../lib/db";

const db = getDb();

const account = db.prepare("SELECT cash_jpy FROM account WHERE id=1").get() as { cash_jpy: number };
const initial = Number((db.prepare("SELECT value FROM settings WHERE key='initial_cash'").get() as { value: string } | undefined)?.value ?? 0);

console.log("=== ACCOUNT ===");
console.log(`cash=${Math.round(account.cash_jpy)} initial=${initial}`);

console.log("\n=== HOLDINGS ===");
const holdings = db.prepare("SELECT ticker, shares, avg_cost_jpy FROM portfolio ORDER BY ticker").all() as { ticker: string; shares: number; avg_cost_jpy: number }[];
if (holdings.length === 0) console.log("(none)");
for (const h of holdings) console.log(`  ${h.ticker}: ${h.shares}sh @ ${Math.round(h.avg_cost_jpy)}`);

console.log("\n=== TRANSACTIONS (oldest first) ===");
const txs = db.prepare("SELECT created_at, ticker, action, shares, price_jpy, total_jpy, source, ai_reasoning FROM transactions ORDER BY id ASC").all() as {
  created_at: string; ticker: string; action: string; shares: number; price_jpy: number; total_jpy: number; source: string; ai_reasoning: string | null;
}[];
console.log(`count=${txs.length}`);
for (const t of txs) {
  console.log(`  [${t.created_at}] ${t.action} ${t.ticker} ${t.shares}sh @${Math.round(t.price_jpy)} (tot${Math.round(t.total_jpy)}) ${t.source}`);
  if (t.ai_reasoning) console.log(`      reason: ${t.ai_reasoning}`);
}

console.log("\n=== PER-TICKER BUY/SELL ===");
const agg = db.prepare(`
  SELECT ticker,
    SUM(CASE WHEN action='BUY' THEN shares ELSE 0 END) AS buy_sh,
    SUM(CASE WHEN action='BUY' THEN total_jpy ELSE 0 END) AS buy_jpy,
    SUM(CASE WHEN action='SELL' THEN shares ELSE 0 END) AS sell_sh,
    SUM(CASE WHEN action='SELL' THEN total_jpy ELSE 0 END) AS sell_jpy
  FROM transactions GROUP BY ticker ORDER BY ticker
`).all() as { ticker: string; buy_sh: number; buy_jpy: number; sell_sh: number; sell_jpy: number }[];
for (const a of agg) {
  const avgBuy = a.buy_sh > 0 ? a.buy_jpy / a.buy_sh : 0;
  const realized = a.sell_sh > 0 ? a.sell_jpy - avgBuy * a.sell_sh : 0;
  console.log(`  ${a.ticker}: BUY ${a.buy_sh}/${Math.round(a.buy_jpy)} SELL ${a.sell_sh}/${Math.round(a.sell_jpy)}` + (a.sell_sh > 0 ? ` => realized~${Math.round(realized)}` : ""));
}

console.log("\n=== EQUITY SNAPSHOTS (latest 10) ===");
const snaps = db.prepare("SELECT created_at, total_value_jpy, cash_jpy FROM equity_snapshots ORDER BY id DESC LIMIT 10").all() as { created_at: string; total_value_jpy: number; cash_jpy: number }[];
for (const s of snaps) console.log(`  [${s.created_at}] total=${Math.round(s.total_value_jpy)} cash=${Math.round(s.cash_jpy)}`);

console.log("\n=== SETTINGS ===");
for (const k of ["last_news", "last_screened", "screened_tickers", "auto_enabled", "interval_minutes"]) {
  const v = (db.prepare("SELECT value FROM settings WHERE key=?").get(k) as { value: string } | undefined)?.value;
  console.log(`  ${k}: ${v ?? "(none)"}`);
}
