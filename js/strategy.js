// Торговая стратегия пользователя: простой Markdown + блоки как в Notion.
//   # / ## / ###        заголовки (# — разделы, по ним строится оглавление)
//   - пункт, 1. пункт   списки; вложенность — табуляция или 2 пробела
//   - [ ] пункт         пункт-галочка
//   **жирный**, *курсив*, `код`, [текст](ссылка)
//   ![](ссылка)         картинка (Google Drive, обычная ссылка или img:имя_файла — ещё не загружена)
//   :::callout ⚠️ … :::  блок-подсказка (как RISK / INVALIDATION в Notion)
//   :::details Открыть … :::  сворачиваемый блок
//   ---                 разделитель
import { esc, driveId } from "./util.js";

function inline(s) {
  const keep = [];
  const stash = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let t = String(s).replace(/\\([\\`*_[\]()#>!-])/g, (_, c) => stash(esc(c))); // \> \: и т. п.
  t = t.replace(/\\:/g, ":");
  t = t.replace(/`([^`]+)`/g, (_, c) => stash(`<code>${esc(c)}</code>`));
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, txt, url) => stash(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(txt)}</a>`));
  t = esc(t);
  t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<i>$2</i>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}

// Картинка: Drive — грузится с токеном (data-drive), img:имя — заглушка «не загружена».
export function imageHtml(src) {
  const s = String(src).trim();
  if (s.startsWith("img:")) {
    return `<div class="st-img missing" data-missing="${esc(s.slice(4))}"><span>🖼</span><span>${esc(s.slice(4))}</span></div>`;
  }
  const id = driveId(s);
  if (id) return `<img class="st-img" data-drive="${esc(id)}" data-img="${esc(s)}" alt="">`;
  if (/^https?:\/\//.test(s)) return `<img class="st-img" src="${esc(s)}" data-img="${esc(s)}" alt="" loading="lazy">`;
  return "";
}

const slug = (t, i) => "st-" + i;

// Markdown -> { html, toc: [{ id, title }], missing: [имена картинок img:…] }
export function render(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const toc = [];
  const missing = new Set();
  const lists = []; // стек открытых списков: { tag, level }
  const blocks = []; // стек :::details / :::callout
  let h1 = 0;

  const closeLists = (toLevel = -1) => {
    while (lists.length && lists[lists.length - 1].level > toLevel) out.push(`</li></${lists.pop().tag}>`);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { closeLists(); continue; }

    const blk = line.trim().match(/^:::(callout|details)\s*(.*)$/);
    if (blk) {
      closeLists();
      if (blk[1] === "callout") { out.push(`<div class="st-callout"><span class="st-callout-icon">${esc(blk[2] || "💡")}</span><div class="st-callout-body">`); blocks.push("callout"); }
      else { out.push(`<details class="st-details"><summary>${inline(blk[2] || "…")}</summary><div class="st-details-body">`); blocks.push("details"); }
      continue;
    }
    if (line.trim() === ":::") {
      closeLists();
      const b = blocks.pop();
      if (b === "callout") out.push("</div></div>");
      else if (b === "details") out.push("</div></details>");
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeLists();
      const lvl = h[1].length;
      if (lvl === 1) { const id = slug(h[2], h1++); toc.push({ id, title: h[2].replace(/\\(.)/g, "$1") }); out.push(`<h2 class="st-h1" id="${id}">${inline(h[2])}</h2>`); }
      else out.push(`<h${lvl + 1} class="st-h${lvl}">${inline(h[2])}</h${lvl + 1}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeLists(); out.push('<hr class="st-hr">'); continue; }

    const img = line.trim().match(/^!\[[^\]]*\]\(([^)]+)\)$/);
    if (img) {
      closeLists();
      if (img[1].startsWith("img:")) missing.add(img[1].slice(4));
      out.push(`<figure class="st-fig">${imageHtml(img[1])}</figure>`);
      continue;
    }

    const li = line.match(/^(\t*|\s*)([-*]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
    if (li) {
      const indent = li[1].replace(/ {2}/g, "\t").replace(/ /g, "").length;
      const tag = /\d/.test(li[2]) ? "ol" : "ul";
      const top = lists[lists.length - 1];
      if (!top || indent > top.level) { out.push(`<${tag} class="st-list">`); lists.push({ tag, level: indent }); }
      else {
        closeLists(indent);
        const cur = lists[lists.length - 1];
        if (!cur || cur.tag !== tag) { closeLists(indent - 1); out.push(`<${tag} class="st-list">`); lists.push({ tag, level: indent }); }
        else out.push("</li>");
      }
      const box = li[3] ? `<span class="st-check ${/x/i.test(li[3]) ? "on" : ""}"></span>` : "";
      out.push(`<li${box ? ' class="st-li-check"' : ""}>${box}${inline(li[4])}`);
      continue;
    }

    closeLists();
    out.push(`<p>${inline(line.trim())}</p>`);
  }
  closeLists();
  while (blocks.length) out.push(blocks.pop() === "callout" ? "</div></div>" : "</div></details>");
  return { html: out.join("\n"), toc, missing: [...missing] };
}

// Подставить загруженные картинки вместо img:имя (имя файла без учёта регистра).
export function replaceImage(md, name, url) {
  const re = new RegExp(`!\\[([^\\]]*)\\]\\(img:${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "gi");
  return md.replace(re, `![$1](${url})`);
}

// Шаблон для нового пользователя.
export const TEMPLATE = {
  ru: `# Правила
## Принципы
-
# Торговые пары
-
# Risk Management
:::callout ⚠️
**RISK**
- Риск на сделку:
- Максимум стопов в день:
- Максимум сделок в день:
:::
# Сетапы
## Название сетапа
:::details Открыть
- Условия:
- Вход:
- Stop Loss:
- Take Profit:
:::
`,
  en: `# Rules
## Principles
-
# Trading pairs
-
# Risk Management
:::callout ⚠️
**RISK**
- Risk per trade:
- Max stop-losses per day:
- Max trades per day:
:::
# Setups
## Setup name
:::details Open
- Conditions:
- Entry:
- Stop Loss:
- Take Profit:
:::
`,
};
