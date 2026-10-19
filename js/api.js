// Работа с Google Sheets и Google Drive через REST API.
import { CONFIG } from "../config.js";
import { token, forget } from "./auth.js";
import { lsGet, lsSet, lsDel, parseDT } from "./util.js";
import { headersFor } from "./form.js";

export class AuthError extends Error {
  constructor() { super("Нужно войти заново"); }
}

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
// Таблица пользователя: определяется при входе (resolveSpreadsheet), у каждого своя.
let ID = null;
export const spreadsheetId = () => ID;
const q = (name) => `'${name.replace(/'/g, "''")}'`;
const colLetter = (k) => String.fromCharCode(65 + k);

// Два журнала: реальные сделки и бэктест. Колонки A..T как в Journal, U — Screens (другие таймфреймы),
// у бэктеста ещё V — Idea.
export const BOOKS = {
  live: { title: CONFIG.journalSheet, ncols: 23 }, // V не используется (Idea только в бэктесте), W — Checklist
  bt: { title: CONFIG.backtestSheet, ncols: 23 },
};

async function call(url, opts = {}) {
  const t = token();
  if (!t) throw new AuthError();
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + t } });
  if (res.status === 401) { forget(); throw new AuthError(); }
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).error?.message || ""; } catch { /* не JSON */ }
    const err = new Error(msg || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

const json = async (url, opts) => (await call(url, opts)).json();
const post = (url, body) => json(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const batch = (requests) => post(`${SHEETS}${ID}:batchUpdate`, { requests });

function cellValue(c) {
  const e = c?.effectiveValue;
  if (!e) return "";
  if ("numberValue" in e) return e.numberValue;
  if ("stringValue" in e) return e.stringValue;
  if ("boolValue" in e) return String(e.boolValue);
  return c.formattedValue || "";
}

function cellLinks(c) {
  if (!c) return [];
  const out = new Set();
  if (c.hyperlink) out.add(c.hyperlink);
  for (const r of c.textFormatRuns || []) if (r.format?.link?.uri) out.add(r.format.link.uri);
  for (const m of String(c.formattedValue || "").match(/https?:\/\/\S+/g) || []) out.add(m);
  return [...out];
}

const sheetTitles = async () =>
  (await json(`${SHEETS}${ID}?fields=sheets(properties(sheetId,title))`)).sheets.map((s) => s.properties);

function parseTrades(sheet, ncols) {
  const rowData = sheet?.data?.[0]?.rowData || [];
  const trades = [];
  trades.headers = (rowData[0]?.values || []).map((c) => String(cellValue(c)));
  rowData.forEach((r, i) => {
    if (i === 0) return; // заголовок
    const cells = r.values || [];
    const v = [], links = {};
    for (let k = 0; k < ncols; k++) {
      v.push(cellValue(cells[k]));
      const l = cellLinks(cells[k]);
      if (l.length) links[k] = l;
    }
    if (v.every((x) => x === "")) return;
    trades.push({ n: i + 1, v, links });
  });
  return trades;
}

// Оба журнала + списки POI / Entry / Idea (с листа Lists, а пока его нет — POI и Entry с Dashboard).
export async function loadAll() {
  const props = await sheetTitles();
  const has = (t) => props.some((p) => p.title === t);
  const D = q(CONFIG.dashboardSheet);
  const lastCol = (b) => String.fromCharCode(64 + b.ncols);
  const ranges = [`${q(BOOKS.live.title)}!A1:${lastCol(BOOKS.live)}`];
  if (has(CONFIG.dashboardSheet)) ranges.push(`${D}!H9:H17`, `${D}!H21:H23`);
  if (has(CONFIG.listsSheet)) ranges.push(`${q(CONFIG.listsSheet)}!A1:F`);
  if (has(BOOKS.bt.title)) ranges.push(`${q(BOOKS.bt.title)}!A1:${lastCol(BOOKS.bt)}`);
  if (has(CONFIG.checklistsSheet)) ranges.push(`${q(CONFIG.checklistsSheet)}!A1:I`);
  if (has(CONFIG.strategySheet)) ranges.push(`${q(CONFIG.strategySheet)}!A2:A200`);

  const p = new URLSearchParams();
  for (const r of ranges) p.append("ranges", r);
  p.set("includeGridData", "true");
  p.set("fields", "sheets(properties(sheetId,title),data(startRow,rowData(values(" +
    "effectiveValue,formattedValue,hyperlink,textFormatRuns(format(link))))))");
  const res = await json(SHEETS + ID + "?" + p);
  const sheet = (t) => res.sheets.find((s) => s.properties.title === t);

  const js = sheet(BOOKS.live.title);
  if (!js) throw new Error(`Нет листа ${BOOKS.live.title}`);
  const bs = sheet(BOOKS.bt.title);

  const lists = { poi: [], entry: [], idea: [], pair: [], tf: [], checklist: "" };
  for (const d of sheet(CONFIG.dashboardSheet)?.data || []) {
    const vals = (d.rowData || []).map((r) => String(cellValue(r.values?.[0])).trim()).filter(Boolean);
    if (d.startRow === 8) lists.poi = vals;
    if (d.startRow === 20) lists.entry = vals;
  }
  const ls = sheet(CONFIG.listsSheet);
  if (ls) {
    const rows = (ls.data?.[0]?.rowData || []).slice(1);
    const col = (k) => [...new Set(rows.map((r) => String(cellValue(r.values?.[k])).trim()).filter(Boolean))];
    // пустая колонка на листе Lists — оставить списки с Dashboard
    if (col(0).length) lists.poi = col(0);
    if (col(1).length) lists.entry = col(1);
    lists.idea = col(2);
    lists.pair = col(3);
    lists.tf = col(4);
    lists.checklist = String(cellValue(rows[0]?.values?.[5]) || ""); // F2 — чек-лист (JSON)
  }
  const cs = sheet(CONFIG.checklistsSheet);
  const runs = { sheetId: cs?.properties.sheetId ?? null, list: [] };
  (cs?.data?.[0]?.rowData || []).forEach((r, i) => {
    if (i === 0) return;
    const v = (r.values || []).map(cellValue);
    if (typeof v[0] !== "number") return;
    const ids = (s) => String(s ?? "").split(/\s+/).filter(Boolean);
    runs.list.push({ n: i + 1, at: v[0], pair: String(v[1] ?? ""), setup: String(v[2] ?? ""), setupName: String(v[3] ?? ""),
      verdict: String(v[4] ?? ""), yes: ids(v[5]), no: ids(v[6]), note: String(v[8] ?? "") });
  });
  // стратегия: текст лежит кусками в A2, A3, … (одна ячейка — до 50 000 символов)
  const ss = sheet(CONFIG.strategySheet);
  const strategy = ss ? (ss.data?.[0]?.rowData || []).map((r) => String(cellValue(r.values?.[0]) ?? "")).join("") : null;
  return {
    strategy, // null — листа ещё нет (стратегию не заполняли)
    runs,
    live: { sheetId: js.properties.sheetId, trades: parseTrades(js, BOOKS.live.ncols) },
    bt: bs ? { sheetId: bs.properties.sheetId, trades: parseTrades(bs, BOOKS.bt.ncols) } : null,
    lists,
  };
}

// Сохранить списки на лист Lists и обновить выпадающий список Entry в колонке G обоих журналов.
export async function saveLists(lists, sheetIds) {
  const L = q(CONFIG.listsSheet);
  if (!(await sheetTitles()).some((s) => s.title === CONFIG.listsSheet)) {
    await batch([{ addSheet: { properties: { title: CONFIG.listsSheet } } }]);
  }
  await post(`${SHEETS}${ID}/values/${encodeURIComponent(`${L}!A:E`)}:clear`, {});
  const cols = [lists.poi, lists.entry, lists.idea, lists.pair, lists.tf];
  const n = Math.max(...cols.map((c) => c.length));
  const values = [["POI", "Entry", "Idea", "Pair", "Timeframes"],
    ...Array.from({ length: n }, (_, i) => cols.map((c) => c[i] ?? ""))];
  await post(`${SHEETS}${ID}/values:batchUpdate`, { valueInputOption: "RAW", data: [{ range: `${L}!A1`, values }] });
  const entry = lists.entry;
  await batch(sheetIds.filter((x) => x != null).map((sheetId) => {
    const range = { sheetId, startRowIndex: 1, startColumnIndex: 6, endColumnIndex: 7 };
    return {
      setDataValidation: entry.length ? {
        range,
        rule: { condition: { type: "ONE_OF_LIST", values: entry.map((v) => ({ userEnteredValue: v })) }, strict: true, showCustomUi: true },
      } : { range }, // пустой список — без проверки
    };
  }));
}

// Чек-лист целиком — JSON в ячейке Lists!F2 (F1 — подпись).
export async function saveChecklist(json) {
  if (!(await sheetTitles()).some((s) => s.title === CONFIG.listsSheet)) {
    await batch([{ addSheet: { properties: { title: CONFIG.listsSheet } } }]);
  }
  await post(`${SHEETS}${ID}/values:batchUpdate`, {
    valueInputOption: "RAW",
    data: [{ range: `${q(CONFIG.listsSheet)}!F1:F2`, values: [["Checklist (правится в приложении)"], [json]] }],
  });
}

// ---------- пройденные чек-листы (лист Checklists, строка на каждый) ----------

const RUN_HEADERS = ["Date-Time", "Pair", "Setup", "Setup name", "Verdict", "Yes", "No", "Не выполнено", "Note"];

async function ensureRunsSheet() {
  const found = (await sheetTitles()).find((s) => s.title === CONFIG.checklistsSheet);
  if (found) return found.sheetId;
  const r = await batch([{ addSheet: { properties: { title: CONFIG.checklistsSheet, gridProperties: { frozenRowCount: 1 } } } }]);
  const sheetId = r.replies[0].addSheet.properties.sheetId;
  await batch([{
    repeatCell: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
      cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "dd.mm.yyyy h:mm" } } }, fields: "userEnteredFormat.numberFormat",
    },
  }]);
  await post(`${SHEETS}${ID}/values:batchUpdate`, {
    valueInputOption: "RAW", data: [{ range: `${q(CONFIG.checklistsSheet)}!A1`, values: [RUN_HEADERS] }],
  });
  return sheetId;
}

export async function appendRun(row) {
  await ensureRunsSheet();
  await post(`${SHEETS}${ID}/values/${encodeURIComponent(`${q(CONFIG.checklistsSheet)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: [row] });
}

// Удалить строку n, если в ней тот же чек-лист (то же время).
export async function deleteRun(sheetId, n, at) {
  const r = await json(`${SHEETS}${ID}/values/${encodeURIComponent(`${q(CONFIG.checklistsSheet)}!A${n}`)}?valueRenderOption=UNFORMATTED_VALUE`);
  const v = r.values?.[0]?.[0];
  if (typeof v !== "number" || Math.abs(v - at) > 1e-6) return false;
  await deleteRow(sheetId, n);
  return true;
}

// ---------- торговая стратегия (лист Strategy: A1 — подпись, A2… — текст кусками по 40 000 символов) ----------

export async function saveStrategy(md) {
  const S = q(CONFIG.strategySheet);
  if (!(await sheetTitles()).some((s) => s.title === CONFIG.strategySheet)) {
    await batch([{ addSheet: { properties: { title: CONFIG.strategySheet } } }]);
  }
  const parts = [];
  for (let i = 0; i < md.length; i += 40000) parts.push([md.slice(i, i + 40000)]);
  await post(`${SHEETS}${ID}/values/${encodeURIComponent(`${S}!A:A`)}:clear`, {});
  await post(`${SHEETS}${ID}/values:batchUpdate`, {
    valueInputOption: "RAW",
    data: [{ range: `${S}!A1`, values: [["Strategy (Markdown, правится в приложении Trader'sBook)"], ...(parts.length ? parts : [[""]])] }],
  });
}

// Лист Backtest: создаётся при первой сделке бэктеста, оформлен как Journal.
export async function ensureBacktest() {
  const found = (await sheetTitles()).find((s) => s.title === BOOKS.bt.title);
  if (found) return found.sheetId;
  const r = await batch([{ addSheet: { properties: { title: BOOKS.bt.title, gridProperties: { frozenRowCount: 1 } } } }]);
  const sheetId = r.replies[0].addSheet.properties.sheetId;
  const fmt = (c0, c1, numberFormat) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: { numberFormat } }, fields: "userEnteredFormat.numberFormat",
    },
  });
  await batch([
    fmt(0, 2, { type: "DATE_TIME", pattern: "dd.mm.yyyy h:mm" }),
    fmt(8, 11, { type: "NUMBER", pattern: "0.00" }),
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold",
      },
    },
  ]);
  await post(`${SHEETS}${ID}/values:batchUpdate`, {
    valueInputOption: "RAW", data: [{ range: `${q(BOOKS.bt.title)}!A1`, values: [headersFor(BOOKS.bt.ncols)] }],
  });
  return sheetId;
}

// Проверка перед записью: в строке n всё ещё та же сделка (время входа и пара)?
export async function verifyRow(book, n, open, pair) {
  const r = await json(`${SHEETS}${ID}/values/${encodeURIComponent(`${q(book.title)}!A${n}:D${n}`)}?valueRenderOption=UNFORMATTED_VALUE`);
  const v = r.values?.[0] || [];
  const a = parseDT(v[0]), b = parseDT(open);
  const sameOpen = Number.isNaN(a) || Number.isNaN(b) ? String(v[0] ?? "") === String(open ?? "") : Math.abs(a - b) < 1e-4;
  return sameOpen && String(v[3] ?? "") === String(pair ?? "");
}

// changes: [[колонка, значение], ...] — пишутся только изменённые ячейки,
// чтобы не стереть оформление и ссылки в остальных.
export async function writeCells(book, n, changes) {
  await post(`${SHEETS}${ID}/values:batchUpdate`, {
    valueInputOption: "RAW",
    data: changes.map(([k, val]) => ({ range: `${q(book.title)}!${colLetter(k)}${n}`, values: [[val]] })),
  });
}

// Сортировка строк целиком (все колонки листа, как в sync.py), старые сверху.
export async function sortSheet(book, sheetId, lastRow) {
  await batch([{
    sortRange: {
      range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 0 },
      sortSpecs: [{ dimensionIndex: 0, sortOrder: "ASCENDING" }],
    },
  }]);
}

// Новая сделка: дописать в конец и отсортировать по времени входа (как sync.py).
export async function appendRow(book, values, sheetId, lastKnownRow) {
  const r = await post(`${SHEETS}${ID}/values/${encodeURIComponent(`${q(book.title)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: [values.slice(0, book.ncols)] });
  const m = (r.updates?.updatedRange || "").match(/![A-Z]+(\d+)/);
  const row = m ? +m[1] : lastKnownRow + 1;
  await sortSheet(book, sheetId, Math.max(row, lastKnownRow));
}

export async function deleteRow(sheetId, n) {
  await batch([{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: n - 1, endIndex: n } } }]);
}

// ---------- своя таблица у каждого пользователя ----------

const APP_PROP = "tradersbook"; // метка таблицы приложения в Drive (appProperties)
async function canOpen(id) {
  try { await json(`${SHEETS}${id}?fields=spreadsheetId`); return true; } catch (e) {
    if (e instanceof AuthError) throw e;
    if ([403, 404].includes(e.status)) return false;
    throw e;
  }
}

// Кто вошёл: адрес Google-аккаунта из Drive (about), в коде сравнивается только его SHA-256.
async function accountHash() {
  const r = await json(`${DRIVE.replace(/\/files$/, "")}/about?fields=user(emailAddress)`);
  const email = String(r.user?.emailAddress || "").trim().toLowerCase();
  if (!email) throw new Error("Не удалось определить аккаунт Google");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Таблица пользователя. Таблица владельца из config.js открывается ТОЛЬКО его аккаунтам (ownerEmailSha256),
// даже если у других случайно есть к ней доступ по ссылке. Порядок: таблица этого аккаунта, запомненная
// на устройстве → (только владельцу) таблица из config → таблица приложения в Drive → иначе новая.
export async function resolveSpreadsheet(lang = "ru") {
  lsDel("tj.sheet"); // старый общий ключ (до разделения по аккаунтам)
  const who = await accountHash();
  const key = "tj.sheet." + who.slice(0, 16);
  const isOwner = (CONFIG.ownerEmailSha256 || []).includes(who);
  const use = (id, created = false) => { ID = id; lsSet(key, id); return { id, created, owner: isOwner }; };
  const cached = lsGet(key);
  if (cached && (cached !== CONFIG.spreadsheetId || isOwner) && await canOpen(cached)) return use(cached);
  if (isOwner && CONFIG.spreadsheetId && await canOpen(CONFIG.spreadsheetId)) return use(CONFIG.spreadsheetId);
  const found = await json(`${DRIVE}?` + new URLSearchParams({
    q: `appProperties has { key='${APP_PROP}' and value='1' } and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: "files(id,createdTime)", orderBy: "createdTime", spaces: "drive",
  }));
  const own = found.files?.[0]?.id;
  if (own && own !== CONFIG.spreadsheetId && await canOpen(own)) return use(own);
  return use(await createSpreadsheet(lang), true);
}

// Стартовые варианты для нового пользователя — общие, без чьей-то стратегии; всё правится в «Изменить список».
const STARTER = {
  poi: ["FVG", "Order Block", "Breaker Block", "Liquidity Sweep", "Support / Resistance", "Supply / Demand"],
  entry: ["Market", "Limit", "Confirmation", "Break & Retest"],
  pair: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "XAUUSD", "US30", "NAS100", "GER40", "BTCUSD"],
  tf: ["W1", "D1", "H4", "H1", "m15", "m5", "m1"],
};
function starterLists() {
  const n = Math.max(...Object.values(STARTER).map((x) => x.length));
  const cell = (v) => ({ userEnteredValue: { stringValue: v ?? "" } });
  return Array.from({ length: n }, (_, i) => ({
    values: [cell(STARTER.poi[i]), cell(STARTER.entry[i]), cell(""), cell(STARTER.pair[i]), cell(STARTER.tf[i])],
  }));
}

// Новая пустая таблица: Journal (заголовки, форматы) и Lists. Остальные листы приложение создаёт само, когда нужно.
async function createSpreadsheet(lang) {
  const head = (vals) => ({ values: vals.map((v) => ({ userEnteredValue: { stringValue: v }, userEnteredFormat: { textFormat: { bold: true } } })) });
  const r = await post(SHEETS.replace(/\/$/, ""), {
    properties: { title: "Trader'sBook", locale: lang === "en" ? "en_US" : "ru_RU" },
    sheets: [
      { properties: { title: CONFIG.journalSheet, gridProperties: { frozenRowCount: 1, columnCount: 26, rowCount: 1000 } },
        data: [{ startRow: 0, startColumn: 0, rowData: [head(headersFor(BOOKS.live.ncols))] }] },
      { properties: { title: CONFIG.listsSheet, gridProperties: { frozenRowCount: 1 } },
        data: [{ startRow: 0, startColumn: 0, rowData: [head(["POI", "Entry", "Idea", "Pair", "Timeframes"]), ...starterLists()] }] },
    ],
  });
  const id = r.spreadsheetId;
  const journal = r.sheets[0].properties.sheetId;
  const fmt = (c0, c1, numberFormat) => ({
    repeatCell: {
      range: { sheetId: journal, startRowIndex: 1, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: { numberFormat } }, fields: "userEnteredFormat.numberFormat",
    },
  });
  await post(`${SHEETS}${id}:batchUpdate`, { requests: [
    fmt(0, 2, { type: "DATE_TIME", pattern: "dd.mm.yyyy h:mm" }),
    fmt(8, 11, { type: "NUMBER", pattern: "0.00" }),
  ] });
  // пометить как таблицу приложения и положить в папку приложения в Drive
  try {
    const parent = await folderId();
    await json(`${DRIVE}/${id}?addParents=${parent}&fields=id`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appProperties: { [APP_PROP]: "1" } }),
    });
  } catch (e) {
    if (e instanceof AuthError) throw e; // без метки таблица всё равно работает: id запомнен в tj.sheet
  }
  return id;
}

// ---------- Google Drive ----------

async function folderId() {
  const cached = lsGet("tj.folder");
  if (cached) return cached;
  const name = CONFIG.driveFolder.replace(/'/g, "\\'");
  const found = await json(`${DRIVE}?` + new URLSearchParams({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)", spaces: "drive",
  }));
  let id = found.files?.[0]?.id;
  if (!id) {
    id = (await post(`${DRIVE}?fields=id`, { name: CONFIG.driveFolder, mimeType: "application/vnd.google-apps.folder" })).id;
  }
  lsSet("tj.folder", id);
  return id;
}

export async function uploadImage(file, name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const parent = await folderId();
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ name, parents: [parent] })], { type: "application/json" }));
    form.append("file", file);
    try {
      const r = await json(`${UPLOAD}?uploadType=multipart&fields=id`, { method: "POST", body: form });
      return `https://drive.google.com/file/d/${r.id}/view`;
    } catch (e) {
      if (e instanceof AuthError || attempt === 1) throw e;
      lsDel("tj.folder"); // папку могли удалить — создадим заново
    }
  }
}

const blobCache = new Map();
export function driveBlobUrl(id) {
  if (!blobCache.has(id)) {
    const p = call(`${DRIVE}/${id}?alt=media`).then((r) => r.blob()).then((b) => URL.createObjectURL(b));
    p.catch(() => blobCache.delete(id));
    blobCache.set(id, p);
  }
  return blobCache.get(id);
}

// Картинки стратегии, подготовленные заранее в скрытом листе StrategyImages
// (A — имя файла, B — тип, C… — base64 кусками). Приложение переносит их в Drive и удаляет лист.
const PENDING = "StrategyImages";
export async function pendingImages() {
  if (!(await sheetTitles()).some((s) => s.title === PENDING)) return [];
  const r = await json(`${SHEETS}${ID}/values/${encodeURIComponent(`${q(PENDING)}!A1:Z200`)}`);
  return (r.values || []).filter((v) => v[0] && v[2]).map(([name, type, ...parts]) => {
    const bin = atob(parts.join(""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: type || "image/png" });
  });
}
export async function dropPendingImages() {
  const s = (await sheetTitles()).find((x) => x.title === PENDING);
  if (s) await batch([{ deleteSheet: { sheetId: s.sheetId } }]);
}
