// 📊 נתוני שימוש כלליים למפתח: מתי האפליקציה נפתחה, האם מותקנת, באיזה סוג טלפון — ותקלות.
// בלי תוכן: לא סכומים, לא תיאורים, לא משימות. (מוסבר גם במדריך)
// הקובץ זהה בשתי האפליקציות. השיוך למשתמש נעשה רק דרך החיבור הרגיל של האפליקציה (ping(client)).
let APP = '', URL_ = '', KEY = '';

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* מצב פרטי */ } },
};
let dev = ls.get('app-device-id');
if (!dev) { dev = (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 36); ls.set('app-device-id', dev); }

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'אחר';
  const br = /SamsungBrowser/.test(ua) ? 'Samsung' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return os + (br ? ' · ' + br : '');
}
async function version() {
  try { return (await caches.keys()).find(k => k.startsWith(APP + '-')) || ''; } catch { return ''; }
}
const pingBody = async () => ({ p_app: APP, p_device_id: dev, p_standalone: standalone(), p_device: deviceName(), p_version: await version() });
// בלי משתמש (רק המפתח הציבורי של האפליקציה)
const anon = (fn, body) => fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', keepalive: true,
  headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** מופעל פעם אחת בעליית האפליקציה */
// 🧪 בדיקות במחשב של המפתח (localhost / 127.0.0.1 / *.localhost) — לא נשלחות ללוח הבקרה, כדי שיופיעו שם רק משתמשים אמיתיים
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(location.hostname);
export function init({ app, url, key }) {
  APP = app; URL_ = url; KEY = key;
  if (!URL_ || !KEY || LOCAL) { URL_ = ''; return; }
  setTimeout(() => { if (!lastPing) anonPing(); }, 8000);
  addEventListener('error', e => report(e.message, (e.filename || '').split('/').pop() + ':' + (e.lineno || '')));
  addEventListener('unhandledrejection', e => { const r = e.reason; report(r?.message || r, (r?.stack || '').split('\n')[1]?.trim()); });
  addEventListener('online', sendErrors);
  setTimeout(sendErrors, 6000);
}

// "נפתחתי" — פעם ב-5 דקות לכל היותר
let lastPing = 0;
async function anonPing() {
  if (!navigator.onLine || !URL_) return;
  lastPing = Date.now();
  try { await anon('track_ping', await pingBody()); } catch { lastPing = 0; }
}
/** מהחיבור הרגיל של האפליקציה (משתמש מחובר) — כך יודעים של מי המכשיר */
export async function ping(client) {
  if (!client || LOCAL || !navigator.onLine || Date.now() - lastPing < 5 * 60 * 1000) return;
  lastPing = Date.now();
  try { const { error } = await client.rpc('track_ping', await pingBody()); if (error) lastPing = 0; } catch { lastPing = 0; }
}

// תקלות: נשמרות במכשיר ונשלחות כשיש אינטרנט (בלי שיוך למשתמש)
const seen = new Set();
/** דיווח יזום מהאפליקציה (למשל "קובץ בנק בפורמט שלא נתמך") — רק שם הפורמט, בלי תוכן */
export function issue(message, source) { report(message, source); }
/** ⚠️ משתמש נתקע — בלי קריסה (ייבוא שנכשל, כניסה, סנכרון, משוב שלא נשלח, שרת).
 *  kind = סוג הכישלון; details = פרטים טכניים בלבד — בלי מייל, שמות, סכומים או תוכן. בלוח הבקרה: ⚠️ (קריסה = 💥) */
const NET = /fetch|network|load failed|timeout|offline/i;
export function fail(kind, details = '') {
  const d = String(details || '').replace(/[^\s@]+@[^\s@]+/g, '<מייל>').replace(/\d{5,}/g, '#').slice(0, 200);
  if (!navigator.onLine || NET.test(d)) return; // בלי אינטרנט — מצב רגיל, לא תקלה
  report(`⚠️ ${kind}: ${d}`, `fail:${kind}`);
}
function report(message, source) {
  message = String(message || '').slice(0, 300);
  if (!message || /ResizeObserver|^Script error\.?$/.test(message) || seen.has(message)) return;
  seen.add(message);
  let q = []; try { q = JSON.parse(ls.get('app-err-queue') || '[]'); } catch { /* */ }
  q.push({ message, source: String(source || '').slice(0, 200) });
  ls.set('app-err-queue', JSON.stringify(q.slice(-20)));
  sendErrors();
}
let sending = false;
async function sendErrors() {
  if (!navigator.onLine || !URL_ || sending) return;
  let q = []; try { q = JSON.parse(ls.get('app-err-queue') || '[]'); } catch { /* */ }
  if (!q.length) return;
  sending = true; ls.set('app-err-queue', '[]');
  const v = await version(), d = deviceName();
  for (const e of q) { try { await anon('track_error', { p_app: APP, p_device_id: dev, p_message: e.message, p_source: e.source, p_device: d, p_version: v }); } catch { /* */ } }
  sending = false;
  // תקלה שנוספה בזמן השליחה — נשלחת מיד אחרי (לא הולכת לאיבוד)
  try { if (JSON.parse(ls.get('app-err-queue') || '[]').length) setTimeout(sendErrors, 500); } catch { /* */ }
}
