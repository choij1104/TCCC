/* TCCC Field — service worker retirement (kill switch)
 * Replaces the cache-first worker from a3575ff6. Clears Cache Storage,
 * unregisters itself, reloads open pages. localStorage is never touched.
 * Keep in repo until all devices are cleaned.
 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (e) {}
    try {
      await self.registration.unregister();
    } catch (e) {}
    try {
      var clientList = await self.clients.matchAll({ type: 'window' });
      clientList.forEach(function (c) {
        try { c.navigate(c.url); } catch (e) {}
      });
    } catch (e) {}
  })());
});
/* No fetch handler: all requests go to the network. */
