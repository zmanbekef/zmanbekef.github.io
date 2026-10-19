// הבנת משפטים בעברית: מה כתבת (משימה / פגישה / מחשבה / "סיימתי"), מתי, וכל כמה זמן.
// הכל רץ בתוך המכשיר, בלי בינה מלאכותית ובלי אינטרנט.

export const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const NUMW = { 'אחת עשרה': 11, 'אחת-עשרה': 11, 'שתים עשרה': 12, 'שתיים עשרה': 12, 'שתים-עשרה': 12, 'אחת': 1, 'שתיים': 2, 'שתים': 2, 'שלוש': 3, 'ארבע': 4, 'חמש': 5, 'שש': 6, 'שבע': 7, 'שמונה': 8, 'תשע': 9, 'עשר': 10 };
const NUMW_RE = Object.keys(NUMW).sort((a, b) => b.length - a.length).join('|');
const DAY_RE = DAYS.join('|');
const E = '(?=\\s|$)'; // סוף מילה (‎\b לא עובד בעברית)
const S = '(?:^|\\s)'; // תחילת מילה

const DONE_VERBS = ['סיימתי', 'גמרתי', 'עשיתי', 'בוצע', 'ביצעתי', 'השלמתי', 'הספקתי', 'כבר עשיתי', 'כבר'];
const NOT_VERBS = new Set(['אחותי', 'אשתי', 'בתי', 'סבתי', 'דודתי', 'חברתי', 'מורתי', 'שותפתי', 'אמי', 'אבי', 'עבודתי', 'דירתי', 'משפחתי', 'כנראה']);
const MEETING_RE = new RegExp(`${S}(פגישה|פגישת|ישיבה|ישיבת|תור|אסיפה|אסיפת|ראיון|נפגש|נפגשים|להיפגש|להפגש|זום|שיחת זום|כנס)${E}`);
const THOUGHT_RE = /^(רעיון|מחשבה|פתק|לזכור|אולי)\s*[:\-–]?\s*/; // "הערה" = משוב לאפליקציה
const TASK_RE = /^(משימה|צריך|אני צריך|אני צריכה|חייב|אני חייב|לא לשכוח|אל תשכח|אל תשכחי)\s*[:\-–]?\s*/;
const REMIND_RE = /^(תזכיר לי|תזכירי לי|תזכיר|תזכירי|להזכיר לי|תזכורת|הזכר לי)\s*[:\-–]?\s*/;

const pad = n => String(n).padStart(2, '0');
export const sod = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function normalize(t) {
  return t.replace(/[\u05BE–—]/g, '-').replace(/[״"“”]/g, '"').replace(/[׳'`]/g, "'")
    .replace(/[!?,;]+/g, ' ')
    .replace(/(^|\s)ב-\s*/g, '$1ב').replace(/(^|\s)ל-\s*/g, '$1ל').replace(/(^|\s)מ-\s*/g, '$1מ').replace(/(^|\s)עד-\s*/g, '$1עד ')
    .replace(/בשעה\s+/g, 'ב').replace(/\s+/g, ' ').trim();
}

// ---------- זמן ותאריך ----------
function nextDow(now, dow, allowToday = true) {
  let diff = (dow - now.getDay() + 7) % 7;
  if (diff === 0 && !allowToday) diff = 7;
  return addDays(sod(now), diff);
}

// מוציא מהמשפט את כל מה שקשור לזמן. מחזיר {date, hour, min, part, repeat, rest}
function extractWhen(s, now) {
  let date = null, hour = null, min = 0, part = null, repeat = null, rel = null, dow = false, endH = null, endM = 0, dur = null;
  const cut = re => { const m = s.match(re); if (m) s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim(); return m; };
  let m;

  // --- חזרתיות לפי הלוח העברי: ערב שבת, ערב חג, ראש חודש, "כל ט"ו בחודש" ---
  if ((m = cut(new RegExp(`${S}(?:ב?כל|לפני\\s+כל)\\s+ערב\\s+שבת${E}|${S}ב?כל\\s+(?:יום\\s+)?שישי\\s+לפני\\s+שבת${E}`)))) {
    repeat = { type: 'weekly', dows: [5], erev: true };
  } else if ((m = cut(new RegExp(`${S}(?:ב?כל|לפני\\s+כל)\\s+ערב\\s+(?:חג|יום\\s+טוב)${E}`)))) {
    repeat = { type: 'erevChag' };
  } else if ((m = cut(new RegExp(`${S}(?:ב?כל|ב)\\s*ראש\\s+חודש${E}`)))) {
    repeat = { type: 'roshChodesh' };
  } else if ((m = cut(new RegExp(`${S}ב?כל\\s+([א-ל]"?[א-ט]?'?)\\s+(?:ב|ל)חודש(?:\\s+העברי)?${E}`))) && hebNum(m[1])) {
    repeat = { type: 'hebDay', hday: hebNum(m[1]) };
  } else if ((m = cut(new RegExp(`${S}(?:ב?כל|פעם ב)\\s*(?:יום\\s+)?(${DAY_RE})(?:\\s+ו(?:ב)?(${DAY_RE}))?${E}`)))) {
    repeat = { type: 'weekly', dows: [DAYS.indexOf(m[1]), ...(m[2] ? [DAYS.indexOf(m[2])] : [])] };
  } else if ((m = cut(new RegExp(`${S}ב?כל\\s+(?:יום|בוקר|ערב|לילה)${E}|${S}(?:פעם ביום|יומי|יום יום)${E}`)))) {
    repeat = { type: 'daily' };
    if (/בוקר/.test(m[0])) part = 'morning'; else if (/ערב/.test(m[0])) part = 'evening'; else if (/לילה/.test(m[0])) part = 'night';
  } else if ((m = cut(new RegExp(`${S}(?:ב?כל|פעם ב)\\s*שבוע${E}`)))) {
    repeat = { type: 'weekly', dows: null };
  } else if ((m = cut(new RegExp(`${S}ב?(\\d{1,2})\\s+(?:ל|ב)כל\\s+חודש${E}|${S}ב?כל\\s+(\\d{1,2})\\s+לחודש${E}`)))) {
    repeat = { type: 'monthly', dom: +(m[1] || m[2]) };
  } else if ((m = cut(new RegExp(`${S}(?:ב?כל|פעם ב)\\s*חודש${E}`)))) {
    repeat = { type: 'monthly', dom: null };
    if ((m = cut(new RegExp(`${S}ב(\\d{1,2})\\s+(?:ל|ב)חודש${E}`)))) repeat.dom = +m[1];
    // "כל חודש ב-10" — מספר בלי שעה מפורשת זה יום בחודש
    else if ((m = cut(new RegExp(`${S}ב(\\d{1,2})${E}(?!\\s*(?:בבוקר|בערב|בצהריים|בלילה|אחרי|וחצי|ורבע))`)))) repeat.dom = +m[1];
  }

  // --- זמן יחסי: בעוד ---
  if ((m = cut(new RegExp(`${S}(?:עוד|בעוד)\\s+(חצי שעה|רבע שעה|שעה|שעתיים|דקה|יום|יומיים|שבוע|שבועיים|חודש|(\\d+)\\s*(דקות|דק'|שעות|ימים|שבועות))${E}`)))) {
    const w = m[1], n = +m[2] || 0, u = m[3];
    const mins = { 'חצי שעה': 30, 'רבע שעה': 15, 'שעה': 60, 'שעתיים': 120, 'דקה': 1 }[w]
      ?? (u && /דק/.test(u) ? n : u === 'שעות' ? n * 60 : null);
    if (mins != null) rel = new Date(now.getTime() + mins * 60000);
    else {
      const days = { 'יום': 1, 'יומיים': 2, 'שבוע': 7, 'שבועיים': 14, 'חודש': 30 }[w] ?? (u === 'ימים' ? n : n * 7);
      date = addDays(sod(now), days);
    }
  }

  // --- תאריך ---
  if (!date && (m = cut(new RegExp(`${S}(?:ב)?(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?${E}`)))) {
    let y = m[3] ? +m[3] : now.getFullYear(); if (y < 100) y += 2000;
    date = new Date(y, +m[2] - 1, +m[1]);
    if (!m[3] && date < sod(now)) date.setFullYear(y + 1);
  }
  if (!date && (m = cut(new RegExp(`${S}(?:ב)?(\\d{1,2})\\s+(?:ב|ל)?(${MONTHS.join('|')})${E}`)))) {
    date = new Date(now.getFullYear(), MONTHS.indexOf(m[2]), +m[1]);
    if (date < sod(now)) date.setFullYear(now.getFullYear() + 1);
  }
  if (!date && !repeat && (m = cut(new RegExp(`${S}ב(\\d{1,2})\\s+לחודש${E}`)))) {
    date = new Date(now.getFullYear(), now.getMonth(), +m[1]);
    if (date < sod(now)) date.setMonth(date.getMonth() + 1);
  }
  if (!date && (m = cut(new RegExp(`${S}(?:ב)?מוצאי שבת${E}|${S}(?:ב)?מוצ"ש${E}|${S}(?:ב)?מוצש${E}`)))) {
    date = nextDow(now, 6); if (hour == null) { hour = 20; min = 0; }
  }
  if (!date && (m = cut(new RegExp(`${S}(?:ב)?(?:ערב שבת|שישי בבוקר)${E}`)))) {
    date = nextDow(now, 5);
  }
  if (!date && (m = cut(new RegExp(`${S}מחרתיים${E}`)))) date = addDays(sod(now), 2);
  if (!date && (m = cut(new RegExp(`${S}מחר${E}`)))) date = addDays(sod(now), 1);
  if (!date && (m = cut(new RegExp(`${S}(היום|הערב|הלילה|הבוקר|בצהריים היום)${E}`)))) {
    date = sod(now);
    if (m[1] === 'הערב') part = part || 'evening'; else if (m[1] === 'הלילה') part = part || 'night'; else if (m[1] === 'הבוקר') part = part || 'morning';
  }
  // "בשבוע הבא ביום שני" / "ביום שני בשבוע הבא" → יום שני של השבוע הבא
  if (!date && !repeat && ((m = cut(new RegExp(`${S}(?:ב)?שבוע\\s+הבא\\s+(?:ב?יום\\s+|ב)(${DAY_RE})${E}`))) || (m = cut(new RegExp(`${S}(?:ב?יום\\s+|ב)(${DAY_RE})\\s+(?:ב|של\\s+)?(?:ה)?שבוע\\s+הבא${E}`))))) {
    date = addDays(addDays(sod(now), 7 - now.getDay()), DAYS.indexOf(m[1])); dow = true;
  }
  if (!date && !repeat && (m = cut(new RegExp(`${S}(?:ב?יום\\s+(${DAY_RE})(?:\\s+הבא)?|ב(${DAY_RE})(?:\\s+הבא)?)${E}`)))) {
    date = nextDow(now, DAYS.indexOf(m[1] || m[2]), !/הבא/.test(m[0]));
    dow = true;
  }
  if (!date && (m = cut(new RegExp(`${S}(?:ב)?שבוע הבא${E}`)))) date = addDays(sod(now), 7);
  if (!date && (m = cut(new RegExp(`${S}(?:ב)?חודש הבא${E}`)))) { date = sod(now); date.setMonth(date.getMonth() + 1); }

  // --- חלק ביום ---
  if ((m = cut(new RegExp(`${S}(בבוקר|בצהריים|בצהרים|אחרי הצהריים|אחרי הצהרים|אחה"צ|בערב|בלילה|לפנות ערב)${E}`)))) {
    part = { 'בבוקר': 'morning', 'בצהריים': 'noon', 'בצהרים': 'noon', 'בערב': 'evening', 'בלילה': 'night', 'לפנות ערב': 'afternoon' }[m[1]] || 'afternoon';
  }

  // --- טווח: "מ-4 עד 6", "בין 4 ל-6", "10:00-11:30" ---
  const HALF = '(?:\\s+(וחצי|ורבע))?';
  const RANGE = new RegExp(`${S}(מ|מה|בין\\s+|ב)?(\\d{1,2})(?::(\\d{2}))?${HALF}\\s*(?:עד|ל|-|–)\\s*(?:ה|ל)?(\\d{1,2})(?::(\\d{2}))?${HALF}${E}(?!\\s*(?:לחודש|ב?(?:${MONTHS.join('|')})))`);
  const rng = s.match(RANGE);
  const frac = (mm, h) => mm ? +mm : h === 'וחצי' ? 30 : h === 'ורבע' ? 15 : 0;
  // --- שעה ---
  if (rng && (rng[1] || rng[3] || rng[6])) {
    cut(RANGE);
    hour = +rng[2]; min = frac(rng[3], rng[4]); endH = +rng[5]; endM = frac(rng[6], rng[7]);
  } else if ((m = cut(new RegExp(`${S}(?:ב|לקראת |ב-)?(\\d{1,2}):(\\d{2})${E}`)))) { hour = +m[1]; min = +m[2]; }
  else if ((m = cut(new RegExp(`${S}ב(\\d{1,2})(?:\\s+(וחצי|ורבע|פחות רבע))?${E}(?!\\s*(?:דקות|שעות|ימים|לחודש|ש"ח|שקל|₪|אנשים|משימות))`)))) {
    hour = +m[1]; min = m[2] === 'וחצי' ? 30 : m[2] === 'ורבע' ? 15 : 0;
    if (m[2] === 'פחות רבע') { hour -= 1; min = 45; }
  } else if ((m = cut(new RegExp(`${S}ב(${NUMW_RE})(?:\\s+(וחצי|ורבע|פחות רבע))?${E}`)))) {
    hour = NUMW[m[1]]; min = m[2] === 'וחצי' ? 30 : m[2] === 'ורבע' ? 15 : 0;
    if (m[2] === 'פחות רבע') { hour -= 1; min = 45; }
  }
  if (hour != null && hour > 23) { hour = null; min = 0; }

  // --- משך: "עד 6", "חצי שעה", "שעתיים", "45 דקות" ---
  if (hour != null && endH == null && (m = cut(new RegExp(`${S}עד\\s*(?:ה|ל|ה-|ל-)?(\\d{1,2})(?::(\\d{2}))?(?:\\s+(וחצי|ורבע))?${E}`)))) {
    endH = +m[1]; endM = m[2] ? +m[2] : m[3] === 'וחצי' ? 30 : m[3] === 'ורבע' ? 15 : 0;
  }
  if ((m = cut(new RegExp(`${S}(?:למשך\\s+|במשך\\s+)?(חצי שעה|רבע שעה|שעה וחצי|שעה ורבע|שעתיים וחצי|שעתיים|שלוש שעות|ארבע שעות|(\\d+)\\s*(דקות|דק'|שעות))${E}`)))) {
    dur = { 'חצי שעה': 30, 'רבע שעה': 15, 'שעה וחצי': 90, 'שעה ורבע': 75, 'שעתיים וחצי': 150, 'שעתיים': 120, 'שלוש שעות': 180, 'ארבע שעות': 240 }[m[1]]
      ?? (/דק/.test(m[3]) ? +m[2] : +m[2] * 60);
  }

  // שעה בלי "בבוקר/בערב": 1–6 זה אחרי הצהריים, 7–11 בבוקר
  if (hour != null && hour <= 12) {
    if (part === 'evening' || part === 'afternoon') { if (hour < 12) hour += 12; }
    else if (part === 'noon') { if (hour < 6) hour += 12; }
    else if (part === 'night') { if (hour >= 6 && hour < 12) hour += 12; }
    else if (part !== 'morning' && hour >= 1 && hour <= 6) hour += 12;
  }
  if (hour == null && part) { hour = { morning: 9, noon: 13, afternoon: 16, evening: 20, night: 22 }[part]; min = 0; }
  if (hour != null && endH != null && endH <= 24) {
    if (endH * 60 + endM <= hour * 60 + min && endH < 12) endH += 12;
    const d = endH * 60 + endM - (hour * 60 + min);
    if (d > 0) dur = d;
  }

  return { date, hour, min, repeat, rel, dow, dur, rest: s };
}

// ---------- הלוח העברי (בלי אינטרנט, מהדפדפן) ----------
const HEB_FMT = (() => { try { return new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long' }); } catch { return null; } })();
function hebOf(d) {
  if (!HEB_FMT) return null;
  const p = HEB_FMT.formatToParts(d);
  return { day: +p.find(x => x.type === 'day').value, month: p.find(x => x.type === 'month').value };
}
const HL = { 'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6, 'ז': 7, 'ח': 8, 'ט': 9, 'י': 10, 'כ': 20, 'ל': 30 };
export function hebNum(t) { const n = [...t.replace(/["']/g, '')].reduce((a, c) => a + (HL[c] || 0), 0); return n >= 1 && n <= 30 ? n : 0; }
// ראש חודש (היום הראשון): ל' בחודש, או א' כשהחודש הקודם היה 29 יום (לא ראש השנה)
export function isRoshChodesh(d) {
  const h = hebOf(d); if (!h) return false;
  if (h.day === 30) return true;
  return h.day === 1 && h.month !== 'Tishri' && hebOf(addDays(d, -1))?.day === 29;
}
// ערב חג (בארץ): ערב ראש השנה, יום כיפור, סוכות, שמיני עצרת, פסח, שביעי של פסח, שבועות
const CHAG = { Tishri: [1, 10, 15, 22], Nisan: [15, 21], Sivan: [6] };
export function isErevChag(d) { const h = hebOf(addDays(d, 1)); return !!h && (CHAG[h.month] || []).includes(h.day); }

// מחשב את המועד הבא של משימה קבועה (אחרי from)
export function nextOccurrence(rep, hour, min, from) {
  const at = d => { const x = new Date(d); x.setHours(hour ?? 9, min ?? 0, 0, 0); return x; };
  for (let i = 0; i < 400; i++) {
    const d = addDays(sod(from), i), c = at(d);
    if (c <= from) continue;
    if (rep.type === 'daily') return c;
    if (rep.type === 'roshChodesh') { if (isRoshChodesh(d)) return c; continue; }
    if (rep.type === 'erevChag') { if (isErevChag(d)) return c; continue; }
    if (rep.type === 'hebDay') { if (hebOf(d)?.day === rep.hday) return c; continue; }
    if (rep.type === 'weekly' && rep.dows.includes(d.getDay())) return c;
    if (rep.type === 'monthly') {
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (d.getDate() === Math.min(rep.dom, last)) return c;
    }
  }
  return null;
}

// ---------- ניקוי הטקסט ----------
function tidy(s) {
  return s.replace(/^[\s:\-–,.]+|[\s:\-–,.]+$/g, '')
    .replace(/(^|\s)(ב|ל|ש|ו|את|על)$/, '')
    .replace(/^ש(?=\S{3,})/, '').replace(/\s+/g, ' ').trim();
}

// ---------- הפענוח הראשי ----------
export function parse(raw, now = new Date()) {
  const s0 = normalize(raw);
  const low = s0.replace(/[."':]/g, '').trim();

  if (/^(עזרה|מה אפשר לעשות|איך משתמשים|מה אתה יודע לעשות|מה את יודעת לעשות)$/.test(low)) return { intent: 'help' };
  if (/^(סיכום|סיכום יום|סיכום היום|סכם|סכם לי)$/.test(low)) return { intent: 'summary' };
  if (/^(בוקר טוב|תכנון|תכנון יום|מה התכנית|מה התוכנית)$/.test(low)) return { intent: 'morning' };
  let q = low.match(/^(?:מה|מה יש|מה יש לי|מה נשאר|מה נשאר לי|מה מתוכנן|מה על הפרק|מה התוכנית)(?:\s+לי)?(?:\s+(?:ל|ב)?(היום|מחר|השבוע))?$/);
  if (q && low !== 'מה') return { intent: 'query', day: q[1] === 'מחר' ? 'tomorrow' : q[1] === 'השבוע' ? 'week' : 'today' };
  if (/^(כן|כן כן|כן עשיתי|עשיתי|עשיתי את זה|בוצע|סיימתי|גמרתי|ברור|נכון|יש|הספקתי|סגור|כן סיימתי)$/.test(low) || /^כן\s+\S+(\s+\S+)?$/.test(low)) return { intent: 'yes' };
  if (/^(לא|עוד לא|עדיין לא|לא עשיתי|לא הספקתי|לא עדיין|לא היום|עוד לא הספקתי)$/.test(low)) return { intent: 'no' };

  // "סיימתי לשלוח הצעת מחיר", "התקשרתי לבנק"
  const words = s0.split(' ');
  const first = words[0], firstTwo = words.slice(0, 2).join(' ');
  if (DONE_VERBS.includes(firstTwo) || DONE_VERBS.includes(first)) {
    const rest = s0.slice((DONE_VERBS.includes(firstTwo) ? firstTwo : first).length).trim();
    return { intent: 'done', text: rest, verb: false };
  }

  // תזכורת / משימה / מחשבה / פגישה
  let s = s0, forced = null, remind = false;
  let m;
  if ((m = s.match(REMIND_RE))) { s = s.slice(m[0].length); remind = true; }
  if ((m = s.match(THOUGHT_RE))) { s = s.slice(m[0].length); forced = 'thought'; }
  else if ((m = s.match(TASK_RE))) { s = s.slice(m[0].length); forced = 'task'; }
  s = s.replace(/^לי\s+/, '');

  const w = extractWhen(s, now);
  // "לקבוע תור" / "לבטל פגישה" — זו משימה, לא הפגישה עצמה
  const meeting = MEETING_RE.test(w.rest) && !/(^|\s)(?:לקבוע|לבטל|להזיז|לתאם|להזמין|לאשר)\s+(?:את\s+ה?)?(?:תור|פגישה|ישיבה)/.test(w.rest);
  let text = tidy(w.rest);
  const bare = !text; // נשאר רק זמן, בלי תוכן ("תזכיר אחרי הצהריים")

  // פועל בעבר בתחילת המשפט ("שילמתי חשמל") — כנראה דיווח על ביצוע
  if (!remind && !forced && !w.date && w.hour == null && !w.repeat && !w.rel && words.length >= 2 && /תי$/.test(first) && first.length >= 4 && !NOT_VERBS.has(first)) {
    return { intent: 'done', text: s0, verb: true };
  }

  let due = null, hasTime = false;
  if (w.rel) { due = w.rel; hasTime = true; }
  else if (w.repeat) {
    if (w.repeat.type === 'weekly' && !w.repeat.dows) w.repeat.dows = [(w.date || now).getDay()];
    if (w.repeat.type === 'monthly' && !w.repeat.dom) w.repeat.dom = (w.date || now).getDate();
    hasTime = w.hour != null;
    due = nextOccurrence(w.repeat, w.hour ?? 9, w.min, new Date(now.getTime() - 60000));
  } else if (w.date) {
    due = new Date(w.date);
    if (w.hour != null) { due.setHours(w.hour, w.min, 0, 0); hasTime = true; }
    if (w.dow && hasTime && due <= now) due = addDays(due, 7); // "ביום ראשון ב-8" כשכבר עבר — בשבוע הבא
  } else if (w.hour != null) {
    due = sod(now); due.setHours(w.hour, w.min, 0, 0); hasTime = true;
    if (due <= now) due = addDays(due, 1);
  }

  let kind = forced || (meeting ? 'meeting' : null);
  if (!kind) kind = (due || remind) ? 'task' : 'thought';
  if (kind === 'thought' && (due || w.repeat)) kind = 'task';
  if (!text) text = tidy(s0.replace(REMIND_RE, ''));

  return { intent: 'item', kind, text, due, hasTime, repeat: w.repeat || null, dur: w.dur ?? null, remind, bare, needsWhen: (remind || kind === 'meeting') && !due };
}

// ---------- התאמה בין "סיימתי X" לבין משימה פתוחה ----------
const STOP = new Set(['את', 'עם', 'של', 'על', 'גם', 'כבר', 'זה', 'הזה', 'לי', 'לו', 'לה', 'אני', 'היום', 'אתמול', 'עכשיו', 'סוף', 'סוף-סוף']);
const FINALS = { 'ם': 'מ', 'ן': 'נ', 'ץ': 'צ', 'ף': 'פ', 'ך': 'כ' };
function stem(w) {
  w = w.replace(/[םןץףך]/g, c => FINALS[c]).replace(/[^א-ת0-9a-z]/gi, '');
  for (let i = 0; i < 2 && w.length > 3 && /^[והלבשמכ]/.test(w); i++) w = w.slice(1);
  w = w.replace(/(תי|נו|ים|ות|תמ)$/, m => (w.length - m.length >= 2 ? '' : m));
  const core = w.length > 2 ? w[0] + w.slice(1).replace(/[וי]/g, '') : w;
  return core.length >= 2 ? core : w;
}
function bigrams(w) { const b = []; for (let i = 0; i < w.length - 1; i++) b.push(w.slice(i, i + 2)); return b.length ? b : [w]; }
function dice(a, b) {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b); let hit = 0; const used = new Array(B.length).fill(false);
  for (const x of A) { const j = B.findIndex((y, k) => !used[k] && y === x); if (j >= 0) { used[j] = true; hit++; } }
  return 2 * hit / (A.length + B.length);
}
const contentWords = t => normalize(t).split(' ').filter(w => w && !STOP.has(w) && w.length > 1).map(stem);

export function matchScore(query, text) {
  const qa = contentWords(query), ta = contentWords(text);
  if (!qa.length || !ta.length) return 0;
  const sum = qa.reduce((s, q) => s + Math.max(...ta.map(t => dice(q, t))), 0);
  return sum / qa.length;
}

// ---------- תצוגת מועד בעברית ----------
const gem = n => { const o = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'], t = ['', 'י', 'כ', 'ל']; let s = t[Math.floor(n / 10)] + o[n % 10]; s = s.replace('יה', 'טו').replace('יו', 'טז'); return s.length > 1 ? s.slice(0, -1) + '"' + s.slice(-1) : s + "'"; };
export function whenLabel(item, now = new Date()) {
  if (item.repeat) {
    const r = item.repeat, t = item.hasTime ? ' ב-' + hm(new Date(item.due)) : '';
    if (r.type === 'daily') return 'כל יום' + t;
    if (r.erev) return 'כל ערב שבת' + t;
    if (r.type === 'roshChodesh') return 'כל ראש חודש' + t;
    if (r.type === 'erevChag') return 'כל ערב חג' + t;
    if (r.type === 'hebDay') return `כל ${gem(r.hday)} בחודש העברי` + t;
    if (r.type === 'weekly') return 'כל יום ' + r.dows.map(d => DAYS[d]).join(' ו') + t;
    return `כל חודש ב-${r.dom}` + t;
  }
  if (!item.due) return '';
  const d = new Date(item.due), diff = Math.round((sod(d) - sod(now)) / 864e5);
  const day = diff === 0 ? 'היום' : diff === 1 ? 'מחר' : diff === 2 ? 'מחרתיים' : diff === -1 ? 'אתמול'
    : diff > 0 && diff < 7 ? 'ביום ' + DAYS[d.getDay()] : `${d.getDate()}.${d.getMonth() + 1}`;
  return item.hasTime ? `${day} ב-${hm(d)}` : day;
}
