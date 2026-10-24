// Вход через Google (OAuth 2.0, implicit flow с переходом на страницу Google и обратно).
// Без всплывающих окон: так вход работает и в приложении на экране «Домой» на iPhone.
import { CONFIG } from "../config.js";
import { lsGet, lsSet, lsDel } from "./util.js";

export const SCOPE_SHEETS = "https://www.googleapis.com/auth/spreadsheets";
export const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive.file";
const KEY = "tj.token";
const STATE = "tj.state";
const HINT = "tj.hint"; // адрес аккаунта — чтобы Google продлил вход без выбора аккаунта
const SILENT = "tj.silentAt"; // когда последний раз продлевали вход без экрана

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

// Разбирает ответ Google после возврата на страницу. null — если ответа нет.
export function handleRedirect() {
  const h = location.hash;
  if (!h.includes("access_token=") && !h.includes("error=")) return null;
  const p = new URLSearchParams(h.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  const expected = lsGet(STATE);
  lsDel(STATE);
  const silent = expected?.startsWith("s:");
  if (p.get("error")) return { error: p.get("error"), silent };
  if (!expected || p.get("state") !== expected) return { error: "state mismatch" };
  const tok = {
    value: p.get("access_token"),
    exp: Date.now() + (Number(p.get("expires_in")) || 3600) * 1000 - 60000,
    scope: p.get("scope") || "",
  };
  lsSet(KEY, JSON.stringify(tok));
  return { ok: true };
}

function current() {
  try {
    const t = JSON.parse(lsGet(KEY) || "null");
    return t && t.exp > Date.now() ? t : null;
  } catch {
    return null;
  }
}

export const token = () => current()?.value || null;
export const hasDrive = () => (current()?.scope || "").includes(SCOPE_DRIVE);
export const forget = () => lsDel(KEY);
export const expiresIn = () => { try { return (JSON.parse(lsGet(KEY) || "null")?.exp || 0) - Date.now(); } catch { return 0; } };
export const setHint = (email) => email && lsSet(HINT, email);
// Продлить вход можно, если на устройстве уже входили и последняя попытка была не только что (без петли).
export const canSilent = () => !!lsGet(HINT) && Date.now() - Number(lsGet(SILENT) || 0) > 120000;

// silent: продление входа без экрана Google (prompt=none) — Google сразу возвращает новый токен,
// если аккаунт на устройстве не вышел из Google. Иначе вернёт ошибку, и приложение покажет обычный вход.
export function login({ silent = false } = {}) {
  const state = (silent ? "s:" : "") + crypto.randomUUID();
  lsSet(STATE, state);
  const q = new URLSearchParams({
    client_id: CONFIG.clientId,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: `${SCOPE_SHEETS} ${SCOPE_DRIVE}`,
    include_granted_scopes: "true",
    state,
  });
  if (silent) {
    lsSet(SILENT, String(Date.now()));
    q.set("prompt", "none");
    if (lsGet(HINT)) q.set("login_hint", lsGet(HINT));
  }
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + q);
}

// Выход: забыть токен и всё, что на этом устройстве относится к пользователю (таблица, черновики, папка Drive).
const USER_KEYS = ["tj.sheet", "tj.folder", "tj.draft", "tj.clrun", "tj.btIdea", HINT, SILENT, "tj.autosave"];
export function logout() {
  const t = token();
  forget();
  USER_KEYS.forEach(lsDel);
  try { Object.keys(localStorage).filter((k) => k.startsWith("tj.sheet.")).forEach(lsDel); } catch { /* приватный режим */ }
  if (t) fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t), { method: "POST" }).catch(() => {});
}
