// מאפשר לאפליקציה להיפתח גם בלי אינטרנט
const CACHE = 'zman-v18';
const FILES = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/db.js', 'js/parse.js', 'js/hebdate.js', 'js/sync.js', 'js/conflicts.js', 'js/zmanim.js', 'js/help.js', 'js/lock.js', 'guide/', 'vendor/supabase.js',
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

// התראה מהענן (גם כשהאפליקציה סגורה)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'זמן בכיף', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'זמן בכיף', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: d.tag, dir: 'rtl', lang: 'he',
    data: { url: d.url || './' }, vibrate: [120, 60, 120],
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(x => x.url.startsWith(self.registration.scope));
    return c ? c.focus() : self.clients.openWindow(url);
  }));
});
