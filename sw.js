/* ZoneSpotter service worker
 * Keeps the app files on the device so the page opens quickly and can be installed.
 * It always tries the network first, so new versions show up as soon as you upload them.
 * Every request asks the server "has this changed?" (cache: "no-cache"), so the browser's own HTTP cache
 * (Cloudflare tells it to keep files for hours) can never hand back an old app.js.
 * (The AI model and ml5 library come from the internet, so ZoneSpotter still needs a connection.)
 */
const CACHE = "zonespotter-v6";   // keep the same number as ?v= in index.html
const SHELL = [
  "./",
  "index.html",
  "styles.css?v=6",
  "app.js?v=6",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: "no-cache" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // CDN and model downloads go straight to the network

  event.respondWith(
    fetch(req, { cache: "no-cache" })   // check with the server every time; a "not modified" reply is tiny
      .then((res) => {
        if (res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html")))
  );
});
