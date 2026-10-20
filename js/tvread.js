// Распознавание скриншота TradingView: актив, направление, время входа (для карточки сделки).
// ИИ (Gemini или Claude, ключ из настроек AI) только ЧИТАЕТ картинку: подписи, положение подписей шкалы времени,
// левый край инструмента позиции, цены. Время входа считает код: интерполяция по шкале времени и округление до свечи.
import { visionJSON } from "./ai.js";

const PROMPT = `You read a TradingView chart screenshot for a trading journal. Report ONLY what is actually visible. Never guess.
Return ONE JSON object:
{
 "title_text": "exact text of the chart title at the top-left, e.g. 'Gold / U.S. Dollar · 5 · OANDA' (any language)",
 "symbol": "instrument ticker as traded, e.g. XAUUSD, EURUSD, GER40, NAS100, BTCUSD — prefer the ticker printed on the price scale label; if only a description is shown, convert it (Gold / U.S. Dollar -> XAUUSD, Euro / U.S. Dollar -> EURUSD, DAX -> GER40)",
 "timeframe": "chart interval as printed in the title, e.g. 1, 3, 5, 15, 30, 1H, 4H, 1D",
 "header_text": "exact text of the top header line with the snapshot date/time and UTC offset, or null",
 "chart_utc_offset": "UTC offset of the chart time zone if printed anywhere (header 'UTC+3' or the time zone at the bottom right), e.g. '+3', '-4', '0', else null",
 "position_tool": {
   "found": true/false,
   "side": "long" if the green (profit) zone is ABOVE the entry line, "short" if the green zone is BELOW,
   "left_x": horizontal position of the LEFT edge of the long/short position box (= entry candle), as an integer 0-1000 of the image width,
   "top_y": vertical position of the TOP edge of the whole position box (both zones), integer 0-1000 of the image height,
   "bottom_y": vertical position of the BOTTOM edge of the whole position box, integer 0-1000 of the image height,
   "entry_price": number or null, "stop_price": number or null, "target_price": number or null
 },
 "time_axis": [ {"text": "label exactly as printed", "x": integer 0-1000 = horizontal center of that label} ... every label on the bottom time axis, left to right ],
 "time_axis_y": vertical center of the bottom time-axis labels, integer 0-1000 of the image height,
 "entry_time_label": "if a date/time label is explicitly printed AT the entry (crosshair label on the time axis, a note or text), its exact text, else null"
}
Coordinates are relative to the whole image width (0 = left edge of the image, 1000 = right edge). Be precise with coordinates.
If there are several position boxes, use the one that is most to the right. If there is no position box, set found=false.`;

// ИИ иногда отвечает «перегружено» — до трёх попыток с паузой.
export async function readShot(image, settings) {
  for (let i = 0; ; i++) {
    try { return await visionJSON(PROMPT, image, settings); } catch (e) {
      if (i >= 2 || !/high demand|overloaded|503|UNAVAILABLE|try again later/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 8000 * (i + 1)));
    }
  }
}

// ---------- точная донастройка по пикселям ----------
// img: { width, height, data: RGBA }. ИИ даёт приблизительные координаты, здесь находим точные:
// левый край прямоугольника позиции (ровный вертикальный перепад цвета) и центры подписей шкалы времени.
const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

export function refineEdge(img, raw) {
  const pt = raw.position_tool || {};
  if (!pt.found || !Number.isFinite(+pt.left_x)) return null;
  const W = img.width, H = img.height;
  const ex = Math.round(+pt.left_x / 1000 * W);
  let y0 = Math.round((+pt.top_y || 0) / 1000 * H), y1 = Math.round((+pt.bottom_y || 1000) / 1000 * H);
  if (!(y1 > y0 + 10)) return null;
  const pad = Math.round((y1 - y0) * 0.12);
  y0 = Math.max(1, y0 + pad); y1 = Math.min(H - 2, y1 - pad);
  const span = Math.max(6, Math.round(W * 0.012)); // ИИ ошибается меньше чем на ~1% — дальше искать не нужно
  let best = null;
  for (let x = Math.max(3, ex - span); x <= Math.min(W - 4, ex + span); x++) {
    let hits = 0, n = 0;
    for (let y = y0; y <= y1; y += 2) {
      n++;
      // слева от края цвет фона/свечей, справа — заливка прямоугольника: перепад и одинаковость справа
      const L = px(img, x - 2, y), R = px(img, x + 1, y), R2 = px(img, x + 3, y);
      if (diff(L, R) > 18 && diff(R, R2) < 24) hits++;
    }
    const score = hits / n - Math.abs(x - ex) / span * 0.35; // ближе к оценке ИИ — лучше
    if (!best || score > best.score) best = { x, score, frac: hits / n };
  }
  return best && best.frac > 0.45 ? best.x / W * 1000 : null;
}

export function refineAxis(img, raw) {
  const ax = raw.time_axis || [];
  if (!ax.length || !Number.isFinite(+raw.time_axis_y)) return null;
  const W = img.width, H = img.height;
  const yc = Math.round(+raw.time_axis_y / 1000 * H), h = Math.max(4, Math.round(H * 0.012));
  const rows = [];
  for (let y = Math.max(0, yc - h); y <= Math.min(H - 1, yc + h); y++) rows.push(y);
  // цвет фона полосы — самый частый
  const counts = new Map();
  for (const y of rows) for (let x = 0; x < W; x += 3) { const c = px(img, x, y).map((v) => v >> 4).join(","); counts.set(c, (counts.get(c) || 0) + 1); }
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map((v) => (+v << 4) + 8);
  const ink = new Array(W).fill(0);
  for (let x = 0; x < W; x++) for (const y of rows) if (diff(px(img, x, y), bg) > 90) { ink[x] = 1; break; }
  // подписи = группы колонок с «чернилами», разрыв больше ~0.8% ширины — новая подпись
  const gap = Math.max(4, Math.round(W * 0.008)), blobs = [];
  let s = -1, last = -1;
  for (let x = 0; x < W; x++) if (ink[x]) { if (s < 0 || x - last > gap) { if (s >= 0) blobs.push((s + last) / 2); s = x; } last = x; }
  if (s >= 0) blobs.push((s + last) / 2);
  const tol = W * 0.035;
  const used = new Set();
  return ax.map((a) => {
    const x = +a.x / 1000 * W;
    let bi = -1, bd = Infinity;
    blobs.forEach((b, i) => { const d = Math.abs(b - x); if (d < bd && !used.has(i)) { bd = d; bi = i; } });
    if (bi >= 0 && bd <= tol) { used.add(bi); return { ...a, x: blobs[bi] / W * 1000 }; }
    return a;
  });
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  янв: 0, фев: 1, мар: 2, апр: 3, май: 4, мая: 4, июн: 5, июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11,
};
const monthOf = (s) => { const k = String(s).toLowerCase().replace(/[^a-zа-яё]/g, "").slice(0, 3); return k in MONTHS ? MONTHS[k] : null; };

// «Oct 18, 2026 16:06 UTC+3» / «Окт 18, 2026» / «18 окт. 2026» -> {y, m, d}
function parseHeaderDate(s) {
  if (!s) return null;
  const t = String(s);
  let m = t.match(/([A-Za-zА-Яа-яё]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && monthOf(m[1]) != null) return { y: +m[3], m: monthOf(m[1]), d: +m[2] };
  m = t.match(/(\d{1,2})\s+([A-Za-zА-Яа-яё]{3,})\.?,?\s+(\d{4})/);
  if (m && monthOf(m[2]) != null) return { y: +m[3], m: monthOf(m[2]), d: +m[1] };
  m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { y: +m[1], m: +m[2] - 1, d: +m[3] };
  return null;
}

const tfMinutes = (tf) => {
  // английские и русские подписи TradingView: 5, 15м, 1H, 1ч, 4ч, 1D, 1Д, 1W, 1Н
  const s = String(tf || "").trim().toUpperCase().replace(/МИН\.?$/, "M").replace(/М$/, "M").replace(/Ч$/, "H").replace(/Д$/, "D").replace(/Н$/, "W");
  let m = s.match(/^(\d+)\s*(M|MIN)?$/); if (m) return +m[1];
  m = s.match(/^(\d+)\s*H$/); if (m) return +m[1] * 60;
  m = s.match(/^H(\d+)$/); if (m) return +m[1] * 60;
  m = s.match(/^(\d*)\s*D$/); if (m) return (+m[1] || 1) * 1440;
  m = s.match(/^(\d*)\s*W$/); if (m) return (+m[1] || 1) * 10080;
  m = s.match(/^M(\d+)$/); if (m) return +m[1];
  return 0;
};

// Метки шкалы -> точки (x, минуты от начала дня по UTC-полям, в часовом поясе графика).
function axisPoints(axis, ref) {
  const items = (axis || []).filter((a) => a && a.text != null && Number.isFinite(+a.x)).map((a) => ({ text: String(a.text).trim(), x: +a.x })).sort((a, b) => a.x - b.x);
  // даты: «12», «Oct», «Окт», «2026», «12 Oct»
  const firstDay = items.findIndex((a) => /^\d{1,2}$/.test(a.text) || monthOf(a.text) != null || /^\d{1,2}\s+\S+/.test(a.text));
  let y = ref.y, mo = ref.m;
  // первая метка-день: её месяц — месяц скриншота, если день не позже дня скриншота, иначе предыдущий
  const dayVal = (a) => { const m = a.text.match(/^(\d{1,2})/); return m ? +m[1] : null; };
  if (firstDay >= 0) {
    const d0 = dayVal(items[firstDay]);
    const mm = monthOf(items[firstDay].text.replace(/^\d+\s*/, ""));
    if (mm != null && !/^\d{1,2}$/.test(items[firstDay].text)) { mo = mm; if (mo > ref.m) y = ref.y - 1; }
    else if (d0 != null && d0 > ref.d) { mo = ref.m - 1; if (mo < 0) { mo = 11; y = ref.y - 1; } }
  }
  const pts = [];
  let day = null, prevD = null;
  for (const a of items) {
    const tm = a.text.match(/^(\d{1,2}):(\d{2})$/);
    const dv = dayVal(a), mv = monthOf(a.text.replace(/^\d+\s*/, ""));
    if (!tm && (dv != null || mv != null)) {
      if (mv != null && dv == null) { if (mv < mo) y++; mo = mv; day = 1; }
      else { if (prevD != null && dv < prevD) { mo++; if (mo > 11) { mo = 0; y++; } } day = dv; }
      prevD = day;
      pts.push({ x: a.x, ms: Date.UTC(y, mo, day) });
      continue;
    }
    if (tm) {
      let d = day;
      if (d == null) { // время левее первой метки дня — предыдущий торговый день
        const nd = firstDay >= 0 ? dayVal(items[firstDay]) || 1 : ref.d;
        const base = new Date(Date.UTC(y, mo, nd));
        base.setUTCDate(base.getUTCDate() - (base.getUTCDay() === 1 ? 3 : 1));
        pts.push({ x: a.x, ms: Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), +tm[1], +tm[2]) });
        continue;
      }
      pts.push({ x: a.x, ms: Date.UTC(y, mo, d, +tm[1], +tm[2]) });
    }
  }
  return pts.sort((a, b) => a.x - b.x);
}

const pad = (n) => String(n).padStart(2, "0");

// Явная подпись времени («Mon 12 Oct '26 13:35», «12 окт 2026 13:35», «2026-10-12 13:35»)
function parseExplicit(s, ref) {
  if (!s) return null;
  const t = String(s);
  const hm = t.match(/(\d{1,2}):(\d{2})/);
  if (!hm) return null;
  const d = parseHeaderDate(t.replace(/'(\d{2})\b/, "20$1")) || (() => { const m = t.match(/(\d{1,2})\s+([A-Za-zА-Яа-яё]{3,})/); return m && monthOf(m[2]) != null ? { y: ref.y, m: monthOf(m[2]), d: +m[1] } : null; })();
  if (!d) return null;
  return Date.UTC(d.y, d.m, d.d, +hm[1], +hm[2]);
}

// Итог: { pair, dir, tf, utcMs (момент входа), dateText (время графика), how, entry, sl, tp }
export function entryFromShot(raw, now = new Date(), img = null) {
  if (img) { // уточнить координаты по пикселям картинки
    const ax = refineAxis(img, raw);
    const ex = refineEdge(img, raw);
    raw = { ...raw, time_axis: ax || raw.time_axis, position_tool: ex != null ? { ...raw.position_tool, left_x: ex } : raw.position_tool, refined: { axis: !!ax, edge: ex != null } };
  }
  const ref = parseHeaderDate(raw.header_text) || { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
  const off = raw.chart_utc_offset != null && /^[+-]?\d+(\.\d+)?$/.test(String(raw.chart_utc_offset).replace(/^UTC/i, "").trim())
    ? parseFloat(String(raw.chart_utc_offset).replace(/^UTC/i, "")) : null;
  const pt = raw.position_tool || {};
  const sym = String(raw.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const out = { pair: sym || "", dir: pt.found ? (pt.side === "short" ? "Short" : pt.side === "long" ? "Long" : "") : "", tf: raw.timeframe || "",
    entry: pt.entry_price ?? null, sl: pt.stop_price ?? null, tp: pt.target_price ?? null, how: "none", chartMs: null, utcMs: null, offset: off };
  const tfm = tfMinutes(raw.timeframe);
  let chartMs = parseExplicit(raw.entry_time_label, ref);
  if (chartMs != null) out.how = "label";
  else if (pt.found && Number.isFinite(+pt.left_x)) {
    const pts = axisPoints(raw.time_axis, ref);
    const x = +pt.left_x;
    // две ближайшие метки по обе стороны (или две крайние, если вход за краем шкалы)
    let a = null, b = null;
    for (let i = 0; i < pts.length - 1; i++) if (pts[i].x <= x && pts[i + 1].x >= x) { a = pts[i]; b = pts[i + 1]; }
    if (!a && pts.length >= 2) [a, b] = x < pts[0].x ? [pts[0], pts[1]] : [pts[pts.length - 2], pts[pts.length - 1]];
    if (a && b && b.x > a.x && b.ms > a.ms) {
      // выходные TradingView не рисует: если между метками скачок больше суток, берём соседний отрезок
      if (b.ms - a.ms > 30 * 3600e3) {
        const i = pts.indexOf(b);
        const c = pts[i + 1];
        const per = c && c.ms > b.ms ? (c.ms - b.ms) / (c.x - b.x) : null;
        chartMs = per ? b.ms - (b.x - x) * per : a.ms + (x - a.x) * (b.ms - a.ms) / (b.x - a.x);
      } else chartMs = a.ms + (x - a.x) * (b.ms - a.ms) / (b.x - a.x);
      // точность: ~4 пикселя ошибки по горизонтали, но не меньше одной свечи
      const msPerUnit = (b.ms - a.ms) / (b.x - a.x), unitsPerPx = 1000 / (img?.width || 1600);
      out.approxMin = Math.max(tfm || 1, Math.round(msPerUnit * unitsPerPx * 4 / 60e3 / (tfm || 1)) * (tfm || 1));
      if (tfm) chartMs = Math.round(chartMs / (tfm * 60e3)) * tfm * 60e3;
      out.how = "axis";
    }
  }
  if (chartMs != null) {
    out.chartMs = chartMs;
    out.utcMs = off != null ? chartMs - off * 3600e3 : null; // без пояса — считаем, что график во времени устройства
    const d = new Date(chartMs);
    out.dateText = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  return out;
}
