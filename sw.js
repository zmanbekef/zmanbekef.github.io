// מאפשר לאפליקציה להיפתח גם בלי אינטרנט
const CACHE = 'zman-v2';
const FILES = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/db.js', 'js/parse.js', 'js/hebdate.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // מוחקים רק עותקים ישנים של "זמן בכיף" — באותה כתובת יושבת גם אפליקציית התקציב
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('zman-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// קודם מהרשת (כדי לקבל עדכונים), ואם אין רשת — מהעותק השמור
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    if (r.ok && new URL(e.request.url).origin === location.origin) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
