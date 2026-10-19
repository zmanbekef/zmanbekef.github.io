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
  let t = text.trim().replace(/[.!]+$/, '');
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
  if (/(^|\s)כל(?=\s)/.test(t)) { every = true; t = t.replace(/(^|\s)כל(?=\s)/g, ' '); }
  // מילים
  const toks = t.replace(/[,;]/g, ' , ').replace(/:(?!\d)/g, ' , ').replace(/\s+-\s+/g, ' ').split(/\s+/).filter(Boolean);
  const slots = [], title = [];
  let pendingPart = null, pendingTime = null, range = null;
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
    if (w === ',' || w === 'ו' || w === 'וגם' || w === 'גם') continue;
    if (w === 'בשעה' && toks[i + 1]) { w = 'ב' + toks[++i]; }
    if (w === 'ביום' && toks[i + 1] && DAY_NAMES.includes(toks[i + 1].replace(/^ו?ב?/, ''))) { w = 'ב' + toks[++i]; }
    const dm = w.match(DAY_RE);
    if (dm) { slots.push({ dow: DAY_NAMES.indexOf(dm[1]), part: pendingPart, time: pendingTime }); pendingPart = null; pendingTime = null; continue; }
    const dateM = w.match(/^(?:ו?ב-?)?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
    if (dateM) { slots.push({ date: { d: +dateM[1], m: +dateM[2] - 1, y: dateM[3] ? +(dateM[3].length === 2 ? '20' + dateM[3] : dateM[3]) : null }, part: pendingPart, time: pendingTime }); pendingPart = null; pendingTime = null; continue; }
    const rel = { 'היום': 0, 'מחר': 1, 'מחרתיים': 2, 'ומחר': 1, 'והיום': 0 }[w];
    if (rel != null) { slots.push({ rel, part: pendingPart, time: pendingTime }); pendingPart = null; pendingTime = null; continue; }
    const pw = PARTS[w.replace(/^ו/, '')];
    if (pw) { const last = slots[slots.length - 1]; if (last && !last.part && !last.time) last.part = pw; else pendingPart = pw; continue; }
    if (/^(?:אחר|ואחר)$/.test(w) && /^הצהריים|^הצהרים/.test(toks[i + 1] || '')) { i++; const last = slots[slots.length - 1]; if (last && !last.part && !last.time) last.part = 'after'; else pendingPart = 'after'; continue; }
    // טווח: מ-9 עד 13
    const fr = w.match(/^(?:ו?מ-?|ו?משעה)(\d{1,2})(?::(\d{2}))?$/);
    if (fr && /^(?:עד|ל-?)$/.test(toks[i + 1] || '') && /^\d{1,2}(?::\d{2})?$/.test(toks[i + 2] || '')) {
      const [eh, em] = toks[i + 2].split(':').map(Number);
      range = { s: { h: +fr[1], m: +(fr[2] || 0) }, e: { h: eh, m: em || 0 } }; i += 2;
      const open = [];
      for (let k = slots.length - 1; k >= 0 && !slots[k].time && !slots[k].range; k--) open.push(slots[k]);
      open.forEach(x => { x.range = range; });
      continue;
    }
    const tm = /^(?:ו?ב-?|ו?ב־)\d|^\d{1,2}:\d{2}$/.test(w) ? timeTok(w) : null;
    if (tm) {
      // שעה אחרי רשימת ימים בלי שעה — לכולם ("בשלישי וחמישי ב-5")
      const open = [];
      for (let k = slots.length - 1; k >= 0 && !slots[k].time && !slots[k].part && !slots[k].range; k--) open.push(slots[k]);
      if (open.length) open.forEach(s => { s.time = tm; }); else pendingTime = tm;
      continue;
    }
    title.push(w);
  }
  if (pendingPart && slots.length) slots.filter(s => !s.part && !s.time).forEach(s => { s.part = pendingPart; });
  if (pendingTime && slots.length) slots.filter(s => !s.part && !s.time).forEach(s => { s.time = pendingTime; });
  // שם האירוע
  let name = title.join(' ').replace(/^(?:ב|ה)?(?:יום|ביום)\s*$/, '').replace(/\s+/g, ' ').trim();
  name = name.split(' ').map((w, i) => { if (i) return w; for (const [re, s] of SINGULAR) if (re.test(w)) return s; return w; }).join(' ');
  const isShift = /^משמרת|תורנות/.test(name);
  const isEvent = verb || isShift || slots.length >= 2;
  if (!isEvent) return null;
  if (!name) name = isShift ? 'משמרת' : 'אירוע';
  if (!slots.length) return { who, whoName, title: name, isShift, events: [], missing: 'when' };

  // תאריכים: ימים לפי הסדר, כל אחד אחרי הקודם
  const start = weekOffset ? addDays(sod(now), 7 - sod(now).getDay()) : sod(now);
  let cursor = start;
  const events = [];
  for (const s of slots) {
    let day;
    if (s.date) { day = new Date(s.date.y || now.getFullYear(), s.date.m, s.date.d); if (!s.date.y && day < sod(now)) day.setFullYear(day.getFullYear() + 1); }
    else if (s.rel != null) day = addDays(sod(now), s.rel);
    else {
      day = new Date(cursor);
      while (day.getDay() !== s.dow) day = addDays(day, 1);
      if (+day === +sod(now) && !weekOffset) { // היום — רק אם השעה עוד לא עברה
        const t0 = slotStart(s, isShift, ctx.shifts); if (t0 && toMin(t0) <= now.getHours() * 60 + now.getMinutes()) day = addDays(day, 7);
      }
    }
    cursor = day;
    const st = slotStart(s, isShift, ctx.shifts);
    let dur = null;
    if (s.range) dur = (toMin(hhmm(s.range.e.h, s.range.e.m)) - toMin(hhmm(s.range.s.h, s.range.s.m)) + 1440) % 1440 || null;
    else if (isShift && s.part && ctx.shifts?.[shiftKey(s.part)]) { const [a, b] = ctx.shifts[shiftKey(s.part)]; dur = (toMin(b) - toMin(a) + 1440) % 1440 || 480; }
    const due = new Date(day);
    if (st) { const [h, m] = st.split(':').map(Number); due.setHours(h, m, 0, 0); }
    const t1 = isShift && s.part ? `משמרת ${PART_LBL[shiftKey(s.part)] || PART_LBL[s.part]}` : name + (s.part && !st ? '' : '');
    events.push({ title: isShift ? t1 : name, due, hasTime: !!st, dur: dur ?? (st ? 60 : null), part: s.part,
      repeat: every && s.dow != null ? { type: 'weekly', dows: [s.dow] } : null });
  }
  // "כל ראשון וחמישי ב-5" עם אותה שעה → אירוע קבוע אחד
  if (every && events.length > 1 && events.every(e => e.repeat && e.title === events[0].title && e.due.getHours() === events[0].due.getHours() && e.due.getMinutes() === events[0].due.getMinutes())) {
    events[0].repeat = { type: 'weekly', dows: events.map(e => e.repeat.dows[0]) }; events.length = 1;
  }
  return { who, whoName, title: name, isShift, events, missing: null };
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
