// 🎭 מצב הדגמה: משפחה מזויפת בארון נפרד (zman-bekef-demo), בלי ענן בכלל.
// 🧭 סיור מודרך שעובר על כל האפשרויות, ו-💬 כפתור הערות שאוסף הכל ושולח בבת אחת.
// כלל קבוע: כל תוספת חדשה באפליקציה מקבלת שלב משלה במערך TOUR שלמטה.
import * as db from './db.js';
import { REVIEW } from './review.js';
import { nextOccurrence, sod, addDays, ymd } from './parse.js';

export const DEMO = db.DEMO;
const FLAG = 'zman-demo', NOTES = 'zman-demoNotes';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- כניסה ויציאה ----------
export function enter() {
  try { localStorage.setItem(FLAG, '1'); } catch { /* */ }
  location.reload();
}
export async function exit() {
  try { localStorage.removeItem(FLAG); } catch { /* */ }
  await new Promise(r => { const q = indexedDB.deleteDatabase(db.DEMO_DB); q.onsuccess = q.onerror = q.onblocked = () => r(); setTimeout(r, 1500); });
  location.href = location.pathname; // בלי ?tour וכו'
}

// ---------- המשפחה המזויפת ----------
const ME = 'demo-me', RUTI = 'demo-ruti', NOA = 'demo-noa', AVI = 'demo-avi';
const P = { me: 'u:' + ME, ruti: 'u:' + RUTI, yoavi: 'm:dm-3', noa: 'u:' + NOA, avi: 'u:' + AVI };
const prof = (uid, full_name, emoji) => ({ user_id: uid, full_name, emoji });
const GROUPS = [
  { id: 'dg-fam', name: 'משפחת לוי', kind: 'family', created_by: ME, code: 'DEMO2345', child_code: 'KIDS6789', myRole: 'admin', members: [
    { id: 'dm-1', group_id: 'dg-fam', user_id: ME, nickname: 'אבא', emoji: '🧔', role: 'admin', color: '#3B82F6', cal_share: 'all', profile: prof(ME, 'דני לוי', '🧔') },
    { id: 'dm-2', group_id: 'dg-fam', user_id: RUTI, nickname: 'אמא', emoji: '👩', role: 'admin', color: '#EC4899', cal_share: 'all', profile: prof(RUTI, 'רותי לוי', '👩') },
    { id: 'dm-3', group_id: 'dg-fam', user_id: null, nickname: 'יואבי', emoji: '👦', role: 'child', color: '#F97316' },
    { id: 'dm-4', group_id: 'dg-fam', user_id: NOA, nickname: 'נועה', emoji: '👧', role: 'child', color: '#22C55E', profile: prof(NOA, 'נועה לוי', '👧') },
  ] },
  { id: 'dg-work', name: 'המשרד', kind: 'team', created_by: ME, code: 'WORK3456', child_code: null, myRole: 'admin', members: [
    { id: 'dm-5', group_id: 'dg-work', user_id: ME, nickname: 'דני', emoji: '🧔', role: 'admin', color: '#3B82F6', cal_share: 'busy', profile: prof(ME, 'דני לוי', '🧔') },
    { id: 'dm-6', group_id: 'dg-work', user_id: AVI, nickname: 'אבי', emoji: '😎', role: 'member', color: '#7C3AED', cal_share: 'busy', profile: prof(AVI, 'אבי כהן', '😎') },
  ] },
];

export async function ensureSeed() {
  if (!DEMO || await db.getKV('demoSeeded', false)) return;
  const now = new Date(), iso = d => d.toISOString();
  const at = (days, h, m = 0) => { const d = addDays(sod(now), days); d.setHours(h, m, 0, 0); return d; };
  const ago = days => iso(addDays(now, -days));
  const items = [];
  const add = o => { const it = { id: db.newId(), kind: 'task', status: 'open', created: ago(3), due: null, hasTime: false, repeat: null, askAt: null, askedKey: null,
    forP: null, forU: null, private: false, group_id: null, by: ME, byP: P.me, dur: null, place: null, res: null, cat: null, steps: null, stars: null, ...o };
    if (it.due instanceof Date) it.due = iso(it.due); items.push(it); return it; };
  const steps = (arr, n) => arr.map((text, i) => ({ id: db.newId(), text, done: i < n }));
  const fri = (5 - now.getDay() + 7) % 7;

  // 📌 היום
  const bank = add({ text: 'להתקשר לבנק', due: at(0, 10), hasTime: true, cat: 'home' });
  const acc = add({ kind: 'meeting', text: 'פגישה עם רואה החשבון', due: at(0, 13), hasTime: true, dur: 60, place: 'משרד', group_id: 'dg-work', cat: 'work' });
  add({ text: 'לאסוף את יואבי מהגן', due: at(0, 16), hasTime: true, forP: P.ruti, forU: RUTI, group_id: 'dg-fam', cat: 'kids' });
  const elec = add({ text: 'לשלם חשמל', due: at(0, 0), cat: 'home' });
  add({ text: 'להוציא את הזבל', due: at(0, 20), hasTime: true, forP: 'any', group_id: 'dg-fam', cat: 'home' });
  add({ text: 'להחזיר ספר לספרייה', due: at(-1, 18), hasTime: true, cat: 'misc' }); // באיחור
  // ⭐ מטלות לילדים
  add({ text: 'לסדר את החדר', due: at(0, 17), hasTime: true, forP: P.yoavi, group_id: 'dg-fam', cat: 'kids', stars: 3 });
  add({ text: 'לקרוא 20 דקות', due: at(0, 19), hasTime: true, repeat: { type: 'daily' }, forP: P.noa, forU: NOA, group_id: 'dg-fam', cat: 'kids', stars: 2 });
  // 📋 צעדים + 💬 תגובות
  const shab = add({ text: 'הכנות לשבת', due: at(fri, 0), group_id: 'dg-fam', cat: 'home',
    steps: steps(['קניות לשבת', 'לבשל', 'להכין חלות', 'לנקות את הבית', 'לערוך שולחן', 'להפעיל פלטה ומיחם', 'הדלקת נרות'], 2),
    comments: [{ id: db.newId(), p: P.ruti, at: ago(1), text: 'אני מכינה את החלות 🍞' }, { id: db.newId(), p: P.me, at: ago(0.5), text: 'מעולה, אני על הקניות' }] });
  // 📅 מחר והלאה
  add({ kind: 'meeting', text: 'רופא שיניים לנועה', due: at(1, 15, 30), hasTime: true, dur: 45, group_id: 'dg-fam', cat: 'health', place: 'מרפאת השן' });
  const gift = add({ text: 'לקנות מתנה לסבתא', due: at(1, 0), by: RUTI, byP: P.ruti, forP: P.me, forU: ME, group_id: 'dg-fam', cat: 'shop',
    comments: [{ id: db.newId(), p: P.ruti, at: ago(0.2), text: 'אולי צעיף? 🧣' }] });
  add({ text: 'לשלוח הצעת מחיר', due: at(1, 11), hasTime: true, forP: P.avi, forU: AVI, group_id: 'dg-work', cat: 'work' });
  add({ text: 'הפתעה ליום ההולדת של רותי', due: at(6, 0), private: true, cat: 'home' });
  // 🏥 משמרות ואירועים (מהצ'אט החכם)
  add({ kind: 'meeting', event: true, icon: '🏥', text: 'משמרת בוקר', due: at(2, 7), hasTime: true, dur: 480, forP: P.ruti, forU: RUTI, group_id: 'dg-fam' });
  add({ kind: 'meeting', event: true, icon: '🏥', text: 'משמרת לילה · כוננות', due: at(3, 23), hasTime: true, dur: 480, forP: P.ruti, forU: RUTI, group_id: 'dg-fam' });
  add({ kind: 'meeting', event: true, icon: '🚗', text: 'רענון נהיגה', due: at(5, 8), hasTime: true, dur: 360 });
  // 🔁 חזרות (גם לפי הלוח העברי)
  const rep = (text, r, h, m, extra) => add({ text, repeat: r, due: nextOccurrence(r, h, m, now) || at(1, h, m), hasTime: h != null, ...extra });
  rep('להדליק נרות שבת', { type: 'weekly', dows: [5], erev: true }, 16, 0, { cat: 'home' });
  rep('לשלם לגננת', { type: 'weekly', dows: [4] }, 9, 0, { cat: 'kids' });
  rep('ראש חודש: לבדוק את החשבונות', { type: 'roshChodesh' }, 9, 0, { cat: 'home' });
  rep('ערב חג: להזמין פרחים', { type: 'erevChag' }, 10, 0, {});
  // 💊 תרופות וקבועים שנעצרים לבד
  const medRep = (text, r, extra) => { const it = add({ text, repeat: r, hasTime: true, med: true, shabbatOk: true, icon: '💊', cat: 'health', created: iso(new Date(r.start + 'T07:00')), ...extra });
    const doses = {}; let t = new Date(r.start + 'T00:00'), n = 0;
    for (let i = 0; i < 200; i++) { const d = nextOccurrence(r, 9, 0, t); if (!d || d > now) break; t = d; if (n++ % 7 !== 3) doses[d.toISOString()] = d.toISOString(); }
    it.doses = doses; it.due = nextOccurrence(r, 9, 0, now)?.toISOString() || null; return it; };
  medRep('אנטיביוטיקה', { type: 'daily', times: ['08:00', '14:00', '20:00'], start: ymd(addDays(now, -3)), until: ymd(addDays(now, 6)) });
  medRep('ויטמין D', { type: 'daily', start: ymd(addDays(now, -20)), until: ymd(addDays(now, 40)) });
  rep('להחליף פילטר במים', { type: 'months', n: 6, start: ymd(addDays(now, 12)) }, 10, 0, { cat: 'home' });
  // ✅ מה שכבר נעשה (בשביל הרצף והסיכומים)
  const doneT = ['לשלם ארנונה', 'לקבוע תור לרופא', 'לתקן את הברז', 'להזמין גז', 'לשלוח מייל לגננת', 'לאסוף חבילה מהדואר'];
  const log = [];
  doneT.forEach((text, i) => { const it = add({ text, status: 'done', due: iso(at(-i - 1, 9)), doneAt: iso(at(-i - 1, 12)), doneBy: P.me, cat: 'home' });
    log.push({ id: db.newId(), ts: it.doneAt, itemId: it.id, text, action: 'done' }); });
  // 💭 מחשבות
  for (const text of ['לסדר את המחסן', 'טיול משפחתי לצפון בחופש', 'לבדוק ביטוח רכב זול יותר', 'ספר שכדאי לקרוא: "הרגלים אטומיים"']) add({ kind: 'thought', text, created: ago(2) });
  // 🛒 קניות
  for (const [text, dept, st] of [['חלב', 'dairy'], ['ביצים', 'dairy'], ['עגבניות', 'veg'], ['מלפפונים', 'veg'], ['חלות', 'bread'], ['עוף', 'meat'], ['אורז', 'pantry'], ['במבה', 'snack'], ['נייר טואלט', 'clean'], ['שמפו', 'care'], ['מיץ ענבים', 'drink', 'done'], ['גבינה צהובה', 'dairy', 'done']])
    add({ kind: 'shop', text, dept, status: st || 'open', group_id: 'dg-fam', by: text === 'במבה' ? NOA : ME });
  // ⭐ כוכבים ופרסים
  for (const [kid, n, reason, d] of [[P.yoavi, 3, 'סידר את החדר', 1], [P.yoavi, 2, 'צחצח שיניים לבד', 2], [P.yoavi, 4, 'עזר בשולחן שבת', 4], [P.noa, 2, 'קראה 20 דקות', 1], [P.noa, 2, 'קראה 20 דקות', 2], [P.noa, 5, 'שיעורי בית', 3], [P.noa, -5, '🎁 גלידה', 2]])
    add({ kind: 'star', kid, n, reason, forP: kid, forU: kid === P.noa ? NOA : null, group_id: 'dg-fam', created: ago(d) });
  for (const [text, icon, cost] of [['גלידה', '🍦', 5], ['יציאה לפארק', '🎡', 10], ['משחק חדש', '🎮', 30]]) add({ kind: 'prize', text, icon, cost, group_id: 'dg-fam' });
  // 🔥 הרגלים
  const days = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [ymd(addDays(now, -i - 1)), true]));
  add({ kind: 'habit', text: 'לשתות 8 כוסות מים', icon: '💧', dows: null, log: days(6), private: true });
  add({ kind: 'habit', text: 'לימוד יומי', icon: '📖', dows: null, log: { ...days(12), [ymd(now)]: true }, private: true });
  add({ kind: 'habit', text: 'הליכה', icon: '🚶', dows: [0, 2, 4], log: {}, private: true });
  // 🔔 הקפצה מרותי
  add({ kind: 'msg', bump: gift.id, text: gift.text, from: P.ruti, forP: P.me, forU: ME, private: true, by: RUTI, group_id: 'dg-fam', replies: [], created: ago(0.1) });

  for (const it of items) await db.put('items', it);
  for (const l of log) await db.put('log', l);
  const bell = [
    { id: db.newId(), key: null, ic: '❤️', title: 'רותי הקפיצה לך', sub: gift.text, go: { item: gift.id }, at: ago(0.1), read: false },
    { id: db.newId(), key: null, ic: '💬', title: 'רותי הגיבה', sub: 'הכנות לשבת: אני מכינה את החלות 🍞', go: { item: shab.id }, at: ago(1), read: false },
    { id: db.newId(), key: null, ic: '✅', title: 'נועה סיימה', sub: 'לקרוא 20 דקות', go: null, at: ago(1.2), read: true },
  ];
  const msgs = [
    { role: 'me', text: 'תזכיר לי היום ב-10 להתקשר לבנק', ts: ago(0.3) },
    { role: 'bot', ic: '📌', bg: 'var(--g1)', title: 'להתקשר לבנק', sub: 'היום ב-10:00 · אשאל אותך אם עשית', acts: [], ts: ago(0.3) },
    { role: 'me', text: 'תכניס לרותי משמרת בוקר בעוד יומיים ומשמרת לילה כוננות אחר כך', ts: ago(0.25) },
    { role: 'bot', ic: '📅', bg: 'var(--g5)', title: 'הכנסתי 2 משמרות ליומן של רותי', sub: '🏥 משמרת בוקר 07:00–15:00\n🏥 משמרת לילה · כוננות 23:00–07:00', acts: [], ts: ago(0.25) },
    { role: 'bot', ic: '🎭', bg: 'linear-gradient(135deg,#F59E0B,#F97316)', title: 'ברוכים הבאים להדגמה!', sub: 'כאן הכל מזויף: משפחת לוי, משימות, קניות וכוכבים.\nאפשר ללחוץ על הכל ולנסות. שום דבר לא נשמר בענן.\n🧭 "סיור" למעלה עובר על כל האפשרויות, ו-💬 בצד שומר הערות.', acts: [], ts: iso(now) },
  ];
  for (const m of msgs) await db.put('msgs', { id: db.newId(), ...m });
  await db.setKV('demoUser', { id: ME, email: 'demo@zman-bekef.example' });
  await db.setKV('profile', { user_id: ME, full_name: 'דני לוי', emoji: '🧔', monthly_email: true });
  await db.setKV('groups', GROUPS);
  await db.setKV('cats', [{ id: 'dc-1', name: 'בית כנסת', icon: '🕍', color: '#0EA5E9', group_id: 'dg-fam', owner: ME }]);
  await db.setKV('bell', bell);
  await db.setKV('top3', { date: ymd(now), ids: [bank.id, acc.id, elec.id] });
  await db.setKV('welcomed2:' + ME, true);
  await db.setKV('migratedGroups', true);
  await db.setKV('demoSeeded', true);
}

// ---------- 🧭 הסיור: כל שלב = אפשרות אחת. v = המסך, sel = מה להאיר ----------
// ⚠️ כלל קבוע: כל תוספת חדשה מוסיפה כאן שלב.
export const TOUR = [
  { v: 'chat', sel: '#chat', t: '💬 השיחה', d: 'כאן כותבים או אומרים הכל, ו"זמן בכיף" מסדר: משימות, פגישות, תזכורות ומחשבות.' },
  { v: 'chat', sel: '#demoNotes', t: '💬 כפתור ההערות', d: 'ראית משהו לתקן? לוחצים כאן בכל שלב וכותבים. בסוף שולחים את כל ההערות בבת אחת.' },
  { v: 'chat', sel: '#inp', t: '✍️ לכתוב משפט רגיל', d: 'למשל: "תזכיר לי מחר ב-10 להתקשר לבנק" או "כל יום חמישי ב-9 לשלם לגננת".' },
  { v: 'chat', sel: '#mic', t: '🎤 הקלטה קולית', d: 'לוחצים ומדברים. גוררים למעלה 🔒 כדי להקליט בלי להחזיק.' },
  { v: 'chat', sel: '#inp', t: '🧠 הצ\'אט החכם', d: 'משפט עם כמה ימים ושעות נכנס ישר ליומן: "תכניס לרותי משמרות: ראשון ערב, שני לילה".' },
  { v: 'chat', sel: '.hero', t: '⭐ החשובים של היום', d: 'כמה שרוצים, נעוצים למעלה בשיחה. ▴ מקפל לשורה אחת.' },
  { v: 'chat', sel: '#inp', t: '🗑️ מחיקה ושאלות מהצ\'אט', d: '"תמחק את…" מוחק אחרי "בטוח?", עם ↩️ בטל. שאלה כמו "איך מוחקים?" מקבלת תשובה מהעזרה.' },
  { v: 'chat', sel: '#dayline', t: '🕐 היום שלי', d: 'ציר של היום: מה עבר, מה עכשיו ומה עוד מחכה. לחיצה פותחת את היומן.' },
  { v: 'chat', sel: '#plusBtn', t: '➕ מה מוסיפים?', d: 'ריבועים גדולים: משימה, תזכורת, פגישה, קניות, תרופה, הרגל, טיימר ועוד. לוחצים — ונפתח רק מה שצריך.' },
  { v: 'chat', sel: '#setBtn', t: '⚙️ הגדרות', d: 'למעלה: הגדרות והאזור האישי.' },
  { v: 'chat', sel: '#bellBtn', t: '🔔 הפעמון', d: 'כל מה שקרה: מי סיים, מי הגיב, מי הקפיץ לך ❤️.' },
  { v: 'chat', sel: '#todayBtn', t: '📋 מה יש לי היום', d: 'לחיצה אחת, וכל היום מופיע בשיחה.' },
  { v: 'chat', sel: '#helpBtn', t: '❓ עזרה', d: 'שואלים כל שאלה במילים רגילות, ויש גם קישור למדריך המלא.' },
  { v: 'cal', sel: '#calMode', t: '📅 היומן', d: 'יומי (24 שעות), שבועי או חודשי, עם תאריך עברי ולועזי.', run: a => a.calMode('day') },
  { v: 'cal', sel: '#calBody', t: '🗓️ תצוגה שבועית', d: 'כל השבוע במבט אחד. כל אחד במשפחה בצבע שלו.', run: a => a.calMode('week') },
  { v: 'cal', sel: '#calBody', t: '🗓️ תצוגה חודשית', d: 'נקודות צבעוניות לכל יום. לחיצה על יום פותחת אותו.', run: a => a.calMode('month') },
  { v: 'cal', sel: '#calWho', t: '👀 של מי היומנים', d: 'לוחצים על השמות כדי להראות או להסתיר: אני, רותי, הילדים, או 👨‍👩‍👧 כולם. שבת בזהב, חג בוורוד.', run: a => a.calMode('week') },
  { v: 'cal', sel: '.cal-ev, #calBody', t: '🗑️ מחיקה מהירה', d: 'לוחצים על אירוע ← 🗑️ מחיקה. טעיתם? ↩️ בטל.', run: a => a.calMode('day') },
  { v: 'tasks', sel: '#taskList', t: '📋 המשימות', d: 'כל מה שפתוח, לפי זמן. מחליקים משימה הצידה כדי למחוק.' },
  { v: 'tasks', sel: '#recurCard', t: '🔁 הקבועים שלי · 💊 תרופות', d: '"אנטיביוטיקה 3 פעמים ביום ל־10 ימים" נעצר לבד בסוף. "✅ לקחתי" בהתראה, ותזכורת שוב אחרי 10 דקות.' },
  { v: 'tasks', sel: '#whoFilter', t: '👥 לפי אנשים', d: 'רק שלי, של רותי, של הילדים, או של כולם.' },
  { v: 'tasks', sel: '#catFilter', t: '🏷️ קטגוריות', d: 'בית, עבודה, ילדים, בריאות, ומה שתוסיפו בעצמכם.' },
  { v: 'tasks', sel: '.habits, #taskList', t: '🔥 הרגלים וספירה', d: 'מסמנים כל יום ✓. "8 כוסות מים": כל לחיצה על + מוסיפה כוס (3/8).' },
  { v: 'tasks', sel: 'text:הכנות לשבת, #taskList', t: '🪜 צעדים ותבניות', d: 'משימה גדולה (הכנות לשבת, ניקיון פסח) מתפרקת לצעדים קטנים.' },
  { v: 'tasks', sel: '[data-op="comments"], #taskList', t: '💬 תגובות', d: 'כותבים הערה על משימה, וכל מי ששייך אליה מקבל הודעה.' },
  { v: 'chat', sel: 'text:פוקוס, #chat', t: '⏱️ טיימר פוקוס', d: '25 דקות עבודה ו-5 הפסקה, ובסוף שואל "סיימת?".' },
  { v: 'tasks', sel: '[data-op="bump"], #taskList', t: '🔔 להקפיץ', d: 'מזכירים בעדינות למי שהמשימה אצלו, עם ❤️.' },
  { v: 'thoughts', sel: '#thoughtList', t: '💭 תיבת מחשבות', d: 'רעיונות בלי תאריך. מתי שרוצים, הופכים אותם למשימה.' },
  { v: 'shop', sel: '#shopList', t: '🛒 רשימת קניות', d: 'כותבים "קניות: חלב, ביצים", והכל מסתדר לפי מחלקות בסופר.' },
  { v: 'shop', sel: '#shopLists', t: '🏪 רשימות בשמות שלכם', d: 'טמבור, ירקן, בית מרקחת: "➕ רשימה חדשה", ומה שמוסיפים נכנס לרשימה הפתוחה.' },
  { v: 'shop', sel: '#menuBtn', t: '🍲 תפריט שבת', d: 'בוחרים מנות, והמצרכים נכנסים לרשימה לבד.' },
  { v: 'kids', sel: '#kidList', t: '⭐ כוכבים לילדים', d: 'מטלה עם כוכבים, פרסים שההורים קובעים, וכוכבים שהופכים לשקלים בכסף בכיף.' },
  { v: 'settings', sel: '#meCard', t: '👤 האזור האישי', d: 'שם, אייקון, רצף ימים וכמה משימות בוצעו השבוע.' },
  { v: 'settings', sel: '#familyCard', t: '👨‍👩‍👧 קבוצות', d: 'משפחה, צוות או קשר ישיר. מזמינים בקוד או ב-QR, ולכל אחד יש צבע.' },
  { v: 'settings', sel: '#toNews', t: '✨ מה חדש', d: 'אחרי כל עדכון קופץ פעם אחת חלון קצר עם מה שהשתנה. כאן רואים את כל ההיסטוריה.' },
  { v: 'settings', sel: '#pushCard', t: '🔔 התראות לטלפון', d: 'בוחרים על מה לקבל התראה, גם כשהאפליקציה סגורה.' },
  { v: 'settings', sel: '#setCity', t: '🕯️ שבת וחגים', d: 'בשבת ובחג אין תזכורות. מה שנופל בהם עובר למוצאי שבת או חג.' },
  { v: 'settings', sel: '#viewCard', t: '🎨 תצוגה ומסך פתיחה', d: 'גודל טקסט, אנימציות, ו"📱 מסך הפתיחה": שיחה, יומן, משימות או קניות.' },
  { v: 'chat', sel: 'nav', t: '📩 מה חדש', d: 'מספר ירוק על הכפתורים כשמישהו הוסיף משהו, וקו "📩 לא נקראו" בשיחה — כמו בוואטסאפ.' },
  { v: 'settings', sel: '#calCard', t: '👀 מי רואה את היומן שלי', d: 'הכל, רק "תפוס", או כלום. לכל קבוצה בנפרד.' },
  { v: 'settings', sel: '#calSubCard', t: '📆 יומן של הטלפון', d: 'לחיצה אחת, וכל המשימות, הפגישות והתזכורות מופיעות ביומן של האייפון או של גוגל, ומתעדכנות לבד.' },
  { v: 'settings', sel: '#gcalCard', t: '📆 יומן גוגל', d: 'סנכרון לשני הכיוונים עם יומן גוגל.' },
  { v: 'settings', sel: '#catCard', t: '🏷️ עריכת קטגוריות', d: 'שם, אייקון וצבע לכל קטגוריה.' },
  { v: 'settings', sel: '#lockCard', t: '🔒 נעילה', d: 'קוד או טביעת אצבע, עם "שכחתי את הקוד".' },
  { v: 'settings', sel: '#feedbackBtn', t: '💌 משוב', d: 'רעיון, תקלה או מחמאה, ישר למייל.' },
  { v: 'settings', sel: '#backupBtn', t: '💾 גיבוי', d: 'שומרים עותק לקובץ, ומשחזרים ממנו מתי שצריך.' },
  { v: 'chat', sel: '#demoNotes', t: '🎉 סיימנו!', d: 'כל הערה שרשמתם ב-💬 מחכה כאן. בסוף לוחצים "📤 שלח את כל ההערות".' },
];

// ---------- הפעלה בתוך האפליקציה ----------
let A = null, step = -1, STEPS = TOUR;
const viewName = { chat: 'שיחה', cal: 'יומן', tasks: 'משימות', thoughts: 'מחשבות', shop: 'קניות', kids: 'ילדים', settings: 'הגדרות' };
const curView = () => document.querySelector('.view.on')?.id?.slice(2) || 'chat';

export function init(api) {
  A = api;
  if (!DEMO) return;
  document.documentElement.classList.add('demo-on');
  const bar = document.createElement('div'); bar.className = 'demo-bar'; bar.id = 'demoBar';
  bar.innerHTML = '<span>🎭 <b>מצב הדגמה</b> — הנתונים לא אמיתיים</span><button class="chip rv-btn" id="dbReview" hidden></button><button class="chip" id="demoTour">🧭 סיור</button><button class="chip" id="demoExit">יציאה ✕</button>';
  $('#app').prepend(bar);
  const fab = document.createElement('button'); fab.className = 'demo-fab'; fab.id = 'demoNotes'; fab.setAttribute('aria-label', 'הערות לתיקון');
  fab.innerHTML = '💬<i class="badge" id="demoCount" hidden></i>';
  $('#app').append(fab);
  const tour = document.createElement('div'); tour.className = 'tour'; tour.id = 'tour'; tour.hidden = true;
  tour.innerHTML = '<i class="tour-dim"></i><i class="tour-dim"></i><i class="tour-dim"></i><i class="tour-dim"></i><div class="tour-spot" id="tourSpot"></div><div class="tour-card" id="tourCard" role="dialog" aria-live="polite"></div>';
  $('#app').append(tour);
  $('#demoTour').onclick = () => startTour(0);
  $('#dbReview').onclick = reviewStart;
  $('#demoExit').onclick = e => {
    const b = e.currentTarget, n = notes().length;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = n ? `${nN(n)} ${n === 1 ? 'לא נשלחה' : 'לא נשלחו'} — לצאת?` : 'לצאת? לחיצה נוספת'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'יציאה ✕'; }, 4000); return; }
    exit();
  };
  fab.onclick = openNotes;
  tour.addEventListener('click', e => { if (e.target === tour || e.target.id === 'tourSpot') next(1); });
  // מקלדת שנפתחת באנדרואיד = resize. בזמן כתיבה לא מזיזים כלום
  addEventListener('resize', () => { if (step >= 0 && !$('#sheetBg').classList.contains('on') && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) place(); });
  drawCount(); reviewBadge();
}

// ---------- הסיור ----------
export function startTour(i = 0) { step = -1; STEPS = TOUR; $('#tour').hidden = false; go(i); }
function stopTour() { step = -1; STEPS = TOUR; $('#tour').hidden = true; document.documentElement.classList.remove('rv-on'); liftFab(); }
// כפתור ההערות לא מסתיר את כרטיס הסיור: כשהכרטיס למטה — הכפתור עולה מעליו
function liftFab() {
  const fab = $('#demoNotes'), card = $('#tourCard'); if (!fab) return;
  if (step < 0 || card.classList.contains('top')) { fab.style.bottom = ''; return; }
  const box = $('#app').getBoundingClientRect();
  fab.style.bottom = Math.round(box.bottom - card.getBoundingClientRect().top + 10) + 'px';
}
const next = d => go(Math.min(STEPS.length - 1, Math.max(0, step + d)));
function target(s) {
  for (const sel of s.sel.split(',').map(x => x.trim())) {
    if (sel.startsWith('text:')) { // האלמנט שמכיל את הטקסט (למשל משימה מסוימת)
      const t = sel.slice(5), hit = [...document.querySelectorAll(`#v-${s.v} button, #v-${s.v} .nm`)].reverse().find(e => e.textContent.includes(t) && e.offsetParent !== null);
      if (hit) return hit.classList.contains('nm') ? hit.parentElement : hit;
      continue;
    }
    const el = document.querySelector(`#v-${s.v} ${sel}`) || document.querySelector(sel);
    if (el && !el.hidden && el.offsetParent !== null && el.getBoundingClientRect().height > 0) return el;
  }
  return null;
}
async function go(i) {
  step = i; const s = STEPS[i];
  if (curView() !== s.v) A.showView(s.v);
  try { s.run?.(A); } catch (e) { console.warn('tour', e); }
  await new Promise(r => setTimeout(r, 260));
  const el = target(s);
  if (el) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); await new Promise(r => setTimeout(r, 60)); }
  drawCard(); place(); liftFab();
}
function place() {
  const s = STEPS[step]; if (!s) return;
  const el = target(s), spot = $('#tourSpot'), card = $('#tourCard'), box = $('#app').getBoundingClientRect();
  // ארבעה מלבנים כהים סביב "החור" שמאיר את הכפתור
  const dims = document.querySelectorAll('.tour-dim'), W = box.width, H = box.height;
  const hole = (x, y, w, h) => {
    const set = (d, l, t, ww, hh) => Object.assign(d.style, { left: l + 'px', top: t + 'px', width: Math.max(0, ww) + 'px', height: Math.max(0, hh) + 'px' });
    set(dims[0], 0, 0, W, y); set(dims[1], 0, y + h, W, H - y - h); set(dims[2], 0, y, x, h); set(dims[3], x + w, y, W - x - w, h);
  };
  if (!el) { spot.style.opacity = 0; hole(W / 2, H / 2, 0, 0); card.classList.remove('top'); liftFab(); return; }
  const r = el.getBoundingClientRect(), pad = 6;
  const top = Math.max(box.top + 4, r.top - pad), bottom = Math.min(box.bottom - 4, r.bottom + pad);
  const x = Math.max(4, r.left - box.left - pad), y = top - box.top, w = Math.min(W - 8, r.width + pad * 2), h = Math.max(30, bottom - top);
  Object.assign(spot.style, { opacity: 1, top: y + 'px', left: x + 'px', width: w + 'px', height: h + 'px' });
  hole(x, y, w, h);
  card.classList.toggle('top', (top + bottom) / 2 > box.top + box.height * 0.55);
  liftFab();
}
function drawCard(list) {
  const s = STEPS[step], n = STEPS.length, card = $('#tourCard');
  if (s?.review && !list) return reviewCard(card, s, step);
  card.classList.remove('rv');
  if (list) {
    card.innerHTML = `<div class="tour-h"><b>📋 כל השלבים</b><button class="tour-x" id="tourBack" aria-label="חזרה">↩️</button></div>
      <div class="tour-list">${STEPS.map((x, i) => `<button class="${i === step ? 'on' : ''}" data-ts="${i}"><span>${i + 1}</span>${esc(x.t)}</button>`).join('')}</div>`;
    card.querySelectorAll('[data-ts]').forEach(b => b.onclick = () => go(+b.dataset.ts));
    $('#tourBack').onclick = () => drawCard();
    card.querySelector('.tour-list .on')?.scrollIntoView({ block: 'center' });
    return;
  }
  card.innerHTML = `<div class="tour-h"><small>שלב ${step + 1} מתוך ${n}</small><button class="tour-x" id="tourX" aria-label="סגירת הסיור">✕</button></div>
    <div class="tour-bar"><i style="width:${((step + 1) / n) * 100}%"></i></div>
    <h4 class="tour-t">${esc(s.t)}</h4><p class="tour-d">${esc(s.d)}</p>
    <div class="tour-btns"><button class="btn" id="tourPrev" ${step ? '' : 'disabled'}>→ הקודם</button><button class="btn" id="tourAll" aria-label="כל השלבים">☰</button>
    <button class="btn pri" id="tourNext">${step === n - 1 ? '✅ סיום' : 'הבא ←'}</button></div>`;
  card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop');
  $('#tourX').onclick = stopTour;
  $('#tourPrev').onclick = () => next(-1);
  $('#tourAll').onclick = () => drawCard(true);
  $('#tourNext').onclick = () => step === n - 1 ? stopTour() : next(1);
  if (step === n - 1) A.confetti?.();
}

// ---------- 💬 הערות ----------
const notes = () => { try { return JSON.parse(localStorage.getItem(NOTES)) || []; } catch { return []; } };
const setNotes = l => { try { localStorage.setItem(NOTES, JSON.stringify(l)); } catch { /* */ } drawCount(); };
function drawCount() { const c = $('#demoCount'); if (!c) return; const n = notes().length; c.hidden = !n; c.textContent = n; }
const nN = n => n === 1 ? 'הערה אחת' : `${n} הערות`;
const where = () => `📍 מסך: ${viewName[curView()] || curView()}${step >= 0 ? (STEPS[step].review ? ` · 🔁 סיור תיקונים: ${STEPS[step].t}` : ` · שלב ${step + 1}: ${STEPS[step].t}`) : ''}`;
const allText = () => notes().map((x, i) => `${i + 1}. [${x.w}]\n${x.t}`).join('\n\n');
function openNotes() {
  const w = where(), list = notes();
  A.sheet(`<h3>💬 הערות לתיקון</h3>
    <p class="note" style="margin-bottom:8px">${esc(w)}</p>
    <textarea id="dnTxt" rows="4" class="fb-txt" placeholder="מה לתקן / לשפר כאן?"></textarea>
    <button class="btn pri" id="dnSave">➕ שמירת הערה</button>
    ${list.length ? `<h4 style="margin:14px 0 6px">📝 ${nN(list.length)} ${list.length === 1 ? 'מחכה' : 'מחכות'}</h4>
    <div class="dn-list">${list.map((x, i) => `<div class="dn-row"><div><small>${esc(x.w)}</small><div>${esc(x.t)}</div></div><button class="act" data-dnx="${i}" aria-label="מחיקת ההערה">🗑️</button></div>`).join('')}</div>
    <button class="btn pri" id="dnSend">📤 שלח את כל ההערות (${list.length})</button>
    <button class="btn" id="dnCopy">📋 העתק (להדביק בצ'אט עם Claude)</button>` : '<p class="note" style="margin-top:10px">ההערות נשמרות בטלפון עד שלוחצים "שלח", גם אם יוצאים מההדגמה.</p>'}
    <div id="dnErr" style="color:#FB7185;font-size:13px;min-height:16px"></div>`);
  setTimeout(() => $('#dnTxt')?.focus(), 200);
  $('#dnSave').onclick = () => {
    const t = $('#dnTxt').value.trim(); if (!t) return A.toast('צריך לכתוב משהו 🙂', true);
    setNotes([...notes(), { w, t: t.slice(0, 1000), at: new Date().toISOString() }]);
    A.closeSheet(); A.toast(`📝 נשמר (${nN(notes().length)})`);
  };
  document.querySelectorAll('[data-dnx]').forEach(b => b.onclick = () => { const l = notes(); l.splice(+b.dataset.dnx, 1); setNotes(l); openNotes(); });
  $('#dnCopy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText('הערות מצב הדגמה — זמן בכיף\n\n' + allText()); A.toast('📋 הועתק! אפשר להדביק'); } catch { A.toast('לא הצלחתי להעתיק', true); }
  });
  $('#dnSend')?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'שולח…';
    const ok = await A.sendNotes(allText(), notes().length);
    if (ok) { setNotes([]); A.closeSheet(); A.confetti?.(); A.toast('📤 כל ההערות נשלחו! תודה 🙏'); return; }
    b.disabled = false; b.textContent = '📤 שלח את כל ההערות';
    $('#dnErr').textContent = 'לא הצלחתי לשלוח. ההערות נשארו שמורות בטלפון. אפשר לנסות שוב, או "📋 העתק" ולהדביק בצ\'אט.';
  });
}

// ---------- 🔁 סיור תיקונים: עובר רק על המסכים שבהם נכתבו הערות, ומראה מה השתנה ----------
// נשמר בטלפון עד שהשליחה מצליחה (וגם אם יוצאים באמצע, ממשיכים מאותו מקום):
// zman-review = { [id]: 'ok' | 'bad' | 'seen' } · zman-review-notes = { [id]: 'הערה' } · zman-review-pos = id של העצירה האחרונה
// zman-review-sent = { [id]: 'ok' | 'bad' | 'note' }: מה כבר נשלח
const RV_KEY = 'zman-review', RV_NOTES = 'zman-review-notes', RV_POS = 'zman-review-pos', RV_SENT = 'zman-review-sent';
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } };
const rvGet = k => { try { const v = JSON.parse(lsGet(k) || '{}'); return v && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const rvSet = (k, v) => lsSet(k, JSON.stringify(v));
const RV_ST = { fixed: ['✅', 'תוקן'], answered: ['💬', 'נענה'], todo: ['⏳', 'עוד לא'] };
const REVIEW_AT = {
  back: { v: 'chat', sel: '#plusBtn' },
  chat: { v: 'chat', sel: '#inp' },
  top: { v: 'chat', sel: '.hero' },
  calWho: { v: 'cal', sel: '#calWho, #calBody', run: a => a.calMode?.('week') },
  month: { v: 'cal', sel: '#calBody', run: a => a.calMode?.('month') },
  mainDate: { v: 'settings', sel: '#calCard' },
  cats: { v: 'settings', sel: '#catCard' },
  habits: { v: 'tasks', sel: '.habits, #taskList' },
  focus: { v: 'chat', sel: 'text:פוקוס, #plusBtn' },
  shopLists: { v: 'shop', sel: '#shopLists' },
  menu: { v: 'shop', sel: '#menuBtn' },
  me: { v: 'settings', sel: '#meCard' },
  recur: { v: 'tasks', sel: '#recurCard, #taskList' },
  lock: { v: 'settings', sel: '#lockCard' },
  backup: { v: 'settings', sel: '#backupBtn' },
};
// עוד לא נסקרו: מה שתוקן / נענה, ושאין עליו סימון שכבר נשלח או מחכה לשליחה
const rvPending = () => { const done = rvGet(RV_KEY), sent = rvGet(RV_SENT); return REVIEW.filter(r => r.st !== 'todo' && !done[r.id] && !sent[r.id]); };
// מה שנכתב / סומן ועוד לא נשלח
function rvUnsent() {
  const done = rvGet(RV_KEY), notes = rvGet(RV_NOTES), sent = rvGet(RV_SENT);
  return REVIEW.filter(r => (done[r.id] && done[r.id] !== 'seen' && sent[r.id] !== done[r.id]) || (notes[r.id] || '').trim()).map(r => ({ r, st: done[r.id] || '', note: (notes[r.id] || '').trim() }));
}
function reviewBadge() {
  const b = $('#dbReview'); if (!b) return;
  const n = rvPending().length, u = rvUnsent().length;
  b.hidden = !n && !u; b.textContent = n ? `🔁 תיקונים ${n}` : `📤 ${u} לשליחה`;
}
function reviewStart() {
  if (!REVIEW.length) return;
  const order = [...REVIEW.filter(r => r.st !== 'todo'), ...REVIEW.filter(r => r.st === 'todo')];
  STEPS = order.map(r => ({ ...(REVIEW_AT[r.at] || REVIEW_AT.chat), t: r.where, review: r }));
  const pend = rvPending().map(r => r.id), pos = lsGet(RV_POS);
  let first = STEPS.findIndex(x => x.review.id === pos);
  if (first < 0) first = STEPS.findIndex(x => pend.includes(x.review.id));
  if (first < 0) { if (rvUnsent().length) { STEPS = TOUR; return reviewSummary(); } first = 0; }
  step = -1; $('#tour').hidden = false; document.documentElement.classList.add('rv-on'); go(first);
}
function reviewMark(id, v) { const d = rvGet(RV_KEY); d[id] = v; rvSet(RV_KEY, d); reviewBadge(); }
function reviewCard(card, s, i) {
  const r = s.review, [se, sl] = RV_ST[r.st] || RV_ST.fixed, n = STEPS.length, mine = rvGet(RV_KEY)[r.id], todo = r.st === 'todo';
  const notes = rvGet(RV_NOTES), cnt = Object.values(notes).filter(x => (x || '').trim()).length;
  const dd = new Date(r.date + 'T12:00:00').toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
  lsSet(RV_POS, r.id);
  card.classList.add('rv');
  card.innerHTML = `<div class="tour-bar"><i style="width:${(i + 1) / n * 100}%"></i></div>
    <div class="rv-top"><small>🔁 ${i + 1} מתוך ${n} · הערה מ־${dd}</small><span class="rv-cnt ${cnt ? 'on' : ''}">💬 ${cnt} הערות</span></div>
    <div class="rv-h"><span class="rv-st ${r.st}">${se} ${sl}</span><b>${esc(r.where)}</b></div>
    <div class="rv-note" title="לחיצה: לקרוא הכל"><small>📝 ההערה שלך</small>${esc(r.note)}</div>
    <div class="rv-did ${r.st}"><small>${todo ? '⏳ מה מתוכנן' : r.st === 'answered' ? '💬 התשובה' : '✨ מה שינינו'}</small>${esc(r.did)}</div>
    ${r.before ? '<button class="chip" id="rBefore" style="margin-bottom:8px">👀 איך זה היה לפני</button>' : ''}
    <label class="rv-say"><span>💬 הערה על התיקון הזה</span><textarea id="rNote" rows="2" placeholder="${todo ? 'משהו להוסיף לפני שנבנה?' : 'מה עוד לא טוב? מה לשנות? (לא חובה)'}">${esc(notes[r.id] || '')}</textarea></label>
    ${todo ? '' : `<div class="rv-big"><button class="ok ${mine === 'ok' ? 'on' : ''}" id="rOk">✅ מאשר</button><button class="bad ${mine === 'bad' ? 'on' : ''}" id="rBad">🔧 עוד לא טוב</button></div>`}
    <div class="tour-btns rv-nav"><button class="btn" id="tourPrev" ${i ? '' : 'disabled'} aria-label="הקודם">→</button><button class="btn pri" id="tourNext">${i === n - 1 ? '📤 לסיכום ושליחה' : 'הבא ←'}</button><button class="btn" id="tourX" aria-label="יציאה. ממשיכים אחר כך מכאן">✕</button></div>`;
  card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop');
  const ta = card.querySelector('#rNote');
  const saveNote = () => { const all = rvGet(RV_NOTES); const v = ta.value; if (v.trim()) all[r.id] = v.slice(0, 1000); else delete all[r.id]; rvSet(RV_NOTES, all);
    const c = Object.values(all).filter(x => (x || '').trim()).length, el = card.querySelector('.rv-cnt'); el.textContent = `💬 ${c} הערות`; el.classList.toggle('on', !!c); reviewBadge(); };
  ta.addEventListener('input', saveNote);
  card.querySelector('.rv-note').onclick = e => { e.currentTarget.classList.toggle('open'); place(); };
  const fwd = () => { if (i >= n - 1) { stopTour(); reviewBadge(); return reviewSummary(); } go(i + 1); };
  $('#tourPrev').onclick = () => { saveNote(); go(i - 1); };
  $('#tourNext').onclick = () => { saveNote(); if (todo && !mine) reviewMark(r.id, 'seen'); fwd(); };
  $('#tourX').onclick = () => { saveNote(); stopTour(); reviewBadge(); if (rvUnsent().length) A.toast('💾 ההערות נשמרו. ממשיכים מכאן ב"🔁 תיקונים"'); };
  $('#rOk')?.addEventListener('click', () => { saveNote(); reviewMark(r.id, 'ok'); A.confetti?.(); setTimeout(fwd, 350); });
  $('#rBad')?.addEventListener('click', e => { reviewMark(r.id, 'bad'); $('#rOk').classList.remove('on'); e.currentTarget.classList.add('on');
    ta.closest('.rv-say').classList.add('need'); ta.placeholder = 'מה עוד לא טוב? כתוב כאן 👇'; ta.focus(); });
  card.querySelector('#rBefore')?.addEventListener('click', () => {
    const ov = document.createElement('div'); ov.className = 'qr-zoom';
    ov.innerHTML = `<div class="qr-card" style="padding:10px"><div class="note" style="margin-bottom:6px">👀 לפני התיקון</div><img src="${esc(r.before)}" alt="לפני" style="width:100%;max-height:70vh;object-fit:contain;border-radius:14px"><button class="btn pri" style="margin-top:10px">סגירה</button></div>`;
    ov.onclick = ev => { if (ev.target === ov || ev.target.closest('button')) ov.remove(); }; document.body.appendChild(ov);
  });
}
function reviewSummary() {
  const list = rvUnsent(), ok = list.filter(x => x.st === 'ok'), bad = list.filter(x => x.st === 'bad'), withNote = list.filter(x => x.note);
  const left = rvPending().filter(r => !list.some(x => x.r.id === r.id));
  const ordered = [...bad, ...list.filter(x => x.st !== 'bad')];
  const item = x => `<div class="rv-li ${x.st}"><b>${x.st === 'ok' ? '✅' : x.st === 'bad' ? '🔧' : '💬'} ${esc(x.r.where)}</b>${x.note ? `<p>💬 ${esc(x.note)}</p>` : ''}</div>`;
  A.sheet(`<div class="nw-head"><span class="nw-spark">🔁</span><h3>סיכום סיור התיקונים</h3></div>
    <div class="rv-sum"><div><b>${ok.length}</b><span>✅ אושרו</span></div><div><b>${bad.length}</b><span>🔧 עוד לא טוב</span></div><div><b>${withNote.length}</b><span>💬 הערות</span></div><div><b>${left.length}</b><span>⏭️ לא נבדקו</span></div></div>
    ${list.length ? `<div class="rv-list">${ordered.map(item).join('')}</div>
      <button class="btn pri rv-send" id="rvSend">📤 שליחה (${list.length})</button>` : '<p class="note" style="text-align:center;margin:8px 0">אין מה לשלוח. הכל כבר נשלח 👍</p>'}
    <button class="btn" id="rvAgain">🔁 ${left.length ? `להמשיך (${left.length} לא נבדקו)` : 'לעבור שוב'}</button><div id="rvErr" style="color:#FB7185;font-size:13px;min-height:16px"></div>`);
  $('#rvAgain').onclick = () => { lsSet(RV_POS, ''); A.closeSheet(); setTimeout(reviewStart, 250); };
  $('#rvSend')?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'שולח…';
    const line = (x, k) => `${k + 1}. ${x.st === 'ok' ? '✅ מאשר' : x.st === 'bad' ? '🔧 עוד לא טוב' : '💬 הערה'} · ${x.r.where} (${x.r.id})\n   📝 ההערה המקורית: ${x.r.note.slice(0, 140)}${x.r.note.length > 140 ? '…' : ''}${x.note ? `\n   💬 עכשיו: ${x.note}` : ''}`;
    const msg = `✅ ${ok.length} אושרו · 🔧 ${bad.length} עוד לא טוב · 💬 ${withNote.length} הערות\n\n` + ordered.map(line).join('\n\n');
    const okSent = await A.sendNotes(msg, list.length, { label: 'סיור תיקונים', kind: bad.length || withNote.length ? 'idea' : 'approval', subject: `🔁 סיור תיקונים — זמן בכיף (✅ ${ok.length} · 🔧 ${bad.length})` });
    if (okSent) {
      const sent = rvGet(RV_SENT), notes = rvGet(RV_NOTES);
      for (const x of list) { sent[x.r.id] = x.st || 'note'; delete notes[x.r.id]; }
      rvSet(RV_SENT, sent); rvSet(RV_NOTES, notes); if (!left.length) lsSet(RV_POS, '');
      reviewBadge(); A.confetti?.(); A.toast('📤 נשלח. תודה! נעבור על זה'); A.closeSheet(); return;
    }
    b.disabled = false; b.textContent = `📤 שליחה (${list.length})`;
    $('#rvErr').textContent = 'לא הצלחתי לשלוח (אין אינטרנט?). ההערות שמורות בטלפון, ואפשר לנסות שוב.';
  });
}
