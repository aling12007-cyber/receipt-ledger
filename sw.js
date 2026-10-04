// Receipt Ledger — service worker: the app opens without a network (last loaded version), and receipts taken
// offline wait on the device (IndexedDB, handled by the page) until the connection is back.
// Network first, so a new deploy is used as soon as it can be fetched; the cache is only the fallback.
// Never caches the API, Supabase, or anything that is not a plain GET.
const CACHE = "rl-shell-v1";
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|fonts\.(googleapis|gstatic)\.com)\//;

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/index.html", "/styles.css", "/i18n.js", "/guide-content.js", "/manifest.webmanifest", "/icon-192.png"])).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  const same = u.origin === self.location.origin;
  if (same && u.pathname.startsWith("/api/")) return;          // live data only
  if (!same && !CDN.test(r.url)) return;                        // Supabase, Google, NTA …: never cached
  e.respondWith(fetch(r).then((res) => {
    if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(r, { ignoreSearch: same }).then((hit) => hit || (r.mode === "navigate" ? caches.match("/index.html") : Response.error()))));
});
