// סנכרון בין הטלפונים של בני הבית דרך Supabase — אותו חשבון ואותה משפחה כמו "כסף בכיף".
// הנתונים נשמרים קודם כל במכשיר (עובד גם בלי אינטרנט), ונשלחים לענן ברקע.
import * as db from './db.js';

const CONFIG = {
  url: 'https://dmhxovlepdoobkoiyjhj.supabase.co',
  // מפתח ציבורי (anon) — האבטחה נשמרת ע"י הרשאות בשרת (RLS): כל משפחה רואה רק את עצמה
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRtaHhvdmxlcGRvb2Jrb2l5amhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNDUxNDIsImV4cCI6MjEwNzkyMTE0Mn0.qao1CRL1QWJhMnWsAaPXKt-WxbgySqIlH68iIdCYH1o',
};
const LOCAL_ONLY = ['askedKey']; // "כבר שאלתי" — שייך לטלפון הזה בלבד

let sb = null, hh = null, me = null, channel = null, flushing = false, cb = {};
export const household = () => hh;
export const user = () => me;
export const isParent = () => !hh || hh.role !== 'child';

let loading;
function loadLib() {
  if (window.supabase) return Promise.resolve();
  loading ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/supabase.js'; s.onload = res; s.onerror = () => { loading = null; rej(new Error('lib')); };
    document.head.appendChild(s);
  });
  return loading;
}
async function client() {
  if (sb) return sb;
  await loadLib();
  sb = window.supabase.createClient(CONFIG.url, CONFIG.key, { auth: { persistSession: true, autoRefreshToken: true } });
  return sb;
}

const HEB_ERR = {
  'Invalid login credentials': 'המייל או הסיסמה לא נכונים',
  'User already registered': 'המייל הזה כבר רשום — נסה "כניסה"',
  'Password should be at least 6 characters': 'הסיסמה צריכה להיות לפחות 6 תווים',
  'bad code': 'הקוד לא נמצא. בדוק שהעתקת נכון',
  'Email not confirmed': 'צריך לאשר את המייל שנשלח אליך, ואז להיכנס',
};
const nice = e => {
  const m = e?.message || String(e);
  const k = Object.keys(HEB_ERR).find(x => m.includes(x));
  return k ? HEB_ERR[k] : (/fetch|network/i.test(m) ? 'אין חיבור לאינטרנט' : m);
};

// ---------- כניסה ----------
export async function currentUser() {
  const c = await client();
  me = (await c.auth.getSession()).data.session?.user || null;
  return me;
}
export async function signIn(email, password) {
  const { error } = await (await client()).auth.signInWithPassword({ email, password });
  if (error) throw new Error(nice(error));
  await currentUser();
}
export async function signUp(email, password) {
  const { data, error } = await (await client()).auth.signUp({ email, password });
  if (error) throw new Error(nice(error));
  if (!data.session) throw new Error(HEB_ERR['Email not confirmed']);
  await currentUser();
}
export async function signOut() {
  stop(); hh = null; me = null;
  for (const k of ['household', 'outbox', 'lastSync', 'people', 'top3']) await db.setKV(k, null);
  await db.clear('items'); await db.clear('msgs'); await db.clear('log');
  await (await client()).auth.signOut();
}

// ---------- משפחה ----------
export async function loadHousehold() {
  const { data, error } = await (await client()).rpc('my_household');
  if (error) throw new Error(nice(error));
  hh = data?.[0] || null;
  await db.setKV('household', hh);
  return hh;
}
export async function createHousehold(name) {
  const { error } = await (await client()).rpc('create_household', { hname: name });
  if (error) throw new Error(nice(error));
  return loadHousehold();
}
export async function joinHousehold(code) {
  const { error } = await (await client()).rpc('join_household', { code });
  if (error) throw new Error(nice(error));
  return loadHousehold();
}

// בני הבית (שם + אייקון) — אותה רשימה כמו בכסף בכיף
export async function loadPeople() {
  if (!hh) return db.getKV('people', []);
  try {
    const { data, error } = await (await client()).from('kv').select('value').eq('household_id', hh.id).eq('key', 'people').maybeSingle();
    if (error) throw error;
    const people = data?.value || [];
    await db.setKV('people', people);
    return people;
  } catch { return db.getKV('people', []); }
}
// מוסיף/מעדכן אדם אחד בלי לדרוס שינויים שנעשו בטלפון אחר
export async function savePerson(p) {
  const fresh = await loadPeople();
  const list = fresh.filter(x => x.id !== p.id).concat(p);
  const { error } = await (await client()).from('kv').upsert({ household_id: hh.id, key: 'people', value: list });
  if (error) throw new Error(nice(error));
  await db.setKV('people', list);
  return list;
}

// דברים משותפים (רכב, עגלה…) — משותף לכל המשפחה
export async function loadRes() {
  if (!hh || !me) return null;
  try {
    const { data, error } = await (await client()).from('kv').select('value').eq('household_id', hh.id).eq('key', 'zman_resources').maybeSingle();
    if (error) throw error;
    return data?.value || [];
  } catch { return null; }
}
export async function saveRes(list) {
  if (!hh || !me) return;
  const { error } = await (await client()).from('kv').upsert({ household_id: hh.id, key: 'zman_resources', value: list });
  if (error) throw new Error(nice(error));
}

// ---------- תור שליחה (עובד גם כשאין רשת) ----------
export async function queue(it) {
  if (!hh) return;
  const box = (await db.getKV('outbox', [])).filter(o => o.id !== it.id);
  box.push({ id: it.id, at: Date.now() });
  await db.setKV('outbox', box);
  flush();
}
const rowOf = it => {
  const data = { ...it }; LOCAL_ONLY.forEach(k => delete data[k]);
  return { household_id: hh.id, id: it.id, data, deleted: it.status === 'deleted', created_by: it.by || me?.id, assignee: it.forU || null, private: !!it.private };
};
export async function flush() {
  if (!hh || !me || flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const c = await client();
    let box = await db.getKV('outbox', []);
    while (box.length) {
      const batch = box.slice(0, 200);
      const items = (await db.all('items')).filter(it => batch.some(b => b.id === it.id));
      if (items.length) { const { error } = await c.from('zman_items').upsert(items.map(rowOf)); if (error) throw error; }
      box = (await db.getKV('outbox', [])).filter(o => !batch.some(b => b.id === o.id && b.at === o.at));
      await db.setKV('outbox', box);
    }
    cb.onStatus?.('ok');
  } catch (e) { console.warn('sync flush', e); cb.onStatus?.('wait'); }
  finally { flushing = false; }
}

// ---------- קבלת שינויים מהטלפונים האחרים ----------
async function apply(row, live) {
  const local = (await db.all('items')).find(x => x.id === row.id) || null;
  const next = { ...row.data, status: row.deleted ? 'deleted' : row.data.status };
  if (local) LOCAL_ONLY.forEach(k => { if (local[k] !== undefined) next[k] = local[k]; });
  await db.put('items', next);
  cb.onItem?.(local, next, live);
}

export async function pull() {
  if (!hh || !me) return 0;
  const c = await client();
  const since = await db.getKV('lastSync', '1970-01-01T00:00:00Z');
  let from = since, n = 0;
  for (;;) {
    const { data, error } = await c.from('zman_items').select('*').eq('household_id', hh.id).gt('updated_at', from).order('updated_at').limit(1000);
    if (error) throw error;
    for (const row of data) { await apply(row, since !== '1970-01-01T00:00:00Z'); n++; }
    if (data.length) from = data[data.length - 1].updated_at;
    if (data.length < 1000) break;
  }
  await db.setKV('lastSync', from);
  return n;
}

function subscribe() {
  stop();
  channel = sb.channel('zman-' + hh.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'zman_items', filter: `household_id=eq.${hh.id}` }, async p => { if (p.new?.id) { await apply(p.new, true); const b = await busy(); if (b) cb.onBusy?.(b); cb.onRemote?.(); } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kv', filter: `household_id=eq.${hh.id}` }, async p => { if (p.new?.key === 'people') { await db.setKV('people', p.new.value); cb.onRemote?.(); } if (p.new?.key === 'zman_resources') { cb.onRes?.(p.new.value || []); } })
    .subscribe();
}
function stop() { if (channel) { sb.removeChannel(channel); channel = null; } }

// זמנים תפוסים של משימות פרטיות של אחרים — רק מתי, בלי מה (להתראות על התנגשויות)
export async function busy() {
  if (!hh || !me || !navigator.onLine) return null;
  try {
    const { data, error } = await (await client()).rpc('zman_busy', { h: hh.id });
    if (error) throw error;
    return (data || []).map(r => ({ id: 'busy-' + r.id, busy: true, status: 'open', kind: 'task', hasTime: true, due: r.due, dur: r.dur, by: r.created_by, forU: r.assignee, forP: r.for_p }));
  } catch (e) { console.warn('busy', e); return null; }
}

async function refresh() {
  await flush(); const n = await pull().catch(() => 0);
  const b = await busy(); if (b) cb.onBusy?.(b);
  const r = await loadRes(); if (r) cb.onRes?.(r);
  if (n || b?.length) cb.onRemote?.();
}
let listening = false;
function listen() {
  if (listening) return; listening = true;
  addEventListener('online', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

/** מופעל בעליית האפליקציה. מחזיר { user, household } */
export async function start(callbacks) {
  cb = callbacks;
  try {
    await currentUser();
    if (!me) return { user: null, household: null };
    hh = await db.getKV('household', null);
    try { await loadHousehold(); } catch { /* בלי רשת — נשתמש במה ששמור */ }
    if (hh) await connected(false);
    return { user: me, household: hh };
  } catch (e) { console.warn('sync start', e); cb.onStatus?.('wait'); return { user: me, household: hh }; }
}

/** אחרי כניסה/הצטרפות: מעלה את מה שכבר רשום בטלפון, מוריד את של המשפחה, ומאזין לשינויים */
export async function connected(first = true) {
  if (first) {
    await db.setKV('lastSync', '1970-01-01T00:00:00Z');
    for (const it of await db.all('items')) { if (!it.by) { it.by = me.id; await db.put('items', it); } await queue(it); }
  }
  await loadPeople();
  await refresh();
  subscribe(); listen();
}

// ---------- התראות לטלפון (Web Push) ----------
export const VAPID_PUBLIC = 'BK8gkzX2KR60Q1uYUvrda0VHsqfpig72_Z1Uy2jhytvKl5uu3HbIYx93G_k53UQznMpv9bLfcPqepKRYUtGWsvI';
const b64u = s => { const p = '='.repeat((4 - s.length % 4) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}
export async function enablePush(prefs) {
  if (!hh || !me) throw new Error('צריך להיות מחובר');
  if (!pushSupported()) throw new Error('הדפדפן הזה לא תומך בהתראות. באייפון צריך קודם להוסיף את האפליקציה למסך הבית');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('לא ניתן אישור להתראות. אפשר לאשר בהגדרות הטלפון');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(VAPID_PUBLIC) });
  const json = sub.toJSON();
  const { error } = await (await client()).from('zman_push_subs').upsert({ endpoint: json.endpoint, user_id: me.id, household_id: hh.id, sub: json, prefs: prefs || {}, updated_at: new Date().toISOString() });
  if (error) throw new Error(nice(error));
}
export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { await (await client()).from('zman_push_subs').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
}
export async function savePrefs(prefs) {
  if (!me) return;
  try { await (await client()).from('zman_push_subs').update({ prefs }).eq('user_id', me.id); } catch { /* */ }
}
// תור ההתראות בענן
export async function upsertNotify(rows) {
  if (!hh || !me || !rows.length || !navigator.onLine) return false;
  const { error } = await (await client()).from('zman_notify').upsert(rows.map(r => ({ household_id: hh.id, created_by: me.id, sent_at: null, ...r })));
  if (error) { console.warn('notify', error); return false; }
  return true;
}
export async function deleteNotify(ids) {
  if (!hh || !me || !ids.length || !navigator.onLine) return false;
  const { error } = await (await client()).from('zman_notify').delete().in('id', ids).is('sent_at', null);
  return !error;
}

// ---------- ניהול המשפחה (רק להורים — נאכף גם בשרת) ----------
export async function listMembers() {
  const { data, error } = await (await client()).rpc('list_members');
  if (error) throw new Error(nice(error));
  return data || [];
}
export async function setRole(uid, role) {
  const { error } = await (await client()).rpc('set_member_role', { target: uid, new_role: role });
  if (error) throw new Error(/last parent/.test(error.message) ? 'חייב להישאר לפחות הורה אחד' : nice(error));
}
export async function removeMember(uid) {
  const { error } = await (await client()).rpc('remove_member', { target: uid });
  if (error) throw new Error(/last parent/.test(error.message) ? 'חייב להישאר לפחות הורה אחד' : nice(error));
}
export async function removePerson(id) {
  const list = (await loadPeople()).filter(x => x.id !== id);
  const { error } = await (await client()).from('kv').upsert({ household_id: hh.id, key: 'people', value: list });
  if (error) throw new Error(nice(error));
  await db.setKV('people', list);
  return list;
}
