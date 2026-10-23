// Общие помощники: числа, даты (серийные даты Google Sheets), сессии, ссылки на картинки.
import { LANG } from "./i18n.js";

export const EPOCH_SHIFT = 25569; // дней между 1899-12-30 и 1970-01-01
const DAY_MS = 86400000;

export function num(v) {
  if (typeof v === "number") return v;
  if (v === "" || v == null) return NaN;
  const s = String(v).replace(/−/g, "-").replace(/\s/g, "").replace(",", ".").replace("%", "");
  return s === "" ? NaN : Number(s);
}

export const isNum = (v) => !Number.isNaN(num(v));

// Время в таблице — «настенное» время пояса журнала без часового пояса,
// поэтому везде работаем с UTC-методами Date, чтобы пояс устройства не влиял.
export function serialToDate(s) {
  return new Date(Math.round((s - EPOCH_SHIFT) * DAY_MS / 60000) * 60000);
}

export function dateToSerial(d) {
  return d.getTime() / DAY_MS + EPOCH_SHIFT;
}

// Текст «dd.mm.yyyy HH:MM», если дата вписана строкой.
export function parseDT(v) {
  if (typeof v === "number") return v;
  const m = String(v || "").trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return NaN;
  const ms = Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  return ms / DAY_MS + EPOCH_SHIFT;
}

const pad = (n) => String(n).padStart(2, "0");

export function fmtDT(v, withYear = true) {
  const s = parseDT(v);
  if (Number.isNaN(s)) return String(v ?? "");
  const d = serialToDate(s);
  const date = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}` + (withYear ? `.${d.getUTCFullYear()}` : "");
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function fmtDay(s) {
  const d = serialToDate(s);
  const wd = (LANG === "en" ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : ["вс", "пн", "вт", "ср", "чт", "пт", "сб"])[d.getUTCDay()];
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}, ${wd}`;
}

export function monthKey(s) {
  const d = serialToDate(s);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function fmtMonth(key) {
  const [y, m] = key.split("-");
  const names = LANG === "en"
    ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    : ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  return `${names[+m - 1]} ${y}`;
}

// serial <-> значение <input type="datetime-local">
export function toInput(v) {
  const s = parseDT(v);
  if (Number.isNaN(s)) return "";
  return serialToDate(s).toISOString().slice(0, 16);
}

export function fromInput(v) {
  if (!v) return "";
  const ms = Date.parse(v + ":00Z");
  return Number.isNaN(ms) ? "" : ms / DAY_MS + EPOCH_SHIFT;
}

export const sameMinute = (a, b) => Math.abs(a - b) < 0.5 / 1440;

// Сессия по времени входа. Время в журнале — в поясе журнала (настройка); переводим его в лондонское
// (Европа и Лондон переводят часы одновременно): Азия 00–07, Франкфурт 07–08, Лондон 08–13, Нью-Йорк 13–24.
// Для Бухареста (Лондон + 2 ч) это ровно 02–09, 09–10, 10–15, 15–02 — как в sync.py.
const LONDON_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" });
export function sessionOf(serial) {
  const h = Number(LONDON_HOUR.format(new Date(serialToMs(serial)))) % 24; // время входа -> час по Лондону
  if (h < 7) return "Asia";
  if (h < 8) return "Frankfurt";
  if (h < 13) return "London";
  return "NY";
}

export function fmtNum(x, digits = 2) {
  if (!Number.isFinite(x)) return "";
  return x.toLocaleString(LANG === "en" ? "en-US" : "ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const fmtSigned = (x, digits = 2) => (x > 0 ? "+" : "") + fmtNum(x, digits);
export const fmtPct = (x) => (Number.isFinite(x) ? fmtNum(x * 100, 0) + "%" : "");

export function fmtDuration(days) {
  if (!Number.isFinite(days) || days <= 0) return "—";
  const mins = Math.round(days * 1440);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const [D, H, M] = LANG === "en" ? ["d", "h", "m"] : ["д", "ч", "м"];
  if (d) return `${d} ${D} ${h} ${H}`;
  if (h) return `${h} ${H} ${m} ${M}`;
  return `${m} ${M}`;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Ссылки на скриншоты
export function tvImage(url) {
  const m = String(url).match(/tradingview\.com\/x\/([A-Za-z0-9]+)/);
  return m ? `https://s3.tradingview.com/snapshots/${m[1][0].toLowerCase()}/${m[1]}.png` : null;
}

export function driveId(url) {
  const s = String(url);
  if (!/drive\.google\.com|docs\.google\.com/.test(s)) return null;
  const m = s.match(/\/d\/([\w-]{20,})/) || s.match(/[?&]id=([\w-]{20,})/);
  return m ? m[1] : null;
}

export const directImage = (url) => /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(url);

export function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } }
export function lsDel(k) { try { localStorage.removeItem(k); } catch { /* приватный режим */ } }

// ---------- часовой пояс журнала ----------
// Время в таблице — «настенное» время пояса журнала (настройка пользователя; по умолчанию — пояс устройства).
let TZ = "";
export const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
export function setJournalTz(z) {
  try { if (z) new Intl.DateTimeFormat("en-US", { timeZone: z }); TZ = z || ""; } catch { TZ = ""; }
}
export const journalTz = () => TZ || deviceTz();
const fmtCache = new Map();
// Смещение пояса от UTC в минутах на момент ms (Бухарест летом = +180)
export function tzOffsetMin(ms, tz = journalTz()) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}
// Момент времени -> «настенное» время пояса журнала (serial таблицы, без секунд)
export const msToSerial = (ms, tz = journalTz()) => (Math.floor(ms / 60000) * 60000 + tzOffsetMin(ms, tz) * 60000) / DAY_MS + EPOCH_SHIFT;
// «Настенное» время пояса журнала -> момент времени
export function serialToMs(s, tz = journalTz()) {
  const w = Math.round((s - EPOCH_SHIFT) * DAY_MS);
  let ms = w - tzOffsetMin(w, tz) * 60000;
  ms = w - tzOffsetMin(ms, tz) * 60000; // уточнение у перехода на летнее/зимнее время
  return ms;
}
export const nowSerial = () => msToSerial(Date.now());
export const tzLabel = (tz = journalTz(), ms = Date.now()) => {
  const o = tzOffsetMin(ms, tz);
  return "UTC" + (o >= 0 ? "+" : "−") + Math.floor(Math.abs(o) / 60) + (Math.abs(o) % 60 ? ":" + String(Math.abs(o) % 60).padStart(2, "0") : "");
};
