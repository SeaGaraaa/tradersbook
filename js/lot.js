// Калькулятор лота: сколько лотов открыть, чтобы при стопе потерять ровно выбранный риск.
// Лот = деньги риска / (расстояние до стопа × размер контракта × курс валюты котировки к валюте счёта).
import { lsGet, lsSet } from "./util.js";

const FX = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "SGD", "HKD", "PLN", "ZAR", "MXN", "TRY", "CNH", "CZK", "HUF", "DKK"];
// Типовые спецификации MT4/MT5 (так у большинства брокеров и проп-компаний). У своего брокера сверить:
// «Обзор рынка» → правый клик по символу → «Спецификация» → «Размер контракта».
const PRESETS = {
  XAUUSD: { contract: 100, quote: "USD", pip: 0.1, kind: "metal" }, GOLD: { contract: 100, quote: "USD", pip: 0.1, kind: "metal" },
  XAGUSD: { contract: 5000, quote: "USD", pip: 0.01, kind: "metal" }, SILVER: { contract: 5000, quote: "USD", pip: 0.01, kind: "metal" },
  XPTUSD: { contract: 100, quote: "USD", pip: 0.1, kind: "metal" },
  GER40: { contract: 1, quote: "EUR", pip: 1, kind: "index" }, DAX40: { contract: 1, quote: "EUR", pip: 1, kind: "index" }, DE40: { contract: 1, quote: "EUR", pip: 1, kind: "index" },
  FRA40: { contract: 1, quote: "EUR", pip: 1, kind: "index" }, EU50: { contract: 1, quote: "EUR", pip: 1, kind: "index" }, STOXX50: { contract: 1, quote: "EUR", pip: 1, kind: "index" },
  UK100: { contract: 1, quote: "GBP", pip: 1, kind: "index" },
  US30: { contract: 1, quote: "USD", pip: 1, kind: "index" }, NAS100: { contract: 1, quote: "USD", pip: 1, kind: "index" }, US100: { contract: 1, quote: "USD", pip: 1, kind: "index" },
  USTEC: { contract: 1, quote: "USD", pip: 1, kind: "index" }, SPX500: { contract: 1, quote: "USD", pip: 1, kind: "index" }, US500: { contract: 1, quote: "USD", pip: 1, kind: "index" },
  US2000: { contract: 1, quote: "USD", pip: 1, kind: "index" }, JP225: { contract: 1, quote: "JPY", pip: 1, kind: "index" }, AUS200: { contract: 1, quote: "AUD", pip: 1, kind: "index" },
  HK50: { contract: 1, quote: "HKD", pip: 1, kind: "index" },
  USOIL: { contract: 1000, quote: "USD", pip: 0.01, kind: "energy" }, WTI: { contract: 1000, quote: "USD", pip: 0.01, kind: "energy" }, XTIUSD: { contract: 1000, quote: "USD", pip: 0.01, kind: "energy" },
  UKOIL: { contract: 1000, quote: "USD", pip: 0.01, kind: "energy" }, BRENT: { contract: 1000, quote: "USD", pip: 0.01, kind: "energy" }, XBRUSD: { contract: 1000, quote: "USD", pip: 0.01, kind: "energy" },
  BTCUSD: { contract: 1, quote: "USD", pip: 1, kind: "crypto" }, ETHUSD: { contract: 1, quote: "USD", pip: 1, kind: "crypto" },
  SOLUSD: { contract: 1, quote: "USD", pip: 0.01, kind: "crypto" }, XRPUSD: { contract: 1, quote: "USD", pip: 0.0001, kind: "crypto" },
};
export const COMMON = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD", "EURGBP", "EURJPY", "GBPJPY", "XAUUSD", "XAGUSD", "GER40", "US30", "NAS100", "SPX500", "UK100", "USOIL", "BTCUSD", "ETHUSD"];

export const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Спецификация символа: своя (пользователь поправил) -> заготовка -> валютная пара -> неизвестно.
export function spec(sym, overrides = {}) {
  const s = norm(sym);
  const base = PRESETS[s] || (s.length === 6 && FX.includes(s.slice(0, 3)) && FX.includes(s.slice(3))
    ? { contract: 100000, quote: s.slice(3), pip: s.slice(3) === "JPY" ? 0.01 : 0.0001, kind: "fx", base: s.slice(0, 3) }
    : null);
  const o = overrides[s];
  if (!base && !o) return null;
  return { kind: "custom", ...(base || {}), ...(o || {}), sym: s, custom: !!o, preset: !!base };
}

// Курсы валют (ECB, раз в день): сколько единиц валюты за 1 единицу валюты счёта.
let RATES = null;
export async function rates(acc) {
  const key = "tj.fx." + acc;
  try {
    const c = JSON.parse(lsGet(key) || "null");
    if (c && Date.now() - c.at < 6 * 3600e3) return (RATES = c);
  } catch { /* нет кэша */ }
  const tries = [
    async () => { const r = await (await fetch(`https://api.frankfurter.dev/v1/latest?from=${acc}`)).json(); return { date: r.date, rates: { ...r.rates, [acc]: 1 } }; },
    async () => { const r = await (await fetch(`https://open.er-api.com/v6/latest/${acc}`)).json(); return { date: r.time_last_update_utc?.slice(5, 16), rates: r.rates }; },
  ];
  for (const t of tries) {
    try { const d = await t(); if (d.rates) { RATES = { ...d, acc, at: Date.now() }; lsSet(key, JSON.stringify(RATES)); return RATES; } } catch { /* следующий источник */ }
  }
  return RATES;
}

// Сколько валюты счёта стоит 1 единица валюты котировки. Пара вида СЧЁТ/XXX (USDJPY на долларовом счёте) —
// точнее всего по цене входа самой пары.
function quoteToAcc(sp, acc, entry, fx) {
  if (sp.quote === acc) return { k: 1, how: "" };
  if (sp.base === acc && entry > 0) return { k: 1 / entry, how: "price" };
  const r = fx?.rates?.[sp.quote];
  return r ? { k: 1 / r, how: "fx", rate: r } : { k: NaN, how: "none" };
}

// p: { balance, acc, riskMode: pct|money, risk, entry, sl, slPips, slMode: price|pips, tp, step, min, sym, overrides }
export function calc(p, fx) {
  const sp = spec(p.sym, p.overrides);
  const out = { spec: sp, errors: [] };
  if (!sp) { out.errors.push("spec"); return out; }
  const balance = +p.balance, risk = +p.risk, entry = +p.entry;
  const riskMoney = p.riskMode === "money" ? risk : balance * risk / 100;
  if (!(riskMoney > 0)) out.errors.push("risk");
  const dist = p.slMode === "pips" ? +p.slPips * sp.pip : Math.abs(entry - +p.sl);
  if (!(dist > 0)) out.errors.push("sl");
  const conv = quoteToAcc(sp, p.acc, entry, fx);
  if (!(conv.k > 0)) out.errors.push("fx");
  if (out.errors.length) return { ...out, riskMoney, dist, conv };
  const perLot = dist * sp.contract * conv.k; // потеря на 1 лот при стопе, в валюте счёта
  const raw = riskMoney / perLot;
  const step = +p.step || 0.01, min = +p.min || step;
  const lots = Math.floor(raw / step + 1e-9) * step;
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const actual = lots * perLot;
  const pipValue = sp.pip * sp.contract * conv.k; // стоимость 1 пипса/пункта на 1 лот
  const dir = p.slMode === "price" && entry > 0 && +p.sl > 0 ? (+p.sl < entry ? 1 : -1) : 0;
  let tp = null;
  if (+p.tp > 0 && entry > 0) {
    const tpDist = (+p.tp - entry) * (dir || 1);
    tp = { ok: !dir || tpDist > 0, dist: Math.abs(+p.tp - entry), rr: Math.abs(+p.tp - entry) / dist, profit: Math.abs(+p.tp - entry) * sp.contract * conv.k * lots };
  }
  return {
    ...out, riskMoney, dist, conv, perLot, raw, lots: +lots.toFixed(dec), dec, actual,
    actualPct: balance > 0 ? actual / balance * 100 : NaN, pips: dist / sp.pip, pipValue, dir, tp, belowMin: lots < min - 1e-9, min,
  };
}
