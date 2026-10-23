// AI-разбор торгового журнала (Claude API напрямую из браузера, ключ пользователя хранится только на устройстве).
import { lsGet, lsSet, parseDT, num, fmtDT, nowSerial, serialToDate } from "./util.js";

export const MODELS = [
  ["claude-sonnet-5-5", "Claude Sonnet 5.5 — рекомендую (быстро и точно)"],
  ["claude-opus-5-5", "Claude Opus 5.5 — глубже, дороже"],
  ["claude-haiku-5-5", "Claude Haiku 5.5 — дешевле, проще"],
];
const KEY = "tj.ai", REPORTS = "tj.ai.reports";

const DEF = { enabled: false, provider: "gemini", key: "", model: MODELS[0][0], gkey: "", gmodel: "", gmodels: [] };
export function settings() { try { return { ...DEF, ...JSON.parse(lsGet(KEY) || "{}") }; } catch { return { ...DEF }; } }
export function saveSettings(s) { lsSet(KEY, JSON.stringify(s)); }
export const enabled = () => settings().enabled;

export function reports() { try { return JSON.parse(lsGet(REPORTS) || "[]"); } catch { return []; } }
export function addReport(r) { lsSet(REPORTS, JSON.stringify([r, ...reports()].slice(0, 12))); }
export function removeReport(id) { lsSet(REPORTS, JSON.stringify(reports().filter((x) => x.id !== id))); }

// Период в «настенном» времени таблицы (serial). Неделя — с понедельника.
export function periodRange(kind, from, to) {
  const now = serialToDate(nowSerial()); // «сейчас» в поясе журнала, в UTC-полях
  const today = Math.floor(nowSerial());
  const wd = (now.getUTCDay() + 6) % 7; // 0 — понедельник
  const m0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 864e5 + 25569;
  const pm0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) / 864e5 + 25569;
  switch (kind) {
    case "week": return [today - wd, today + 1];
    case "lastweek": return [today - wd - 7, today - wd];
    case "month": return [m0, today + 1];
    case "lastmonth": return [pm0, m0];
    case "3m": return [today - 91, today + 1];
    case "custom": {
      const f = from ? Date.parse(from + "T00:00:00Z") / 864e5 + 25569 : -Infinity;
      const t = to ? Date.parse(to + "T00:00:00Z") / 864e5 + 25569 + 1 : Infinity;
      return [f, t];
    }
    default: return [-Infinity, Infinity];
  }
}

const cut = (s, n) => { s = String(s ?? "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

// Данные для разбора: только то, что есть в журнале. Ссылки на скриншоты не отправляются.
export function buildInput({ trades, numbers, stats, period, strategy, runs, itemText, mode, lang, from, to }) {
  const rows = trades.map((t) => {
    const v = t.v, risk = num(v[9]), profit = num(v[10]);
    return {
      "#": numbers.get(t.n), open: fmtDT(v[0]), close: fmtDT(v[1]), dir: v[2], pair: v[3], session: v[4], poi: v[5], entry: v[6],
      result: v[7], rr_plan: v[8], risk_pct: v[9], profit_pct: v[10], r: risk > 0 && Number.isFinite(profit) ? +(profit / risk).toFixed(2) : null,
      exit: cut(v[18], 200), notes: cut(v[19], 400), ...(mode === "bt" ? { idea: v[21] } : {}),
      screenshots: [11, 12, 13, 14, 15, 16, 17, 20].some((k) => String(v[k] || "").trim()) ? "есть" : "нет",
    };
  });
  const k = stats.kpi;
  const fmt = (b) => b.map((x) => ({ name: x.name, trades: x.trades, win: x.win, winrate: Math.round(x.winrate * 100) + "%", ...(x.profit != null ? { profit_pct: +x.profit.toFixed(2) } : {}) })).filter((x) => x.trades);
  const no = new Map();
  for (const r of runs) for (const id of r.no) no.set(id, (no.get(id) || 0) + 1);
  return {
    language: lang === "en" ? "English" : "Russian",
    journal: mode === "bt" ? "backtest" : "live account",
    period: { from: from || "начало журнала", to: to || "сегодня", trades: rows.length },
    totals: {
      trades_with_result: k.total, winrate: Math.round(k.winrate * 100) + "%", profit_pct: +k.profit.toFixed(2), total_r: +k.totalR.toFixed(2),
      expectancy_r: +k.expectancy.toFixed(2), profit_factor: k.pf == null ? "нет убыточных" : +k.pf.toFixed(2), max_drawdown_pct: +k.maxDD.toFixed(2),
      avg_rr_wins: +k.avgRR.toFixed(2), trades_with_risk: k.withRisk,
    },
    by_pair: fmt(stats.pair), by_session: fmt(stats.session), by_poi: fmt(stats.poi), by_entry: fmt(stats.entry),
    by_weekday: period.days.map((d) => ({ day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.day], trades: d.trades, profit_pct: +d.profit.toFixed(2), winrate: Math.round(d.winrate * 100) + "%" })),
    streaks: { max_wins: period.maxWinStreak, max_losses: period.maxLossStreak },
    checklists_in_period: runs.length ? {
      total: runs.length, no_trade: runs.filter((r) => r.verdict === "Сделки нет").length,
      most_failed_items: [...no.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n]) => ({ item: itemText(id), times: n })),
    } : "чек-листы за период не заполнялись",
    strategy: strategy ? cut(strategy.replace(/!\[[^\]]*\]\([^)]*\)/g, ""), 30000) : "стратегия не заполнена",
    trades: rows,
  };
}

const SYSTEM = `You are a strict, experienced trading coach reviewing a trader's journal.
Rules:
- Use ONLY the data provided. Never invent prices, levels, news or results. If something can't be judged from the data, say so in "data_gaps".
- Always reference trades by their journal number like #12. Every mistake must list the trade numbers it is based on.
- Judge against the trader's own strategy text when it is provided (risk per trade, number of trades/stops per day, sessions, setups, entry model, RR). Quote the rule briefly. If there is no strategy, use general risk-management principles and say they are general.
- Look for: risk above the trader's limit, too many trades or losses in a day, revenge trading (quick re-entries after a loss), trading outside the allowed sessions/time, missing stop or risk, moving targets, low RR, setups/pairs/sessions that lose money, missing notes/screenshots, checklist items that fail often.
- Be honest about sample size: fewer than 30 trades means conclusions about setups are preliminary — state it.
- Never promise profit. Be concrete, short and practical.
- Write all text in the language given in "language".
Return ONLY one JSON object, no markdown, with exactly these keys:
{"verdict": "2-3 sentence summary of the period",
 "score": integer 0-100 = discipline score (how well the trader followed their own rules),
 "score_reason": "one sentence why",
 "mistakes": [{"title": "...", "severity": "high|medium|low", "trades": [numbers], "detail": "what happened, with numbers", "fix": "what to do instead"}],
 "rule_violations": [{"rule": "the rule from the strategy", "trades": [numbers], "detail": "..."}],
 "patterns": [{"title": "...", "detail": "with numbers: pairs/sessions/weekdays/setups"}],
 "strengths": ["..."],
 "actions": ["concrete action for the next period"],
 "data_gaps": ["what is missing in the journal to analyse better"]}
Sort mistakes by severity (high first). Keep each text field under 400 characters.`;

// Активный ключ и модель выбранного сервиса.
export const activeKey = (s = settings()) => (s.provider === "gemini" ? s.gkey : s.key);
export const activeModel = (s = settings()) => (s.provider === "gemini" ? s.gmodel || "gemini-flash-latest" : s.model);

// Модели Gemini, доступные по ключу (берём у Google, чтобы список был актуальным). Самая свежая Flash — первой.
export async function geminiModels(key) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 400 || r.status === 403 ? "Ключ Gemini не подошёл — проверь его" : "Gemini: " + (j?.error?.message || r.status));
  const list = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /^models\/gemini-([\d.]+-)?(flash|pro)/.test(m.name) && !/(tts|image|audio|live|embedding|thinking-exp|transcribe|customtools|computer-use|robotics)/.test(m.name))
    .map((m) => m.name.replace("models/", ""))
    .filter((n) => !/^gemini-(1\.|2\.)/.test(n)); // 1.x и 2.x для новых ключей Google уже закрыл
  const ver = (n) => parseFloat((n.match(/gemini-([\d.]+)/) || [])[1] || 0);
  const rank = (n) => ver(n) * 10 + (/flash$/.test(n) ? 3 : /pro$/.test(n) ? 2 : /flash/.test(n) ? 1 : 0) - (/preview|exp/.test(n) ? 5 : 0);
  // «-latest» Google сам ведёт на свежую версию — его ставим первым
  const alias = (n) => (n === "gemini-flash-latest" ? 1000 : /-latest$/.test(n) ? 500 : 0);
  return [...new Set(list)].sort((a, b) => alias(b) - alias(a) || rank(b) - rank(a));
}

async function callClaude(prompt, key, model) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 8000, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
    });
  } catch {
    throw new Error("Нет связи с Claude API — проверь интернет");
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = j?.error?.message || res.statusText;
    if (res.status === 401) throw new Error("Ключ Anthropic не подошёл — проверь его в разделе API");
    if (res.status === 429) throw new Error("Слишком много запросов или закончился лимит аккаунта Anthropic: " + m);
    throw new Error("Claude API: " + m);
  }
  return { text: (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""), usage: j.usage || null };
}

async function callGemini(prompt, key, model) {
  let res;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6 * 60e3); // бесплатный Gemini бывает медленным
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: ctl.signal,
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 16384 },
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e?.name === "AbortError" ? "Gemini не ответил за 6 минут — попробуй ещё раз или возьми период короче" : "Нет связи с Gemini — проверь интернет");
  }
  clearTimeout(timer);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = j?.error?.message || res.statusText;
    if (res.status === 400 && /api key/i.test(m)) throw new Error("Ключ Gemini не подошёл — проверь его в разделе API");
    if (res.status === 429) throw new Error("Бесплатный лимит Gemini на сейчас исчерпан — попробуй через минуту или завтра");
    if (res.status === 404) throw new Error("Эта модель Gemini недоступна — выбери другую в разделе API");
    throw new Error("Gemini: " + m);
  }
  const parts = j.candidates?.[0]?.content?.parts || [];
  if (!parts.length) throw new Error("Gemini не дал ответа (" + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || "пусто") + ") — попробуй ещё раз");
  return { text: parts.filter((p) => !p.thought).map((p) => p.text || "").join(""), usage: j.usageMetadata || null };
}

export async function analyze(input, s = settings()) {
  const prompt = "Trading journal data (JSON):\n" + JSON.stringify(input);
  const { text, usage } = s.provider === "gemini" ? await callGemini(prompt, s.gkey, activeModel(s)) : await callClaude(prompt, s.key, s.model);
  const j = { usage };
  const a = text.indexOf("{"), e = text.lastIndexOf("}");
  let data;
  try { data = JSON.parse(text.slice(a, e + 1)); } catch { throw new Error("ИИ вернул ответ не в том формате — попробуй ещё раз"); }
  const arr = (x) => (Array.isArray(x) ? x : []);
  return {
    verdict: String(data.verdict || ""), score: Math.max(0, Math.min(100, Math.round(+data.score || 0))), score_reason: String(data.score_reason || ""),
    mistakes: arr(data.mistakes), rule_violations: arr(data.rule_violations), patterns: arr(data.patterns),
    strengths: arr(data.strengths).map(String), actions: arr(data.actions).map(String), data_gaps: arr(data.data_gaps).map(String),
    usage: j.usage || null,
  };
}

export const tradeIds = (list) => (Array.isArray(list) ? list : []).map((x) => parseInt(String(x).replace("#", ""), 10)).filter(Number.isFinite);
export { parseDT };

// Картинка + задание -> JSON (распознавание скриншотов). image: { b64, mime }.
export async function visionJSON(prompt, image, s = settings()) {
  const key = activeKey(s);
  if (!key) throw new Error("Нет ключа AI — включи AI в разделе API и вставь ключ");
  let text = "";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4 * 60e3);
  try {
    if (s.provider === "gemini") {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel(s))}:generateContent`, {
        method: "POST", signal: ctl.signal, headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ inline_data: { mime_type: image.mime, data: image.b64 } }, { text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 8192 },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 429 ? "Бесплатный лимит Gemini на сейчас исчерпан — попробуй через минуту" : "Gemini: " + (j?.error?.message || res.status));
      text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    } else {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: ctl.signal,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "content-type": "application/json" },
        body: JSON.stringify({ model: s.model, max_tokens: 3000, messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: image.mime, data: image.b64 } }, { type: "text", text: prompt + "\nReturn only the JSON." }] }] }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error("Claude API: " + (j?.error?.message || res.status));
      text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    }
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("ИИ не ответил за 4 минуты — попробуй ещё раз");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  try { return JSON.parse(text.slice(a, b + 1)); } catch { throw new Error("ИИ вернул ответ не в том формате — попробуй ещё раз"); }
}
