// Экономический календарь (Forex Factory). Данные — calendar.json рядом с приложением: его раз в час
// обновляет GitHub Actions (scripts/ff_calendar.py). Здесь: загрузка, фильтр, «опасное окно» вокруг новостей.
import { lsGet, lsSet } from "./util.js";

export const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "CNY", "All"];
export const IMPACTS = ["High", "Medium", "Low", "Holiday"];
export const RANGES = ["today", "tomorrow", "week", "next", "past"];

export const DEFAULT = { cur: CURRENCIES.slice(), impact: ["High", "Medium", "Low", "Holiday"], range: "week", q: "", window: 15, notify: false };
let F = { ...DEFAULT };
let DATA = { events: [], fetched: "" };
let loadedAt = 0;

export const filter = () => F;
export function setFilter(json) {
  try {
    const d = typeof json === "string" ? JSON.parse(json || "null") : json;
    if (d && typeof d === "object") F = { ...DEFAULT, ...d };
  } catch { /* испорченный фильтр — по умолчанию */ }
  lsSet("tj.news", JSON.stringify(F));
  return F;
}
setFilter(lsGet("tj.news")); // до загрузки таблицы — последний фильтр с этого устройства

export const data = () => DATA;
export async function load(force = false) {
  if (!force && Date.now() - loadedAt < 4 * 60e3 && DATA.events.length) return DATA;
  const r = await fetch("calendar.json?t=" + Math.floor(Date.now() / 60e3), { cache: "no-store" });
  if (!r.ok) throw new Error("calendar.json: " + r.status);
  const d = await r.json();
  DATA = { ...d, events: (d.events || []).map((e) => ({ ...e, ms: Date.parse(e.t) })) };
  loadedAt = Date.now();
  return DATA;
}

// Валюты, которые двигают активы пользователя (для кнопки «Мои активы»).
const IDX = { GER40: "EUR", DAX40: "EUR", DE40: "EUR", EU50: "EUR", STOXX50: "EUR", FRA40: "EUR", UK100: "GBP", FTSE100: "GBP",
  US30: "USD", NAS100: "USD", US100: "USD", SPX500: "USD", US500: "USD", USTEC: "USD", US2000: "USD", JP225: "JPY", NIKKEI: "JPY",
  AUS200: "AUD", HK50: "CNY", CHINA50: "CNY", USOIL: "USD", UKOIL: "USD", WTI: "USD", BRENT: "USD", GOLD: "USD", SILVER: "USD" };
export function currenciesOf(pairs) {
  const set = new Set();
  for (const raw of pairs || []) {
    const p = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (IDX[p]) { set.add(IDX[p]); continue; }
    if (/USDT$|USDC$/.test(p)) set.add("USD"); // крипта к доллару
    const a = p.slice(0, 3), b = p.slice(3, 6);
    for (const c of [a, b]) if (CURRENCIES.includes(c)) set.add(c);
    if (/^X(AU|AG|PT|PD)/.test(p)) set.add("USD");
  }
  return [...set];
}

// Границы периода в локальном времени устройства.
function bounds(range, now = Date.now()) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const day = 864e5, t0 = d0.getTime();
  if (range === "today") return [t0, t0 + day];
  if (range === "tomorrow") return [t0 + day, t0 + 2 * day];
  if (range === "next") return [now - 60 * 60e3, now + day]; // ближайшие 24 часа (и последний час)
  if (range === "past") return [now - 8 * 7 * day, now];
  return [-Infinity, Infinity]; // неделя: всё, что есть в выгрузке за текущую неделю
}

export function visible(events = DATA.events, f = F, now = Date.now()) {
  const [a, b] = bounds(f.range, now);
  const q = f.q.trim().toLowerCase();
  let list = events.filter((e) => f.cur.includes(e.cur) && f.impact.includes(e.impact) && e.ms >= a && e.ms < b && (!q || e.title.toLowerCase().includes(q)));
  if (f.range === "week") {
    // «Неделя» — текущая неделя с воскресенья, как на Forex Factory
    const s = new Date(now); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - s.getDay());
    list = list.filter((e) => e.ms >= s.getTime() && e.ms < s.getTime() + 7 * 864e5);
  }
  if (f.range === "past") list = list.reverse();
  return list;
}

// Сильные новости по валютам фильтра: ближайшая и «опасное окно» (N минут до и после выхода).
export function danger(now = Date.now(), f = F) {
  const w = (Number(f.window) || 15) * 60e3;
  const high = DATA.events.filter((e) => e.impact === "High" && e.exact && f.cur.includes(e.cur));
  const active = high.filter((e) => now >= e.ms - w && now <= e.ms + w);
  const next = high.find((e) => e.ms > now) || null;
  return { active, next, window: w };
}

// «8 мин», «1 ч 12 мин», «3 дн» (en: 8 min, 1 h 12 min, 3 d)
export function fmtLeft(ms, en = false) {
  const m = Math.max(0, Math.round(Math.abs(ms) / 60e3));
  const [mn, hh, dd] = en ? ["min", "h", "d"] : ["мин", "ч", "дн"];
  if (m < 60) return `${m} ${mn}`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} ${hh} ${r} ${mn}` : `${h} ${hh}`;
  return `${Math.round(h / 24)} ${dd}`;
}
