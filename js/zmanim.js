// זמני שבת, חגים וזמני היום — מהשירות החינמי Hebcal, לפי העיר שנבחרה. נשמר בטלפון לשימוש בלי אינטרנט.
import * as db from './db.js';

export const CITIES = [
  ['ירושלים', 31.778, 35.235, 40], ['בני ברק', 32.0807, 34.8338, 20], ['תל אביב', 32.0853, 34.7818, 20], ['חיפה', 32.794, 34.9896, 30],
  ['פתח תקווה', 32.0871, 34.8875, 20], ['בית שמש', 31.747, 34.9881, 20], ['מודיעין עילית', 31.933, 35.0418, 20], ['ביתר עילית', 31.6969, 35.1153, 40],
  ['אלעד', 32.0523, 34.9512, 20], ['אשדוד', 31.8014, 34.6435, 20], ['נתניה', 32.3215, 34.8532, 20], ['באר שבע', 31.2518, 34.7913, 20],
  ['רחובות', 31.8928, 34.8113, 20], ['רמת גן', 32.0684, 34.8248, 20], ['ראשון לציון', 31.973, 34.7925, 20], ['חולון', 32.0158, 34.7874, 20],
  ['בת ים', 32.0231, 34.7503, 20], ['הרצליה', 32.1624, 34.8447, 20], ['כפר סבא', 32.175, 34.907, 20], ['רעננה', 32.1848, 34.8713, 20],
  ['מודיעין', 31.898, 35.0104, 20], ['אשקלון', 31.6688, 34.5743, 20], ['צפת', 32.9646, 35.496, 20], ['טבריה', 32.7922, 35.5312, 20],
  ['עפולה', 32.6078, 35.2897, 20], ['רכסים', 32.7497, 35.0989, 30], ['עמנואל', 32.161, 35.144, 20], ['קריית גת', 31.61, 34.7642, 20],
  ['נתיבות', 31.4231, 34.5886, 20], ['אילת', 29.5577, 34.9519, 20],
];
export const cityOf = name => CITIES.find(c => c[0] === name) || CITIES[0];
const TZ = 'Asia/Jerusalem';
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const q = c => `latitude=${c[1]}&longitude=${c[2]}&tzid=${TZ}`;

let CAL = null; // { key, at, windows: [{start, end, name}] }
export const windows = () => CAL?.windows || [];

/** טוען (או מרענן פעם ביום) את זמני השבתות והחגים לחודשיים הקרובים */
export async function loadCalendar(city, minutes) {
  const c = cityOf(city), key = `${c[0]}|${minutes}`;
  CAL = await db.getKV('zcal', null);
  if (CAL?.key === key && Date.now() - CAL.at < 864e5) return CAL;
  if (!navigator.onLine) return CAL;
  try {
    const start = new Date(Date.now() - 2 * 864e5), end = new Date(Date.now() + 75 * 864e5);
    const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=off&mod=off&nx=off&mf=off&ss=off&s=off&c=on&M=on&i=on&lg=he&b=${minutes}&${q(c)}&start=${ymd(start)}&end=${ymd(end)}`;
    const data = await fetch(url).then(r => r.json());
    const ev = data.items.slice().sort((a, b) => a.date.localeCompare(b.date));
    const wins = [];
    for (let i = 0; i < ev.length; i++) {
      if (ev[i].category !== 'candles') continue;
      const h = ev.slice(i + 1).find(e => e.category === 'havdalah');
      if (!h) break;
      const s = new Date(ev[i].date), e = new Date(h.date);
      if (wins.some(w => w.end.getTime() === e.getTime())) continue; // שבת שאחרי חג — כבר בתוך החלון
      const hol = ev.filter(x => x.category === 'holiday' && x.yomtov && new Date(x.date) >= new Date(ymd(s)) && new Date(x.date) <= e).map(x => x.hebrew);
      wins.push({ start: s, end: e, name: hol.length ? hol[0] : 'שבת', shabbat: s.getDay() === 5 || e.getDay() === 6 });
    }
    CAL = { key, at: Date.now(), windows: wins.map(w => ({ ...w, start: w.start.toISOString(), end: w.end.toISOString() })) };
    await db.setKV('zcal', CAL);
  } catch (e) { console.warn('hebcal', e); }
  return CAL;
}

/** ליומן: חגים, הדלקת נרות והבדלה לחודש מסוים → { 'YYYY-MM-DD': { hol: [שמות], candles: Date, havdalah: Date } } */
export async function monthEvents(city, minutes, y, m) {
  const c = cityOf(city), key = `hol2:${c[0]}|${minutes}|${y}-${m}`; // hol2: בלי ימים מודרניים (יום הזיכרון וכו׳)
  const cached = await db.getKV(key, null);
  if (cached && (Date.now() - cached.at < 7 * 864e5 || !navigator.onLine)) return cached.days;
  if (!navigator.onLine) return {};
  try {
    const start = new Date(y, m, 1), end = new Date(y, m + 1, 0);
    const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=on&mod=off&nx=on&mf=off&ss=off&s=off&c=on&M=on&i=on&lg=he&b=${minutes}&${q(c)}&start=${ymd(start)}&end=${ymd(end)}`;
    const data = await fetch(url).then(r => r.json());
    const days = {};
    for (const e of data.items || []) {
      const d = e.date.slice(0, 10), x = days[d] ||= { hol: [] };
      if (e.category === 'candles') x.candles = e.date;
      else if (e.category === 'havdalah') x.havdalah = e.date;
      else if (['holiday', 'roshchodesh'].includes(e.category) && e.subcat !== 'modern' && !x.hol.includes(e.hebrew)) x.hol.push(e.hebrew);
    }
    await db.setKV(key, { at: Date.now(), days });
    return days;
  } catch (e) { console.warn('hebcal month', e); return cached?.days || {}; }
}

// החלון (שבת/חג) שהזמן הזה נופל בו, או null
export function quietAt(t) {
  const x = +t;
  return windows().find(w => x >= +new Date(w.start) && x < +new Date(w.end)) || null;
}
// השבת/החג הבא (או הנוכחי)
export function nextWindow(t = Date.now()) {
  return windows().find(w => +new Date(w.end) > +t) || null;
}

// זמני היום לתאריך מסוים
const ZNAMES = { sunrise: 'הנץ', sofZmanShma: 'סוף זמן ק"ש', sofZmanShmaMGA: 'סוף זמן ק"ש מג"א', sofZmanTfilla: 'סוף זמן תפילה', chatzot: 'חצות', minchaGedola: 'מנחה גדולה', plagHaMincha: 'פלג המנחה', sunset: 'שקיעה', tzeit85deg: 'צאת הכוכבים' };
export async function zmanim(city, date = new Date()) {
  const c = cityOf(city), d = ymd(date), key = `zday:${c[0]}:${d}`;
  const cached = await db.getKV(key, null);
  if (cached) return cached;
  if (!navigator.onLine) return null;
  try {
    const data = await fetch(`https://www.hebcal.com/zmanim?cfg=json&${q(c)}&date=${d}`).then(r => r.json());
    const out = {}; for (const k of Object.keys(ZNAMES)) if (data.times[k]) out[k] = data.times[k];
    await db.setKV(key, out);
    return out;
  } catch { return null; }
}

// "חצי שעה לפני סוף זמן קריאת שמע" → { key, offsetMin, rest }
const ZWORDS = [
  [/סוף\s+זמן\s+(?:קריאת\s+שמע|ק"ש|קש)/, 'sofZmanShma'], [/סוף\s+זמן\s+תפילה/, 'sofZmanTfilla'], [/(?:הנץ|הנץ החמה|זריחה)/, 'sunrise'],
  [/(?:השקיעה|שקיעה)/, 'sunset'], [/פלג\s+המנחה/, 'plagHaMincha'], [/מנחה\s+גדולה/, 'minchaGedola'], [/חצות(?:\s+היום)?/, 'chatzot'],
  [/(?:צאת\s+הכוכבים|צה"כ)/, 'tzeit85deg'], [/(?:כניסת\s+(?:ה)?שבת|הדלקת\s+נרות)/, 'candles'], [/(?:צאת\s+(?:ה)?שבת|יציאת\s+(?:ה)?שבת|הבדלה)/, 'havdalah'],
];
const OFF = { 'רבע שעה': 15, 'חצי שעה': 30, 'שעה': 60, 'שעתיים': 120, 'עשר דקות': 10, 'חמש דקות': 5 };
export function findZman(text) {
  for (const [re, key] of ZWORDS) {
    const m = text.match(new RegExp(`(?:(?:(\\d+)\\s*דקות|(רבע שעה|חצי שעה|שעתיים|שעה|עשר דקות|חמש דקות))\\s+(לפני|אחרי)\\s+)?(?:ב|עד |ל)?${re.source}`));
    if (!m) continue;
    const off = (m[1] ? +m[1] : m[2] ? OFF[m[2]] : 0) * (m[3] === 'אחרי' ? 1 : -1);
    return { key, offsetMin: off, rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
  }
  return null;
}
/** מחשב את הזמן: היום, ואם כבר עבר — מחר (או השבת הבאה לכניסה/יציאה) */
export async function zmanTime(city, z, day) {
  if (z.key === 'candles' || z.key === 'havdalah') {
    const w = nextWindow(day ? +new Date(day) : Date.now());
    if (!w) return null;
    return new Date(+new Date(z.key === 'candles' ? w.start : w.end) + z.offsetMin * 60e3);
  }
  for (let i = 0; i < 2; i++) {
    const d = day ? new Date(day) : new Date(Date.now() + i * 864e5);
    const t = await zmanim(city, d);
    if (!t?.[z.key]) return null;
    const at = new Date(+new Date(t[z.key]) + z.offsetMin * 60e3);
    if (day || at > new Date()) return at;
  }
  return null;
}
export const zLabel = (t, k) => `${ZNAMES[k] || k} ${new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: TZ })}`;

// ---------- מנגינות להתראה (כשהאפליקציה פתוחה) ----------
export const MELODIES = { none: 'בלי צליל', bells: '🔔 פעמונים', rise: '🎵 מנגינה עולה', shabbat: '🕯️ מנגינת שבת', short: '• צליל קצר' };
const NOTES = {
  bells: [[880, .18], [660, .18], [880, .18], [660, .3]],
  rise: [[523, .14], [659, .14], [784, .14], [1047, .3]],
  shabbat: [[392, .3], [523, .3], [523, .2], [587, .2], [659, .45], [587, .2], [523, .45]],
  short: [[988, .12]],
};
let ac = null;
export function play(name) {
  const seq = NOTES[name]; if (!seq) return;
  try {
    ac ||= new (window.AudioContext || window.webkitAudioContext)();
    let t = ac.currentTime + .02;
    for (const [f, d] of seq) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.25, t + .02); g.gain.exponentialRampToValueAtTime(.001, t + d);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + d + .02); t += d;
    }
  } catch { /* אין צליל */ }
}
