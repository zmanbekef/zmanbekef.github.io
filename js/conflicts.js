// זיהוי התנגשויות בזמנים והצעות לפתרון. פונקציות טהורות — מקבלות את המשימות ומחזירות תוצאות.
import { sod, addDays, hm } from './parse.js';

// ---------- מקומות ודברים משותפים ----------
export const CITIES = ['תל אביב', 'ירושלים', 'חיפה', 'בני ברק', 'פתח תקווה', 'פתח תקוה', 'ראשון לציון', 'חולון', 'בת ים', 'רמת גן', 'גבעתיים',
  'הרצליה', 'רעננה', 'כפר סבא', 'נתניה', 'אשדוד', 'אשקלון', 'באר שבע', 'מודיעין עילית', 'מודיעין', 'ביתר עילית', 'בית שמש', 'אלעד',
  'ראש העין', 'רחובות', 'נס ציונה', 'הוד השרון', 'חדרה', 'טבריה', 'צפת', 'עפולה', 'קריית גת', 'קריית ספר', 'קריית מלאכי', 'לוד', 'רמלה',
  'יבנה', 'אור יהודה', 'גבעת שמואל', 'בית שאן', 'אילת', 'נתיבות', 'אופקים', 'שדרות', 'עכו', 'נהריה', 'כרמיאל', 'רכסים', 'עמנואל', 'אריאל',
  'מעלה אדומים', 'גבעת זאב', 'כוכב יעקב', 'קרית יערים', 'טלז סטון', 'חריש', 'יקנעם', 'קריית אתא', 'קריית ביאליק', 'קריית מוצקין', 'נוף הגליל'];
export const DEFAULT_RES = [{ id: 'car', e: '🚗', n: 'הרכב', words: ['רכב', 'הרכב', 'האוטו', 'אוטו', 'המכונית', 'מכונית', 'ברכב', 'באוטו'] }];

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// מוצא מקום במשפט: "פגישה עם יוסי בתל אביב" → { place: 'תל אביב', text: 'פגישה עם יוסי' }
export function findPlace(text, known = []) {
  const list = [...new Set([...known, ...CITIES])].sort((a, b) => b.length - a.length);
  for (const p of list) {
    const m = text.match(new RegExp(`(^|\\s)(?:ב|ל|מ|באזור |ליד )${reEsc(p)}(?=\\s|$|[,.])`));
    if (m) return { place: p, text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
  }
  return { place: null, text };
}
export function findRes(text, resources) {
  return resources.filter(r => r.words.some(w => new RegExp(`(^|\\s|[לבה])${reEsc(w)}(?=\\s|$|[,.])`).test(text))).map(r => r.id);
}

// ---------- זמנים ----------
export const startOf = it => it.due ? new Date(it.due).getTime() : null;
export const endOf = it => startOf(it) + (it.dur || 0) * 60e3;
const timed = it => it.due && it.hasTime && it.dur > 0;
const overlap = (a, b) => startOf(a) < endOf(b) && startOf(b) < endOf(a);
export const span = it => `\u2066${hm(new Date(startOf(it)))}–${hm(new Date(endOf(it)))}\u2069`; // תמיד משמאל לימין, גם בתוך עברית
const travelKey = (a, b) => [a, b].sort().join('|');

/**
 * מוצא את כל ההתנגשויות בטווח הקרוב.
 * ctx: { items, busy, owner(it)→personId|'any', adults: [personId], resources, travel: {key: minutes}, from, to }
 * מחזיר: [{ key, type, a, b, ... }]
 */
export function detect(ctx) {
  const { items, busy = [], owner, adults, resources, travel = {} } = ctx;
  const from = ctx.from ?? Date.now(), to = ctx.to ?? from + 14 * 864e5;
  const live = items.filter(it => it.status === 'open' && (it.kind === 'task' || it.kind === 'meeting') && it.due && it.hasTime && endOf(it) > from && startOf(it) < to);
  const T = live.filter(timed).concat(busy.filter(b => endOf(b) > from && startOf(b) < to));
  const ok = (a, b) => (a.ok || []).includes(b.id) || (b.ok || []).includes(a.id);
  const out = [];
  const add = (type, a, b, extra = {}) => out.push({ key: `${type}:${[a.id, b?.id].sort().join('+')}:${a.due}:${b?.due || ''}:${a.dur}:${b?.dur || ''}`, type, a, b, ...extra });

  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
    const a = T[i], b = T[j];
    if (!overlap(a, b) || ok(a, b) || (a.busy && b.busy)) continue;
    const oa = owner(a), ob = owner(b);
    const ra = a.res || [], rb = b.res || [], shared = ra.filter(r => rb.includes(r));
    if (shared.length) add('res', a, b, { res: resources.find(r => r.id === shared[0]) });
    else if (oa === 'any' || ob === 'any') continue; // נבדק למטה ("אף אחד לא פנוי")
    else if (oa && oa === ob) add('self', a, b, { who: oa });
    else if (oa && ob) add('both', a, b, { who: [oa, ob] });
  }

  // "מישהו מאיתנו צריך…" — האם יש לפחות מבוגר אחד פנוי?
  for (const it of live.filter(x => owner(x) === 'any')) {
    const probe = { ...it, dur: it.dur || 15 };
    const ad = typeof adults === 'function' ? adults(it) : adults;
    const blockers = ad.map(p => T.find(x => x.id !== it.id && owner(x) === p && overlap(probe, x)));
    if (ad.length && blockers.every(Boolean) && !blockers.every(x => ok(it, x))) add('nobody', it, blockers[0], { blockers });
  }

  // זמן נסיעה בין שני מקומות שונים של אותו אדם
  const byOwner = {};
  for (const it of live.filter(x => x.place && x.dur > 0)) (byOwner[owner(it)] ||= []).push(it);
  for (const list of Object.values(byOwner)) {
    list.sort((x, y) => startOf(x) - startOf(y));
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      if (a.place === b.place || ok(a, b) || overlap(a, b)) continue;
      const gap = (startOf(b) - endOf(a)) / 60e3;
      if (gap > 180 || sod(new Date(startOf(a))).getTime() !== sod(new Date(startOf(b))).getTime()) continue;
      const need = travel[travelKey(a.place, b.place)];
      if (need == null) out.push({ key: `ask:${travelKey(a.place, b.place)}`, type: 'travelAsk', a, b });
      else if (gap < need) add('travel', a, b, { need, gap });
    }
  }
  return out;
}

// ---------- הצעות ----------
const ROUND = 15 * 60e3;
// שעה פנויה קרובה לאותו אדם (ובלי להתנגש בדבר משותף), באותו יום ואז בימים הבאים
export function freeSlot(it, ctx, blockersOf) {
  const dur = (it.dur || 30) * 60e3, orig = startOf(it), now = Date.now();
  const blockers = blockersOf(it);
  const isFree = t => t > now && blockers.every(b => !(t < endOf(b) && startOf(b) < t + dur));
  for (let day = 0; day < 7; day++) {
    const base = sod(addDays(new Date(orig), day)).getTime();
    const cands = [];
    for (let t = base + 7 * 3600e3; t + dur <= base + 22 * 3600e3; t += ROUND) cands.push(t);
    cands.sort((x, y) => Math.abs(x - orig) - Math.abs(y - orig));
    const t = cands.find(x => x !== orig && isFree(x));
    if (t) return new Date(t);
  }
  return null;
}

export function travelFix(c) {
  const leave = new Date(startOf(c.b) - c.need * 60e3);
  const moveTo = new Date(Math.ceil((endOf(c.a) + c.need * 60e3) / ROUND) * ROUND);
  return { leave, moveTo, shortenTo: leave };
}
