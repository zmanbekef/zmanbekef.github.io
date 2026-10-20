// סנכרון בין הטלפונים דרך Supabase — אותו חשבון כמו "כסף בכיף", עם קבוצות משלנו (משפחה / שותפים / צוות / קשר פרטי).
// הנתונים נשמרים קודם כל במכשיר (עובד גם בלי אינטרנט), ונשלחים לענן ברקע.
import * as db from './db.js';
import * as track from './track.js';

const CONFIG = {
  url: 'https://dmhxovlepdoobkoiyjhj.supabase.co',
  // מפתח ציבורי (anon) — האבטחה נשמרת ע"י הרשאות בשרת (RLS): כל משפחה רואה רק את עצמה
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRtaHhvdmxlcGRvb2Jrb2l5amhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNDUxNDIsImV4cCI6MjEwNzkyMTE0Mn0.qao1CRL1QWJhMnWsAaPXKt-WxbgySqIlH68iIdCYH1o',
};
const DEMO = db.DEMO;
if (!DEMO) track.init({ app: 'zman', url: CONFIG.url, key: CONFIG.key });
const LOCAL_ONLY = ['askedKey']; // "כבר שאלתי" — שייך לטלפון הזה בלבד

let sb = null, hh = null, me = null, channel = null, flushing = false, cb = {};
let groups = [], profile = null;
export const household = () => hh;          // המשפחה של "כסף בכיף" (רק בשביל ייבוא)
export const user = () => me;
export const myGroups = () => groups;
export const myProfile = () => profile;
export const isParent = () => !groups.length || groups.some(g => g.myRole !== 'child');

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
  if (DEMO) throw new Error('🎭 במצב הדגמה לא מתחברים לענן');
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
  'too many tries': 'יותר מדי ניסיונות עם קוד שגוי. נסה שוב בעוד שעה',
  'pair full': 'הקישור הזה כבר בשימוש של מישהו אחר',
  'last admin': 'חייב להישאר לפחות מנהל אחד בקבוצה',
  'not admin': 'רק מנהל הקבוצה יכול לעשות את זה',
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
  await currentUser(); track.ping(sb);
}
// שכחתי סיסמה: מייל עם קישור שחוזר לאפליקציה, ושם בוחרים סיסמה חדשה
export async function resetPassword(email) {
  const { error } = await (await client()).auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw new Error(nice(error));
}
export async function setPassword(password) {
  const { error } = await (await client()).auth.updateUser({ password });
  if (error) throw new Error(nice(error));
}
/** בדיקת סיסמת החשבון (בשביל "שכחתי את קוד הנעילה") */
export async function verifyPassword(password) {
  if (!me?.email || !navigator.onLine) return false;
  const { error } = await (await client()).auth.signInWithPassword({ email: me.email, password });
  return !error;
}
export async function signUp(email, password) {
  const { data, error } = await (await client()).auth.signUp({ email, password });
  if (error) throw new Error(nice(error));
  if (!data.session) throw new Error(HEB_ERR['Email not confirmed']);
  await currentUser(); track.ping(sb);
}
/** יציאה: קודם מעלים לענן את מה שעוד לא עלה. אם אי אפשר — זורקים 'pending' (אלא אם force) */
export async function pendingCount() { return (await db.getKV('outbox', [])).length; }
export async function signOut(force) {
  if (me && navigator.onLine) await Promise.race([flush(), new Promise(r => setTimeout(r, 6000))]);
  if (!force && (await pendingCount())) throw new Error('pending');
  stop(); hh = null; me = null; groups = []; profile = null;
  for (const k of ['household', 'outbox', 'lastSync2', 'people', 'top3', 'groups', 'profile', 'migratedGroups']) await db.setKV(k, null);
  await db.clear('items'); await db.clear('msgs'); await db.clear('log');
  await (await client()).auth.signOut();
}

// ---------- המשפחה של "כסף בכיף" (בשביל ייבוא לקבוצה) ----------
export async function loadHousehold() {
  const { data, error } = await (await client()).rpc('my_household');
  if (error) throw new Error(nice(error));
  hh = data?.[0] || null;
  await db.setKV('household', hh);
  return hh;
}
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

// ---------- פרופיל: שם מלא ואייקון ----------
export async function loadProfile() {
  try {
    const { data, error } = await (await client()).from('zman_profiles').select('*').eq('user_id', me.id).maybeSingle();
    if (error) throw error;
    profile = cleanP(data) || null; await db.setKV('profile', profile);
  } catch { profile = await db.getKV('profile', null); }
  return profile;
}
/** מייל סיכום חודשי (ב-1 לחודש) — דלוק או כבוי */
export async function setMonthly(on) {
  const { error } = await (await client()).from('zman_profiles').update({ monthly_email: !!on }).eq('user_id', me.id);
  if (error) throw new Error(nice(error));
  profile = { ...(profile || {}), monthly_email: !!on }; await db.setKV('profile', profile);
}
export async function saveProfile(full_name, emoji) {
  const { error } = await (await client()).from('zman_profiles').upsert({ user_id: me.id, full_name, emoji, updated_at: new Date().toISOString() });
  if (error) throw new Error(nice(error));
  profile = { ...(profile || {}), user_id: me.id, full_name, emoji }; await db.setKV('profile', profile);
  return profile;
}

// שם ואייקון שמגיעים מאנשים אחרים — מנקים, שלא יוכלו להכניס קוד לדף
const cleanE = v => typeof v === 'string' && v.length <= 16 && !/[<>&"'`=\\/]/.test(v) ? v : null;
const cleanT = v => typeof v === 'string' ? v.replace(/[<>]/g, '').slice(0, 60) : v;
const cleanP = p => p && { ...p, full_name: cleanT(p.full_name), emoji: cleanE(p.emoji) };

// ---------- קבוצות ----------
export async function loadGroups() {
  try {
    const c = await client();
    const { data: gs, error } = await c.from('zman_groups').select('id,name,kind,source_household,created_by,created_at').order('created_at');
    if (error) throw error;
    const ids = (gs || []).map(g => g.id);
    const { data: ms } = ids.length ? await c.from('zman_members').select('*').in('group_id', ids).order('joined_at') : { data: [] };
    const uids = [...new Set((ms || []).map(m => m.user_id).filter(Boolean))];
    const { data: ps } = uids.length ? await c.from('zman_profiles').select('*').in('user_id', uids) : { data: [] };
    // קודי הצטרפות — רק למנהל (ילד לא רואה אותם)
    const { data: codes } = ids.length ? await c.rpc('zman_group_codes') : { data: [] };
    groups = (gs || []).map(g => {
      const members = (ms || []).filter(m => m.group_id === g.id).map(m => ({ ...m, nickname: cleanT(m.nickname), emoji: cleanE(m.emoji), profile: cleanP((ps || []).find(p => p.user_id === m.user_id)) || null }));
      const cd = (codes || []).find(x => x.id === g.id);
      return { ...g, name: cleanT(g.name), code: cd?.code || null, child_code: cd?.child_code || null, members, myRole: members.find(m => m.user_id === me.id)?.role || 'member' };
    });
    await db.setKV('groups', groups);
  } catch (e) { console.warn('groups', e); groups = await db.getKV('groups', []) || []; }
  return groups;
}
const rpc = async (fn, args) => {
  const { data, error } = await (await client()).rpc(fn, args);
  if (error) throw new Error(nice(error));
  return data;
};
export const createGroup = async (name, kind, nick, emo) => { const g = await rpc('zman_create_group', { gname: name, gkind: kind, nick, emo }); await loadGroups(); return g; };
export const joinGroup = async (code, nick, emo) => { const g = await rpc('zman_join_group', { jcode: code, nick, emo }); if (!g) throw new Error(HEB_ERR['bad code']); await loadGroups(); return g; };
export const setNickname = async (g, nick, emo) => { await rpc('zman_set_nickname', { g, nick, emo }); await loadGroups(); };
// קטגוריות: של הקבוצות שלי + "רק שלי"
export async function loadCategories() {
  if (!me || !navigator.onLine) return db.getKV('cats', []);
  try {
    const { data, error } = await (await client()).from('zman_categories').select('*');
    if (error) throw error;
    const rows = (data || []).map(r => ({ ...r, name: cleanT(r.name), icon: cleanE(r.icon) || '🏷️' }));
    await db.setKV('cats', rows); return rows;
  } catch (e) { console.warn('cats', e); return db.getKV('cats', []); }
}
export async function saveCategory(row) {
  const { error } = await (await client()).from('zman_categories').upsert({ ...row, owner: row.owner || me.id });
  if (error) throw new Error(nice(error));
  const rows = (await db.getKV('cats', [])).filter(r => r.id !== row.id); rows.push(row); await db.setKV('cats', rows);
}
// יומן: מי בקבוצה רואה את היומן שלי ('all' / 'busy' / 'none'), והיומן של מישהו אחר לפי מה שהוא הרשה
// 📆 יומן גוגל
export const GCAL_FN = CONFIG.url + '/functions/v1/zman-gcal';
export const gcalStatus = async () => (await rpc('zman_gcal_status'))?.[0] || null;
export const gcalStart = () => rpc('zman_gcal_start');
export const gcalPrefs = p => rpc('zman_gcal_prefs', { p });
export const gcalDisconnect = () => rpc('zman_gcal_disconnect');
export async function gcalSync() {
  const { data, error } = await (await client()).functions.invoke('zman-gcal', { body: { action: 'sync' } });
  if (error) throw new Error(nice(error)); return data;
}
export const setColor = async (mid, c) => { await rpc('zman_set_color', { mid, c }); await loadGroups(); };
export const setCalShare = async (g, v) => { await rpc('zman_set_cal_share', { g, v }); await loadGroups(); };
export async function calendarOf(uid) {
  if (!me || !uid || !navigator.onLine) return db.getKV('cal:' + uid, []);
  try { const rows = await rpc('zman_calendar', { target: uid }); await db.setKV('cal:' + uid, rows || []); return rows || []; }
  catch { return db.getKV('cal:' + uid, []); }
}
export const addName = async (g, nick, emo) => { const m = await rpc('zman_add_name', { g, nick, emo }); await loadGroups(); return m; };
export const setRole = async (mid, role) => { await rpc('zman_set_role', { mid, new_role: role }); await loadGroups(); };
export const removeMember = async mid => { await rpc('zman_remove_member', { mid }); await loadGroups(); };
export const renameGroup = async (g, name) => { const { error } = await (await client()).from('zman_groups').update({ name }).eq('id', g); if (error) throw new Error(nice(error)); await loadGroups(); };
export const importHousehold = async h => { const g = await rpc('zman_import_household', { h }); await loadGroups(); return g; };

// דברים משותפים (רכב, עגלה…) — נשמר אצל המשפחה של כסף בכיף אם יש, אחרת רק בטלפון
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

// משוב — גיבוי בענן (אפשר רק להוסיף; אף אחד לא קורא מהאפליקציה)
export async function saveFeedback(f) {
  if (!me) return false;
  const { error } = await (await client()).from('feedback').insert({ user_id: me.id, app: 'zman-bekef', ...f });
  return !error;
}

/** משוב שעובד גם במצב הדגמה: לקוח נפרד עם החשבון האמיתי שבטלפון (רק הוספה לטבלת המשוב) */
export async function saveFeedbackAny(f) {
  try {
    await loadLib();
    const c = sb || window.supabase.createClient(CONFIG.url, CONFIG.key, { auth: { persistSession: true, autoRefreshToken: false } });
    const u = (await c.auth.getSession()).data.session?.user; if (!u) return false;
    const { error } = await c.from('feedback').insert({ user_id: u.id, app: 'zman-bekef', ...f });
    if (error) console.warn('feedback', error);
    return !error;
  } catch (e) { console.warn('feedback', e); return false; }
}

// ---------- תור שליחה (עובד גם כשאין רשת) ----------
export async function queue(it) {
  if (!me || DEMO) return;
  const box = (await db.getKV('outbox', [])).filter(o => o.id !== it.id);
  box.push({ id: it.id, at: Date.now() });
  await db.setKV('outbox', box);
  flush();
}
/** אחרי שחזור מגיבוי: כל המשימות נכנסות לתור ועולות לענן */
export async function queueMany(items) {
  if (!me || DEMO || !items?.length) return;
  const ids = new Set(items.map(x => x.id)), now = Date.now();
  const box = (await db.getKV('outbox', [])).filter(o => !ids.has(o.id));
  for (const id of ids) box.push({ id, at: now });
  await db.setKV('outbox', box);
  flush();
}
const rowOf = it => {
  const data = { ...it }; LOCAL_ONLY.forEach(k => delete data[k]);
  return { id: it.id, group_id: it.group_id || null, data, deleted: it.status === 'deleted', created_by: it.by || me?.id, assignee: it.forU || null, private: !!it.private };
};
export async function flush() {
  if (!me || DEMO || flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const c = await client();
    let box = await db.getKV('outbox', []);
    while (box.length) {
      const batch = box.slice(0, 200);
      const items = (await db.all('items')).filter(it => batch.some(b => b.id === it.id));
      if (items.length) {
        const { error } = await c.from('zman_tasks').upsert(items.map(rowOf));
        if (error) {
          if (!error.code) throw error; // אין רשת — ננסה שוב אחר כך
          // השרת דחה משהו (הרשאה / נתונים): שולחים אחד-אחד, ומה שנדחה עובר הצידה — כדי שלא יחסום את כל השאר לתמיד
          const parked = await db.getKV('outboxParked', []);
          for (const it of items) {
            const r = await c.from('zman_tasks').upsert([rowOf(it)]);
            if (r.error) { if (!r.error.code) throw r.error; parked.push({ id: it.id, at: new Date().toISOString(), err: r.error.message }); console.warn('sync parked', it.id, r.error.message); }
          }
          await db.setKV('outboxParked', parked.slice(-200));
        }
      }
      box = (await db.getKV('outbox', [])).filter(o => !batch.some(b => b.id === o.id && b.at === o.at));
      await db.setKV('outbox', box);
    }
    cb.onStatus?.('ok');
  } catch (e) { console.warn('sync flush', e); cb.onStatus?.('wait'); }
  finally { flushing = false; }
}

// ---------- קבלת שינויים מהטלפונים האחרים ----------
const mergeComments = (a, b) => {
  if (!a?.length && !b?.length) return null;
  const m = new Map(); for (const c of [...(a || []), ...(b || [])]) m.set(c.id, c);
  return [...m.values()].sort((x, y) => x.at.localeCompare(y.at));
};
async function apply(row, live) {
  const local = (await db.get('items', row.id)) || null;
  // תגובות על משימה: מאחדים (שתי תגובות שנכתבו באותו זמן לא דורסות זו את זו)
  const merged = mergeComments(local?.comments, row.data?.comments);
  // יש אצלנו שינוי שעוד לא עלה לענן — השינוי שלנו גובר (הוא יעלה עוד רגע), רק מוסיפים לו תגובות חדשות
  if (local && (await db.getKV('outbox', [])).some(o => o.id === row.id)) {
    if (merged && merged.length !== (local.comments || []).length) { local.comments = merged; await db.put('items', local); cb.onItem?.(local, local, live); }
    return;
  }
  if (merged) row = { ...row, data: { ...row.data, comments: merged } };
  const next = { ...row.data, group_id: row.group_id, status: row.deleted ? 'deleted' : row.data.status };
  if (local) LOCAL_ONLY.forEach(k => { if (local[k] !== undefined) next[k] = local[k]; });
  await db.put('items', next);
  cb.onItem?.(local, next, live);
}
export async function pull() {
  if (!me) return 0;
  const c = await client();
  const since = await db.getKV('lastSync2', '1970-01-01T00:00:00Z');
  let from = since, n = 0;
  for (;;) {
    const { data, error } = await c.from('zman_tasks').select('*').gt('updated_at', from).order('updated_at').limit(1000);
    if (error) throw error;
    for (const row of data) { await apply(row, since !== '1970-01-01T00:00:00Z'); n++; }
    if (data.length) from = data[data.length - 1].updated_at;
    if (data.length < 1000) break;
  }
  await db.setKV('lastSync2', from);
  return n;
}
function subscribe() {
  stop();
  channel = sb.channel('zman-' + me.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'zman_tasks' }, async p => { if (p.new?.id) { await apply(p.new, true); const b = await busy(); if (b) cb.onBusy?.(b); cb.onRemote?.(); } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'zman_members' }, async () => { await loadGroups(); cb.onGroups?.(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'zman_categories' }, async () => { cb.onCats?.(await loadCategories()); })
    .subscribe();
}
function stop() { if (channel) { sb.removeChannel(channel); channel = null; } }

// זמנים תפוסים של מי שאני בקבוצה איתו — רק מתי, בלי מה
export async function busy() {
  if (!me || !navigator.onLine) return null;
  try {
    const { data, error } = await (await client()).rpc('zman_busy2');
    if (error) throw error;
    return (data || []).map(r => ({ id: 'busy-' + r.id, busy: true, status: 'open', kind: 'task', hasTime: true, due: r.due, dur: r.dur, by: r.owner }));
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
  document.addEventListener('visibilitychange', async () => { if (!document.hidden) { if (me) track.ping(sb); await loadGroups(); cb.onGroups?.(); refresh(); } });
}

/** מופעל בעליית האפליקציה. מחזיר { user } */
let ready = Promise.resolve();
export const whenReady = () => ready;
/** פתיחה: מה שבטלפון מיד (בלי לחכות לרשת), והענן ממשיך ברקע. בפעם הראשונה במכשיר — מחכים לפרופיל */
export async function start(callbacks) {
  cb = callbacks;
  if (DEMO) { // 🎭 משתמש, קבוצות ופרופיל מזויפים מתוך הארון של ההדגמה — בלי ענן בכלל
    me = await db.getKV('demoUser', null); groups = await db.getKV('groups', []) || []; profile = await db.getKV('profile', null);
    cb.onCats?.(await db.getKV('cats', []));
    return { user: me };
  }
  try { await currentUser(); } catch (e) { console.warn('sync start', e); }
  if (!me) return { user: null };
  track.ping(sb);
  hh = await db.getKV('household', null); groups = await db.getKV('groups', []) || []; profile = await db.getKV('profile', null);
  ready = (async () => {
    try {
      try { await loadHousehold(); } catch { /* בלי רשת */ }
      await loadProfile(); await loadGroups(); cb.onGroups?.();
      await connected(false);
    } catch (e) { console.warn('sync start', e); cb.onStatus?.('wait'); }
  })();
  if (!profile) await ready;
  return { user: me };
}
/** אחרי כניסה: מעלה את מה שכבר רשום בטלפון, מוריד את של הקבוצות, ומאזין לשינויים */
export async function connected(first = true) {
  if (first) {
    await db.setKV('lastSync2', '1970-01-01T00:00:00Z');
    try { await loadHousehold(); } catch { /* */ }
    await loadProfile(); await loadGroups();
  }
  await loadPeople();
  cb.onCats?.(await loadCategories());
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
  if (!me) throw new Error('צריך להיות מחובר');
  if (!pushSupported()) throw new Error('הדפדפן הזה לא תומך בהתראות. באייפון צריך קודם להוסיף את האפליקציה למסך הבית');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('לא ניתן אישור להתראות. אפשר לאשר בהגדרות הטלפון');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(VAPID_PUBLIC) });
  const json = sub.toJSON();
  const { error } = await (await client()).from('zman_push_subs').upsert({ endpoint: json.endpoint, user_id: me.id, household_id: null, sub: json, prefs: prefs || {}, updated_at: new Date().toISOString() });
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
  if (!me || DEMO || !rows.length || !navigator.onLine) return false;
  const { error } = await (await client()).from('zman_notify').upsert(rows.map(r => ({ household_id: null, created_by: me.id, sent_at: null, ...r })));
  if (error) { console.warn('notify', error); return false; }
  return true;
}
export async function deleteNotify(ids) {
  if (!me || DEMO || !ids.length || !navigator.onLine) return false;
  const { error } = await (await client()).from('zman_notify').delete().in('id', ids).is('sent_at', null);
  return !error;
}

// לבדיקות בלבד (בדפדפן של המפתח): מצב מדומה בלי חשבון אמיתי
let adminOf = null;
/** האם אני מנהל האפליקציה (בשביל כפתור "מצב הדגמה") — בדיקה בשרת */
export async function isAppAdmin() {
  if (DEMO) return true;
  if (!me || !navigator.onLine) return false;
  if (adminOf === me.id) return true;
  try { const ok = !!(await rpc('is_app_admin')); if (ok) adminOf = me.id; return ok; } catch { return false; }
}
export function _testState(st) { if (st.user) me = st.user; if (st.groups) groups = st.groups; if (st.profile) profile = st.profile; }
