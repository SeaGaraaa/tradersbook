// Тикет сделки MT5 картинкой — как карточка в истории MT5 на телефоне.
// Данные пишет автоперенос с компьютера (tools/journal_sync/sync.py) в колонку Y «MT5» журнала (JSON).
import { esc } from "./util.js";
import { t as tr } from "./i18n.js";

export function parse(raw) {
  if (!raw) return null;
  try {
    const d = typeof raw === "string" ? JSON.parse(raw) : raw;
    return d && d.sym && Number.isFinite(+d.in) && Number.isFinite(+d.out) ? d : null;
  } catch { return null; }
}

// 1 116.00 — пробел между тысячами, как в MT5
function money(x) {
  const s = Math.abs(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return (x < 0 ? "-" : "") + s;
}
const price = (x, dg) => (+x).toFixed(dg);

const C = {
  sellHead: "#2c0806", buyHead: "#08203f", body: "#1c1c1e",
  white: "#f2f2f2", grey: "#8e8e93", text: "#d1d1d6", red: "#e8574a", blue: "#3f8cff",
};

// PNG (data URL) карточки тикета. Ширина 1270 px — чётко на телефоне и на компьютере.
export function png(d) {
  const W = 1270, H = 560, P = 16;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const font = (px, w = 400) => `${w} ${px}px -apple-system, "SF Pro Text", "Segoe UI", Roboto, Arial, sans-serif`;
  const sell = d.side === "sell";
  const sign = sell ? -1 : 1;
  const dg = Number.isFinite(+d.dg) ? +d.dg : 5;
  const diff = (+d.out - +d.in) * sign;
  const pts = d.pt ? Math.round(diff / d.pt) : null;
  const pct = (+d.out - +d.in) / +d.in * 100 * sign;
  const pl = +d.pl || 0;
  const plColor = pl < 0 ? C.red : C.blue;

  // фон с закруглением
  g.fillStyle = C.body;
  g.beginPath(); g.roundRect(0, 0, W, H, 28); g.fill();
  g.save(); g.beginPath(); g.roundRect(0, 0, W, H, 28); g.clip();
  g.fillStyle = sell ? C.sellHead : C.buyHead; g.fillRect(0, 0, W, 155);
  g.restore();

  // шапка: символ, сторона и объём, описание, номер
  g.textBaseline = "alphabetic";
  g.fillStyle = C.white; g.font = font(44, 700);
  g.fillText(d.sym, P, 66);
  const sw = g.measureText(d.sym + " ").width;
  g.fillStyle = sell ? C.red : C.blue; g.font = font(44, 600);
  g.fillText(`${d.side} ${d.vol}`, P + sw, 66);
  g.fillStyle = C.grey; g.font = font(34);
  if (d.desc) g.fillText(d.desc, P, 122);
  g.textAlign = "right"; g.font = font(34);
  g.fillText(`#${d.t}`, W - P - 14, 58);

  // цены и результат
  g.textAlign = "left"; g.fillStyle = C.text; g.font = font(38);
  g.fillText(`${price(d.in, dg)} → ${price(d.out, dg)}`, P, 220);
  g.textAlign = "right"; g.fillStyle = plColor; g.font = font(48, 700);
  g.fillText(money(pl), W - P - 14, 230);
  g.textAlign = "left"; g.fillStyle = diff < 0 ? C.red : C.blue; g.font = font(34);
  const pctTxt = `${pct < 0 ? "-" : ""}${Math.abs(pct).toFixed(2)}%`;
  g.fillText(`Δ = ${pts == null ? "" : pts + " "}(${pctTxt})`, P, 282);

  // время (сервер MT5)
  g.fillStyle = C.text; g.font = font(34);
  g.fillText(`${d.o} → ${d.c}`, P, 368);

  // SL / TP / своп / комиссии
  const row = (y, l1, v1, c1, l2, v2) => {
    g.textAlign = "left"; g.fillStyle = C.grey; g.font = font(34);
    g.fillText(l1, P, y); g.fillText(l2, 628, y);
    g.fillStyle = c1; g.fillText(v1, 345, y);
    g.textAlign = "right"; g.fillStyle = C.text; g.fillText(v2, W - P - 14, y);
  };
  const lvl = (x) => (+x ? price(x, dg) : "—");
  const m = (x) => (+x ? money(+x) : "-");
  row(462, "S/L:", lvl(d.sl), +d.sl ? C.red : C.text, "Swap:", m(d.sw));
  row(526, "T/P:", lvl(d.tp), C.text, "Charges:", m(d.ch));
  return cv.toDataURL("image/png");
}

// Блок в карточке сделки: картинка тикета под скриншотами и кнопка «Скачать».
export function block(raw) {
  const d = parse(raw);
  if (!d) return "";
  let url = "";
  try { url = png(d); } catch { return ""; }
  const name = `MT5_${d.sym}_${d.t}.png`;
  return `<div class="field-h shots-h"><span>${tr("Тикет MT5")} <span class="muted">${tr("— сам из терминала, при автопереносе с компьютера")}</span></span>
    <a class="link-btn" href="${url}" download="${esc(name)}">${tr("Скачать")}</a></div>
    <div class="mt5-ticket"><img src="${url}" alt="${esc(tr("Тикет MT5"))} #${esc(String(d.t))}">
    ${+d.tp ? "" : `<div class="hint">${tr("T/P «—»: тейк, поставленный после входа, MT5 не хранит. Его запишет наблюдатель watch.py, если он запущен.")}</div>`}</div>`;
}
