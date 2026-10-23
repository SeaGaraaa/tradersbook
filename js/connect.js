// Подключения: сделки с бирж и торговых счетов -> строки журнала.
// Всё работает прямо из браузера (биржи и MetaApi разрешают такие запросы). Ключи хранятся только на этом
// устройстве (localStorage) и уходят только на сайт самой биржи / MetaApi. Нужны ключи «только чтение».
import { lsGet, lsSet, sessionOf, parseDT, EPOCH_SHIFT, msToSerial } from "./util.js";
import { MAXCOLS } from "./form.js";

const DAY = 864e5;
const enc = (s) => new TextEncoder().encode(s);
async function hmac(secret, msg, out = "hex") {
  const k = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc(msg)));
  return out === "hex" ? [...sig].map((b) => b.toString(16).padStart(2, "0")).join("") : btoa(String.fromCharCode(...sig));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; };

class ConnError extends Error {}
async function getJson(url, opts = {}) {
  let res;
  try { res = await fetch(url, opts); } catch { throw new ConnError("Нет связи с сервером " + new URL(url).host); }
  let body = null;
  try { body = await res.json(); } catch { /* не JSON */ }
  if (!res.ok) throw new ConnError(body?.msg || body?.message || body?.retMsg || `${res.status} ${res.statusText}`);
  return body;
}

// ---------- источники ----------
export const SOURCES = {
  binance: {
    name: "Binance Futures", kind: "crypto",
    fields: [["key", "API Key"], ["secret", "Secret Key", true]],
    help: "Binance → Профиль → Управление API → Создать API. Оставь только «Разрешить чтение» (Enable Reading).",
  },
  bybit: {
    name: "Bybit (деривативы USDT)", kind: "crypto",
    fields: [["key", "API Key"], ["secret", "API Secret", true]],
    help: "Bybit → Профиль → API → Создать новый ключ → «Системный» → права «Только чтение».",
  },
  okx: {
    name: "OKX (фьючерсы, свопы, маржа)", kind: "crypto",
    fields: [["key", "API Key"], ["secret", "Secret Key", true], ["pass", "Passphrase", true]],
    help: "OKX → Профиль → API → Создать ключ API → права «Чтение» (Read).",
  },
  metaapi: {
    name: "MetaTrader 4/5 через MetaApi", kind: "mt",
    fields: [["token", "MetaApi token", true], ["account", "ID счёта в MetaApi (если уже есть)"],
      ["login", "Номер счёта MT"], ["password", "Пароль инвестора", true], ["server", "Сервер (как в терминале)"], ["platform", "mt5 или mt4"]],
    help: "Для любой проп-компании и брокера на MT4/MT5. Зарегистрируйся на metaapi.cloud, возьми токен на app.metaapi.cloud/token. "
      + "Счёт подключается по паролю инвестора (только чтение). Один счёт у MetaApi бесплатный, дальше — по их тарифам.",
  },
};

// ---------- хранение подключений (только на этом устройстве) ----------
const KEY = "tj.conn";
export function list() { try { return JSON.parse(lsGet(KEY) || "[]"); } catch { return []; } }
export function save(arr) { lsSet(KEY, JSON.stringify(arr)); }
export function upsert(c) { const a = list(); const i = a.findIndex((x) => x.id === c.id); if (i < 0) a.push(c); else a[i] = c; save(a); }
export function remove(id) { save(list().filter((x) => x.id !== id)); }

// ---------- общая сборка позиций из исполнений (биржи) ----------
// fill: { key, sym, t(ms), side(+1 buy / -1 sell), qty, price, fee, pnl? (реализованный, если биржа даёт) }
export function fromFills(fills) {
  const out = [];
  const by = new Map();
  for (const f of fills) { if (!by.has(f.key)) by.set(f.key, []); by.get(f.key).push(f); }
  for (const arr of by.values()) {
    arr.sort((a, b) => a.t - b.t);
    let pos = 0, cur = null;
    const eps = (q) => Math.max(1e-9, q * 1e-7);
    for (const f of arr) {
      let qty = f.qty, fee = f.fee || 0, pnl = f.pnl;
      while (qty > eps(f.qty)) {
        if (Math.abs(pos) <= eps(f.qty)) {
          pos = 0;
          cur = { sym: f.sym, open: f.t, dir: f.side, inQ: 0, inV: 0, outQ: 0, outV: 0, fee: 0, pnl: 0, hasPnl: pnl != null, ids: [] };
        }
        if (f.side === cur.dir) {
          cur.inQ += qty; cur.inV += qty * f.price; cur.fee += fee; pos += f.side * qty;
          cur.ids.push(f.id); qty = 0;
        } else {
          const q = Math.min(qty, Math.abs(pos)), part = q / qty;
          cur.outQ += q; cur.outV += q * f.price; cur.fee += fee * part;
          if (pnl != null) cur.pnl += pnl * part;
          pos += f.side * q; qty -= q; fee -= fee * part; if (pnl != null) pnl -= pnl * part;
          cur.ids.push(f.id);
          if (Math.abs(pos) <= eps(f.qty)) {
            const entry = cur.inV / cur.inQ, exit = cur.outV / cur.outQ;
            const gross = cur.hasPnl ? cur.pnl : (exit - entry) * cur.outQ * cur.dir;
            out.push({ id: `${cur.sym}:${cur.open}:${f.t}`, sym: cur.sym, open: cur.open, close: f.t, dir: cur.dir,
              entry, exit, volume: cur.inQ, pnl: gross - cur.fee });
            pos = 0; cur = null;
            if (qty > eps(f.qty)) continue; // остаток открывает позицию в обратную сторону
          }
        }
      }
    }
  }
  return out;
}

// ---------- Binance USDⓈ-M Futures ----------
async function binance(c, since, progress) {
  const base = "https://fapi.binance.com";
  const call = async (path, params) => {
    const q = new URLSearchParams({ ...params, recvWindow: "10000", timestamp: String(Date.now()) }).toString();
    const sig = await hmac(c.secret, q);
    return getJson(`${base}${path}?${q}&signature=${sig}`, { headers: { "X-MBX-APIKEY": c.key } });
  };
  const acc = await call("/fapi/v2/account", {});
  const balance = n(acc.totalWalletBalance);
  const now = Date.now(), from = Math.max(since, now - 180 * DAY);
  const syms = new Set();
  for (let t = from; t < now; t += 7 * DAY) {
    progress?.(`Binance: ищу пары… ${new Date(t).toLocaleDateString()}`);
    const inc = await call("/fapi/v1/income", { incomeType: "REALIZED_PNL", startTime: t, endTime: Math.min(now, t + 7 * DAY - 1), limit: 1000 });
    for (const x of inc) syms.add(x.symbol);
  }
  const fills = [];
  for (const sym of syms) {
    for (let t = from; t < now; t += 7 * DAY) {
      progress?.(`Binance: ${sym} ${new Date(t).toLocaleDateString()}`);
      const tr = await call("/fapi/v1/userTrades", { symbol: sym, startTime: t, endTime: Math.min(now, t + 7 * DAY - 1), limit: 1000 });
      for (const x of tr) {
        const stable = /^(USDT|USDC|BUSD|FDUSD)$/.test(x.commissionAsset);
        fills.push({ id: x.id, key: sym + ":" + x.positionSide, sym, t: x.time, side: x.side === "BUY" ? 1 : -1, qty: n(x.qty),
          price: n(x.price), fee: stable ? n(x.commission) : 0, pnl: n(x.realizedPnl) });
      }
      await sleep(120);
    }
  }
  return { trades: fromFills(fills), balance, balanceExact: false };
}

// ---------- Bybit v5, линейные контракты ----------
async function bybit(c, since, progress) {
  const base = "https://api.bybit.com";
  const call = async (path, params) => {
    const q = new URLSearchParams(params).toString(), ts = String(Date.now()), rw = "10000";
    const sig = await hmac(c.secret, ts + c.key + rw + q);
    const r = await getJson(`${base}${path}?${q}`, { headers: { "X-BAPI-API-KEY": c.key, "X-BAPI-SIGN": sig, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": rw } });
    if (r.retCode !== 0) throw new ConnError(r.retMsg || "Bybit: ошибка " + r.retCode);
    return r.result;
  };
  let balance = 0;
  for (const accountType of ["UNIFIED", "CONTRACT"]) {
    try { const w = await call("/v5/account/wallet-balance", { accountType }); balance = n(w.list?.[0]?.totalEquity || w.list?.[0]?.totalWalletBalance); if (balance) break; } catch { /* другой тип счёта */ }
  }
  const now = Date.now(), from = Math.max(since, now - 720 * DAY);
  const fills = [];
  for (let t = from; t < now; t += 7 * DAY) {
    progress?.(`Bybit: ${new Date(t).toLocaleDateString()}`);
    let cursor = "";
    do {
      const r = await call("/v5/execution/list", { category: "linear", startTime: t, endTime: Math.min(now, t + 7 * DAY - 1), limit: 100, ...(cursor ? { cursor } : {}) });
      for (const x of r.list || []) {
        if (x.execType && x.execType !== "Trade") continue;
        fills.push({ id: x.execId, key: x.symbol, sym: x.symbol, t: +x.execTime, side: x.side === "Buy" ? 1 : -1, qty: n(x.execQty), price: n(x.execPrice), fee: n(x.execFee) });
      }
      cursor = r.nextPageCursor || "";
      await sleep(100);
    } while (cursor);
  }
  return { trades: fromFills(fills), balance, balanceExact: false };
}

// ---------- OKX: история закрытых позиций ----------
async function okx(c, since, progress) {
  const base = "https://www.okx.com";
  const call = async (path) => {
    const ts = new Date().toISOString();
    const sig = await hmac(c.secret, ts + "GET" + path, "b64");
    const r = await getJson(base + path, { headers: { "OK-ACCESS-KEY": c.key, "OK-ACCESS-SIGN": sig, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": c.pass } });
    if (r.code !== "0") throw new ConnError(r.msg || "OKX: ошибка " + r.code);
    return r.data;
  };
  const bal = await call("/api/v5/account/balance");
  const balance = n(bal?.[0]?.totalEq);
  const trades = [];
  let after = "";
  for (let page = 0; page < 50; page++) {
    progress?.(`OKX: страница ${page + 1}`);
    const d = await call("/api/v5/account/positions-history?limit=100" + (after ? `&after=${after}` : ""));
    if (!d.length) break;
    for (const x of d) {
      const close = +x.uTime;
      if (close < since) continue;
      const dir = x.direction === "short" ? -1 : x.direction === "long" ? 1 : (n(x.closeAvgPx) - n(x.openAvgPx)) * n(x.realizedPnl) >= 0 ? 1 : -1;
      trades.push({ id: `${x.posId}:${x.uTime}`, sym: x.instId, open: +x.cTime, close, dir, entry: n(x.openAvgPx), exit: n(x.closeAvgPx),
        volume: n(x.closeTotalPos), pnl: n(x.realizedPnl) });
    }
    const oldest = Math.min(...d.map((x) => +x.uTime));
    if (oldest < since || d.length < 100) break;
    after = String(oldest);
    await sleep(150);
  }
  return { trades, balance, balanceExact: false };
}

// ---------- MetaTrader 4/5 через MetaApi ----------
const PROV = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts";
const txId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Создать счёт в MetaApi (пароль инвестора дальше не хранится). Возвращает id счёта.
export async function metaapiCreate(c, progress) {
  const tid = txId();
  const body = JSON.stringify({ name: "Trader'sBook " + c.login, login: String(c.login).trim(), password: c.password, server: c.server.trim(),
    platform: /4/.test(c.platform || "") ? "mt4" : "mt5", magic: 0, type: "cloud-g2" });
  for (let i = 0; i < 30; i++) {
    const res = await fetch(PROV, { method: "POST", headers: { "auth-token": c.token, "transaction-id": tid, "Content-Type": "application/json" }, body });
    if (res.status === 201 || res.status === 200) return (await res.json()).id;
    if (res.status === 202) { progress?.("MetaApi: ищет настройки брокера…"); await sleep((+res.headers.get("Retry-After") || 10) * 1000); continue; }
    let msg = ""; try { const j = await res.json(); msg = j.message || ""; } catch { /* нет тела */ }
    throw new ConnError("MetaApi: " + (msg || res.status));
  }
  throw new ConnError("MetaApi: брокер не найден, проверь сервер");
}

async function metaapi(c, since, progress) {
  const H = { "auth-token": c.token };
  const acc = async () => getJson(`${PROV}/${c.account}`, { headers: H });
  let a = await acc();
  const wasUndeployed = a.state !== "DEPLOYED";
  if (wasUndeployed) { progress?.("MetaApi: запускаю подключение к счёту…"); await getJson(`${PROV}/${c.account}/deploy`, { method: "POST", headers: H }).catch(() => {}); }
  for (let i = 0; i < 60 && !(a.state === "DEPLOYED" && a.connectionStatus === "CONNECTED"); i++) {
    progress?.(`MetaApi: жду подключения к брокеру (${a.connectionStatus || a.state})…`);
    await sleep(5000);
    a = await acc();
  }
  if (a.connectionStatus !== "CONNECTED") throw new ConnError("MetaApi: счёт не подключился к брокеру. Проверь номер, пароль инвестора и сервер.");
  const client = `https://mt-client-api-v1.${a.region || "new-york"}.agiliumtrade.ai/users/current/accounts/${c.account}`;
  const deals = [];
  try {
    for (let off = 0; ; off += 1000) {
      progress?.(`MetaApi: загружаю историю (${deals.length})…`);
      const d = await getJson(`${client}/history-deals/time/2000-01-01T00:00:00.000Z/${new Date(Date.now() + DAY).toISOString()}?offset=${off}&limit=1000`, { headers: H });
      deals.push(...d);
      if (d.length < 1000) break;
    }
  } finally {
    if (wasUndeployed) getJson(`${PROV}/${c.account}/undeploy`, { method: "POST", headers: H }).catch(() => {}); // не держим счёт включённым
  }
  const norm = deals.map((d) => ({
    id: d.id, pos: d.positionId, t: Date.parse(d.time), sym: d.symbol,
    type: /BUY$/.test(d.type) ? "buy" : /SELL$/.test(d.type) ? "sell" : /BALANCE|CREDIT|BONUS|CORRECTION/.test(d.type) ? "balance" : "other",
    entry: d.entryType === "DEAL_ENTRY_IN" ? "in" : d.entryType ? "out" : "", vol: n(d.volume), price: n(d.price),
    profit: n(d.profit), comm: n(d.commission), swap: n(d.swap), sl: n(d.stopLoss), tp: n(d.takeProfit), bySL: d.reason === "DEAL_REASON_SL",
  }));
  return { trades: fromMtDeals(norm).filter((t) => t.close >= since), balanceExact: true };
}

// Сделки MT (MetaApi или отчёт терминала) -> позиции с балансом на момент входа и стопом.
// deal: { id, pos, t, sym, type: buy|sell|balance|other, entry: in|out, vol, price, profit, comm, swap, sl, tp, bySL }
export function fromMtDeals(deals) {
  deals = [...deals].sort((a, b) => a.t - b.t);
  const balAt = []; let bal = 0;
  for (const d of deals) { bal += d.profit + d.comm + d.swap; balAt.push([d.t, bal]); }
  const before = (t) => { let b = 0; for (const [x, v] of balAt) { if (x >= t) break; b = v; } return b; };
  const byPos = new Map();
  for (const d of deals) {
    if (d.type !== "buy" && d.type !== "sell") continue;
    if (!byPos.has(d.pos)) byPos.set(d.pos, []);
    byPos.get(d.pos).push(d);
  }
  const out = [];
  for (const [pos, ds] of byPos) {
    const ins = ds.filter((d) => d.entry === "in"), outs = ds.filter((d) => d.entry !== "in");
    if (!ins.length || !outs.length) continue;
    const inQ = ins.reduce((s, d) => s + d.vol, 0), outQ = outs.reduce((s, d) => s + d.vol, 0);
    if (outQ + 1e-9 < inQ) continue; // ещё открыта
    const entry = ins.reduce((s, d) => s + d.vol * d.price, 0) / inQ, exit = outs.reduce((s, d) => s + d.vol * d.price, 0) / outQ;
    const dir = ins[0].type === "buy" ? 1 : -1;
    const gross = ds.reduce((s, d) => s + d.profit, 0), pnl = ds.reduce((s, d) => s + d.profit + d.comm + d.swap, 0);
    const last = outs[outs.length - 1];
    const losing = (p) => p > 0 && (p - entry) * dir < 0, winning = (p) => p > 0 && (p - entry) * dir > 0;
    // SL ордера при входе; иначе последний SL позиции (если он в убыток); иначе цена закрытия по стопу
    // (стоп в безубытке или подтянутый в плюс — начальный риск неизвестен, Risk остаётся пустым)
    const sl = ins[0].sl > 0 ? ins[0].sl : losing(last.sl) ? last.sl : last.bySL && !(last.sl > 0) && losing(last.price) ? last.price : 0;
    const slSource = ins[0].sl > 0 ? "order" : sl ? "last" : "";
    const tp = ins[0].tp > 0 ? ins[0].tp : winning(last.tp) ? last.tp : 0;
    const perUnit = exit !== entry ? Math.abs(gross / (exit - entry)) : 0; // деньги за 1.0 цены всей позиции
    out.push({ id: "mt:" + pos, sym: ins[0].sym, open: ins[0].t, close: last.t, dir, entry, exit, volume: inQ, pnl,
      sl, tp, slSource, riskMoney: sl && perUnit ? Math.abs(entry - sl) * perUnit : 0, balance: before(ins[0].t) });
  }
  return out.sort((a, b) => a.open - b.open);
}

// ---------- загрузка и превращение в строки журнала ----------
export async function fetchTrades(c, since, progress) {
  const f = { binance, bybit, okx, metaapi }[c.src];
  const r = await f(c, since, progress);
  // для бирж баланс на момент сделки оцениваем: текущий баланс минус результат более поздних сделок
  if (!r.balanceExact) {
    const sorted = [...r.trades].sort((a, b) => b.close - a.close);
    let bal = r.balance || 0;
    for (const t of sorted) { bal -= t.pnl; t.balance = bal; t.balanceEstimated = true; }
  }
  return r.trades.sort((a, b) => a.open - b.open);
}

const ALIASES = [
  ["GER40", "DAX40", "DE40", "GER30", "DE30", "DAX", "GDAXI"], ["US30", "DJ30", "WS30", "DOW", "DJI"], ["NAS100", "US100", "USTEC", "NDX", "NQ100"],
  ["SPX500", "US500", "SP500", "SPX"], ["UK100", "FTSE100", "FTSE"], ["XAUUSD", "GOLD"], ["XAGUSD", "SILVER"], ["USOIL", "WTI", "XTIUSD"], ["UKOIL", "BRENT", "XBRUSD"],
];
const aliasOf = (p) => ALIASES.find((g) => g.includes(p))?.[0] || p;
// Название пары как в списке пользователя (DAX40 из терминала -> GER40, если в журнале так)
export const pairName = (s, pairs = []) => { const p = normPair(s), a = aliasOf(p); return pairs.find((x) => aliasOf(normPair(x)) === a) || p; };
export const normPair = (s) => String(s || "").toUpperCase().replace(/-SWAP$|-FUTURES$/, "").replace(/\.[A-Z0-9]+$/, "").replace(/[-_/ ]/g, "").replace(/\+$/, "");
const wall = (ms) => msToSerial(ms); // время в поясе журнала, без секунд
const r2 = (x) => Math.round(x * 100) / 100;

export function toRow(t, srcName, pairs = []) {
  const v = new Array(MAXCOLS).fill("");
  const open = wall(t.open), close = wall(t.close);
  const profitPct = t.balance > 0 ? r2(t.pnl / t.balance * 100) : "";
  const riskPct = t.riskMoney && t.balance > 0 ? r2(t.riskMoney / t.balance * 100) : "";
  const R = t.riskMoney ? t.pnl / t.riskMoney : NaN;
  const be = Number.isFinite(R) ? Math.abs(R) <= 0.1 : profitPct !== "" ? Math.abs(profitPct) <= 0.05 : Math.abs(t.pnl) < 1e-9;
  v[0] = open; v[1] = close; v[2] = t.dir > 0 ? "Long" : "Short"; v[3] = pairName(t.sym, pairs); v[4] = sessionOf(open);
  v[7] = be ? "BE" : t.pnl > 0 ? "Win" : "Lose";
  v[8] = t.sl && t.tp && t.entry !== t.sl ? r2(Math.abs(t.tp - t.entry) / Math.abs(t.entry - t.sl)) : "";
  v[9] = riskPct; v[10] = profitPct;
  const notes = [`[авто] ${srcName}`, `вход ${+t.entry.toPrecision(8)}, выход ${+t.exit.toPrecision(8)}`];
  if (t.sl) notes.push(`SL ${+t.sl.toPrecision(8)}${t.slSource === "last" ? " (последний, мог быть перенесён)" : ""}`);
  if (t.balanceEstimated) notes.push("% от оценки баланса (текущий минус более поздние сделки)");
  v[19] = notes.join("; ");
  return v;
}

// Что уже есть: та же пара и вход ±2 минуты (как в sync.py) или сделка уже переносилась на этом устройстве.
const IMP = "tj.imported";
export const imported = () => { try { return new Set(JSON.parse(lsGet(IMP) || "[]")); } catch { return new Set(); } };
export function markImported(ids) { const s = imported(); ids.forEach((i) => s.add(i)); lsSet(IMP, JSON.stringify([...s].slice(-20000))); }
export function isDuplicate(t, journal) {
  const p = aliasOf(normPair(t.sym)), o = wall(t.open);
  return journal.some((x) => aliasOf(normPair(x.v[3])) === p && Math.abs(parseDT(x.v[0]) - o) <= 2 / 1440);
}

// ---------- отчёт терминала MT5 / MT4 (HTML: «История» → правый клик → «Отчёт» → HTML) ----------
// Строки узнаются по форме, а не по названиям столбцов, — подходит отчёт на любом языке терминала.
const DT = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
const num = (s) => { const v = parseFloat(String(s).replace(/[\s\u00a0]/g, "")); return Number.isFinite(v) ? v : 0; };
const wallUTC = (s) => { const m = String(s).match(DT); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN; };

export function decodeReport(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
  return new TextDecoder("utf-8").decode(b);
}

export function parseMtReport(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = [...doc.querySelectorAll("tr")].map((tr) => [...tr.children].filter((c) => !c.classList.contains("hidden")).map((c) => c.textContent.replace(/\u00a0/g, " ").trim()));
  const account = (rows.find((r) => r.length === 2 && /^\d{4,}\s*\(/.test(r[1]))?.[1] || "").match(/^\d+/)?.[0] || "";
  const reportDate = rows.find((r) => r.length === 2 && DT.test(r[1]))?.[1] || "";
  const positions = [], deals = [];
  let platform = "";
  for (const r of rows) {
    // MT5, «Позиции»: время, позиция, символ, тип, объём, цена, S/L, T/P, время, цена, комиссия, своп, прибыль
    if (r.length === 13 && DT.test(r[0]) && DT.test(r[8]) && /^(buy|sell)/i.test(r[3])) {
      platform = "mt5";
      positions.push({ open: r[0], pos: r[1], sym: r[2], dir: /^buy/i.test(r[3]) ? 1 : -1, vol: num(r[4]), entry: num(r[5]), sl: num(r[6]), tp: num(r[7]),
        close: r[8], exit: num(r[9]), comm: num(r[10]), swap: num(r[11]), profit: num(r[12]) });
      continue;
    }
    // MT4, «Закрытые сделки»: тикет, время, тип, объём, символ, цена, S/L, T/P, время, цена, комиссия, налоги, своп, прибыль
    if (r.length >= 14 && DT.test(r[1]) && DT.test(r[8]) && /^(buy|sell)$/i.test(r[2])) {
      platform = "mt4";
      positions.push({ open: r[1], pos: r[0], sym: r[4], dir: /^buy/i.test(r[2]) ? 1 : -1, vol: num(r[3]), entry: num(r[5]), sl: num(r[6]), tp: num(r[7]),
        close: r[8], exit: num(r[9]), comm: num(r[10]) + num(r[11]), swap: num(r[12]), profit: num(r[13]), bySL: /\[sl\]/i.test(r.join(" ")) });
      continue;
    }
    // MT5, «Сделки»: время, сделка, символ, тип, направление, объём, цена, ордер, [издержки], комиссия, сбор, своп, прибыль, баланс, комментарий
    if (r.length >= 14 && DT.test(r[0]) && /^\d+$/.test(r[1]) && !DT.test(r[8])) {
      deals.push({ t: r[0], sym: r[2], type: r[3].toLowerCase(), dirn: r[4].toLowerCase(), price: num(r[6]), profit: num(r.at(-3)), comment: r.at(-1) });
      continue;
    }
    // MT4, пополнения/снятия: тикет, время, balance, комментарий, сумма
    if (r.length >= 4 && r.length <= 6 && DT.test(r[1]) && /^(balance|credit)$/i.test(r[2])) {
      deals.push({ t: r[1], sym: "", type: "balance", dirn: "", price: 0, profit: num(r.at(-1)), comment: r[3] });
    }
  }
  return { account, reportDate, platform, positions, deals };
}

// Часовой пояс сервера: «ny7» — Нью-Йорк + 7 ч (так у большинства брокеров и проп-компаний), или сдвиг от UTC в минутах.
const NY_H = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
function nyOffsetMin(utcMs) { const ny = +NY_H.format(new Date(utcMs)), u = new Date(utcMs).getUTCHours(); let d = ny - u; if (d > 12) d -= 24; if (d < -12) d += 24; return d * 60; }
export function serverToUtc(wallMs, tz) {
  if (tz === "ny7") { const guess = wallMs - (nyOffsetMin(wallMs) + 420) * 60000; return wallMs - (nyOffsetMin(guess) + 420) * 60000; }
  return wallMs - (+tz || 0) * 60000;
}
// Угадать пояс по дате отчёта и времени сохранения файла (обычно сохраняют сразу после создания).
export function guessServerTz(reportDate, savedMs) {
  const w = wallUTC(reportDate);
  if (!Number.isFinite(w) || !savedMs || Math.abs(w - savedMs) > 15 * 3600e3) return "ny7";
  const off = Math.round((w - savedMs) / 1800e3) * 30;
  return off === nyOffsetMin(savedMs) + 420 ? "ny7" : String(off);
}

export function fromReport(p, tz) {
  const T = (s) => serverToUtc(wallUTC(s), tz);
  const slHits = new Set(p.deals.filter((d) => /\[sl/i.test(d.comment) && d.dirn !== "in").map((d) => `${d.sym}|${d.t}`));
  const norm = [];
  for (const d of p.deals) if (!/^(buy|sell)/.test(d.type)) norm.push({ id: "b" + d.t, pos: "", t: T(d.t), sym: "", type: "balance", entry: "", vol: 0, price: 0, profit: d.profit, comm: 0, swap: 0, sl: 0, tp: 0 });
  for (const x of p.positions) {
    const type = x.dir > 0 ? "buy" : "sell", opp = x.dir > 0 ? "sell" : "buy";
    norm.push({ id: x.pos + "i", pos: x.pos, t: T(x.open), sym: x.sym, type, entry: "in", vol: x.vol, price: x.entry, profit: 0, comm: 0, swap: 0, sl: 0, tp: 0 });
    norm.push({ id: x.pos + "o", pos: x.pos, t: T(x.close), sym: x.sym, type: opp, entry: "out", vol: x.vol, price: x.exit, profit: x.profit, comm: x.comm, swap: x.swap,
      sl: x.sl, tp: x.tp, bySL: x.bySL || slHits.has(`${x.sym}|${x.close}`) });
  }
  return fromMtDeals(norm);
}
