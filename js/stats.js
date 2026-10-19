// Расчёты Dashboard и Stats — те же формулы, что в таблице.
import { num, parseDT, monthKey } from "./util.js";

const C = { open: 0, close: 1, dir: 2, pair: 3, session: 4, poi: 5, entry: 6, result: 7, rr: 8, risk: 9, profit: 10 };
export { C as COL };

const res = (t) => String(t.v[C.result] ?? "").trim();
const profit = (t) => { const x = num(t.v[C.profit]); return Number.isNaN(x) ? 0 : x; };
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const lc = (s) => String(s ?? "").toLowerCase();

function block(rows, match, withRR = false) {
  const m = rows.filter(match);
  const done = m.filter((t) => res(t) !== "" && res(t) !== "BE");
  const win = m.filter((t) => res(t) === "Win");
  const out = { trades: done.length, win: win.length, winrate: done.length ? win.length / done.length : 0 };
  if (withRR) { const r = avg(win.map((t) => num(t.v[C.rr])).filter((x) => !Number.isNaN(x))); out.rr = Number.isNaN(r) ? 0 : r; }
  return out;
}

// trades — в порядке строк таблицы.
export function compute(trades, lists) {
  const done = trades.filter((t) => res(t) !== "");
  const wins = done.filter((t) => res(t) === "Win");
  const loses = done.filter((t) => res(t) === "Lose");
  const nonBE = done.filter((t) => res(t) !== "BE");

  const rrWins = wins.map((t) => num(t.v[C.rr])).filter((x) => !Number.isNaN(x));
  const loseSum = Math.abs(sum(loses, profit));
  const expR = done.map((t) => [profit(t), num(t.v[C.risk])]).filter(([, r]) => r > 0).map(([p, r]) => p / r);
  const totalR = expR.reduce((s, x) => s + x, 0);
  const dur = done.map((t) => parseDT(t.v[C.close]) - parseDT(t.v[C.open])).filter((x) => !Number.isNaN(x));

  // Equity Curve и Max Drawdown (SCAN по колонке Profit)
  let acc = 0, dd = 0, maxDD = 0;
  const equity = [];
  for (const t of trades) {
    const raw = t.v[C.profit];
    const p = profit(t);
    acc += p;
    dd = Math.max(0, dd - p);
    maxDD = Math.max(maxDD, dd);
    if (raw !== "") equity.push({ t, y: acc });
  }

  const kpi = {
    total: done.length,
    winrate: nonBE.length ? wins.length / nonBE.length : 0,
    avgRR: rrWins.length ? avg(rrWins) : 0,
    pf: loseSum ? sum(wins, profit) / loseSum : null, // null = «No Losses»
    expectancy: expR.length ? avg(expR) : 0,
    totalR,
    withRisk: expR.length, // сколько сделок с Risk — по ним считаются R
    duration: dur.length ? avg(dur) : 0,
    maxDD,
    profit: sum(trades, profit),
  };

  const poi = lists.poi.map((name) => ({ name, ...block(trades, (t) => lc(t.v[C.poi]).includes(lc(name).trim())) }));
  const entry = lists.entry.map((name) => ({ name, ...block(trades, (t) => lc(t.v[C.entry]).includes(lc(name).trim())) }));
  const session = ["Asia", "Frankfurt", "London", "NY"].map((name) => ({
    name, ...block(trades, (t) => lc(t.v[C.session]).trim() === lc(name), true),
  }));

  // По инструментам — дополнительно к таблице.
  const pairs = [...new Set(trades.map((t) => String(t.v[C.pair] || "").trim()).filter(Boolean))].sort();
  const pair = pairs.map((name) => {
    const m = trades.filter((t) => String(t.v[C.pair]).trim() === name);
    const w = sum(m.filter((t) => res(t) === "Win"), profit), l = Math.abs(sum(m.filter((t) => res(t) === "Lose"), profit));
    return { name, ...block(m, () => true), profit: sum(m, profit), pf: l ? w / l : null };
  });

  // Stats: сводная по месяцам (Trades = COUNTA(Result), Profit = SUM, WinRate = Win / (Win + Lose))
  const months = new Map();
  for (const t of trades) {
    const s = parseDT(t.v[C.open]);
    if (Number.isNaN(s)) continue;
    const k = monthKey(s);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(t);
  }
  const monthRow = (key, m) => {
    const w = m.filter((t) => res(t) === "Win").length, l = m.filter((t) => res(t) === "Lose").length;
    return { key, trades: m.filter((t) => res(t) !== "").length, profit: sum(m, profit), winrate: w + l ? w / (w + l) : 0 };
  };
  const monthly = [...months.keys()].sort().map((k) => monthRow(k, months.get(k)));
  const monthlyTotal = monthRow("total", [...months.values()].flat());

  return { kpi, equity, poi, entry, session, pair, monthly, monthlyTotal };
}

