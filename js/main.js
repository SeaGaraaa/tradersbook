import { CONFIG } from "../config.js";
import * as auth from "./auth.js";
import * as api from "./api.js";
import { compute, period, COL } from "./stats.js";
import { TF, NUM_COLS, IDEA, SCREENS, CHECK, toForm, formValues, diff } from "./form.js";
import * as CL from "./checklist.js";
import { exportPNG, exportPDF } from "./export.js";
import * as St from "./strategy.js";
import * as SB from "./stbuilder.js";
import * as Conn from "./connect.js";
import * as News from "./news.js";
import * as Lot from "./lot.js";
import { t as tr, setLang, applyStatic, LANG } from "./i18n.js";
import {
  num, isNum, parseDT, fmtDT, fmtDay, fmtMonth, monthKey, fromInput, sameMinute, sessionOf,
  fmtNum, fmtSigned, fmtPct, fmtDuration, esc, tvImage, driveId, directImage, lsGet, lsSet, lsDel,
} from "./util.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const DEF = {
  session: ["Asia", "Frankfurt", "London", "NY"],
  result: ["Win", "Lose", "BE"],
};
const MIN_SAMPLE = 30; // меньше сделок — вывод по идее делать рано
const LIST_LABEL = { poi: "POI", entry: "Entry", idea: "Idea", pair: "Pair", tf: "таймфреймов" }; // подписи в confirm — переводятся через t()
const emptyFilter = () => ({ pair: "", result: "", month: "", q: "" });

const S = {
  mode: lsGet("tj.mode") === "bt" ? "bt" : "live", // live — реальный счёт, bt — бэктест
  books: { live: { trades: [], sheetId: null }, bt: null },
  lists: { poi: [], entry: [], idea: [], pair: [], session: [] },
  view: ["journal", "dashboard", "stats", "checklist", "strategy", "news", "lot"].includes(lsGet("tj.view")) ? lsGet("tj.view") : "journal",
  run: null, // текущий (несохранённый) чек-лист на вкладке «Чек-лист»
  runs: [], runsSheetId: null, // сохранённые чек-листы (лист Checklists)
  clDraft: null, // правка шаблона чек-листа
  strategy: null, strategyData: "", stB: null, stBOrig: "", stEdit: null, stPreview: false, // торговая стратегия (лист Strategy); stEdit — текст в правке
  f: { live: emptyFilter(), bt: emptyFilter() },
  btIdea: lsGet("tj.btIdea") || "", // идея, выбранная на Dashboard бэктеста
  ed: null, // открытая карточка: { mode, n, key, form, uploading, manage }
};

const isBT = () => S.mode === "bt";
const book = (mode = S.mode) => S.books[mode] || { trades: [], sheetId: null };
const trades = (mode = S.mode) => book(mode).trades;
const F = () => S.f[S.mode];

// ---------------- общие ----------------

let toastTimer;
function toast(msg, bad = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), bad ? 6000 : 2500);
}

let busy = 0;
function setBusy(on) {
  busy += on ? 1 : -1;
  document.body.classList.toggle("busy", busy > 0);
}

function handleErr(e) {
  console.error(e);
  if (e instanceof api.AuthError) {
    if (S.ed) saveDraft();
    showLogin(tr("Сессия Google истекла. Войди ещё раз — несохранённые изменения восстановятся."));
  } else {
    toast(tr("Ошибка: {e}", { e: e.message || e }), true);
  }
}

const res = (t) => String(t.v[COL.result] ?? "").trim();
const resClass = (r) => ({ Win: "win", Lose: "lose", BE: "be" }[r] || "");
const sgn = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
const ideaOf = (t) => String(t.v[IDEA] ?? "").trim();

// ---------------- экраны входа ----------------

function showSetup() {
  $("#app").hidden = true;
  $("#gate").hidden = false;
  $("#gate").innerHTML = `
    <div class="gate-card">
      <div class="logo"></div>
      <h1>Trader'sBook</h1>
      <p>${tr("Не задан OAuth Client ID. Впиши его в <code>config.js</code> (поле <code>clientId</code>).")}</p>
      <p class="muted">${tr("Redirect URI для настройки в Google Cloud:")} <code>${esc(auth.redirectUri())}</code></p>
    </div>`;
}

function showLogin(note = "") {
  $("#app").hidden = true;
  $("#gate").hidden = false;
  $("#gate").innerHTML = `
    <div class="gate-card">
      <div class="logo"></div>
      <h1>Trader'sBook</h1>
      <p class="muted">${esc(note || tr("Данные хранятся в твоей Google-таблице. Войди, чтобы открыть журнал."))}</p>
      <button class="btn primary big" id="loginBtn">${tr("Войти через Google")}</button>
    </div>`;
  $("#loginBtn").onclick = () => auth.login();
}

function showApp() {
  $("#gate").hidden = true;
  $("#app").hidden = false;
}

// ---------------- данные ----------------

function buildLists(data) {
  const uniq = (a) => [...new Set(a.map((x) => String(x).trim()).filter(Boolean))];
  const all = [...trades("live"), ...trades("bt")];
  const col = (k) => all.map((t) => t.v[k]);
  return {
    poi: uniq(data.lists.poi),
    entry: uniq(data.lists.entry),
    idea: uniq(data.lists.idea),
    // свой список пар (лист Lists, колонка D), пока его нет — стандартные + встречающиеся в сделках
    pair: data.lists.pair.length ? uniq(data.lists.pair) : uniq(col(COL.pair)), // у нового пользователя пусто — пары добавляет сам
    // строки скриншотов в карточке (лист Lists, колонка E), пока списка нет — W1..m3
    tf: data.lists.tf.length ? uniq(data.lists.tf) : [...TF],
    session: uniq([...DEF.session, ...col(COL.session)]),
  };
}

async function reload() {
  setBusy(true);
  try {
    const data = await api.loadAll();
    S.books = { live: data.live, bt: data.bt };
    S.lists = buildLists(data);
    S.runs = data.runs.list;
    S.runsSheetId = data.runs.sheetId;
    S.strategy = data.strategy;
    S.strategyData = data.strategyData || "";
    CL.load(data.lists.checklist);
    if (data.lists.news) News.setFilter(data.lists.news);
    if (data.lists.lot) ltLoad(data.lists.lot);
    render();
    return true;
  } catch (e) {
    handleErr(e);
    return false;
  } finally {
    setBusy(false);
  }
}

// ---------------- навигация ----------------

function modeBar() {
  return `<div class="modebar">
    <div class="seg mode" role="tablist">
      <button type="button" data-mode="live" class="${!isBT() ? "on" : ""}">${tr("Реальный счёт")}</button>
      <button type="button" data-mode="bt" class="${isBT() ? "on" : ""}">${tr("Бэктест")}</button>
    </div>
    ${isBT() && S.view === "stats" && ideaRows().length ? `<select id="ideaTop" class="idea-sel">${ideaRows().map(({ name }) =>
      `<option ${name === activeIdea() ? "selected" : ""}>${esc(name)}</option>`).join("")}</select>` : ""}
  </div>`;
}

const ideasInTrades = () => [...new Set(trades("bt").map(ideaOf).filter(Boolean))];

// Идеи с закрытыми сделками, лучшая (по Expectancy R) сверху.
function ideaRows() {
  return [...new Set([...S.lists.idea, ...ideasInTrades()])]
    .map((name) => ({ name, k: compute(trades("bt").filter((t) => ideaOf(t) === name), S.lists).kpi }))
    .filter((r) => r.k.total > 0)
    .sort((a, b) => b.k.expectancy - a.k.expectancy);
}

// Идея для Dashboard/Stats бэктеста: выбранная, а если её нет — лучшая.
function activeIdea() {
  const rows = ideaRows();
  return rows.some((r) => r.name === S.btIdea) ? S.btIdea : rows[0]?.name || "";
}

function pickIdea(name) {
  S.btIdea = name;
  lsSet("tj.btIdea", name);
  render();
}

function render() {
  document.body.classList.toggle("bt", isBT() && !["checklist", "strategy", "news", "connect", "lot"].includes(S.view));
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === S.view));
  $("#apiBtn")?.classList.toggle("on", S.view === "connect");
  $("#fab").hidden = S.view !== "journal";
  if (S.view === "journal") renderJournal();
  else if (S.view === "dashboard") renderDashboard();
  else if (S.view === "checklist") renderChecklist();
  else if (S.view === "strategy") renderStrategy();
  else if (S.view === "connect") renderConnect();
  else if (S.view === "news") renderNews();
  else if (S.view === "lot") renderLot();
  else renderStats();
  const top = $("#ideaTop");
  if (top) top.oninput = (e) => pickIdea(e.target.value);
  newsBar();
}

function setView(v) {
  S.view = v;
  lsSet("tj.view", v);
  render();
  window.scrollTo(0, 0);
}

function setMode(m) {
  if (S.mode === m) return;
  S.mode = m;
  lsSet("tj.mode", m);
  render();
  window.scrollTo(0, 0);
}

// ---------------- журнал ----------------

function filtered(list = trades()) {
  const { pair, result, month, q } = F();
  const ql = q.trim().toLowerCase();
  return list.filter((t) => {
    if (pair && t.v[COL.pair] !== pair) return false;
    if (result === "_empty" ? res(t) !== "" : result && res(t) !== result) return false;
    if (month) { const s = parseDT(t.v[COL.open]); if (Number.isNaN(s) || monthKey(s) !== month) return false; }
    if (ql && !t.v.some((x) => String(x).toLowerCase().includes(ql))) return false;
    return true;
  });
}

// для Dashboard/Stats бэктеста — только выбранная идея
const scoped = () => (isBT() ? trades().filter((t) => ideaOf(t) === activeIdea()) : trades());

function opt(list, cur, all) {
  return `<option value="">${all}</option>` + list.map((x) =>
    `<option value="${esc(x.v ?? x)}" ${cur === (x.v ?? x) ? "selected" : ""}>${esc(x.t ?? x)}</option>`).join("");
}

function renderJournal() {
  const f = F();
  const months = [...new Set(trades().map((t) => parseDT(t.v[COL.open])).filter((s) => !Number.isNaN(s)).map(monthKey))]
    .sort().reverse().map((k) => ({ v: k, t: fmtMonth(k) }));
  $("#view").innerHTML = modeBar() + `
    <div class="filters">
      <select id="fPair">${opt(S.lists.pair, f.pair, tr("Все пары"))}</select>
      <select id="fRes">${opt([...DEF.result, { v: "_empty", t: tr("Без результата") }], f.result, tr("Любой результат"))}</select>
      <select id="fMonth">${opt(months, f.month, tr("Все месяцы"))}</select>
      <input id="fQ" type="search" placeholder="${tr("Поиск")}" value="${esc(f.q)}">
    </div>
    <div id="summary" class="summary"></div>
    <div id="list"></div>`;
  const bind = (id, k) => { const el = $(id); if (el) el.oninput = (e) => { F()[k] = e.target.value; renderList(); }; };
  bind("#fPair", "pair"); bind("#fRes", "result"); bind("#fMonth", "month"); bind("#fQ", "q");
  renderList();
}

// Номер сделки: по времени входа во всём журнале (1 — самая первая), фильтры его не меняют.
function tradeNumbers(mode = S.mode) {
  return new Map([...trades(mode)]
    .sort((a, b) => (parseDT(a.v[0]) || 0) - (parseDT(b.v[0]) || 0) || a.n - b.n)
    .map((t, i) => [t.n, i + 1]));
}

function renderList() {
  const rows = filtered();
  const done = rows.filter((t) => res(t) !== "");
  const w = done.filter((t) => res(t) === "Win").length, nb = done.filter((t) => res(t) !== "BE").length;
  const p = rows.reduce((s, t) => s + (isNum(t.v[COL.profit]) ? num(t.v[COL.profit]) : 0), 0);
  $("#summary").innerHTML = `<div class="sum-cell"><span class="sum-k">${tr("Сделок")}</span><b>${rows.length}</b></div>
    <div class="sum-cell"><span class="sum-k">WinRate</span><b>${fmtPct(nb ? w / nb : 0)}</b></div>
    <div class="sum-cell"><span class="sum-k">${tr("Результат")}</span><b class="${sgn(p)}">${fmtSigned(p)}%</b></div>`;

  if (!rows.length) {
    $("#list").innerHTML = `<div class="empty">${isBT() && !trades().length
      ? tr("Бэктестов пока нет. Нажми «+», чтобы записать первую сделку бэктеста.")
      : tr("Сделок нет")}</div>`;
    return;
  }
  const desc = [...rows].reverse(); // новые сверху
  const num_ = tradeNumbers();
  const bt = isBT();

  const profitCell = (t) => {
    const x = num(t.v[COL.profit]);
    return Number.isNaN(x) ? esc(t.v[COL.profit]) : `<span class="${sgn(x)}">${fmtSigned(x)}%</span>`;
  };
  const n2 = (v) => (isNum(v) ? fmtNum(num(v)) : esc(v));
  const dirSpan = (t) => `<span class="dir ${t.v[2] === "Long" ? "long" : t.v[2] === "Short" ? "short" : ""}">${esc(t.v[2])}</span>`;

  const table = `
    <div class="table-wrap"><table class="grid">
      <thead><tr>
        <th class="r c-num">#</th><th>Open</th><th>Close</th>${bt ? "<th>Idea</th>" : ""}<th>Dir</th><th>Pair</th><th>Session</th><th>POI</th><th>Entry</th>
        <th>Result</th><th class="r">RR</th><th class="r">Risk</th><th class="r">Profit</th>
      </tr></thead>
      <tbody>${desc.map((t) => `
        <tr data-n="${t.n}" class="${resClass(res(t))}">
          <td class="r c-num">${num_.get(t.n)}</td><td>${esc(fmtDT(t.v[0]))}</td><td>${esc(fmtDT(t.v[1]))}</td>
          ${bt ? `<td class="c-idea" title="${esc(ideaOf(t))}">${esc(ideaOf(t))}</td>` : ""}
          <td>${dirSpan(t)}</td>
          <td>${esc(t.v[3])}</td><td>${esc(t.v[4])}</td><td class="c-poi" title="${esc(t.v[5])}">${esc(t.v[5])}</td><td>${esc(t.v[6])}</td>
          <td><span class="res ${resClass(res(t))}">${esc(res(t))}</span></td>
          <td class="r">${n2(t.v[8])}</td><td class="r">${n2(t.v[9])}</td><td class="r">${profitCell(t)}</td>        </tr>`).join("")}
      </tbody></table></div>`;

  let lastDay = null;
  const cards = desc.map((t) => {
    const s = parseDT(t.v[COL.open]);
    const day = Number.isNaN(s) ? "" : fmtDay(Math.floor(s));
    let head = "";
    if (day !== lastDay) {
      const same = desc.filter((x) => { const y = parseDT(x.v[COL.open]); return !Number.isNaN(y) && fmtDay(Math.floor(y)) === day; });
      const dp = same.reduce((a, x) => a + (isNum(x.v[COL.profit]) ? num(x.v[COL.profit]) : 0), 0);
      head = (lastDay !== null ? "</div>" : "") + `<div class="day"><span>${esc(day || tr("Без даты"))}</span><span class="${sgn(dp)}">${fmtSigned(dp)}%</span></div><div class="day-group">`;
      lastDay = day;
    }
    const time = Number.isNaN(s) ? "" : fmtDT(s).slice(-5);
    const ce = parseDT(t.v[COL.close]);
    const tclose = Number.isNaN(ce) ? "" : "–" + fmtDT(ce).slice(-5);
    return head + `
      <div class="card ${resClass(res(t))}" data-n="${t.n}">
        ${bt && ideaOf(t) ? `<div class="card-idea">${esc(ideaOf(t))}</div>` : ""}
        <div class="card-top">
          <span class="tnum">#${num_.get(t.n)}</span><span class="pair">${esc(t.v[3])}</span>${dirSpan(t)}
          <span class="muted">${esc(time + tclose)} · ${esc(t.v[4])}</span>
          <span class="grow"></span>
          <span class="profit">${profitCell(t)}</span>
        </div>
        <div class="card-mid">
          <span class="res ${resClass(res(t))}">${esc(res(t) || "—")}</span>
          ${t.v[5] ? `<span class="poi">${esc(t.v[5])}</span>` : ""}
          ${t.v[6] ? `<span class="muted">${esc(t.v[6])}</span>` : ""}
        </div>
        <div class="card-bot">
          ${isNum(t.v[9]) ? `<span class="muted">Risk ${fmtNum(num(t.v[9]))}%</span>` : ""}
          ${isNum(t.v[8]) ? `<span class="muted">RR ${fmtNum(num(t.v[8]))}</span>` : ""}
        </div>
      </div>`;
  }).join("");

  $("#list").innerHTML = table + `<div class="cards">${cards}${cards ? "</div>" : ""}</div>`;
}

// ---------------- Dashboard ----------------

function equitySvg(points0) {
  if (points0.length < 1) return `<div class="empty">${tr("Мало данных для графика")}</div>`;
  const points = [{ t: null, y: 0 }, ...points0]; // старт с нуля
  // размер под ширину экрана, чтобы подписи не мельчили на телефоне
  const W = Math.round(Math.min(1000, Math.max(320, ($("#view")?.clientWidth || 1000) - 60)));
  const H = W < 600 ? 220 : 300, P = 40;
  const ys = points.map((p) => p.y).concat(0);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const X = (i) => P + (i / (points.length - 1)) * (W - P - 10);
  const Y = (y) => 10 + (1 - (y - lo) / (hi - lo)) * (H - 30);
  const line = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
  const area = `${line}L${X(points.length - 1).toFixed(1)},${Y(0).toFixed(1)}L${X(0).toFixed(1)},${Y(0).toFixed(1)}Z`;
  const ticks = [];
  const step = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const last = points[points.length - 1].y;
  return `<svg viewBox="0 0 ${W} ${H}" class="equity" role="img" aria-label="Equity curve">
    ${ticks.map((v) => `<line x1="${P}" x2="${W - 10}" y1="${Y(v)}" y2="${Y(v)}" class="gridline"/>
      <text x="${P - 6}" y="${Y(v) + 4}" text-anchor="end" class="axis">${fmtNum(v, step < 1 ? 1 : 0)}%</text>`).join("")}
    <line x1="${P}" x2="${W - 10}" y1="${Y(0)}" y2="${Y(0)}" class="zeroline"/>
    <path d="${area}" class="${last >= 0 ? "area-pos" : "area-neg"}"/>
    <path d="${line}" class="eqline"/>
    ${points.map((p, i) => !p.t ? "" : `<circle cx="${X(i)}" cy="${Y(p.y)}" r="3.5" class="dot ${resClass(res(p.t))}"><title>${esc(fmtDT(p.t.v[0]))} ${esc(p.t.v[3])}: ${fmtSigned(num(p.t.v[COL.profit]))}% → ${fmtSigned(p.y)}%</title></circle>`).join("")}
  </svg>`;
}

function niceStep(x) {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / e;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e;
}

function anaTable(title, rows, extra = []) {
  return `<section class="panel"><h3>${title}</h3><table class="ana">
    <thead><tr><th></th><th class="r">Trades</th><th class="r">Win</th><th class="r">Winrate</th>${extra.map((x) => `<th class="r">${x.h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="r">${r.trades}</td><td class="r">${r.win}</td>
      <td class="r"><span class="bar" style="--w:${Math.round(r.winrate * 100)}%"></span>${fmtPct(r.winrate)}</td>
      ${extra.map((x) => `<td class="r">${x.f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></section>`;
}

// Сравнение идей бэктеста: те же показатели, что на Dashboard, по каждой идее.
function ideasTable() {
  const rows = ideaRows();
  if (!rows.length) return `<section class="panel"><h3>${tr("Сравнение идей")}</h3><div class="empty">${tr("Пока нет сделок бэктеста с результатом")}</div></section>`;
  const sel = activeIdea();
  return `<section class="panel"><h3>${tr("Сравнение идей")} <span class="muted">${tr("— по Expectancy (R), лучшая сверху; нажми на идею, чтобы открыть её статистику ниже")}</span></h3>
    <div class="ana-scroll"><table class="ana ideas">
      <thead><tr><th>Idea</th><th class="r">Trades</th><th class="r">WinRate</th><th class="r">Expectancy (R)</th><th class="r">Σ R</th>
        <th class="r">Profit Factor</th><th class="r">AVG RR</th><th class="r">Profit</th><th class="r">Max DD</th></tr></thead>
      <tbody>${rows.map(({ name, k }) => `
        <tr class="pick ${sel && sel === name ? "sel" : ""}" data-idea="${esc(name)}">
          <td>${name ? esc(name) : `<span class="muted">${tr("без идеи")}</span>`}${k.total < MIN_SAMPLE ? ` <span class="few" title="${tr("Меньше {n} сделок — вывод делать рано", { n: MIN_SAMPLE })}">${tr("мало данных")}</span>` : ""}</td>
          <td class="r">${k.total}</td><td class="r">${fmtPct(k.winrate)}</td>
          <td class="r"><b class="${sgn(k.expectancy)}">${fmtSigned(k.expectancy)}</b></td>
          <td class="r ${sgn(k.totalR)}">${fmtSigned(k.totalR)}</td>
          <td class="r">${k.pf == null ? "No Losses" : fmtNum(k.pf)}</td><td class="r">${fmtNum(k.avgRR)}</td>
          <td class="r ${sgn(k.profit)}">${fmtSigned(k.profit)}%</td><td class="r">${fmtNum(k.maxDD)}%</td>
        </tr>`).join("")}</tbody></table></div>
    <div class="idea-cards">${rows.map(({ name, k }) => `
      <div class="idea-card pick ${sel && sel === name ? "sel" : ""}" data-idea="${esc(name)}">
        <div class="ic-name">${name ? esc(name) : `<span class="muted">${tr("без идеи")}</span>`}${k.total < MIN_SAMPLE ? ` <span class="few">${tr("мало данных")}</span>` : ""}</div>
        <div class="ic-grid">
          <div><span>Expectancy</span><b class="${sgn(k.expectancy)}">${fmtSigned(k.expectancy)} R</b></div>
          <div><span>Σ R</span><b class="${sgn(k.totalR)}">${fmtSigned(k.totalR)}</b></div>
          <div><span>WinRate</span><b>${fmtPct(k.winrate)}</b></div>
          <div><span>Trades</span><b>${k.total}</b></div>
          <div><span>PF</span><b>${k.pf == null ? "—" : fmtNum(k.pf)}</b></div>
          <div><span>Max DD</span><b>${fmtNum(k.maxDD)}%</b></div>
        </div>
      </div>`).join("")}</div>
    <div class="hint">${tr("R считается по сделкам, где заполнен Risk. «Мало данных» — меньше {n} сделок: разница между идеями может быть случайной.", { n: MIN_SAMPLE })}</div>
  </section>`;
}

function renderDashboard() {
  if (isBT() && !activeIdea()) { $("#view").innerHTML = modeBar() + ideasTable(); return; }
  const st = compute(scoped(), S.lists);
  const k = st.kpi;
  const kp = (label, value, cls = "") => `<div class="kpi"><div class="kpi-l">${label}</div><div class="kpi-v ${cls}">${value}</div></div>`;
  $("#view").innerHTML = modeBar() + `
    ${isBT() ? ideasTable() : ""}
    ${isBT() ? `<h2 class="sec">${tr("Идея: {name}", { name: esc(activeIdea()) })}</h2>` : ""}
    <div class="kpis">
      ${kp("Total Trades", k.total)}
      ${kp("WinRate", fmtPct(k.winrate))}
      ${kp("AVG RR", fmtNum(k.avgRR))}
      ${kp("Profit Factor", k.pf == null ? (k.total ? "No Losses" : "—") : fmtNum(k.pf))}
      ${kp("Expectancy (R)", fmtSigned(k.expectancy), sgn(k.expectancy))}
      ${isBT() ? kp("Σ R", fmtSigned(k.totalR), sgn(k.totalR)) : kp("Duration", fmtDuration(k.duration))}
      ${kp("Max Drawdown", fmtNum(k.maxDD) + "%", k.maxDD > 0 ? "neg" : "")}
      ${kp("Profit", fmtSigned(k.profit) + "%", sgn(k.profit))}
    </div>
    <section class="panel"><h3>${tr("Equity Curve, % от счёта")}</h3>${equitySvg(st.equity)}</section>
    <div class="ana-grid">
      ${anaTable("POI Analysis", st.poi)}
      ${anaTable("Entry Model Analysis", st.entry)}
      ${anaTable("Session Analysis", st.session, [{ h: "AVG RR", f: (r) => fmtNum(r.rr) }])}
      ${anaTable(tr("По инструментам"), st.pair, [
        { h: "Profit", f: (r) => `<span class="${sgn(r.profit)}">${fmtSigned(r.profit)}%</span>` },
        { h: "PF", f: (r) => (r.pf == null ? "—" : fmtNum(r.pf)) },
      ])}
    </div>`;
}

// ---------------- Статистика ----------------

// Столбцы «от нуля»: прибыльные вверх (зелёные), убыточные вниз (красные); подпись значения у конца столбца.
function zeroBars(rows, label, short, frac = 1) {
  if (!rows.length) return `<div class="empty">${tr("Пока нет сделок с датой")}</div>`;
  const full = Math.min(1100, $("#view")?.clientWidth || 1000) - 80;
  const W = Math.round(Math.max(300, window.innerWidth > 900 ? full * frac - (frac < 1 ? 30 : 0) : full));
  const vals = rows.map((r) => r.profit);
  const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
  // место под подписи значений: сверху — у прибыльных, снизу — у убыточных (не налезают на подписи периодов)
  const H = 260, top = 26, bottom = 30 + (lo < 0 ? 24 : 0), padX = 8;
  const span = hi - lo || 1;
  const Y = (v) => top + (hi - v) / span * (H - top - bottom);
  const slot = (W - padX * 2) / rows.length;
  const bw = Math.min(64, slot * 0.62);
  const y0 = Y(0);
  const bars = rows.map((r, i) => {
    const cx = padX + slot * (i + 0.5);
    const y = Y(r.profit), h = Math.max(2, Math.abs(y - y0));
    const up = r.profit >= 0;
    const by = up ? y0 - h : y0;
    const rr = Math.min(4, h / 2);
    const L = cx - bw / 2, R = cx + bw / 2;
    // скругление только у свободного конца столбца, у нулевой линии — прямой край
    const path = up
      ? `M${L},${by + h}V${by + rr}Q${L},${by} ${L + rr},${by}H${R - rr}Q${R},${by} ${R},${by + rr}V${by + h}Z`
      : `M${L},${by}V${by + h - rr}Q${L},${by + h} ${L + rr},${by + h}H${R - rr}Q${R},${by + h} ${R},${by + h - rr}V${by}Z`;
    const tip = `${label(r)} · ${tr("Сделок")}: ${r.trades} · WinRate ${fmtPct(r.winrate)} · ${fmtSigned(r.profit)}%${r.withR ? ` · ${fmtSigned(r.totalR)} R` : ""}`;
    const ty = up ? by - 8 : by + h + 16;
    return `<g class="zb ${up ? "pos" : "neg"}" data-tip="${esc(tip)}">
      <rect x="${cx - slot / 2}" y="${top - 20}" width="${slot}" height="${H - top - bottom + 40}" class="zb-hit"/>
      <path d="${path}" class="zb-bar"/>
      <text x="${cx}" y="${ty}" text-anchor="middle" class="zb-val">${fmtSigned(r.profit)}%</text>
      <text x="${cx}" y="${H - 8}" text-anchor="middle" class="axis">${esc(short(r))}</text>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="zbars" role="img" aria-label="${esc(tr("Прибыль по периодам"))}">
    <line x1="${padX}" x2="${W - padX}" y1="${y0}" y2="${y0}" class="zeroline"/>${bars}</svg>`;
}

function renderStats() {
  if (isBT() && !activeIdea()) {
    $("#view").innerHTML = `<div class="stats-page">${modeBar()}<section class="panel stats-empty">
      <h3>${tr("Пока нет сделок бэктеста с результатом")}</h3>
      <p class="muted">${tr("Открой «Журнал» → «Бэктест», нажми «+», выбери идею и запиши сделку с результатом — здесь появится её статистика по месяцам и дням недели.")}</p>
    </section></div>`;
    return;
  }
  const p = period(scoped());
  const T = p.total;
  const WD = LANG === "en" ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const WDL = LANG === "en" ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    : ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
  const tile = (l, v, cls = "", sub = "") => `<div class="kpi"><div class="kpi-l">${l}</div><div class="kpi-v ${cls}">${v}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  const pf = (x) => (x == null ? "—" : fmtNum(x));
  const row = (label, r, cls = "") => `<tr class="${cls}"><td>${label}</td><td class="r">${r.trades}</td>
    <td class="r wlb"><span class="pos">${r.win}</span> / <span class="neg">${r.lose}</span> / <span class="muted">${r.be}</span></td>
    <td class="r">${fmtPct(r.winrate)}</td><td class="r"><b class="${sgn(r.profit)}">${fmtSigned(r.profit)}%</b></td>
    <td class="r ${sgn(r.totalR)}">${r.withR ? fmtSigned(r.totalR) : "—"}</td><td class="r">${pf(r.pf)}</td></tr>`;
  const head = `<thead><tr><th></th><th class="r">${tr("Сделок")}</th><th class="r">W / L / BE</th><th class="r">WinRate</th>
    <th class="r">Profit</th><th class="r">Σ R</th><th class="r">PF</th></tr></thead>`;
  $("#view").innerHTML = `<div class="stats-page">${modeBar()}
    ${isBT() ? `<h2 class="sec">${tr("Идея: {name}", { name: esc(activeIdea()) })}</h2>` : ""}
    <div class="kpis stats-kpis">
      ${tile(tr("Итог"), fmtSigned(T.profit) + "%", sgn(T.profit), T.withR ? `${fmtSigned(T.totalR)} R` : "")}
      ${tile(tr("Сделок"), T.trades, "", tr("в среднем {n} в месяц", { n: fmtNum(p.avgPerMonth, 1) }))}
      ${tile("WinRate", fmtPct(T.winrate), "", `${T.win} / ${T.lose} / ${T.be}`)}
      ${tile(tr("Лучший месяц"), p.best ? fmtSigned(p.best.profit) + "%" : "—", p.best ? sgn(p.best.profit) : "", p.best ? esc(fmtMonth(p.best.key)) : "")}
      ${tile(tr("Худший месяц"), p.worst ? fmtSigned(p.worst.profit) + "%" : "—", p.worst ? sgn(p.worst.profit) : "", p.worst ? esc(fmtMonth(p.worst.key)) : "")}
      ${tile(tr("Серии подряд"), `<span class="pos">${p.maxWinStreak}</span> / <span class="neg">${p.maxLossStreak}</span>`, "", tr("побед / поражений"))}
    </div>
    <section class="panel">
      <h3>${tr("Прибыль по месяцам, % от счёта")}</h3>
      ${zeroBars(p.months, (m) => fmtMonth(m.key), (m) => fmtMonth(m.key).slice(0, 3) + " " + m.key.slice(2, 4))}
    </section>
    <section class="panel">
      <h3>${tr("По месяцам")}${isBT() ? ` <span class="muted">${tr("— {name}, месяц — дата сделки на истории", { name: esc(activeIdea()) })}</span>` : ""}</h3>
      <div class="ana-scroll-x"><table class="ana stats-table">${head}
        <tbody>${[...p.months].reverse().map((m) => row(esc(fmtMonth(m.key)), m)).join("")}${row(tr("Итого"), T, "total")}</tbody>
      </table></div>
    </section>
    <div class="ana-grid stats-two">
      <section class="panel">
        <h3>${tr("По дням недели")} <span class="muted">${tr("— день входа в сделку")}</span></h3>
        ${zeroBars(p.days, (d) => WDL[d.day], (d) => WD[d.day], 0.5)}
      </section>
      <section class="panel">
        <h3>${tr("Дни недели — подробно")}</h3>
        <div class="ana-scroll-x"><table class="ana stats-table">${head}
          <tbody>${p.days.map((d) => row(WDL[d.day], d)).join("")}</tbody></table></div>
      </section>
    </div>
  </div>`;
}

// Подсказка у столбцов статистики (наведение мышью или касание).
function chartTip(e) {
  const g = e.target.closest?.("[data-tip]");
  let tip = $("#chartTip");
  if (!g) { if (tip) tip.hidden = true; return; }
  if (!tip) { tip = Object.assign(document.createElement("div"), { id: "chartTip", className: "chart-tip" }); document.body.append(tip); }
  tip.textContent = g.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = Math.max(8, x) + "px";
  tip.style.top = Math.max(8, e.clientY - tip.offsetHeight - 12) + "px";
}

// ---------------- карточка сделки ----------------

function saveDraft() {
  if (S.ed) lsSet("tj.draft", JSON.stringify({ mode: S.ed.mode, n: S.ed.n, key: S.ed.key, form: S.ed.form }));
}
const clearDraft = () => lsDel("tj.draft");

function openEditor(n, form = null) {
  const t = n ? trades().find((x) => x.n === n) : null;
  if (n && !t) { toast(tr("Сделка не найдена — таблица изменилась"), true); return; }
  S.ed = {
    mode: S.mode, n: t ? t.n : null, key: t ? { open: t.v[0], pair: t.v[3] } : null,
    form: form || toForm(t, isBT() ? activeIdea() : ""), uploading: {}, activeTf: "H4", manage: null,
  };
  $("#editor").hidden = false;
  document.body.classList.add("modal-open");
  renderEditor();
}

function closeEditor() {
  S.ed = null;
  $("#editor").hidden = true;
  document.body.classList.remove("modal-open");
}

function seg(name, options, cur) {
  return `<div class="seg" data-seg="${name}">${options.map((o) =>
    `<button type="button" data-val="${esc(o)}" class="${cur === o ? "on " + (resClass(o) || o.toLowerCase()) : ""}">${esc(o)}</button>`).join("")}</div>`;
}

// Поле-список (POI — несколько значений, Entry и Idea — одно) с режимом правки самого списка.
function listField(kind, label, items, selected) {
  const manage = S.ed.manage === kind;
  let chips;
  if (manage) {
    chips = items.map((p) => `<span class="chip edit">${esc(p)}<button type="button" class="chip-x" data-rm="${kind}" data-val="${esc(p)}" aria-label="${tr("Убрать {x}", { x: esc(p) })}">×</button></span>`).join("")
      + `<span class="chip-add"><input data-add="${kind}" placeholder="${tr({ idea: "Новая идея", pair: "Новая пара, например USDJPY" }[kind] || "Новая запись")}" enterkeyhint="done" maxlength="${kind === "idea" ? 80 : 40}"${kind === "pair" ? ' autocapitalize="characters"' : ""}>`
      + `<button type="button" class="btn sm" data-addbtn="${kind}">${tr("Добавить")}</button></span>`;
  } else {
    // выбранное, но удалённое из списка значение всё равно видно в этой сделке
    chips = [...new Set([...items, ...selected])].map((p) =>
      `<button type="button" class="chip ${selected.includes(p) ? "on" : ""}${items.includes(p) ? "" : " stale"}" data-pick="${kind}" data-val="${esc(p)}">${esc(p)}</button>`).join("")
      || `<span class="muted">${tr("Список пуст — нажми «Изменить список»")}</span>`;
  }
  return `<div class="field${manage ? " managing" : ""}${kind === "idea" ? " idea-field" : ""}">
    <div class="field-h"><span>${label}</span>
      <button type="button" class="link-btn" data-manage="${kind}">${manage ? tr("Готово") : tr("Изменить список")}</button></div>
    <div class="chips">${chips}</div>
    ${manage ? `<div class="hint">${tr("Изменения списка сразу сохраняются в таблицу (лист {sheet}). Сделки, где значение уже записано, не меняются.", { sheet: esc(CONFIG.listsSheet) })}</div>` : ""}
  </div>`;
}

async function updateList(kind, list) {
  const next = { poi: S.lists.poi, entry: S.lists.entry, idea: S.lists.idea, pair: S.lists.pair, tf: S.lists.tf, [kind]: list };
  setBusy(true);
  try {
    await api.saveLists(next, [book("live").sheetId, S.books.bt?.sheetId]);
    Object.assign(S.lists, next);
    if (S.ed) renderEditor(); else render();
    toast(tr("Список сохранён"));
    return true;
  } catch (e) {
    handleErr(e);
    return false;
  } finally {
    setBusy(false);
  }
}

function addToList(kind) {
  const input = $(`input[data-add="${kind}"]`);
  let val = (input?.value || "").trim().replace(/\s+/g, " ");
  if (kind === "pair") val = val.toUpperCase().replace(/\s/g, "");
  if (kind === "tf") {
    val = val.replace(/\s/g, "");
    if (val.includes(":")) { toast(tr("В названии таймфрейма не должно быть двоеточия"), true); return; }
    val = TF.find((x) => x.toLowerCase() === val.toLowerCase()) || val; // W1..m3 — в своём написании
  }
  if (!val) return;
  if (kind === "poi" && val.includes(",")) { toast(tr("В названии POI не должно быть запятой — ею разделяются POI в ячейке"), true); return; }
  const list = S.lists[kind];
  if (list.some((x) => x.toLowerCase() === val.toLowerCase())) { toast(tr("Такое уже есть в списке"), true); return; }
  updateList(kind, [...list, val]);
}

function renderEditor() {
  const f = S.ed.form;
  const bt = S.ed.mode === "bt";
  const body = $("#editor .ed-body");
  const scroll = body ? body.scrollTop : 0;
  const isNew = !S.ed.n;
  const r = num(f.profit) / num(f.risk);
  const sel = (k, list) => `<select data-k="${k}"><option value=""></option>${[...new Set([...list, f[k]].filter(Boolean))]
    .map((x) => `<option ${x === f[k] ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>`;
  const title = (bt ? tr("Бэктест · ") : "") + (isNew ? tr("Новая сделка") : tr("Сделка #{n}", { n: tradeNumbers(S.ed.mode).get(S.ed.n) ?? "?" }));

  $("#editor").innerHTML = `
    <div class="ed-sheet${bt ? " bt" : ""}">
      <div class="ed-head">
        <button class="btn ghost" data-act="cancel">${tr("Отмена")}</button>
        <div class="ed-title">${title}</div>
        <button class="btn primary" data-act="save">${tr("Сохранить")}</button>
      </div>
      <div class="ed-body">
        ${bt ? listField("idea", tr("Idea — какую идею тестируешь"), S.lists.idea, f.idea ? [f.idea] : []) : ""}
        <div class="row2">
          <label>Open<input type="datetime-local" data-k="open" value="${esc(f.open)}"></label>
          <label>Close<input type="datetime-local" data-k="close" value="${esc(f.close)}"></label>
        </div>
        ${listField("pair", "Pair", S.lists.pair, f.pair ? [f.pair] : [])}
        <label>Direction${seg("dir", ["Long", "Short"], f.dir)}</label>
        <div class="row2">
          <label>Session${sel("session", S.lists.session)}</label>
          <label>Result${seg("result", DEF.result, f.result)}</label>
        </div>
        ${listField("poi", "POI", S.lists.poi, f.poi)}
        ${listField("entry", "Entry", S.lists.entry, f.entry ? [f.entry] : [])}
        <div class="row3">
          <label>RR<input inputmode="decimal" data-k="rr" value="${esc(f.rr)}"></label>
          <label>Risk, %<input inputmode="decimal" data-k="risk" value="${esc(f.risk)}"></label>
          <label>Profit, %<input inputmode="decimal" data-k="profit" value="${esc(f.profit)}"></label>
        </div>
        <div class="hint" id="rHint">${Number.isFinite(r) ? tr("Итог в R: {r}", { r: fmtSigned(r) }) : bt ? tr("Совет: в бэктесте ставь одинаковый Risk (например 0,5), тогда идеи честно сравниваются в R.") : ""}</div>
        ${shotsBlock()}
        <label>Exit<input data-k="exit" value="${esc(f.exit)}"></label>
        <label>Notes<textarea data-k="notes" rows="4">${esc(f.notes)}</textarea></label>
        ${isNew ? "" : `<button class="btn danger wide" data-act="delete">${tr("Удалить сделку")}</button>`}
      </div>
    </div>`;
  $("#editor .ed-body").scrollTop = scroll;
  hydrateThumbs($("#editor"));
}

// ---------- вкладка «Стратегия»: своя у каждого пользователя (лист Strategy его таблицы) ----------

function renderStrategy() {
  const md = S.strategy;
  if (S.stB) return renderStrategyBuilder();
  if (S.stEdit != null) return renderStrategyEditor();
  if (!md || !md.trim()) {
    $("#view").innerHTML = `<div class="st-page"><section class="panel st-empty">
      <img src="icons/tb-icon-192.png" alt="" class="st-empty-logo">
      <h2>${tr("Твоя торговая стратегия")}</h2>
      <p class="muted">${tr("Здесь хранятся правила твоей торговли: пары, риск, сетапы, вход, стоп и тейк. Стратегия лежит в твоей Google-таблице и видна только тебе.")}</p>
      <div class="cle-actions st-empty-actions">
        <button type="button" class="btn primary" data-act="st-build">${tr("Заполнить по разделам")}</button>
        <button type="button" class="btn ghost" data-act="st-template">${tr("Писать текстом")}</button>
      </div>
      <div class="hint st-empty-hint">${tr("По разделам проще: пары, риск, время, сетапы — у каждого свои поля с подсказками. Текстом — для тех, кто привык к Markdown.")}
      </div>
    </section></div>`;
    return;
  }
  const r = St.render(md);
  $("#view").innerHTML = `<div class="st-page">
    <header class="panel st-head">
      <img src="icons/tb-icon-192.png" alt="" class="st-logo">
      <div class="st-title"><h1>${tr("Торговая стратегия")}</h1><div class="muted">Trader'sBook</div></div>
      <span class="grow"></span>
      <button type="button" class="btn ghost sm" data-act="st-expand">${tr("Развернуть всё")}</button>
      <button type="button" class="btn primary sm" data-act="st-edit">${tr("Изменить")}</button>
    </header>
    ${r.missing.length ? `<div class="panel st-missing">
      <div><b>${tr("Картинок не загружено: {n}", { n: r.missing.length })}</b>
        <div class="muted">${tr("Нажми «Загрузить картинки» и выбери файлы — каждый встанет на своё место по имени ({ex}).", { ex: esc(r.missing[0]) })}</div></div>
      <label class="btn primary sm file">${tr("Загрузить картинки")}<input type="file" accept="image/*" multiple data-stmissing="1" hidden></label>
    </div>` : ""}
    <div class="st-layout">
      <nav class="st-toc">${r.toc.map((x) => `<a href="#${x.id}" data-sttoc="${x.id}">${esc(x.title)}</a>`).join("")}</nav>
      <article class="panel st-body">${r.html}</article>
    </div>
  </div>`;
  hydrateThumbs($("#view"));
  if (r.missing.length && !S.stAutoTried && auth.hasDrive()) { S.stAutoTried = true; stAutoImport(); }
}

// Картинки, заранее положенные в скрытый лист StrategyImages, грузятся в Drive сами — один раз.
async function stAutoImport() {
  try {
    const files = await api.pendingImages();
    if (!files.length) return;
    await stUpload(files, "missing");
    if (!St.render(S.strategy).missing.length) await api.dropPendingImages();
  } catch (e) {
    handleErr(e);
  }
}

// ---------------- конструктор стратегии ----------------
const STB_HINT = {
  principles: "Например:\nТоргую только сетапы с этой страницы\nНе отыгрываюсь после убытка",
  time: "Например:\nЛондон 10:00–13:00 (UTC+3)\nНе вхожу в первые 15 минут сессии\nНе торгую за 15 минут до важных новостей",
  manage: "Например:\nПри +1R переношу стоп в безубыток\nЗакрываю сделку до конца сессии",
};

function renderStrategyBuilder() {
  const d = S.stB;
  const preview = S.stPreview;
  const r = preview ? St.render(SB.toMarkdown(d)) : null;
  const area = (path, value, ph, rows = 3) =>
    `<textarea class="stb-area" rows="${rows}" data-stb="${path}" placeholder="${esc(ph)}">${esc(value || "")}</textarea>`;
  const field = (label, help, html) => `<label class="stb-field"><span class="stb-label">${label}${help ? ` <span class="muted">${help}</span>` : ""}</span>${html}</label>`;
  const tools = (path, i, n) => `<span class="stb-tools">
      <button type="button" class="stb-btn" data-stbmove="${path}|${i}|-1" ${i ? "" : "disabled"} aria-label="${tr("Выше")}">↑</button>
      <button type="button" class="stb-btn" data-stbmove="${path}|${i}|1" ${i < n - 1 ? "" : "disabled"} aria-label="${tr("Ниже")}">↓</button>
      <button type="button" class="chip-x" data-stbdel="${path}|${i}" aria-label="${tr("Удалить")}">×</button></span>`;
  const images = (path, list) => `<div class="stb-imgs">
      ${(list || []).map((u, j) => `<span class="stb-thumb">${St.imageHtml(u)}<button type="button" class="chip-x" data-stbimgdel="${path}|${j}" aria-label="${tr("Удалить")}">×</button></span>`).join("")}
      <label class="btn ghost sm file">${tr("+ картинка")}<input type="file" accept="image/*" multiple data-stbimg="${path}" hidden></label></div>`;

  const body = (s, i) => {
    const p = `sections.${i}`;
    if (s.kind === "list") {
      return area(`${p}.text`, s.text, tr(STB_HINT[s.hint] || "Каждая строка — отдельный пункт"), 4) + images(`${p}.images`, s.images);
    }
    if (s.kind === "pairs") {
      return `<div class="chips">${S.lists.pair.map((x) => `<button type="button" class="chip ${s.pairs.includes(x) ? "on" : ""}" data-stbpair="${i}|${esc(x)}">${esc(x)}</button>`).join("")}
        <button type="button" class="chip add" data-stbpairadd="${i}">${tr("+ пара")}</button></div>
        ${area(`${p}.text`, s.text, tr("Заметки по парам (не обязательно)"), 2)}`;
    }
    if (s.kind === "risk") {
      const num = (k, label, ph) => field(label, "", `<input data-stb="${p}.${k}" value="${esc(s[k] || "")}" placeholder="${ph}" inputmode="decimal">`);
      return `<div class="stb-grid">
          ${num("risk", tr("Риск на сделку, %"), "0,5")}
          ${num("stops", tr("Стопов в день, максимум"), "2")}
          ${num("trades", tr("Сделок в день, максимум"), "3")}
          ${num("rr", tr("Минимальный RR, 1 к …"), "2")}
        </div>
        ${field(tr("Другие правила риска"), "", area(`${p}.text`, s.text, tr("Например: после 3 стопов подряд риск 0,25%"), 2))}`;
    }
    return `${(s.setups || []).map((st, j) => {
      const q = `${p}.setups.${j}`;
      return `<div class="stb-setup">
        <div class="stb-head"><input class="stb-name" data-stb="${q}.name" value="${esc(st.name)}" placeholder="${tr("Название сетапа")}">${tools(`${p}.setups`, j, s.setups.length)}</div>
        ${field(tr("Когда появляется"), tr("— контекст, время, что делает цена"), area(`${q}.when`, st.when, tr("Например:\nАзия в диапазоне\nЛондон снимает максимум Азии"), 3))}
        <div class="stb-grid stb-grid-3">
          ${field(tr("Вход"), "", area(`${q}.entry`, st.entry, tr("Например: слом структуры на M5, вход от отката"), 2))}
          ${field("Stop Loss", "", area(`${q}.sl`, st.sl, tr("Например: за максимум манипуляции"), 2))}
          ${field("Take Profit", "", area(`${q}.tp`, st.tp, tr("Например: минимум Азии"), 2))}
        </div>
        ${field(tr("Когда сделки нет"), tr("— сетап отменяется"), area(`${q}.inval`, st.inval, tr("Например: цена ушла дальше 30 пунктов от открытия дня"), 2))}
        ${images(`${q}.images`, st.images)}
      </div>`;
    }).join("")}
      <button type="button" class="btn ghost sm" data-stbaddsetup="${i}">${tr("+ сетап")}</button>`;
  };

  const kinds = new Set(d.sections.map((s) => s.kind));
  const addBtn = (kind, label) => `<button type="button" class="btn ghost sm" data-stbadd="${kind}">${label}</button>`;
  $("#view").innerHTML = `<div class="st-page stb-page">
    <header class="panel st-head">
      <img src="icons/tb-icon-192.png" alt="" class="st-logo">
      <div class="st-title"><h1>${tr("Торговая стратегия")}</h1><div class="muted">${tr("Конструктор")}</div></div>
      <span class="grow"></span>
      <button type="button" class="btn ghost sm" data-act="st-cancel">${tr("Отмена")}</button>
      <button type="button" class="btn primary sm" data-act="st-save">${tr("Сохранить")}</button>
    </header>
    <div class="stb-bar">
      <div class="seg st-mode">
        <button type="button" data-act="st-write" class="${preview ? "" : "on"}">${tr("Заполнение")}</button>
        <button type="button" data-act="st-preview" class="${preview ? "on" : ""}">${tr("Просмотр")}</button>
      </div>
      <span class="grow"></span>
      <button type="button" class="link-btn muted" data-act="st-totext">${tr("Писать текстом")}</button>
    </div>
    ${preview ? `<article class="panel st-body">${r.html || `<div class="empty">${tr("Пока пусто — заполни хотя бы один раздел")}</div>`}</article>` : `
    <div class="hint stb-intro">${tr("Заполняй только то, что нужно: пустые поля и разделы на странице не появятся. В каждом поле одна строка — один пункт.")}</div>
    ${d.sections.map((s, i) => `<section class="panel stb-sec">
      <div class="stb-head"><input class="stb-title" data-stb="sections.${i}.title" value="${esc(s.title)}" placeholder="${tr("Название раздела")}">${tools("sections", i, d.sections.length)}</div>
      ${body(s, i)}
    </section>`).join("")}
    <div class="stb-add">
      ${addBtn("list", tr("+ свой раздел"))}
      ${kinds.has("setups") ? "" : addBtn("setups", tr("+ сетапы"))}
      ${kinds.has("risk") ? "" : addBtn("risk", tr("+ риск-менеджмент"))}
      ${kinds.has("pairs") ? "" : addBtn("pairs", tr("+ торговые пары"))}
    </div>`}
  </div>`;
  hydrateThumbs($("#view"));
  $$(".stb-area").forEach(autoGrow);
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + 2 + "px";
}

function openBuilder(d) {
  S.stB = d;
  S.stBOrig = JSON.stringify(d);
  S.stPreview = false;
  renderStrategy();
  window.scrollTo(0, 0);
}

// Действия конструктора; true — нажатие обработано.
function builderClick(b) {
  const d = S.stB;
  if (!d) return false;
  const ds = b.dataset;
  if (ds.stbmove) {
    const [path, i, dir] = ds.stbmove.split("|");
    const [p, k] = clPath(d, path); const a = p[k], x = +i, y = x + +dir;
    if (y < 0 || y >= a.length) return true;
    [a[x], a[y]] = [a[y], a[x]];
  } else if (ds.stbdel) {
    const [path, i] = ds.stbdel.split("|");
    const [p, k] = clPath(d, path);
    const what = path === "sections" ? tr("раздел целиком") : tr("сетап целиком");
    if (!confirm(tr("Удалить {what}?", { what }))) return true;
    p[k].splice(+i, 1);
  } else if (ds.stbimgdel) {
    const [path, j] = ds.stbimgdel.split("|");
    const [p, k] = clPath(d, path); p[k].splice(+j, 1);
  } else if (ds.stbpair) {
    const [i, pair] = ds.stbpair.split("|");
    const s = d.sections[+i];
    s.pairs = s.pairs.includes(pair) ? s.pairs.filter((x) => x !== pair) : [...s.pairs, pair];
  } else if (ds.stbpairadd) {
    const val = (prompt(tr("Новая торговая пара (например, USDJPY):")) || "").toUpperCase().replace(/\s/g, "");
    if (!val) return true;
    const s = d.sections[+ds.stbpairadd];
    if (S.lists.pair.some((x) => x.toUpperCase() === val)) { if (!s.pairs.includes(val)) s.pairs.push(val); renderStrategy(); return true; }
    updateList("pair", [...S.lists.pair, val]).then((ok) => { if (ok) { s.pairs.push(val); renderStrategy(); } });
    return true;
  } else if (ds.stbaddsetup) {
    d.sections[+ds.stbaddsetup].setups.push(SB.newSetup(d.lang));
  } else if (ds.stbadd) {
    d.sections.push(SB.newSection(ds.stbadd, d.lang));
    renderStrategy();
    $$(".stb-sec").at(-1)?.scrollIntoView({ block: "start" });
    $$(".stb-sec").at(-1)?.querySelector("input")?.focus();
    return true;
  } else return false;
  renderStrategy();
  return true;
}

async function stbUpload(files, path) {
  if (!auth.hasDrive()) { toast(tr("Нет доступа к Google Drive — при входе отметь доступ к файлам"), true); return; }
  setBusy(true);
  try {
    const [p, k] = clPath(S.stB, path);
    for (const f of files) p[k].push(await api.uploadImage(f, `strategy_${f.name}`));
    renderStrategy();
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

async function stbSave() {
  setBusy(true);
  try {
    const md = SB.toMarkdown(S.stB), data = JSON.stringify(S.stB);
    await api.saveStrategy(md, data);
    S.strategy = md; S.strategyData = data;
    S.stB = null; S.stPreview = false;
    renderStrategy();
    window.scrollTo(0, 0);
    toast(tr("Стратегия сохранена"));
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

// ---------------- подключения: перенос сделок с бирж и торговых счетов ----------------
const CX = { adding: "", form: {}, preview: null, msg: "", report: null };
const PERIODS = [["last", "с прошлой загрузки"], ["30", "30 дней"], ["90", "90 дней"], ["180", "180 дней"], ["all", "вся доступная история"]];

function renderConnect() {
  const conns = Conn.list();
  const src = CX.adding && Conn.SOURCES[CX.adding];
  const card = (c) => {
    const s = Conn.SOURCES[c.src];
    return `<div class="card cx-card">
      <div class="cx-top"><b>${esc(c.label || s.name)}</b><span class="muted">${esc(s.name)}</span><span class="grow"></span>
        <button type="button" class="chip-x" data-cxdel="${esc(c.id)}" aria-label="${tr("Удалить")}">×</button></div>
      <div class="muted cx-last">${c.last ? tr("Последняя загрузка: {d}", { d: new Date(c.last).toLocaleString() }) : tr("Ещё не загружали")}</div>
      <div class="cx-row">
        <select data-cxper="${esc(c.id)}">${PERIODS.filter(([v]) => v !== "last" || c.last).map(([v, l]) => `<option value="${v}">${tr(l)}</option>`).join("")}</select>
        <button type="button" class="btn primary sm" data-cxrun="${esc(c.id)}">${tr("Загрузить сделки")}</button>
      </div>
    </div>`;
  };
  const pv = CX.preview;
  $("#view").innerHTML = `<div class="cx-page">
    <div class="cx-head"><button type="button" class="btn ghost sm" data-act="cx-back">← ${tr("Журнал")}</button>
      <h2>API</h2><span class="muted">${tr("биржи и торговые счета")}</span></div>
    <div class="hint cx-note">${tr("Сделки переносятся в журнал сами: время, пара, направление, результат, Profit, а для MT — ещё Risk и RR по стопу. POI, вход, скриншоты и заметки дописываешь ты. Ключи хранятся только на этом устройстве и уходят только на сайт биржи или MetaApi. Создавай ключи только для чтения.")}</div>
    ${CX.msg ? `<div class="panel cx-msg">${esc(CX.msg)}</div>` : ""}
    ${pv ? previewHtml(pv) : `
    <section class="panel"><h3>${tr("Мои подключения")}</h3>
      ${conns.length ? conns.map(card).join("") : `<div class="empty">${tr("Пока ничего не подключено")}</div>`}
    </section>
    <section class="panel"><h3>${tr("Подключить")}</h3>
      <div class="chips">${Object.entries(Conn.SOURCES).map(([k, s]) => `<button type="button" class="chip ${CX.adding === k ? "on" : ""}" data-cxsrc="${k}">${esc(tr(s.name))}</button>`).join("")}
        <button type="button" class="chip ${CX.adding === "file" ? "on" : ""}" data-cxsrc="file">${tr("Отчёт MT4/MT5 (файл)")}</button></div>
      ${CX.adding === "file" ? reportForm() : ""}
      ${src ? `<div class="cx-form">
        <div class="hint">${esc(tr(src.help))}</div>
        <label>${tr("Название (для себя)")}<input data-cxf="label" value="${esc(CX.form.label || "")}" placeholder="${esc(tr(src.name))}"></label>
        ${src.fields.map(([k, l, secret]) => k === "platform"
          ? `<label>${tr("Платформа")}<select data-cxf="platform">${["mt5", "mt4"].map((p) => `<option ${CX.form.platform === p ? "selected" : ""}>${p}</option>`).join("")}</select></label>`
          : `<label>${esc(tr(l))}<input data-cxf="${k}" ${secret ? 'type="password" autocomplete="new-password"' : 'autocomplete="off"'} value="${esc(CX.form[k] || "")}" spellcheck="false"></label>`).join("")}
        <div class="cle-actions"><button type="button" class="btn primary" data-act="cx-save">${tr("Подключить")}</button>
          <button type="button" class="btn ghost" data-act="cx-cancel">${tr("Отмена")}</button></div>
      </div>` : ""}
      <div class="hint cx-soon">${tr("Bitget, KuCoin, MEXC, Gate и Kraken не разрешают запросы из браузера — для них нужен свой посредник, это следующий шаг.")}</div>
    </section>`}
  </div>`;
}

function reportForm() {
  const r = CX.report;
  const tzs = [["ny7", tr("Нью-Йорк + 7 ч (как у большинства брокеров и проп-компаний)")], ["0", "UTC"], ["60", "UTC+1"], ["120", "UTC+2"], ["180", "UTC+3"]];
  if (r && !tzs.some(([v]) => v === r.tz)) tzs.push([r.tz, "UTC" + (r.tz >= 0 ? "+" : "") + r.tz / 60]);
  return `<div class="cx-form">
    <div class="hint">${tr("В терминале: вкладка «История» → правый клик → «Отчёт» → HTML. Сохрани файл и выбери его здесь. Ключи не нужны.")}</div>
    <label class="btn ghost file cx-filebtn">${r ? esc(r.name) : tr("Выбрать файл отчёта")}<input type="file" accept=".html,.htm" data-cxfile="1" hidden></label>
    ${r ? `<div class="muted">${tr("Счёт {a}: позиций {n}", { a: esc(r.p.account || "—"), n: r.p.positions.length })}</div>
    <label>${tr("Время сервера в отчёте")}<select data-cxtz="1">${tzs.map(([v, l]) => `<option value="${v}" ${r.tz === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
    <div class="cle-actions"><button type="button" class="btn primary" data-act="cx-report">${tr("Показать сделки")}</button></div>` : ""}
  </div>`;
}

async function cxReadReport(file) {
  try {
    const p = Conn.parseMtReport(Conn.decodeReport(await file.arrayBuffer()));
    if (!p.positions.length) { toast(tr("В файле не нашлось закрытых позиций — это точно HTML-отчёт из MT4/MT5?"), true); return; }
    CX.report = { p, name: file.name, tz: Conn.guessServerTz(p.reportDate, file.lastModified) };
  } catch (e) {
    toast(tr("Не получилось прочитать файл: {e}", { e: e.message }), true);
  }
  renderConnect();
}

function cxReportPreview() {
  const r = CX.report;
  const list = Conn.fromReport(r.p, r.tz);
  const done = Conn.imported(), journal = trades("live");
  const label = (r.p.platform === "mt4" ? "MT4" : "MT5") + (r.p.account ? " " + r.p.account : "") + " (" + tr("отчёт") + ")";
  const items = list.map((t) => {
    const key = `file:${r.p.account}:${t.id}`;
    const dup = Conn.isDuplicate(t, journal), seen = !dup && done.has(key);
    return { key, row: Conn.toRow(t, label, S.lists.pair), dup, seen, pick: !dup && !seen };
  });
  CX.preview = { conn: "", items, at: Date.now() };
  renderConnect();
}

function previewHtml(pv) {
  const fresh = pv.items.filter((x) => !x.dup);
  return `<section class="panel"><h3>${tr("Найдено сделок: {n}", { n: pv.items.length })}${pv.items.length - fresh.length ? ` <span class="muted">· ${tr("уже в журнале: {n}", { n: pv.items.length - fresh.length })}</span>` : ""}</h3>
    ${pv.items.length ? `<div class="ana-scroll-x"><table class="ana cx-table"><thead><tr><th></th><th>${tr("Вход")}</th><th>${tr("Пара")}</th><th></th><th>${tr("Результат")}</th><th class="r">Risk</th><th class="r">Profit</th></tr></thead><tbody>
      ${pv.items.map((x, i) => `<tr class="${x.dup ? "muted" : ""}"><td><input type="checkbox" data-cxpick="${i}" ${x.pick ? "checked" : ""} ${x.dup ? "disabled" : ""}></td>
        <td>${esc(fmtDT(x.row[0]))}</td><td>${esc(x.row[3])}</td><td>${esc(x.row[2])}</td>
        <td>${x.dup ? tr("уже есть") : x.seen && !x.pick ? `<span class="muted">${tr("скрыта")}</span> ${esc(x.row[7])}` : esc(x.row[7])}</td><td class="r">${x.row[9] === "" ? "—" : fmtNum(x.row[9]) + "%"}</td>
        <td class="r ${x.row[10] > 0 ? "pos" : x.row[10] < 0 ? "neg" : ""}">${x.row[10] === "" ? "—" : fmtSigned(x.row[10]) + "%"}</td></tr>`).join("")}
    </tbody></table></div>
    ${fresh.length ? `<div class="hint">${tr("Сделки без галочки не добавятся и в следующий раз будут показаны как «скрыта» — так удалённые из журнала сделки не вернутся сами.")}</div>` : ""}` : `<div class="empty">${tr("Новых закрытых сделок за этот период нет")}</div>`}
    <div class="cle-actions">
      ${fresh.length ? `<button type="button" class="btn primary" data-act="cx-add">${pv.items.some((x) => x.pick) ? tr("Добавить в журнал: {n}", { n: pv.items.filter((x) => x.pick).length }) : tr("Скрыть эти сделки")}</button>` : ""}
      <button type="button" class="btn ghost" data-act="cx-close">${tr("Назад")}</button>
    </div></section>`;
}

async function cxSave() {
  const src = CX.adding, f = CX.form, def = Conn.SOURCES[src];
  const need = def.fields.filter(([k]) => !(src === "metaapi" && k !== "token")).map(([k]) => k);
  if (need.some((k) => !String(f[k] || "").trim())) { toast(tr("Заполни все поля"), true); return; }
  const c = { id: Date.now().toString(36), src, label: (f.label || "").trim() };
  for (const [k] of def.fields) if (f[k]) c[k] = String(f[k]).trim();
  if (src === "metaapi") {
    if (!c.account) {
      if (!c.login || !c.password || !c.server) { toast(tr("Укажи ID счёта MetaApi или номер счёта, пароль инвестора и сервер"), true); return; }
      setBusy(true);
      try { CX.msg = tr("Создаю счёт в MetaApi…"); renderConnect(); c.account = await Conn.metaapiCreate(c, (m) => { CX.msg = tr(m); renderConnect(); }); }
      catch (e) { CX.msg = ""; setBusy(false); toast(e.message, true); renderConnect(); return; }
      setBusy(false);
    }
    delete c.password; // пароль инвестора нужен только для создания счёта в MetaApi
  }
  Conn.upsert(c);
  CX.adding = ""; CX.form = {}; CX.msg = "";
  renderConnect();
  toast(tr("Подключено. Нажми «Загрузить сделки»"));
}

async function cxRun(id) {
  const c = Conn.list().find((x) => x.id === id);
  if (!c) return;
  const per = $(`[data-cxper="${id}"]`)?.value || "last";
  const since = per === "last" ? c.last - 2 * 864e5 : per === "all" ? 0 : Date.now() - +per * 864e5;
  setBusy(true);
  try {
    const list = await Conn.fetchTrades(c, since, (m) => { CX.msg = tr(m); renderConnect(); });
    const done = Conn.imported();
    const journal = trades("live");
    const name = Conn.SOURCES[c.src].name;
    const items = list.map((t) => {
      const key = `${c.id}:${t.id}`;
      const dup = Conn.isDuplicate(t, journal), seen = !dup && done.has(key);
      return { key, row: Conn.toRow(t, c.label || name, S.lists.pair), dup, seen, pick: !dup && !seen };
    });
    CX.preview = { conn: id, items, at: Date.now() };
    CX.msg = "";
  } catch (e) {
    CX.msg = "";
    toast(e.message || String(e), true);
  } finally {
    setBusy(false);
    renderConnect();
  }
}

async function cxAdd() {
  const pv = CX.preview;
  const picked = pv.items.filter((x) => x.pick && !x.dup);
  setBusy(true);
  try {
    const last = trades("live").reduce((m, t) => Math.max(m, t.n), 1);
    if (picked.length) await api.appendRows(api.BOOKS.live, picked.map((x) => x.row), book("live").sheetId, last);
    Conn.markImported(pv.items.filter((x) => !x.dup).map((x) => x.key)); // добавленные и снятые: потом не предлагаются сами
    const c = Conn.list().find((x) => x.id === pv.conn);
    if (c) { c.last = pv.at; Conn.upsert(c); }
    CX.preview = null;
    toast(tr("Добавлено сделок: {n}", { n: picked.length }));
    await reload();
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

function connectClick(b) {
  const d = b.dataset, a = d.act;
  if (a === "cx-back") { setView("journal"); return true; }
  if (d.cxsrc) { CX.adding = CX.adding === d.cxsrc ? "" : d.cxsrc; CX.form = {}; renderConnect(); return true; }
  if (a === "cx-cancel") { CX.adding = ""; CX.form = {}; renderConnect(); return true; }
  if (a === "cx-save") { cxSave(); return true; }
  if (d.cxdel) { if (confirm(tr("Удалить подключение? Ключи сотрутся с этого устройства."))) { Conn.remove(d.cxdel); renderConnect(); } return true; }
  if (d.cxrun) { cxRun(d.cxrun); return true; }
  if (a === "cx-add") { cxAdd(); return true; }
  if (a === "cx-report") { cxReportPreview(); return true; }
  if (a === "cx-close") { CX.preview = null; renderConnect(); return true; }
  return false;
}

// ---------------- новости (экономический календарь Forex Factory) ----------------
const IMP_RU = { High: "Высокое", Medium: "Среднее", Low: "Низкое", Holiday: "Выходной" };
const RANGE_RU = { today: "Сегодня", tomorrow: "Завтра", week: "Неделя", next: "24 часа", past: "Прошедшие" };
let newsSaveT = 0, newsTick = 0, newsErr = "";

const hm = (ms) => new Date(ms).toLocaleTimeString(LANG === "en" ? "en-GB" : "ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayTitle = (ms) => new Date(ms).toLocaleDateString(LANG === "en" ? "en-GB" : "ru-RU", { weekday: "long", day: "numeric", month: "long" });
const utcLabel = () => { const o = -new Date().getTimezoneOffset(); return "UTC" + (o >= 0 ? "+" : "−") + Math.floor(Math.abs(o) / 60) + (Math.abs(o) % 60 ? ":" + String(Math.abs(o) % 60).padStart(2, "0") : ""); };
const left = (ms) => News.fmtLeft(ms, LANG === "en");

function newsLive() {
  const now = Date.now(), dz = News.danger(now), f = News.filter();
  if (!News.data().events.length) return "";
  const ev = (e) => `<b>${esc(e.cur)}</b> · ${esc(e.title)}`;
  if (dz.active.length) {
    const e = dz.active[0], before = e.ms > now;
    return `<div class="nw-live danger"><div class="nw-live-ico">⚠</div><div>
      <div class="nw-live-h">${before ? tr("Через {t} — сильная новость. Сделки не открывать", { t: `<span data-cd="${e.ms}">${left(e.ms - now)}</span>` })
        : tr("Сильная новость вышла {t} назад. Подожди до {h}", { t: `<span data-cd="${e.ms}">${left(now - e.ms)}</span>`, h: hm(e.ms + dz.window) })}</div>
      <div>${dz.active.map(ev).join("<br>")} · ${hm(e.ms)}</div>
      <div class="muted">${tr("Опасное окно: {n} мин до и после сильной новости. Открытые позиции — закрыть или в безубыток.", { n: f.window })}</div></div></div>`;
  }
  if (dz.next) {
    const e = dz.next, soon = e.ms - now < 2 * 3600e3;
    return `<div class="nw-live ${soon ? "soon" : "calm"}"><div class="nw-live-ico">${soon ? "⏱" : "✓"}</div><div>
      <div class="nw-live-h">${tr("Следующая сильная новость через {t}", { t: `<span data-cd="${e.ms}">${left(e.ms - now)}</span>` })}</div>
      <div>${ev(e)} · ${esc(dayTitle(e.ms))}, ${hm(e.ms)}</div>
      <div class="muted">${tr("Опасное окно начнётся в {h}", { h: hm(e.ms - dz.window) })}</div></div></div>`;
  }
  return `<div class="nw-live calm"><div class="nw-live-ico">✓</div><div><div class="nw-live-h">${tr("Сильных новостей по выбранным валютам до конца недели нет")}</div></div></div>`;
}

function renderNews() {
  const f = News.filter(), D = News.data(), now = Date.now();
  const mine = News.currenciesOf(S.lists.pair);
  const list = News.visible();
  const dz = News.danger(now);
  const hot = new Set(dz.active.map((e) => e.id));
  const nextId = list.find((e) => e.ms > now)?.id;
  let lastDay = "";
  const rows = list.map((e) => {
    const day = new Date(e.ms).toDateString();
    const head = day !== lastDay ? `<div class="nw-day">${esc(dayTitle(e.ms))}</div>` : "";
    lastDay = day;
    const past = e.exact && e.ms + 60e3 < now;
    const cls = ["nw-row", "imp-" + e.impact.toLowerCase(), past ? "past" : "", hot.has(e.id) ? "hot" : "", e.id === nextId ? "next" : ""].join(" ");
    const status = hot.has(e.id) ? `<span class="nw-badge hot">${tr("опасно")}</span>`
      : e.id === nextId ? `<span class="nw-badge next">${tr("через {t}", { t: `<span data-cd="${e.ms}">${left(e.ms - now)}</span>` })}</span>`
      : past ? `<a class="nw-badge done" href="${esc(e.url)}" target="_blank" rel="noopener" title="${tr("Фактическое значение — на сайте Forex Factory")}">${tr("вышла")} ↗</a>` : "";
    return head + `<div class="${cls}">
      <div class="nw-time">${e.exact ? hm(e.ms) : esc(e.label || tr("весь день"))}</div>
      <div class="nw-cur">${esc(e.cur)}</div>
      <div class="nw-imp" title="${tr(IMP_RU[e.impact] || e.impact)} · ${tr(News.TYPE_RU[News.typeOf(e)])}"><span class="imp-dot"></span><span class="imp-txt">${tr(IMP_RU[e.impact] || e.impact)}</span></div>
      <div class="nw-title"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> ${status}</div>
      <div class="nw-num"><span class="nw-k">${tr("Прогноз")}</span>${esc(e.forecast || "—")}</div>
      <div class="nw-num"><span class="nw-k">${tr("Пред.")}</span>${esc(e.previous || "—")}</div>
    </div>`;
  }).join("");
  const chip = (on, attr, label, cls = "") => `<button type="button" class="chip ${cls} ${on ? "on" : ""}" ${attr}>${label}</button>`;
  const fetched = D.fetched ? new Date(D.fetched) : null;
  $("#view").innerHTML = `<div class="nw-page">
    <div class="nw-head"><h2>${tr("Новости")}</h2><span class="muted">${tr("Экономический календарь Forex Factory · время {tz}", { tz: utcLabel() })}</span></div>
    <div id="nwLive">${newsLive()}</div>
    ${newsErr ? `<div class="panel cx-msg">${esc(newsErr)}</div>` : ""}
    <section class="panel nw-filters">
      <div class="nw-frow"><span class="nw-flabel">${tr("Влияние")}</span>
        ${News.IMPACTS.map((i) => chip(f.impact.includes(i), `data-nwimp="${i}"`, `<span class="imp-dot"></span>${tr(IMP_RU[i])}`, "imp-chip imp-" + i.toLowerCase())).join("")}</div>
      <div class="nw-frow"><span class="nw-flabel">${tr("Валюты")}</span>
        ${News.CURRENCIES.map((c) => chip(f.cur.includes(c), `data-nwcur="${c}"`, c === "All" ? tr("Все страны") : c)).join("")}
        <span class="nw-fsep"></span>
        ${mine.length ? chip(false, 'data-nwmine="1"', tr("Мои активы: {c}", { c: mine.join(", ") }), "accent") : ""}
        ${chip(false, 'data-nwall="1"', tr("Все"))}</div>
      <div class="nw-frow"><span class="nw-flabel">${tr("Тип")}</span>
        ${News.TYPES.map((k) => chip((f.types || News.TYPES).includes(k), `data-nwtype="${k}"`, tr(News.TYPE_RU[k]))).join("")}
        <span class="nw-fsep"></span>${chip(false, 'data-nwtypeall="1"', tr("Все"))}</div>
      <div class="nw-frow"><span class="nw-flabel">${tr("Период")}</span>
        <div class="seg">${News.RANGES.map((r) => `<button type="button" data-nwrange="${r}" class="${f.range === r ? "on" : ""}">${tr(RANGE_RU[r])}</button>`).join("")}</div>
        <input type="search" class="nw-q" data-nwq="1" placeholder="${tr("Поиск: CPI, NFP, ставка…")}" value="${esc(f.q)}"></div>
      <div class="nw-frow nw-set"><label>${tr("Опасное окно")} <input type="number" min="0" max="120" step="5" data-nwwin="1" value="${esc(f.window)}"> ${tr("мин до и после сильной новости")}</label>
        ${"Notification" in window ? `<label class="nw-check"><input type="checkbox" data-nwnotify="1" ${f.notify ? "checked" : ""}> ${tr("Напоминать перед сильной новостью")}</label>` : ""}</div>
    </section>
    <section class="panel nw-list">
      <div class="nw-row nw-thead"><div>${tr("Время")}</div><div>${tr("Валюта")}</div><div>${tr("Влияние")}</div><div>${tr("Событие")}</div><div>${tr("Прогноз")}</div><div>${tr("Пред.")}</div></div>
      ${rows || `<div class="empty">${D.events.length ? tr("По этому фильтру новостей нет") : tr("Календарь загружается…")}</div>`}
    </section>
    <div class="hint nw-foot">${tr("Источник: Forex Factory. Выгрузка обновляется раз в час (так требует Forex Factory){t}. Фактические значения в выгрузке нет — после выхода новости нажми «вышла ↗», откроется событие на сайте.", { t: fetched ? tr(", последняя — в {h}", { h: hm(fetched.getTime()) }) : "" })}</div>
  </div>`;
}

// Фильтр: сразу на устройстве, в таблицу — через секунду после последнего изменения (один на все устройства).
function newsSet(patch, rerender = true) {
  const f = News.setFilter({ ...News.filter(), ...patch });
  clearTimeout(newsSaveT);
  newsSaveT = setTimeout(() => api.saveNewsFilter(JSON.stringify(f)).catch(() => {}), 1200);
  newsBar();
  if (rerender && S.view === "news") renderNews();
}

function newsClick(b) {
  const d = b.dataset, f = News.filter();
  const tog = (arr, x) => (arr.includes(x) ? arr.filter((y) => y !== x) : [...arr, x]);
  if (d.nwimp) { newsSet({ impact: tog(f.impact, d.nwimp) }); return true; }
  if (d.nwcur) { newsSet({ cur: tog(f.cur, d.nwcur) }); return true; }
  if (d.nwmine) { newsSet({ cur: News.currenciesOf(S.lists.pair) }); return true; }
  if (d.nwall) { newsSet({ cur: News.CURRENCIES.slice() }); return true; }
  if (d.nwrange) { newsSet({ range: d.nwrange }); return true; }
  if (d.nwtype) { const t = tog(f.types || News.TYPES, d.nwtype); newsSet({ types: t.length === News.TYPES.length ? null : t }); return true; }
  if (d.nwtypeall) { newsSet({ types: null }); return true; }
  return false;
}

// Полоса предупреждения на всех вкладках и красная точка у вкладки «Новости».
function newsBar() {
  const bar = $("#newsBar"), tab = $('.tab[data-view="news"]');
  if (!bar) return;
  const now = Date.now(), dz = News.danger(now);
  tab?.classList.toggle("hot", dz.active.length > 0);
  if (!dz.active.length || S.view === "news") { bar.hidden = true; return; }
  const e = dz.active[0];
  bar.hidden = false;
  bar.innerHTML = `⚠ <b>${esc(e.cur)}</b> ${esc(e.title)} — ${e.ms > now ? tr("через {t}", { t: left(e.ms - now) }) : tr("вышла {t} назад", { t: left(now - e.ms) })}. ${tr("Опасно торговать")}`;
}

// Раз в секунду — отсчёт и полоса; раз в 5 минут — свежий календарь; напоминания перед сильными новостями.
function newsStart() {
  if (newsTick) return;
  const refresh = () => News.load().then(() => { newsErr = ""; if (S.view === "news") renderNews(); newsBar(); })
    .catch(() => { newsErr = tr("Не удалось загрузить календарь — проверь интернет"); if (S.view === "news") renderNews(); });
  refresh();
  setInterval(refresh, 5 * 60e3);
  newsTick = setInterval(() => {
    const now = Date.now();
    $$("[data-cd]").forEach((el) => (el.textContent = left(Math.abs(+el.dataset.cd - now))));
    if (S.view === "news") { const live = $("#nwLive"); const html = newsLive(); if (live && live.dataset.h !== html) { live.innerHTML = html; live.dataset.h = html; } }
    newsBar();
    newsNotify(now);
  }, 1000);
}

function newsNotify(now) {
  const f = News.filter();
  if (!f.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  for (const e of News.danger(now).active) {
    const k = "tj.nw." + e.id;
    if (e.ms < now || sessionStorage.getItem(k)) continue;
    sessionStorage.setItem(k, "1");
    try { new Notification(`⚠ ${e.cur}: ${e.title}`, { body: tr("Через {t}. Опасно торговать", { t: left(e.ms - now) }), icon: "icons/tb-icon-192.png", tag: e.id }); } catch { /* iOS без push */ }
  }
}

// ---------------- калькулятор лота ----------------
const LT_DEFAULT = { balance: "", acc: "USD", riskMode: "pct", risk: 1, sym: "", entry: "", sl: "", slPips: "", slMode: "price", tp: "", step: 0.01, min: 0.01, overrides: {} };
let LT = (() => { try { return { ...LT_DEFAULT, ...JSON.parse(lsGet("tj.lot") || "{}") }; } catch { return { ...LT_DEFAULT }; } })();
let ltSaveT = 0, ltFx = null;
// В таблицу — только постоянное (баланс, риск, свои спецификации); цены сделки живут на устройстве.
const LT_KEEP = ["balance", "acc", "riskMode", "risk", "sym", "slMode", "step", "min", "overrides"];

function ltLoad(json) {
  try { const d = JSON.parse(json || "null"); if (d) LT = { ...LT, ...d }; } catch { /* испорчено — оставить */ }
}
function ltSet(patch, full = false) {
  LT = { ...LT, ...patch };
  lsSet("tj.lot", JSON.stringify(LT));
  if (Object.keys(patch).some((k) => LT_KEEP.includes(k))) {
    clearTimeout(ltSaveT);
    const keep = Object.fromEntries(LT_KEEP.map((k) => [k, LT[k]]));
    ltSaveT = setTimeout(() => api.saveLotSettings(JSON.stringify(keep)).catch(() => {}), 1500);
  }
  if (full) renderLot(); else ltResult();
}

// «пипс» для валют и металлов, «пункт» для индексов и остального; с окончанием по числу
function ltUnit(kind, n = 1) {
  const pip = kind === "fx" || kind === "metal";
  if (LANG === "en") return pip ? (n === 1 ? "pip" : "pips") : (n === 1 ? "point" : "points");
  const f = pip ? ["пипс", "пипса", "пипсов"] : ["пункт", "пункта", "пунктов"];
  const k = Math.abs(n) % 100, d = k % 10;
  if (!Number.isInteger(n)) return f[1];
  return k > 10 && k < 20 ? f[2] : d === 1 ? f[0] : d >= 2 && d <= 4 ? f[1] : f[2];
}
const ltSyms = () => [...new Set([...S.lists.pair.map(Lot.norm), ...Lot.COMMON])].filter(Boolean);
const money = (x) => (Number.isFinite(x) ? x.toLocaleString(LANG === "en" ? "en-US" : "ru-RU", { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : "—");
const cur = () => ({ USD: "$", EUR: "€", GBP: "£" })[LT.acc] || LT.acc + " ";

function renderLot() {
  if (!LT.sym && !LT.otherMode) LT.sym = ltSyms()[0] || "EURUSD";
  const syms = ltSyms();
  const other = LT.otherMode || !syms.includes(Lot.norm(LT.sym));
  const sp = Lot.spec(LT.sym, LT.overrides);
  const unitName = ltUnit(sp?.kind);
  const seg = (attr, val, opts) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" ${attr}="${v}" class="${val === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const num = (k, ph, extra = "") => `<input type="text" inputmode="decimal" data-lt="${k}" value="${esc(LT[k] ?? "")}" placeholder="${esc(ph)}" ${extra}>`;
  $("#view").innerHTML = `<div class="lt-page">
    <div class="nw-head"><h2>${tr("Калькулятор лота")}</h2><span class="muted">${tr("сколько лотов открыть, чтобы при стопе потерять ровно свой риск")}</span></div>
    <div class="lt-grid">
      <div class="lt-inputs">
        <section class="panel lt-card"><h3>${tr("Счёт и риск")}</h3>
          <div class="lt-row2">
            <label>${tr("Баланс счёта")}${num("balance", "100000")}</label>
            <label>${tr("Валюта счёта")}<select data-ltsel="acc">${["USD", "EUR", "GBP"].map((c) => `<option ${LT.acc === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
          </div>
          <div class="lt-label">${tr("Риск на сделку")}</div>
          <div class="lt-risk">${seg("data-ltrm", LT.riskMode, [["pct", "%"], ["money", LT.acc]])}${num("risk", LT.riskMode === "pct" ? "0.5" : "500")}</div>
          ${LT.riskMode === "pct" ? `<div class="chips lt-quick">${[0.25, 0.5, 1, 2].map((v) => `<button type="button" class="chip ${+LT.risk === v ? "on" : ""}" data-ltrisk="${v}">${String(v).replace(".", LANG === "en" ? "." : ",")}%</button>`).join("")}</div>` : ""}
        </section>
        <section class="panel lt-card"><h3>${tr("Сделка")}</h3>
          <label>${tr("Инструмент")}<select data-ltsel="symsel">${syms.map((s) => `<option ${Lot.norm(LT.sym) === s ? "selected" : ""}>${s}</option>`).join("")}<option value="__other" ${other ? "selected" : ""}>${tr("Другой…")}</option></select></label>
          ${other ? `<label>${tr("Символ, как в терминале")}<input type="text" data-lt="sym" data-full="1" value="${esc(LT.sym)}" placeholder="USDMXN, NAS100…" autocapitalize="characters"></label>` : ""}
          <details class="lt-spec" ${!sp || sp.custom ? "open" : ""}><summary>${sp ? tr("Спецификация: контракт {c} · {u} {p} · котировка {q}", { c: sp.contract.toLocaleString("ru-RU"), u: unitName, p: sp.pip, q: sp.quote }) : tr("Спецификация не известна — заполни")}${sp?.custom ? ` <span class="nw-badge next">${tr("своя")}</span>` : ""}</summary>
            <div class="hint">${tr("Проверь у своего брокера / проп-компании: терминал → «Обзор рынка» → правый клик по символу → «Спецификация» → «Размер контракта». У индексов и нефти он бывает разным.")}</div>
            <div class="lt-row3">
              <label>${tr("Размер контракта")}<input type="text" inputmode="decimal" data-lts="contract" value="${esc(sp?.contract ?? "")}"></label>
              <label>${tr("Размер пипса / пункта")}<input type="text" inputmode="decimal" data-lts="pip" value="${esc(sp?.pip ?? "")}"></label>
              <label>${tr("Валюта котировки")}<input type="text" data-lts="quote" value="${esc(sp?.quote ?? "")}" placeholder="USD" autocapitalize="characters"></label>
            </div>
            ${sp?.custom && sp.preset ? `<button type="button" class="link-btn" data-act="lt-specreset">${tr("Вернуть стандартную")}</button>` : ""}
          </details>
          <div class="lt-row2">
            <label>${tr("Цена входа")}${num("entry", "1.08500")}</label>
            <label>${tr("Take Profit (не обязательно)")}${num("tp", "")}</label>
          </div>
          <div class="lt-label">${tr("Stop Loss")}</div>
          <div class="lt-risk">${seg("data-ltsm", LT.slMode, [["price", tr("Цена")], ["pips", sp?.kind === "fx" || sp?.kind === "metal" ? tr("Пипсы") : tr("Пункты")]])}
            ${LT.slMode === "price" ? num("sl", "1.08300") : num("slPips", "20")}</div>
          <details class="lt-spec"><summary>${tr("Шаг и минимальный лот: {s} / {m}", { s: LT.step, m: LT.min })}</summary>
            <div class="lt-row2"><label>${tr("Шаг лота")}${num("step", "0.01")}</label><label>${tr("Минимальный лот")}${num("min", "0.01")}</label></div></details>
        </section>
      </div>
      <section class="panel lt-res" id="ltRes"></section>
    </div>
  </div>`;
  ltResult();
  if (!ltFx || ltFx.acc !== LT.acc) Lot.rates(LT.acc).then((r) => { ltFx = r; ltResult(); });
}

function ltResult() {
  const box = $("#ltRes");
  if (!box) return;
  const r = Lot.calc(LT, ltFx);
  const sp = r.spec;
  const unit = ltUnit(sp?.kind);
  const need = [];
  if (r.errors.includes("spec")) need.push(tr("спецификацию инструмента"));
  if (r.errors.includes("risk")) need.push(LT.riskMode === "pct" ? tr("баланс и риск") : tr("риск"));
  if (r.errors.includes("sl")) need.push(LT.slMode === "price" ? tr("цену входа и стоп") : tr("стоп в пипсах"));
  if (r.errors.includes("fx")) need.push(ltFx ? tr("курс {q} — укажи цену входа или проверь валюту котировки", { q: sp?.quote }) : tr("курс валют (загружается…)"));
  if (need.length) {
    box.innerHTML = `<div class="lt-big muted">—</div><div class="lt-need">${tr("Чтобы посчитать, укажи: {x}", { x: need.join(", ") })}</div>`;
    return;
  }
  const pct = r.actualPct;
  const lvl = pct > 2 ? "bad" : pct > 1 ? "warn" : "ok";
  const row = (k, v, cls = "") => `<div class="lt-kv"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  box.innerHTML = `
    <div class="lt-cap">${tr("Лот")}${r.dir ? ` · <span class="${r.dir > 0 ? "long" : "short"}">${r.dir > 0 ? "Long" : "Short"}</span>` : ""}</div>
    <div class="lt-big ${r.belowMin ? "neg" : ""}">${r.lots.toFixed(r.dec)}</div>
    <button type="button" class="btn ghost sm lt-copy" data-ltcopy="${r.lots.toFixed(r.dec)}">${tr("Скопировать")}</button>
    ${r.belowMin ? `<div class="lt-alert bad">${tr("Меньше минимального лота {m}: с таким стопом риск не уложится. Сократи стоп или подними риск.", { m: r.min })}</div>` : ""}
    <div class="lt-kvs">
      ${row(tr("Риск при стопе"), `${cur()}${money(r.actual)} · ${fmtNum(pct, 2)}%`, lvl === "ok" ? "" : "neg")}
      ${row(tr("Стоп"), `${fmtNum(Math.round(r.pips * 10) / 10, Number.isInteger(Math.round(r.pips * 10) / 10) ? 0 : 1)} ${ltUnit(sp.kind, Math.round(r.pips * 10) / 10)}`)}
      ${row(tr("1 {u} на 1 лот", { u: unit }), `${cur()}${money(r.pipValue)}`)}
      ${row(tr("1 {u} на этот лот", { u: unit }), `${cur()}${money(r.pipValue * r.lots)}`)}
      ${r.tp ? (r.tp.ok ? row(tr("RR / прибыль на тейке"), `1:${fmtNum(r.tp.rr, 2)} · ${cur()}${money(r.tp.profit)}`, "pos") : row("Take Profit", tr("с другой стороны от входа"), "neg")) : ""}
    </div>
    ${lvl !== "ok" ? `<div class="lt-alert ${lvl}">${lvl === "bad" ? tr("Риск больше 2% на сделку — так счёт проп-компании сливается за несколько стопов.") : tr("Риск больше 1% на сделку. Проверь дневной лимит убытка своей проп-компании.")}</div>` : ""}
    ${r.raw - r.lots > 1e-9 ? `<div class="hint">${tr("Лот округлён вниз до шага {s}, чтобы не превысить риск (точно было бы {x}).", { s: LT.step, x: fmtNum(r.raw, 3) })}</div>` : ""}
    ${r.conv.how === "fx" ? `<div class="hint">${tr("Курс {q}→{a}: {k} (ECB, {d}).", { q: sp.quote, a: LT.acc, k: fmtNum(r.conv.k, 5), d: esc(ltFx?.date || "") })}</div>` : ""}
    ${r.conv.how === "price" ? `<div class="hint">${tr("Стоимость пункта посчитана по цене входа {p}.", { p: LT.entry })}</div>` : ""}
    ${sp.custom ? `<div class="hint">${tr("Используется твоя спецификация символа.")}</div>` : ""}`;
}

function lotClick(b) {
  const d = b.dataset;
  if (d.ltrm) { ltSet({ riskMode: d.ltrm }, true); return true; }
  if (d.ltsm) { ltSet({ slMode: d.ltsm }, true); return true; }
  if (d.ltrisk) { ltSet({ riskMode: "pct", risk: +d.ltrisk }, true); return true; }
  if (d.act === "lt-specreset") { const o = { ...LT.overrides }; delete o[Lot.norm(LT.sym)]; ltSet({ overrides: o }, true); return true; }
  if (d.ltcopy) { navigator.clipboard?.writeText(d.ltcopy).then(() => toast(tr("Скопировано: {x}", { x: d.ltcopy })), () => {}); return true; }
  return false;
}

// Ввод: числа принимают и запятую.
function lotInput(t) {
  const v = t.value.replace(",", ".").trim();
  if (t.dataset.lt) { ltSet({ [t.dataset.lt]: t.dataset.lt === "sym" ? v.toUpperCase() : v }); if (t.dataset.full) ltResultSpecSoon(); return true; }
  if (t.dataset.lts) {
    const s = Lot.norm(LT.sym), cur0 = Lot.spec(LT.sym, LT.overrides) || {};
    const o = { contract: cur0.contract, pip: cur0.pip, quote: cur0.quote, ...LT.overrides[s] };
    o[t.dataset.lts] = t.dataset.lts === "quote" ? v.toUpperCase() : +v;
    ltSet({ overrides: { ...LT.overrides, [s]: o } });
    return true;
  }
  return false;
}
let ltSpecT = 0;
function ltResultSpecSoon() { clearTimeout(ltSpecT); ltSpecT = setTimeout(() => { const a = document.activeElement; const pos = a?.selectionStart; renderLot(); const el = $('[data-lt="sym"]'); if (el && a?.dataset.lt === "sym") { el.focus(); el.setSelectionRange(pos, pos); } }, 600); }

function lotChange(t) {
  if (t.dataset.ltsel === "acc") { ltSet({ acc: t.value }, true); return true; }
  if (t.dataset.ltsel === "symsel") { ltSet(t.value === "__other" ? { sym: "", otherMode: true, entry: "", sl: "", tp: "" } : { sym: t.value, otherMode: false, entry: "", sl: "", tp: "" }, true); return true; }
  return false;
}

function renderStrategyEditor() {
  const preview = S.stPreview;
  const r = preview ? St.render(S.stEdit) : null;
  $("#view").innerHTML = `<div class="st-page">
    <header class="panel st-head">
      <img src="icons/tb-icon-192.png" alt="" class="st-logo">
      <div class="st-title"><h1>${tr("Торговая стратегия")}</h1><div class="muted">${tr("Правка")}</div></div>
      <span class="grow"></span>
      <button type="button" class="btn ghost sm" data-act="st-cancel">${tr("Отмена")}</button>
      <button type="button" class="btn primary sm" data-act="st-save">${tr("Сохранить")}</button>
    </header>
    <div class="panel st-editor">
      <div class="st-tools">
        <div class="seg st-mode">
          <button type="button" data-act="st-write" class="${preview ? "" : "on"}">${tr("Текст")}</button>
          <button type="button" data-act="st-preview" class="${preview ? "on" : ""}">${tr("Просмотр")}</button>
        </div>
        ${preview ? "" : `
        <button type="button" class="btn ghost sm" data-stins="h1">${tr("Раздел")}</button>
        <button type="button" class="btn ghost sm" data-stins="h2">${tr("Подраздел")}</button>
        <button type="button" class="btn ghost sm" data-stins="li">${tr("Пункт")}</button>
        <button type="button" class="btn ghost sm" data-stins="bold"><b>B</b></button>
        <button type="button" class="btn ghost sm" data-stins="callout">${tr("Блок-подсказка")}</button>
        <button type="button" class="btn ghost sm" data-stins="details">${tr("Сворачиваемый блок")}</button>
        <label class="btn ghost sm file">${tr("Картинка")}<input type="file" accept="image/*" multiple data-stimg="1" hidden></label>`}
      </div>
      ${preview ? `<article class="st-body st-preview">${r.html}</article>`
        : `<textarea class="st-text" data-stmd="1" spellcheck="true">${esc(S.stEdit)}</textarea>
      <details class="st-help"><summary>${tr("Как оформлять")}</summary>
        <div class="muted">${tr("<code># Раздел</code>, <code>## Подраздел</code>; <code>- пункт</code>, <code>1. пункт</code>, <code>- [ ] галочка</code>; вложенность — Tab; <code>**жирный**</code>; блок-подсказка: <code>:::callout ⚠️</code> … <code>:::</code>; сворачиваемый блок: <code>:::details Открыть</code> … <code>:::</code>; <code>---</code> — разделитель.")}</div></details>`}
    </div>
  </div>`;
  if (preview) hydrateThumbs($("#view"));
}

function stInsert(kind) {
  const ta = $(".st-text");
  if (!ta) return;
  const snippets = {
    h1: `\n# ${tr("Новый раздел")}\n`,
    h2: `\n## ${tr("Подраздел")}\n`,
    li: "\n- ",
    bold: null,
    callout: `\n:::callout ⚠️\n**${tr("ВАЖНО")}**\n- \n:::\n`,
    details: `\n:::details ${tr("Открыть")}\n- \n:::\n`,
  };
  const a = ta.selectionStart, b = ta.selectionEnd, v = ta.value;
  let ins = snippets[kind];
  if (kind === "bold") ins = `**${v.slice(a, b) || tr("текст")}**`;
  ta.value = v.slice(0, a) + ins + v.slice(b);
  ta.selectionStart = ta.selectionEnd = a + ins.length;
  ta.focus();
  S.stEdit = ta.value;
}

// Картинки в Drive пользователя: вставить в текст (правка) или подставить вместо img:имя (загрузка недостающих).
async function stUpload(files, mode) {
  if (!auth.hasDrive()) { toast(tr("Нет доступа к Google Drive — при входе отметь доступ к файлам"), true); return; }
  setBusy(true);
  let done = 0, skipped = 0;
  try {
    if (mode === "insert") {
      const urls = [];
      for (const f of files) { urls.push(await api.uploadImage(f, `strategy_${f.name}`)); done++; }
      const ta = $(".st-text");
      const ins = "\n" + urls.map((u) => `![](${u})`).join("\n") + "\n";
      const pos = ta ? ta.selectionStart : S.stEdit.length;
      S.stEdit = S.stEdit.slice(0, pos) + ins + S.stEdit.slice(pos);
      renderStrategy();
    } else {
      let md = S.strategy;
      const missing = St.render(md).missing.map((x) => x.toLowerCase());
      for (const f of files) {
        if (!missing.includes(f.name.toLowerCase())) { skipped++; continue; }
        const url = await api.uploadImage(f, `strategy_${f.name}`);
        md = St.replaceImage(md, f.name, url);
        done++;
      }
      if (done) { await api.saveStrategy(md, S.strategyData); S.strategy = md; }
      renderStrategy();
    }
    toast(tr("Загружено картинок: {n}", { n: done }) + (skipped ? " · " + tr("не подошло по имени: {n}", { n: skipped }) : ""));
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

async function stSave() {
  setBusy(true);
  try {
    await api.saveStrategy(S.stEdit);
    S.strategy = S.stEdit; S.strategyData = "";
    S.stEdit = null; S.stPreview = false;
    renderStrategy();
    window.scrollTo(0, 0);
    toast(tr("Стратегия сохранена"));
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

function strategyClick(b) {
  if (builderClick(b)) return true;
  const a = b.dataset.act;
  if (a === "st-build") { openBuilder(SB.starter(LANG)); return true; }
  if (a === "st-totext") {
    if (!confirm(tr("В текстовом режиме конструктор отключится: страница будет правиться только текстом (Markdown). Перейти?"))) return true;
    S.stEdit = SB.toMarkdown(S.stB); S.stB = null; S.stPreview = false; renderStrategy(); return true;
  }
  if (S.stB && a === "st-cancel") {
    if (JSON.stringify(S.stB) !== S.stBOrig && !confirm(tr("Закрыть без сохранения?"))) return true;
    S.stB = null; S.stPreview = false; renderStrategy(); return true;
  }
  if (S.stB && a === "st-save") { stbSave(); return true; }
  if (a === "st-template") { S.stEdit = St.TEMPLATE[LANG] || St.TEMPLATE.ru; S.stPreview = false; renderStrategy(); return true; }
  if (a === "st-blank") { S.stEdit = ""; S.stPreview = false; renderStrategy(); return true; }
  if (a === "st-edit" && SB.parse(S.strategyData)) { openBuilder(SB.parse(S.strategyData)); return true; }
  if (a === "st-edit") { S.stEdit = S.strategy || ""; S.stPreview = false; renderStrategy(); window.scrollTo(0, 0); return true; }
  if (a === "st-cancel") {
    if (S.stEdit !== (S.strategy || "") && !confirm(tr("Закрыть без сохранения?"))) return true;
    S.stEdit = null; renderStrategy(); return true;
  }
  if (a === "st-save") { stSave(); return true; }
  if (a === "st-write") { S.stPreview = false; renderStrategy(); return true; }
  if (a === "st-preview") { S.stPreview = true; renderStrategy(); return true; }
  if (a === "st-expand") {
    const all = $$(".st-details");
    const open = all.some((d) => !d.open);
    all.forEach((d) => (d.open = open));
    b.textContent = open ? tr("Свернуть всё") : tr("Развернуть всё");
    return true;
  }
  if (b.dataset.stins) { stInsert(b.dataset.stins); return true; }
  return false;
}

// ---------- вкладка «Чек-лист»: пройти перед торговлей, каждый сохраняется в лист Checklists ----------

const newRun = () => ({ pair: "", setup: "", yes: [], no: [], note: "" });
function loadRun() {
  try { const r = JSON.parse(lsGet("tj.clrun") || "null"); if (r && Array.isArray(r.yes)) return r; } catch { /* битый черновик */ }
  return newRun();
}
const saveRun = () => lsSet("tj.clrun", JSON.stringify(S.run));

function runVerdict(c) {
  const st = CL.status(c);
  const req = CL.required(c);
  const answered = req.filter((id) => c.yes.includes(id) || c.no.includes(id)).length;
  return {
    st,
    text: { ok: "Можно торговать", warn: "Можно торговать", broken: "Сделки нет", partial: "Пройден не до конца", none: "Не начат" }[st], // хранится в таблице по-русски
    html: {
      ok: `<span class="chk-v ok">${tr("✓ Можно торговать")}</span>`,
      warn: `<span class="chk-v warn">${tr("✓ Можно торговать · «нет»: {n} из {l} допустимых", { n: c.no.length, l: CL.limit() })}</span>`,
      broken: `<span class="chk-v bad">${tr("✗ Сделки нет — «нет»: {n} (предел {l})", { n: c.no.length, l: CL.limit() })}</span>`,
      partial: `<span class="chk-v part">${tr("Отмечено {a} из {r}", { a: answered, r: req.length })}${c.no.length ? tr(" · «нет»: {n} из {l}", { n: c.no.length, l: CL.limit() }) : ""}</span>`,
      none: `<span class="chk-v">${tr("Отметь каждый пункт: ✓ выполнено, ✗ нет")}</span>`,
    }[st],
  };
}

function renderChecklist() {
  if (S.clDraft) { $("#view").innerHTML = `<div class="cl-page">${checklistEditor()}</div>`; return; }
  const c = S.run;
  const d = CL.current();
  const v = runVerdict(c);
  const item = ([id, text]) => {
    const a = c.yes.includes(id) ? "yes" : c.no.includes(id) ? "no" : "";
    return `<div class="cl-item ${a}"><div class="cl-text">${esc(text)}</div>
      <div class="cl-btns"><button type="button" class="cl-yes ${a === "yes" ? "on" : ""}" data-rcl="${esc(id)}" data-v="yes" aria-label="${tr("Да")}">✓</button>
      <button type="button" class="cl-no ${a === "no" ? "on" : ""}" data-rcl="${esc(id)}" data-v="no" aria-label="${tr("Нет")}">✗</button></div></div>`;
  };
  const setup = CL.setupById(c.setup);
  $("#view").innerHTML = `<div class="cl-page">
    <section class="panel checklist ${v.st}">
      <div class="clr-head"><h3><img src="icons/tb-checklist.png" alt="" class="cl-logo">${tr("Новый чек-лист")}</h3>${v.html}</div>
      <div class="hint cl-rule">${tr("Сделки нет при {n} «нет» и больше", { n: CL.limit() })} · <button type="button" class="link-btn" data-act="cl-edit">${tr("изменить")}</button></div>
      ${d.note ? `<div class="hint cl-note">${esc(d.note)}</div>` : ""}
      <div class="cl-h">${tr("Актив")}</div>
      <div class="chips">${S.lists.pair.map((p) => `<button type="button" class="chip ${c.pair === p ? "on" : ""}" data-rpair="${esc(p)}">${esc(p)}</button>`).join("")}
        <button type="button" class="chip add" data-act="pair-add" title="${tr("Пара добавится везде: журнал, бэктест, чек-лист")}">${tr("+ пара")}</button></div>
      <div class="cl-h">${tr("Сетап")} <span class="muted">${tr("— не обязательно; выбранный добавит свои пункты")}</span></div>
      <div class="chips">${d.setups.map((s) => `<button type="button" class="chip ${c.setup === s.id ? "on" : ""}" data-rsetup="${esc(s.id)}">${esc(s.name)}</button>`).join("")}
        <button type="button" class="chip add" data-act="setup-add">${tr("+ сетап")}</button>
        ${d.setups.length ? `<button type="button" class="link-btn" data-act="setup-edit">${tr("изменить сетапы")}</button>` : ""}</div>
      ${d.general.map((g) => `<div class="cl-h">${esc(g.title)}</div>${g.items.map(item).join("")}`).join("")}
      ${setup ? `<div class="cl-h">${esc(setup.name)}${setup.entry ? ` <span class="muted">— ${esc(setup.entry)}</span>` : ""}</div>
        ${setup.items.map(item).join("")}${setup.no ? `<div class="hint cl-no-trade">${esc(setup.no)}</div>` : ""}` : ""}
      <label class="cl-note-in">${tr("Заметка")}<textarea rows="2" data-rnote="1" placeholder="${tr("Что видишь на графике, почему да / нет")}">${esc(c.note)}</textarea></label>
      <div class="cle-actions">
        <button type="button" class="btn primary" data-act="run-save">${tr("Сохранить чек-лист")}</button>
        <button type="button" class="btn ghost" data-act="run-reset">${tr("Очистить")}</button>
        <span class="grow"></span>
        <button type="button" class="link-btn" data-act="cl-edit">${tr("Изменить чек-лист")}</button>
      </div>
      <div class="cl-export">
        <span class="muted">${tr("Выгрузить чек-лист")} <span class="cl-export-hint">${tr("(пустой — бланк для печати)")}</span></span>
        <span class="grow"></span>
        <button type="button" class="btn ghost sm" data-act="run-png" title="${tr("Выгрузить картинкой (пустой — бланк для печати)")}">PNG</button>
        <button type="button" class="btn ghost sm" data-act="run-pdf" title="${tr("Выгрузить в PDF (пустой — бланк для печати)")}">PDF</button>
      </div>
    </section>
    ${runsHistory()}
  </div>`;
}

// Сохранённые чек-листы: сводка за сегодня, частые «нет», история по дням.
function runsHistory() {
  const runs = [...S.runs].sort((a, b) => b.at - a.at);
  if (!runs.length) return `<section class="panel"><h3>${tr("История")}</h3><div class="empty">${tr("Сохранённых чек-листов пока нет")}</div></section>`;
  const today = Math.floor(fromInput(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)));
  const tday = runs.filter((r) => Math.floor(r.at) === today);
  const ok = (list) => list.filter((r) => r.verdict === "Можно торговать").length;
  const bad = (list) => list.filter((r) => r.verdict === "Сделки нет").length;
  const freq = new Map();
  for (const r of runs) for (const id of r.no) freq.set(id, (freq.get(id) || 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  let lastDay = "";
  const list = runs.map((r) => {
    const day = fmtDay(Math.floor(r.at));
    const head = day !== lastDay ? `<div class="day"><span>${esc(day)}</span></div>` : "";
    lastDay = day;
    const cls = r.verdict === "Можно торговать" ? "ok" : r.verdict === "Сделки нет" ? "bad" : "part";
    return head + `<div class="card run ${cls}">
      <div class="card-top"><span class="tnum">${esc(fmtDT(r.at).slice(-5))}</span><span class="pair">${esc(r.pair || "—")}</span>
        <span class="muted">${esc(r.setupName || tr("без сетапа"))}</span><span class="grow"></span>
        <span class="chk ${cls}">${esc(tr(r.verdict))}</span>
        <button type="button" class="mini" data-runexp="png" data-n-run="${r.n}" title="${tr("Выгрузить PNG")}">PNG</button>
        <button type="button" class="mini" data-runexp="pdf" data-n-run="${r.n}" title="${tr("Выгрузить PDF")}">PDF</button>
        <button type="button" class="chip-x" data-rundel="${r.n}" aria-label="${tr("Удалить")}">×</button></div>
      ${r.no.length ? `<ul class="run-no">${r.no.map((id) => `<li>${esc(CL.itemText(id))}</li>`).join("")}</ul>` : ""}
      ${r.note ? `<div class="card-notes">${esc(r.note)}</div>` : ""}
    </div>`;
  }).join("");
  return `<div class="ana-grid">
    <section class="panel"><h3>${tr("Сводка")}</h3>
      <div class="kpis small">
        <div class="kpi"><div class="kpi-l">${tr("Сегодня")}</div><div class="kpi-v">${tday.length}</div></div>
        <div class="kpi"><div class="kpi-l">${tr("Сегодня «можно»")}</div><div class="kpi-v pos">${ok(tday)}</div></div>
        <div class="kpi"><div class="kpi-l">${tr("Всего")}</div><div class="kpi-v">${runs.length}</div></div>
        <div class="kpi"><div class="kpi-l">${tr("Всего «сделки нет»")}</div><div class="kpi-v neg">${bad(runs)}</div></div>
      </div>
      ${top.length ? `<div class="cl-h">${tr("Чаще всего не выполнено")}</div><table class="ana viol"><tbody>${top.map(([id, n]) =>
        `<tr><td class="wrap-cell">${esc(CL.itemText(id))}</td><td class="r">${n}</td></tr>`).join("")}</tbody></table>` : ""}
    </section>
    <section class="panel"><h3>${tr("История")}</h3>${list}</section>
  </div>`;
}

function runToggle(id, v) {
  const c = S.run, on = c[v].includes(id);
  c.yes = c.yes.filter((x) => x !== id); c.no = c.no.filter((x) => x !== id);
  if (!on) c[v].push(id);
  saveRun(); renderChecklist();
}

async function runSave() {
  const c = S.run;
  if (!c.pair && !c.setup && !c.yes.length && !c.no.length) { toast(tr("Чек-лист пустой"), true); return; }
  const v = runVerdict(c);
  const now = new Date();
  const at = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()) / 86400000 + 25569;
  const setup = CL.setupById(c.setup);
  const row = [at, c.pair, c.setup, setup?.name || "", v.text, c.yes.join(" "), c.no.join(" "),
    c.no.map((id) => CL.itemText(id)).join("; "), c.note.trim()];
  setBusy(true);
  try {
    await api.appendRun(row);
    S.run = newRun(); saveRun();
    toast(v.st === "ok" ? tr("Сохранено. Можно торговать") : tr("Сохранено: {v}", { v: tr(v.text) }));
    await reload();
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

async function exportRun(run, kind) {
  setBusy(true);
  try {
    await (kind === "png" ? exportPNG(run) : exportPDF(run));
  } catch (e) {
    toast(tr("Не удалось выгрузить: {e}", { e: e.message || e }), true);
  } finally {
    setBusy(false);
  }
}

async function runDelete(n) {
  const r = S.runs.find((x) => x.n === n);
  if (!r || !confirm(tr("Удалить чек-лист {d} {p}?", { d: fmtDT(r.at), p: r.pair }))) return;
  setBusy(true);
  try {
    if (!(await api.deleteRun(S.runsSheetId, r.n, r.at))) { toast(tr("Таблица изменилась — обновил, попробуй ещё раз"), true); await reload(); return; }
    toast(tr("Чек-лист удалён"));
    await reload();
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

// Правка шаблона чек-листа (черновик S.clDraft, сохраняется кнопкой; хранится в Lists!F2).
function checklistEditor() {
  const d = S.clDraft;
  const items = (path, list) => list.map(([, text], i) => `
    <div class="cle-item"><textarea rows="2" data-clp="${path}.${i}.1">${esc(text)}</textarea>
      <button type="button" class="chip-x" data-cldel="${path}.${i}" aria-label="${tr("Удалить пункт")}">×</button></div>`).join("")
    + `<button type="button" class="btn ghost sm" data-cladd="${path}">${tr("+ пункт")}</button>`;
  return `<section class="panel checklist editing">
    <h3>${tr("Чек-лист — правка шаблона")}</h3>
    <label>${tr("Общая заметка")}<textarea rows="2" data-clp="note">${esc(d.note)}</textarea></label>
    <label class="cle-limit">${tr("Сколько «нет» запрещают сделку")}
      <input type="number" min="1" max="20" inputmode="numeric" data-clp="limit" value="${esc(d.limit ?? CL.DEFAULT_LIMIT)}"></label>
    <div class="cle-sec">${tr("Общий блок — проходится всегда")}</div>
    ${d.general.map((g, gi) => `<div class="cle-group">
      <div class="cle-row"><input data-clp="general.${gi}.title" value="${esc(g.title)}" placeholder="${tr("Название группы")}">
        <button type="button" class="chip-x" data-cldel="general.${gi}" aria-label="${tr("Удалить группу")}">×</button></div>
      ${items(`general.${gi}.items`, g.items)}</div>`).join("")}
    <button type="button" class="btn ghost sm" data-cladd="general">${tr("+ группа")}</button>
    <div class="cle-sec" id="cle-setups">${tr("Сетапы — добавляется блок выбранного сетапа")}</div>
    ${d.setups.map((s, si) => `<div class="cle-group">
      <div class="cle-row"><input data-clp="setups.${si}.name" value="${esc(s.name)}" placeholder="${tr("Название сетапа")}">
        <input data-clp="setups.${si}.entry" value="${esc(s.entry || "")}" placeholder="${tr("Вход (например, от Confirm)")}">
        <button type="button" class="chip-x" data-cldel="setups.${si}" aria-label="${tr("Удалить сетап")}">×</button></div>
      ${items(`setups.${si}.items`, s.items)}
      <textarea rows="2" data-clp="setups.${si}.no" placeholder="${tr("Когда сделки нет (подсказка)")}">${esc(s.no || "")}</textarea></div>`).join("")}
    <button type="button" class="btn ghost sm" data-cladd="setups">${tr("+ сетап")}</button>
    <div class="hint">${tr("Шаблон хранится в твоей Google-таблице (лист {sheet}, ячейка F2). Сохранённые чек-листы не меняются: в них записаны и коды, и тексты пунктов.", { sheet: esc(CONFIG.listsSheet) })}</div>
    <div class="cle-actions">
      <button type="button" class="btn primary" data-act="cl-save">${tr("Сохранить шаблон")}</button>
      <button type="button" class="btn ghost" data-act="cl-cancel">${tr("Отмена")}</button>
      <button type="button" class="btn ghost" data-act="cl-reset">${tr("Стандартный шаблон")}</button>
    </div>
  </section>`;
}

// путь «setups.1.items.2.1» -> [родитель, ключ]
function clPath(obj, path) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o[isNaN(k) ? k : +k], obj);
  return [parent, isNaN(last) ? last : +last];
}

function clAdd(path) {
  const d = S.clDraft;
  if (path === "general") d.general.push({ title: tr("Новая группа"), items: [[CL.newId(), ""]] });
  else if (path === "setups") d.setups.push({ id: CL.newId("S"), name: tr("Новый сетап"), entry: "", no: "", items: [[CL.newId(), ""]] });
  else { const [p, k] = clPath(d, path); p[k].push([CL.newId(), ""]); }
  renderChecklist();
}

function clDelete(path) {
  const [p, k] = clPath(S.clDraft, path);
  const what = tr(path.split(".").length <= 2 ? (path.startsWith("setups") ? "сетап целиком" : "группу целиком") : "пункт");
  if (!confirm(tr("Удалить {w}?", { w: what }))) return;
  p.splice(k, 1);
  renderChecklist();
}

// Новый сетап прямо из чек-листа: сохраняется в шаблон и сразу выбирается. Пункты добавляются в «изменить сетапы».
async function setupAdd() {
  const name = (prompt(tr("Название нового сетапа:")) || "").trim();
  if (!name) return;
  if (CL.current().setups.some((s) => s.name.toLowerCase() === name.toLowerCase())) { toast(tr("Такой сетап уже есть"), true); return; }
  const d = CL.draft();
  const id = CL.newId("S");
  d.setups.push({ id, name, entry: "", no: "", items: [] });
  const out = CL.finalize(d);
  setBusy(true);
  try {
    await api.saveChecklist(JSON.stringify(out));
    CL.load(JSON.stringify(out));
    S.run.setup = id; saveRun();
    renderChecklist();
    toast(tr("Сетап «{name}» добавлен — свои пункты можно дописать в «изменить сетапы»", { name }));
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

async function clSave() {
  const d = CL.finalize(S.clDraft);
  setBusy(true);
  try {
    await api.saveChecklist(JSON.stringify(d));
    CL.load(JSON.stringify(d));
    S.clDraft = null;
    renderChecklist();
    toast(tr("Шаблон чек-листа сохранён"));
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

// Нажатия на вкладке «Чек-лист» (true — обработано).
function checklistClick(b) {
  const a = b.dataset.act;
  if (b.dataset.rpair) { S.run.pair = S.run.pair === b.dataset.rpair ? "" : b.dataset.rpair; saveRun(); renderChecklist(); return true; }
  if (b.dataset.rsetup) { S.run.setup = S.run.setup === b.dataset.rsetup ? "" : b.dataset.rsetup; saveRun(); renderChecklist(); return true; }
  if (b.dataset.rcl) { runToggle(b.dataset.rcl, b.dataset.v); return true; }
  if (b.dataset.rundel) { runDelete(+b.dataset.rundel); return true; }
  if (b.dataset.runexp) {
    const r = S.runs.find((x) => x.n === +b.dataset.nRun);
    if (r) exportRun(r, b.dataset.runexp);
    return true;
  }
  if (a === "run-png" || a === "run-pdf") {
    const c = S.run, now = new Date(), setup = CL.setupById(c.setup);
    const blank = !c.pair && !c.setup && !c.yes.length && !c.no.length;
    exportRun({
      ...c, setupName: setup?.name || "", verdict: blank ? "" : runVerdict(c).text,
      at: blank ? null : Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()) / 86400000 + 25569,
    }, a === "run-png" ? "png" : "pdf");
    return true;
  }
  if (a === "pair-add") {
    const val = (prompt(tr("Новая торговая пара (например, USDJPY):")) || "").toUpperCase().replace(/\s/g, "");
    if (!val) return true;
    if (S.lists.pair.some((x) => x.toUpperCase() === val)) { toast(tr("Такая пара уже есть"), true); return true; }
    updateList("pair", [...S.lists.pair, val]).then((ok) => { if (ok) { S.run.pair = val; saveRun(); renderChecklist(); } });
    return true;
  }
  if (a === "setup-add") { setupAdd(); return true; }
  if (a === "setup-edit") {
    S.clDraft = CL.draft(); renderChecklist();
    $("#cle-setups")?.scrollIntoView({ block: "start" });
    return true;
  }
  if (a === "run-save") { runSave(); return true; }
  if (a === "run-reset") { if (confirm(tr("Очистить отметки?"))) { S.run = newRun(); saveRun(); renderChecklist(); } return true; }
  if (a === "cl-edit") { S.clDraft = CL.draft(); renderChecklist(); window.scrollTo(0, 0); return true; }
  if (a === "cl-cancel") { S.clDraft = null; renderChecklist(); return true; }
  if (a === "cl-reset") {
    if (confirm(tr("Вернуть стандартный шаблон? Свои правки пропадут после сохранения."))) {
      S.clDraft = { ...CL.defaultFor(), archive: CL.current().archive || {} }; renderChecklist();
    }
    return true;
  }
  if (a === "cl-save") { clSave(); return true; }
  if (b.dataset.cladd) { clAdd(b.dataset.cladd); return true; }
  if (b.dataset.cldel) { clDelete(b.dataset.cldel); return true; }
  return false;
}

// Строки скриншотов: таймфреймы из списка + те, где в этой сделке уже есть скриншоты.
function shotsBlock() {
  const f = S.ed.form;
  const manage = S.ed.manage === "tf";
  const extra = Object.keys(f.shots).filter((k) => !S.lists.tf.includes(k) && (f.shots[k].length || S.ed.uploading[k]));
  const rows = [...S.lists.tf, ...extra];
  const head = `<div class="field-h shots-h"><span>${tr("Скриншоты")} <span class="muted">${tr("— ссылка TradingView, фото или Ctrl+V картинки в поле")}</span></span>
    <button type="button" class="link-btn" data-manage="tf">${manage ? tr("Готово") : tr("Изменить список")}</button></div>`;
  const mgr = manage ? `<div class="field managing"><div class="chips">
      ${S.lists.tf.map((p) => `<span class="chip edit">${esc(p)}<button type="button" class="chip-x" data-rm="tf" data-val="${esc(p)}" aria-label="${tr("Убрать {x}", { x: esc(p) })}">×</button></span>`).join("")}
      <span class="chip-add"><input data-add="tf" placeholder="${tr("Новый таймфрейм, например H2 или M30")}" enterkeyhint="done" maxlength="12">
      <button type="button" class="btn sm" data-addbtn="tf">${tr("Добавить")}</button></span></div>
      <div class="hint">${tr("Список строк общий для всех сделок и сохраняется в таблицу (лист {sheet}, колонка E).", { sheet: esc(CONFIG.listsSheet) })}
        ${tr("W1–m3 пишутся в свои колонки L–R, новые таймфреймы — в колонку U «Screens». Убранная строка остаётся видна в сделках, где у неё есть скриншоты.")}</div></div>` : "";
  return head + mgr + rows.map(shotRow).join("");
}

function shotRow(tf) {
  const urls = S.ed.form.shots[tf] || [];
  const up = S.ed.uploading[tf] || 0;
  const stale = !S.lists.tf.includes(tf);
  return `<div class="shot-row${stale ? " stale" : ""}" data-tf="${esc(tf)}">
    <div class="shot-tf" title="${stale ? tr("Этого таймфрейма нет в списке") : ""}">${esc(tf)}</div>
    <div class="shot-items">
      ${urls.map((u, j) => `<div class="thumb">${thumbHtml(u)}<button type="button" class="x" data-del="${j}" aria-label="${tr("Убрать")}">×</button></div>`).join("")}
      ${up ? `<div class="thumb loading">${tr("загрузка…")}</div>` : ""}
      <input class="shot-in" data-link="1" placeholder="${tr("ссылка…")}" enterkeyhint="done">
      <label class="btn ghost sm file">${tr("Фото")}<input type="file" accept="image/*" data-file="1" hidden></label>
    </div>
  </div>`;
}

const rowTf = (el) => el.closest?.(".shot-row")?.dataset.tf;

function thumbHtml(u) {
  const tv = tvImage(u);
  if (tv || directImage(u)) return `<img loading="lazy" src="${esc(tv || u)}" data-img="${esc(u)}" alt="">`;
  const id = driveId(u);
  if (id) return `<img data-drive="${esc(id)}" data-img="${esc(u)}" alt="">`;
  return `<a href="${esc(u)}" target="_blank" rel="noopener" class="linkchip">${esc(u.replace(/^https?:\/\//, "").slice(0, 28))}</a>`;
}

function hydrateThumbs(root) {
  $$("img[data-drive]", root).forEach((img) => {
    api.driveBlobUrl(img.dataset.drive).then((u) => (img.src = u)).catch(() => img.replaceWith(Object.assign(
      document.createElement("a"), { href: img.dataset.img, target: "_blank", rel: "noopener", className: "linkchip", textContent: "Drive" })));
  });
}

function addLink(tf, value) {
  const urls = String(value).split(/\s+/).filter((s) => /^https?:\/\//.test(s));
  if (!urls.length) { if (value.trim()) toast(tr("Это не ссылка"), true); return; }
  (S.ed.form.shots[tf] ||= []).push(...urls);
  renderEditor();
}

async function uploadTo(tf, file) {
  if (!auth.hasDrive()) { toast(tr("Нет доступа к Google Drive — при входе отметь доступ к файлам"), true); return; }
  const ed = S.ed;
  const f = ed.form;
  const k = tf;
  const when = (f.open || "").replace("T", "_").replace(":", "");
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const name = `${ed.mode === "bt" ? "BT_" : ""}${when || "trade"}_${f.pair || "PAIR"}_${tf.trim()}.${ext}`;
  ed.uploading[k] = (ed.uploading[k] || 0) + 1;
  renderEditor();
  try {
    const url = await api.uploadImage(file, name);
    if (S.ed === ed) { (f.shots[k] ||= []).push(url); toast(tr("Скриншот загружен")); }
  } catch (e) {
    handleErr(e);
  } finally {
    ed.uploading[k]--;
    if (S.ed === ed) renderEditor();
  }
}

const findByKey = (list, key) => list.find((x) => String(x.v[3]) === String(key.pair) && sameMinute(parseDT(x.v[0]), parseDT(key.open)));

async function saveEditor() {
  const ed = S.ed;
  const bk = api.BOOKS[ed.mode];
  if (Object.values(ed.uploading).some((x) => x > 0)) { toast(tr("Подожди, скриншот ещё загружается")); return; }
  const v = formValues(ed.form, S.lists.tf);
  if (ed.mode === "bt" && !v[IDEA]) { toast(tr("Выбери идею — без неё сделку не с чем сравнивать"), true); return; }
  if (v[0] === "") { toast(tr("Укажи время входа (Open)"), true); return; }
  if (!v[3]) { toast(tr("Укажи пару"), true); return; }
  const old = ed.n ? trades(ed.mode).find((x) => x.n === ed.n) : null;
  const touched = old ? diff(old, v, bk.ncols).map(([k]) => k) : NUM_COLS;
  for (const k of NUM_COLS) {
    if (touched.includes(k) && typeof v[k] === "string" && v[k] !== "") { toast(tr("Поле {f}: нужно число", { f: ["RR", "Risk", "Profit"][k - 8] }), true); return; }
  }
  saveDraft();
  setBusy(true);
  try {
    if (!ed.n) {
      const sheetId = ed.mode === "bt" ? (S.books.bt?.sheetId ?? await api.ensureBacktest()) : book("live").sheetId;
      const last = trades(ed.mode).reduce((m, t) => Math.max(m, t.n), 1);
      await api.appendRow(bk, v, sheetId, last);
    } else {
      let t = old;
      if (!(await api.verifyRow(bk, t.n, ed.key.open, ed.key.pair))) {
        // таблица изменилась (сортировка, синхронизация) — ищем ту же сделку заново
        await reload();
        t = findByKey(trades(ed.mode), ed.key);
        if (!t) { toast(tr("Не нашёл эту сделку в таблице — она могла быть удалена. Изменения не записаны."), true); return; }
      }
      const changes = diff(t, v, bk.ncols);
      if (changes.length) await api.writeCells(bk, t.n, changes);
      // если поменяли время входа — пересортировать
      if (changes.some(([k]) => k === 0)) {
        const last = trades(ed.mode).reduce((m, x) => Math.max(m, x.n), 1);
        await api.sortSheet(bk, book(ed.mode).sheetId, last);
      }
    }
    // первая запись в колонки U / W — подписать их в заголовке
    const hdr = trades(ed.mode).headers || [];
    const heads = [[SCREENS, "Screens"], [CHECK, "Checklist"]].filter(([k, name]) => v[k] && hdr[k] !== name);
    if (heads.length) await api.writeCells(bk, 1, heads);
    clearDraft();
    closeEditor();
    toast(tr("Сохранено в таблицу"));
    await reload();
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

async function deleteTrade() {
  const ed = S.ed;
  const bk = api.BOOKS[ed.mode];
  const t = trades(ed.mode).find((x) => x.n === ed.n);
  if (!t || !confirm(tr(ed.mode === "bt" ? "Удалить сделку {d} {p} из бэктеста?" : "Удалить сделку {d} {p} из журнала?", { d: fmtDT(t.v[0]), p: t.v[3] }))) return;
  setBusy(true);
  try {
    if (!(await api.verifyRow(bk, t.n, ed.key.open, ed.key.pair))) {
      toast(tr("Таблица изменилась — обновил данные, открой сделку ещё раз"), true);
      closeEditor();
      await reload();
      return;
    }
    await api.deleteRow(book(ed.mode).sheetId, t.n);
    clearDraft();
    closeEditor();
    toast(tr("Сделка удалена"));
    await reload();
  } catch (e) {
    handleErr(e);
  } finally {
    setBusy(false);
  }
}

function editorEvents() {
  const el = $("#editor");
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button, [data-img]");
    if (!b || !S.ed) return;
    const f = S.ed.form;
    if (b.dataset.act === "cancel") { if (confirm(tr("Закрыть без сохранения?"))) { clearDraft(); closeEditor(); } return; }
    if (b.dataset.act === "save") return saveEditor();
    if (b.dataset.act === "delete") return deleteTrade();
    if (b.dataset.pick === "poi") { const p = b.dataset.val; f.poi = f.poi.includes(p) ? f.poi.filter((x) => x !== p) : [...f.poi, p]; return renderEditor(); }
    if (["entry", "idea", "pair"].includes(b.dataset.pick)) {
      const k = b.dataset.pick; f[k] = f[k] === b.dataset.val ? "" : b.dataset.val; return renderEditor();
    }
    if (b.dataset.manage) { S.ed.manage = S.ed.manage === b.dataset.manage ? null : b.dataset.manage; renderEditor(); $(`input[data-add="${b.dataset.manage}"]`)?.focus(); return; }
    if (b.dataset.addbtn) return addToList(b.dataset.addbtn);
    if (b.dataset.rm) {
      const kind = b.dataset.rm, val = b.dataset.val;
      if (!confirm(tr("Убрать «{v}» из списка {l}?", { v: val, l: tr(LIST_LABEL[kind]) }))) return;
      return updateList(kind, S.lists[kind].filter((x) => x !== val));
    }
    const sg = b.closest("[data-seg]");
    if (sg) { const k = sg.dataset.seg; f[k] = f[k] === b.dataset.val ? "" : b.dataset.val; return renderEditor(); }
    if (b.dataset.del) { f.shots[rowTf(b)]?.splice(+b.dataset.del, 1); return renderEditor(); }
    if (b.dataset.img) return openViewer(b.dataset.img);
  });
  el.addEventListener("input", (e) => {
    const k = e.target.dataset.k;
    if (!k || !S.ed) return;
    const f = S.ed.form;
    f[k] = e.target.value;
    if (k === "session") f.sessionAuto = false;
    if (k === "open" && f.sessionAuto && fromInput(f.open) !== "") {
      f.session = sessionOf(fromInput(f.open));
      const s = $('select[data-k="session"]', el);
      if (s) { if (![...s.options].some((o) => o.value === f.session)) s.add(new Option(f.session)); s.value = f.session; }
    }
    if (["risk", "profit"].includes(k)) {
      const r = num(f.profit) / num(f.risk);
      $("#rHint").textContent = Number.isFinite(r) ? tr("Итог в R: {r}", { r: fmtSigned(r) }) : "";
    }
  });
  el.addEventListener("change", (e) => {
    if (!S.ed) return;
    if (e.target.dataset.link) addLink(rowTf(e.target), e.target.value);
    if (e.target.dataset.file) { const file = e.target.files?.[0]; if (file) uploadTo(rowTf(e.target), file); }
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset.link) { e.preventDefault(); e.target.blur(); }
    if (e.key === "Enter" && e.target.dataset.add) { e.preventDefault(); addToList(e.target.dataset.add); }
  });
  el.addEventListener("focusin", (e) => {
    const row = e.target.closest(".shot-row");
    if (row && S.ed) S.ed.activeTf = row.dataset.tf;
  });
  el.addEventListener("paste", (e) => {
    if (!S.ed) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    uploadTo(rowTf(e.target) || S.ed.activeTf, item.getAsFile());
  });
}

// ---------------- просмотр картинки ----------------

function openViewer(url) {
  const v = $("#viewer");
  const tv = tvImage(url), id = driveId(url);
  v.innerHTML = `<div class="vw-bar"><a class="btn ghost" href="${esc(url)}" target="_blank" rel="noopener">${tr("Открыть оригинал")}</a>
    <button class="btn ghost" data-close>${tr("Закрыть")}</button></div><div class="vw-img"><img alt=""></div>`;
  const img = $("img", v);
  if (tv || directImage(url)) img.src = tv || url;
  else if (id) api.driveBlobUrl(id).then((u) => (img.src = u)).catch(() => toast(tr("Картинка недоступна — открой оригинал"), true));
  else { window.open(url, "_blank", "noopener"); return; }
  v.hidden = false;
}

// ---------------- старт ----------------

// Язык и тема: кнопки в шапке, выбор запоминается на устройстве.
function applyLangUi() {
  applyStatic();
  $("#lang").textContent = LANG === "en" ? "RU" : "EN"; // кнопка показывает, на какой язык переключит
  $("#fab").setAttribute("aria-label", tr("Новая сделка"));
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  lsSet("tj.theme", next);
  $('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#f4f6f8" : "#0c0c0f");
  if (S.view === "dashboard") renderDashboard(); // цвета графика
}

function events() {
  $("#lang").onclick = () => {
    setLang(LANG === "en" ? "ru" : "en");
    CL.load(); // шаблон по умолчанию — на новом языке (свой сохранённый не меняется)
    applyLangUi();
    render();
    if (S.ed) renderEditor();
  };
  $("#theme").onclick = toggleTheme;
  $$(".tab").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  $("#fab").onclick = () => openEditor(null);
  $("#newsBar").onclick = () => setView("news");
  $("#apiBtn").onclick = () => setView("connect");
  $("#refresh").onclick = () => reload().then((ok) => ok && toast(tr("Обновлено")));
  $("#logout").onclick = () => { if (confirm(tr("Выйти из Google-аккаунта в приложении?"))) { auth.logout(); showLogin(); } };
  $("#view").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn && S.view === "checklist" && checklistClick(btn)) return;
    if (btn && S.view === "strategy" && strategyClick(btn)) return;
    if (btn && S.view === "connect" && connectClick(btn)) return;
    if (btn && S.view === "news" && newsClick(btn)) return;
    if (btn && S.view === "lot" && lotClick(btn)) return;
    if (btn?.dataset.act === "cx-open") { setView("connect"); return; }
    const toc = e.target.closest("[data-sttoc]");
    if (toc) { e.preventDefault(); document.getElementById(toc.dataset.sttoc)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const m = e.target.closest("[data-mode]");
    if (m) return setMode(m.dataset.mode);
    const idea = e.target.closest("[data-idea]");
    if (idea) return pickIdea(idea.dataset.idea);
    const img = e.target.closest("[data-img]");
    if (img) { e.stopPropagation(); return openViewer(img.dataset.img); }
    const row = e.target.closest("[data-n]");
    if (row) openEditor(+row.dataset.n);
  });
  $("#view").addEventListener("input", (e) => {
    if (e.target.dataset.rnote && S.run) { S.run.note = e.target.value; saveRun(); }
    if (e.target.dataset.stmd) { S.stEdit = e.target.value; return; }
    if (e.target.dataset.cxf) { CX.form[e.target.dataset.cxf] = e.target.value; return; }
    if (S.view === "lot" && lotInput(e.target)) return;
    if (e.target.dataset.nwq != null) {
      const pos = e.target.selectionStart;
      newsSet({ q: e.target.value });
      const q = $("[data-nwq]"); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
      return;
    }
    if (e.target.dataset.stb && S.stB) { const [p, key] = clPath(S.stB, e.target.dataset.stb); p[key] = e.target.value; if (e.target.classList.contains("stb-area")) autoGrow(e.target); return; }
    if (e.target.dataset.clp && S.clDraft) { const [p, key] = clPath(S.clDraft, e.target.dataset.clp); p[key] = e.target.value; }
  });
  $("#view").addEventListener("mousemove", chartTip);
  $("#view").addEventListener("click", chartTip);
  $("#view").addEventListener("mouseleave", () => { const t = $("#chartTip"); if (t) t.hidden = true; });
  $("#view").addEventListener("change", (e) => {
    if (S.view === "lot" && lotChange(e.target)) return;
    if (e.target.dataset.nwwin) { newsSet({ window: Math.max(0, Math.min(120, parseInt(e.target.value, 10) || 0)) }); return; }
    if (e.target.dataset.nwnotify) {
      if (!e.target.checked) { newsSet({ notify: false }); return; }
      Notification.requestPermission().then((p) => { newsSet({ notify: p === "granted" }); if (p !== "granted") toast(tr("Браузер не разрешил уведомления"), true); });
      return;
    }
    if (e.target.dataset.cxtz && CX.report) { CX.report.tz = e.target.value; return; }
    if (e.target.dataset.cxfile && e.target.files?.[0]) { cxReadReport(e.target.files[0]); e.target.value = ""; return; }
    if (e.target.dataset.cxpick && CX.preview) { CX.preview.items[+e.target.dataset.cxpick].pick = e.target.checked; renderConnect(); return; }
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    if (e.target.dataset.stimg) stUpload(files, "insert");
    if (e.target.dataset.stmissing) stUpload(files, "missing");
    if (e.target.dataset.stbimg && S.stB) stbUpload(files, e.target.dataset.stbimg);
    e.target.value = "";
  });
  $("#viewer").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    if (e.target.closest("[data-close]") || !e.target.closest("img")) $("#viewer").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#viewer").hidden) $("#viewer").hidden = true;
  });
  editorEvents();
  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (S.view === "dashboard") renderDashboard(); if (S.view === "stats") renderStats(); }, 200); });
  window.addEventListener("pagehide", () => S.ed && saveDraft());
  document.addEventListener("visibilitychange", () => { if (document.hidden && S.ed) saveDraft(); });
}

async function boot() {
  if (!CONFIG.clientId) return showSetup();
  const r = auth.handleRedirect();
  if (r?.error) toast(tr("Вход не выполнен: {e}", { e: r.error }), true);
  if (!auth.token()) return showLogin();
  showApp();
  newsStart();
  S.run = loadRun();
  events();
  applyLangUi();
  if (document.documentElement.dataset.theme === "light") $('meta[name="theme-color"]')?.setAttribute("content", "#f4f6f8");
  // своя таблица пользователя: найти или создать (у нового пользователя — пустая)
  setBusy(true);
  try {
    const sheet = await api.resolveSpreadsheet(LANG);
    if (sheet.created) toast(tr("Создал тебе таблицу «Trader'sBook» в Google Drive — все данные будут там"));
  } catch (e) {
    setBusy(false);
    handleErr(e);
    return;
  }
  setBusy(false);
  if (!(await reload())) return;
  let d = null;
  try { d = JSON.parse(lsGet("tj.draft") || "null"); } catch { /* битый черновик */ }
  if (d?.form && !d.form.shots) { clearDraft(); d = null; } // черновик старой версии приложения
  if (d?.form) {
    if (d.mode && d.mode !== S.mode) { S.mode = d.mode; render(); }
    let n = null;
    if (d.key) {
      const t = findByKey(trades(), d.key);
      if (!t) { clearDraft(); return; }
      n = t.n;
    }
    openEditor(n, d.form);
    toast(tr("Восстановил несохранённые изменения"));
  }
  if ("serviceWorker" in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    // пришла новая версия приложения — перезагрузить страницу (если не открыта карточка сделки)
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      const go = () => (S.ed ? setTimeout(go, 2000) : location.reload());
      go();
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
  }
}

boot();
