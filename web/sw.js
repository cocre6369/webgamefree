/**
 * sw.js - cache the game so it keeps working offline (and instantly on a
 * second visit).  The 10 MiB IWAD is cached under a versioned key; bump
 * CACHE when the build changes.
 */
const CACHE = "freedoom-wasm-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.webmanifest",
  "./doom.wasm",
  "./assets/freedoom1.wad.gz",
  "./assets/icon.svg",
  "./js/main.js",
  "./js/doom.js",
  "./js/wasi.js",
  "./js/music.js",
  "./js/renderer.js",
  "./js/audio.js",
  "./js/audio-worklet.js",
  "./js/input.js",
  "./js/savedata.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
    }),
  );
});
