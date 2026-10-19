// 🧠 צ'אט חכם: משפט אחד → כמה אירועים ביומן.
// "תכניס לפסי משמרות בראשון ערב שני לילה רביעי בוקר" → 3 משמרות ביומן של פסי.
// מחזיר null כשזה לא משפט "ליומן" (ואז ממשיכים בדרך הרגילה: תזכורת, משימה, מחשבה).
import { sod, addDays } from './parse.js';

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const DAY_RE = new RegExp(`^(?:ו?ב?יום\\s+|ו?ב|ו)?(${DAY_NAMES.join('|')})(?:\\s+בשבוע)?$`);
const PARTS = { 'בוקר': 'morning', 'בבוקר': 'morning', 'צהריים': 'noon', 'בצהריים': 'noon', 'צהרים': 'noon', 'בצהרים': 'noon',
  'אחה"צ': 'after', 'אחה״צ': 'after', 'ערב': 'evening', 'בערב': 'evening', 'לילה': 'night', 'בלילה': 'night' };
const PART_LBL = { morning: 'בוקר', noon: 'צהריים', after: 'אחה"צ', evening: 'ערב', night: 'לילה' };
// שעה רגילה לחלק יום (לא משמרת)
const PART_TIME = { morning: '09:00', noon: '12:00', after: '16:00', evening: '19:00', night: '22:00' };
const VERB_RE = /^(?:תכניס|תכניסי|הכנס|להכניס|תוסיף|תוסיפי|הוסף|להוסיף|תרשום|תרשמי|רשום|לרשום|תשבץ|תשבצי|שבץ|לשבץ|תקבע|תקבעי|קבע|לקבוע)(?=\s|$)\s*/;
const SINGULAR = [[/^משמרות$/, 'משמרת'], [/^פגישות$/, 'פגישה'], [/^חוגים$/, 'חוג'], [/^שיעורים$/, 'שיעור'], [/^תורים$/, 'תור'], [/^אימונים$/, 'אימון'], [/^ארוחות$/, 'ארוחה']];
export const ICONS = [[/משמרת|תורנות/, '🏥'], [/חוג|שיעור|קורס/, '🎨'], [/ארוחה|ארוחת|סעודה/, '🍽️'], [/אימון|ספורט|חדר כושר|בריכה/, '🏋️'], [/רופא|תור ל|בדיקה/, '🩺'], [/פגישה|פגישות/, '👥'], [/יום הולדת|חתונה|בר מצווה|שמחה|ברית/, '🎉'], [/טיסה|נסיעה/, '✈️']];
export const iconFor = t => ICONS.find(([re]) => re.test(t))?.[1] || '📅';

const hhmm = (h, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/**
 * @param text המשפט
 * @param ctx { names: [{id, name}] (בלי אני), shifts: {morning:[s,e],evening:[s,e],night:[s,e]}, now }
 */
export function smartParse(text, ctx) {
  const now = ctx.now || new Date();
  let t = text.trim().replace(/[!?]+/g, ' ');
  t = monthDates(t);
  t = t.replace(/\.(?=\s|$)/g, ' , ').replace(/[״"]/g, '"');
  // "מ8 בבוקר עד 2" / "בין 8 ל-2" → "מ8 עד 2" (חלק היום רק עוזר להבין בוקר/ערב)
  t = t.replace(/(^|\s)בין\s+(\d{1,2}(?::\d{2})?)\s+(?:ל-?|לבין\s+)(\d{1,2}(?::\d{2})?)(?=\s|$)/g, '$1מ$2 עד $3');
  t = t.replace(/(^|\s)(ו?מ-?\d{1,2}(?::\d{2})?)\s+(?:בבוקר|בצהריים|בצהרים|בערב|בלילה|אחה"צ)\s+עד/g, '$1$2 עד');
  t = t.replace(/(^|\s)עד\s+(?:ה-?|השעה\s+)?(\d{1,2}(?::\d{2})?)(?:\s+(?:בצהריים|בצהרים|אחה"צ|בערב|בלילה))?(?=\s|$)/g, '$1עד $2');
  if (/^(?:תזכיר|תזכירי|להזכיר|תגיד|תגידי|תשאל|תשאלי)\b/.test(t)) return null; // תזכורת רגילה
  const verb = VERB_RE.test(t);
  t = t.replace(VERB_RE, '');
  // ליומן / ללוח
  t = t.replace(/(^|\s)(?:ל|אל\s+ה)?(?:יומן|לוח)(?:\s+של\s+\S+)?(?=\s|$)/, ' ');
  // למי
  let who = null, whoName = null;
  const people = [...(ctx.names || [])].filter(x => x.name).sort((a, b) => b.name.length - a.name.length);
  const take = re => { const m = t.match(re); if (m) t = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim(); return !!m; };
  if (take(/(^|\s)(?:לנו|לשנינו|לשנינו\s+ביחד|לשנינו\s+יחד)(?=\s|$)/)) who = 'us';
  else if (take(/(^|\s)(?:לי|בשבילי|ביומן שלי)(?=\s|$)/)) who = 'me';
  else for (const p of people) {
    const n = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (take(new RegExp(`(^|\\s)(?:ל|בשביל\\s+|של\\s+|ליומן\\s+של\\s+)${n}(?=[\\s,:]|$)`))) { who = p.id; whoName = p.name; break; }
  }
  // שבוע הבא / כל (קבוע)
  let weekOffset = 0, every = false;
  if (take(/(^|\s)(?:ב?שבוע\s+הבא|בשבוע\s+שאחרי)(?=[\s:,]|$)/)) weekOffset = 1;
  take(/(^|\s)(?:ב|של\s+)?השבוע(?=[\s:,]|$)/); // "השבוע" — הימים הקרובים (כך ממילא)
  if (/(^|\s)כל(?=\s)/.test(t)) { every = true; t = t.replace(/(^|\s)כל(?=\s)/g, ' '); }
  // מילים
  const toks = t.replace(/[,;]/g, ' , ').replace(/:(?!\d)/g, ' , ').replace(/\s+-\s+/g, ' ').split(/\s+/).filter(Boolean);
  const slots = [], title = [];
  let pendingPart = null, pendingTime = null, pendingRange = null, range = null, lastTimed = [];
  const timeTok = (w, next) => {
    // ב-5 / ב5 / בשעה 17:30 / 17:30 / ב-10:15
    const m = w.match(/^(?:ו?ב-?|ו?בשעה|ו?ב־)?(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return null;
    let h = +m[1]; const mi = +(m[2] || 0);
    if (h > 23 || mi > 59) return null;
    return { h, m: mi, raw: w };
  };
  for (let i = 0; i < toks.length; i++) {
    let w = toks[i];
    { const base = w.replace(/^ו?ב?/, ''); if (DAY_FIX[w] || DAY_FIX[base]) w = DAY_FIX[w] || DAY_FIX[base]; }
    if (w === ',' || w === 'ו' || w === 'וגם' || w === 'גם') continue;
    if (w === 'בשעה' && toks[i + 1]) { w = 'ב' + toks[++i]; }
    if (w === 'ביום' && toks[i + 1] && DAY_NAMES.includes(toks[i + 1].replace(/^ו?ב?/, ''))) { w = 'ב' + toks[++i]; }
    const dm = w.match(DAY_RE);
    if (dm) { lastTimed = []; slots.push({ dow: DAY_NAMES.indexOf(dm[1]), part: pendingPart, pp: !!pendingPart, time: pendingTime }); pendingPart = null; pendingTime = null; continue; }
    const dateM = w.match(/^(?:ו?ב-?|ו?ה-?)?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
    if (dateM) { slots.push({ date: { d: +dateM[1], m: +dateM[2] - 1, y: dateM[3] ? +(dateM[3].length === 2 ? '20' + dateM[3] : dateM[3]) : null }, part: pendingPart, time: pendingTime }); pendingPart = null; pendingTime = null; continue; }
    const rel = { 'היום': 0, 'מחר': 1, 'מחרתיים': 2, 'ומחר': 1, 'והיום': 0 }[w];
    if (rel != null) { slots.push({ rel, part: pendingPart, time: pendingTime }); pendingPart = null; pendingTime = null; continue; }
    const pw = PARTS[w.replace(/^ו/, '')];
    if (pw) {
      if (lastTimed.length) { lastTimed.forEach(x => { if (!x.part) x.part = pw; }); lastTimed = []; continue; } // "בשמונה בערב" — לכל הימים של השעה הזאת
      const last = slots[slots.length - 1];
      if (last && !last.time && (!last.part || last.pp)) { last.part = pw; last.pp = false; } // "שלישי בוקר" — החלק שאחרי היום הוא שלו
      else pendingPart = pw;
      continue;
    }
    if (/^(?:אחר|ואחר)$/.test(w) && /^הצהריים|^הצהרים/.test(toks[i + 1] || '')) { i++; const last = slots[slots.length - 1]; if (last && !last.part && !last.time) last.part = 'after'; else pendingPart = 'after'; continue; }
    // טווח: מ-9 עד 13
    const fr = w.match(/^(?:ו?מ-?|ו?משעה)(\d{1,2})(?::(\d{2}))?$/);
    if (fr && /^(?:עד|ל-?)$/.test(toks[i + 1] || '') && /^\d{1,2}(?::\d{2})?$/.test(toks[i + 2] || '')) {
      const [eh, em] = toks[i + 2].split(':').map(Number);
      range = { s: { h: +fr[1], m: +(fr[2] || 0) }, e: { h: eh, m: em || 0 } }; i += 2;
      const open = [];
      for (let k = slots.length - 1; k >= 0 && !slots[k].time && !slots[k].range; k--) open.push(slots[k]);
      if (open.length) open.forEach(x => { x.range = range; }); else pendingRange = range; // "בין 9 ל-11 ביום חמישי" — השעות לפני היום
      continue;
    }
    // שעה במילים: "בשמונה", "בשבע וחצי"
    const nw = w.match(/^(?:ו?ב)(אחת|שתיים|שתים|שלוש|ארבע|חמש|שש|שבע|שמונה|תשע|עשר|אחת-עשרה|שתים-עשרה)$/);
    if (nw) {
      const NW = { 'אחת': 1, 'שתיים': 2, 'שתים': 2, 'שלוש': 3, 'ארבע': 4, 'חמש': 5, 'שש': 6, 'שבע': 7, 'שמונה': 8, 'תשע': 9, 'עשר': 10, 'אחת-עשרה': 11, 'שתים-עשרה': 12 };
      let mi = 0; if (/^וחצי$/.test(toks[i + 1] || '')) { mi = 30; i++; } else if (/^ורבע$/.test(toks[i + 1] || '')) { mi = 15; i++; }
      w = 'ב' + NW[nw[1]] + (mi ? ':' + mi : '');
    }
    const tm = /^(?:ו?ב-?|ו?ב־)\d|^\d{1,2}:\d{2}$/.test(w) ? timeTok(w) : null;
    if (tm) {
      // שעה אחרי רשימת ימים בלי שעה — לכולם ("בשלישי וחמישי ב-5")
      const open = [];
      for (let k = slots.length - 1; k >= 0 && !slots[k].time && !slots[k].part && !slots[k].range; k--) open.push(slots[k]);
      if (open.length) { open.forEach(s => { s.time = tm; }); lastTimed = open; } else pendingTime = tm;
      continue;
    }
    if (slots.length) (slots[slots.length - 1].extra ||= []).push(w); else title.push(w);
    lastTimed = [];
  }
  // אם אין שם לפני הימים ("תכניס ב18.12 וב25.12 רענון נהיגה") — המילים שאחרי הם השם של כולם
  if (!title.length && slots.some(x => x.extra)) { for (const x of slots) if (x.extra) { title.push(...x.extra); x.extra = null; } }
  if (pendingPart && slots.length) slots.filter(s => !s.part && !s.time).forEach(s => { s.part = pendingPart; });
  if (pendingTime && slots.length) slots.filter(s => !s.part && !s.time).forEach(s => { s.time = pendingTime; });
  if (pendingRange && slots.length) slots.filter(s => !s.time && !s.range).forEach(s => { s.range = pendingRange; });
  // שם האירוע
  let name = title.join(' ').replace(/^(?:ב|ה)?(?:יום|ביום)\s*$/, '').replace(/\s+/g, ' ').trim();
  name = name.split(' ').map((w, i) => { if (i) return w; for (const [re, s] of SINGULAR) if (re.test(w)) return s; return w; }).join(' ');
  const isShift = /^משמרת|תורנות/.test(name);
  const isEvent = verb || isShift || slots.length >= 2;
  if (!isEvent) return null;
  if (!name) name = isShift ? 'משמרת' : 'אירוע';
  if (!slots.length) return isShift ? { who, whoName, title: name, isShift, events: [], missing: 'when' } : null; // בלי מתי — משימה רגילה ("תכניס לנתנאל לסדר את החדר")

  // תאריכים: ימים לפי הסדר, כל אחד אחרי הקודם
  const start = weekOffset ? addDays(sod(now), 7 - sod(now).getDay()) : sod(now);
  let cursor = start;
  const events = [];
  for (const s of slots) {
    let day;
    if (s.date) { day = new Date(s.date.y || now.getFullYear(), s.date.m, s.date.d); if (!s.date.y && day < sod(now)) day.setFullYear(day.getFullYear() + 1); }
    else if (s.rel != null) day = addDays(sod(now), s.rel);
    else {
      day = new Date(every ? start : cursor); // קבוע ("כל שני ורביעי") — כל יום מהיום, לא אחד אחרי השני
      while (day.getDay() !== s.dow) day = addDays(day, 1);
      if (+day === +sod(now) && !weekOffset) { // היום — רק אם השעה עוד לא עברה
        const t0 = slotStart(s, isShift, ctx.shifts); if (t0 && toMin(t0) <= now.getHours() * 60 + now.getMinutes()) day = addDays(day, 7);
      }
    }
    cursor = day;
    const st = slotStart(s, isShift, ctx.shifts);
    let dur = null;
    if (s.range) { let eh = s.range.e.h; if (eh < s.range.s.h && eh <= 12 && eh + 12 > s.range.s.h) eh += 12; dur = (toMin(hhmm(eh, s.range.e.m)) - toMin(hhmm(s.range.s.h, s.range.s.m)) + 1440) % 1440 || null; }
    else if (isShift && s.part && ctx.shifts?.[shiftKey(s.part)]) { const [a, b] = ctx.shifts[shiftKey(s.part)]; dur = (toMin(b) - toMin(a) + 1440) % 1440 || 480; }
    const due = new Date(day);
    if (st) { const [h, m] = st.split(':').map(Number); due.setHours(h, m, 0, 0); }
    const t1 = isShift && s.part ? `משמרת ${PART_LBL[shiftKey(s.part)] || PART_LBL[s.part]}` : name + (s.part && !st ? '' : '');
    const ex = s.extra?.length ? s.extra.join(' ') : '';
    events.push({ title: (isShift ? t1 : name) + (ex ? ` · ${ex}` : ''), due, hasTime: !!st, dur: dur ?? (st ? 60 : null), part: s.part,
      repeat: every && s.dow != null ? { type: 'weekly', dows: [s.dow] } : null });
  }
  // "כל ראשון וחמישי ב-5" עם אותה שעה → אירוע קבוע אחד
  if (every && events.length > 1 && events.every(e => e.repeat && e.title === events[0].title && e.due.getHours() === events[0].due.getHours() && e.due.getMinutes() === events[0].due.getMinutes())) {
    events[0].repeat = { type: 'weekly', dows: events.map(e => e.repeat.dows[0]).sort() }; events[0].due = new Date(Math.min(...events.map(e => +e.due))); events.length = 1;
  }
  return { who, whoName, title: name, isShift, events, missing: null };
}
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const MON_RE = `(${MONTHS.join('|')}|מרס)`;
// טעויות נפוצות של הקלטה / הקלדה בימים
const DAY_FIX = { 'למישי': 'חמישי', 'חמשי': 'חמישי', 'ראשן': 'ראשון', 'שלשי': 'שלישי', 'רבעי': 'רביעי', 'רביעיי': 'רביעי', 'שישיי': 'שישי' };
// "ב18 וב25 לדצמבר" / "18 בדצמבר" / "ה-3 לנובמבר" → "18.12 וב25.12"
function monthDates(t) {
  const re = new RegExp(`((?:ה-?|ב-?|ו?ב-?|ו?ה-?)?\\d{1,2}(?:\\s*(?:,|ו|וגם)?\\s*(?:ו?ב-?|ו?ה-?|ו)?\\d{1,2})*)\\s+(?:ל|ב|של\\s+)?${MON_RE}(?=[\\s.,]|$)`, 'g');
  return t.replace(re, (all, nums, mon) => {
    const m = mon === 'מרס' ? 3 : MONTHS.indexOf(mon) + 1;
    return nums.replace(/(\d{1,2})(?![\d:])/g, `$1.${m}`);
  });
}
const shiftKey = p => (p === 'noon' || p === 'after') ? 'evening' : p;
function slotStart(s, isShift, shifts) {
  if (s.range) return hhmm(s.range.s.h, s.range.s.m);
  if (s.time) {
    let h = s.time.h;
    if (h >= 1 && h <= 7 && s.part !== 'morning') h += 12; // "ב-5" = 17:00
    if (s.part === 'evening' || s.part === 'night' || s.part === 'after') { if (h < 12) h += 12; }
    return hhmm(h % 24, s.time.m);
  }
  if (s.part) return isShift && shifts?.[shiftKey(s.part)] ? shifts[shiftKey(s.part)][0] : PART_TIME[s.part];
  return null;
}
