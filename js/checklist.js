// Чек-лист перед входом. По умолчанию — стартовый общий (GENERIC), дальше пользователь правит его под свою стратегию;
// рабочая версия лежит в его таблице (Lists!F2).
// id пунктов не менять: по ним в сделках хранятся ответы.

// Стартовый чек-лист нового пользователя — общие правила без чьей-то стратегии.
// Свой чек-лист пользователь собирает сам («Изменить чек-лист»), он сохраняется в его таблице (Lists!F2).
const GENERIC = {
  ru: {
    note: "",
    limit: 1,
    general: [
      { title: "Дисциплина", items: [
        ["c1", "Дневной лимит убытка не достигнут."],
        ["c2", "Лимит сделок на день не превышен."],
        ["c3", "Я спокоен и не отыгрываюсь после убытка."],
      ] },
      { title: "Риск", items: [
        ["c4", "Риск на сделку не больше, чем в моей стратегии."],
        ["c5", "Лот посчитан по расстоянию до стоп-лосса."],
        ["c6", "Стоп-лосс и тейк-профит определены до входа."],
      ] },
      { title: "Анализ", items: [
        ["c7", "Контекст старшего таймфрейма определён."],
        ["c8", "Вход соответствует сетапу из моей стратегии."],
        ["c9", "Соотношение риск/прибыль не хуже минимального по стратегии."],
        ["c10", "Важные новости проверены."],
      ] },
    ],
    setups: [],
    after: [],
    archive: {},
  },
  en: {
    note: "",
    limit: 1,
    general: [
      { title: "Discipline", items: [
        ["c1", "Daily loss limit not reached."],
        ["c2", "Daily trade limit not exceeded."],
        ["c3", "I'm calm and not revenge trading after a loss."],
      ] },
      { title: "Risk", items: [
        ["c4", "Risk per trade is not above my strategy's limit."],
        ["c5", "Lot size calculated from the distance to the stop-loss."],
        ["c6", "Stop-loss and take-profit set before entry."],
      ] },
      { title: "Analysis", items: [
        ["c7", "Higher-timeframe context is defined."],
        ["c8", "The entry matches a setup from my strategy."],
        ["c9", "Risk/reward is not worse than my strategy's minimum."],
        ["c10", "Important news checked."],
      ] },
    ],
    setups: [],
    after: [],
    archive: {},
  },
};

// ---------- текущий чек-лист (пользователь меняет его в приложении; хранится в Lists!F2 как JSON) ----------

export const DEFAULT = GENERIC.ru;
const clone = (x) => JSON.parse(JSON.stringify(x));
const langNow = () => { try { return localStorage.getItem("tj.lang") === "en" ? "en" : "ru"; } catch { return "ru"; } };
// Шаблон по умолчанию на языке интерфейса (пока пользователь не сохранил свой).
export const defaultFor = (lang = langNow()) => clone(GENERIC[lang] || GENERIC.ru);
let CUR = defaultFor();
let RAW = ""; // сохранённый шаблон из таблицы (пусто — свой ещё не сохраняли)
export const hasSaved = () => !!RAW;

const isItems = (a) => Array.isArray(a) && a.every((x) => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string");
function valid(d) {
  return d && typeof d === "object"
    && Array.isArray(d.general) && d.general.every((g) => typeof g.title === "string" && isItems(g.items))
    && Array.isArray(d.setups) && d.setups.every((s) => typeof s.id === "string" && typeof s.name === "string" && isItems(s.items))
    && isItems(d.after);
}

export const current = () => CUR;
export const draft = () => clone(CUR);

// Из ячейки таблицы; пусто или испорчено — чек-лист по умолчанию (как в checklist.md).
export function load(json = RAW) {
  RAW = json || "";
  try {
    const d = json ? JSON.parse(json) : null;
    CUR = valid(d) ? { note: "", archive: {}, ...d } : defaultFor();
  } catch {
    CUR = defaultFor();
  }
  return CUR;
}

// Перед сохранением: пустые пункты убрать, тексты удалённых пунктов запомнить для статистики.
export function finalize(d) {
  const clean = (items) => items.map(([id, t]) => [id, t.trim()]).filter(([, t]) => t);
  const out = {
    note: (d.note || "").trim(),
    limit: Math.max(1, parseInt(d.limit, 10) || DEFAULT_LIMIT),
    general: d.general.map((g) => ({ title: g.title.trim() || "Без названия", items: clean(g.items) })),
    setups: d.setups.map((s) => ({ ...s, name: s.name.trim() || "Без названия", entry: (s.entry || "").trim(), no: (s.no || "").trim(), items: clean(s.items) })),
    after: clean(d.after),
    archive: { ...(CUR.archive || {}), ...(d.archive || {}) },
  };
  const now = new Set(allItems(out).map(([id]) => id));
  for (const [id, t] of allItems(CUR)) if (!now.has(id)) out.archive[id] = t;
  for (const id of now) delete out.archive[id];
  return out;
}

export const newId = (p = "i") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const allItems = (d) => [...d.general.flatMap((g) => g.items), ...d.setups.flatMap((s) => s.items), ...d.after];

export const itemText = (id) => Object.fromEntries(allItems(CUR))[id] || CUR.archive?.[id] || id;
export const setupById = (id) => CUR.setups.find((s) => s.id === id);

export const emptyCheck = () => ({ setup: "", yes: [], no: [] });

// Ячейка: «setup:LR; yes:g1 g2 lr1; no:g4»
export function parseCheck(text) {
  const c = emptyCheck();
  for (const part of String(text ?? "").split(";")) {
    const m = part.match(/^\s*(setup|yes|no)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === "setup") c.setup = m[2].trim();
    else c[k] = m[2].split(/[\s,]+/).filter(Boolean);
  }
  return c;
}

export function formatCheck(c) {
  if (!c || (!c.setup && !c.yes.length && !c.no.length)) return "";
  const order = allItems(CUR).map(([id]) => id);
  const sort = (a) => [...new Set(a)].sort((x, y) => (order.indexOf(x) + 1 || 1e9) - (order.indexOf(y) + 1 || 1e9));
  return [c.setup && `setup:${c.setup}`, c.yes.length && `yes:${sort(c.yes).join(" ")}`, c.no.length && `no:${sort(c.no).join(" ")}`]
    .filter(Boolean).join("; ");
}

export const sameCheck = (a, b) => formatCheck(parseCheck(a)) === formatCheck(parseCheck(b));

// Обязательные пункты: общий блок + блок выбранного сетапа.
export function required(c) {
  return [...CUR.general.flatMap((g) => g.items.map(([id]) => id)), ...(setupById(c.setup)?.items.map(([id]) => id) || [])];
}

// Сколько «нет» запрещают сделку (меняется в шаблоне; в стартовом — одно).
export const DEFAULT_LIMIT = 3;
export const limit = () => Math.max(1, parseInt(CUR.limit, 10) || DEFAULT_LIMIT);

// none — пусто; broken — «нет» не меньше порога (сделки нет); partial — отмечено не всё;
// warn — всё отмечено, «нет» меньше порога (можно, но с нарушениями); ok — всё «да».
// Сетап не обязателен: без него обязателен только общий блок, с ним — ещё пункты сетапа.
export function status(c) {
  if (c.no.length >= limit()) return "broken";
  if (!c.setup && !c.yes.length && !c.no.length) return "none";
  const req = required(c);
  if (!req.every((id) => c.yes.includes(id) || c.no.includes(id))) return "partial";
  return c.no.length ? "warn" : "ok";
}
