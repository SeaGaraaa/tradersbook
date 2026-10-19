// Конструктор стратегии: разделы с полями вместо Markdown. Данные (JSON) лежат в листе Strategy, колонка B;
// из них собирается обычный Markdown (колонка A), который показывает вкладка «Стратегия».
// Каждая строка в поле — отдельный пункт. Пустые поля и разделы на страницу не попадают.

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const TXT = {
  ru: {
    principles: "Принципы", pairs: "Торговые пары", time: "Время торговли", risk: "Риск-менеджмент",
    setups: "Сетапы", manage: "Ведение сделки", setup: "Новый сетап", open: "Открыть",
    riskPer: "Риск на сделку", maxStops: "Максимум стопов в день", maxTrades: "Максимум сделок в день", minRR: "Минимальный RR",
    entry: "Вход", sl: "Stop Loss", tp: "Take Profit", inval: "ИНВАЛИДАЦИЯ — сделки нет", ofBalance: "от баланса",
  },
  en: {
    principles: "Principles", pairs: "Trading pairs", time: "Trading hours", risk: "Risk management",
    setups: "Setups", manage: "Trade management", setup: "New setup", open: "Open",
    riskPer: "Risk per trade", maxStops: "Max stop-losses per day", maxTrades: "Max trades per day", minRR: "Minimum RR",
    entry: "Entry", sl: "Stop Loss", tp: "Take Profit", inval: "INVALIDATION — no trade", ofBalance: "of balance",
  },
};
export const words = (lang) => TXT[lang] || TXT.ru;

export const newSetup = (lang) => ({ id: uid("s"), name: words(lang).setup, when: "", entry: "", sl: "", tp: "", inval: "", images: [] });
export const newSection = (kind, lang, title = "") => {
  const w = words(lang);
  const base = { id: uid("x"), kind, title: title || ({ list: "", pairs: w.pairs, risk: w.risk, setups: w.setups })[kind] || "" };
  if (kind === "list") return { ...base, text: "", images: [] };
  if (kind === "pairs") return { ...base, pairs: [], text: "" };
  if (kind === "risk") return { ...base, risk: "", stops: "", trades: "", rr: "", text: "" };
  return { ...base, setups: [newSetup(lang)] };
};

// Стартовая страница нового пользователя: разделы есть, полей с чужими правилами нет (только подсказки).
export function starter(lang) {
  const w = words(lang);
  return {
    v: 1, lang,
    sections: [
      { ...newSection("list", lang, w.principles), hint: "principles" },
      newSection("pairs", lang),
      { ...newSection("list", lang, w.time), hint: "time" },
      newSection("risk", lang),
      newSection("setups", lang),
      { ...newSection("list", lang, w.manage), hint: "manage" },
    ],
  };
}

export function parse(json) {
  try {
    const d = JSON.parse(json || "null");
    return d && d.v === 1 && Array.isArray(d.sections) ? d : null;
  } catch {
    return null;
  }
}

// «каждая строка — пункт»: маркеры, которые люди ставят сами, убираем
export const lines = (t) => String(t || "").split("\n").map((s) => s.trim().replace(/^([-•*–]|\d+[.)])\s+/, "").trim()).filter(Boolean);
const bullets = (t) => lines(t).map((s) => "- " + s);
const pics = (a) => (a || []).filter(Boolean).map((u) => `![](${u})`);
const pct = (v) => (/^[\d.,]+$/.test(String(v).trim()) ? String(v).trim() + "%" : String(v).trim());
const rr = (v) => { const s = String(v).trim(); return /^[\d.,]+$/.test(s) ? "1:" + s : s; };

export function toMarkdown(d) {
  const w = words(d.lang);
  const out = [];
  for (const s of d.sections) {
    const title = (s.title || "").trim() || "—";
    let body = [];
    if (s.kind === "list") body = [...bullets(s.text), ...pics(s.images)];
    else if (s.kind === "pairs") body = [...(s.pairs || []).map((p) => "- " + p), ...bullets(s.text)];
    else if (s.kind === "risk") {
      const items = [
        s.risk && `- ${w.riskPer}: **${pct(s.risk)}** ${w.ofBalance}`,
        s.stops && `- ${w.maxStops}: **${s.stops}**`,
        s.trades && `- ${w.maxTrades}: **${s.trades}**`,
        s.rr && `- ${w.minRR}: **${rr(s.rr)}**`,
        ...bullets(s.text),
      ].filter(Boolean);
      if (items.length) body = [":::callout ⚠️", "**RISK**", ...items, ":::"];
    } else if (s.kind === "setups") {
      for (const st of s.setups || []) {
        const part = [...bullets(st.when)];
        for (const [k, label] of [["entry", w.entry], ["sl", w.sl], ["tp", w.tp]]) {
          if (lines(st[k]).length) part.push("", `**${label}**`, ...bullets(st[k]));
        }
        if (lines(st.inval).length) part.push("", ":::callout ⛔", `**${w.inval}**`, ...bullets(st.inval), ":::");
        part.push(...pics(st.images));
        const name = (st.name || "").trim();
        if (!name && !part.length) continue;
        body.push(`## ${name || "—"}`, `:::details ${w.open}`, ...part, ":::");
      }
    }
    if (body.length) out.push(`# ${title}`, ...body, "");
  }
  return out.join("\n");
}
