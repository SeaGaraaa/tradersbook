// Карточка сделки: строка таблицы <-> форма, и какие ячейки изменились.
import { num, isNum, parseDT, toInput, fromInput, sameMinute, sessionOf, EPOCH_SHIFT } from "./util.js";
import { parseCheck, formatCheck, sameCheck, emptyCheck } from "./checklist.js";
import { LANG } from "./i18n.js";

export const BASE_HEADERS = ["Date-Time Open", "Date-Time Close", "Direction", "Pair", "Session", "POI", "Entry", "Result",
  "RR", "Risk", "Profit", "W1", "D1", "H4", "H1", "m15", "m5", "m3", "Exit", "Notes"];
export const SCREENS = 20; // колонка U: скриншоты других таймфреймов, строки «TF: ссылка»
export const IDEA = 21; // колонка V (только Backtest): идея
export const CHECK = 22; // колонка W: чек-лист «setup:LR; yes:…; no:…»
export const MAXCOLS = 23;
export const TF = ["W1", "D1", "H4", "H1", "m15", "m5", "m3"]; // свои колонки L..R
export const LINK0 = 11; // колонка L
export const NUM_COLS = [8, 9, 10]; // RR, Risk, Profit

export const headersFor = (ncols) => [...BASE_HEADERS, "Screens", "Idea", "Checklist"].slice(0, ncols);

const res = (t) => String(t.v[7] ?? "").trim();
const normPoi = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean).join(", ");
const URL_RE = /https?:\/\/\S+/g;

export function linksOf(t, k) {
  if (t.links[k]?.length) return [...t.links[k]];
  const v = String(t.v[k] ?? "").trim();
  return v ? [v] : [];
}

// «H2: url url\nD3: url» -> { H2: [...], D3: [...] }
export function parseScreens(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*([^:\s][^:]*?)\s*:\s*(https?:\/\/.*)$/);
    const tf = m ? m[1] : "Другое";
    const urls = (m ? m[2] : line).match(URL_RE) || [line.trim()];
    (out[tf] ||= []).push(...urls);
  }
  return out;
}

// { tf: [urls] } -> текст ячейки (порядок — как в списке таймфреймов)
export function formatScreens(shots, order = []) {
  const names = Object.keys(shots).filter((k) => !TF.includes(k) && shots[k]?.length);
  names.sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
  return names.map((k) => `${k}: ${shots[k].join(" ")}`).join("\n");
}

export function emptyForm(now = new Date(), idea = "") {
  // текущее время устройства как «настенное» время
  const s = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()) / 86400000 + EPOCH_SHIFT;
  return {
    open: toInput(s), close: "", dir: "", pair: "", session: sessionOf(s), sessionAuto: true,
    poi: [], entry: "", result: "", rr: "", risk: "", profit: "",
    shots: Object.fromEntries(TF.map((tf) => [tf, []])), exit: "", notes: "", idea, check: emptyCheck(),
  };
}

export function toForm(t, idea = "") {
  if (!t) return emptyForm(new Date(), idea);
  const n = (v) => (isNum(v) ? (LANG === "en" ? String(num(v)) : String(num(v)).replace(".", ",")) : String(v ?? ""));
  const shots = Object.fromEntries(TF.map((tf, i) => [tf, linksOf(t, LINK0 + i)]));
  for (const [tf, urls] of Object.entries(parseScreens(t.v[SCREENS]))) {
    const key = TF.find((x) => x.toLowerCase() === tf.toLowerCase()) ? `${tf} ` : tf; // не путать с колонками L..R
    (shots[key] ||= []).push(...urls);
  }
  return {
    open: toInput(t.v[0]), close: toInput(t.v[1]), dir: String(t.v[2] ?? ""), pair: String(t.v[3] ?? ""),
    // сессия «авто», если пустая или совпадает с той, что выходит по времени входа — тогда при смене времени она пересчитается
    session: String(t.v[4] ?? ""), sessionAuto: !t.v[4] || (isNum(parseDT(t.v[0])) && sessionOf(parseDT(t.v[0])) === String(t.v[4]).trim()),
    poi: normPoi(t.v[5]).split(", ").filter(Boolean),
    entry: String(t.v[6] ?? ""), result: res(t), rr: n(t.v[8]), risk: n(t.v[9]), profit: n(t.v[10]),
    shots, exit: String(t.v[18] ?? ""), notes: String(t.v[19] ?? ""), idea: String(t.v[IDEA] ?? "").trim(),
    check: parseCheck(t.v[CHECK]),
  };
}

export function formValues(f, tfOrder = []) {
  const nn = (s) => { const x = num(s); return String(s).trim() === "" || Number.isNaN(x) ? String(s).trim() : x; };
  const v = new Array(MAXCOLS).fill("");
  v[0] = fromInput(f.open); v[1] = fromInput(f.close);
  v[2] = f.dir; v[3] = f.pair; v[4] = f.session; v[5] = f.poi.join(", "); v[6] = f.entry; v[7] = f.result;
  v[8] = nn(f.rr); v[9] = nn(f.risk); v[10] = nn(f.profit);
  TF.forEach((tf, i) => (v[LINK0 + i] = (f.shots[tf] || []).join("\n")));
  v[18] = f.exit.trim(); v[19] = f.notes;
  v[SCREENS] = formatScreens(Object.fromEntries(Object.entries(f.shots).map(([k, u]) => [k.trim(), u])), tfOrder);
  v[IDEA] = (f.idea || "").trim();
  v[CHECK] = formatCheck(f.check);
  return v;
}

// Список [колонка, новое значение] только для реально изменённых ячеек (колонки 0..ncols-1).
export function diff(t, v, ncols = SCREENS + 1) {
  const out = [];
  for (let k = 0; k < ncols; k++) {
    const nv = v[k], ov = t.v[k];
    let same;
    if (k <= 1) {
      const a = parseDT(ov);
      // дату, вписанную непонятным текстом, форма показать не может — не трогаем её
      same = nv === "" ? (String(ov ?? "") === "" || Number.isNaN(a)) : !Number.isNaN(a) && sameMinute(a, nv);
    } else if (NUM_COLS.includes(k)) {
      same = typeof nv === "number" && isNum(ov) ? Math.abs(num(ov) - nv) < 1e-9 : String(ov ?? "").trim() === String(nv);
    } else if (k === 5) {
      same = normPoi(ov) === nv;
    } else if (k >= LINK0 && k < LINK0 + TF.length) {
      same = linksOf(t, k).join("\n") === nv;
    } else if (k === SCREENS) {
      // сравниваем по смыслу (порядок строк мог быть другим)
      const norm = (s) => JSON.stringify(Object.entries(parseScreens(s)).sort());
      same = norm(ov) === norm(nv);
    } else if (k === CHECK) {
      same = sameCheck(ov, nv);
    } else if (k === 19) {
      same = String(ov ?? "").replace(/\r\n/g, "\n") === nv.replace(/\r\n/g, "\n");
    } else {
      same = String(ov ?? "").trim() === String(nv).trim();
    }
    if (!same) out.push([k, nv]);
  }
  return out;
}
