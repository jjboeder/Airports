var CACHE_NAME = 'airports-v4';
var ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/airports.js',
  './js/fuel-calculator.js',
  './js/route-planner.js',
  './js/weight-balance.js',
  './data/airports-eu.json',
  './data/europe.geojson',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Install: cache all app assets
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
          .map(function (n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for API calls, cache-first for app assets
self.addEventListener('fetch', function (e) {
  var url = e.request.url;

  // API calls (all go through worker proxy): always go to network, don't cache
  if (url.indexOf('owm-proxy.jjboeder.workers.dev') >= 0) {
    e.respondWith(fetch(e.request));
    return;
  }

  // External CDN (Leaflet, tiles): network-first with cache fallback
  if (url.indexOf('unpkg.com') >= 0 || url.indexOf('tile.openstreetmap.org') >= 0) {
    e.respondWith(
      fetch(e.request).then(function (res) {
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(e.request, clone); });
        return res;
      }).catch(function () {
        return caches.match(e.request);
      })
    );
    return;
  }

  // App assets: cache-first with network fallback
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request).then(function (res) {
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(e.request, clone); });
        return res;
      });
    })
  );
});
