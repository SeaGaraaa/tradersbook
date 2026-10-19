// Кэш оболочки приложения: сначала сеть (чтобы обновления приходили сразу), без сети — из кэша.
// Запросы к Google (данные, вход) не кэшируются.
const CACHE = "tj-v36";
const SHELL = ["./", "index.html", "styles.css", "config.js", "manifest.webmanifest",
  "js/main.js", "js/api.js", "js/auth.js", "js/stats.js", "js/form.js", "js/util.js", "js/checklist.js", "js/export.js", "js/i18n.js", "js/strategy.js",
  "icons/tb-icon-192.png", "icons/tb-icon-512.png", "icons/tb-apple-touch-icon.png", "icons/tb-logo-64.png", "icons/tb-checklist.png"];

self.addEventListener("install", (e) => {
  // cache: "reload" — брать файлы с сервера, а не из HTTP-кэша браузера
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))),
  );
});
