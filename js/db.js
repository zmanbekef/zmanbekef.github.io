// שמירת הנתונים בתוך המכשיר (IndexedDB) — נשמר גם אחרי סגירת האפליקציה
// 🎭 מצב הדגמה: ארון נפרד לגמרי — הנתונים האמיתיים לא נוגעים בו
// 📱 עמדת בדיקה (?bdika=1): נכנסים ישר להדגמה, בלי חשבון, בלי חלונות קופצים, בלי שרת ובלי מעקב
export const BDIKA = (() => { try { return new URLSearchParams(location.search).get('bdika') === '1'; } catch { return false; } })();
export const DEMO = BDIKA || (() => { try { return localStorage.getItem('zman-demo') === '1'; } catch { return false; } })();
export const DEMO_DB = 'zman-bekef-demo';
const DB_NAME = DEMO ? DEMO_DB : 'zman-bekef';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('items', { keyPath: 'id' });   // משימות, פגישות ומחשבות
      db.createObjectStore('msgs', { keyPath: 'id' });    // היסטוריית השיחה
      db.createObjectStore('log', { keyPath: 'id' });     // יומן פעולות (בשביל רצפים ודוחות בהמשך)
      db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

// 📱 בעמדת הבדיקה האפליקציה רצה בתוך מסגרת של אתר אחר, ושם הדפדפן יכול לחסום אחסון.
// לכן שם הכל נשמר רק בזיכרון (מתחיל מחדש בכל טעינה), בלי IndexedDB
const MEM = { items: new Map(), msgs: new Map(), log: new Map(), kv: new Map() };
const memReq = v => ({ result: v });
const memStore = name => {
  const m = MEM[name], key = v => name === 'kv' ? undefined : v.id;
  return {
    getAll: () => memReq(structuredClone([...m.values()])), get: id => memReq(structuredClone(m.get(id))),
    put: (v, k) => { m.set(k ?? key(v), structuredClone(v)); return memReq(k ?? key(v)); },
    delete: id => { m.delete(id); return memReq(undefined); }, clear: () => { m.clear(); return memReq(undefined); },
  };
};
async function store(name, mode) {
  if (BDIKA) return memStore(name);
  return (await open()).transaction(name, mode).objectStore(name);
}
const done = req => 'onsuccess' in req ? new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }) : Promise.resolve(req.result);

export const all = async name => done((await store(name, 'readonly')).getAll());
export const get = async (name, id) => done((await store(name, 'readonly')).get(id));
export const put = async (name, v) => done((await store(name, 'readwrite')).put(v));
export const del = async (name, id) => done((await store(name, 'readwrite')).delete(id));
export const clear = async name => done((await store(name, 'readwrite')).clear());

export async function getKV(key, fallback) {
  const v = await done((await store('kv', 'readonly')).get(key));
  return v === undefined ? fallback : v;
}
export async function setKV(key, val) { return done((await store('kv', 'readwrite')).put(val, key)); }

const KV_KEYS = ['top3', 'settings', 'lastMorning', 'lastEvening'];
export async function exportAll() {
  const kv = {};
  for (const k of KV_KEYS) kv[k] = await getKV(k, null);
  return { app: 'zman-bekef', version: 1, exported: new Date().toISOString(), items: await all('items'), log: await all('log'), kv };
}
export async function importAll(data) {
  if (!data || data.app !== 'zman-bekef' || !Array.isArray(data.items)) throw new Error('קובץ גיבוי לא תקין');
  for (const it of data.items) await put('items', it);
  for (const l of data.log || []) await put('log', l);
  for (const [k, v] of Object.entries(data.kv || {})) if (v != null) await setKV(k, v);
  return data.items;
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
