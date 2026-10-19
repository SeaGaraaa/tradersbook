// Выгрузка чек-листа в PNG и PDF в стиле приложения (тёмный фон, зелёный акцент, логотип TB).
// Рисуем на canvas; PDF собирается из JPEG-кадров этого же рисунка, по листам A4, без внешних библиотек.
import * as CL from "./checklist.js";
import { fmtDT } from "./util.js";
import { t as tr } from "./i18n.js";

const W = 1240; // ширина листа: A4 при 150 dpi
const PAGE_H = Math.round(W * 297 / 210);
const PAD = 72;
const C = {
  bg: "#090a0c", panel: "#15171c", line: "#262a33", text: "#e9ebef", muted: "#8a93a3",
  accent: "#4adaa3", win: "#22c55e", lose: "#ef4444",
};
const FONT = '-apple-system, "Segoe UI", Roboto, Arial, sans-serif';

let logoP = null;
function logo() {
  logoP ||= new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = "icons/tb-checklist.png";
  });
  return logoP;
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Отметка: ✓ зелёная, ✗ красная, пусто — серая рамка (бланк для печати).
function box(ctx, x, y, s, state) {
  const col = state === "yes" ? C.accent : state === "no" ? C.lose : C.muted;
  ctx.lineWidth = 3;
  ctx.strokeStyle = col;
  roundRect(ctx, x, y, s, s, 6);
  ctx.stroke();
  ctx.lineCap = "round";
  ctx.lineWidth = 4;
  ctx.beginPath();
  if (state === "yes") {
    ctx.moveTo(x + s * 0.24, y + s * 0.52); ctx.lineTo(x + s * 0.43, y + s * 0.7); ctx.lineTo(x + s * 0.76, y + s * 0.3);
  } else if (state === "no") {
    ctx.moveTo(x + s * 0.28, y + s * 0.28); ctx.lineTo(x + s * 0.72, y + s * 0.72);
    ctx.moveTo(x + s * 0.72, y + s * 0.28); ctx.lineTo(x + s * 0.28, y + s * 0.72);
  }
  ctx.stroke();
}

// run: { at, pair, setup, setupName, verdict, yes[], no[], note }
// Раскладка: draw=false — только считаем высоту и места, где можно резать страницы.
function layout(ctx, run, img, draw) {
  const d = CL.current();
  const inner = W - PAD * 2;
  const breaks = [];
  let y = PAD;
  const T = (text, x, yy, size, color, weight = 400) => {
    if (!draw) return;
    ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillStyle = color; ctx.textBaseline = "top"; ctx.fillText(text, x, yy);
  };

  // шапка: логотип, название, дата
  const L = 120;
  if (draw && img) ctx.drawImage(img, PAD, y, L, L);
  T("Trader'sBook", PAD + L + 28, y + 14, 46, C.text, 700);
  T(tr("Чек-лист перед входом"), PAD + L + 28, y + 70, 28, C.accent, 600);
  const when = run.at ? fmtDT(run.at) : "";
  if (draw && when) { ctx.font = `400 26px ${FONT}`; ctx.fillStyle = C.muted; ctx.textAlign = "right"; ctx.textBaseline = "top"; ctx.fillText(when, W - PAD, y + 20); ctx.textAlign = "left"; }
  y += L + 36;

  // карточка с активом, сетапом и итогом
  const setup = CL.setupById(run.setup);
  const verdict = run.verdict || "";
  const vcol = verdict === "Можно торговать" ? C.accent : verdict === "Сделки нет" ? C.lose : C.muted;
  const boxH = 132;
  if (draw) { ctx.fillStyle = C.panel; roundRect(ctx, PAD, y, inner, boxH, 18); ctx.fill(); ctx.strokeStyle = vcol; ctx.lineWidth = 2; ctx.stroke(); }
  // колонки по ширине текста: итог прижат вправо, сетап занимает остаток и при нехватке места сокращается
  const left = PAD + 32, right = PAD + inner - 32;
  const fit = (text, maxW, size, min) => { // шрифт поменьше, потом «…», чтобы текст влез
    let s = size;
    ctx.font = `700 ${s}px ${FONT}`;
    while (ctx.measureText(text).width > maxW && s > min) { s -= 2; ctx.font = `700 ${s}px ${FONT}`; }
    let v = text;
    while (ctx.measureText(v).width > maxW && v.length > 2) v = v.slice(0, -2) + "…";
    return { v, s };
  };
  const vText = verdict ? tr(verdict) : tr("бланк");
  const vf = fit(vText, 380, 32, 24);
  ctx.font = `700 ${vf.s}px ${FONT}`;
  const vW = ctx.measureText(vf.v).width;
  const col = (label, value, x, maxW) => {
    T(label, x, y + 24, 20, C.muted, 600);
    if (!draw) return;
    const f = fit(value || "—", maxW, 32, 24);
    ctx.font = `700 ${f.s}px ${FONT}`; ctx.fillStyle = C.text; ctx.textBaseline = "top";
    ctx.fillText(f.v, x, y + 58 + (32 - f.s) / 2);
  };
  // сетап не выбран — колонки «Сетап» на картинке нет вовсе
  const setupName = setup?.name || run.setupName || "";
  col(tr("АКТИВ"), run.pair, left, setupName ? 210 : right - Math.max(vW, 80) - 48 - left);
  const setupX = left + 240;
  if (setupName) col(tr("СЕТАП"), setupName, setupX, right - Math.max(vW, 80) - 48 - setupX);
  if (draw) {
    ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.font = `600 20px ${FONT}`; ctx.fillStyle = C.muted; ctx.fillText(tr("ИТОГ"), right, y + 24);
    ctx.font = `700 ${vf.s}px ${FONT}`; ctx.fillStyle = vcol; ctx.fillText(vf.v, right, y + 58 + (32 - vf.s) / 2);
    ctx.textAlign = "left";
  }
  y += boxH + 28;

  // правило пользователя: сколько «нет» запрещают сделку
  {
    ctx.font = `600 22px ${FONT}`;
    T(tr("Сделки нет при {n} «нет» и больше", { n: CL.limit() }), PAD, y, 22, C.accent, 600);
    y += 34;
  }
  if (d.note) {
    ctx.font = `400 22px ${FONT}`;
    for (const line of wrap(ctx, d.note, inner)) { T(line, PAD, y, 22, C.muted); y += 32; }
    y += 10;
  }
  breaks.push(y);

  const S = 34, gap = 22, textX = PAD + S + gap, textW = inner - S - gap;
  const state = (id) => (run.yes.includes(id) ? "yes" : run.no.includes(id) ? "no" : "");
  const section = (title, items, sub = "") => {
    y += 18;
    T(title.toUpperCase(), PAD, y, 22, C.muted, 700);
    if (sub && draw) { ctx.font = `700 22px ${FONT}`; const w = ctx.measureText(title.toUpperCase()).width; T(sub, PAD + w + 12, y, 22, C.muted, 400); }
    y += 40;
    breaks.push(y);
    for (const [id, text] of items) {
      ctx.font = `400 26px ${FONT}`;
      const lines = wrap(ctx, text, textW);
      const h = Math.max(S, lines.length * 36) + 20;
      if (draw) {
        ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
        box(ctx, PAD, y + 12, S, state(id));
      }
      const st = state(id);
      lines.forEach((ln, i) => T(ln, textX, y + 14 + i * 36, 26, st === "no" ? C.lose : st === "yes" ? C.text : C.text));
      y += h;
      breaks.push(y);
    }
  };

  for (const g of d.general) section(g.title, g.items);
  if (setup) {
    section(setup.name, setup.items, setup.entry ? `— ${setup.entry}` : "");
    if (setup.no) {
      ctx.font = `400 22px ${FONT}`;
      y += 6;
      for (const line of wrap(ctx, setup.no, inner)) { T(line, PAD, y, 22, C.lose); y += 32; }
      breaks.push(y);
    }
  }
  // «нет» по пунктам, которых уже нет в шаблоне
  const known = new Set([...d.general.flatMap((g) => g.items.map(([id]) => id)), ...(setup?.items.map(([id]) => id) || [])]);
  const extra = run.no.filter((id) => !known.has(id)).map((id) => [id, CL.itemText(id)]);
  if (extra.length) section(tr("Другие невыполненные пункты"), extra);

  if (run.note) {
    y += 24;
    T(tr("ЗАМЕТКА"), PAD, y, 22, C.muted, 700);
    y += 40;
    ctx.font = `400 26px ${FONT}`;
    for (const line of wrap(ctx, run.note, inner)) { T(line, PAD, y, 26, C.text); y += 36; breaks.push(y); }
  }

  y += 40;
  T("Trader'sBook · seagaraaa.github.io/tradersbook", PAD, y, 20, C.muted);
  y += 30 + PAD;
  breaks.push(y);
  return { height: y, breaks };
}

async function render(run) {
  const img = await logo();
  const probe = document.createElement("canvas").getContext("2d");
  const { height, breaks } = layout(probe, run, img, false);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = Math.ceil(height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, canvas.height);
  layout(ctx, run, img, true);
  return { canvas, breaks };
}

const fileName = (run, ext) => {
  const when = run.at ? fmtDT(run.at).replace(/(\d+)\.(\d+)\.(\d+) (\d+):(\d+)/, "$3-$2-$1_$4$5") : "blank";
  return `TB-checklist_${when}${run.pair ? "_" + run.pair : ""}.${ext}`;
};

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

export async function exportPNG(run) {
  const { canvas } = await render(run);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  download(blob, fileName(run, "png"));
}

// Страницы режем по границам пунктов, чтобы строка не разрывалась между листами.
function pageCuts(height, breaks) {
  const cuts = [0];
  let start = 0;
  // на первом листе — весь лист, на следующих — с отступом сверху и снизу
  const cap = () => (start === 0 ? PAGE_H : PAGE_H - PAD);
  while (height - start > cap()) {
    const fit = breaks.filter((b) => b > start + 200 && b <= start + cap());
    const end = fit.length ? Math.max(...fit) : start + cap();
    cuts.push(end);
    start = end;
  }
  cuts.push(height);
  return cuts;
}

export async function exportPDF(run) {
  const { canvas, breaks } = await render(run);
  const cuts = pageCuts(canvas.height, breaks);
  const pages = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const page = document.createElement("canvas");
    page.width = W;
    page.height = PAGE_H; // каждый лист — полный A4, остаток залит фоном
    const ctx = page.getContext("2d");
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, PAGE_H);
    const h = cuts[i + 1] - cuts[i];
    ctx.drawImage(canvas, 0, cuts[i], W, h, 0, i ? PAD / 2 : 0, W, h);
    const blob = await new Promise((r) => page.toBlob(r, "image/jpeg", 0.92));
    pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), w: W, h: PAGE_H });
  }
  download(new Blob([buildPdf(pages)], { type: "application/pdf" }), fileName(run, "pdf"));
}

// Минимальный PDF: на каждой странице одна JPEG-картинка во весь лист A4.
export function buildPdf(pages) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n, body) => { offsets[n] = size; push(`${n} 0 obj\n`); body(); push("\nendobj\n"); };
  const PW = 595.28, PH = 841.89;
  const n = pages.length;
  // 1 — каталог, 2 — список страниц, далее на каждую страницу: страница, содержимое, картинка
  const pageObj = (i) => 3 + i * 3;
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>`));
  pages.forEach((p, i) => {
    const po = pageObj(i);
    obj(po, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im${i} ${po + 2} 0 R >> >> /Contents ${po + 1} 0 R >>`));
    const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im${i} Do Q`;
    obj(po + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(po + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
      push(p.bytes);
      push("\nendstream");
    });
  });
  const total = 3 + n * 3;
  const xref = size;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}
