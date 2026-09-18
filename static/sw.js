const CACHE = 'herdr-shell-v2'
const SHELL = ['/', '/app.js', '/lines.js', '/manifest.json', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // API responses are never cached. A stale agent status on a phone is worse
  // than no status: it invites a reply to an agent that is no longer there.
  if (url.pathname.startsWith('/api/')) return

  // Network first so a deploy lands immediately; cache is only the fallback for
  // when Tailscale is down, which is the entire reason this worker exists.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((cache) => cache.put(event.request, copy))
        return res
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('/')))
  )
})
