// Редактор стратегии как в Notion: страница из блоков, правится прямо на месте.
// Хранится по-прежнему Markdown (тот же, что рисует strategy.js), поэтому AI и старые страницы его понимают.
//   «/» — меню блоков, «+» слева — новый блок, ⠿ — тянуть (синяя линия показывает, куда встанет) или меню блока.
//   Сокращения в начале строки: «# », «## », «### », «- », «1. », «[] », «> » (сворачиваемый), «---».
//   Enter — новый блок, Backspace в начале — обычный текст / склеить с предыдущим, Tab / Shift+Tab — вложенность списка.
import { esc } from "./util.js";
import { inline, imageHtml } from "./strategy.js";
import { t as tr } from "./i18n.js";

let uid = 0;
const nid = () => "b" + (++uid) + Math.random().toString(36).slice(2, 6);
const LIST = new Set(["bullet", "num", "todo"]);
const TEXT = new Set(["p", "h1", "h2", "h3", "bullet", "num", "todo", "toggle"]);
const BOX = new Set(["toggle", "callout"]);
const ICONS = ["💡", "⚠️", "📌", "✅", "❌", "🛑", "🎯", "⏰", "📈", "📉", "🔥", "ℹ️"];

// ---------- Markdown <-> блоки ----------

export function parse(md) {
  const root = [];
  const stack = [root];
  for (const raw of String(md ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const cur = stack[stack.length - 1];
    if (!line.trim()) continue;
    const blk = line.trim().match(/^:::(callout|details)\s*(.*)$/);
    if (blk) {
      const b = blk[1] === "callout"
        ? { id: nid(), type: "callout", icon: blk[2] || "💡", children: [] }
        : { id: nid(), type: "toggle", text: blk[2] === "…" ? "" : blk[2], children: [] };
      cur.push(b); stack.push(b.children); continue;
    }
    if (line.trim() === ":::") { if (stack.length > 1) stack.pop(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { cur.push({ id: nid(), type: "h" + h[1].length, text: h[2] }); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { cur.push({ id: nid(), type: "divider" }); continue; }
    const img = line.trim().match(/^!\[[^\]]*\]\(([^)]+)\)$/);
    if (img) { cur.push({ id: nid(), type: "image", url: img[1] }); continue; }
    const li = line.match(/^(\t*|\s*)([-*]|\d+[.)])(?:\s+(\[[ xX]\]\s*)?(.*))?$/);
    if (li) {
      const indent = Math.min(6, li[1].replace(/ {2}/g, "\t").replace(/ /g, "").length);
      const type = li[3] ? "todo" : /\d/.test(li[2]) ? "num" : "bullet";
      cur.push({ id: nid(), type, indent, text: li[4] || "", checked: !!li[3] && /x/i.test(li[3]) });
      continue;
    }
    cur.push({ id: nid(), type: "p", text: line.trim() });
  }
  return root;
}

// текст обычного абзаца, который иначе прочитался бы как заголовок / список / блок
const escP = (s) => (/^(#{1,3}\s|[-*]\s|[-*]$|\d+[.)](\s|$)|:::|-{3,}\s*$|\*{3,}\s*$|!\[)/.test(s)
  ? (/^\d/.test(s) ? s.replace(/^(\d+)([.)])/, "$1\\$2") : "\\" + s) : s);

export function serialize(blocks) {
  const out = [];
  const walk = (list) => {
    for (const b of list) {
      const text = String(b.text ?? "").replace(/\n/g, " ").trim();
      const tabs = "\t".repeat(b.indent || 0);
      if (/^h[123]$/.test(b.type)) { if (text) out.push("", "#".repeat(+b.type[1]) + " " + text); continue; }
      if (b.type === "p") { if (text) out.push(escP(text)); continue; }
      if (b.type === "bullet") { if (text) out.push(tabs + "- " + text); continue; }
      if (b.type === "num") { if (text) out.push(tabs + "1. " + text); continue; }
      if (b.type === "todo") { if (text) out.push(tabs + (b.checked ? "- [x] " : "- [ ] ") + text); continue; }
      if (b.type === "divider") { out.push("", "---", ""); continue; }
      if (b.type === "image") { if (b.url) out.push("", `![](${b.url})`, ""); continue; }
      if (b.type === "callout") { out.push("", `:::callout ${b.icon || "💡"}`); walk(b.children || []); out.push(":::", ""); continue; }
      if (b.type === "toggle") { out.push("", `:::details ${text || "…"}`); walk(b.children || []); out.push(":::", ""); continue; }
    }
  };
  walk(blocks);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// HTML внутри блока -> строчный Markdown (**жирный**, *курсив*, `код`, [ссылка](url))
function htmlToInline(el) {
  let s = "";
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { s += c.nodeValue.replace(/ /g, " ").replace(/\n/g, " ").replace(/([\\*`])/g, "\\$1"); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName, st = c.style || {};
      if (tag === "BR") { s += " "; continue; }
      if (tag === "CODE") { s += "`" + c.textContent.replace(/`/g, "") + "`"; continue; }
      if (tag === "A" && /^https?:/.test(c.getAttribute("href") || "")) { s += "[" + c.textContent.replace(/[[\]]/g, "") + "](" + c.getAttribute("href") + ")"; continue; }
      const bold = tag === "B" || tag === "STRONG" || st.fontWeight === "bold" || +st.fontWeight >= 600;
      const ital = tag === "I" || tag === "EM" || st.fontStyle === "italic";
      const before = s.length;
      walk(c);
      const inner = s.slice(before);
      s = s.slice(0, before);
      if (!inner.trim()) { s += inner; continue; }
      // пробелы по краям — снаружи разметки, иначе **текст ** не распознается
      const lead = inner.match(/^\s*/)[0], trail = inner.match(/\s*$/)[0], core = inner.trim();
      const w = (bold ? "**" : "") + (ital ? "*" : "");
      s += lead + w + core + [...w].reverse().join("") + trail;
    }
  };
  walk(el);
  return s;
}

// ---------- каретка ----------
function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return 0;
  const r = sel.getRangeAt(0), pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function setCaret(el, off) {
  if (!el) return;
  el.focus({ preventScroll: true });
  const sel = getSelection(), r = document.createRange();
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n, left = off;
  while ((n = w.nextNode())) {
    if (left <= n.length) { r.setStart(n, left); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); return; }
    left -= n.length;
  }
  r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
}
const textLen = (el) => el.textContent.length;
// каретка на первой / последней строке блока (для стрелок вверх/вниз)
function caretLine(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return { first: true, last: true };
  const r = sel.getRangeAt(0).cloneRange();
  let rect = r.getClientRects()[0];
  if (!rect) { const off = caretOffset(el); return { first: off === 0, last: off === textLen(el) }; }
  const box = el.getBoundingClientRect(), lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
  return { first: rect.top - box.top < lh * 0.8, last: box.bottom - rect.bottom < lh * 0.8 };
}

// ---------- редактор ----------
// opts: { md, onChange(md), upload(files) -> Promise<url[]>, hydrate(root), onHeadings([{id, text}]) }
export function mount(root, opts) {
  let blocks = parse(opts.md);
  if (!blocks.length) blocks = [blank()];
  let last = JSON.stringify(blocks);
  const undo = [], redo = [];
  const open = new Set(); // открытые сворачиваемые блоки
  let typingT = 0, menu = null, slash = null, drag = null;

  function blank(type = "p", extra = {}) { return { id: nid(), type, text: "", ...extra }; }

  // поиск блока: { list, i, b, parent }
  function find(id, list = blocks, parent = null) {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.id === id) return { list, i, b, parent };
      if (b.children) { const r = find(id, b.children, b); if (r) return r; }
    }
    return null;
  }
  // блоки в порядке на экране (внутрь свёрнутых не заходим)
  function flat(list = blocks, out = []) {
    for (const b of list) {
      out.push(b);
      if (b.children && (b.type === "callout" || open.has(b.id))) flat(b.children, out);
    }
    return out;
  }
  const textEl = (id) => root.querySelector(`.nb-b[data-id="${id}"] > .nb-row > .nb-text`);
  const blockEl = (id) => root.querySelector(`.nb-b[data-id="${id}"]`);

  // ---------- история и сохранение ----------
  function commit() {
    const cur = JSON.stringify(blocks);
    if (cur === last) return;
    undo.push(last); if (undo.length > 200) undo.shift();
    redo.length = 0;
    last = cur;
    emit();
  }
  function emit() {
    opts.onChange?.(serialize(blocks));
    opts.onHeadings?.(blocks.filter((b) => b.type === "h1" && b.text.trim()).map((b) => ({ id: b.id, text: b.text })));
  }
  function typed() { clearTimeout(typingT); typingT = setTimeout(commit, 500); opts.onChange?.(serialize(blocks)); }
  function back(from, to) {
    clearTimeout(typingT); commit();
    if (!from.length) return;
    to.push(last);
    last = from.pop();
    blocks = JSON.parse(last);
    const f = document.activeElement?.closest?.(".nb-b")?.dataset.id;
    draw(f && find(f) ? { id: f, end: true } : null);
    emit();
  }

  // ---------- отрисовка ----------
  const PH = {
    p: "Напиши текст или нажми «/» для блоков", h1: "Заголовок 1", h2: "Заголовок 2", h3: "Заголовок 3",
    bullet: "Пункт списка", num: "Пункт списка", todo: "Задача", toggle: "Сворачиваемый блок",
  };
  function listHtml(list, parent) {
    if (!list.length && parent) return `<div class="nb-empty" data-nb="kidadd" data-parent="${parent.id}">${tr("Пусто. Нажми, чтобы написать, или перетащи блок сюда")}</div>`;
    const cnt = [];
    return list.map((b) => {
      const ind = b.indent || 0;
      let n = 0;
      if (b.type === "num") { cnt.length = ind + 1; cnt[ind] = (cnt[ind] || 0) + 1; n = cnt[ind]; }
      else if (LIST.has(b.type)) { cnt.length = ind + 1; cnt[ind] = 0; }
      else cnt.length = 0;
      return blockHtml(b, n);
    }).join("");
  }
  function blockHtml(b, n) {
    const text = (cls = "") => `<div class="nb-text ${cls}" contenteditable="true" spellcheck="true" data-ph="${esc(tr(PH[b.type] || PH.p))}">${inline(b.text || "")}</div>`;
    let row = "", kids = "";
    const ind = b.indent || 0;
    if (b.type === "bullet") row = `<span class="nb-mark">${["•", "◦", "▪"][ind % 3]}</span>` + text();
    else if (b.type === "num") row = `<span class="nb-mark nb-num">${n}.</span>` + text();
    else if (b.type === "todo") row = `<span class="nb-check ${b.checked ? "on" : ""}" data-nb="check" role="checkbox" aria-checked="${!!b.checked}"></span>` + text(b.checked ? "done" : "");
    else if (b.type === "toggle") {
      const o = open.has(b.id);
      row = `<button type="button" class="nb-arrow ${o ? "open" : ""}" data-nb="toggle" tabindex="-1" aria-label="${tr("Свернуть / развернуть")}">▸</button>` + text();
      if (o) kids = `<div class="nb-kids">${listHtml(b.children || [], b)}</div>`;
    } else if (b.type === "callout") {
      row = `<button type="button" class="nb-icon" data-nb="icon" tabindex="-1" title="${tr("Сменить значок")}">${esc(b.icon || "💡")}</button><div class="nb-kids">${listHtml(b.children || [], b)}</div>`;
    } else if (b.type === "divider") row = `<div class="nb-hr" tabindex="0" data-nb="sel"><hr></div>`;
    else if (b.type === "image") row = `<figure class="nb-fig" tabindex="0" data-nb="sel">${imageHtml(b.url)}</figure>`;
    else row = text();
    return `<div class="nb-b nb-${b.type}" data-id="${b.id}" style="--ind:${ind}">
      <div class="nb-gut"><button type="button" class="nb-plus" data-nb="plus" tabindex="-1" title="${tr("Нажми, чтобы добавить блок ниже")}">+</button><span class="nb-grip" data-nb="grip" title="${tr("Тяни, чтобы переместить · нажми — меню")}">⠿</span></div>
      <div class="nb-row">${row}</div>${kids}</div>`;
  }
  // focus: { id, off } | { id, end: true }
  function draw(focus) {
    const y = window.scrollY;
    root.innerHTML = `<div class="nb-doc">${listHtml(blocks, null)}</div>`;
    opts.hydrate?.(root);
    window.scrollTo(0, y);
    if (focus) place(focus);
  }
  function place(focus) {
    const el = textEl(focus.id);
    if (el) setCaret(el, focus.end ? textLen(el) : focus.off || 0);
    else blockEl(focus.id)?.querySelector("[data-nb=sel]")?.focus({ preventScroll: true });
    markFocus();
  }
  function markFocus() {
    root.querySelectorAll(".nb-b.focus").forEach((e) => e.classList.remove("focus"));
    document.activeElement?.closest?.(".nb-b")?.classList.add("focus");
  }

  // ---------- операции с блоками ----------
  function insertAfter(id, nb) {
    const f = find(id);
    if (!f) { blocks.push(nb); return; }
    f.list.splice(f.i + 1, 0, nb);
  }
  function setType(b, type) {
    if (b.type === type) return;
    const from = b.type;
    if (BOX.has(from) && !BOX.has(type)) { // содержимое контейнера встаёт следом
      const f = find(b.id);
      const kids = b.children || [];
      delete b.children;
      if (from === "callout") { const first = kids.find((k) => TEXT.has(k.type)); b.text = first ? first.text : ""; kids.splice(kids.indexOf(first), first ? 1 : 0); }
      f.list.splice(f.i + 1, 0, ...kids);
    }
    if (type === "callout" && from !== "callout") { b.children = from === "toggle" ? [blank("p", { text: b.text || "" }), ...(b.children || [])] : [blank("p", { text: b.text || "" })]; b.icon ||= "💡"; delete b.text; }
    else if (type === "toggle" && from === "callout") { const kids = b.children || []; b.text = ""; b.children = kids; }
    else if (type === "toggle") { b.children ||= []; open.add(b.id); }
    if (!LIST.has(type)) delete b.indent;
    if (type !== "todo") delete b.checked;
    if (type === "divider" || type === "image") { delete b.text; }
    b.type = type;
  }
  function remove(id) { const f = find(id); if (f) f.list.splice(f.i, 1); if (!blocks.length) blocks.push(blank()); }
  function clone(b) { const c = JSON.parse(JSON.stringify(b)); const re = (x) => { x.id = nid(); (x.children || []).forEach(re); }; re(c); return c; }
  // заголовок тянется вместе со своим разделом (до следующего заголовка того же или старшего уровня)
  function section(id) {
    const f = find(id);
    if (!f || !/^h[123]$/.test(f.b.type)) return [id];
    const lvl = +f.b.type[1], ids = [id];
    for (let i = f.i + 1; i < f.list.length; i++) {
      const x = f.list[i];
      if (/^h[123]$/.test(x.type) && +x.type[1] <= lvl) break;
      ids.push(x.id);
    }
    return ids;
  }
  function moveBy(id, d) {
    const f = find(id);
    if (!f) return;
    const j = f.i + d;
    if (j < 0 || j >= f.list.length) return;
    [f.list[f.i], f.list[j]] = [f.list[j], f.list[f.i]];
    commit(); draw({ id, end: true });
  }
  function indent(b, d) {
    const f = find(b.id);
    if (d > 0) {
      if (!LIST.has(b.type)) return;
      const prev = f.list[f.i - 1];
      const max = prev && LIST.has(prev.type) ? (prev.indent || 0) + 1 : 0;
      b.indent = Math.min(max, (b.indent || 0) + 1, 6);
    } else if ((b.indent || 0) > 0) b.indent--;
    else if (f.parent) { // вынести из сворачиваемого блока / подсказки
      f.list.splice(f.i, 1);
      const pf = find(f.parent.id);
      pf.list.splice(pf.i + 1, 0, b);
    } else return false;
    return true;
  }
  async function addImages(afterId, files, replace) {
    if (!files.length || !opts.upload) return;
    const urls = await opts.upload(files);
    if (!urls?.length) return;
    let at = afterId;
    const nbs = urls.map((url) => ({ id: nid(), type: "image", url }));
    nbs.forEach((nb, k) => {
      if (k === 0 && replace) { const f = find(replace); if (f) { f.list.splice(f.i, 1, nb); at = nb.id; return; } }
      insertAfter(at, nb); at = nb.id;
    });
    const nx = blank(); insertAfter(at, nx);
    commit(); draw({ id: nx.id });
  }
  function pickImages(afterId, replace) {
    const inp = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", multiple: true });
    inp.onchange = () => addImages(afterId, [...(inp.files || [])], replace);
    inp.click();
  }

  // ---------- меню ----------
  const KINDS = [
    { type: "p", icon: "Aa", label: "Текст", hint: "Обычный абзац", keys: "text текст абзац" },
    { type: "h1", icon: "H1", label: "Заголовок 1", hint: "Раздел, попадает в оглавление", keys: "heading h1 заголовок раздел" },
    { type: "h2", icon: "H2", label: "Заголовок 2", hint: "Подраздел", keys: "heading h2 заголовок подраздел" },
    { type: "h3", icon: "H3", label: "Заголовок 3", hint: "Маленький заголовок", keys: "heading h3 заголовок" },
    { type: "bullet", icon: "•", label: "Список", hint: "Пункты с точками", keys: "bullet list список пункт" },
    { type: "num", icon: "1.", label: "Нумерованный список", hint: "1, 2, 3…", keys: "number numbered нумерованный список" },
    { type: "todo", icon: "☑", label: "Галочка", hint: "Пункт, который можно отметить", keys: "todo check галочка задача чек" },
    { type: "toggle", icon: "▸", label: "Сворачиваемый блок", hint: "Скрывает текст внутри", keys: "toggle details сворачиваемый скрыть" },
    { type: "callout", icon: "💡", label: "Подсказка", hint: "Выделенный блок со значком", keys: "callout подсказка важно риск" },
    { type: "divider", icon: "—", label: "Разделитель", hint: "Линия между блоками", keys: "divider line разделитель линия" },
    { type: "image", icon: "🖼", label: "Картинка", hint: "Загрузить с устройства", keys: "image picture картинка фото скриншот" },
  ];
  function closeMenu() { menu?.el.remove(); menu = null; slash = null; }
  function showMenu(items, anchor, onPick, opt = {}) {
    closeMenu();
    const el = document.createElement("div");
    el.className = "nb-menu";
    document.body.append(el);
    menu = { el, items, sel: 0, onPick, title: opt.title };
    paintMenu();
    const r = anchor.getBoundingClientRect();
    const h = el.offsetHeight, w = el.offsetWidth;
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    el.style.top = Math.max(8, Math.min(top, innerHeight - h - 8)) + "px";
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  }
  function paintMenu() {
    if (!menu) return;
    const { el, items } = menu;
    el.innerHTML = (menu.title ? `<div class="nb-menu-t">${esc(menu.title)}</div>` : "")
      + (items.length ? items.map((it, i) => it.sep ? `<div class="nb-menu-t">${esc(it.sep)}</div>`
        : `<button type="button" class="nb-mi ${i === menu.sel ? "on" : ""} ${it.danger ? "danger" : ""}" data-mi="${i}">
          <span class="nb-mi-ic">${esc(it.icon || "")}</span><span class="nb-mi-tx"><b>${esc(tr(it.label))}</b>${it.hint ? `<small>${esc(tr(it.hint))}</small>` : ""}</span></button>`).join("")
        : `<div class="nb-menu-none">${tr("Ничего не найдено")}</div>`);
    el.querySelector(".nb-mi.on")?.scrollIntoView({ block: "nearest" });
    el.onpointerdown = (e) => e.preventDefault(); // не терять каретку
    el.onclick = (e) => { const b = e.target.closest("[data-mi]"); if (b) { const it = menu.items[+b.dataset.mi]; const cb = menu.onPick; closeMenu(); cb(it); } };
  }
  function menuKey(e) {
    if (!menu) return false;
    const pick = menu.items.map((x, i) => (x.sep ? -1 : i)).filter((i) => i >= 0);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const k = pick.indexOf(menu.sel), d = e.key === "ArrowDown" ? 1 : -1;
      menu.sel = pick[(k + d + pick.length) % pick.length] ?? 0; paintMenu(); return true;
    }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const it = menu.items[menu.sel]; const cb = menu.onPick; closeMenu(); if (it && !it.sep) cb(it); return true; }
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); return true; }
    return false;
  }
  function filterKinds(q) {
    q = q.trim().toLowerCase();
    return KINDS.filter((k) => !q || tr(k.label).toLowerCase().includes(q) || k.keys.includes(q));
  }
  // выбранный в «/»-меню или «+» тип: пустой блок превращается, иначе новый блок ниже
  function applyKind(b, type) {
    let target = b;
    const empty = TEXT.has(b.type) && !String(b.text || "").trim() && !(b.children || []).length;
    if (!empty || !TEXT.has(b.type)) { target = blank(); insertAfter(b.id, target); }
    if (type === "image") { commit(); draw({ id: target.id }); pickImages(target.id, target.id); return; }
    setType(target, type);
    let focus = { id: target.id };
    if (type === "divider") { const nx = blank(); insertAfter(target.id, nx); focus = { id: nx.id }; }
    if (type === "callout") focus = { id: target.children[0].id };
    commit(); draw(focus);
  }
  function blockMenu(b, anchor) {
    const turn = KINDS.filter((k) => k.type !== "image" && k.type !== "divider" && k.type !== b.type && !(b.type === "image" || b.type === "divider"));
    const items = [];
    if (turn.length) items.push({ sep: tr("Превратить в") }, ...turn.map((k) => ({ ...k, act: "turn" })));
    items.push({ sep: tr("Действия") });
    if (b.type === "callout") items.push({ act: "icon", icon: b.icon || "💡", label: "Сменить значок" });
    if (b.type === "image") items.push({ act: "replace", icon: "🖼", label: "Заменить картинку" });
    items.push({ act: "up", icon: "↑", label: "Выше" }, { act: "down", icon: "↓", label: "Ниже" },
      { act: "dup", icon: "⧉", label: "Дублировать" }, { act: "del", icon: "🗑", label: "Удалить", danger: true });
    showMenu(items, anchor, (it) => {
      if (it.act === "turn") { setType(b, it.type); commit(); draw(b.type === "callout" ? { id: b.children[0].id } : { id: b.id, end: true }); }
      else if (it.act === "icon") iconMenu(b, anchor);
      else if (it.act === "replace") pickImages(b.id, b.id);
      else if (it.act === "up") moveBy(b.id, -1);
      else if (it.act === "down") moveBy(b.id, 1);
      else if (it.act === "dup") { const c = clone(b); insertAfter(b.id, c); commit(); draw({ id: c.id, end: true }); }
      else if (it.act === "del") { const fl = flat(); const k = fl.indexOf(b); remove(b.id); commit(); const nb = fl[k - 1] || fl[k + 1]; draw(nb && find(nb.id) ? { id: nb.id, end: true } : null); }
    });
    menu.sel = items.findIndex((x) => !x.sep); paintMenu();
  }
  function iconMenu(b, anchor) {
    showMenu(ICONS.map((ic) => ({ icon: ic, label: ic })), anchor, (it) => { b.icon = it.icon; commit(); draw(); });
    menu.el.classList.add("nb-icons");
  }

  // ---------- события ----------
  const cur = (el) => find(el.closest(".nb-b")?.dataset.id);

  root.addEventListener("focusin", markFocus);
  root.addEventListener("input", (e) => {
    const el = e.target.closest(".nb-text");
    if (!el) return;
    const f = cur(el);
    if (!f) return;
    const b = f.b;
    b.text = htmlToInline(el);
    if (!el.textContent) el.innerHTML = ""; // чтобы показалась подсказка-плейсхолдер
    // «/» в начале или после пробела — меню блоков
    const off = caretOffset(el), plain = el.textContent;
    if (e.data === "/" && (off === 1 || /\s/.test(plain[off - 2] || ""))) {
      const rr = getSelection().getRangeAt(0).getBoundingClientRect();
      const sl = { id: b.id, start: off - 1 };
      showMenu(filterKinds(""), rr.width || rr.height ? { getBoundingClientRect: () => rr } : el, (it) => slashPick(it, sl));
      slash = sl; // после showMenu: он сбрасывает slash
    } else if (slash && slash.id === b.id && menu) {
      const q = plain.slice(slash.start + 1, off);
      if (off <= slash.start || plain[slash.start] !== "/" || /\s{2}/.test(q) || q.length > 24) closeMenu();
      else { menu.items = filterKinds(q); menu.sel = 0; paintMenu(); }
    }
    // сокращения Markdown в начале обычного текста
    if (b.type === "p" && !slash) {
      const rules = [[/^#\s/, "h1"], [/^##\s/, "h2"], [/^###\s/, "h3"], [/^[-*]\s/, "bullet"], [/^1[.)]\s/, "num"], [/^\[\s?\]\s/, "todo"], [/^>\s/, "toggle"]];
      for (const [re, type] of rules) {
        const m = plain.match(re);
        if (m && off === m[0].length) { cutStart(el, m[0].length); b.text = htmlToInline(el); setType(b, type); commit(); draw(type === "callout" ? { id: b.children[0].id } : { id: b.id }); return; }
      }
      if (/^-{3}$/.test(plain) && off === 3) { setType(b, "divider"); const nx = blank(); insertAfter(b.id, nx); commit(); draw({ id: nx.id }); return; }
    }
    typed();
  });
  function cutStart(el, n) {
    const r = document.createRange();
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node, left = n;
    r.setStart(el, 0);
    while ((node = w.nextNode())) { if (left <= node.length) { r.setEnd(node, left); break; } left -= node.length; }
    r.deleteContents();
  }
  function slashPick(it, s) {
    slash = null;
    if (!it || !s) return;
    const el = textEl(s.id), f = find(s.id);
    if (!el || !f) return;
    // убрать «/запрос» из текста
    const off = caretOffset(el) || el.textContent.length;
    const r = document.createRange(), w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node, pos = 0, a = null;
    while ((node = w.nextNode())) {
      if (!a && s.start <= pos + node.length) { r.setStart(node, s.start - pos); a = 1; }
      if (a && off <= pos + node.length) { r.setEnd(node, off - pos); break; }
      pos += node.length;
    }
    if (a) r.deleteContents();
    f.b.text = htmlToInline(el);
    applyKind(f.b, it.type);
  }

  root.addEventListener("keydown", (e) => {
    if (menuKey(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && (e.key === "z" || e.key === "Z" || e.key === "я" || e.key === "Я")) { e.preventDefault(); if (e.shiftKey) back(redo, undo); else back(undo, redo); return; }
    if (mod && (e.key === "y" || e.key === "н")) { e.preventDefault(); back(redo, undo); return; }
    const sel = e.target.closest("[data-nb=sel]");
    if (sel && (e.key === "Backspace" || e.key === "Delete")) {
      e.preventDefault();
      const f = cur(sel), fl = flat(), k = fl.indexOf(f.b);
      remove(f.b.id); commit();
      const nb = fl[k - 1] || fl[k + 1];
      draw(nb && find(nb.id) ? { id: nb.id, end: true } : null); return;
    }
    if (sel && e.key === "Enter") { e.preventDefault(); const f = cur(sel); const nx = blank(); insertAfter(f.b.id, nx); commit(); draw({ id: nx.id }); return; }
    const el = e.target.closest(".nb-text");
    if (!el) return;
    const f = cur(el);
    if (!f) return;
    const b = f.b;
    if (mod && (e.key === "b" || e.key === "и")) { e.preventDefault(); document.execCommand("bold"); return; }
    if (mod && (e.key === "i" || e.key === "ш")) { e.preventDefault(); document.execCommand("italic"); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(typingT);
      b.text = htmlToInline(el);
      // пустой пункт списка: сначала левее, потом обычный текст
      if (LIST.has(b.type) && !el.textContent.trim()) {
        if ((b.indent || 0) > 0) b.indent--; else setType(b, "p");
        commit(); draw({ id: b.id }); return;
      }
      if (b.type === "toggle" && open.has(b.id) && caretOffset(el) === textLen(el)) {
        const nx = blank(); b.children.unshift(nx); commit(); draw({ id: nx.id }); return;
      }
      // разрезать блок по каретке
      const sel2 = getSelection();
      const r = sel2.getRangeAt(0);
      r.deleteContents();
      const tail = document.createRange();
      tail.setStart(r.startContainer, r.startOffset);
      tail.setEnd(el, el.childNodes.length);
      const frag = tail.extractContents();
      const tmp = document.createElement("div"); tmp.append(frag);
      b.text = htmlToInline(el);
      const atStart = !el.textContent && tmp.textContent;
      const type = LIST.has(b.type) ? b.type : "p";
      const nx = blank(type, { text: htmlToInline(tmp), ...(LIST.has(type) ? { indent: b.indent || 0 } : {}) });
      if (atStart && /^h[123]$/.test(b.type)) { // Enter в начале заголовка — пустая строка над ним
        const up = blank(); f.list.splice(f.i, 0, up); b.text = nx.text; commit(); draw({ id: b.id }); return;
      }
      insertAfter(b.id, nx);
      commit(); draw({ id: nx.id });
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      b.text = htmlToInline(el);
      const off = caretOffset(el);
      if (indent(b, e.shiftKey ? -1 : 1)) { commit(); draw({ id: b.id, off }); }
      return;
    }
    if (e.key === "Backspace" && getSelection().isCollapsed && caretOffset(el) === 0) {
      e.preventDefault();
      clearTimeout(typingT);
      b.text = htmlToInline(el);
      if (b.type !== "p") { // список / заголовок / сворачиваемый -> обычный текст
        if (LIST.has(b.type) && (b.indent || 0) > 0) b.indent--; else setType(b, "p");
        commit(); draw({ id: b.id }); return;
      }
      if (f.i === 0 && f.parent) { // первый блок внутри контейнера
        if (f.parent.type === "toggle") { f.parent.text = (f.parent.text || "") + b.text; f.list.splice(0, 1); commit(); draw({ id: f.parent.id, end: true }); return; }
        if (!b.text && f.list.length === 1) { const pf = find(f.parent.id); const nx = blank(); pf.list.splice(pf.i, 1, nx); commit(); draw({ id: nx.id }); return; }
        indent(b, -1); commit(); draw({ id: b.id }); return;
      }
      const fl = flat(), k = fl.indexOf(b);
      const prev = fl.slice(0, k).reverse().find((x) => TEXT.has(x.type) || x.type === "image" || x.type === "divider");
      if (!prev) return;
      if (prev.type === "image" || prev.type === "divider") { remove(prev.id); commit(); draw({ id: b.id }); return; }
      const pel = textEl(prev.id), join = pel ? textLen(pel) : 0;
      prev.text = (prev.text || "") + b.text;
      remove(b.id);
      commit(); draw({ id: prev.id, off: join });
      return;
    }
    if (e.key === "Delete" && getSelection().isCollapsed && caretOffset(el) === textLen(el)) {
      const fl = flat(), k = fl.indexOf(b), next = fl[k + 1];
      if (!next || !TEXT.has(next.type) || BOX.has(next.type)) return;
      e.preventDefault();
      const join = textLen(el);
      b.text = htmlToInline(el) + (next.text || "");
      remove(next.id); commit(); draw({ id: b.id, off: join });
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey) {
      const line = caretLine(el);
      const up = e.key === "ArrowUp";
      if (up ? !line.first : !line.last) return;
      const fl = flat().filter((x) => TEXT.has(x.type)), k = fl.indexOf(b), to = fl[k + (up ? -1 : 1)];
      if (!to) return;
      e.preventDefault();
      place(up ? { id: to.id, end: true } : { id: to.id, off: 0 });
    }
    if (e.key === "Escape") el.blur();
  });

  root.addEventListener("paste", (e) => {
    const el = e.target.closest(".nb-text");
    if (!el) return;
    const f = cur(el);
    const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile()).filter(Boolean);
    e.preventDefault();
    if (imgs.length) { addImages(f.b.id, imgs); return; }
    const text = (e.clipboardData?.getData("text/plain") || "").replace(/\r\n/g, "\n");
    if (!text.includes("\n")) { document.execCommand("insertText", false, text); return; }
    const nbs = parse(text);
    if (!nbs.length) return;
    f.b.text = htmlToInline(el);
    let at = f.b.id;
    if (!f.b.text.trim() && TEXT.has(f.b.type) && !BOX.has(f.b.type)) { const g = find(at); g.list.splice(g.i, 1, ...nbs); }
    else nbs.forEach((nb) => { insertAfter(at, nb); at = nb.id; });
    const lastB = nbs[nbs.length - 1];
    commit(); draw({ id: lastB.id, end: true });
  });

  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-nb]");
    if (!a || drag?.moved) return;
    const kind = a.dataset.nb;
    if (kind === "kidadd") { const p = find(a.dataset.parent)?.b; if (!p) return; const nx = blank(); p.children.push(nx); commit(); draw({ id: nx.id }); return; }
    const f = cur(a);
    if (!f) return;
    const b = f.b;
    if (kind === "check") { b.checked = !b.checked; commit(); draw(); return; }
    if (kind === "toggle") { if (open.has(b.id)) open.delete(b.id); else open.add(b.id); draw(); return; }
    if (kind === "icon") { iconMenu(b, a); return; }
    if (kind === "plus") {
      const nx = blank(); insertAfter(b.id, nx); commit(); draw({ id: nx.id });
      const el = textEl(nx.id);
      el.textContent = "/"; setCaret(el, 1); nx.text = "/";
      const sl = { id: nx.id, start: 0 };
      showMenu(filterKinds(""), el, (it) => slashPick(it, sl));
      slash = sl;
      return;
    }
    if (kind === "grip") { blockMenu(b, a); }
  });

  // ---------- перетаскивание за ⠿ ----------
  root.addEventListener("pointerdown", (e) => {
    const g = e.target.closest("[data-nb=grip]");
    if (!g || e.button > 0) return;
    const f = cur(g);
    if (!f) return;
    e.preventDefault();
    drag = { ids: section(f.b.id), sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, moved: false, target: null };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  function onMove(e) {
    if (!drag) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.moved) {
      if (Math.hypot(drag.x - drag.sx, drag.y - drag.sy) < 5) return;
      drag.moved = true;
      closeMenu();
      const src = blockEl(drag.ids[0]);
      const r = src.getBoundingClientRect();
      drag.ghost = src.cloneNode(true);
      drag.ghost.className += " nb-ghost";
      drag.ghost.style.width = Math.min(r.width, 520) + "px";
      if (drag.ids.length > 1) drag.ghost.insertAdjacentHTML("beforeend", `<div class="nb-ghost-n">${tr("+ ещё блоков: {n}", { n: drag.ids.length - 1 })}</div>`);
      drag.dx = Math.min(Math.max(drag.sx - r.left, 0), 40); drag.dy = Math.min(Math.max(drag.sy - r.top, 0), 24);
      document.body.append(drag.ghost);
      drag.line = Object.assign(document.createElement("div"), { className: "nb-drop" });
      document.body.append(drag.line);
      drag.ids.forEach((id) => blockEl(id)?.classList.add("nb-dragging"));
      document.body.classList.add("nb-dragmode");
      getSelection().removeAllRanges();
      const loop = () => {
        if (!drag?.moved) return;
        const edge = 70;
        const v = drag.y < edge ? -Math.ceil((edge - drag.y) / 5) : drag.y > innerHeight - edge ? Math.ceil((drag.y - innerHeight + edge) / 5) : 0;
        if (v) { window.scrollBy(0, v); aim(); }
        drag.raf = requestAnimationFrame(loop);
      };
      loop();
    }
    e.preventDefault();
    drag.ghost.style.left = drag.x - drag.dx + "px";
    drag.ghost.style.top = drag.y - drag.dy + "px";
    aim();
  }
  // куда встанет блок: ближайший блок под курсором (самый вложенный), выше или ниже его середины
  function aim() {
    const skip = drag.ids.map(blockEl).filter(Boolean);
    const els = [...root.querySelectorAll(".nb-b, .nb-empty")].filter((el) => !skip.some((s) => s.contains(el)));
    let best = null, bestDepth = -1, near = null, nearD = Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const depth = (() => { let d = 0, p = el.parentElement; while (p && p !== root) { if (p.classList.contains("nb-b")) d++; p = p.parentElement; } return d; })();
      if (drag.y >= r.top && drag.y <= r.bottom && depth >= bestDepth) { best = el; bestDepth = depth; }
      const d = drag.y < r.top ? r.top - drag.y : drag.y > r.bottom ? drag.y - r.bottom : 0;
      if (d < nearD && !el.classList.contains("nb-empty")) { near = el; nearD = d; }
    }
    const el = best || near;
    if (!el) { drag.target = null; drag.line.style.display = "none"; return; }
    let pos, rect;
    if (el.classList.contains("nb-empty")) { pos = "into"; rect = el.getBoundingClientRect(); }
    else {
      const row = el.querySelector(":scope > .nb-row").getBoundingClientRect(), full = el.getBoundingClientRect();
      // у подсказки и сворачиваемого блока «выше / ниже» решает их верхняя строка, остальное — их содержимое
      const mid = el.matches(".nb-callout, .nb-toggle") ? row.top + Math.min(row.height, 44) / 2 : full.top + full.height / 2;
      pos = drag.y < mid ? "before" : "after";
      rect = { left: row.left, width: row.width, top: pos === "before" ? full.top : full.bottom };
    }
    drag.target = { id: el.dataset.id || el.dataset.parent, pos };
    Object.assign(drag.line.style, {
      display: "block",
      left: rect.left + "px", width: rect.width + "px",
      top: (pos === "into" ? rect.top + rect.height / 2 : rect.top) - 1.5 + "px",
    });
  }
  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!drag) return;
    const d = drag;
    if (!d.moved) { drag = null; return; } // обычное нажатие — откроется меню блока (click)
    cancelAnimationFrame(d.raf);
    d.ghost.remove(); d.line.remove();
    document.body.classList.remove("nb-dragmode");
    setTimeout(() => { drag = null; }, 0); // click после отпускания не открывает меню
    const t = d.target;
    if (!t || d.ids.includes(t.id)) { draw(); return; }
    // вынуть блоки (в порядке на странице) и вставить у цели
    const moved = d.ids.map((id) => find(id)?.b).filter(Boolean);
    moved.forEach((b) => { const f = find(b.id); f.list.splice(f.i, 1); });
    const ft = find(t.id);
    if (!ft) { blocks.push(...moved); }
    else if (t.pos === "into") { (ft.b.children ||= []).push(...moved); if (ft.b.type === "toggle") open.add(ft.b.id); }
    else ft.list.splice(ft.i + (t.pos === "after" ? 1 : 0), 0, ...moved);
    // в контейнерах вложенность списков считается заново
    moved.forEach((b) => { if (b.indent) { const f = find(b.id); const prev = f.list[f.i - 1]; if (!prev || !LIST.has(prev.type)) b.indent = 0; } });
    if (!blocks.length) blocks.push(blank());
    commit(); draw();
    const el = blockEl(moved[0].id);
    el?.classList.add("nb-landed");
    setTimeout(() => el?.classList.remove("nb-landed"), 700);
  }

  const onDocDown = (e) => { if (menu && !menu.el.contains(e.target)) closeMenu(); };
  document.addEventListener("pointerdown", onDocDown, true);

  draw();
  opts.onHeadings?.(blocks.filter((b) => b.type === "h1" && b.text.trim()).map((b) => ({ id: b.id, text: b.text })));

  return {
    // панель для телефона: действия над блоком, где стоит каретка
    act(kind, anchor) {
      const id = (document.activeElement?.closest?.(".nb-b") || root.querySelector(".nb-b.focus"))?.dataset.id;
      const f = id && find(id);
      if (!f) return;
      const el = textEl(f.b.id);
      if (el && TEXT.has(f.b.type)) f.b.text = htmlToInline(el);
      const off = el ? caretOffset(el) : 0;
      if (kind === "add") { showMenu(filterKinds(""), anchor, (it) => applyKind(f.b, it.type)); return; }
      if (kind === "menu") { blockMenu(f.b, anchor); return; }
      if (kind === "in" || kind === "out") { if (indent(f.b, kind === "in" ? 1 : -1)) { commit(); draw({ id: f.b.id, off }); } else place({ id: f.b.id, off }); return; }
      if (kind === "up" || kind === "down") { moveBy(f.b.id, kind === "up" ? -1 : 1); return; }
      if (kind === "bold") { place({ id: f.b.id, off }); document.execCommand("bold"); }
    },
    focusHeading(id) { blockEl(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); },
    undo() { back(undo, redo); },
    destroy() { closeMenu(); document.removeEventListener("pointerdown", onDocDown, true); clearTimeout(typingT); commit(); },
  };
}
