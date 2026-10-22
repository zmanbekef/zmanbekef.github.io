import * as db from './db.js';
import { parse, matchScore, whenLabel, nextOccurrence, doseStats, MED_RE, sod, addDays, ymd, hm, DAYS } from './parse.js';
import { hebDate, gematria } from './hebdate.js';
import * as sync from './sync.js';
import * as C from './conflicts.js';
import * as Z from './zmanim.js';
import * as help from './help.js';
import * as lock from './lock.js';
import { smartParse, iconFor } from './smart.js';
import { DEPTS, deptOf, guessDept, shopItems } from './shop.js';
import * as demo from './demo.js';
import { NEWS } from './whats-new.js';

const $ = s => document.querySelector(s);
// כפתורים שמחברים בטעינה: אם הדף עוד ישן ואין בו את הכפתור, ממשיכים בלי להיתקע
const $h = sel => document.querySelector(sel) || document.createElement('i');
let nxTimer = 0; // טיימר המעבר האוטומטי ב"✨ מה חדש"
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => ymd(new Date());
const isToday = iso => iso && ymd(new Date(iso)) === today();

const S = { items: [], msgs: [], log: [], top3: null, settings: { morning: '07:00', evening: '20:00', city: 'ירושלים', candleMin: 40, shabbatAlerts: [60], melody: 'bells' }, pending: null, day: today(),
  people: [], uid: null, myP: null, who: 'all', busy: [], ext: [], extHost: '', resources: C.DEFAULT_RES, travel: {}, alerted: [] };
const item = id => S.items.find(x => x.id === id && x.status !== 'deleted');
const openItems = () => S.items.filter(x => x.status === 'open');
const isTask = x => x.kind === 'task' || x.kind === 'meeting';
const allTasksOpen = () => openItems().filter(isTask);

// ---------- אנשים וקבוצות ----------
// כל אדם מזוהה לפי החשבון שלו ('u:'+uid) — אותו אדם בכל הקבוצות. "רק שם" (בלי טלפון) מזוהה לפי השורה בקבוצה ('m:'+id).
const FACES = ['🧔', '👩', '👦', '👧', '👴', '👵', '🧑', '👶', '🙂', '😎', '🦁', '🌟'];
const KINDS = { family: ['👨‍👩‍👧', 'משפחה'], partners: ['🤝', 'שותפים'], team: ['👥', 'צוות'], friends: ['🎉', 'חברים'], other: ['✨', 'קבוצה'], pair: ['👤', 'קשר ישיר'] };
const person = pid => S.people.find(p => p.id === pid);
const personOfUid = uid => uid && S.people.find(p => p.uid === uid);
const family = () => S.people.length > 1;
const groupOf = gid => sync.myGroups().find(g => g.id === gid);
const gLabel = g => g ? (g.kind === 'pair' ? `👤 ${pairOther(g)?.name || 'קשר ישיר'}` : `${KINDS[g.kind]?.[0] || '✨'} ${g.name}`) : '🔒 רק לי';
const pairOther = g => { const m = g.members.find(x => x.user_id !== S.uid); return m ? person(m.user_id ? 'u:' + m.user_id : 'm:' + m.id) : null; };
// הכינוי של אדם בקבוצה מסוימת (ואם אין — השם שלו)
const nameIn = (pid, gid) => { const p = person(pid); if (!p) return ''; return (gid && p.nicks.find(n => n.g === gid)?.nick) || p.name; };
const whoIn = (pid, gid) => { if (pid === 'any') return '👨‍👩‍👧 מישהו מאיתנו'; const p = person(pid); return p ? `${p.e} ${nameIn(pid, gid)}` : ''; };
function buildPeople() {
  const list = [];
  const pr = sync.myProfile();
  if (S.uid) list.push({ id: 'u:' + S.uid, uid: S.uid, name: pr?.full_name || 'אני', e: pr?.emoji || '🙂', photo: pr?.photo || null, nicks: [] });
  for (const g of sync.myGroups()) for (const m of g.members) {
    const id = m.user_id ? 'u:' + m.user_id : 'm:' + m.id;
    let p = list.find(x => x.id === id);
    if (!p) { p = { id, uid: m.user_id || null, name: m.user_id ? (m.profile?.full_name || m.nickname) : m.nickname, e: m.profile?.emoji || m.emoji || '🙂', photo: m.profile?.photo || null, nicks: [] }; list.push(p); }
    if (m.color && !p.color) p.color = m.color;
    p.nicks.push({ g: g.id, nick: m.nickname, role: m.role, mid: m.id, kind: g.kind });
  }
  S.people = list; S.myP = S.uid ? 'u:' + S.uid : null;
}
// אנשים שאני חולק איתם קבוצה (לא כולל אותי)
const others = () => S.people.filter(p => p.id !== S.myP);
// מי אחראי על המשימה: מי שהיא בשבילו, ואם אין — מי שרשם
const ownerP = it => it.forP || personOfUid(it.by)?.id || null;
const byMe = it => !it.by || it.by === S.uid;
// למי שאין חשבון (למשל ילד קטן) — השאלה "עשית?" חוזרת למי שרשם
const isMine = it => !S.uid || (it.forP === 'any' ? (!it.group_id || groupOf(it.group_id)?.myRole !== 'child') : it.forP ? it.forP === S.myP || (!person(it.forP)?.uid && byMe(it)) : byMe(it));
const tasksOpen = () => allTasksOpen().filter(isMine);
const who = pid => whoIn(pid, null);

// 🖼️ פרצוף: תמונה אם יש, אחרת האימוג'י. התמונה נטענת אחרי הציור (hydrateFaces)
const faceHtml = p => p?.photo && p.uid && !demo.DEMO ? `<i class="face-img" data-av="${esc(p.uid)}" data-v="${esc(p.photo)}">${esc(p.e || '🙂')}</i>` : esc(p?.e || '🙂');
async function hydrateFaces(root = document) {
  for (const el of root.querySelectorAll('[data-av]:not([data-done])')) {
    el.dataset.done = '1';
    const url = await sync.photoUrl(el.dataset.av, el.dataset.v);
    if (url) { const img = new Image(); img.alt = ''; img.onload = () => { el.textContent = ''; el.append(img); el.classList.add('has'); }; img.src = url; }
  }
}
// הקטנה לפני העלאה: ריבוע 320×320, JPEG — בערך 20–40KB
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  const src = bmp || await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const w = src.width, h = src.height, side = Math.min(w, h), N = 320;
  const cv = document.createElement('canvas'); cv.width = cv.height = N;
  cv.getContext('2d').drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, N, N);
  return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.82));
}

// ---------- 💬 "לא נקראו" כמו בוואטסאפ ----------
// מה שמישהו אחר הוסיף (משימה, פגישה, קנייה) ועוד לא ראיתי. סופרים רק מאז שהתכונה נוספה (seenSince)
const isUnread = it => !!it.by && it.by !== S.uid && !S.seen?.[it.id] && ['task', 'meeting', 'shop'].includes(it.kind) && it.status === 'open'
  && new Date(it.created || 0) > new Date(S.seenSince || Date.now());
async function markSeen(list) {
  if (!list.length) return;
  S.seen = { ...(S.seen || {}) }; for (const it of list) S.seen[it.id] = Date.now();
  const old = Date.now() - 60 * 864e5; for (const [k, v] of Object.entries(S.seen)) if (v < old) delete S.seen[k];
  await db.setKV('seen', S.seen); drawUnread();
}
const unreadChat = () => S.msgs.filter(m => m.role === 'bot' && m.ts > (S.chatSeen || '')).length;
function drawUnread() {
  const t = S.items.filter(x => isUnread(x) && x.kind !== 'shop').length, sh = S.items.filter(x => isUnread(x) && x.kind === 'shop').length;
  const c = curView() === 'chat' && !document.hidden ? 0 : unreadChat();
  const set = (sel, n) => { const b = $(sel); if (b) { b.hidden = !n; b.textContent = n > 99 ? '99+' : n; } };
  set('#newTasks', t); set('#newShop', sh); set('#newChat', c);
}
// נכנסים למסך → מה שחדש מסומן "חדש" עד שיוצאים, ונחשב כנקרא
function seeView(v) {
  if (v === 'tasks') { const l = S.items.filter(x => isUnread(x) && x.kind !== 'shop'); S.fresh = new Set(l.map(x => x.id)); setTimeout(() => markSeen(l), 1500); }
  if (v === 'shop') { const l = S.items.filter(x => isUnread(x) && x.kind === 'shop'); S.freshShop = new Set(l.map(x => x.id)); setTimeout(() => markSeen(l), 1500); }
  if (v === 'chat') { S.chatFrom = S.chatSeen || ''; setTimeout(async () => { if (curView() === 'chat' && !document.hidden) { S.chatSeen = new Date().toISOString(); await db.setKV('chatSeen', S.chatSeen); drawUnread(); } }, 1500); }
}

// ---------- שמירה ----------
async function save(it) {
  if (S.uid && !it.by) { it.by = S.uid; it.byP = S.myP; }
  await db.put('items', it); sync.queue(it);
}
async function addLog(it, action) {
  const l = { id: db.newId(), ts: new Date().toISOString(), itemId: it?.id || null, text: it?.text || '', action };
  S.log.push(l); await db.put('log', l);
}

// ---------- הודעות בשיחה ----------
const KIND = {
  task: { ic: '📌', bg: 'var(--g1)' }, rep: { ic: '🔁', bg: 'var(--g2)' }, meeting: { ic: '👥', bg: 'var(--g5)' },
  thought: { ic: '💭', bg: 'var(--g6)' },
};
const nowLbl = ts => new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
const dayLbl = ts => {
  const d = new Date(ts), diff = Math.round((sod(new Date()) - sod(d)) / 864e5);
  return diff === 0 ? 'היום' : diff === 1 ? 'אתמול' : `יום ${DAYS[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}`;
};

function msgEl(m, isNew) {
  const d = document.createElement('div');
  if (m.role === 'me') {
    d.className = 'me' + (isNew ? ' new' : '');
    d.innerHTML = `${esc(m.text)}<div class="time">${m.voice ? '🎤 ' : ''}${nowLbl(m.ts)}</div>`;
    return d;
  }
  d.className = 'bot' + (isNew ? ' new' : '');
  d.innerHTML = `<div class="in"><div class="ic" style="background:${/^[\w\s#(),.%-]*$|^var\(--[\w-]+\)$|^linear-gradient\([\w\s#(),.%-]+\)$/.test(m.bg || '') && m.bg ? m.bg : 'var(--card2)'}">${esc(m.ic || '🤖')}</div><div><b>${esc(m.title)}</b>${m.sub ? `<div class="sub">${esc(m.sub)}</div>` : ''}</div></div>`;
  if (m.acts?.length) {
    const box = document.createElement('div');
    box.className = 'acts' + (m.used ? ' used' : '');
    m.acts.forEach((a, i) => {
      const b = document.createElement('button');
      b.className = 'act' + (a.pri ? ' pri' : '') + (m.chosen === i ? ' chosen' : '');
      b.textContent = a.l;
      b.onclick = () => onAct(m, i, box);
      box.appendChild(b);
    });
    d.appendChild(box);
  }
  return d;
}

let lastDay = null;
function appendMsg(m, isNew) {
  const dl = dayLbl(m.ts);
  if (dl !== lastDay) { const s = document.createElement('div'); s.className = 'day'; s.textContent = dl; $('#chat').appendChild(s); lastDay = dl; }
  $('#chat').appendChild(msgEl(m, isNew));
}
function scrollDown() { requestAnimationFrame(() => { const mn = $('#main'); mn.scrollTo({ top: mn.scrollHeight, behavior: 'smooth' }); }); }

async function pushMsg(m) {
  m.id = db.newId(); m.ts = new Date().toISOString();
  S.msgs.push(m); await db.put('msgs', m); drawUnread();
  if ($('#v-chat').classList.contains('on')) { appendMsg(m, true); scrollDown(); } else { lastDay = null; }
  return m;
}
const me = (text, voice) => pushMsg({ role: 'me', text, voice: !!voice });
const bot = (ic, bg, title, sub, acts) => pushMsg({ role: 'bot', ic, bg, title, sub, acts });
function think(ms = 450) {
  const t = document.createElement('div'); t.className = 'typing'; t.innerHTML = '<i></i><i></i><i></i>';
  $('#chat').appendChild(t); scrollDown();
  return new Promise(r => setTimeout(() => { t.remove(); r(); }, ms));
}

// כפתורים שלא "נועלים" את ההודעה (אפשר ללחוץ עליהם שוב)
const KEEP = new Set(['toKesef', 'shopView', 'calDay', 'pickShifts', 'quickFor', 'bump', 'assign', 'newGroup', 'shareGroup', 'editMe', 'edit', 'star', 'pickTop3', 'goto', 'conflict', 'replyText', 'replyNo']);
async function onAct(m, i, box) {
  const a = m.acts[i];
  if (!KEEP.has(a.op)) {
    m.used = true; m.chosen = i; await db.put('msgs', m);
    box.classList.add('used'); box.children[i].classList.add('chosen');
  }
  OPS[a.op]?.(...(a.a || []));
}

// ---------- פעולות על משימות ----------
function snoozeDate(preset, it) {
  const n = new Date(), at = (d, h, mi = 0) => { const x = new Date(d); x.setHours(h, mi, 0, 0); return x; };
  switch (preset) {
    case 'hour': return { d: new Date(n.getTime() + 3600e3), t: true, l: 'בעוד שעה' };
    case 'afternoon': return n.getHours() < 15 ? { d: at(n, 16), t: true, l: 'היום ב-16:00' } : { d: at(n, 20), t: true, l: 'הערב ב-20:00' };
    case 'evening': return n.getHours() < 20 ? { d: at(n, 20), t: true, l: 'הערב ב-20:00' } : { d: at(addDays(n, 1), 9), t: true, l: 'מחר ב-09:00' };
    case 'tomorrowMorning': return { d: at(addDays(n, 1), 9), t: true, l: 'מחר ב-09:00' };
    case 'tomorrow': {
      if (it?.hasTime && it.due) { const o = new Date(it.due); const d = at(addDays(n, 1), o.getHours(), o.getMinutes()); return { d, t: true, l: 'מחר ב-' + hm(d) }; }
      return { d: sod(addDays(n, 1)), t: false, l: 'מחר' };
    }
  }
}

async function markDone(id, quiet) {
  const it = item(id); if (!it) return toast('המשימה הזאת כבר לא קיימת', true);
  const now = new Date();
  let ended = false;
  if (it.repeat) {
    it.lastDone = now.toISOString();
    if (it.due) it.doses = { ...(it.doses || {}), [it.due]: now.toISOString() }; // 💊 איזו מנה נלקחה
    const from = new Date(Math.max(now, new Date(it.due || now)));
    it.due = nextOccurrence(it.repeat, it.hasTime ? new Date(it.due).getHours() : 9, it.hasTime ? new Date(it.due).getMinutes() : 0, from)?.toISOString() || null;
    it.askAt = null; it.askedKey = null; it.nag = 0;
    if (!it.due && it.repeat.until) { it.status = 'done'; it.doneAt = now.toISOString(); it.ended = true; ended = true; }
  } else { it.status = 'done'; it.doneAt = now.toISOString(); }
  if (it.kind === 'thought') it.kind = 'task';
  it.doneBy = S.myP;
  await save(it); await addLog(it, 'done');
  if (it.stars) await creditStars(it);
  if (PAY_RE.test(it.text) && it.kind !== 'shop') setTimeout(() => bot('💰', 'var(--g3)', 'שילמת? לרשום את זה בכסף בכיף', `"${it.text}"`, [{ l: '💰 לרשום בכסף בכיף', op: 'toKesef', a: [id], pri: true }]), 600);
  // מי שנתן לי את המשימה מקבל הודעה שסיימתי
  if (it.by && it.by !== S.uid && S.uid) queueNotify(it.by, 'done', `✅ ${nameIn(S.myP, it.group_id)} סיים/ה`, it.text, it.id + ':' + now.getTime());
  if (S.pending === id) S.pending = null;
  renderAll();
  if (ended) { await finishedMsg(it); confetti(140); return; }
  if (!quiet && it.med && it.repeat) {
    const st = doseStats(it);
    await bot('💊', 'var(--g3)', `✅ נרשם: ${it.text}`, `${st ? `לקחת ${st.taken}/${st.expected} מנות` : ''}${st?.daysLeft != null ? ` · נשארו ${st.daysLeft} ימים` : ''}${it.due ? `\nהמנה הבאה: ${whenLabel1(it)}` : ''}`, [{ l: '↩️ בטל סימון', op: 'undoDone', a: [id] }]);
    confetti(40); return;
  }
  if (!quiet) {
    await think(300);
    const left = top3Items().filter(x => !isDoneToday(x)).length, inTop = S.top3?.ids.includes(id);
    let sub = `"${it.text}" סומן כבוצע.`;
    if (it.repeat && it.due) sub += `\nהפעם הבאה: ${whenLabel(it)}`;
    if (inTop) sub += left ? `\nנשארו עוד ${left} מהחשובים של היום 💪` : '\nסיימת את כל החשובים של היום! 🏆';
    await bot('🎉', 'var(--g3)', pick(['כל הכבוד!', 'מעולה!', 'יפה מאוד!', 'אלוף!']), sub, [{ l: '↩️ בטל סימון', op: 'undoDone', a: [id] }]);
  }
  confetti(inTop3AllDone() ? 140 : 70);
}
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
// ❓ שאלה בצ'אט ("איך מוחקים משימה?") — תשובה מהעזרה בתוך השיחה, ולא משימה חדשה
const plain = h => h.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
async function helpInChat(text, voice) {
  await me(text, voice); await think();
  const kid = !sync.isParent() && sync.myGroups().length > 0;
  const ts = help.answer(text).filter(t => !kid || !['roles', 'add'].includes(t.id));
  if (!ts.length) return bot('🤔', 'var(--card2)', 'לא בטוח שהבנתי את השאלה', 'אפשר לנסח אחרת, לפתוח את העזרה, או לשלוח את השאלה למוישי.\nרצית לרשום את זה כמשימה? לחצו "📌 לרשום כמשימה".',
    [{ l: '❓ עזרה', op: 'help', a: [text] }, { l: '📌 לרשום כמשימה', op: 'asTask', a: [text] }, { l: '💌 לשאול את מוישי', op: 'feedback', a: [text] }]);
  const [t, t2] = ts;
  await bot('❓', 'var(--g2)', t.t, plain(t.a), [{ l: '❓ עוד בעזרה', op: 'help', a: [text] }, ...(t2 ? [{ l: t2.t.slice(0, 30), op: 'helpTopic', a: [t2.id] }] : [])]);
}
// 🗑️ כל מחיקה שואלת "בטוח?" — ואחרי המחיקה יש ↩️ בטל
function askRemove(id, after) {
  const it = item(id); if (!it) return toast('זה כבר לא קיים', true);
  sheet(`<h3>🗑️ למחוק?</h3><p class="note" style="margin-bottom:14px"><b>${esc(it.text)}</b>${it.due ? ' · ' + esc(whenLabel(it)) : ''}${it.repeat ? '<br>🔁 זה קבוע: כל הפעמים הבאות יימחקו' : ''}<br>אפשר לבטל מיד אחרי (↩️ בטל).</p>
    <button class="btn danger" id="rmYes">🗑️ כן, למחוק</button><button class="btn" id="rmNo">ביטול</button>`);
  $('#rmNo').onclick = closeSheet;
  $('#rmYes').onclick = async () => { await OPS.removeNow(id); closeSheet(); after?.(); };
}
// "תמחק את הפגישה עם יוסי" / "בטל את התור לרופא" — מחיקה מהצ'אט (רק בציווי: "לבטל את המנוי" זו משימה)
const DEL_RE = /^(?:תמחק|תמחקי|מחק|מחקי|תבטל|תבטלי|בטל|בטלי|תוריד|תורידי|תסיר|תסירי)\s+(?:לי\s+)?(?:את\s+)?(.+?)\s*[.!?]*$/;
async function deleteByText(text, voice) {
  const m = text.match(DEL_RE); if (!m) return false;
  const q = m[1].replace(/^(?:ה)?(?:משימה|פגישה|תזכורת|אירוע)\s+(?:של\s+)?/, '').trim();
  const cands = S.items.filter(x => ['open', 'paused'].includes(x.status) && x.text && !['msg', 'star'].includes(x.kind) && (byMe(x) || isMine(x)))
    .map(x => ({ x, s: matchScore(q, x.text) })).filter(c => c.s >= 0.45).sort((a, b) => b.s - a.s).slice(0, 4);
  await me(text, voice); await think();
  if (!cands.length) { await bot('🔎', 'var(--card2)', 'לא מצאתי מה למחוק', `חיפשתי "${q}". אפשר גם ללחוץ על המשימה ← 🗑️, או להחליק אותה הצידה במסך המשימות.`); return true; }
  const lbl = x => `${x.text}${x.due ? ' · ' + whenLabel(x) : ''}`;
  if (cands.length === 1 || cands[0].s - cands[1].s > 0.2) {
    const x = cands[0].x;
    await bot('🗑️', 'linear-gradient(135deg,#F43F5E,#BE123C)', 'בטוח למחוק?', lbl(x), [{ l: '🗑️ כן, למחוק', op: 'removeNow', a: [x.id], pri: true }, { l: '✋ לא', op: 'noop' }]);
  } else {
    await bot('🤔', 'var(--card2)', 'איזה מהם למחוק?', cands.map((c, i) => `${i + 1}. ${lbl(c.x)}`).join('\n'),
      [...cands.map((c, i) => ({ l: `🗑️ ${i + 1}. ${c.x.text.slice(0, 22)}`, op: 'remove', a: [c.x.id] })), { l: '✋ אף אחד', op: 'noop' }]);
  }
  return true;
}

const OPS = {
  bump: id => bumpTask(id),
  toKesef: id => openToKesef(id),
  focus: id => openFocusPick(id),
  focusAgain: id => startFocus(id, 'work'),
  focusBreak: id => startFocus(id, 'break'),
  habitTick: id => tickHabit(id),
  shopView: gid => { S.shopG = gid || null; showView('shop'); },
  shopList: (gid, lid) => { S.shopG = gid || null; S.shopL = { ...(S.shopL || {}), [gid || '']: lid || null }; showView('shop'); },
  calDay(iso) { CAL.day = sod(new Date(iso)); CAL.mode = 'day'; showView('cal'); },
  async undoMany(...ids) {
    for (const id of ids) { const it = item(id); if (!it) continue; it.status = 'deleted'; await save(it); }
    renderAll(); toast(`↩️ בוטל (${ids.length})`);
  },
  pickShifts: (whoP, nm) => openShiftPicker(whoP || null, nm),
  quickFor: (title, whoP) => openQuick({ text: title, kind: 'meeting', forP: whoP || null }),
  async bumpDone(id) { const m = item(id); if (!m) return; if (item(m.bump)?.status === 'open') await markDone(m.bump, true); await addReply(m, { r: 'done' }); toast('✅ נשלח שסיימת'); },
  done: id => markDone(id),
  skipDose: id => skipDose(id),
  async snoozeMed(id) { const it = item(id); if (!it) return; it.askAt = new Date(Date.now() + NAG_MIN * 60e3).toISOString(); it.askedKey = null; it.nag = Math.min(it.nag || 0, NAG_MAX - 1); await save(it); toast(`⏰ אזכיר שוב בעוד ${NAG_MIN} דקות`); },
  recur: id => openRecur(S.items.find(x => x.id === id) || null),
  recurList: () => { showView('tasks'); setTimeout(() => $('#recurCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250); },
  async undoDone(id) {
    const it = item(id); if (!it) return;
    if (it.repeat) {
      it.lastDone = null;
      const last = Object.entries(it.doses || {}).sort((a, b) => a[1].localeCompare(b[1])).pop();
      if (last) { delete it.doses[last[0]]; it.due = last[0]; }
      if (it.ended) { it.status = 'open'; it.ended = false; it.doneAt = null; }
    } else { it.status = 'open'; it.doneAt = null; }
    const i = S.log.findLastIndex(l => l.itemId === id && l.action === 'done');
    if (i >= 0) { await db.del('log', S.log[i].id); S.log.splice(i, 1); }
    if (it.stars) await uncreditStars(it);
    await save(it); renderAll(); toast('↩️ הסימון בוטל');
  },
  async snoozeAsk(id) {
    const it = item(id); if (!it) return;
    await think();
    await bot('⏰', 'var(--g4)', 'אין בעיה. מתי לשאול שוב?', it.text, [
      { l: 'בעוד שעה', op: 'snooze', a: [id, 'hour'] }, { l: 'אחר הצהריים', op: 'snooze', a: [id, 'afternoon'] },
      { l: 'הערב', op: 'snooze', a: [id, 'evening'] }, { l: 'מחר', op: 'snooze', a: [id, 'tomorrow'] },
      { l: '📅 תאריך אחר', op: 'edit', a: [id, 'date'] },
    ]);
  },
  async snooze(id, preset, quiet) {
    const it = item(id); if (!it) return;
    const s = snoozeDate(preset, it);
    if (it.repeat) it.askAt = s.d.toISOString();
    else { it.due = s.d.toISOString(); it.hasTime = s.t; it.askAt = null; }
    it.askedKey = null;
    if (it.kind === 'thought') it.kind = 'task';
    await save(it); await addLog(it, 'snoozed'); renderAll();
    if (S.pending === id) S.pending = null;
    if (!quiet) { await think(300); await bot('👍', 'var(--g2)', `בסדר, ${s.l}`, s.t ? `אשאל אותך שוב על "${it.text}"` : `"${it.text}" עבר ל${s.l}`); }
  },
  async when(id, preset) {
    const it = item(id); if (!it) return;
    if (preset === 'none') { it.kind = it.kind === 'meeting' ? 'meeting' : 'task'; await save(it); renderAll(); await think(250); return bot('👍', 'var(--g2)', 'נשמר בלי תאריך', `"${it.text}" נמצא במסך המשימות`); }
    return OPS.snooze(id, preset);
  },
  edit: (id, focus) => openEdit(id, focus),
  async undo(id) {
    const it = item(id); if (!it) return;
    it.status = 'deleted'; await save(it); await addLog(it, 'deleted');
    if (S.top3) S.top3.ids = S.top3.ids.filter(x => x !== id), await db.setKV('top3', S.top3);
    renderAll(); await think(250); await bot('↩️', 'var(--card2)', 'בוטל', `"${it.text}" נמחק`);
  },
  remove: id => askRemove(id),
  noop: () => toast('👍 בסדר, לא נמחק'),
  help: q => openHelp(q || ''),
  feedback: q => openFeedback(q || ''),
  async asTask(q) { const t = String(q || '').replace(/[?？]+\s*$/, '').trim(); if (!t) return; const p = parse(t); await createItem({ ...p, kind: p.kind === 'thought' ? 'task' : p.kind, text: p.text || t }, t); },
  async helpTopic(id) { const t = help.TOPICS.find(x => x.id === id); if (t) await bot('❓', 'var(--g2)', t.t, plain(t.a), [{ l: '❓ עוד בעזרה', op: 'help', a: [''] }]); },
  async removeNow(id) {
    const it = item(id); if (!it) return;
    const was = it.status;
    it.status = 'deleted'; await save(it); await addLog(it, 'deleted');
    if (S.top3) S.top3.ids = S.top3.ids.filter(x => x !== id), await db.setKV('top3', S.top3);
    renderAll();
    toast('🗑️ נמחק', false, { l: '↩️ בטל', run: async () => { it.status = was; await save(it); await addLog(it, 'restored'); renderAll(); toast('↩️ חזר'); } });
  },
  async toThought(id) {
    const it = item(id); if (!it) return;
    Object.assign(it, { kind: 'thought', due: null, hasTime: false, repeat: null, askAt: null, askedKey: null });
    await save(it); await addLog(it, 'moved'); renderAll(); toast('💭 עבר לתיבת המחשבות');
  },
  async toTask(id) {
    const it = item(id); if (!it) return;
    it.kind = 'task'; await save(it); renderAll(); toast('📋 עבר למשימות (בלי תאריך)');
  },
  async skipOnce(id) {
    const it = item(id); if (!it?.repeat) return;
    const d = new Date(it.due);
    it.due = nextOccurrence(it.repeat, d.getHours(), d.getMinutes(), new Date(Math.max(new Date(), d)))?.toISOString();
    it.askAt = null; it.askedKey = null; await save(it); renderAll();
    toast('⏭️ דילגתי הפעם. הבא: ' + whenLabel(it));
  },
  async star(id) {
    const it = item(id); if (!it) return;
    if (it.kind === 'thought') { it.kind = 'task'; it.due = sod(new Date()).toISOString(); it.hasTime = false; await save(it); }
    const t3 = curTop3();
    if (t3.ids.includes(id)) { t3.ids = t3.ids.filter(x => x !== id); toast('הוסר מהחשובים'); }
    else { t3.ids.push(id); toast('⭐ נוסף לחשובים של היום'); }
    S.top3 = t3; await db.setKV('top3', t3); renderAll();
  },
  async top3ok(ids) {
    S.top3 = { date: today(), ids: ids.filter(x => item(x)) }; await db.setKV('top3', S.top3); renderAll();
    await think(250); await bot('💪', 'var(--g3)', 'יאללה, יום טוב!', 'החשובים מופיעים למעלה. לחיצה עליהם מסמנת שבוצעו');
  },
  pickTop3: () => openPicker(),
  async matchDone(id) { await markDone(id); },
  async logDone(text) {
    const it = { id: db.newId(), kind: 'task', text, due: null, hasTime: false, repeat: null, status: 'done', created: new Date().toISOString(), doneAt: new Date().toISOString() };
    S.items.push(it); await save(it); await addLog(it, 'done'); renderAll();
    await think(250); await bot('🙌', 'var(--g3)', 'יפה! רשמתי שעשית את זה', text); confetti(50);
  },
  async undoLogged(id) {
    const it = item(id); if (!it) return;
    it.status = 'open'; it.kind = 'thought'; it.doneAt = null;
    const i = S.log.findLastIndex(l => l.itemId === id && l.action === 'done');
    if (i >= 0) { await db.del('log', S.log[i].id); S.log.splice(i, 1); }
    await save(it); renderAll(); toast('💭 נשמר כמחשבה');
  },
  reviewLeftovers: () => reviewOpen('leftovers'),
  goto: v => showView(v),
  assign: id => openAssign(id),
  newGroup: () => { showView('settings'); openNewGroup(); },
  shareGroup: gid => { const g = groupOf(gid); if (g) window.open(waHref(inviteText(g, g.code)), '_blank'); },
  editMe: () => openEditMe(),
  switchUser: () => signOut(),
  async dur(id, m) {
    const it = item(id); if (!it) return;
    it.dur = m; await save(it); renderAll();
    toast(m ? `⏱️ ${durLbl(m)}` : '⏱️ רק תזכורת');
    await scanConflicts();
  },
  async travel(a, b, m) { S.travel[[a, b].sort().join('|')] = m; await db.setKV('travel', S.travel); toast(`🚗 נשמר: ${durLbl(m)}`); await scanConflicts(); },
  conflict: (a, b) => openConflict(a, b),
  async react(id, r) {
    const m = item(id); if (!m) return toast('ההודעה כבר לא קיימת', true);
    await addReply(m, { r });
    if (r === 'yes' && m.invite) { await createShared(m, m.invite); await bot('✅', 'var(--g3)', 'מאושר! נכנס ללוח של שניכם', `${m.text}\n📅 ${whenLabel(m.invite)}`); confetti(70); }
    else toast(`${REACT[r]} נשלח`);
  },
  replyNo: (id, mode) => openReplyNo(id, mode),
  replyText: id => openReplyText(id),
  async acceptAlt(id, idx) {
    const m = item(id); const r = m?.replies?.[idx]; if (!r?.alt) return;
    await addReply(m, { r: 'yes', alt: r.alt });
    await createShared(m, r.alt);
    await bot('✅', 'var(--g3)', 'סגרנו! נכנס ללוח של שניכם', `${m.text}\n📅 ${whenLabel(r.alt)}`); confetti(70);
  },
  async unsend(id) { const m = item(id); if (!m) return; m.status = 'deleted'; await save(m); toast('↩️ ההודעה בוטלה'); },
  async okConf(aId, bId) {
    for (const [x, y] of [[aId, bId], [bId, aId]]) { const it = x && item(x); if (it && y && !it.busy) { it.ok = [...new Set([...(it.ok || []), y])]; await save(it); } }
    renderAll(); await scanConflicts(); toast('👍 בסדר, לא אתריע על זה שוב');
  },
};

// ---------- טיפול במה שכתבת ----------
async function send(text, voice) {
  text = text.trim(); if (!text) return;
  // משוב ("משוב: …", "תקלה: …") — חלון משוב שנשלח למייל של מוישי, בלי לשמור בשיחה
  if (FEEDBACK_RE.test(text)) { $('#inp').blur(); return openFeedback(text.replace(FEEDBACK_RE, '').trim(), text); }
  // שאלה על האפליקציה ("איך מוסיפים את אשתי?") — תשובה בחלון עזרה, בלי ללכלך את השיחה
  if (DEL_RE.test(text) && await deleteByText(text, voice)) return;
  const pi = parse(text).intent;
  const p0 = parse(text), asks = /[?？]\s*$/.test(text) && pi === 'item' && !p0.due && !p0.repeat;
  if (!['query', 'summary', 'morning', 'yes', 'no', 'done'].includes(pi) && (help.isHelpRequest(text) || asks)) {
    if (help.wantsGuide(text) && !help.answer(text).length) { $('#inp').blur(); return openHelp(text, true); }
    return helpInChat(text, voice);
  }
  if (/^(?:תקפיץ|תקפיצי|להקפיץ|הקפץ|הקפיצי)\s/.test(text) && await bumpByText(text)) return;
  // "הרגל: לשתות 8 כוסות מים" → הרגל חדש (עם רצף 🔥)
  const hm2 = text.match(/^(?:הרגל(?:\s+חדש)?|תוסיף\s+הרגל|הרגל\s+יומי)\s*[:\-–]?\s*(.+)$/);
  if (hm2) {
    await me(text, voice); await think();
    let t = hm2[1].trim(); const dows = [];
    DAYS.forEach((d, i) => { const re = new RegExp(`(^|\\s)(?:ו?ב?יום\\s+|ו?ב)?${d}(?=[\\s,]|$)`); if (re.test(t)) { dows.push(i); t = t.replace(re, ' '); } });
    t = t.replace(/(^|\s)(?:כל\s+יום|כל\s+בוקר|כל\s+ערב|כל|יומי|בכל\s+יום)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    const ICON = [[/מים|לשתות/, '💧'], [/לקרוא|קריאה|ספר/, '📖'], [/ריצה|לרוץ/, '🏃'], [/הליכה|ללכת/, '🚶'], [/מדיטציה|נשימות/, '🧘'], [/תפילה|להתפלל|תהילים|שיעור|דף יומי/, '🙏'], [/שיניים/, '🦷'], [/לישון|שינה/, '😴'], [/ויטמין|כדור|תרופה/, '💊'], [/פרי|ירק|לאכול/, '🥗'], [/טלפון|מסך/, '📵'], [/לכתוב|יומן/, '✍️']].find(([r]) => r.test(t))?.[1] || '⭐';
    const h = { id: db.newId(), kind: 'habit', text: t, icon: ICON, goal: goalOf(t), dows: dows.length ? dows.sort() : null, status: 'open', created: new Date().toISOString(), log: {}, group_id: null, private: true, due: null, hasTime: false, repeat: null };
    S.items.push(h); await save(h); renderTasks();
    return bot('🔥', 'var(--g4)', `הרגל חדש: ${ICON} ${t}`, `${h.dows ? 'בימים: ' + h.dows.map(d => DAYS[d]).join(', ') : 'כל יום'}\nמסמנים במסך 📋 משימות ← 🔥 הרגלים, והרצף גדל`, [{ l: '✅ עשיתי היום', op: 'habitTick', a: [h.id], pri: true }, { l: '📋 להרגלים', op: 'goto', a: ['tasks'] }]);
  }
  // "תבנית ניקיון פסח" / "תבנית הכנות לשבת"
  const tm = text.match(/^(?:תבנית|מתבנית|תפתח\s+תבנית)\s+(.+)$/);
  if (tm) {
    const want = tm[1].trim(), t = allTemplates().find(x => x.name.includes(want) || want.includes(x.name.split(' ')[0]));
    await me(text, voice); await think();
    if (!t) return bot('📋', 'var(--card2)', 'לא מצאתי תבנית כזאת', 'התבניות: ' + allTemplates().map(x => x.name).join(' · '));
    return createItem({ kind: 'task', text: t.name, steps: mkSteps(t.steps), due: null, hasTime: false, repeat: null }, null).then(() => { const n = S.items[S.items.length - 1]; if (n?.steps) openSteps(n.id); });
  }
  if (/^(?:תפריט\s+(?:ל)?שבת|מה\s+מבשלים\s+לשבת|מה\s+נבשל\s+לשבת)\??$/.test(text.trim())) { await me(text, voice); return openMenu(); }
  // "טמבור: מסמרים, צבע" → לרשימה בשם הזה (רק אם פתחו רשימה כזאת — בלי ניחוש אוטומטי)
  const nl = text.match(/^(?:ל|לרשימת\s+|לרשימה\s+)?([^:]{2,25}?)\s*:\s*(.+)$/);
  if (nl) {
    const gid = defGroup()?.id || null, l = shopLists(gid).find(x => x.text.trim() === nl[1].trim());
    if (l) {
      await me(text, voice); await think();
      const a = await addShop(shopItems('קניות: ' + nl[2], true) || [nl[2]], gid, l.id);
      return bot(l.icon || '🏪', 'var(--g3)', a.length ? `נוסף${a.length > 1 ? 'ו ' + a.length : ''} לרשימה "${l.text}"` : 'כבר ברשימה', a.map(x => `${deptOf(x.dept)[1]} ${x.text}`).join('\n'),
        [{ l: `${l.icon || '🏪'} לרשימה`, op: 'shopList', a: [gid || '', l.id], pri: true }]);
    }
  }
  // "קניות: חלב, ביצים" → רשימת הקניות של הקבוצה הראשית
  const shopL = shopItems(text);
  if (shopL?.length) {
    await me(text, voice); await think();
    const gid = defGroup()?.id || null, a = await addShop(shopL, gid);
    return bot('🛒', 'var(--g3)', a.length ? `נוסף${a.length > 1 ? 'ו ' + a.length : ''} לרשימת הקניות${gid ? ` של "${groupOf(gid)?.name}"` : ''}` : 'כבר ברשימה',
      a.map(x => `${deptOf(x.dept)[1]} ${x.text}`).join('\n'), [{ l: '🛒 לרשימה', op: 'shopView', a: [gid || ''] , pri: true }]);
  }
  // משפט "ליומן" (כמה ימים / משמרות / "תכניס ל...") → אירועים ביומן
  const sm = smartParse(text, { names: smartNames(), shifts: shiftHours(), now: new Date() });
  if (sm) { await me(text, voice); await think(); return createEvents(sm); }
  await me(text, voice);
  await think();
  const f = forWhom(text);
  if (f.msg) return sendMessage(f);
  // "תכניס לשרה לסדר את החדר 3 כוכבים" → מטלה עם ⭐
  let stars = null; const sM = f.text.match(/(?:^|\s)(?:ב-?|עם\s+|שווה\s+)?(\d{1,2})\s*כוכבים?(?=\s|$)|\s*⭐\s*(\d{1,2})/);
  if (sM) { stars = +(sM[1] || sM[2]); f.text = f.text.replace(sM[0], ' ').replace(/\s+/g, ' ').trim(); }
  const zm = Z.findZman(f.text);
  const pl = C.findPlace(zm ? zm.rest : f.text, knownPlaces());
  const p = parse(pl.text);
  if (zm && p.intent === 'item') {
    const at = await Z.zmanTime(S.settings.city, zm, p.due && !p.hasTime ? p.due : null);
    if (at) { p.due = at; p.hasTime = true; p.needsWhen = false; if (p.kind === 'thought') p.kind = 'task'; }
    else return bot('🤔', 'var(--card2)', 'לא הצלחתי לחשב את הזמן', 'צריך אינטרנט כדי לקבל את זמני היום. נסה שוב עוד רגע');
  }
  p.forP = f.forP; p.private = f.private; p.group = f.group || null; p.stars = stars; p.place = pl.place; p.res = C.findRes(text, S.resources);

  if (p.intent === 'help') return openHelp();
  if (p.intent === 'summary') return evening(true);
  if (p.intent === 'morning') return morning(true);
  if (p.intent === 'query') return query(p.day);

  if (p.intent === 'yes') {
    if (S.pending && item(S.pending)) return markDone(S.pending);
    return askWhich('', 'על מה מדובר? 🙂');
  }
  if (p.intent === 'no') {
    if (S.pending && item(S.pending)) return OPS.snoozeAsk(S.pending);
    return bot('👍', 'var(--g2)', 'בסדר', 'אם תרצה לרשום משהו, פשוט כתוב לי');
  }
  if (p.intent === 'done') return doneReport(p);

  // "תזכיר לי אחרי הצהריים" כתשובה לשאלה "עשית?"
  if (S.pending && item(S.pending) && p.due && p.bare && !p.repeat) {
    const it = item(S.pending);
    if (it.repeat) it.askAt = p.due.toISOString(); else { it.due = p.due.toISOString(); it.hasTime = p.hasTime; }
    it.askedKey = null; await save(it); S.pending = null; renderAll();
    return bot('👍', 'var(--g2)', `בסדר, ${whenLabel({ due: p.due, hasTime: p.hasTime })}`, `אשאל אותך שוב על "${it.text}"`);
  }
  return createItem(p, text);
}

// הקבוצה המשותפת לי ולאדם הזה (קודם קבוצה רגילה, אחר כך קשר ישיר)
function sharedGroup(pid) {
  const p = person(pid); if (!p) return null;
  const gs = p.nicks.map(n => groupOf(n.g)).filter(Boolean);
  return gs.find(g => g.kind !== 'pair') || gs[0] || null;
}
// הקבוצה "הראשית" (לשיוך של "מישהו מאיתנו")
const defGroup = () => groupOf(S.settings.defGroup) || sync.myGroups().find(g => g.kind === 'family') || sync.myGroups().find(g => g.kind !== 'pair') || null;
// "תזכיר לרחל מחר ב-5 לקנות חלב" / "רחל: לקנות חלב" / "משימה לרחל ..." / "פרטי: ..."
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function forWhom(text) {
  let t = text.trim(), forP = null, priv = false, m;
  if ((m = t.match(/^(?:פרטי|🔒)\s*[:\-–]?\s*/))) { priv = true; t = t.slice(m[0].length); }
  if (/\(פרטי\)|\s🔒/.test(t)) { priv = true; t = t.replace(/\s*\(פרטי\)|\s*🔒/g, ''); }
  if ((m = t.match(/(^|\s)(מישהו מאיתנו|אחד מאיתנו|מישהו מהבית|אחד ההורים)(\s+(צריך|צריכה|חייב))?(?=\s|$)/))) {
    t = t.replace(m[0], ' ').replace(/\s+/g, ' ').trim(); if (!/^(תזכיר|משימה)/.test(t)) t = 'משימה: ' + t; return { text: t, forP: 'any', private: false, group: defGroup()?.id || null };
  }
  // כל אדם — לפי השם המלא שלו ולפי כל כינוי שלו בכל קבוצה ("אבא", "מוישי")
  const names = S.people.flatMap(p => [{ id: p.id, name: p.name, g: null }, ...p.nicks.map(n => ({ id: p.id, name: n.nick, g: n.g }))])
    .filter(x => x.name).sort((a, b) => b.name.length - a.name.length);
  // הודעה לבן משפחה: "פסי, קבעתי לנו דייט…" / "תגיד לפסי ש…" / "תשאל את פסי אם…"
  for (const p of names.filter(p => p.id !== S.myP)) {
    const n = reEsc(p.name);
    if ((m = t.match(new RegExp(`^${n}\\s*,\\s*`))) || (m = t.match(new RegExp(`^(?:תגיד|תגידי|תכתוב|תכתבי|תודיע|תודיעי)\\s+ל${n}(?=[\\s:,]|$)\\s*[:,]?\\s*(?:ש)?`)))
      || (m = t.match(new RegExp(`^(?:תשאל|תשאלי)\\s+את\\s+${n}(?=[\\s:,]|$)\\s*[:,]?\\s*`))) || (m = t.match(new RegExp(`^הודעה\\s+ל${n}(?=[\\s:,]|$)\\s*[:,]?\\s*`)))) {
      return { text: t.slice(m[0].length).trim() || t, forP: p.id, private: true, msg: true, group: p.g || sharedGroup(p.id)?.id || null };
    }
  }
  let group = null;
  for (const p of names) {
    const n = reEsc(p.name), E = '(?=[\\s:,]|$)';
    const self = p.id === S.myP;
    group = self ? null : (p.g || sharedGroup(p.id)?.id || null);
    if ((m = t.match(new RegExp(`^(תזכיר|תזכירי|להזכיר|תגיד|תגידי|תבקש|תבקשי)\\s+(?:מ|ל|את\\s+)${n}${E}\\s*[:,]?\\s*`)))) {
      t = 'תזכיר לי ' + t.slice(m[0].length); forP = self ? null : p.id; break;
    }
    if ((m = t.match(new RegExp(`^(?:תכניס|תכניסי|תוסיף|תוסיפי|תרשום|תרשמי|תן|תני)\\s+(?:משימה\\s+|מטלה\\s+)?(?:ל|בשביל\\s+)${n}${E}\\s*[:,]?\\s*(?:מטלה\\s*[:,]?\\s*)?`)))) {
      t = 'משימה: ' + t.slice(m[0].length); forP = self ? null : p.id; break;
    }
    if ((m = t.match(new RegExp(`^(משימה|תזכורת)\\s+(?:ל|בשביל\\s+)${n}${E}\\s*[:,]?\\s*`)))) {
      t = 'משימה: ' + t.slice(m[0].length); forP = self ? null : p.id; break;
    }
    if ((m = t.match(new RegExp(`^ל?${n}\\s*:\\s*`)))) { t = t.slice(m[0].length); forP = self ? null : p.id; break; }
    // "פסי צריכה מחר ב-8 ללכת לרופא" → משימה בשביל פסי
    if ((m = t.match(new RegExp(`^${n}\\s+(?:צריך|צריכה|צריכים|חייב|חייבת|צריך\\s+ל|צריכה\\s+ל)\\s*`)))) { t = 'משימה: ' + t.slice(m[0].length); forP = self ? null : p.id; break; }
    if ((m = t.match(new RegExp(`(^|\\s)בשביל\\s+${n}${E}`)))) { t = t.replace(m[0], ' ').trim(); forP = self ? null : p.id; break; }
  }
  return { text: t, forP, private: priv, group: forP ? group : null };
}

async function createItem(p, raw) {
  const fp = p.forP && p.forP !== 'any' ? person(p.forP) : null;
  const it = {
    id: db.newId(), kind: p.kind === 'thought' && fp ? 'task' : p.kind, text: p.text || raw, due: p.due ? p.due.toISOString() : null, hasTime: !!p.hasTime,
    repeat: p.repeat, status: 'open', created: new Date().toISOString(), askAt: null, askedKey: null, raw: raw || null,
    forP: p.forP === 'any' ? 'any' : fp?.id || null, forU: fp?.uid || null, private: !!p.private, group_id: p.private ? null : (p.group || null),
    dur: p.dur ?? (p.med && p.repeat ? 0 : null), place: p.place || null, res: p.res?.length ? p.res : null, cat: p.cat || (p.med && p.repeat ? 'health' : null), steps: p.steps || null, stars: p.stars || null,
    med: p.med && p.repeat ? true : null, shabbatOk: p.shabbatOk ?? (p.med && p.repeat ? true : null), icon: p.med && p.repeat ? '💊' : p.icon || null,
  };
  S.items.push(it); await save(it); await addLog(it, 'created'); renderAll();
  if (fp?.uid && fp.uid !== S.uid) queueNotify(fp.uid, 'share', `📥 ${nameIn(S.myP, it.group_id)} נתן/ה לך ${it.kind === 'meeting' ? 'פגישה' : 'משימה'}`, `${it.text}${it.due ? ' · ' + whenLabel(it) : ''}`, it.id);
  else if (it.group_id && !it.private && it.forP !== S.myP) notifyGroup(it.group_id, `📥 ${nameIn(S.myP, it.group_id)} שיתף/ה ב"${groupOf(it.group_id)?.name || 'הקבוצה'}"`, it);
  await createReply(it, p, fp);
  const qw = it.due && it.hasTime && it.kind === 'task' && !it.dur ? Z.quietAt(new Date(it.due)) : null;
  if (qw) await bot('🕯️', 'linear-gradient(135deg,#F59E0B,#FACC15)', `זה נופל ב${qw.name}`, `בשבת ובחג אין תזכורות. אזכיר לך ב${qw.name === 'שבת' ? 'מוצאי שבת' : 'מוצאי החג'}, ב-${hm(new Date(qw.end))}`);
  if (it.kind !== 'thought' && it.hasTime && it.dur == null && !it.med) await askDur(it);
  else await scanConflicts();
}

async function createReply(it, p, fp) {
  const edit = { l: '✏️ תקן', op: 'edit', a: [it.id] }, undo = { l: '🗑️ מחיקה', op: 'remove', a: [it.id] }, assign = { l: '📎 שיוך', op: 'assign', a: [it.id] };
  const extra = [S.uid ? gLabel(groupOf(it.group_id)) : '', it.dur ? `⏱️ ${durLbl(it.dur)}` : '', it.place ? `📍 ${it.place}` : '', ...(it.res || []).map(r => resOf(r)?.e + ' ' + resOf(r)?.n)].filter(Boolean).join(' · ');
  if (it.forP === 'any') return bot('👨‍👩‍👧', 'var(--g6)', `מישהו מאיתנו: ${it.text}`, `${it.due ? whenLabel(it) : 'בלי תאריך'}${extra ? ' · ' + extra : ''}\nאבדוק שלפחות אחד מכם פנוי, ואתריע אם לא`, [assign, edit, undo]);
  if (fp) {
    const sub = `${it.due ? whenLabel(it) : 'בלי תאריך'}\n${fp.uid ? `השאלה "עשית?" תגיע לטלפון של ${nameIn(fp.id, it.group_id)}, ואעדכן אותך כשיסיים/תסיים 🎉` : `ל${nameIn(fp.id, it.group_id)} עוד אין חשבון באפליקציה, אז אשאל אותך`}`;
    return bot(fp.e || '🙋', 'var(--g6)', `בשביל ${nameIn(fp.id, it.group_id)}: ${it.text}`, sub, fp.uid ? [{ l: '🔔 להקפיץ', op: 'bump', a: [it.id] }, assign, edit, undo] : [assign, edit, undo]);
  }
  if (it.private) toast('🔒 פרטי — רק אתה רואה את זה');

  if (it.kind === 'thought') {
    return bot(KIND.thought.ic, KIND.thought.bg, 'נשמר בתיבת המחשבות', `${it.text}\nאין לזה תאריך, וזה בסדר. אפשר לטפל בזה מתי שתרצה.`, [
      { l: '📅 תן תאריך', op: 'edit', a: [it.id, 'date'] }, { l: '⭐ להיום', op: 'star', a: [it.id] },
      { l: '📋 זו משימה', op: 'toTask', a: [it.id] }, undo]);
  }
  if (it.kind === 'meeting') {
    if (!it.due) return bot(KIND.meeting.ic, KIND.meeting.bg, it.text, 'מתי הפגישה? כתוב לי יום ושעה, או בחר כאן', [{ l: '📅 לבחור מועד', op: 'edit', a: [it.id, 'date'], pri: true }, edit, undo]);
    return bot(KIND.meeting.ic, KIND.meeting.bg, it.text, `👥 פגישה · ${whenLabel(it)}${extra ? ' · ' + extra : ''}${it.hasTime ? '\nאזכיר לך חצי שעה לפני' : ''}`, [assign, edit, undo]);
  }
  if (p.needsWhen) {
    return bot(KIND.task.ic, KIND.task.bg, it.text, 'מתי להזכיר לך?', [
      { l: 'בעוד שעה', op: 'when', a: [it.id, 'hour'] }, { l: 'הערב', op: 'when', a: [it.id, 'evening'] },
      { l: 'מחר בבוקר', op: 'when', a: [it.id, 'tomorrowMorning'] }, { l: '📅 תאריך אחר', op: 'edit', a: [it.id, 'date'] },
      { l: 'בלי תאריך', op: 'when', a: [it.id, 'none'] }]);
  }
  if (it.repeat && (it.med || it.repeat.until || it.repeat.times)) {
    const st = doseStats(it);
    return bot(it.med ? '💊' : '🔁', it.med ? 'linear-gradient(135deg,#14B8A6,#22C55E)' : KIND.rep.bg, it.text,
      `${whenLabel(it)}\n${it.repeat.until ? `⏹️ נעצר לבד אחרי ${+it.repeat.until.slice(8)}.${+it.repeat.until.slice(5, 7)}${st?.total ? ` (${st.total} מנות)` : ''}` : '♾️ ללא סוף'}\n${it.med ? 'בכל פעם תגיע תזכורת עם "✅ לקחתי". לא אישרת? אזכיר שוב אחרי 10 דקות' : 'אזכיר בכל פעם'}${it.med ? '\n🕯️ גם בשבת (אפשר לשנות)' : ''}`,
      [{ l: '🔁 הקבועים שלי', op: 'recurList', a: [] }, { l: '✏️ לשנות', op: 'recur', a: [it.id] }, undo]);
  }
  const k = it.repeat ? KIND.rep : KIND.task;
  const how = !it.due ? 'בלי תאריך · נמצא במסך המשימות'
    : it.hasTime ? `${whenLabel(it)}${extra ? ' · ' + extra : ''}\nכשיגיע הזמן אשאל אותך אם עשית את זה`
    : `${whenLabel(it)}\nאשאל עליו בסיכום הערב`;
  const acts = [assign, edit, undo];
  if (!it.due || isToday(it.due)) acts.unshift({ l: '⭐ לחשובים של היום', op: 'star', a: [it.id] });
  return bot(k.ic, k.bg, it.text, how, acts);
}

async function doneReport(p) {
  const cands = tasksOpen().concat(openItems().filter(x => x.kind === 'thought'));
  if (!p.text) {
    if (S.pending && item(S.pending)) return markDone(S.pending);
    return askWhich('', 'מה סיימת? 🙂');
  }
  const scored = cands.map(it => ({ it, s: matchScore(p.text, it.text) })).sort((a, b) => b.s - a.s);
  const [a, b] = scored;
  if (a && a.s >= 0.5 && (!b || a.s - b.s >= 0.12 || a.s >= 0.85)) return markDone(a.it.id);
  const close = scored.filter(x => x.s >= 0.3).slice(0, 3);
  if (close.length) return askWhich(p.text, 'התכוונת לאחת מאלה?', close.map(x => x.it));
  // לא נמצאה משימה מתאימה — רושמים כדבר שנעשה
  const it = { id: db.newId(), kind: 'task', text: p.text, due: null, hasTime: false, repeat: null, status: 'done', created: new Date().toISOString(), doneAt: new Date().toISOString() };
  if (p.verb) it.text = p.text;
  S.items.push(it); await save(it); await addLog(it, 'done'); renderAll();
  confetti(50);
  return bot('🙌', 'var(--g3)', 'יפה! רשמתי שעשית את זה', it.text, p.verb ? [{ l: '↩️ זה לא דיווח, שמור כמחשבה', op: 'undoLogged', a: [it.id] }] : [{ l: '↩️ בטל', op: 'undo', a: [it.id] }]);
}

async function askWhich(text, title, list) {
  list = list || rankForToday(tasksOpen()).slice(0, 4);
  if (!list.length) return bot('🤔', 'var(--card2)', 'אין כרגע משימות פתוחות', 'כתוב לי מה צריך לעשות, ואני ארשום');
  const acts = list.map(it => ({ l: '✅ ' + it.text, op: 'matchDone', a: [it.id] }));
  if (text) acts.push({ l: 'משהו אחר, רק לרשום', op: 'logDone', a: [text] });
  return bot('🤔', 'var(--card2)', title, text ? `"${text}"` : '', acts);
}

// ---------- מעקב: שאלות "עשית?" כשמגיע הזמן ----------
// ---------- 💊 קבועים ותרופות ----------
const whenLabel1 = it => whenLabel({ due: it.due, hasTime: true });
const NAG_MIN = 10, NAG_MAX = 2;
async function finishedMsg(it) {
  const st = doseStats(it);
  await bot('🎉', 'var(--g3)', it.med ? `🎉 סיימת את הטיפול: ${it.text}` : `🏁 הסתיים: ${it.text}`,
    `${it.med && st ? `לקחת ${st.taken} מתוך ${st.total ?? st.expected} מנות. ` : ''}התזכורת נעצרה לבד, לא צריך לבטל כלום 💚`, [{ l: '🔁 להמשיך עוד', op: 'recur', a: [it.id] }]);
  await bell('🎉', it.med ? 'סיימת את הטיפול' : 'קבוע הסתיים', it.text, { item: it.id }, 'end:' + it.id);
}
// מנה שלא סומנה לא תוקעת את הבאה, וקבוע שעבר את התאריך האחרון נעצר לבד
async function advanceRepeats() {
  const now = new Date();
  for (const it of S.items.filter(x => x.status === 'open' && x.repeat && x.due)) {
    if (it.repeat.until && sod(now) > sod(new Date(it.repeat.until + 'T00:00'))) {
      it.status = 'done'; it.doneAt = now.toISOString(); it.ended = true; await save(it); await finishedMsg(it); continue;
    }
    if (!it.med) continue;
    let d = new Date(it.due), moved = false;
    for (let i = 0; i < 50; i++) { const nx = nextOccurrence(it.repeat, d.getHours(), d.getMinutes(), d); if (!nx || nx > now) break; d = nx; moved = true; }
    if (moved) { it.due = d.toISOString(); it.askAt = null; it.askedKey = null; it.nag = 0; await save(it); }
  }
}
// "💊 הגיע הזמן" — ואם לא אישרו, שוב אחרי 10 דקות (עד פעמיים)
async function medPrompts(list) {
  const now = new Date();
  for (const it of list) {
    const t = new Date(it.askAt || it.due); if (!it.due || t > now || it.askedKey === String(+t)) continue;
    if (now - new Date(it.due) > 3 * 3600e3) continue; // מנה ישנה מדי — לא מציקים
    it.askedKey = String(+t);
    if ((it.nag || 0) < NAG_MAX) { it.nag = (it.nag || 0) + 1; it.askAt = new Date(+now + NAG_MIN * 60e3).toISOString(); } else it.askAt = null;
    await save(it);
    const st = doseStats(it);
    await bot('💊', 'linear-gradient(135deg,#14B8A6,#22C55E)', `💊 ${it.text}`, `${it.nag > 1 ? 'תזכורת שוב: ' : ''}הגיע הזמן (${hm(new Date(it.due))}). לקחת?${st?.daysLeft != null ? `\nנשארו ${st.daysLeft} ימים` : ''}`, [
      { l: '✅ לקחתי', op: 'done', a: [it.id], pri: true }, { l: `⏰ עוד ${NAG_MIN} דקות`, op: 'snoozeMed', a: [it.id] }, { l: '⏭️ דילגתי', op: 'skipDose', a: [it.id] }]);
    buzz(Z.quietAt(Date.now()));
  }
}
async function skipDose(id) {
  const it = item(id); if (!it?.repeat) return; const d = new Date(it.due);
  it.due = nextOccurrence(it.repeat, d.getHours(), d.getMinutes(), new Date(Math.max(Date.now(), +d)))?.toISOString() || null;
  it.askAt = null; it.askedKey = null; it.nag = 0;
  if (!it.due && it.repeat.until) { it.status = 'done'; it.ended = true; it.doneAt = new Date().toISOString(); await save(it); return finishedMsg(it); }
  await save(it); renderAll(); toast(`⏭️ דילגת. הבאה: ${it.due ? whenLabel1(it) : '—'}`);
}
// מההתראה בטלפון: ?take=ID&at=… (לחצו "✅ לקחתי") או ?dose=ID (לחצו על ההתראה)
async function doseLink(kind, id, at) {
  const it = item(id); if (!it) return;
  if (kind === 'take') {
    if (!at || at === it.due || new Date(at) >= new Date(it.due)) await markDone(id, true);
    else { it.doses = { ...(it.doses || {}), [at]: new Date().toISOString() }; await save(it); }
    const st = doseStats(item(id) || it); toast(`💊 נרשם שלקחת${st ? ` · ${st.taken}/${st.expected}` : ''}`); renderAll();
  } else { showView('chat'); it.askedKey = null; it.askAt = null; await medPrompts([it]); }
}
let following = false;
async function followUps(medOnly) {
  if (following) return; following = true;
  try {
    const now = new Date();
    await advanceRepeats();
    // 🕯️ בשבת/חג (medOnly): רק מה שסומן "גם בשבת ובחג"
    const ok = x => !medOnly || x.shabbatOk;
    if (!medOnly) await closePastEvents();
    for (const it of tasksOpen().filter(x => x.kind === 'meeting' && x.hasTime && x.due && ok(x))) {
      const d = new Date(it.due), key = 'pre:' + it.due;
      if (d > now && d - now <= 30 * 60e3 && it.askedKey !== key) {
        it.askedKey = key; await save(it);
        await bot('🔔', 'var(--g5)', `בעוד ${Math.max(1, Math.round((d - now) / 60e3))} דקות: ${it.text}`, `ב-${hm(d)}`);
        buzz();
      }
    }
    await medPrompts(tasksOpen().filter(x => x.med && ok(x)));
    const due = tasksOpen().filter(x => {
      if (x.event || x.med || !ok(x)) return false; // אירוע ביומן — לא שואלים "עשית?"; תרופות — למעלה
      const t = x.askAt || (x.hasTime && x.due);
      return t && new Date(t) <= now && x.askedKey !== String(t);
    }).sort((a, b) => new Date(a.askAt || a.due) - new Date(b.askAt || b.due)).slice(0, 3);
    for (const it of due) {
      const t = it.askAt || it.due;
      it.askedKey = String(t); await save(it);
      S.pending = it.id;
      if (it.kind === 'meeting') {
        await bot('👥', 'var(--g5)', `${it.text}`, `הפגישה הייתה ב-${hm(new Date(it.due))}. היא התקיימה?`, [
          { l: '✅ כן', op: 'done', a: [it.id], pri: true }, { l: '⏰ נדחתה', op: 'snoozeAsk', a: [it.id] }, { l: '🗑️ בוטלה', op: 'remove', a: [it.id] }]);
      } else {
        await bot(it.repeat ? '🔁' : '⏰', 'var(--g4)', `${it.text}?`, `הגיע הזמן (${hm(new Date(t))}). עשית את זה?`, [
          { l: '✅ כן, עשיתי', op: 'done', a: [it.id], pri: true }, { l: '⏰ עוד לא', op: 'snoozeAsk', a: [it.id] }, { l: '⏱️ פוקוס', op: 'focus', a: [it.id] },
          { l: '✏️ תקן', op: 'edit', a: [it.id] }, { l: '🗑️ כבר לא רלוונטי', op: 'remove', a: [it.id] }]);
      }
      buzz();
    }
  } finally { following = false; }
}
function buzz(silent) { if (!silent && !Z.quietAt(Date.now())) Z.play(S.settings.melody); try { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(80); } catch { /* */ } if (document.hidden) document.title = '🔔 זמן בכיף'; }

// ---------- סיכומי בוקר וערב ----------
const minutes = s => { const [h, m] = (s || '0:0').split(':').map(Number); return h * 60 + m; };
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };

function rankForToday(list) {
  const t0 = sod(new Date()), t1 = addDays(t0, 1);
  const score = x => {
    if (!x.due) return 3e13;
    const d = new Date(x.due);
    if (d < t0) return d.getTime() - 1e13;          // באיחור — קודם
    if (d < t1) return d.getTime();                 // היום
    return d.getTime() + 1e13;                      // בהמשך
  };
  return [...list].sort((a, b) => score(a) - score(b));
}
const dueToday = x => x.due && new Date(x.due) < addDays(sod(new Date()), 1);
const overdueDays = x => x.due && new Date(x.due) < sod(new Date());

async function morning(force) {
  if (!force && (await db.getKV('lastMorning', '')) === today()) return;
  await db.setKV('lastMorning', today());
  const list = tasksOpen().filter(x => dueToday(x) && !overdueDays(x));
  const meets = list.filter(x => x.kind === 'meeting'), tasks = list.filter(x => x.kind !== 'meeting');
  const first = rankForToday(list.filter(x => x.hasTime))[0];
  let sub = !list.length ? 'אין עדיין משהו מתוכנן להיום.'
    : `היום יש לך ${meets.length ? `${meets.length === 1 ? 'פגישה אחת' : meets.length + ' פגישות'} ו-` : ''}${tasks.length === 1 ? 'משימה אחת' : tasks.length + ' משימות'}.`;
  if (first) sub += `\nהראשון: ${hm(new Date(first.due))} ${first.text}`;
  const left = tasksOpen().filter(x => overdueDays(x) && !x.repeat);
  const acts = left.length ? [{ l: `לעבור על ${left.length} שנשארו`, op: 'reviewLeftovers', pri: true }] : null;
  if (left.length) sub += `\nונשארו ${left.length === 1 ? 'משימה אחת' : left.length + ' משימות'} מימים קודמים.`;
  await bot('☀️', 'var(--g4)', greet(), sub, acts);

  const t3 = S.top3?.date === today() ? S.top3 : null;
  if (!t3 || !t3.ids.length) {
    const cand = rankForToday(tasksOpen().filter(x => x.kind === 'task' && (!x.due || dueToday(x)))).slice(0, 3);
    if (cand.length) {
      await bot('⭐', 'var(--g1)', 'אלה החשובים של היום?', cand.map((x, i) => `${i + 1}. ${x.text}`).join('\n'),
        [{ l: '👍 מתאים', op: 'top3ok', a: [cand.map(x => x.id)], pri: true }, { l: '✏️ לבחור אחרים', op: 'pickTop3' }]);
    } else {
      await bot('⭐', 'var(--g1)', 'מה הכי חשוב לך היום?', 'כתוב לי מה חשוב היום, ואז לחץ ⭐ כדי לשים אותם למעלה');
    }
  }
}
function greet() { const h = new Date().getHours(); return h < 12 ? 'בוקר טוב!' : h < 17 ? 'צהריים טובים!' : 'ערב טוב!'; }

async function evening(force) {
  if (!force && (await db.getKV('lastEvening', '')) === today()) return;
  await db.setKV('lastEvening', today());
  const doneN = S.log.filter(l => l.action === 'done' && isToday(l.ts)).length;
  const open = rankForToday(tasksOpen().filter(dueToday));
  if (!force && !doneN && !open.length) return; // אין מה לסכם
  let sub = doneN ? `סיימת היום ${doneN === 1 ? 'משימה אחת' : doneN + ' משימות'} 🎉` : 'היום עוד לא סומנו משימות כבוצעות.';
  sub += open.length === 1 ? '\nנשארה משימה אחת פתוחה. בוא נחליט מה עושים איתה. שום דבר לא עובר לבד.'
    : open.length ? `\nנשארו ${open.length} משימות פתוחות. בוא נחליט מה עושים עם כל אחת. שום דבר לא עובר לבד.` : '\nאין משימות פתוחות. לילה טוב! 🌙';
  await bot('🌙', 'var(--g5)', 'סיכום היום', sub);
  if (doneN) confetti(40);
  await reviewOpen('evening', open);
}

async function reviewOpen(mode, list) {
  list = list || rankForToday(tasksOpen().filter(x => mode === 'leftovers' ? overdueDays(x) && !x.repeat : dueToday(x)));
  if (!list.length) return mode === 'leftovers' && bot('👍', 'var(--g3)', 'אין משימות שנשארו', '');
  for (const it of list.slice(0, 6)) {
    it.askedKey = String(it.askAt || it.due); await save(it);
    const acts = it.repeat
      ? [{ l: '✅ עשיתי', op: 'done', a: [it.id], pri: true }, { l: '⏭️ דלג הפעם', op: 'skipOnce', a: [it.id] }, { l: '✏️ תקן', op: 'edit', a: [it.id] }]
      : [{ l: '✅ בעצם עשיתי', op: 'done', a: [it.id], pri: true }, { l: '➡️ למחר', op: 'snooze', a: [it.id, 'tomorrow'] },
        { l: '📅 תאריך אחר', op: 'edit', a: [it.id, 'date'] }, { l: '💭 למחשבות', op: 'toThought', a: [it.id] }, { l: '🗑️ למחוק', op: 'remove', a: [it.id] }];
    await bot(it.kind === 'meeting' ? '👥' : it.repeat ? '🔁' : '📌', 'var(--card2)', it.text, whenLabel(it), acts);
  }
  if (list.length > 6) await bot('📋', 'var(--card2)', `ועוד ${list.length - 6} במסך המשימות`, '', [{ l: 'למסך המשימות', op: 'goto', a: ['tasks'] }]);
}

async function query(day) {
  const t0 = sod(new Date()), from = day === 'tomorrow' ? addDays(t0, 1) : t0, to = day === 'week' ? addDays(t0, 7) : addDays(from, 1);
  const list = rankForToday(tasksOpen().filter(x => x.due && new Date(x.due) >= from && new Date(x.due) < to));
  const late = day === 'today' ? tasksOpen().filter(overdueDays) : [];
  const name = day === 'tomorrow' ? 'מחר' : day === 'week' ? 'השבוע' : 'היום';
  const ext = S.ext.filter(x => new Date(x.due) >= from && new Date(x.due) < to);
  if (!list.length && !late.length && !ext.length) return bot('📋', 'var(--g2)', `${name} אין שום דבר מתוכנן`, 'כתוב לי מה תרצה להוסיף');
  const line = x => `${x.hasTime ? hm(new Date(x.due)) : '•'} ${x.kind === 'meeting' ? '👥 ' : ''}${x.text}${day === 'week' ? ` (${whenLabel(x).split(' ב-')[0]})` : ''}`;
  // מה שמהיומן נכנס לפי השעה, עם "📅 … · מהיומן"
  const tOf = x => x.hasTime ? +new Date(x.due) : +sod(new Date(x.due));
  const all = list.map(x => [x, 0]);
  for (const x of ext) { const i = all.findIndex(([y]) => tOf(y) > tOf(x)); all.splice(i < 0 ? all.length : i, 0, [x, 1]); }
  let sub = all.map(([x, e]) => e ? `${x.hasTime ? hm(new Date(x.due)) : '•'} 📅 ${x.text}${day === 'week' ? ` (${whenLabel(x).split(' ב-')[0]})` : ''} · מהיומן` : line(x)).join('\n');
  if (late.length) sub += `${sub ? '\n' : ''}⚠️ באיחור: ${late.map(x => x.text).join(', ')}`;
  return bot('📋', 'var(--g2)', `מה יש ${name}`, sub, [{ l: 'למסך המשימות', op: 'goto', a: ['tasks'] }]);
}

// ---------- משוב: מגיע ישר למייל של מוישי ----------
const FEEDBACK_TO = 'mvindish@gmail.com';            // רק לגיבוי (mailto) כשאין רשת
const FEEDBACK_FORM = 'afe845b5ff6d0c2cd899d08390663e7c'; // הכינוי של FormSubmit — המייל לא מופיע בבקשה
const FEEDBACK_RE = /^(משוב|פידבק|הערה|הערות|הצעה|הצעת שיפור|יש לי הערה|יש לי הצעה|רעיון לאפליקציה|יש לי רעיון לאפליקציה|באג|תקלה|בעיה באפליקציה|דיווח|feedback)(?=[\s:,-]|$)[\s:,-]*/i;
const FKINDS = { idea: '💡 רעיון', bug: '🐞 משהו לא עובד', love: '❤️ מחמאה', other: '💬 אחר' };
function openFeedback(text = '', hint = text) {
  let kind = /באג|תקלה|בעיה|לא עובד/.test(hint) ? 'bug' : /רעיון|הצעה|שיפור/.test(hint) ? 'idea' : /תודה|מעולה|אוהב|כל הכבוד|מדהים/.test(hint) ? 'love' : 'other';
  const me = person(S.myP);
  sheet(`<h3>💌 שליחת משוב</h3>
    <p class="note" style="margin-bottom:12px">כל הערה, רעיון או תקלה מגיעים ישירות למוישי — ועוזרים לשפר את האפליקציה 🙏</p>
    <div class="chips" style="flex-wrap:wrap;padding:0 0 12px">${Object.entries(FKINDS).map(([k, n]) => `<button class="chip ${k === kind ? 'on' : ''}" data-fk="${k}">${n}</button>`).join('')}</div>
    <textarea id="fMsg" rows="5" placeholder="מה תרצו לספר? למשל: היה נחמד אם…" class="fb-txt">${esc(text)}</textarea>
    <label>איך לחזור אליך (לא חובה)</label><input id="fContact" value="${esc([me?.name, sync.user()?.email].filter(Boolean).join(' · '))}" placeholder="שם / טלפון / מייל">
    <label class="set-row" style="cursor:pointer;border:none"><span>לצרף פרטי מכשיר (עוזר לתקן תקלות)</span><input type="checkbox" id="fDev" checked></label>
    <div id="fErr" style="color:#FB7185;font-size:13px;min-height:16px"></div>
    <button class="btn pri" id="fSend">📨 שליחה</button>`);
  $('#sheet').querySelectorAll('[data-fk]').forEach(b => b.onclick = () => { kind = b.dataset.fk; $('#sheet').querySelectorAll('[data-fk]').forEach(x => x.classList.toggle('on', x === b)); });
  $('#fMsg').oninput = () => $('#fErr').textContent = '';
  $('#fSend').onclick = async e => {
    const message = $('#fMsg').value.trim();
    if (message.length < 2) return $('#fErr').textContent = 'צריך לכתוב משהו 🙂';
    const contact = $('#fContact').value.trim();
    const device = $('#fDev').checked
      ? `${navigator.userAgent.match(/iPhone|iPad|Android[^;)]*|Mac|Windows/)?.[0] || 'מכשיר'} · ${screen.width}×${screen.height} · ${isStandalone() ? 'מותקנת' : 'דפדפן'} · קבוצות: ${sync.myGroups().length}`
      : '';
    e.target.disabled = true; e.target.textContent = 'שולח…';
    const cloud = sync.saveFeedbackAny({ kind, message, contact, device });
    let mailed = false;
    try {
      const r = await fetch(`https://formsubmit.co/ajax/${FEEDBACK_FORM}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _subject: `💌 משוב חדש — זמן בכיף (${FKINDS[kind]})`, _template: 'table', _captcha: 'false',
          'אפליקציה': 'זמן בכיף ⏰', 'סוג': FKINDS[kind], 'משוב': message, 'פרטים לחזרה': contact || '—', 'מכשיר': device || '—' }),
      });
      mailed = await formOk(r);
    } catch { mailed = false; }
    const saved = await cloud;
    if (mailed || saved) { closeSheet(); confetti(); toast('💌 תודה! המשוב נשלח'); return; }
    e.target.disabled = false; e.target.textContent = '📨 שליחה';
    sync.fail('feedback', 'feedback form not sent');
    $('#fErr').innerHTML = `לא הצלחתי לשלוח (אין אינטרנט?). אפשר <a href="mailto:${FEEDBACK_TO}?subject=${encodeURIComponent('משוב — זמן בכיף')}&body=${encodeURIComponent(message)}" style="color:#F9A8D4">לשלוח במייל רגיל</a>`;
  };
}

// 🚪 הוציאו אותי מקבוצה (או שיצאתי): כל מה ששייך לקבוצה נמחק מהטלפון הזה
async function removedFromGroups(gone) {
  const lost = [];
  for (const g of gone) {
    const mine = S.items.filter(x => x.group_id === g.id);
    for (const it of mine) await db.del('items', it.id);
    S.items = S.items.filter(x => x.group_id !== g.id);
    const box = (await db.getKV('outbox', [])).filter(o => mine.every(it => it.id !== o.id)); await db.setKV('outbox', box);
    if (S.settings.defGroup === g.id) { S.settings.defGroup = null; await db.setKV('settings', S.settings); }
    if (g.self) toast(`🚪 יצאת מ"${g.name}"`);
    else if (!sync.myGroups().length) { lost.push(g.name); continue; }
    else {
      await bot('🚪', 'linear-gradient(135deg,#64748B,#334155)', `הוצאת מהקבוצה "${g.name || ''}"`, `מנהל הקבוצה הסיר אותך. כל מה ששייך לקבוצה (${mine.length} פריטים) נמחק מהטלפון הזה.`);
      await bell('🚪', `הוצאת מ"${g.name || 'קבוצה'}"`, 'מה ששייך לקבוצה נמחק מהטלפון', null, 'gone:' + g.id);
    }
  }
  if (lost.length) return startOver(lost.filter(Boolean).map(n => `"${n}"`).join(' ו'));
  buildPeople(); renderAll(); renderFamily();
}
// 🚪 הוסרתי מהקבוצה האחרונה: מתחילים מחדש כמו משתמש חדש. נשארים רק החשבון והמשימות הפרטיות שלי
async function startOver(names) {
  for (const it of S.items.filter(x => x.group_id || (x.by && x.by !== S.uid))) await db.del('items', it.id);
  S.items = S.items.filter(x => !x.group_id && (!x.by || x.by === S.uid));
  for (const m of S.msgs) await db.del('msgs', m.id);
  S.msgs = []; S.bell = []; S.top3 = null;
  for (const k of ['bell', 'top3', 'welcomed2:' + S.uid, 'sched']) await db.setKV(k, null);
  drawBellBadge(); buildPeople(); renderAll(); renderChat(); renderFamily();
  const gate = $('#gate'), body = $('#gateBody');
  gate.classList.add('on');
  body.innerHTML = `<div class="g-logo">🚪</div><h2>הוסרת מהקבוצה</h2>
    <p class="note">הוסרת מ${esc(names || 'הקבוצה')}, ומה ששייך ${names?.includes('" ו"') ? 'לקבוצות' : 'לקבוצה'} נמחק מהטלפון הזה. החשבון שלך והמשימות הפרטיות שלך נשארו.<br>מה עכשיו?</p>
    <button class="btn pri" id="soNew">➕ לפתוח קבוצה חדשה</button>
    <button class="btn" id="soJoin">🔑 להצטרף לקבוצה עם קוד</button>
    <button class="link" id="soSolo">🙋 להמשיך לבד בינתיים</button>`;
  const next = async fn => { gate.classList.remove('on'); if (fn) fn(); else { S.restart = false; showView('chat'); await welcomeMe(); openEditMe(); } };
  $('#soNew').onclick = () => next(openNewGroup);
  $('#soJoin').onclick = () => next(openJoin);
  $('#soSolo').onclick = () => next(null);
  S.restart = true; // אחרי הקבוצה / השם — שוב ההיכרות של ההתחלה
}
// 🎭 מצב הדגמה — רק למנהל האפליקציה. ההערות נשלחות במייל אחד (FormSubmit, לא דרך הענן שלנו)
async function drawDemoCard() {
  const el = $('#demoCard'); if (!el) return;
  if (!demo.DEMO && !(await sync.isAppAdmin())) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = demo.DEMO
    ? `<h4>🎭 מצב הדגמה <small>פועל</small></h4><p class="note">הנתונים כאן מזויפים, ושום דבר לא נשמר בענן. ביציאה חוזרים הנתונים האמיתיים בדיוק כמו שהיו.</p>
       <div class="two"><button class="btn pri" id="dmTour" style="margin:0">🧭 סיור</button><button class="btn" id="dmOut" style="margin:0">יציאה מההדגמה</button></div>`
    : `<h4>🛠️ למנהל האפליקציה <small>רק לך</small></h4><p class="note">משפחה מזויפת שממלאת כל מסך, סיור מודרך על כל האפשרויות, וכפתור 💬 שאוסף הערות ושולח הכל בבת אחת. הנתונים האמיתיים לא נפגעים.</p>
       <button class="btn pri" id="dmIn">🎭 להיכנס למצב הדגמה</button>
       <a class="btn" href="https://kesefbekef.github.io/admin/" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;text-decoration:none">📊 לוח בקרה: מי מתקין ומשתמש (כל האפליקציות)</a>
       <p class="note">נפתח בכסף בכיף. אם צריך — נכנסים שם עם אותו מייל וסיסמה.</p>`;
  $('#dmIn')?.addEventListener('click', () => demo.enter());
  $('#dmTour')?.addEventListener('click', () => demo.startTour(0));
  $('#dmOut')?.addEventListener('click', () => demo.exit());
}
// FormSubmit עונה 200 גם כשלא נשלח (למשל טופס שעוד לא הופעל) — בודקים success באמת
async function formOk(r) { if (!r.ok) return false; try { const j = await r.json(); return j.success === true || j.success === 'true'; } catch { return false; } }
// ההערות נשמרות גם בטבלת המשוב בענן וגם במייל. נמחקות מהטלפון רק אם לפחות אחד מהם הצליח באמת
// o = { label, kind, subject }: לסיור התיקונים. בלי o: הערות מצב הדגמה
async function sendDemoNotes(text, n, o = null) {
  const label = o?.label || 'הערות מצב הדגמה', subject = o?.subject || `📝 ${label} — זמן בכיף (${n})`;
  const cloud = sync.saveFeedbackAny({ kind: o?.kind || 'idea', message: `[${label}] (${n})\n\n${text}`.slice(0, 4900), contact: sync.user()?.email && !demo.DEMO ? sync.user().email : '', device: `${navigator.userAgent.match(/iPhone|iPad|Android[^;)]*|Mac|Windows/)?.[0] || ''} · ${screen.width}×${screen.height}` });
  let mailed = false;
  try {
    const r = await fetch(`https://formsubmit.co/ajax/${FEEDBACK_FORM}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ _subject: subject, _template: 'box', _captcha: 'false', 'אפליקציה': 'זמן בכיף ⏰', 'סוג': label, 'הערות': text }),
    });
    mailed = await formOk(r);
  } catch { mailed = false; }
  const ok = (await cloud) || mailed; if (!ok) sync.fail('feedback', `${o?.label || 'demo notes'} not sent`); return ok;
}

// ---------- עזרה: שאלות ותשובות בחלון נפרד ----------
async function shareApp() {
  try {
    if (navigator.share) { await navigator.share({ title: 'זמן בכיף', text: help.SHARE_TEXT.replace(help.SHARE_URL, '').trim(), url: help.SHARE_URL }); return; }
    await navigator.clipboard.writeText(help.SHARE_TEXT); toast('🔗 הקישור הועתק — אפשר להדביק לחבר');
  } catch (e) { if (e.name !== 'AbortError') toast('🔗 ' + help.SHARE_URL); }
}
function openHelp(question = '', showGuide = false) {
  const kid = !sync.isParent() && sync.myGroups().length > 0;
  const topics = help.TOPICS.filter(t => !kid || !['roles', 'add'].includes(t.id));
  sheet(`<h3>❓ עזרה</h3>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input id="hQ" placeholder="שאל אותי, למשל: איך מוסיפים את אשתי?" style="flex:1;min-width:0" enterkeyhint="send">
      <button class="act pri" id="hAsk" style="padding:0 16px">שאל</button></div>
    <div id="hAns" class="chat" style="padding:0;margin-bottom:12px;gap:8px"></div>
    <div id="hGuide"></div>
    <div style="display:flex;gap:8px;margin-bottom:12px"><button class="btn" id="hOpenGuide" style="flex:2;margin-top:0">📖 המדריך המלא</button><button class="btn news-btn" id="hNews" style="flex:1;margin-top:0">✨ מה חדש</button></div>
    <p class="note" style="margin-bottom:6px">שאלות נפוצות:</p>
    <div class="chips" style="flex-wrap:wrap;padding:0 0 12px">${topics.map(t => `<button class="chip" data-topic="${t.id}">${t.t}</button>`).join('')}</div>
    <button class="btn" id="hFeedback" style="margin-bottom:10px">💌 שליחת משוב / דיווח על תקלה</button>
    <p class="note" style="text-align:center">עדיין תקוע? מוישי וינדיש · <a href="tel:0542964361" style="color:#F9A8D4">054-2964361</a> · <a href="mailto:mvindish@gmail.com" style="color:#F9A8D4">mvindish@gmail.com</a></p>`);
  const box = $('#hAns');
  const bubble = (cls, html) => {
    const d = document.createElement('div'); d.className = cls + ' new'; d.innerHTML = html; d.style.maxWidth = '100%'; box.appendChild(d);
    d.querySelector('[data-share-app]')?.addEventListener('click', shareApp);
    d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return d;
  };
  const answerHtml = t => `<div><b>${t.t}</b><div class="sub" style="margin-top:6px;line-height:1.6;color:#fff">${t.a}</div></div>`;
  const showGuideFrame = () => {
    $('#hGuide').innerHTML = `<iframe src="guide/" title="המדריך" style="width:100%;height:65vh;border:0;border-radius:18px;margin-bottom:12px;background:#FBF8FF"></iframe>`;
    $('#hOpenGuide').style.display = 'none';
    $('#hGuide').scrollIntoView({ behavior: 'smooth' });
  };
  const ask = q => {
    q = q.trim(); if (!q) return;
    bubble('me', esc(q));
    const found = help.answer(q).filter(t => topics.includes(t));
    if (found.length) found.forEach(t => bubble('bot', answerHtml(t)));
    else {
      const b = bubble('bot', `<div><b>🤔 לא בטוח שהבנתי</b><div class="sub" style="margin-top:4px">רצית לראות את ההוראות? או לבחור נושא למטה 👇</div>
        <div class="acts"><button class="act pri" data-g="1">📖 כן, פתח את המדריך</button></div></div>`);
      b.querySelector('[data-g]').onclick = showGuideFrame;
    }
    $('#hQ').value = '';
  };
  $('#hAsk').onclick = () => ask($('#hQ').value);
  $('#hQ').addEventListener('keydown', e => { if (e.key === 'Enter') ask(e.target.value); });
  $('#hOpenGuide').onclick = showGuideFrame;
  $('#hNews').onclick = () => openNews(true);
  $('#hFeedback').onclick = () => openFeedback();
  $('#sheet').querySelectorAll('[data-topic]').forEach(c => c.onclick = () => {
    const t = help.TOPICS.find(x => x.id === c.dataset.topic);
    bubble('me', esc(t.t.replace(/^\S+\s/, ''))); bubble('bot', answerHtml(t));
  });
  if (showGuide) showGuideFrame(); else if (question) ask(question);
}


// ---------- התראות לטלפון ----------
const APP_URL = './';
// בשבת/חג — ההתראה נדחית לצאת השבת
const outOfQuiet = t => { const w = Z.quietAt(t); return w ? new Date(+new Date(w.end) + 60e3) : new Date(t); };
async function queueNotify(toUid, cat, title, body, ref) {
  if (!toUid || !S.uid) return;
  await sync.upsertNotify([{ id: `${toUid}:${cat}:${ref}:${Date.now()}`, to_uid: toUid, at: outOfQuiet(Date.now()).toISOString(), cat, title, body: (body || '').slice(0, 300), url: APP_URL }]);
}
// מה צריך לקפוץ לי בטלפון בשבועיים הקרובים: "עשית?", פגישות, שבת, סיכומים
function desiredSchedule() {
  const uid = S.uid, now = Date.now(), until = now + 14 * 864e5, out = [];
  const add = (key, at, cat, title, body, shab) => { if (+at > now && +at < until) out.push({ id: `${uid}:${key}`, to_uid: uid, at: (shab ? new Date(at) : outOfQuiet(at)).toISOString(), cat, title, body, url: APP_URL }); };
  // 💊 תרופות: כל המנות של 4 הימים הקרובים, וכל אחת עוד פעמיים אחרי 10 דקות. "גם בשבת" — בלי לדחות
  for (const it of tasksOpen().filter(x => x.med && x.repeat && x.due)) {
    let t = new Date(+new Date(it.due) - 1);
    for (let i = 0; i < 40; i++) {
      const d = nextOccurrence(it.repeat, 9, 0, t); if (!d || +d > now + 4 * 864e5) break; t = d;
      if (it.doses?.[d.toISOString()]) continue;
      for (let k = 0; k <= NAG_MAX; k++) {
        const at = new Date(+d + k * NAG_MIN * 60e3); if (+at <= now) continue;
        out.push({ id: `${uid}:med:${it.id}:${+d}:${k}`, to_uid: uid, at: (it.shabbatOk ? at : outOfQuiet(at)).toISOString(), cat: 'med', title: `💊 ${k ? 'תזכורת שוב: ' : ''}${it.text}`, body: `${hm(d)} · לחצו "✅ לקחתי"`, url: `${APP_URL}?dose=${encodeURIComponent(it.id)}&at=${encodeURIComponent(d.toISOString())}` });
      }
    }
  }
  for (const it of tasksOpen()) {
    if (!it.due || !it.hasTime || it.med) continue;
    const t = new Date(it.askAt || it.due);
    if (it.kind === 'meeting') add(`pre:${it.id}`, new Date(+t - 30 * 60e3), 'task', `🔔 בעוד חצי שעה: ${it.text}`, `ב-${hm(t)}${it.place ? ' · ' + it.place : ''}`, it.shabbatOk);
    else add(`task:${it.id}`, t, 'task', `⏰ ${it.text}`, 'הגיע הזמן. עשית את זה?', it.shabbatOk);
  }
  for (const w of Z.windows().filter(w => +new Date(w.start) > now).slice(0, 3))
    for (const off of S.settings.shabbatAlerts || [])
      add(`sh:${w.start}:${off}`, new Date(+new Date(w.start) - off * 60e3), 'shabbat', `🕯️ עוד ${durLbl(off)} ${w.name === 'שבת' ? 'נכנסת שבת' : 'נכנס ' + w.name}`, `הדלקת נרות ב-${hm(new Date(w.start))}`);
  for (let i = 0; i < 7; i++) {
    const d = addDays(sod(new Date()), i), at = (hhmm) => { const [h, m] = hhmm.split(':'); const x = new Date(d); x.setHours(+h, +m, 0, 0); return x; };
    const am = at(S.settings.morning), pm = at(S.settings.evening);
    if (!Z.quietAt(am)) add(`am:${ymd(d)}`, am, 'summary', '☀️ בוקר טוב!', 'בוא נראה מה יש היום ונבחר את החשובים');
    if (!Z.quietAt(pm)) add(`pm:${ymd(d)}`, pm, 'summary', '🌙 סיכום היום', 'בוא נסגור את היום: מה הספקת ומה עובר למחר');
  }
  return out;
}
let schedBusy = false;
async function syncSchedule() {
  if (schedBusy || !S.uid || !navigator.onLine) return;
  schedBusy = true;
  try {
    const want = desiredSchedule(), had = await db.getKV('sched', {});
    const sig = r => `${r.at}|${r.title}|${r.body}`;
    const changed = want.filter(r => had[r.id] !== sig(r));
    const gone = Object.keys(had).filter(id => !want.some(r => r.id === id));
    if (changed.length && !(await sync.upsertNotify(changed))) { sync.fail('reminder', `schedule upsert failed (${changed.length})`); return; }
    const removed = gone.filter(id => { const at = had[id]?.split('|')[0]; return !at || new Date(at) > new Date(); });
    if (removed.length) await sync.deleteNotify(removed);
    const next = {}; for (const r of want) next[r.id] = sig(r);
    await db.setKV('sched', next);
  } finally { schedBusy = false; }
}

// כרטיס ההגדרות
const PUSH_CATS = [['msg', '💬 הודעות ותגובות'], ['task', '⏰ הגיע הזמן של משימה'], ['med', '💊 תרופות וקבועים'], ['conflict', '⚠️ התנגשות'], ['share', '📥 שיתפו איתי / נתנו לי משימה'], ['group', '📎 שיוך לקבוצה'],
  ['bump', '🔔 הקפצות'], ['comment', '💬 תגובות על משימות'], ['done', '✅ מישהו סיים משימה שנתתי'], ['join', '👥 מצטרף חדש לקבוצה'], ['summary', '☀️🌙 סיכומים'], ['shabbat', '🕯️ שבת וחג']];
function drawMonthly() {
  const el = $('#monthlyRow'); if (!el) return;
  if (!S.uid) { el.innerHTML = '<p class="note" style="margin-top:8px">📧 אחרי כניסה אפשר לקבל ב-1 לכל חודש מייל עם סיכום החודש.</p>'; return; }
  const on = sync.myProfile()?.monthly_email !== false, mail = sync.user()?.email || '';
  el.innerHTML = `<label class="set-row" style="cursor:pointer"><span>📧 מייל סיכום חודשי ב-1 לחודש</span><input type="checkbox" id="setMonthly" ${on ? 'checked' : ''}></label>
    <p class="note">נשלח אל ${esc(mail)}: כמה משימות סיימת, מה נשאר פתוח ומה מחכה בחודש הבא.</p>`;
  $('#setMonthly').onchange = async e => {
    try { await sync.setMonthly(e.target.checked); toast(e.target.checked ? '📧 המייל החודשי הופעל' : 'המייל החודשי כובה'); }
    catch (x) { e.target.checked = !e.target.checked; toast(x.message, true); }
  };
}
async function drawPush() {
  const el = $('#pushCard'); if (!el) return;
  const st = await sync.pushState(), prefs = S.settings.push || {};
  const ios = /iPhone|iPad/.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  el.innerHTML = `<h4>🔔 התראות לטלפון <small>${st === 'on' ? 'פעיל ✓' : ''}</small></h4>
    ${!S.uid ? '<p class="note">כדי לקבל התראות צריך קודם להיכנס.</p><button class="btn pri" id="pushLogin">🔑 כניסה / יצירת קבוצה</button>'
      : st === 'unsupported' ? `<p class="note">${ios && !standalone ? 'באייפון: קודם מוסיפים את האפליקציה למסך הבית (כפתור השיתוף ⬆️ ← "הוסף למסך הבית"), פותחים משם, ואז חוזרים לכאן.' : 'הדפדפן הזה לא תומך בהתראות.'}</p>`
      : st === 'denied' ? '<p class="note">ההתראות חסומות. אפשר לאשר אותן בהגדרות הטלפון ← אפליקציות ← Chrome (או זמן בכיף) ← התראות.</p>'
      : st === 'off' ? '<button class="btn pri" id="pushOn">🔔 להפעיל התראות בטלפון הזה</button>'
      : `${PUSH_CATS.map(([k, l]) => `<label class="set-row" style="cursor:pointer"><span>${l}</span><input type="checkbox" data-cat="${k}" ${prefs[k] !== false ? 'checked' : ''}></label>`).join('')}
        <button class="btn" id="pushTest">🧪 שלח לי התראת ניסיון</button><button class="btn danger" id="pushOff">לכבות התראות בטלפון הזה</button>
        <p class="note" style="margin-top:6px">בשבת ובחג לא נשלחות התראות. באנדרואיד אפשר לבחור צליל מיוחד: הגדרות הטלפון ← התראות ← Chrome ← זמן בכיף ← צליל.</p>`}`;
  $('#pushLogin')?.addEventListener('click', () => showGate());
  $('#pushOn')?.addEventListener('click', async () => { try { await sync.enablePush(S.settings.push || {}); toast('🔔 ההתראות הופעלו'); await syncSchedule(); } catch (e) { sync.fail('push', e); toast(e.message, true); } drawPush(); });
  $('#pushOff')?.addEventListener('click', async () => { await sync.disablePush(); toast('ההתראות כובו בטלפון הזה'); drawPush(); });
  $('#pushTest')?.addEventListener('click', async () => { await queueNotify(S.uid, 'msg', '🧪 התראת ניסיון', 'אם רואים את זה — ההתראות עובדות! אפשר גם לנעול את הטלפון ולנסות שוב.', 'test'); toast('📨 נשלח. תוך דקה תקפוץ התראה'); });
  el.querySelectorAll('[data-cat]').forEach(c => c.onchange = async () => {
    S.settings.push = { ...(S.settings.push || {}), [c.dataset.cat]: c.checked }; await db.setKV('settings', S.settings); await sync.savePrefs(S.settings.push); toast('נשמר ✓');
  });
}

// ---------- הודעות והזמנות בין בני הבית ----------
const REACT = { heart: '❤️', done: '✅', yes: '✅', no: '❌', alt: '🕐', like: '👍', text: '💬' };
const otherSide = m => m.from === S.myP ? m.forP : m.from;
function inviteOf(text) {
  const p = parse(text);
  if (p.intent !== 'item' || !p.due) return null;
  return { due: p.due.toISOString(), hasTime: p.hasTime, dur: p.dur ?? (p.hasTime ? 60 : null), title: p.text };
}
async function sendMessage(f) {
  const to = person(f.forP);
  if (!S.uid) return bot('🔒', 'var(--card2)', 'צריך להיות מחובר כדי לשלוח הודעות', 'נכנסים באזור האישי ⚙️');
  if (!to?.uid) return bot('🤔', 'var(--card2)', `ל${to?.name || 'מי שכתבת'} אין עדיין חשבון באפליקציה`, 'אפשר להזמין אותו/ה מהאזור האישי ⚙️ ← הקבוצות שלי');
  const zm = Z.findZman(f.text);
  const pl = C.findPlace(zm ? zm.rest : f.text, knownPlaces());
  const inv = inviteOf(pl.text);
  if (inv) {
    if (zm) { const at = await Z.zmanTime(S.settings.city, zm); if (at) { inv.due = at.toISOString(); inv.hasTime = true; } }
    inv.place = pl.place;
  }
  const m = { id: db.newId(), kind: 'msg', text: f.text, from: S.myP, forP: to.id, forU: to.uid, private: true, status: 'open', group_id: f.group || sharedGroup(to.id)?.id || null,
    invite: inv, replies: [], created: new Date().toISOString() };
  S.items.push(m); await save(m);
  await queueNotify(to.uid, 'msg', `💌 ${nameIn(S.myP, m.group_id)}`, f.text + (inv ? `\n📅 ${whenLabel(inv)}` : ''), m.id);
  return bot('💌', 'var(--g6)', `נשלח ל${to.name}`, `${f.text}${inv ? `\n📅 ${whenLabel(inv)}${inv.dur ? ' · ⏱️ ' + durLbl(inv.dur) : ''}` : ''}\nאעדכן אותך כש${to.name} יגיב/תגיב`,
    [{ l: '↩️ בטל שליחה', op: 'unsend', a: [m.id] }]);
}
// הודעה שהגיעה אליי
async function showIncoming(m) {
  const from = person(m.from), inv = m.invite;
  if (m.bump) { // הקפצה
    const t = item(m.bump);
    await bell('🔔', `${from?.name || 'מישהו'} מזכיר/ה לך`, m.text, { item: m.bump }, 'bump:' + m.id);
    await bot(from?.e || '🔔', 'var(--g4)', `🔔 ${from?.name || 'מישהו'} מזכיר/ה לך`, `${m.text}${t?.due ? '\n' + whenLabel(t) : ''}`,
      [{ l: '❤️ קיבלתי', op: 'react', a: [m.id, 'heart'], pri: true }, ...(t && t.status === 'open' ? [{ l: '✅ עשיתי', op: 'bumpDone', a: [m.id] }] : [])]);
    return buzz();
  }
  await bell('💌', `הודעה מ${from?.name || 'מישהו'}`, m.text, { view: 'chat', item: m.id }, 'msg:' + m.id);
  let sub = m.text;
  if (inv) {
    sub += `\n📅 ${whenLabel(inv)}${inv.dur ? ' · ⏱️ ' + durLbl(inv.dur) : ''}${inv.place ? ' · 📍 ' + inv.place : ''}`;
    const clash = inviteClashes(inv);
    if (clash.length) sub += `\n⚠️ מתנגש אצלך עם: ${clash.map(x => `${x.text} (${C.span(x)})`).join(', ')}`;
    const q = inv.hasTime && Z.quietAt(new Date(inv.due)); if (q) sub += `\n🕯️ שים/י לב: זה ב${q.name}`;
  }
  const acts = inv
    ? [{ l: '✅ מאושר', op: 'react', a: [m.id, 'yes'], pri: true }, { l: '❤️', op: 'react', a: [m.id, 'heart'] }, { l: '❌ לא יכול/ה', op: 'replyNo', a: [m.id, 'no'] },
      { l: '🕐 זמן אחר', op: 'replyNo', a: [m.id, 'alt'] }, { l: '✍️ לענות', op: 'replyText', a: [m.id] }]
    : [{ l: '❤️', op: 'react', a: [m.id, 'heart'], pri: true }, { l: '👍', op: 'react', a: [m.id, 'like'] }, { l: '✍️ לענות', op: 'replyText', a: [m.id] }];
  await bot(from?.e || '💌', 'var(--g6)', `💌 ${from?.name || 'הודעה'}`, sub, acts);
  buzz();
}
function inviteClashes(inv) {
  if (!inv?.hasTime) return [];
  const probe = { id: 'probe', due: inv.due, dur: inv.dur || 60, hasTime: true };
  return S.items.filter(x => x.status === 'open' && isTask(x) && isMine(x) && x.due && x.hasTime && x.dur > 0 &&
    C.startOf(x) < C.endOf(probe) && C.startOf(probe) < C.endOf(x));
}
// תגובה חדשה להודעה שאני חלק ממנה
async function showReply(m, r) {
  const p = person(r.p), n = p?.name || 'מישהו';
  const ic = p?.e || REACT[r.r] || '💬';
  await bell(REACT[r.r] || '💬', m.bump ? `${n} ${r.r === 'heart' ? 'קיבל/ה את ההקפצה ❤️' : r.r === 'done' ? 'עשה/תה ✅' : 'הגיב/ה'}` : `${n} ${REACT[r.r] || 'ענה/תה'}`, r.text || m.text, { view: 'chat' }, `rep:${m.id}:${r.at}`);
  if (m.bump) return r.r === 'done' ? (bot(ic, 'var(--g3)', `${n} עשה/תה ✅`, m.text), confetti(50)) : bot(ic, 'var(--g6)', `${n} קיבל/ה ❤️`, `🔔 ${m.text}`);
  if (r.r === 'heart' || r.r === 'like') return bot(ic, 'var(--g6)', `${n} ${REACT[r.r]}`, m.text);
  if (r.r === 'yes') return bot(ic, 'var(--g3)', `${n} אישר/ה ✅`, `${m.text}${r.alt || m.invite ? `\n📅 ${whenLabel(r.alt || m.invite)} · נכנס ללוח של שניכם` : ''}`), confetti(60);
  if (r.r === 'no') return bot(ic, 'linear-gradient(135deg,#F43F5E,#F97316)', `${n} לא יכול/ה ❌`, `${m.text}${r.text ? `\n"${r.text}"` : ''}`,
    [{ l: '🕐 להציע זמן אחר', op: 'replyNo', a: [m.id, 'alt'] }, { l: '✍️ לענות', op: 'replyText', a: [m.id] }]);
  if (r.r === 'alt') return bot(ic, 'var(--g4)', `${n} מציע/ה זמן אחר 🕐`, `${m.text}\n📅 ${whenLabel(r.alt)}${r.text ? `\n"${r.text}"` : ''}`,
    [{ l: '✅ מאשר/ת', op: 'acceptAlt', a: [m.id, m.replies.indexOf(r)], pri: true }, { l: '🕐 זמן אחר', op: 'replyNo', a: [m.id, 'alt'] }, { l: '✍️ לענות', op: 'replyText', a: [m.id] }]);
  return bot(ic, 'var(--g6)', `${n}:`, r.text, [{ l: '❤️', op: 'react', a: [m.id, 'heart'] }, { l: '✍️ לענות', op: 'replyText', a: [m.id] }]);
}
async function addReply(m, r) {
  m.replies = [...(m.replies || []), { p: S.myP, at: new Date().toISOString(), ...r }];
  await save(m); renderAll();
  const to = person(otherSide(m));
  const txt = m.bump ? { heart: 'קיבל/ה ❤️', done: 'עשה/תה ✅' }[r.r] || '' : { heart: '❤️', like: '👍', yes: 'אישר/ה ✅', no: 'לא יכול/ה ❌', alt: 'מציע/ה זמן אחר 🕐', text: '' }[r.r];
  if (to?.uid) await queueNotify(to.uid, m.bump ? 'bump' : 'msg', `${person(S.myP)?.e || ''} ${person(S.myP)?.name || ''} ${txt}`.trim(), r.text || m.text, m.id);
}
// אירוע משותף: נכנס ללוח של שנינו
async function createShared(m, inv) {
  const other = person(otherSide(m)), title = (inv.title || m.text).replace(/^(קבעתי|קבענו)\s+(לנו|לשנינו)\s*/, '') || m.text;
  for (const forP of [null, other?.id]) {
    const it = { id: db.newId(), kind: 'meeting', text: title, due: inv.due, hasTime: !!inv.hasTime, dur: inv.dur ?? null, place: inv.place || null,
      repeat: null, status: 'open', created: new Date().toISOString(), forP, forU: forP ? other?.uid || null : null, linked: m.id, private: false };
    S.items.push(it); await save(it);
  }
  renderAll(); scanConflicts();
}
// חלון "לא יכול/ה" / "זמן אחר": סיבה + שעות ששנינו פנויים
function openReplyNo(id, mode) {
  const m = item(id); if (!m) return toast('ההודעה כבר לא קיימת', true);
  const inv = m.invite, other = otherSide(m);
  const slots = [];
  if (inv?.hasTime) {
    const dur = (inv.dur || 60) * 60e3, base = { due: inv.due, dur: inv.dur || 60 };
    const freeFor = (o, t) => S.items.concat(S.busy, S.ext).filter(x => x.status === 'open' && x.due && x.hasTime && x.dur > 0 && (ownerOf(x) === o)).every(y => !(t < C.endOf(y) && C.startOf(y) < t + dur));
    let from = C.startOf(base);
    for (let i = 0; i < 3; i++) {
      const d = freeWhen({ ...base, due: new Date(from).toISOString() }, t => t !== C.startOf(base) && !slots.some(s => Math.abs(s - t) < 2 * 3600e3) && freeFor(meId(), t) && freeFor(other, t) && !Z.quietAt(t) && !Z.quietAt(t + dur));
      if (!d) break; slots.push(+d); from = +d;
    }
  }
  sheet(`<h3>${mode === 'no' ? '❌ לא יכול/ה' : '🕐 להציע זמן אחר'}</h3>
    <p class="note" style="margin-bottom:8px">${esc(m.text)}${inv ? ' · ' + esc(whenLabel(inv)) : ''}</p>
    <label>${mode === 'no' ? 'למה? (לא חובה)' : 'הערה (לא חובה)'}</label><input id="rText" placeholder="${mode === 'no' ? 'למשל: יש לי אסיפת הורים' : 'למשל: רק אם נחזור עד 10'}">
    ${inv ? `<label>${slots.length ? 'שעות ששניכם פנויים בהן' : 'זמן אחר'}</label><div id="rSlots">${slots.map((t, i) => `<div class="pick" data-t="${t}"><div class="ck"></div>${esc(whenLabel({ due: new Date(t).toISOString(), hasTime: true }))}<small>שניכם פנויים</small></div>`).join('')}</div>
    <div class="two"><div><label>או תאריך</label><input type="date" id="rDate"></div><div><label>שעה</label><input type="time" id="rTime"></div></div>` : ''}
    <button class="btn pri" id="rSend" style="margin-top:14px">📨 שלח</button>`);
  let pick = null;
  $('#rSlots')?.addEventListener('click', e => { const el = e.target.closest('.pick'); if (!el) return; pick = +el.dataset.t; [...$('#rSlots').children].forEach(x => { x.classList.toggle('on', x === el); x.querySelector('.ck').textContent = x === el ? '✓' : ''; }); });
  $('#rSend').onclick = async () => {
    let alt = null;
    const ds = $('#rDate')?.value, ts = $('#rTime')?.value;
    if (ds) { const d = new Date(ds + 'T' + (ts || '00:00')); alt = { due: d.toISOString(), hasTime: !!ts, dur: inv?.dur || null, title: inv?.title, place: inv?.place }; }
    else if (pick) alt = { due: new Date(pick).toISOString(), hasTime: true, dur: inv?.dur || 60, title: inv?.title, place: inv?.place };
    if (mode === 'alt' && !alt) return toast('בחר/י זמן', true);
    closeSheet();
    const r = alt ? { r: 'alt', alt, text: $('#rText').value.trim() || (mode === 'no' ? 'לא יכול/ה בזמן הזה' : '') } : { r: 'no', text: $('#rText').value.trim() };
    await addReply(m, r);
    await bot('📨', 'var(--g2)', alt ? `הצעת: ${whenLabel(alt)}` : 'נשלח', r.text || '');
  };
}
function openReplyText(id) {
  const m = item(id); if (!m) return;
  sheet(`<h3>✍️ תשובה</h3><p class="note" style="margin-bottom:8px">${esc(m.text)}</p><input id="tText" placeholder="כתוב/כתבי כאן…"><button class="btn pri" id="tSend" style="margin-top:12px">📨 שלח</button>`);
  setTimeout(() => $('#tText').focus(), 300);
  $('#tSend').onclick = async () => { const t = $('#tText').value.trim(); if (!t) return; closeSheet(); await addReply(m, { r: 'text', text: t }); await bot('📨', 'var(--g2)', 'נשלח', t); };
}

// ---------- התנגשויות ----------
const durLbl = m => m >= 60 ? (m % 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} שע׳` : m === 60 ? 'שעה' : m === 120 ? 'שעתיים' : `${m / 60} שעות`) : `${m} דק׳`;
const resOf = id => S.resources.find(r => r.id === id);
const knownPlaces = () => [...new Set(S.items.map(x => x.place).filter(Boolean))];
const ownerOf = x => x.busy ? (x.forP || personOfUid(x.forU)?.id || personOfUid(x.by)?.id || '?') : (x.forP === 'any' ? 'any' : ownerP(x) || personOfUid(x.by)?.id || S.myP || 'me');
// מבוגרים עם חשבון — בקבוצה של המשימה (בשביל "מישהו מאיתנו")
const adults = it => { const gid = it?.group_id; const a = S.people.filter(p => p.uid && (!gid || p.nicks.some(n => n.g === gid && n.role !== 'child'))).map(p => p.id); return a.length ? a : [S.myP || 'me']; };
const meId = () => S.myP || 'me';
const ctx = () => ({ items: S.items, busy: S.busy.concat(S.ext), owner: ownerOf, adults, resources: S.resources, travel: S.travel });
const allConflicts = () => C.detect(ctx()).concat(shabbatConflicts());
// משהו שנקבע בשבת/חג, או שמסתיים פחות משעה לפני הכניסה
function shabbatConflicts() {
  const out = [], now = Date.now();
  for (const it of S.items) {
    if (it.status !== 'open' || !['task', 'meeting'].includes(it.kind) || !it.due || !it.hasTime || it.repeat || !(it.dur > 0 || it.kind === 'meeting')) continue;
    const st = C.startOf(it), en = Math.max(C.endOf(it), st + 15 * 60e3);
    if (en < now || st > now + 21 * 864e5) continue;
    const w = Z.windows().find(w => st < +new Date(w.end) && en > +new Date(w.start) - 60 * 60e3);
    if (!w) continue;
    const okId = 'shabbat:' + w.start;
    if ((it.ok || []).includes(okId)) continue;
    const inside = st < +new Date(w.end) && en > +new Date(w.start);
    out.push({ key: `shab:${it.id}:${it.due}:${it.dur}:${w.start}`, type: inside ? 'shabbat' : 'preShabbat', a: it, b: null, okId, w });
  }
  return out;
}
function concerns(c) {
  const mine = [c.a, c.b].some(x => x && !x.busy && ownerOf(x) === meId());
  if (c.type === 'nobody' || c.type === 'res') return mine || adults(c.a).includes(meId());
  return mine;
}
const nameOf = x => x.ext ? `📅 ${x.text} (מהיומן)` : x.busy ? `${who(ownerOf(x))} תפוס/ה` : x.text;
const lineOf = x => `${nameOf(x)} (${C.span(x)}${family() && !x.busy ? ' · ' + whoIn(ownerOf(x), x.group_id) : ''})`;
function describe(c) {
  const day = whenLabel({ due: c.a.due, hasTime: false });
  switch (c.type) {
    case 'self': return ['⚠️', 'var(--g4)', 'התנגשות בלוח שלך', `${day}:\n${lineOf(c.a)}\nמתנגש עם: ${lineOf(c.b)}`];
    case 'both': return ['⚠️', 'var(--g4)', `התנגשות עם ${person(c.who.find(x => x !== meId()))?.name || 'בן משפחה'}`, `${day}, שניכם תפוסים:\n${lineOf(c.a)}\n${lineOf(c.b)}`];
    case 'res': return [c.res?.e || '⚠️', 'var(--g4)', `${c.res?.n || 'משהו משותף'} דרוש פעמיים באותו זמן`, `${day}:\n${lineOf(c.a)}\n${lineOf(c.b)}`];
    case 'nobody': return ['🚨', 'linear-gradient(135deg,#F43F5E,#F97316)', 'אף אחד לא פנוי!', `${c.a.text} · ${whenLabel(c.a)}\nכולם תפוסים: ${c.blockers.map(lineOf).join(', ')}`];
    case 'shabbat': return ['🕯️', 'linear-gradient(135deg,#F59E0B,#FACC15)', `"${c.a.text}" נופל ב${c.w.name}`, `${whenLabel(c.a)}\n${c.w.name} נכנס/ת ב-${hm(new Date(c.w.start))} ויוצא/ת ב-${hm(new Date(c.w.end))}`];
    case 'preShabbat': return ['🕯️', 'linear-gradient(135deg,#F59E0B,#FACC15)', `"${c.a.text}" קרוב מדי לכניסת ${c.w.name}`, `מסתיים ב-${hm(new Date(C.endOf(c.a)))}, והדלקת נרות ב-${hm(new Date(c.w.start))}`];
    case 'travel': return ['🚗', 'var(--g4)', 'אין מספיק זמן להגיע', `${c.a.text} ב${c.a.place} עד ${hm(new Date(C.endOf(c.a)))}\n${c.b.text} ב${c.b.place} ב-${hm(new Date(C.startOf(c.b)))}\nהנסיעה לוקחת בערך ${durLbl(c.need)}, ויש רק ${durLbl(Math.max(0, Math.round(c.gap)))}`];
  }
}

async function askDur(it) {
  const meet = it.kind === 'meeting';
  const opts = [[15, 'רבע שעה'], [30, 'חצי שעה'], [60, 'שעה'], [120, 'שעתיים']].map(([m, l]) => ({ l, op: 'dur', a: [it.id, m], pri: meet && m === 60 }));
  if (!meet) opts.unshift({ l: '⏱️ רק תזכורת', op: 'dur', a: [it.id, 0], pri: true });
  opts.push({ l: '✏️ אחר', op: 'edit', a: [it.id] });
  return bot('⏱️', 'var(--g2)', 'כמה זמן זה ייקח?', `${it.text}\nכדי שאוכל להתריע אם משהו מתנגש`, opts);
}

let scanning = false;
async function scanConflicts() {
  if (scanning) return; scanning = true;
  try {
    const all = allConflicts();
    S.conflictIds = new Set(all.filter(c => c.type !== 'travelAsk' && concerns(c)).flatMap(c => [c.a.id, c.b?.id]));
    for (const c of all.filter(c => concerns(c) && !S.alerted.includes(c.key))) {
      S.alerted.push(c.key);
      if (c.type === 'travelAsk') {
        await bot('🚗', 'var(--g2)', `כמה זמן נסיעה מ${c.a.place} ל${c.b.place}?`, 'אזכור את זה, ואתריע אם אין מספיק זמן להגיע',
          [15, 30, 45, 60, 90].map(m => ({ l: durLbl(m), op: 'travel', a: [c.a.place, c.b.place, m] })));
        continue;
      }
      const [ic, bg, title, sub] = describe(c);
      await bell(ic, title, sub, { conf: c.a.id }, 'conf:' + c.key);
      for (const o of new Set([c.a, c.b, ...(c.blockers || [])].filter(Boolean).map(ownerOf)))
        if (['both', 'res', 'nobody'].includes(c.type) && o !== meId() && person(o)?.uid && [c.a, c.b].some(x => x && !x.busy && byMe(x) && Date.now() - new Date(x.created) < 10 * 60e3))
          await queueNotify(person(o).uid, 'conflict', c.type === 'both' ? `⚠️ התנגשות עם ${person(meId())?.name || 'בן משפחה'}` : `${ic} ${title}`, sub, c.key);
      await bot(ic, bg, title, sub, [{ l: '👀 לראות ומה אפשר לעשות', op: 'conflict', a: [c.a.id, c.b?.id || c.okId], pri: true }, { l: '✅ זה בסדר', op: 'okConf', a: [c.a.id, c.b?.id || c.okId] }]);
      buzz();
    }
    S.alerted = S.alerted.slice(-400); await db.setKV('alerted', S.alerted);
    renderTasks();
  } finally { scanning = false; }
}
const findConflict = (aId, bId) => allConflicts().find(c => c.type !== 'travelAsk' && [c.a.id, c.b?.id, c.okId].includes(aId) && (!bId || [c.a.id, c.b?.id, c.okId].includes(bId)));

// חלון "במה זה מתנגש": ציר שעות + עצות
function openConflict(aId, bId) {
  const c = findConflict(aId, bId);
  if (!c) return toast('👍 ההתנגשות כבר לא קיימת');
  const pair = [c.a, c.b, ...(c.blockers || [])].filter(Boolean);
  const t0 = Math.min(...pair.map(C.startOf)) - 45 * 60e3, t1 = Math.max(...pair.map(C.endOf)) + 45 * 60e3, W = t1 - t0;
  const owners = [...new Set(c.type === 'nobody' ? adults(c.a) : pair.map(ownerOf))];
  const pool = S.items.concat(S.busy, S.ext).filter(x => x.status === 'open' && x.due && x.hasTime && x.dur > 0 && C.endOf(x) > t0 && C.startOf(x) < t1);
  const bar = x => { const l = (C.startOf(x) - t0) / W * 100, w = Math.max(2, x.dur * 60e3 / W * 100); const hot = pair.includes(x);
    return `<div class="tl-bar${hot ? ' hot' : ''}${x.busy ? ' busy' : ''}" style="right:${l}%;width:${w}%" title="${esc(nameOf(x))}">${esc(x.ext ? '📅 ' + x.text : x.busy ? '🔒 תפוס' : x.text)}</div>`; };
  const rows = owners.map(o => `<div class="tl-row"><div class="tl-who">${o === 'any' ? '👨‍👩‍👧' : esc(who(o) || 'אני')}</div><div class="tl-track">${pool.filter(x => ownerOf(x) === o || (c.type === 'nobody' && x === c.a)).map(bar).join('')}</div></div>`).join('');
  const ticks = []; for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t < t1; t += 3600e3) ticks.push(`<span style="right:${(t - t0) / W * 100}%">${hm(new Date(t))}</span>`);
  const [, , title, sub] = describe(c);
  const tips = suggestions(c);
  sheet(`<h3>${esc(title)}</h3><p class="note" style="white-space:pre-line;margin-bottom:12px">${esc(sub)}</p>
    <div class="tl">${rows}<div class="tl-ticks">${ticks.join('')}</div></div>
    <h3 style="margin-top:16px;font-size:16px">💡 מה אפשר לעשות</h3>
    <div id="tips">${tips.map((t, i) => `<button class="btn${i === 0 ? ' pri' : ''}" data-i="${i}" style="margin-top:8px">${esc(t.l)}</button>`).join('')}</div>
    <button class="btn" id="cOk" style="margin-top:8px">✅ זה בסדר, להשאיר כך</button>`);
  $('#tips').onclick = async e => { const b = e.target.closest('[data-i]'); if (!b) return; closeSheet(); await tips[+b.dataset.i].run(); renderAll(); await scanConflicts(); };
  $('#cOk').onclick = async () => { closeSheet(); await OPS.okConf(c.a.id, c.b?.id || c.okId); };
}

function suggestions(c) {
  const out = [], editable = x => x && !x.busy && x.status === 'open';
  const mineFirst = [c.a, c.b].filter(editable).sort((x, y) => (ownerOf(y) === meId()) - (ownerOf(x) === meId()) || new Date(y.created) - new Date(x.created));
  const tgt = c.type === 'nobody' ? c.a : c.type === 'travel' ? c.b : mineFirst[0];
  const other = tgt === c.a ? c.b : c.a;
  const dayLbl = d => whenLabel({ due: d.toISOString(), hasTime: true });
  const move = (x, d) => async () => { x.due = d.toISOString(); x.askedKey = null; await save(x); toast(`🕐 הוזז ל${dayLbl(d)}`); };
  const busyFor = o => S.items.concat(S.busy, S.ext).filter(x => x.status === 'open' && x.due && x.hasTime && x.dur > 0 && ownerOf(x) === o);
  const blockersOf = x => {
    const o = ownerOf(x);
    let list = o === 'any' ? [] : busyFor(o);
    if (x.res?.length) list = list.concat(S.items.filter(y => y.status === 'open' && y.due && y.hasTime && y.dur > 0 && (y.res || []).some(r => x.res.includes(r))));
    return list.filter(y => y.id !== x.id);
  };
  if (c.type === 'shabbat' || c.type === 'preShabbat') {
    const it = c.a, dur = Math.max(it.dur || 0, 15) * 60e3, ws = +new Date(c.w.start), we = +new Date(c.w.end);
    const freeMe = t => busyFor(ownerOf(it)).every(y => y.id === it.id || !(t < C.endOf(y) && C.startOf(y) < t + dur));
    const before = freeWhen({ ...it, dur: dur / 60e3 }, t => t + dur <= ws - 60 * 60e3 && t > ws - 3 * 864e5 && freeMe(t));
    if (before) out.push({ l: `🕐 להקדים ל${dayLbl(before)}`, run: move(it, before) });
    const after = freeWhen({ ...it, due: new Date(we + 30 * 60e3).toISOString(), dur: dur / 60e3 }, t => t >= we + 30 * 60e3 && freeMe(t));
    if (after) out.push({ l: `🕐 להזיז ל${dayLbl(after)} (אחרי ${c.w.name === 'שבת' ? 'השבת' : 'החג'})`, run: move(it, after) });
    return out;
  }
  if (c.type === 'travel') {
    const f = C.travelFix(c);
    out.push({ l: `🕐 להזיז את "${c.b.text}" ל-${hm(f.moveTo)}`, run: move(c.b, f.moveTo) });
    const keep = Math.round((f.shortenTo - C.startOf(c.a)) / 60e3);
    if (keep >= 15 && editable(c.a)) out.push({ l: `✂️ לסיים את "${c.a.text}" ב-${hm(f.shortenTo)} ולצאת לדרך`, run: async () => { c.a.dur = keep; await save(c.a); toast('✂️ קוצר'); } });
    return out;
  }
  if (editable(tgt)) {
    if (c.type === 'nobody') {
      // שעה שבה לפחות אחד מכם פנוי
      const probe = { ...tgt, dur: tgt.dur || 15 };
      const d = freeWhen(probe, t => adults(tgt).some(p => busyFor(p).every(y => !(t < C.endOf(y) && C.startOf(y) < t + probe.dur * 60e3))));
      if (d) out.push({ l: `🕐 להזיז ל${dayLbl(d)} (מישהו פנוי)`, run: move(tgt, d) });
      for (const bl of c.blockers.filter(editable)) {
        const d2 = C.freeSlot(bl, ctx(), blockersOf);
        if (d2) out.push({ l: `🕐 להזיז את "${bl.text}" של ${person(ownerOf(bl))?.name || ''} ל${dayLbl(d2)}`, run: move(bl, d2) });
      }
    } else {
      // בהתנגשות ביני לבין פסי — שעה ששנינו פנויים בה
      const both = x => blockersOf(x).concat(c.type === 'both' && other ? busyFor(ownerOf(other)).filter(y => y.id !== x.id) : []);
      const d = C.freeSlot(tgt, ctx(), both);
      if (d) out.push({ l: `🕐 להזיז את "${tgt.text}" ל${dayLbl(d)} (${c.type === 'both' ? 'שניכם פנויים' : 'פנוי'})`, run: move(tgt, d) });
      // להעביר למישהו אחר שפנוי
      if (tgt.group_id && tgt.kind !== 'meeting') for (const p of S.people.filter(p => p.uid && p.id !== ownerOf(tgt) && p.nicks.some(n => n.g === tgt.group_id && n.role !== 'child'))) {
        if (busyFor(p.id).every(y => !(C.startOf(tgt) < C.endOf(y) && C.startOf(y) < C.endOf(tgt))))
          out.push({ l: `🙋 לתת ל${nameIn(p.id, tgt.group_id)} (פנוי/ה אז)`, run: () => setAssign(tgt, tgt.group_id, p.id) });
      }
      // לקצר / לפצל
      if (other && !(c.type === 'res' && false)) {
        const ts = C.startOf(tgt), te = C.endOf(tgt), os = C.startOf(other), oe = C.endOf(other);
        if (ts < os && te > os && te <= oe && (os - ts) >= 15 * 60e3)
          out.push({ l: `✂️ לקצר את "${tgt.text}" שיסתיים ב-${hm(new Date(os))}`, run: async () => { tgt.dur = Math.round((os - ts) / 60e3); await save(tgt); toast('✂️ קוצר'); } });
        if (ts >= os && ts < oe && te > oe && (te - oe) >= 15 * 60e3)
          out.push({ l: `✂️ להתחיל את "${tgt.text}" ב-${hm(new Date(oe))}, אחרי "${nameOf(other)}"`, run: async () => { tgt.dur = Math.round((te - oe) / 60e3); tgt.due = new Date(oe).toISOString(); await save(tgt); toast('✂️ עודכן'); } });
        if (ts < os && te > oe && (os - ts) >= 15 * 60e3 && (te - oe) >= 15 * 60e3)
          out.push({ l: `✂️ לפצל: עד ${hm(new Date(os))} ומ-${hm(new Date(oe))}`, run: async () => {
            const part2 = { ...tgt, id: db.newId(), due: new Date(oe).toISOString(), dur: Math.round((te - oe) / 60e3), text: tgt.text + ' (המשך)', created: new Date().toISOString(), askedKey: null };
            tgt.dur = Math.round((os - ts) / 60e3); await save(tgt); S.items.push(part2); await save(part2); toast('✂️ פוצל לשניים'); } });
      }
    }
  }
  if (!out.length) out.push({ l: '✏️ לשנות ידנית', run: async () => openEdit(tgt?.id || c.a.id) });
  return out;
}
function freeWhen(it, isFree) {
  const dur = (it.dur || 15) * 60e3, orig = C.startOf(it);
  for (let day = 0; day < 7; day++) {
    const base = sod(addDays(new Date(orig), day)).getTime(), c = [];
    for (let t = base + 7 * 3600e3; t + dur <= base + 22 * 3600e3; t += 15 * 60e3) if (t > Date.now() && t !== orig) c.push(t);
    c.sort((x, y) => Math.abs(x - orig) - Math.abs(y - orig));
    const t = c.find(isFree); if (t) return new Date(t);
  }
  return null;
}

// ---------- 3 החשובים ----------
function curTop3() { return S.top3?.date === today() ? { ...S.top3, ids: [...S.top3.ids] } : { date: today(), ids: [] }; }
function top3Items() { return curTop3().ids.map(id => S.items.find(x => x.id === id)).filter(x => x && x.status !== 'deleted'); }
const isDoneToday = x => x.status === 'done' || (x.repeat && x.lastDone && isToday(x.lastDone));
const inTop3AllDone = () => { const t = top3Items(); return t.length > 0 && t.every(isDoneToday); };

function renderTop3() {
  const list = top3Items();
  const box = $('#top3'); box.innerHTML = '';
  list.forEach(it => {
    const b = document.createElement('button'); const d = isDoneToday(it);
    b.className = 't3' + (d ? ' done' : '');
    b.innerHTML = `<div class="ck">${d ? '✓' : ''}</div><span>${esc(it.text)}</span>${it.hasTime && it.due && !d ? `<em>${hm(new Date(it.due))}</em>` : ''}`;
    b.onclick = () => d ? OPS.undoDone(it.id) : markDone(it.id, true).then(() => toast('✅ ' + it.text));
    box.appendChild(b);
  });
  {
    const b = document.createElement('button'); b.className = 't3 empty';
    b.textContent = list.length ? '＋ להוסיף עוד חשוב' : '⭐ לבחור את החשובים של היום';
    b.onclick = () => openPicker(); box.appendChild(b);
  }
  const n = list.filter(isDoneToday).length;
  $('#t3bar').style.width = list.length ? (n / list.length * 100) + '%' : '0';
  $('#t3txt').textContent = !list.length ? 'עוד לא נבחרו' : n === list.length ? '🎉 סיימת את כל החשובים!' : `${n} מתוך ${list.length} בוצעו`;
  $('#t3edit').hidden = !list.length;
  const fold = (() => { try { return localStorage.getItem('zman-t3fold') === '1'; } catch { return false; } })();
  $('.hero').classList.toggle('fold', fold); $('#t3fold').innerHTML = fold ? '<b>▾</b> לפתוח' : '<b>▴</b> לקפל'; $('#t3fold').setAttribute('aria-expanded', String(!fold));
  $('#t3title').textContent = fold && list.length ? `⭐ החשובים · ${n}/${list.length}${n === list.length ? ' 🎉' : ''}` : '⭐ החשובים של היום';
}
// ⭐ נעוץ למעלה בשיחה, ואפשר לקפל לשורה אחת
$h('#t3fold').onclick = e => { e.stopPropagation(); const f = !$('.hero').classList.contains('fold'); try { localStorage.setItem('zman-t3fold', f ? '1' : '0'); } catch { /* */ } renderTop3(); };

function streak() {
  const days = new Set(S.log.filter(l => l.action === 'done').map(l => ymd(new Date(l.ts))));
  let d = sod(new Date()); if (!days.has(ymd(d))) d = addDays(d, -1);
  let n = 0; while (days.has(ymd(d))) { n++; d = addDays(d, -1); }
  return n;
}

// ---------- מסך משימות ----------
function rowHtml(it) {
  const d = isDoneToday(it) && !it.repeat ? ' done' : '';
  const late = it.status === 'open' && it.due && (it.hasTime ? new Date(it.due) < new Date() : overdueDays(it));
  const star = curTop3().ids.includes(it.id);
  const g = groupOf(it.group_id);
  const owner = !S.uid ? '' : it.forP && it.forP !== S.myP ? whoIn(it.forP, it.group_id) : g ? gLabel(g) : (it.by && it.by !== S.uid ? whoIn(personOfUid(it.by)?.id, null) : '');
  const ct = catOf(it);
  const meta = [it.stars ? `⭐${it.stars}` : '', stepsLbl(it), ct ? `${ct.icon} ${ct.name}` : '', owner, it.kind === 'meeting' ? '👥 פגישה' : '', (it.hasTime && it.dur ? whenLabel(it).replace(/(\d{1,2}:\d{2})$/, x => `\u2066${x}–${hm(new Date(C.endOf(it)))}\u2069`) : whenLabel(it)), it.place ? '📍 ' + it.place : '', ...(it.res || []).map(r => resOf(r)?.e || '')].filter(Boolean).join(' · ');
  const warn = S.conflictIds?.has(it.id) && it.status === 'open' ? '<button class="warn" data-op="conf" aria-label="התנגשות">⚠️</button>' : '';
  const tint = S.uid ? colorOf(it.forP && it.forP !== 'any' ? it.forP : ownerP(it) || S.myP) : null;
  return `<div class="row${d}" data-id="${it.id}"${tint ? ` style="--pc:${tint}"` : ''}><button class="cb" data-op="check">${d ? '✓' : ''}</button>${warn}
    <div class="nm" data-op="edit">${esc(it.text)}${meta ? `<small class="${late ? 'late' : ''}">${esc(meta)}</small>` : ''}</div>
    ${it.prog?.of > 1 && it.status === 'open' ? `<button class="prog-b" data-op="prog" aria-label="עוד אחד" dir="ltr">${it.prog.n || 0}/${it.prog.of} ＋</button>` : ''}${it.comments?.length ? `<button class="star on cm-n" data-op="comments" aria-label="${it.comments.length} תגובות">💬<small>${it.comments.length}</small></button>` : ''}${canBump(it) ? '<button class="star on" data-op="bump" aria-label="להקפיץ" style="font-size:16px">🔔</button>' : ''}${S.uid && it.status === 'open' ? '<button class="star on" data-op="assign" aria-label="שיוך" style="font-size:16px">📎</button>' : ''}${it.status === 'open' && it.kind === 'task' && isMine(it) ? `<button class="star${star ? ' on' : ''}" data-op="star" aria-label="לחשובים של היום">⭐</button>` : ''}${byMe(it) ? '<button class="star del-x" data-op="del" aria-label="מחיקה">🗑️</button>' : ''}</div>`;
}
function renderTasks() {
  const now = new Date(), t0 = sod(now), t1 = addDays(t0, 1), t2 = addDays(t0, 2);
  // סינון: הכל / שלי / רק לי (בלי קבוצה) / קבוצה מסוימת
  const passC = x => !S.catF || (catOf(x)?.id || '') === S.catF;
  const pass = x => passC(x) && (S.who === 'all' || (S.who === 'mine' && isMine(x)) || (S.who === 'solo' && !x.group_id) || x.group_id === S.who);
  const open = rankForToday(allTasksOpen().filter(pass));
  const isLate = x => x.due && (x.hasTime ? new Date(x.due) < now : new Date(x.due) < t0);
  const gs = sync.myGroups();
  $('#whoFilter').hidden = !gs.length;
  if (gs.length) $('#whoFilter').innerHTML = [['all', 'הכל'], ['mine', '🙋 שלי'], ['solo', '🔒 רק לי'], ...gs.map(g => [g.id, gLabel(g)])]
    .map(([k, l]) => `<button class="chip ${S.who === k ? 'on' : ''}" data-w="${k}">${esc(l)}</button>`).join('');
  const used = [...new Map(allTasksOpen().map(catOf).filter(Boolean).map(c => [c.id, c])).values()];
  $('#catFilter').hidden = !used.length;
  if (used.length) $('#catFilter').innerHTML = [`<button class="chip ${!S.catF ? 'on' : ''}" data-cf="">🏷️ כל הקטגוריות</button>`, ...used.map(c => `<button class="chip ${S.catF === c.id ? 'on' : ''}" data-cf="${esc(c.id)}" style="--c:${c.color}">${esc(c.icon)} ${esc(c.name)}</button>`)].join('');
  const fresh = open.filter(x => S.fresh?.has(x.id) || isUnread(x)), freshIds = new Set(fresh.map(x => x.id));
  const rest = open.filter(x => !freshIds.has(x.id));
  const groups = [
    ['📩 חדשים שלא ראית', fresh],
    ['⚠️ באיחור', rest.filter(isLate)],
    ['☀️ היום', rest.filter(x => !isLate(x) && x.due && new Date(x.due) < t1 && !x.repeat)],
    ['🌅 מחר', rest.filter(x => x.due && new Date(x.due) >= t1 && new Date(x.due) < t2 && !x.repeat)],
    ['📆 בהמשך', rest.filter(x => x.due && new Date(x.due) >= t2 && !x.repeat)],
    ['🔁 קבועות', rest.filter(x => x.repeat && !isLate(x))],
    ['📝 בלי תאריך', rest.filter(x => !x.due)],
    ['✅ בוצעו היום', S.items.filter(x => pass(x) && x.status !== 'deleted' && isTask(x) && ((x.status === 'done' && isToday(x.doneAt)) || (x.repeat && isToday(x.lastDone))))],
  ].filter(g => g[1].length);
  $('#taskList').innerHTML = habitsCard() + recurCard() + (groups.length ? groups.map(([h, l]) => `<div class="card${h.startsWith('📩') ? ' fresh-card' : ''}"><h4>${h}<small>${l.length}</small></h4>${l.map(rowHtml).join('')}</div>`).join('')
    : `<div class="empty-state"><span class="em">🌤️</span>אין משימות כרגע.<br>כתוב לי בשיחה, למשל: "תזכיר לי מחר ב-10 להתקשר לבנק"</div>`);
  requestAnimationFrame(() => document.querySelectorAll('.rc-bar i[data-pct]').forEach(b => { b.style.width = b.dataset.pct + '%'; }));
  const lateN = tasksOpen().filter(isLate).length;
  $('#lateBadge').hidden = !lateN; $('#lateBadge').textContent = lateN;
  drawUnread();
}
// החלקה של שורה הצידה ← מחיקה (עם "↩️ בטל")
(() => {
  let row = null, x0 = 0, y0 = 0, dx = 0;
  const list = $('#taskList');
  list.addEventListener('touchstart', e => { row = e.target.closest('.row[data-id]'); if (!row) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; row.style.transition = 'none'; }, { passive: true });
  list.addEventListener('touchmove', e => {
    if (!row) return; const d = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
    if (!dx && Math.abs(dy) > Math.abs(d)) { row = null; return; }
    dx = d; row.style.transform = `translateX(${dx}px)`; row.classList.toggle('swipe-del', Math.abs(dx) > 90);
  }, { passive: true });
  list.addEventListener('touchend', async () => {
    if (!row) return; const r = row, id = r.dataset.id; row = null;
    r.style.transition = 'transform .2s';
    if (Math.abs(dx) > 90) { r.style.transform = ''; r.classList.remove('swipe-del'); askRemove(id); }
    else { r.style.transform = ''; r.classList.remove('swipe-del'); }
  });
})();
$h('#catFilter').addEventListener('click', e => { const b = e.target.closest('[data-cf]'); if (b) { S.catF = b.dataset.cf || null; renderTasks(); } });
$h('#whoFilter').addEventListener('click', e => { const b = e.target.closest('[data-w]'); if (b) { S.who = b.dataset.w; renderTasks(); } });
$h('#taskList').addEventListener('click', async e => {
  const op = e.target.closest('[data-op]')?.dataset.op, id = e.target.closest('.row')?.dataset.id;
  if (!op || !id) return;
  const it = S.items.find(x => x.id === id);
  if (op === 'check') e.target.closest('.cb')?.classList.add('pop');
  if (op === 'check') return isDoneToday(it) && !(it.repeat && it.status === 'open' && !isToday(it.lastDone)) ? OPS.undoDone(id) : markDone(id, true).then(() => toast('✅ ' + it.text));
  if (op === 'edit') return openEdit(id);
  if (op === 'star') return OPS.star(id);
  if (op === 'del') return askRemove(id);
  if (op === 'prog') { // 🔢 עוד אחד: 2/5 → 3/5. בסוף — בוצע
    it.prog = { ...it.prog, n: Math.min(it.prog.of, (it.prog.n || 0) + 1) }; await save(it);
    if (it.prog.n >= it.prog.of) { await markDone(id, true); if (it.repeat) { it.prog.n = 0; await save(it); } toast(`🎉 ${it.text}: ${it.prog.of}/${it.prog.of}`); } else { toast(`🔢 ${it.prog.n}/${it.prog.of}`); renderTasks(); }
    return;
  }
  if (op === 'conf') return openConflict(id);
  if (op === 'assign') return openAssign(id);
  if (op === 'bump') return bumpTask(id);
  if (op === 'comments') return openComments(id);
});

// 🎬 אנימציית כניסה: הכרטיסים "קופצים" אחד אחרי השני — רק כשנכנסים למסך, לא בכל עדכון
function enterAnim(el) { if (!el) return; el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); clearTimeout(el._en); el._en = setTimeout(() => el.classList.remove('enter'), 900); }
// מספר שעולה מ-0 (למשל רצף ימים, בוצעו השבוע)
function countUp(el, to, pre = '') {
  if (!el) return; to = +to || 0;
  if (document.documentElement.classList.contains('no-anim') || to < 2) { el.textContent = pre + to; return; }
  const t0 = performance.now(), d = 900;
  const step = t => { const k = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - k, 3); el.textContent = pre + Math.round(to * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
// ⚙️ תצוגה: גודל טקסט ואנימציות (לכל מכשיר)
// 📱 מסך הפתיחה — לבחירה, לכל טלפון בנפרד
const startView = () => { try { const v = localStorage.getItem('zman-start'); return ['chat', 'cal', 'tasks', 'shop'].includes(v) ? v : 'chat'; } catch { return 'chat'; } };
function drawViewCard() {
  const el = $('#viewCard'); if (!el) return;
  const font = document.documentElement.dataset.font || 'm', anim = !document.documentElement.classList.contains('no-anim');
  el.innerHTML = `<h4>🎨 תצוגה</h4>
    <div class="set-row"><span>🔠 גודל כתב</span><span class="chips" style="padding:0;gap:4px">${[['m', 'רגיל', 14], ['l', 'גדול', 16], ['xl', 'ענק', 18]].map(([k, l, px]) => `<button class="chip ${font === k ? 'on' : ''}" data-font="${k}" aria-pressed="${font === k}" style="font-size:${px}px">א ${l}</button>`).join('')}</span></div>
    <div class="set-row"><span>🎬 אנימציות</span><span class="chips" style="padding:0;gap:4px">${[['on', '✨ פועל'], ['off', '⏸️ כבוי']].map(([k, l]) => `<button class="chip ${(k === 'on') === anim ? 'on' : ''}" data-anim="${k}">${l}</button>`).join('')}</span></div>
    <div class="set-row" style="display:block"><span>📱 מסך הפתיחה</span><div class="chips" style="padding:8px 0 0;flex-wrap:wrap">${[['chat', '💬 שיחה'], ['cal', '📅 יומן'], ['tasks', '📋 משימות'], ['shop', '🛒 קניות']].map(([k, l]) => `<button class="chip ${startView() === k ? 'on' : ''}" data-sv="${k}">${l}</button>`).join('')}</div></div>
    <p class="note">נשמר בטלפון הזה בלבד.</p>`;
  el.querySelectorAll('[data-sv]').forEach(b => b.onclick = () => { try { localStorage.setItem('zman-start', b.dataset.sv); } catch { /* */ } drawViewCard(); toast(`📱 מעכשיו האפליקציה נפתחת ב${b.textContent}`); });
  el.querySelectorAll('[data-font]').forEach(b => b.onclick = () => { const f = b.dataset.font; if (f === 'm') delete document.documentElement.dataset.font; else document.documentElement.dataset.font = f; try { localStorage.setItem('zman-font', f === 'm' ? '' : f); } catch { /* */ } drawViewCard(); toast('🔠 גודל הכתב עודכן'); });
  el.querySelectorAll('[data-anim]').forEach(b => b.onclick = () => { const on = b.dataset.anim === 'on'; document.documentElement.classList.toggle('no-anim', !on); try { localStorage.setItem('zman-anim', on ? 'on' : 'off'); } catch { /* */ } drawViewCard(); if (on) confetti(30); toast(on ? '✨ האנימציות פועלות' : '⏸️ האנימציות כבויות'); });
}

// 🎨 צבע לכל בן משפחה — מסונכרן לכולם. כל אחד משנה את שלו, מנהל גם ל"רק שם"
const canColor = pid => { const p = person(pid); if (!p) return false; if (pid === S.myP) return true; return p.nicks.some(n => groupOf(n.g)?.myRole === 'admin'); };
function openColorPick(pid) {
  const p = person(pid); if (!p) return;
  if (!S.uid) return toast('צריך להיות מחובר', true);
  if (!canColor(pid)) return toast('רק מנהל הקבוצה (או האדם עצמו) יכול לשנות צבע', true);
  sheet(`<h3>🎨 הצבע של ${esc(p.id === S.myP ? 'אני' : pName(pid))}</h3><p class="note">המשימות והאירועים שלו/ה יופיעו בצבע הזה — אצל כולם.</p>
    <div class="col-grid" id="cpGrid" style="margin-top:10px">${CAT_COLORS.map(c => `<button type="button" class="${c === colorOf(pid) ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="צבע ${c}"></button>`).join('')}</div>`);
  pickChips($('#cpGrid'), 'data-c', async c => {
    const mid = p.nicks.find(n => pid === S.myP || groupOf(n.g)?.myRole === 'admin')?.mid || p.nicks[0]?.mid;
    try { await sync.setColor(mid, c); buildPeople(); closeSheet(); renderAll(); renderFamily(); drawCalCard(); toast('🎨 נשמר'); } catch (x) { toast(x.message, true); }
  });
}

// 💬 תגובות על משימה — שרשור קטן, עם הודעה למי שרשם ולמי שהמשימה בשבילו
function openComments(id) {
  const it = item(id); if (!it) return;
  const list = it.comments || [];
  sheet(`<h3>💬 ${esc(it.text)}</h3>
    <div class="cm-list" id="cmList">${list.length ? list.map(c => { const p = person(c.p), mine = c.p === S.myP;
      return `<div class="cm ${mine ? 'mine' : ''}" style="--c:${colorOf(c.p)}"><b>${esc(mine ? 'אני' : p ? pName(p.id) : 'מישהו')}</b>${esc(c.text)}<i>${ago(c.at)}</i></div>`; }).join('')
      : '<div class="empty-state" style="padding:14px"><span class="em">💬</span>עוד אין תגובות. אפשר לשאול, לעדכן או להוסיף פרט.</div>'}</div>
    <div style="display:flex;gap:8px;margin-top:10px"><input id="cmText" placeholder="כתוב תגובה…" maxlength="300" enterkeyhint="send" style="flex:1"><button class="round mic" id="cmSend" aria-label="שליחה" style="width:46px;height:46px;font-size:18px">➤</button></div>`);
  const box = $('#cmList'); box.scrollTop = box.scrollHeight;
  const go = async () => {
    const text = $('#cmText').value.trim(); if (!text) return;
    if (!S.uid) return toast('צריך להיות מחובר כדי להגיב', true);
    it.comments = [...(it.comments || []), { id: db.newId(), p: S.myP, at: new Date().toISOString(), text: text.slice(0, 300) }];
    await save(it); renderAll();
    const gid = it.group_id;
    for (const uid of new Set([it.by, it.forU].filter(u => u && u !== S.uid))) await queueNotify(uid, 'comment', `💬 ${nameIn(S.myP, gid)} הגיב/ה על "${it.text.slice(0, 40)}"`, text, it.id + ':' + it.comments.length);
    openComments(id);
  };
  $('#cmSend').onclick = go;
  $('#cmText').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) go(); };
  setTimeout(() => $('#cmText')?.focus(), 300);
}

// 🛒 רשימת קניות משותפת לקבוצה, לפי מחלקות בסופר
const shopGid = () => S.shopG !== undefined ? S.shopG : (defGroup()?.id || null);
// 🏪 רשימות בשמות חופשיים (טמבור, ירקן, סופר…): כל רשימה היא פריט shoplist בקבוצה. בלי רשימה = "🛒 קניות" הרגילה
const shopLists = gid => S.items.filter(x => x.kind === 'shoplist' && x.status !== 'deleted' && (x.group_id || null) === (gid || null)).sort((a, b) => (a.created || '').localeCompare(b.created || ''));
const shopLid = gid => { const l = S.shopL?.[gid || ''] || null; return l && shopLists(gid).some(x => x.id === l) ? l : null; };
const shopOf = (gid, lid = shopLid(gid)) => S.items.filter(x => x.kind === 'shop' && x.status !== 'deleted' && (x.group_id || null) === (gid || null) && (x.list || null) === (lid || null));
async function addShop(texts, gid = shopGid(), lid = shopLid(gid)) {
  const have = shopOf(gid, lid).filter(x => x.status === 'open').map(x => x.text.trim());
  const added = [];
  for (const t of texts) {
    if (have.includes(t)) continue;
    const it = { id: db.newId(), kind: 'shop', text: t.slice(0, 60), dept: guessDept(t), list: lid || null, status: 'open', created: new Date().toISOString(), group_id: gid || null, private: !gid, forP: null, forU: null, due: null, hasTime: false, repeat: null };
    S.items.push(it); await save(it); added.push(it);
  }
  renderShop(); return added;
}
function renderShop() {
  const el = $('#shopList'); if (!el || !$('#v-shop').classList.contains('on')) return;
  const gs = S.uid ? sync.myGroups().filter(g => g.kind !== 'pair' || g.members.length > 1) : [];
  const gid = shopGid();
  $('#shopWho').hidden = !gs.length;
  $('#shopWho').innerHTML = [[null, '🔒 רק שלי'], ...gs.map(g => [g.id, gLabel(g)])].map(([id, l]) => `<button class="chip ${(gid || null) === id ? 'on' : ''}" data-sg="${id || ''}">${esc(l)}</button>`).join('');
  const lid = shopLid(gid), lists = shopLists(gid);
  const cnt = l => S.items.filter(x => x.kind === 'shop' && x.status === 'open' && (x.group_id || null) === (gid || null) && (x.list || null) === l).length;
  $('#shopLists').innerHTML = [`<button class="chip ${!lid ? 'on' : ''}" data-sl="">🛒 קניות${cnt(null) ? ` <small>${cnt(null)}</small>` : ''}</button>`,
    ...lists.map(l => `<button class="chip ${lid === l.id ? 'on' : ''}" data-sl="${l.id}">${esc(l.icon || '🏪')} ${esc(l.text)}${cnt(l.id) ? ` <small>${cnt(l.id)}</small>` : ''}</button>`),
    '<button class="chip sl-new" data-sl="+">➕ רשימה חדשה</button>', lid ? '<button class="chip" data-sl="edit" aria-label="עריכת הרשימה">✏️</button>' : ''].join('');
  $('#menuBtn').parentElement.hidden = !!lid; // תפריט שבת — רק ברשימת הקניות הרגילה
  $('#shopTitle').textContent = lid ? `${lists.find(l => l.id === lid)?.icon || '🏪'} ${lists.find(l => l.id === lid)?.text}` : 'רשימת קניות 🛒';
  $('#shopIn').placeholder = lid ? `מה צריך ב${lists.find(l => l.id === lid)?.text}? למשל: מסמרים, צבע` : 'למשל: חלב, ביצים, עגבניות';
  const list = shopOf(gid, lid), open = list.filter(x => x.status === 'open'), done = list.filter(x => x.status === 'done');
  const row = x => `<div class="shop-row${x.status === 'done' ? ' done' : ''}" data-id="${x.id}"><button class="cb" data-sop="check" aria-label="${x.status === 'done' ? 'החזר לרשימה' : 'נקנה'}">${x.status === 'done' ? '✓' : ''}</button><span class="sh-t" data-sop="edit">${esc(x.text)}${S.freshShop?.has(x.id) || isUnread(x) ? '<i class="new-dot">חדש</i>' : ''}</span>${x.by && x.by !== S.uid ? `<i class="sh-by" style="background:${colorOf(personOfUid(x.by)?.id)}" title="${esc(personOfUid(x.by)?.name || '')}"></i>` : ''}</div>`;
  el.innerHTML = (open.length ? DEPTS.map(([id, ic, name]) => { const l = open.filter(x => (x.dept || 'other') === id); return l.length ? `<div class="card"><h4>${ic} ${name}<small>${l.length}</small></h4>${l.map(row).join('')}</div>` : ''; }).join('')
    : `<div class="empty-state"><span class="em">🛒</span>הרשימה ריקה.<br>כותבים למעלה, או בצ'אט: "קניות: חלב, ביצים, לחם"</div>`)
    + (done.length ? `<div class="card"><h4>✅ בעגלה<small>${done.length}</small></h4>${done.map(row).join('')}<button class="btn" id="shopClear" style="margin-top:8px">🧹 לנקות את מה שנקנה</button></div>` : '');
  $('#shopClear')?.addEventListener('click', async e => {
    if (!tapAgain(e.currentTarget, '🧹 בטוח? לחץ שוב')) return;
    for (const x of done) { x.status = 'deleted'; await save(x); } renderShop(); toast('🧹 נוקה');
  });
}
$h('#shopWho').onclick = e => { const b = e.target.closest('[data-sg]'); if (!b) return; S.shopG = b.dataset.sg || null; renderShop(); };
const SL_ICONS = ['🏪', '🛒', '🔨', '🥬', '💊', '🧸', '👕', '📚', '🧹', '🎁', '🐟', '🍞', '🌸', '⛽', '🖥️', '🧴'];
function openShopList(l) {
  const gid = shopGid(); let icon = l?.icon || '🏪';
  sheet(`<h3>${l ? '✏️ עריכת רשימה' : '➕ רשימה חדשה'}</h3>
    <label>שם הרשימה</label><input id="slN" maxlength="30" value="${esc(l?.text || '')}" placeholder="למשל: טמבור, ירקן, בית מרקחת">
    <label>אייקון</label><div class="ic-grid" id="slI">${SL_ICONS.map(x => `<button type="button" class="${x === icon ? 'on' : ''}" data-i="${x}">${x}</button>`).join('')}</div>
    <p class="note" style="margin-top:8px">מה שמוסיפים כשהרשימה פתוחה נכנס אליה, ומסתדר בה לפי מחלקות.${gid ? ' כולם בקבוצה רואים אותה.' : ''}</p>
    <button class="btn pri" id="slS" style="margin-top:12px">💾 שמור</button>${l ? '<button class="btn danger" id="slD">🗑️ מחיקת הרשימה</button>' : ''}`);
  pickChips($('#slI'), 'data-i', v => { icon = v; });
  $('#slS').onclick = async () => {
    const text = $('#slN').value.trim(); if (!text) return toast('צריך שם לרשימה', true);
    const it = l || { id: db.newId(), kind: 'shoplist', status: 'open', created: new Date().toISOString(), group_id: gid || null, private: !gid, forP: null, forU: null, due: null, hasTime: false, repeat: null };
    Object.assign(it, { text, icon }); if (!l) S.items.push(it); await save(it);
    S.shopL = { ...(S.shopL || {}), [gid || '']: it.id }; closeSheet(); renderShop(); toast(l ? '💾 נשמר' : `🏪 נפתחה הרשימה "${text}"`);
  };
  $('#slD')?.addEventListener('click', () => {
    const n = shopOf(gid, l.id).length;
    sheet(`<h3>🗑️ למחוק את "${esc(l.text)}"?</h3><p class="note" style="margin-bottom:12px">${n ? `גם ${n} הפריטים שבה יימחקו.` : 'הרשימה ריקה.'}</p><button class="btn danger" id="slY">🗑️ כן, למחוק</button><button class="btn" id="slNo">ביטול</button>`);
    $('#slNo').onclick = closeSheet;
    $('#slY').onclick = async () => { for (const x of shopOf(gid, l.id)) { x.status = 'deleted'; await save(x); } l.status = 'deleted'; await save(l); S.shopL = { ...(S.shopL || {}), [gid || '']: null }; closeSheet(); renderShop(); toast('🗑️ הרשימה נמחקה'); };
  });
}
$h('#shopLists').onclick = e => {
  const b = e.target.closest('[data-sl]'); if (!b) return; const v = b.dataset.sl, gid = shopGid();
  if (v === '+') return openShopList(null);
  if (v === 'edit') return openShopList(item(shopLid(gid)));
  S.shopL = { ...(S.shopL || {}), [gid || '']: v || null }; renderShop();
};
const shopGo = async () => {
  const v = $('#shopIn').value.trim(); if (!v) return;
  const parts = shopItems('קניות: ' + v, !!shopLid(shopGid())) || [v];
  $('#shopIn').value = ''; const a = await addShop(parts);
  if (a.length) toast(`🛒 נוסף${a.length > 1 ? 'ו ' + a.length : ''}`); else toast('כבר ברשימה');
};
$h('#shopAdd').onclick = shopGo;
$h('#menuBtn').onclick = () => openMenu();
$h('#shopIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) shopGo(); });
$h('#shopList').addEventListener('click', async e => {
  const op = e.target.closest('[data-sop]')?.dataset.sop, id = e.target.closest('[data-id]')?.dataset.id, x = id && item(id);
  if (!op || !x) return;
  if (op === 'check') { x.status = x.status === 'done' ? 'open' : 'done'; x.doneAt = x.status === 'done' ? new Date().toISOString() : null; await save(x); e.target.closest('.cb')?.classList.add('pop'); setTimeout(renderShop, 180); return; }
  sheet(`<h3>🛒 ${esc(x.text)}</h3><label>שם</label><input id="shN" value="${esc(x.text)}" maxlength="60"><label>מחלקה</label>
    <div class="chips" id="shD" style="padding:0;flex-wrap:wrap">${DEPTS.map(([d, ic, n]) => `<button class="chip ${(x.dept || 'other') === d ? 'on' : ''}" data-d="${d}">${ic} ${n}</button>`).join('')}</div>
    <button class="btn pri" id="shSave" style="margin-top:14px">💾 שמור</button><button class="btn danger" id="shDel">🗑️ להוריד מהרשימה</button>`);
  let dep = x.dept || 'other';
  pickChips($('#shD'), 'data-d', v => { dep = v; });
  $('#shSave').onclick = async () => { x.text = $('#shN').value.trim() || x.text; x.dept = dep; await save(x); closeSheet(); renderShop(); };
  $('#shDel').onclick = async () => { x.status = 'deleted'; await save(x); closeSheet(); renderShop(); toast('🗑️ הוסר', false, { l: '↩️ בטל', run: async () => { x.status = 'open'; await save(x); renderShop(); } }); };
});

// 📋 תבניות + פירוק משימה גדולה לשלבים
const TEMPLATES = [
  { id: 'shabbat', ic: '🕯️', name: 'הכנות לשבת', steps: ['קניות לשבת', 'לבשל', 'להכין חלות', 'לנקות את הבית', 'לערוך שולחן', 'להפעיל פלטה ומיחם', 'שעון שבת', 'בגדי שבת', 'הדלקת נרות'] },
  { id: 'pesach', ic: '🧹', name: 'ניקיון פסח', steps: ['חדרי שינה', 'סלון', 'ארונות בגדים', 'המכונית', 'ארונות מטבח', 'מקרר', 'תנור וכיריים', 'להכשיר כיורים', 'להחליף כלים', 'מכירת חמץ', 'בדיקת חמץ', 'ביעור חמץ'] },
  { id: 'simcha', ic: '🎉', name: 'חתונה / שמחה', steps: ['לבחור תאריך', 'אולם', 'רשימת מוזמנים', 'צלם', 'תזמורת / די־ג׳יי', 'הזמנות להדפסה', 'לשלוח הזמנות', 'בגדים', 'איפור ושיער', 'אישורי הגעה', 'סידורי הושבה'] },
  { id: 'school', ic: '🎒', name: 'חזרה ללימודים', steps: ['רשימת ציוד', 'ספרים', 'מחברות וכלי כתיבה', 'תיק', 'בגדים ונעליים', 'לעטוף ספרים', 'מדבקות שם', 'תשלומי הורים', 'הסעות'] },
];
const allTemplates = () => TEMPLATES.concat((S.templates || []).map(t => ({ ...t, mine: true })));
const mkSteps = arr => arr.map(t => ({ id: db.newId(), text: t, done: false }));
const stepsLbl = it => it.steps?.length ? `📝 ${it.steps.filter(x => x.done).length}/${it.steps.length}` : '';
function openSteps(id) {
  const it = item(id); if (!it) return;
  const st = it.steps || [], n = st.filter(x => x.done).length;
  sheet(`<h3>📝 ${esc(it.text)}</h3>
    ${st.length ? `<div class="bar" style="margin:4px 0 10px"><i style="width:${n / st.length * 100}%"></i></div><p class="note">${n} מתוך ${st.length} שלבים</p>` : '<p class="note">מפרקים משימה גדולה לצעדים קטנים. כל צעד מסמנים כשגומרים.</p>'}
    <div id="stList">${st.map(x => `<div class="shop-row${x.done ? ' done' : ''}" data-s="${x.id}"><button class="cb" data-st="check">${x.done ? '✓' : ''}</button><span class="sh-t">${esc(x.text)}</span><button class="star on" data-st="del" aria-label="מחיקה">✕</button></div>`).join('')}</div>
    <div style="display:flex;gap:8px;margin-top:10px"><input id="stIn" placeholder="שלב חדש…" maxlength="80" enterkeyhint="done" style="flex:1"><button class="round mic" id="stAdd" aria-label="הוספה" style="width:46px;height:46px;font-size:20px">＋</button></div>
    ${st.length ? '<button class="btn" id="stTpl" style="margin-top:12px">💾 לשמור כתבנית</button>' : ''}`);
  const re = () => { renderAll(); openSteps(id); };
  const add = async () => { const v = $('#stIn').value.trim(); if (!v) return; it.steps = [...(it.steps || []), ...mkSteps(v.split(/\s*,\s*/).filter(Boolean))]; await save(it); re(); setTimeout(() => $('#stIn')?.focus(), 50); };
  $('#stAdd').onclick = add;
  $('#stIn').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) add(); };
  $('#stList').onclick = async e => {
    const op = e.target.closest('[data-st]')?.dataset.st, sid = e.target.closest('[data-s]')?.dataset.s; if (!op || !sid) return;
    if (op === 'del') it.steps = it.steps.filter(x => x.id !== sid);
    else { const x = it.steps.find(y => y.id === sid); x.done = !x.done; if (x.done) e.target.closest('.cb')?.classList.add('pop'); }
    await save(it);
    if (op === 'check' && it.steps.length && it.steps.every(x => x.done) && it.status === 'open') { confetti(90); closeSheet(); renderAll(); return toast('🏆 כל השלבים בוצעו!', false, { l: '✅ לסמן את המשימה', run: () => markDone(id) }); }
    setTimeout(re, op === 'check' ? 160 : 0);
  };
  $('#stTpl')?.addEventListener('click', async () => {
    S.templates = (S.templates || []).filter(t => t.name !== it.text).concat({ id: db.newId(), ic: '📋', name: it.text, steps: it.steps.map(x => x.text) });
    await db.setKV('templates', S.templates); toast('💾 נשמר כתבנית. תמצא אותה ב-➕ ← "📋 מתבנית"');
  });
}

// ---------- ⭐ ילדים: מטלות עם כוכבים, פרסים, והמרה לשקלים ב"כסף בכיף" ----------
const KESEF_URL = 'https://kesefbekef.github.io/';
const kidGroup = pid => person(pid)?.nicks.find(n => n.role === 'child')?.g || null;
const isKid = pid => !!kidGroup(pid);
const iAmKid = () => !!S.myP && isKid(S.myP) && !sync.myGroups().some(g => g.myRole !== 'child');
const parentOf = pid => { const g = groupOf(kidGroup(pid)); return !!g && g.myRole !== 'child'; };
const kidsList = () => iAmKid() ? [person(S.myP)] : S.people.filter(p => isKid(p.id) && parentOf(p.id));
const starsOf = pid => S.items.filter(x => x.kind === 'star' && x.kid === pid && x.status !== 'deleted').reduce((a, x) => a + (+x.n || 0), 0);
const prizesOf = gid => S.items.filter(x => x.kind === 'prize' && x.status !== 'deleted' && x.group_id === gid).sort((a, b) => a.cost - b.cost);
async function starEntry(pid, n, reason, id) {
  const p = person(pid); if (!p) return;
  const e = { id: id || db.newId(), kind: 'star', kid: pid, n, reason, status: 'open', created: new Date().toISOString(), group_id: kidGroup(pid), forP: pid, forU: p.uid || null, private: false, due: null, hasTime: false, repeat: null };
  const i = S.items.findIndex(x => x.id === e.id); if (i >= 0) S.items[i] = e; else S.items.push(e);
  await save(e); return e;
}
// מטלה עם כוכבים בוצעה → הכוכבים נכנסים (מזהה קבוע — לא נכנס פעמיים)
const starRef = it => `st-${it.id}${it.repeat ? '-' + ymd(new Date()) : ''}`;
async function creditStars(it) {
  if (!it.stars || !it.forP || it.forP === 'any') return;
  await starEntry(it.forP, +it.stars, `✅ ${it.text}`, starRef(it));
  toast(`⭐ +${it.stars} ל${pName(it.forP)}!`); confetti(40);
}
async function uncreditStars(it) { const e = item(starRef(it)); if (e) { e.status = 'deleted'; await save(e); } }
const starPicker = (sel = 0) => `<label>⭐ כוכבים על המטלה</label><div class="chips" id="stPick" style="padding:0">${[0, 1, 2, 3, 5, 10].map(n => `<button type="button" class="chip ${+sel === n ? 'on' : ''}" data-n="${n}">${n ? '⭐ ' + n : 'בלי'}</button>`).join('')}</div>`;

function renderKids() {
  const el = $('#kidList'); if (!el || !$('#v-kids').classList.contains('on')) return;
  const kids = kidsList();
  if (!kids.length) { el.innerHTML = `<div class="empty-state"><span class="em">⭐</span>עוד אין ילדים בקבוצה.<br>⚙️ ← הקבוצות שלי ← ילד מצטרף עם "קוד לילד", או "➕ רק שם (בלי טלפון)".</div>`; return; }
  el.innerHTML = kids.map(k => {
    const n = starsOf(k.id), gid = kidGroup(k.id), prizes = prizesOf(gid), next = prizes.find(p => p.cost > n), par = parentOf(k.id);
    const chores = S.items.filter(x => x.status === 'open' && isTask(x) && x.forP === k.id && x.stars).slice(0, 8);
    const hist = S.items.filter(x => x.kind === 'star' && x.kid === k.id && x.status !== 'deleted').sort((a, b) => b.created.localeCompare(a.created)).slice(0, 4);
    return `<div class="card kid" style="--c:${colorOf(k.id)}" data-kid="${k.id}">
      <div class="kid-h"><span class="kid-face">${esc(k.e)}</span><b>${esc(k.id === S.myP ? 'אני' : pName(k.id))}</b><span class="kid-stars">⭐ <b data-count="${n}">${n}</b></span></div>
      ${next ? `<div class="bar"><i style="width:${Math.min(100, n / next.cost * 100)}%"></i></div><p class="note">עוד ${next.cost - n} ⭐ ל${esc(next.icon || '🎁')} ${esc(next.text)}</p>` : prizes.length ? '<p class="note">🎉 אפשר לבחור כל פרס!</p>' : ''}
      ${chores.length ? `<div class="h">מטלות פתוחות</div>${chores.map(x => `<div class="shop-row" data-id="${x.id}"><button class="cb" data-kop="done" aria-label="בוצע"></button><span class="sh-t">${esc(x.text)}</span><b class="st-n">⭐${x.stars}</b></div>`).join('')}` : '<p class="note">אין מטלות פתוחות.</p>'}
      ${hist.length ? `<div class="h">לאחרונה</div>${hist.map(h => `<div class="kid-hist"><span>${esc(h.reason || '')}</span><b dir="ltr" class="${h.n < 0 ? 'neg' : ''}">${h.n > 0 ? '+' : ''}${h.n}⭐</b></div>`).join('')}` : ''}
      ${par ? `<div class="chips" style="padding:10px 0 0;flex-wrap:wrap"><button class="chip" data-kop="chore">➕ מטלה</button><button class="chip" data-kop="bonus">✨ בונוס</button><button class="chip" data-kop="prize">🎁 לתת פרס</button></div>
        <button class="btn" data-kop="cash" style="margin-top:8px">⭐ להמיר לשקלים בכסף בכיף</button>` : ''}
    </div>`;
  }).join('') + prizeCard();
  el.querySelectorAll('[data-count]').forEach(b => countUp(b, b.dataset.count));
}
function prizeCard() {
  const gids = [...new Set(kidsList().map(k => kidGroup(k.id)))];
  return gids.map(gid => { const pr = prizesOf(gid), par = groupOf(gid)?.myRole !== 'child';
    return `<div class="card"><h4>🎁 פרסים${gids.length > 1 ? ' · ' + esc(groupOf(gid)?.name || '') : ''}</h4>
      ${pr.length ? pr.map(p => `<div class="set-row"><span>${esc(p.icon || '🎁')} ${esc(p.text)}</span><span><b>⭐ ${p.cost}</b>${par ? ` <button class="act" data-pz="${p.id}">✏️</button>` : ''}</span></div>`).join('') : '<p class="note">עוד אין פרסים. הורים מוסיפים פרסים, והילדים אוספים כוכבים.</p>'}
      ${par ? `<button class="btn" data-pznew="${gid}">➕ פרס חדש</button>` : ''}</div>`; }).join('');
}
function openPrize(gid, p) {
  sheet(`<h3>${p ? '✏️ עריכת פרס' : '🎁 פרס חדש'}</h3><label>מה הפרס</label><input id="pzN" maxlength="40" value="${esc(p?.text || '')}" placeholder="למשל: גלידה, שעה מחשב, טיול">
    <label>אייקון</label><div class="ic-grid" id="pzI">${['🎁', '🍦', '🍕', '🎮', '📱', '🧸', '🎬', '🏊', '🚲', '📚', '🍫', '⭐', '🎡', '🛝', '🎨', '⚽'].map(x => `<button type="button" class="${x === (p?.icon || '🎁') ? 'on' : ''}" data-i="${x}">${x}</button>`).join('')}</div>
    <label>כמה כוכבים</label><input id="pzC" type="number" min="1" max="500" value="${p?.cost || 10}">
    <button class="btn pri" id="pzS" style="margin-top:14px">💾 שמור</button>${p ? '<button class="btn danger" id="pzD">🗑️ מחיקה</button>' : ''}`);
  let icon = p?.icon || '🎁'; pickChips($('#pzI'), 'data-i', v => { icon = v; });
  $('#pzS').onclick = async () => {
    const text = $('#pzN').value.trim(), cost = Math.max(1, +$('#pzC').value || 1); if (!text) return toast('צריך שם לפרס', true);
    const it = p || { id: db.newId(), kind: 'prize', status: 'open', created: new Date().toISOString(), group_id: gid, private: false, due: null, hasTime: false, repeat: null };
    Object.assign(it, { text, icon, cost }); if (!p) S.items.push(it); await save(it); closeSheet(); renderKids(); toast('🎁 נשמר');
  };
  $('#pzD')?.addEventListener('click', async e => { if (!tapAgain(e.currentTarget, '🗑️ בטוח? לחץ שוב')) return; p.status = 'deleted'; await save(p); closeSheet(); renderKids(); });
}
$h('#kidList').addEventListener('click', async e => {
  const pz = e.target.closest('[data-pz]'); if (pz) return openPrize(item(pz.dataset.pz).group_id, item(pz.dataset.pz));
  const pn = e.target.closest('[data-pznew]'); if (pn) return openPrize(pn.dataset.pznew, null);
  const op = e.target.closest('[data-kop]')?.dataset.kop, kid = e.target.closest('[data-kid]')?.dataset.kid; if (!op || !kid) return;
  const name = pName(kid);
  if (op === 'done') { e.target.closest('.cb')?.classList.add('pop'); await markDone(e.target.closest('[data-id]').dataset.id, true); return renderKids(); }
  if (op === 'chore') return openQuick({ forP: kid, kind: 'task', stars: 1 });
  if (op === 'bonus') {
    sheet(`<h3>✨ בונוס ל${esc(name)}</h3><label>על מה (לא חובה)</label><input id="bnR" maxlength="40" placeholder="למשל: עזר בלי שביקשו">${starPicker(1)}<button class="btn pri" id="bnS" style="margin-top:14px">⭐ לתת</button>`);
    let n = 1; pickChips($('#stPick'), 'data-n', v => { n = +v; });
    $('#bnS').onclick = async () => { if (!n) return closeSheet(); await starEntry(kid, n, `✨ ${$('#bnR').value.trim() || 'בונוס'}`); closeSheet(); confetti(40); renderKids(); toast(`⭐ +${n} ל${name}`); };
    return;
  }
  if (op === 'prize') {
    const have = starsOf(kid), pr = prizesOf(kidGroup(kid));
    if (!pr.length) return openPrize(kidGroup(kid), null);
    sheet(`<h3>🎁 פרס ל${esc(name)}</h3><p class="note">יש ל${esc(name)} ⭐ ${have}</p>${pr.map(p => `<button class="btn ${p.cost <= have ? 'pri' : ''}" data-give="${p.id}" ${p.cost > have ? 'disabled style="opacity:.5"' : ''}>${esc(p.icon || '🎁')} ${esc(p.text)} · ⭐ ${p.cost}</button>`).join('')}`);
    $('#sheet').onclick = async ev => { const b = ev.target.closest('[data-give]'); if (!b) return; const p = item(b.dataset.give); $('#sheet').onclick = null; await starEntry(kid, -p.cost, `🎁 ${p.text}`); closeSheet(); confetti(120); renderKids(); toast(`🎉 ${name} קיבל/ה ${p.text}!`); };
    return;
  }
  if (op === 'cash') {
    const have = starsOf(kid); if (have <= 0) return toast(`ל${name} אין כוכבים להמרה`, true);
    if (demo.DEMO) return toast('🎭 בהדגמה לא שולחים באמת לכסף בכיף');
    window.open(`${KESEF_URL}?stars=${have}&kid=${encodeURIComponent(name)}`, '_blank', 'noopener');
    sheet(`<h3>⭐ המרה לשקלים</h3><p class="note">נפתח "כסף בכיף" עם ⭐ ${have} של ${esc(name)}. אחרי שאישרת שם —</p><button class="btn pri" id="csY">✅ המרתי — לאפס את הכוכבים כאן</button><button class="btn" id="csN">עוד לא</button>`);
    $('#csY').onclick = async () => { await starEntry(kid, -have, '💰 הומר לשקלים בכסף בכיף'); closeSheet(); renderKids(); toast('💰 הכוכבים הומרו'); };
    $('#csN').onclick = closeSheet;
  }
});

// ---------- 🔥 הרגלים עם רצף ----------
const HABIT_ICONS = ['💧', '📖', '🏃', '🧘', '🙏', '🦷', '🥗', '😴', '💊', '🚶', '✍️', '🎸', '🧹', '📵', '🍎', '⭐'];
const habits = () => S.items.filter(x => x.kind === 'habit' && x.status === 'open');
const habitDue = (h, d) => !h.dows?.length || h.dows.includes(d.getDay());
// 💧 הרגל עם ספירה (8 כוסות): ביומן נשמר מספר. בלי יעד — true כמו קודם
const habitGoal = h => Math.max(1, +h.goal || 1);
const habitCount = (h, d) => { const v = h.log?.[ymd(d)]; return v === true ? habitGoal(h) : +v || 0; };
const habitDone = (h, d) => habitCount(h, d) >= habitGoal(h);
// כמה פעמים בטקסט: "לשתות 8 כוסות מים" → 8
const goalOf = t => { const m = String(t || '').match(/(?:^|\s)(\d{1,2})\s*(?:כוסות|פעמים|כוס|דפים|עמודים|פרקים|סטים|חזרות|דקות של)?(?=\s|$)/); return m && +m[1] > 1 && +m[1] <= 30 && /כוס|פעמ|דפ|עמוד|פרק|סט|חזר/.test(t) ? +m[1] : null; };
function habitStreak(h) {
  let n = 0, d = sod(new Date());
  if (habitDue(h, d) && habitDone(h, d)) n++;
  for (let i = 1; i < 400; i++) {
    d = addDays(sod(new Date()), -i);
    if (+d < +sod(new Date(h.created))) break;
    if (!habitDue(h, d)) continue;
    if (habitDone(h, d)) n++; else break;
  }
  return n;
}
// ---------- 🔁 הקבועים שלי (כמו "🔁 הקבועים שלי" בכסף בכיף) ----------
const recurs = () => S.items.filter(x => x.repeat && ['open', 'paused'].includes(x.status) && x.kind !== 'habit' && byMe(x))
  .sort((a, b) => (b.med ? 1 : 0) - (a.med ? 1 : 0) || (a.status === 'paused') - (b.status === 'paused') || new Date(a.due || 0) - new Date(b.due || 0));
function recurCard() {
  const rs = recurs();
  return `<div class="card recur" id="recurCard"><h4>🔁 הקבועים שלי<button class="act" id="rcNew" style="margin-inline-start:auto">➕ קבוע</button></h4>
    ${rs.length ? rs.map(it => {
      const st = doseStats(it), pz = it.status === 'paused';
      const pct = st?.total ? Math.round(100 * st.expected / st.total) : null;
      return `<div class="rc-row${pz ? ' off' : ''}" data-rc="${it.id}">
        <div class="rc-top"><span class="rc-ic">${it.med ? '💊' : esc(it.icon || '🔁')}</span><span class="rc-t" data-rop="edit">${esc(it.text)}<small>${esc(whenLabel(it))}${pz ? ' · ⏸️ מושהה' : it.due ? ' · הבא: ' + esc(whenLabel1(it)) : ''}</small></span>
        <span class="rc-acts"><button class="act" data-rop="${pz ? 'resume' : 'pause'}" aria-label="${pz ? 'המשך' : 'השהיה'}">${pz ? '▶️' : '⏸️'}</button><button class="act" data-rop="stop" aria-label="עצירה">⏹️</button></span></div>
        ${it.med || it.repeat.until ? `<div class="rc-info">${st?.daysLeft != null ? `<b class="rc-left">${it.med ? '💊 ' : ''}נשארו ${st.daysLeft === 1 ? 'יום אחד' : st.daysLeft + ' ימים'}</b>` : '<b class="rc-left">♾️ ללא סוף</b>'}${it.med && st?.expected ? `<span>לקחת ${st.taken}/${st.expected} מנות</span>` : ''}${it.med && it.shabbatOk ? '<span>🕯️ גם בשבת</span>' : ''}</div>` : ''}
        ${pct != null ? `<div class="bar rc-bar"><i data-pct="${pct}" style="width:0"></i></div>` : ''}</div>`; }).join('')
      : '<p class="note">תרופות ודברים שחוזרים: "אנטיביוטיקה 3 פעמים ביום ל־10 ימים", "ויטמין D כל יום למשך חודשיים", "להחליף פילטר כל חצי שנה". כשנגמר הזמן, זה נעצר לבד.</p>'}</div>`;
}
document.addEventListener('click', async e => {
  if (e.target.closest('#rcNew')) return openRecur(null);
  const op = e.target.closest('[data-rop]')?.dataset.rop, id = e.target.closest('[data-rc]')?.dataset.rc; if (!op || !id) return;
  const it = S.items.find(x => x.id === id); if (!it) return;
  if (op === 'edit') return openRecur(it);
  if (op === 'pause') { it.status = 'paused'; it.askAt = null; await save(it); renderTasks(); return toast('⏸️ מושהה. התזכורות לא יגיעו עד שתמשיכו'); }
  if (op === 'resume') { const d = new Date(it.due || Date.now()); it.status = 'open'; it.due = nextOccurrence(it.repeat, d.getHours(), d.getMinutes(), new Date())?.toISOString() || null; it.askedKey = null; it.nag = 0; await save(it); renderTasks(); return toast('▶️ ממשיכים'); }
  if (op === 'stop') {
    const b = e.target.closest('button'); if (!tapAgain(b, '⏹️ לעצור?')) return;
    it.status = 'done'; it.ended = true; it.doneAt = new Date().toISOString(); await save(it); renderAll();
    toast('⏹️ נעצר', false, { l: '↩️ בטל', run: async () => { it.status = 'open'; it.ended = false; await save(it); renderAll(); } });
  }
});
// טופס "🔁 קבוע": איך חוזר, באילו שעות, לכמה זמן, תרופה, גם בשבת
const RC_TYPES = [['daily', 'כל יום'], ['days', 'כל כמה ימים'], ['weekly', 'כל שבוע'], ['monthly', 'כל חודש'], ['half', 'כל חצי שנה'], ['yearly', 'כל שנה']];
const RC_DUR = [['', '♾️ ללא סוף'], ['d10', '10 ימים'], ['d7', 'שבוע'], ['m1', 'חודש'], ['m2', 'חודשיים'], ['custom', '✏️ אחר'], ['date', '📅 עד תאריך']];
function openRecur(it, pre = {}) {
  const r = it?.repeat || {};
  let type = r.type === 'months' && r.n === 6 ? 'half' : ['daily', 'days', 'weekly', 'monthly', 'yearly'].includes(r.type) ? r.type : 'daily';
  let med = it ? !!it.med : MED_RE.test(' ' + (pre.text || '') + ' ');
  let shab = it ? it.shabbatOk !== false && (it.shabbatOk || it.med) : med;
  const dows = new Set(r.dows || [new Date().getDay()]);
  let times = r.times?.length ? [...r.times] : [it?.due && it.hasTime ? hm(new Date(it.due)) : pre.time || '09:00'];
  let dur = r.until ? 'date' : '';
  const start = r.start || ymd(new Date());
  sheet(`<h3>${it ? '✏️ עריכת קבוע' : '🔁 קבוע חדש'}</h3>
    <label>מה</label><input id="rcText" value="${esc(it?.text || pre.text || '')}" placeholder="למשל: אנטיביוטיקה / ויטמין D / להחליף פילטר">
    <label class="set-row" style="cursor:pointer;border:none;padding:8px 0 0"><span>💊 זו תרופה</span><input type="checkbox" id="rcMed" ${med ? 'checked' : ''}></label>
    <p class="note">בתרופה: כפתור "✅ לקחתי" בהתראה, ותזכורת שוב אחרי 10 דקות אם לא אישרת.</p>
    <label>איך חוזר</label><div class="chips" id="rcType" style="padding:0;flex-wrap:wrap">${RC_TYPES.map(([k, l]) => `<button class="chip ${k === type ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
    <div id="rcDaysN" hidden><label>כל כמה ימים</label><input type="number" id="rcN" min="2" max="60" value="${r.type === 'days' ? r.n : 2}" class="num" style="width:90px"></div>
    <div id="rcDows" hidden><label>באילו ימים</label><div class="chips" style="padding:0;flex-wrap:wrap">${DAYS.map((d, i) => `<button class="chip ${dows.has(i) ? 'on' : ''}" data-d="${i}">${d}</button>`).join('')}</div></div>
    <label>באילו שעות</label><div id="rcTimes" class="rc-times"></div>
    <div class="chips" style="padding:6px 0 0;flex-wrap:wrap"><button class="chip" id="rcAddT">➕ עוד שעה</button><button class="chip" data-tp="2">פעמיים ביום</button><button class="chip" data-tp="3">3 פעמים</button><button class="chip" data-tp="8h">כל 8 שעות</button></div>
    <label>מתחיל</label><input type="date" id="rcStart" value="${start}">
    <label>לכמה זמן</label><div class="chips" id="rcDur" style="padding:0;flex-wrap:wrap">${RC_DUR.map(([k, l]) => `<button class="chip ${k === dur ? 'on' : ''}" data-u="${k}">${l}</button>`).join('')}</div>
    <div id="rcCustom" class="two" hidden style="margin-top:8px"><input type="number" id="rcCn" min="1" max="365" value="14"><select id="rcCu" class="sel"><option value="d">ימים</option><option value="w">שבועות</option><option value="m">חודשים</option></select></div>
    <input type="date" id="rcUntil" hidden style="margin-top:8px" value="${r.until || ymd(addDays(new Date(), 9))}">
    <label class="set-row" style="cursor:pointer;border:none;padding:10px 0 0"><span>🕯️ להזכיר גם בשבת ובחג</span><input type="checkbox" id="rcShab" ${shab ? 'checked' : ''}></label>
    <p class="note" id="rcSum" style="margin-top:6px"></p>
    <button class="btn pri" id="rcSave" style="margin-top:12px">💾 שמור</button>
    ${it ? `<div class="two"><button class="btn" id="rcPause">${it.status === 'paused' ? '▶️ להמשיך' : '⏸️ השהיה'}</button><button class="btn danger" id="rcStop">⏹️ לעצור</button></div>` : '<button class="btn" id="rcCancel">ביטול</button>'}`);
  const drawTimes = () => {
    $('#rcTimes').innerHTML = times.map((t, i) => `<span class="rc-time"><input type="time" value="${t}" data-ti="${i}">${times.length > 1 ? `<button class="act" data-tx="${i}" aria-label="הסרת שעה">✕</button>` : ''}</span>`).join('');
  };
  const build = () => {
    const rp = type === 'half' ? { type: 'months', n: 6 } : type === 'days' ? { type: 'days', n: Math.max(2, +$('#rcN').value || 2) } : type === 'weekly' ? { type: 'weekly', dows: [...dows].sort() } : type === 'monthly' ? { type: 'monthly', dom: new Date($('#rcStart').value + 'T00:00').getDate() } : { type };
    const ts = [...new Set(times.filter(Boolean))].sort(); if (ts.length > 1) rp.times = ts;
    rp.start = $('#rcStart').value || ymd(new Date());
    const st = new Date(rp.start + 'T00:00'), cu = $('#rcCu').value, cn = Math.max(1, +$('#rcCn').value || 1);
    const addM = n => { const x = new Date(st); x.setMonth(x.getMonth() + n); return addDays(x, -1); };
    const end = dur === 'd10' ? addDays(st, 9) : dur === 'd7' ? addDays(st, 6) : dur === 'm1' ? addM(1) : dur === 'm2' ? addM(2) : dur === 'custom' ? (cu === 'm' ? addM(cn) : addDays(st, cn * (cu === 'w' ? 7 : 1) - 1)) : dur === 'date' ? new Date($('#rcUntil').value + 'T00:00') : null;
    if (end && !isNaN(end)) rp.until = ymd(end);
    return { rp, ts };
  };
  const summary = () => {
    $('#rcDaysN').hidden = type !== 'days'; $('#rcDows').hidden = type !== 'weekly';
    $('#rcCustom').hidden = dur !== 'custom'; $('#rcUntil').hidden = dur !== 'date';
    const { rp, ts } = build(), [h, m] = ts[0].split(':').map(Number);
    const fake = { repeat: rp, due: nextOccurrence(rp, h, m, new Date(Math.max(Date.now(), +new Date(rp.start + 'T00:00') - 1)))?.toISOString(), hasTime: true, created: new Date().toISOString() };
    const stt = doseStats(fake, new Date(rp.start + 'T23:59'));
    $('#rcSum').textContent = `📋 ${whenLabel(fake)}${fake.due ? ` · הראשון: ${whenLabel1(fake)}` : ''}${rp.until && stt?.total ? ` · סה"כ ${stt.total} פעמים, ואז נעצר לבד` : rp.until ? '' : ' · ללא סוף'}`;
  };
  drawTimes(); summary();
  $('#rcMed').onchange = e => { med = e.target.checked; if (med) $('#rcShab').checked = true; };
  pickChips($('#rcType'), 'data-k', v => { type = v; summary(); });
  pickChips($('#rcDur'), 'data-u', v => { dur = v; summary(); });
  $('#rcDows').onclick = e => { const b = e.target.closest('[data-d]'); if (!b) return; const i = +b.dataset.d; if (dows.has(i) && dows.size > 1) dows.delete(i); else dows.add(i); b.classList.toggle('on', dows.has(i)); summary(); };
  $('#rcTimes').addEventListener('change', e => { const i = e.target.dataset.ti; if (i != null) { times[+i] = e.target.value; summary(); } });
  $('#rcTimes').addEventListener('click', e => { const x = e.target.closest('[data-tx]'); if (!x) return; times.splice(+x.dataset.tx, 1); drawTimes(); summary(); });
  $('#rcAddT').onclick = () => { times.push(times.length ? hm(new Date(new Date('2000-01-01T' + times[times.length - 1]).getTime() + 6 * 3600e3)) : '09:00'); drawTimes(); summary(); };
  $('#sheet').querySelectorAll('[data-tp]').forEach(b => b.onclick = () => { const v = b.dataset.tp; times = v === '2' ? ['08:00', '20:00'] : v === '3' ? ['08:00', '14:00', '20:00'] : ['08:00', '16:00', '00:00']; drawTimes(); summary(); });
  ['rcN', 'rcStart', 'rcCn', 'rcCu', 'rcUntil'].forEach(k => $('#' + k).addEventListener('change', summary));
  $('#rcCancel')?.addEventListener('click', closeSheet);
  $('#rcPause')?.addEventListener('click', () => { closeSheet(); document.querySelector(`[data-rc="${it.id}"] [data-rop="${it.status === 'paused' ? 'resume' : 'pause'}"]`)?.click() || (it.status === 'paused' ? (it.status = 'open') : (it.status = 'paused'), save(it).then(renderAll)); });
  $('#rcStop')?.addEventListener('click', async e => { if (!tapAgain(e.currentTarget, '⏹️ בטוח? לחץ שוב')) return; it.status = 'done'; it.ended = true; it.doneAt = new Date().toISOString(); await save(it); closeSheet(); renderAll(); toast('⏹️ נעצר'); });
  $('#rcSave').onclick = async () => {
    const text = $('#rcText').value.trim(); if (!text) return toast('צריך לכתוב מה', true);
    const { rp, ts } = build(), [h, m] = ts[0].split(':').map(Number);
    if (rp.until && rp.until < rp.start) return toast('התאריך האחרון לפני ההתחלה', true);
    const due = nextOccurrence(rp, h, m, new Date(Math.max(Date.now() - 60e3, +new Date(rp.start + 'T00:00') - 1)));
    if (!due) return toast('אין אף פעם בטווח הזה', true);
    const shabbatOk = $('#rcShab').checked;
    closeSheet();
    if (it) {
      Object.assign(it, { text, repeat: rp, due: due.toISOString(), hasTime: true, med: med || null, shabbatOk, icon: med ? '💊' : it.icon === '💊' ? null : it.icon, askAt: null, askedKey: null, nag: 0 });
      if (it.status !== 'paused') it.status = 'open'; it.ended = false;
      await save(it); renderAll(); toast('💾 נשמר');
    } else {
      showView('chat');
      await createItem({ kind: 'task', text, due, hasTime: true, repeat: rp, med, shabbatOk, private: false, group: null, cat: med ? 'health' : null }, null);
    }
  };
}
function habitsCard() {
  const hs = habits();
  return `<div class="card habits"><h4>🔥 הרגלים · היום<button class="act" id="hbNew" style="margin-inline-start:auto">➕ הרגל</button></h4>
    ${hs.length ? hs.map(h => { const today = habitDue(h, new Date()), done = habitDone(h, new Date()), st = habitStreak(h), g = habitGoal(h), n = habitCount(h, new Date());
      // [ − ] 3/8 [ + ] יחד, ו-+ פועם כדי שיבינו שלוחצים עליו בכל פעם
      const cnt = g > 1 && today ? `<span class="hb-cnt" dir="ltr"><button class="hb-btn hb-minus" data-hop="minus" ${n ? '' : 'disabled'} aria-label="אחד פחות">−</button><b class="hb-n">${n}/${g}</b><button class="hb-btn hb-plus${done ? '' : ' pulse'}" data-hop="tick" aria-label="עוד אחד">${done ? '✓' : '+'}</button></span>` : g > 1 ? `<b class="hb-n" dir="ltr">${n}/${g}</b>` : '';
      const dots = g > 1 && g <= 12 ? `<span class="hb-dots">${Array.from({ length: g }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>` : '';
      const hint = g > 1 && today && !n ? `<small class="hb-hint">👉 לוחצים <b>+</b> על כל ${/כוס/.test(h.text) ? 'כוס' : 'פעם'}</small>` : '';
      return `<div class="hb-row${done ? ' done' : ''}${today ? '' : ' off'}" data-h="${h.id}">${g > 1 ? `<span class="hb-ic">${esc(h.icon || '⭐')}</span>` : `<button class="cb" data-hop="tick" ${today ? '' : 'disabled'} aria-label="${done ? 'בטל' : 'עשיתי היום'}">${done ? '✓' : ''}</button>`}<span class="sh-t" data-hop="edit">${g > 1 ? '' : esc(h.icon || '⭐') + ' '}${esc(h.text)}${today ? '' : ' <small>(לא היום)</small>'}${dots}${hint}</span>${cnt}<b class="hb-st" title="ימים ברצף">🔥${st}</b></div>`; }).join('')
      : '<p class="note">משהו קטן שרוצים לעשות כל יום (או בימים מסוימים): לשתות מים, לקרוא 10 דקות, הליכה. מסמנים כל יום — והרצף 🔥 גדל.</p>'}</div>`;
}
async function tickHabit(id, btn, minus) {
  const h = item(id); if (!h) return;
  const k = ymd(new Date()), g = habitGoal(h), was = habitCount(h, new Date()); h.log = { ...(h.log || {}) };
  if (g > 1) { // עוד כוס: 3/8 → 4/8. בסוף, לחיצה נוספת מאפסת
    if (!minus && was >= g) return toast(`✓ ${g}/${g} — כל הכבוד! (− כדי להוריד)`);
    const n = minus ? Math.max(0, was - 1) : was + 1;
    if (n) h.log[k] = n; else delete h.log[k];
    btn?.classList.add('pop'); if (!minus && n && n < g) toast(`${h.icon || '💧'} ${n}/${g}`);
  } else if (h.log[k]) delete h.log[k]; else { h.log[k] = true; btn?.classList.add('pop'); }
  // ניקיון: שומרים רק שנה אחורה
  const old = ymd(addDays(new Date(), -400)); for (const d of Object.keys(h.log)) if (d < old) delete h.log[d];
  await save(h);
  const st = habitStreak(h);
  if (habitDone(h, new Date()) && !(g > 1 && was >= g)) { if ([3, 7, 14, 21, 30, 50, 100, 200, 365].includes(st)) { confetti(140); toast(`🔥 ${st} ימים ברצף! אלוף/ה`); } else toast(`🔥 ${st} ${st === 1 ? 'יום' : 'ימים'} ברצף`); }
  renderTasks();
}
function openHabit(h, preText) {
  let icon = h?.icon || '💧'; const dows = new Set(h?.dows || []);
  sheet(`<h3>${h ? '✏️ עריכת הרגל' : '🔥 הרגל חדש'}</h3><label>מה</label><input id="hbN" maxlength="50" value="${esc(h?.text || preText || '')}" placeholder="למשל: לשתות 8 כוסות מים">
    <label>אייקון</label><div class="ic-grid" id="hbI">${HABIT_ICONS.map(x => `<button type="button" class="${x === icon ? 'on' : ''}" data-i="${x}">${x}</button>`).join('')}</div>
    <label>💧 כמה פעמים ביום (למשל 8 כוסות). 1 = פעם אחת</label><input type="number" id="hbG" min="1" max="30" value="${h ? habitGoal(h) : goalOf(preText) || 1}" class="num" style="width:90px">
    <label>באילו ימים (בלי בחירה = כל יום)</label><div class="chips" id="hbD" style="padding:0;flex-wrap:wrap">${DAYS.map((d, i) => `<button type="button" class="chip ${dows.has(i) ? 'on' : ''}" data-d="${i}">${d}</button>`).join('')}</div>
    <button class="btn pri" id="hbS" style="margin-top:14px">💾 שמור</button>${h ? '<button class="btn danger" id="hbX">🗑️ מחיקת ההרגל</button>' : ''}`);
  pickChips($('#hbI'), 'data-i', v => { icon = v; });
  $('#hbD').onclick = e => { const b = e.target.closest('[data-d]'); if (!b) return; const i = +b.dataset.d; if (dows.has(i)) dows.delete(i); else dows.add(i); b.classList.toggle('on', dows.has(i)); };
  $('#hbS').onclick = async () => {
    const text = $('#hbN').value.trim(); if (!text) return toast('צריך לכתוב מה', true);
    const it = h || { id: db.newId(), kind: 'habit', status: 'open', created: new Date().toISOString(), log: {}, group_id: null, private: true, due: null, hasTime: false, repeat: null };
    const goal = Math.min(30, Math.max(1, +$('#hbG').value || 1));
    Object.assign(it, { text, icon, goal: goal > 1 ? goal : null, dows: dows.size && dows.size < 7 ? [...dows].sort() : null });
    if (!h) S.items.push(it); await save(it); closeSheet(); showView('tasks'); renderTasks(); toast(h ? '💾 נשמר' : '🔥 הרגל חדש! מסמנים כל יום');
  };
  $('#hbX')?.addEventListener('click', async e => { if (!tapAgain(e.currentTarget, '🗑️ בטוח? לחץ שוב')) return; h.status = 'deleted'; await save(h); closeSheet(); renderTasks(); });
}
$h('#v-tasks').addEventListener('click', e => {
  if (e.target.closest('#hbNew')) return openHabit(null);
  const op = e.target.closest('[data-hop]')?.dataset.hop, id = e.target.closest('[data-h]')?.dataset.h; if (!op || !id) return;
  if (op === 'tick') return tickHabit(id, e.target.closest('.cb'));
  if (op === 'minus') return tickHabit(id, null, true);
  openHabit(item(id));
});

// ---------- ⏱️ טיימר פוקוס: 25 דקות עבודה, 5 הפסקה, ובסוף "סיימת?" ----------
// ⏱️ כמה זמן עבודה וכמה הפסקה — בוחרים לפני שמתחילים (נשמר לפעם הבאה)
const fMin = () => S.settings.focusWork || 25, bMin = () => S.settings.focusBreak ?? 5;
// ⏱️ טיימר מה־➕: בוחרים על איזו משימה (או כותבים חדשה)
function pickFocusTask() {
  const list = rankForToday(tasksOpen().filter(x => x.kind === 'task')).slice(0, 12);
  sheet(`<h3>⏱️ טיימר פוקוס — על מה?</h3>
    ${list.length ? `<div id="ftList">${list.map(x => `<div class="pick" data-id="${x.id}"><div class="ck">⏱️</div>${esc(x.text)}<small>${esc(whenLabel(x))}</small></div>`).join('')}</div>` : '<p class="note">אין משימות פתוחות.</p>'}
    <label>או משהו חדש</label><div style="display:flex;gap:8px"><input id="ftNew" placeholder="למשל: לסדר את המחסן"><button class="round mic" id="ftGo" style="width:46px;height:46px;font-size:18px" aria-label="להתחיל">▶️</button></div>`);
  $('#ftList')?.addEventListener('click', e => { const id = e.target.closest('.pick')?.dataset.id; if (id) openFocusPick(id); });
  $('#ftGo').onclick = async () => {
    const text = $('#ftNew').value.trim(); if (!text) return toast('צריך לכתוב על מה', true);
    const it = { id: db.newId(), kind: 'task', text, due: sod(new Date()).toISOString(), hasTime: false, repeat: null, status: 'open', created: new Date().toISOString() };
    S.items.push(it); await save(it); await addLog(it, 'created'); openFocusPick(it.id);
  };
}
function openFocusPick(id) {
  const it = item(id); if (!it) return;
  let w = fMin(), b = bMin();
  const chips = (arr, cur, attr, lbl) => `<div class="chips" style="padding:0;flex-wrap:wrap">${arr.map(x => `<button class="chip ${x === cur ? 'on' : ''}" ${attr}="${x}">${lbl(x)}</button>`).join('')}</div>`;
  sheet(`<h3>⏱️ טיימר פוקוס</h3><p class="note" style="margin-bottom:6px">על: <b>${esc(it.text)}</b></p>
    <label>כמה זמן לעבוד</label>${chips([10, 15, 25, 30, 45, 60, 90], w, 'data-fw', x => durLbl(x))}
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px"><span class="note">או בדיוק:</span><input type="number" id="fwN" min="1" max="240" class="num" style="width:90px" value="${w}"><span class="note">דקות</span></div>
    <label>הפסקה אחרי</label>${chips([0, 5, 10, 15, 20], b, 'data-fb', x => x ? durLbl(x) : 'בלי הפסקה')}
    <button class="btn pri" id="fGo" style="margin-top:14px">▶️ להתחיל</button>`);
  pickChips($('#sheet').querySelector('[data-fw]').parentElement, 'data-fw', v => { w = +v; $('#fwN').value = v; });
  pickChips($('#sheet').querySelector('[data-fb]').parentElement, 'data-fb', v => { b = +v; });
  $('#fwN').oninput = e => { w = Math.min(240, Math.max(1, +e.target.value || 25)); };
  $('#fGo').onclick = async () => { S.settings.focusWork = w; S.settings.focusBreak = b; await db.setKV('settings', S.settings); startFocus(id, 'work'); };
}
let focusT = null;
async function startFocus(id, phase = 'work') {
  const it = item(id); if (!it) return;
  const mins = phase === 'work' ? fMin() : bMin(), now = Date.now();
  S.focus = { id, phase, start: now, end: now + mins * 60e3 };
  await db.setKV('focus', S.focus);
  if (S.uid) queueNotify(S.uid, 'task', phase === 'work' ? `⏱️ ${fMin()} דקות עברו` : '☕ ההפסקה נגמרה', phase === 'work' ? `סיימת את "${it.text}"?` : `חוזרים ל"${it.text}"?`, `focus:${id}:${now}`);
  closeSheet(); drawFocus(true);
}
function drawFocus(open) {
  const f = S.focus, el = $('#focus');
  clearInterval(focusT);
  if (!f) { el.hidden = true; $('#focusPill').hidden = true; return; }
  const it = item(f.id), total = f.end - f.start;
  if (open !== undefined) S.focusOpen = open;
  el.hidden = !S.focusOpen; $('#focusPill').hidden = S.focusOpen;
  $('#fcTitle').textContent = it?.text || '';
  $('#fcPhase').textContent = f.phase === 'work' ? '⏱️ זמן פוקוס' : '☕ הפסקה';
  el.classList.toggle('brk', f.phase !== 'work');
  const step = () => {
    const left = Math.max(0, f.end - Date.now()), mm = Math.floor(left / 60e3), ss = Math.floor(left / 1000) % 60, t = `${mm}:${String(ss).padStart(2, '0')}`;
    $('#fcTime').textContent = t; $('#focusPill').textContent = `${f.phase === 'work' ? '⏱️' : '☕'} ${t}`;
    $('#fcRing').style.strokeDashoffset = String(565.5 * (1 - left / total));
    if (!left) { clearInterval(focusT); endFocus(); }
  };
  step(); focusT = setInterval(step, 1000);
}
async function endFocus() {
  const f = S.focus; if (!f) return;
  S.focus = null; await db.setKV('focus', null); drawFocus();
  const it = item(f.id); if (!it) return;
  buzz();
  if (f.phase === 'work') {
    confetti(40); showView('chat');
    await bot('⏱️', 'var(--g5)', `${fMin()} דקות על "${it.text}" 💪`, 'סיימת?', [
      { l: '✅ סיימתי', op: 'done', a: [it.id], pri: true }, ...(bMin() ? [{ l: `☕ הפסקה ${bMin()} דק׳`, op: 'focusBreak', a: [it.id] }] : []), { l: `⏱️ עוד ${fMin()}`, op: 'focusAgain', a: [it.id] }]);
  } else {
    showView('chat');
    await bot('☕', 'var(--g2)', 'ההפסקה נגמרה', `חוזרים ל"${it.text}"?`, [{ l: `⏱️ עוד ${fMin()}`, op: 'focusAgain', a: [it.id], pri: true }, { l: '✅ כבר סיימתי', op: 'done', a: [it.id] }]);
  }
}
async function stopFocus() {
  if (!S.focus) return;
  S.focus = null; await db.setKV('focus', null); drawFocus(); toast('⏹️ הטיימר נעצר');
}
$h('#fcStop').onclick = e => { if (tapAgain(e.currentTarget, '⏹️ לעצור? לחץ שוב')) stopFocus(); };
$h('#fcHide').onclick = () => drawFocus(false);
$h('#focusPill').onclick = () => drawFocus(true);
$h('#fcDone').onclick = async () => { const f = S.focus; if (!f) return; S.focus = null; await db.setKV('focus', null); drawFocus(); await markDone(f.id); };

// 🕐 ציר היום: פס קטן במסך הראשי — מה יש היום לפי שעות, וקו "עכשיו"
function renderDayline() {
  const el = $('#dayline'); if (!el) return;
  const t0 = sod(new Date()), from = 7, to = 23, span = (to - from) * 36e5;
  const ev = calEvents(t0, addDays(t0, 1)).filter(e => e.hasTime && (e.owner === S.myP || !S.uid));
  const pos = t => Math.max(0, Math.min(100, (+t - +t0 - from * 36e5) / span * 100));
  const nowP = pos(Date.now());
  el.hidden = false;
  el.innerHTML = `<div class="dl-h"><b>🕐 היום שלי</b><small>${ev.length ? `${ev.length} ${ev.length === 1 ? 'דבר' : 'דברים'} עם שעה` : 'אין כלום עם שעה — יום פנוי 🌤️'}</small></div>
    <div class="dl-bar">${ev.map(e => { const a = pos(e.start), b = pos(Math.max(+e.end, +e.start + 30 * 60e3)); return `<i class="${e.done ? 'done' : ''}" style="right:${a}%;width:${Math.max(2.5, b - a)}%;background:${e.cat?.color || e.color}" title="${esc(hm(e.start) + ' ' + e.text)}"></i>`; }).join('')}
      ${nowP > 0 && nowP < 100 ? `<b class="dl-now" style="right:${nowP}%"></b>` : ''}</div>
    <div class="dl-t"><span>7:00</span><span>12:00</span><span>17:00</span><span>23:00</span></div>
    ${ev.filter(e => !e.done && +e.start > Date.now()).slice(0, 1).map(e => `<div class="dl-next">הבא: <b>${hm(e.start)}</b> ${esc(e.ext ? '📅' : e.it?.icon || '')} ${esc(e.text)}</div>`).join('')}`;
}
$h('#dayline').onclick = () => { CAL.day = sod(new Date()); CAL.mode = 'day'; showView('cal'); };

// ---------- 🍲 תפריט שבת → רשימת קניות ----------
const DISHES = {
  'חלות': ['קמח', 'שמרים', 'סוכר', 'ביצים', 'שמן', 'מלח'], 'דג חריימה': ['פילה דג', 'רסק עגבניות', 'פלפל אדום', 'שום', 'פפריקה'],
  'מרק עוף': ['עוף למרק', 'גזר', 'בצל', 'סלרי', 'קישוא', 'תפוחי אדמה', 'אבקת מרק'], 'עוף בתנור': ['עוף', 'תפוחי אדמה', 'בצל', 'שום', 'פפריקה', 'שמן'],
  'צ׳ולנט': ['בשר לצ׳ולנט', 'תפוחי אדמה', 'שעועית', 'גריסים', 'ביצים', 'בצל'], 'קוגל אטריות': ['אטריות', 'ביצים', 'סוכר', 'שמן'],
  'קוגל תפו"א': ['תפוחי אדמה', 'בצל', 'ביצים', 'שמן'], 'סלט ירקות': ['עגבניות', 'מלפפונים', 'בצל', 'פלפל', 'לימון'],
  'חומוס וטחינה': ['חומוס', 'טחינה', 'לימון'], 'סלט כרוב': ['כרוב', 'מיונז', 'גזר'], 'אורז': ['אורז', 'שמן'], 'פשטידה': ['ביצים', 'גבינה', 'קמח', 'ירקות'],
  'עוגה': ['קמח', 'סוכר', 'ביצים', 'שמן', 'אבקת אפיה', 'קקאו'], 'יין ומיץ ענבים': ['יין לקידוש', 'מיץ ענבים'], 'שניצל': ['חזה עוף', 'פירורי לחם', 'ביצים', 'שמן'],
};
const MEALS = [['fri', '🕯️ ליל שבת', ['חלות', 'יין ומיץ ענבים', 'דג חריימה', 'מרק עוף', 'עוף בתנור', 'סלט ירקות']], ['day', '☀️ סעודת שחרית', ['חלות', 'צ׳ולנט', 'קוגל אטריות', 'סלט ירקות']], ['third', '🌅 סעודה שלישית', ['חלות', 'חומוס וטחינה', 'סלט ירקות']]];
const dishIng = n => (S.dishes || {})[n] || DISHES[n] || null;
async function openMenu() {
  S.menu ||= await db.getKV('shabMenu', null) || Object.fromEntries(MEALS.map(([k, , d]) => [k, [...d]]));
  S.dishes ||= await db.getKV('dishes', {});
  const all = [...new Set([...Object.keys(DISHES), ...Object.keys(S.dishes)])];
  sheet(`<h3>🍲 תפריט שבת</h3>
    <div class="mn-how" aria-label="איך זה עובד: בוחרים מנות, רואים את המצרכים, ומכניסים לרשימת הקניות">
      <div class="mn-st s1"><b>1</b><span>🍲</span>בוחרים מנות<small>ליל שבת, שחרית, סעודה שלישית</small></div><i class="mn-ar">←</i>
      <div class="mn-st s2"><b>2</b><span>🥕🧅🍗</span>המצרכים מחושבים לבד<small>מכל המנות יחד</small></div><i class="mn-ar">←</i>
      <div class="mn-st s3"><b>3</b><span>🛒</span>לחיצה אחת ← לרשימה<small>מסודר לפי מחלקות</small></div>
    </div>
    <p class="note">לחיצה על מנה (✕) מוציאה אותה. ➕ מוסיף מנה, ואפשר גם מנה משלכם עם המצרכים שלה.</p>
    ${MEALS.map(([k, l]) => `<label>${l}</label><div class="chips" style="padding:0;flex-wrap:wrap">${S.menu[k].map((d, i) => `<button class="chip on" data-mk="${k}" data-mi="${i}" title="להסיר">${esc(d)} ✕</button>`).join('')}<button class="chip" data-madd="${k}">➕</button></div>`).join('')}
    <button class="btn pri" id="mnShop" style="margin-top:14px">🛒 להוסיף את המצרכים לרשימה</button>
    <button class="btn" id="mnReset">↺ להתחיל מהתפריט הרגיל</button>`);
  const saveMenu = async () => { await db.setKV('shabMenu', S.menu); openMenu(); };
  $('#sheet').querySelectorAll('[data-mk]').forEach(b => b.onclick = async () => { S.menu[b.dataset.mk].splice(+b.dataset.mi, 1); await saveMenu(); });
  $('#sheet').querySelectorAll('[data-madd]').forEach(b => b.onclick = () => {
    const k = b.dataset.madd;
    sheet(`<h3>➕ מנה ל${MEALS.find(m => m[0] === k)[1]}</h3><div class="chips" style="padding:0;flex-wrap:wrap">${all.filter(d => !S.menu[k].includes(d)).map(d => `<button class="chip" data-dish="${esc(d)}">${esc(d)}</button>`).join('')}</div>
      <label>או מנה משלך</label><input id="mnName" maxlength="30" placeholder="למשל: סלט חצילים"><label>המצרכים (מופרדים בפסיק)</label><input id="mnIng" maxlength="200" placeholder="חצילים, טחינה, שום, לימון">
      <button class="btn pri" id="mnAdd" style="margin-top:12px">➕ להוסיף</button><button class="btn" id="mnBack">חזרה</button>`);
    $('#sheet').querySelectorAll('[data-dish]').forEach(x => x.onclick = async () => { S.menu[k].push(x.dataset.dish); await saveMenu(); });
    $('#mnBack').onclick = openMenu;
    $('#mnAdd').onclick = async () => {
      const n = $('#mnName').value.trim(); if (!n) return toast('צריך שם למנה', true);
      const ing = $('#mnIng').value.split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);
      if (ing.length) { S.dishes[n] = ing; await db.setKV('dishes', S.dishes); }
      S.menu[k].push(n); await saveMenu();
    };
  });
  $('#mnReset').onclick = async () => { S.menu = Object.fromEntries(MEALS.map(([k, , d]) => [k, [...d]])); await saveMenu(); };
  $('#mnShop').onclick = async () => {
    const ing = [...new Set(Object.values(S.menu).flat().flatMap(d => dishIng(d) || [d]))];
    const added = await addShop(ing);
    closeSheet(); showView('shop'); confetti(50);
    toast(added.length ? `🛒 נוספו ${added.length} מצרכים לרשימה` : 'הכל כבר ברשימה 👍');
  };
}

// ---------- 🔗 חיבור לכסף בכיף ----------
// משימת תשלום שבוצעה → "💰 לרשום בכסף בכיף" (נפתח עם הסכום והתיאור)
const PAY_RE = /(^|\s)(?:לשלם|תשלום|לשלם\s+את|חשבון|ארנונה|חשמל|ועד\s+בית|שכר\s+דירה|משכנתא|ביטוח|אגרה|קנס|דמי|שכר\s+לימוד|גננת|מנוי|לטעון)(?=\s|$)/;
function openToKesef(id) {
  const it = item(id); if (!it) return;
  sheet(`<h3>💰 לרשום בכסף בכיף</h3><p class="note">"${esc(it.text)}" — כמה שילמת? (אפשר גם להשאיר ריק ולמלא שם)</p>
    <input id="kfAmt" type="number" inputmode="decimal" min="0" placeholder="סכום ב-₪" style="margin-top:8px">
    <button class="btn pri" id="kfGo" style="margin-top:12px">💰 לפתוח בכסף בכיף</button>`);
  setTimeout(() => $('#kfAmt')?.focus(), 300);
  $('#kfGo').onclick = () => {
    const a = Math.max(0, +$('#kfAmt').value || 0);
    if (demo.DEMO) return toast('🎭 בהדגמה לא שולחים באמת לכסף בכיף');
    window.open(`${KESEF_URL}?${a ? 'add=' + a + '&' : 'add=&'}desc=${encodeURIComponent(it.text)}`, '_blank', 'noopener');
    closeSheet(); toast('💰 נפתח כסף בכיף — לוחצים שם "שמירה"');
  };
}
// קישור מבחוץ (למשל מכסף בכיף): ?task=...&date=YYYY-MM-DD&time=HH:MM → חלון אישור, ושום דבר לא נשמר בלי לחיצה
function deepLinkTask() {
  const q = new URLSearchParams(location.search), text = (q.get('task') || '').trim().slice(0, 120);
  if (!text) return;
  if ($('#gate').classList.contains('on') || $('#lock').classList.contains('on')) return setTimeout(deepLinkTask, 1000); // קודם כניסה / נעילה
  const ds = q.get('date') || '', ts = q.get('time') || '';
  const okD = /^\d{4}-\d{2}-\d{2}$/.test(ds), okT = /^\d{1,2}:\d{2}$/.test(ts);
  const due = okD ? new Date(ds + 'T00:00') : null; if (due && okT) { const [h, m] = ts.split(':'); due.setHours(+h, +m, 0, 0); }
  history.replaceState(null, '', location.pathname);
  sheet(`<h3>📅 להוסיף תזכורת?</h3><p style="font-size:17px;margin:8px 0"><b>${esc(text)}</b></p><p class="note">${due ? whenLabel({ due: due.toISOString(), hasTime: okT }) : 'בלי תאריך'}${q.get('from') === 'kesef' ? ' · מכסף בכיף 💰' : ''}</p>
    <button class="btn pri" id="dlY" style="margin-top:12px">📅 להוסיף</button><button class="btn" id="dlN">לא תודה</button>`);
  $('#dlN').onclick = closeSheet;
  $('#dlY').onclick = async () => { closeSheet(); showView('chat'); await createItem({ kind: 'task', text, due, hasTime: !!(due && okT), repeat: null, dur: okT ? 0 : null }, null); };
}

// ---------- 📆 יומן גוגל (סנכרון דו־כיווני דרך הענן) ----------
async function drawGcal() {
  const el = $('#gcalCard'); if (!el) return;
  if (!S.uid) { el.innerHTML = '<h4>📆 יומן גוגל</h4><p class="note">אחרי כניסה אפשר לחבר את יומן גוגל: מה שכאן מופיע שם, ומה ששם מופיע כאן.</p>'; return; }
  el.innerHTML = '<h4>📆 יומן גוגל</h4><p class="note">בודק…</p>';
  let st = null; try { st = await sync.gcalStatus(); } catch { el.innerHTML = '<h4>📆 יומן גוגל</h4><p class="note">צריך אינטרנט כדי לראות את מצב החיבור.</p>'; return; }
  if (!st?.connected) {
    el.innerHTML = `<h4>📆 יומן גוגל</h4><p class="note">מחברים פעם אחת, ומאז: פגישות ואירועים מכאן מופיעים ביומן גוגל, ומה שמוסיפים ביומן גוגל מופיע כאן — כל 10 דקות, לבד.</p>
      ${st && !st.connected && st.last_error ? '<p class="note" style="color:#FCA5A5">החיבור הקודם פג. צריך לחבר שוב.</p>' : ''}
      <button class="btn pri" id="gcOn">🔗 לחבר את יומן גוגל</button>
      <p class="note" style="margin-top:6px">בחלון של גוגל תופיע אזהרה "Google hasn't verified this app" — זה תקין (אפליקציה פרטית שלנו): לוחצים <b>Advanced</b> ← <b>Go to זמן בכיף</b>.</p>`;
    $('#gcOn').onclick = async () => { try { const n = await sync.gcalStart(); location.href = `${sync.GCAL_FN}?auth=${n}`; } catch (x) { toast(x.message, true); } };
    return;
  }
  const p = st.prefs || {};
  el.innerHTML = `<h4>📆 יומן גוגל <small>מחובר ✓</small></h4>
    <p class="note">${st.email ? `היומן של <b dir="ltr">${esc(st.email)}</b>. ` : ''}${st.last_sync ? `סונכרן ${ago(st.last_sync)}.` : 'הסנכרון הראשון בדרך…'}</p>
    ${st.last_error ? `<p class="note" style="color:#FCA5A5">⚠️ בעיה בסנכרון האחרון. ננסה שוב לבד.</p>` : ''}
    <p class="note" style="margin-top:8px">מה לשלוח ליומן גוגל:</p>
    ${[['events', '👥 פגישות ואירועים (משמרות, חוגים…)', p.events !== false], ['tasks', '⏰ משימות עם שעה', !!p.tasks], ['family', '👨‍👩‍👧 גם מה שבני המשפחה נתנו לי', !!p.family]].map(([k, l, on]) => `<label class="set-row" style="cursor:pointer"><span>${l}</span><input type="checkbox" data-gp="${k}" ${on ? 'checked' : ''}></label>`).join('')}
    <p class="note">ומה שביומן גוגל (90 יום קדימה) מופיע ביומן כאן עם 📆.</p>
    <div class="two" style="margin-top:10px"><button class="btn pri" id="gcSync" style="margin:0">🔄 לסנכרן עכשיו</button><button class="btn danger" id="gcOff" style="margin:0">🔌 לנתק</button></div>`;
  el.querySelectorAll('[data-gp]').forEach(c => c.onchange = async () => {
    const np = { events: p.events !== false, tasks: !!p.tasks, family: !!p.family, [c.dataset.gp]: c.checked };
    try { await sync.gcalPrefs(np); toast('נשמר ✓ — יעודכן בסנכרון הבא'); } catch (x) { toast(x.message, true); }
  });
  $('#gcSync').onclick = async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = '🔄 מסנכרן…';
    try { const r = await sync.gcalSync(); toast(`📆 סונכרן: ${r?.pushed || 0} נשלחו, ${r?.pulled || 0} הגיעו`); }
    catch (x) { toast('הסנכרון לא הצליח. ננסה שוב עוד מעט', true); }
    drawGcal();
  };
  $('#gcOff').onclick = async e => {
    if (!tapAgain(e.currentTarget, '🔌 בטוח? לחץ שוב')) return;
    try { await sync.gcalDisconnect(); toast('🔌 נותק. מה שכבר ביומן גוגל נשאר'); } catch (x) { toast(x.message, true); }
    drawGcal();
  };
}
// חזרה מגוגל: ?gcal=ok / cancel / ...
function gcalReturn() {
  const r = new URLSearchParams(location.search).get('gcal'); if (!r) return;
  history.replaceState(null, '', location.pathname);
  const msg = { ok: ['📆 יומן גוגל חובר! הסנכרון הראשון כבר רץ', false], cancel: ['החיבור בוטל. אפשר לנסות שוב בהגדרות', true], expired: ['עבר יותר מדי זמן. לוחצים שוב "לחבר"', true],
    norefresh: ['גוגל לא נתן הרשאה מלאה. מנתקים את "זמן בכיף" בחשבון גוגל ומחברים שוב', true], setup: ['החיבור לגוגל עוד לא מוכן. עוד רגע', true] }[r] || ['משהו השתבש בחיבור. נסה שוב', true];
  setTimeout(() => { showView('settings'); toast(msg[0], msg[1]); if (r === 'ok') confetti(90); $('#gcalCard')?.scrollIntoView({ block: 'center' }); }, 1200);
}

// ---------- 🧠 צ'אט חכם: משפט אחד → כמה אירועים ביומן ----------
const SHIFTS_DEF = { morning: ['07:00', '15:00'], evening: ['15:00', '23:00'], night: ['23:00', '07:00'] };
const shiftHours = () => ({ ...SHIFTS_DEF, ...(S.settings.shifts || {}) });
const smartNames = () => S.people.filter(p => p.id !== S.myP).flatMap(p => [{ id: p.id, name: p.name }, ...p.nicks.map(n => ({ id: p.id, name: n.nick }))]);
const dmy = d => `${d.getDate()}.${d.getMonth() + 1}`;
// מי בתוך "לנו": אני + המבוגרים האחרים בקבוצה הראשית (או בקשר הישיר)
function usTargets() {
  const g = defGroup() || sync.myGroups().find(x => x.kind === 'pair');
  const adults = (g?.members || []).filter(m => m.user_id && m.user_id !== S.uid && m.role !== 'child').map(m => 'u:' + m.user_id);
  return { list: [S.myP || null, ...adults], gid: g?.id || null };
}
async function createEvents(sm) {
  const whoP = sm.who === 'me' || !sm.who ? S.myP : sm.who;
  if (sm.missing === 'when') {
    const nm = whoP && whoP !== S.myP ? sm.whoName || pName(whoP) : '';
    if (sm.isShift) return bot('🏥', 'var(--g2)', `באילו ימים ואיזו משמרת${nm ? ' ל' + nm : ''}?`, 'בוחרים ימים ומשמרות, או כותבים למשל: "ראשון ערב, שני לילה"', [{ l: '📅 לבחור משמרות', op: 'pickShifts', a: [whoP || '', nm], pri: true }]);
    return bot(iconFor(sm.title), 'var(--g2)', `מתי ${sm.title}?`, nm ? `ייכנס ליומן של ${nm}` : 'ייכנס ליומן',
      [{ l: '📅 לבחור מתי', op: 'quickFor', a: [sm.title, whoP || ''], pri: true }]);
  }
  const us = sm.who === 'us' ? usTargets() : null;
  const targets = us ? us.list : [whoP];
  const ids = [];
  for (const tp of targets) for (const e of sm.events) {
    const other = tp && tp !== S.myP ? person(tp) : null;
    const it = { id: db.newId(), kind: 'meeting', event: true, icon: iconFor(e.title), text: e.title, due: e.due.toISOString(), hasTime: e.hasTime, dur: e.dur, repeat: e.repeat,
      status: 'open', created: new Date().toISOString(), askAt: null, askedKey: null, raw: null, forP: other?.id || null, forU: other?.uid || null, private: false,
      group_id: us ? us.gid : other ? (sharedGroup(other.id)?.id || null) : null, place: null, res: null, cat: null };
    S.items.push(it); await save(it); await addLog(it, 'created'); ids.push(it.id);
  }
  renderAll();
  const n = sm.events.length, noun = sm.isShift ? (n === 1 ? 'משמרת' : 'משמרות') : (n === 1 ? 'אירוע' : 'אירועים');
  const whose = us && targets.length > 1 ? (targets.length === 2 ? 'של שניכם' : 'של כולכם') : whoP && whoP !== S.myP ? `של ${sm.whoName || pName(whoP)}` : 'שלך';
  // הודעה אחת לטלפון של מי שזה בשבילו (לא שלוש)
  for (const tp of targets) { const p = tp && tp !== S.myP ? person(tp) : null; if (p?.uid) await queueNotify(p.uid, 'share', `📥 ${nameIn(S.myP, sharedGroup(p.id)?.id)} הכניס/ה ליומן שלך ${n === 1 ? noun : n + ' ' + noun}`, sm.events.map(e => `${e.title} · ${DAYS[e.due.getDay()]} ${dmy(e.due)}`).join(', '), ids[0]); }
  const lines = sm.events.map(e => `${iconFor(e.title)} ${e.title} · ${e.repeat ? 'כל ' + e.repeat.dows.map(d => DAYS[d]).join(' ו') : `${DAYS[e.due.getDay()]} ${dmy(e.due)}`}${e.hasTime ? ` · \u2066${hm(e.due)}${e.dur ? '–' + hm(new Date(+e.due + e.dur * 60e3)) : ''}\u2069` : ''}`).join('\n');
  await bot('📅', 'var(--g3)', `נכנס${n === 1 ? '' : 'ו'} ${n === 1 ? noun : n + ' ' + noun} ליומן ${whose}`, lines, [
    { l: '📅 לראות ביומן', op: 'calDay', a: [sm.events[0].due.toISOString()], pri: true },
    n === 1 && ids.length === 1 ? { l: '✏️ לתקן', op: 'edit', a: [ids[0]] } : { l: '✏️ לתקן ביומן', op: 'calDay', a: [sm.events[0].due.toISOString()] },
    { l: '↩️ לבטל הכל', op: 'undoMany', a: ids }]);
  scanConflicts();
}
// בחירת משמרות בלחיצות: שבועיים קדימה, לכל יום בוקר / ערב / לילה
function openShiftPicker(whoP, name) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(sod(new Date()), i + 1)), pick = {};
  const nm = whoP && whoP !== S.myP ? name || pName(whoP) : '';
  sheet(`<h3>🏥 משמרות${nm ? ' ל' + esc(nm) : ''}</h3><p class="note">לכל יום בוחרים משמרת (לחיצה נוספת מבטלת).</p>
    <div class="shift-pick">${days.map((d, i) => `<div class="set-row"><span>${DAYS[d.getDay()]} ${dmy(d)}</span><span class="chips" style="padding:0;gap:4px">${[['morning', 'בוקר'], ['evening', 'ערב'], ['night', 'לילה']].map(([k, l]) => `<button class="chip" data-d="${i}" data-s="${k}">${l}</button>`).join('')}</span></div>`).join('')}</div>
    <button class="btn pri" id="spSave" style="margin-top:12px">📅 להכניס ליומן</button>`);
  $('#sheet').querySelector('.shift-pick').onclick = e => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    const i = b.dataset.d, on = pick[i] !== b.dataset.s;
    $('#sheet').querySelectorAll(`[data-d="${i}"]`).forEach(x => x.classList.remove('on'));
    if (on) { pick[i] = b.dataset.s; b.classList.add('on'); } else delete pick[i];
  };
  $('#spSave').onclick = async () => {
    const sh = shiftHours(), keys = Object.keys(pick).sort((a, b) => a - b);
    if (!keys.length) return toast('צריך לבחור לפחות משמרת אחת', true);
    const lbl = { morning: 'בוקר', evening: 'ערב', night: 'לילה' };
    const events = keys.map(i => { const d = new Date(days[i]), [s, e] = sh[pick[i]], [h, m] = s.split(':').map(Number); d.setHours(h, m, 0, 0);
      const toM = x => +x.split(':')[0] * 60 + +x.split(':')[1]; return { title: `משמרת ${lbl[pick[i]]}`, due: d, hasTime: true, dur: ((toM(e) - toM(s)) + 1440) % 1440 || 480, repeat: null }; });
    closeSheet(); showView('chat');
    await createEvents({ who: whoP || 'me', whoName: name || null, title: 'משמרת', isShift: true, events });
  };
}
// אירוע שהזמן שלו עבר — נסגר לבד (בלי "התקיים?"), ואירוע קבוע עובר לפעם הבאה
async function closePastEvents() {
  const now = Date.now();
  for (const it of S.items.filter(x => x.event && x.status === 'open' && x.due)) {
    const end = +new Date(it.due) + (it.dur || 60) * 60e3;
    if (end > now) continue;
    if (it.repeat) { const d = new Date(it.due); it.due = nextOccurrence(it.repeat, d.getHours(), d.getMinutes(), new Date(now))?.toISOString() || null; it.lastDone = new Date(end).toISOString(); }
    else { it.status = 'done'; it.doneAt = new Date(end).toISOString(); }
    await save(it);
  }
}

// ---------- 🏷️ קטגוריות (זהה לכסף בכיף: 24 אייקונים, 10 צבעים) ----------
const CAT_ICONS = ['🏠', '💼', '🧒', '🛒', '❤️', '📦', '🎓', '🚗', '💰', '🍽️', '🏋️', '📚', '🕍', '🎉', '✈️', '🧹', '🩺', '🐶', '🌱', '🎨', '💻', '📞', '🎁', '⭐'];
const CAT_COLORS = ['#7C3AED', '#EC4899', '#F97316', '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6', '#64748B', '#F43F5E'];
const CAT_BUILTIN = [
  { key: 'home', name: 'בית', icon: '🏠', color: '#3B82F6' }, { key: 'work', name: 'עבודה', icon: '💼', color: '#7C3AED' },
  { key: 'kids', name: 'ילדים', icon: '🧒', color: '#F97316' }, { key: 'shop', name: 'קניות', icon: '🛒', color: '#22C55E' },
  { key: 'health', name: 'בריאות', icon: '❤️', color: '#F43F5E' }, { key: 'misc', name: 'שונות', icon: '📦', color: '#64748B' },
];
const scopeOf = gid => gid || null;
// כל הקטגוריות של "מקום" אחד (קבוצה, או רק שלי): המוכנות (עם השינויים של הקבוצה) + מה שהוסיפו
function catsIn(gid) {
  const rows = (S.cats || []).filter(r => (r.group_id || null) === scopeOf(gid) && (r.group_id || r.owner === S.uid));
  // מוכנה שנמחקה (שורה עם builtin + deleted) לא מופיעה. סדר: לפי ord, ואם אין — הסדר המקורי
  const built = CAT_BUILTIN.filter(b => !rows.some(r => r.builtin === b.key && r.deleted)).map((b, i) => { const o = rows.find(r => r.builtin === b.key && !r.deleted); return { id: b.key, builtin: b.key, name: o?.name || b.name, icon: o?.icon || b.icon, color: o?.color || b.color, row: o || null, ord: o?.ord ?? i }; });
  return built.concat(rows.filter(r => !r.builtin && !r.deleted).map((r, i) => ({ id: r.id, name: r.name, icon: r.icon || '🏷️', color: r.color || '#64748B', row: r, ord: r.ord ?? 100 + i })))
    .sort((a, b) => a.ord - b.ord);
}
// הקטגוריה של משימה (קטגוריה שנמחקה או לא קיימת → שונות)
function catOf(it) {
  if (!it?.cat) return null;
  const list = catsIn(it.group_id), c = list.find(x => x.id === it.cat) || (S.cats || []).find(r => r.id === it.cat && !r.deleted);
  return c ? { id: c.id, name: c.name, icon: c.icon || '🏷️', color: c.color || '#64748B' } : list.find(x => x.id === 'misc');
}
const catChips = (gid, sel, attr = 'data-cat') => `<div class="chips cat-chips">${[{ id: '', name: 'בלי', icon: '∅', color: '#334155' }, ...catsIn(gid)].map(c =>
  `<button type="button" class="chip ${(sel || '') === c.id ? 'on' : ''}" ${attr}="${esc(c.id)}" style="--c:${c.color}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div>`;
function pickChips(box, attr, cb) { box.addEventListener('click', e => { const b = e.target.closest(`[${attr}]`); if (!b) return; box.querySelectorAll(`[${attr}]`).forEach(x => x.classList.toggle('on', x === b)); cb(b.getAttribute(attr)); }); }

let catScope = null;
function drawCatCard() {
  const el = $('#catCard'); if (!el) return;
  const gs = sync.myGroups().filter(g => g.myRole !== 'child');
  if (catScope && !gs.some(g => g.id === catScope)) catScope = null;
  el.innerHTML = `<h4>🏷️ קטגוריות</h4>
    ${S.uid && gs.length ? `<div class="chips" style="padding:0 0 8px;flex-wrap:wrap">${[[null, '🔒 רק שלי'], ...gs.map(g => [g.id, gLabel(g)])].map(([id, l]) => `<button class="chip ${catScope === id ? 'on' : ''}" data-cs="${id || ''}">${esc(l)}</button>`).join('')}</div>
      <p class="note">${catScope ? 'הקטגוריות של הקבוצה — כולם בקבוצה רואים ויכולים לשנות.' : 'קטגוריות שרק את/ה רואה.'}</p>` : ''}
    ${catsIn(catScope).map((c, i, a) => `<div class="set-row"><span><b class="cat-dot" style="background:${c.color}"></b>${esc(c.icon)} ${esc(c.name)}</span><span class="cat-acts"><button class="act" data-cu="${i}" ${i ? '' : 'disabled'} aria-label="למעלה">▲</button><button class="act" data-cd="${i}" ${i < a.length - 1 ? '' : 'disabled'} aria-label="למטה">▼</button><button class="act" data-ce="${esc(c.id)}" aria-label="עריכה">✏️</button></span></div>`).join('')}
    <button class="btn" id="catNew">➕ קטגוריה חדשה</button>
    ${!S.uid ? '<p class="note">בלי חשבון הקטגוריות נשמרות רק בטלפון הזה.</p>' : ''}`;
  el.querySelectorAll('[data-cs]').forEach(b => b.onclick = () => { catScope = b.dataset.cs || null; drawCatCard(); });
  el.querySelectorAll('[data-ce]').forEach(b => b.onclick = () => openCatEdit(catsIn(catScope).find(c => c.id === b.dataset.ce)));
  // ▲▼ סדר: שומרים ord לכל הקטגוריות של המקום הזה (גם למוכנות — נוצרת להן שורה)
  const move = async (i, d) => {
    const list = catsIn(catScope), j = i + d; if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    for (const [k, c] of list.entries()) {
      const row = c.row ? { ...c.row, ord: k } : { id: `${catScope || 'me-' + (S.uid || 'local')}|${c.builtin}`, group_id: catScope, builtin: c.builtin, name: c.name, icon: c.icon, color: c.color, deleted: false, ord: k };
      if (c.row?.ord !== k) await saveCat(row, true);
    }
    drawCatCard(); renderAll();
  };
  el.querySelectorAll('[data-cu]').forEach(b => b.onclick = () => move(+b.dataset.cu, -1));
  el.querySelectorAll('[data-cd]').forEach(b => b.onclick = () => move(+b.dataset.cd, 1));
  $('#catNew').onclick = () => openCatEdit(null);
}
function openCatEdit(c) {
  let icon = c?.icon || '🏷️', color = c?.color || CAT_COLORS[0];
  sheet(`<h3>${c ? '✏️ עריכת קטגוריה' : '➕ קטגוריה חדשה'}</h3>
    <label>שם</label><input id="ceName" maxlength="30" value="${esc(c?.name || '')}" placeholder="למשל: חוגים">
    <label>אייקון</label><div class="ic-grid" id="ceIcons">${CAT_ICONS.map(x => `<button type="button" class="${x === icon ? 'on' : ''}" data-i="${x}">${x}</button>`).join('')}</div>
    <label>צבע</label><div class="col-grid" id="ceColors">${CAT_COLORS.map(x => `<button type="button" class="${x === color ? 'on' : ''}" data-c="${x}" style="background:${x}" aria-label="צבע ${x}"></button>`).join('')}</div>
    <button class="btn pri" id="ceSave" style="margin-top:16px">💾 שמור</button>
    ${c ? '<button class="btn danger" id="ceDel">🗑️ מחיקה</button>' : ''}`);
  pickChips($('#ceIcons'), 'data-i', v => { icon = v; });
  pickChips($('#ceColors'), 'data-c', v => { color = v; });
  $('#ceSave').onclick = async () => {
    const name = $('#ceName').value.trim(); if (!name) return toast('צריך שם', true);
    const row = c?.row ? { ...c.row, name, icon, color } : { id: c?.builtin ? `${catScope || 'me-' + (S.uid || 'local')}|${c.builtin}` : db.newId(), group_id: catScope, builtin: c?.builtin || null, name, icon, color, deleted: false };
    await saveCat(row); closeSheet(); toast('🏷️ נשמר');
  };
  $('#ceDel')?.addEventListener('click', async e => {
    if (!tapAgain(e.currentTarget, '🗑️ בטוח? המשימות יעברו ל"שונות"')) return;
    await saveCat(c.row ? { ...c.row, deleted: true } : { id: `${catScope || 'me-' + (S.uid || 'local')}|${c.builtin}`, group_id: catScope, builtin: c.builtin, name: c.name, icon: c.icon, color: c.color, deleted: true });
    for (const it of S.items.filter(x => x.cat === c.id)) { it.cat = c.id === 'misc' ? null : 'misc'; await save(it); }
    closeSheet(); renderAll(); toast('🗑️ נמחקה. המשימות עברו ל"שונות"');
  });
}
async function saveCat(row, quiet) {
  S.cats = (S.cats || []).filter(r => r.id !== row.id).concat({ ...row, owner: row.owner || S.uid });
  await db.setKV('cats', S.cats);
  if (S.uid && !demo.DEMO) { try { await sync.saveCategory(row); } catch (x) { toast(x.message, true); } }
  if (!quiet) { drawCatCard(); renderAll(); }
}

// ---------- 🔔 פעמון: כל מה שקשור אליי, עם מספר של מה שלא נקרא ----------
async function bell(ic, title, sub, go, key) {
  S.bell ||= [];
  if (key && S.bell.some(b => b.key === key)) return; // אותו דבר לא נכנס פעמיים
  S.bell.unshift({ id: db.newId(), key: key || null, ic, title, sub: (sub || '').slice(0, 200), go: go || null, at: new Date().toISOString(), read: false });
  const month = Date.now() - 30 * 864e5;
  S.bell = S.bell.filter(b => new Date(b.at) > month).slice(0, 150);
  await db.setKV('bell', S.bell); drawBellBadge();
}
function drawBellBadge() {
  const n = (S.bell || []).filter(b => !b.read).length;
  $('#bellBadge').hidden = !n; $('#bellBadge').textContent = n > 99 ? '99+' : n;
  $('#bellBtn').setAttribute('aria-label', n ? `התראות, ${n} חדשות` : 'התראות');
}
const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60e3); return m < 1 ? 'עכשיו' : m < 60 ? `לפני ${m} דק׳` : m < 1440 ? `לפני ${Math.round(m / 60)} שע׳` : `לפני ${Math.round(m / 1440)} ימים`; };
function openBell() {
  const list = S.bell || [];
  sheet(`<h3>🔔 התראות</h3>
    ${list.length ? `<button class="chip" id="bellAll" style="margin-bottom:8px">✓ סמן הכל כנקרא</button>
      <div class="bell-list">${list.map(b => `<button class="bell-row${b.read ? '' : ' new'}" data-b="${b.id}"><span class="bell-ic">${esc(b.ic)}</span><span class="bell-tx"><b>${esc(b.title)}</b>${b.sub ? `<small>${esc(b.sub)}</small>` : ''}<i>${ago(b.at)}</i></span></button>`).join('')}</div>`
      : '<div class="empty-state"><span class="em">🔕</span>אין התראות כרגע.<br>כאן יופיעו התנגשויות, משימות ששיתפו איתך, הקפצות, תגובות ועוד.</div>'}`);
  $('#bellAll')?.addEventListener('click', async () => { list.forEach(b => { b.read = true; }); await db.setKV('bell', list); drawBellBadge(); openBell(); });
  $('#sheet').querySelector('.bell-list')?.addEventListener('click', async e => {
    const r = e.target.closest('[data-b]'); if (!r) return;
    const b = list.find(x => x.id === r.dataset.b); b.read = true; await db.setKV('bell', list); drawBellBadge();
    closeSheet(); goTo(b.go);
  });
}
function goTo(go) {
  if (!go) return;
  if (go.conf) return openConflict(go.conf);
  if (go.view) showView(go.view);
  if (go.item && item(go.item)) { if (item(go.item).kind === 'msg') return showView('chat'); if (go.comments) return openComments(go.item); return openCalEvent(go.item); }
}
$h('#bellBtn').onclick = openBell;

// ---------- 🔔 הקפצה: "פסי מזכירה למוישי" ----------
const canBump = it => S.uid && it?.status === 'open' && it.forP && it.forP !== S.myP && it.forP !== 'any' && !!person(it.forP)?.uid;
async function bumpTask(id) {
  const it = item(id); if (!it) return;
  const to = person(it.forP);
  if (!canBump(it)) return toast(to ? `ל${to.name} אין עדיין חשבון באפליקציה` : 'אפשר להקפיץ רק משימה של מישהו אחר', true);
  S.bumps ||= await db.getKV('bumps', {});
  const last = S.bumps[id] || 0, mins = Math.floor((Date.now() - last) / 60e3);
  if (mins < 10) return toast(`🔔 ${mins < 1 ? 'הרגע הקפצת' : `כבר הקפצת לפני ${mins} דק׳`}. אפשר שוב בעוד ${10 - mins} דק׳`, true);
  S.bumps[id] = Date.now(); await db.setKV('bumps', S.bumps);
  const gid = it.group_id || sharedGroup(to.id)?.id || null;
  const m = { id: db.newId(), kind: 'msg', bump: id, text: it.text, from: S.myP, forP: to.id, forU: to.uid, private: true, status: 'open', group_id: gid, replies: [], created: new Date().toISOString() };
  S.items.push(m); await save(m);
  await queueNotify(to.uid, 'bump', `🔔 ${nameIn(S.myP, gid)} מזכיר/ה לך`, `${it.text}${it.due ? ' · ' + whenLabel(it) : ''}`, m.id);
  toast(`🔔 הוקפץ ל${nameIn(to.id, gid)}`);
}
// "תקפיץ למוישי לקחת מהגן"
async function bumpByText(text) {
  const m = text.match(/^(?:תקפיץ|תקפיצי|להקפיץ|הקפץ|הקפיצי)\s+(?:ל|את\s+)?(.+)$/); if (!m) return false;
  const rest0 = m[1].trim();
  const names = S.people.filter(p => p.id !== S.myP).flatMap(p => [{ id: p.id, name: p.name }, ...p.nicks.map(n => ({ id: p.id, name: n.nick }))]).filter(x => x.name).sort((a, b) => b.name.length - a.name.length);
  const who = names.find(x => rest0.startsWith(x.name)); if (!who) return false;
  const rest = rest0.slice(who.name.length).replace(/^[\s,:-]+(?:ש|את\s+)?/, '').trim();
  await me(text); await think();
  const cands = S.items.filter(x => x.status === 'open' && isTask(x) && x.forP === who.id);
  const best = rest ? cands.map(it => ({ it, s: matchScore(rest, it.text) })).sort((a, b) => b.s - a.s)[0] : cands.length === 1 ? { it: cands[0], s: 1 } : null;
  if (best && best.s >= .34) { await bumpTask(best.it.id); return bot('🔔', 'var(--g6)', `הקפצתי ל${who.name}`, best.it.text), true; }
  if (rest) { await send(`תזכיר ל${who.name} ${rest}`); const n = S.items.filter(x => x.forP === who.id && x.status === 'open').sort((a, b) => new Date(b.created) - new Date(a.created))[0]; if (n) await bumpTask(n.id); return true; }
  await bot('🤔', 'var(--card2)', `איזו משימה של ${who.name} להקפיץ?`, cands.length ? cands.slice(0, 5).map(x => '• ' + x.text).join('\n') : `ל${who.name} אין משימות פתוחות. כתוב למשל: "תקפיץ ל${who.name} לקחת מהגן"`,
    cands.slice(0, 5).map(x => ({ l: '🔔 ' + x.text.slice(0, 24), op: 'bump', a: [x.id] })));
  return true;
}

// ---------- 📅 יומן: יומי (24 שעות) · שבועי · חודשי, עם תאריך עברי ולועזי ----------
const CAL_COLORS = ['#EC4899', '#06B6D4', '#F97316', '#22C55E', '#FACC15', '#14B8A6', '#F43F5E', '#A3E635'];
const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const HOUR_PX = 56;
const DSH = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const CAL = { mode: 'day', day: sod(new Date()), other: {}, hol: {}, jump: true };
const pName = pid => nameIn(pid, person(pid)?.nicks?.[0]?.g || null);
const calShow = () => ({ mine: true, assigned: true, groups: true, thoughts: false, ...(S.settings.calShow || {}) });
// צבע לכל אדם: אני סגול, השאר לפי הסדר (אפשר לשנות בהגדרות)
function colorOf(pid) {
  const pc = person(pid)?.color; if (pc) return pc; // הצבע שנבחר (מסונכרן לכל הקבוצה)
  if (S.settings.calColors?.[pid]) return S.settings.calColors[pid];
  if (!pid || pid === S.myP) return '#7C3AED';
  const i = others().findIndex(p => p.id === pid);
  return CAL_COLORS[(i < 0 ? 0 : i) % CAL_COLORS.length];
}
// מי מוצג ביומן חוץ ממני (ברירת מחדל: מי שבמשפחה או בקשר ישיר איתי)
function calWho() {
  if (Array.isArray(S.settings.calWho)) return S.settings.calWho.filter(id => person(id));
  return others().filter(p => p.nicks.some(n => ['family', 'pair'].includes(n.kind))).map(p => p.id);
}
// לאיזו קבוצה בהגדרות "מה מוצג" שייך דבר: שלי / שהקצו לי / של הקבוצות
function calCat(it) {
  if (it.kind === 'thought') return 'thoughts';
  if (it.forP === 'any') return 'assigned';
  if (it.forP === S.myP && !byMe(it)) return 'assigned';
  if (byMe(it) && (!it.forP || it.forP === S.myP)) return 'mine';
  if (byMe(it)) return 'groups';
  return 'other';
}
// כל ההופעות של דבר בטווח (גם משימות קבועות)
function occurrences(it, from, to) {
  if (!it.due) return [];
  const d = new Date(it.due);
  if (!it.repeat) return d >= from && d < to ? [d] : [];
  const out = [], h = it.hasTime ? d.getHours() : 9, m = it.hasTime ? d.getMinutes() : 0;
  let t = new Date(Math.max(+from, +sod(new Date(it.created || from))) - 1);
  for (let i = 0; i < 62; i++) { const n = nextOccurrence(it.repeat, h, m, t); if (!n || n >= to) break; out.push(n); t = n; }
  return out;
}
function calEvents(from, to) {
  const show = calShow(), who = new Set(calWho()), seen = new Set(), ev = [];
  const push = (it, owner, mine, busy) => {
    for (const s of occurrences(it, from, to)) ev.push({
      id: it.id, it, mine, busy, owner, color: colorOf(owner), start: s, hasTime: !!it.hasTime,
      end: new Date(+s + (it.hasTime ? Math.max(it.dur || 0, 0) : 0) * 60e3), dur: it.dur,
      done: it.status === 'done' || (it.repeat && it.lastDone && ymd(new Date(it.lastDone)) === ymd(s)),
      text: it.text, kind: it.kind, cat: busy ? null : catOf(it),
    });
  };
  for (const it of S.items) {
    if (!['open', 'done'].includes(it.status) || ['msg', 'reply'].includes(it.kind) || !it.due) continue;
    const cat = calCat(it), owner = it.forP && it.forP !== 'any' ? it.forP : ownerP(it) || S.myP;
    if (cat === 'other' ? !who.has(owner) : !show[cat]) continue;
    if (cat === 'groups' && !who.has(owner)) continue; // בשביל מישהו שהוסתר בשורת האנשים
    if (S.settings.calMe === false && ['mine', 'assigned', 'thoughts'].includes(cat)) continue; // 🙋 "אני" כבוי
    seen.add(it.id); push(it, owner, true, false);
  }
  for (const pid of who) {
    const p = person(pid); if (!p?.uid) continue;
    for (const r of CAL.other[p.uid] || []) if (!seen.has(r.id)) push({ ...r.data, id: r.id }, pid, false, r.busy);
  }
  // 📅 מהיומן של הטלפון (גוגל / אייפון): לקריאה בלבד, בצבע משלו
  if (S.settings.calMe !== false) for (const x of S.ext) {
    const s0 = new Date(x.due); if (s0 >= to || +s0 + (x.dur || 0) * 60e3 < +from) continue;
    ev.push({ id: x.id, it: x, ext: true, mine: false, busy: false, owner: S.myP, color: '#3B82F6', start: s0, hasTime: x.hasTime, end: new Date(+s0 + (x.dur || 0) * 60e3), dur: x.dur, done: false, text: x.text, kind: 'ext', cat: null });
  }
  return ev.sort((a, b) => a.start - b.start);
}
async function loadOthers(force) {
  const ids = calWho().map(id => person(id)?.uid).filter(Boolean);
  await Promise.all(ids.map(async uid => { if (force || !CAL.other[uid]) CAL.other[uid] = await sync.calendarOf(uid); }));
}
async function loadHol(d) {
  const k = `${d.getFullYear()}-${d.getMonth()}`;
  if (!CAL.hol[k]) CAL.hol[k] = await Z.monthEvents(S.settings.city, S.settings.candleMin, d.getFullYear(), d.getMonth());
  return CAL.hol[k];
}
// 🕯️ שבת וחג בצבע בולט (חג = יום טוב, לא ראש חודש או צום)
const CHAG_RE = /ראש השנה|יום כיפור|יום הכיפורים|סוכות|שמיני עצרת|שמחת תורה|פסח|שבועות|חג/;
const dayKind = (d, h) => (h?.hol || []).some(x => CHAG_RE.test(x) && !/ערב|חול המועד|חוה[״"]מ|הושענא/.test(x)) ? ' hol chag' : d.getDay() === 6 ? ' hol shab' : h?.hol.length ? ' holmin' : '';
const holOf = d => CAL.hol[`${d.getFullYear()}-${d.getMonth()}`]?.[ymd(d)] || null;
// 📅 התאריך הראשי (גדול): לועזי או עברי — לבחירה ב⚙️ ← 📅 יומן
const hebMain = () => S.settings.mainDate === 'heb';
const hebDay = d => { try { const n = +new Intl.DateTimeFormat('he-u-ca-hebrew', { day: 'numeric' }).format(d); return gematria(n); } catch { return ''; } };
const hebMonth = d => { try { return new Intl.DateTimeFormat('he-u-ca-hebrew', { month: 'long' }).format(d).replace('חשון', 'חשוון'); } catch { return ''; } };
const evLabel = e => `${e.ext ? 'מהיומן' : e.kind === 'meeting' ? 'פגישה' : e.kind === 'thought' ? 'מחשבה' : 'משימה'}: ${e.busy ? 'תפוס' : e.text}${e.hasTime ? `, ${hm(e.start)}${e.dur ? ' עד ' + hm(e.end) : ''}` : ''}${e.owner !== S.myP ? ', של ' + pName(e.owner) : ''}${e.done ? ', בוצע' : ''}`;
const evIcon = e => e.ext ? '📅' : e.busy ? '⛔' : e.done ? '✅' : e.it?.icon ? e.it.icon : e.kind === 'meeting' ? '👥' : e.kind === 'thought' ? '💭' : e.it?.repeat ? '🔁' : '📌';

async function renderCal(force) {
  if (!$('#v-cal').classList.contains('on')) return;
  const d = CAL.day, m = CAL.mode, jump = CAL.jump; CAL.jump = false;
  document.querySelectorAll('#calMode button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  // שורת האנשים: אני + מי שבקבוצות שלי ויש לו חשבון
  const ppl = others(), who = calWho(), meOn = S.settings.calMe !== false, all = meOn && ppl.every(p => who.includes(p.id));
  $('#calWho').hidden = !ppl.length;
  $('#calWho').innerHTML = `<span class="cw-lbl">👀 של מי:</span><button class="chip ${all ? 'on' : ''}" data-p="*">👨‍👩‍👧 כולם</button><button class="chip ${meOn ? 'on' : ''}" data-p="me" style="--c:${colorOf(S.myP)}" aria-pressed="${meOn}"><i class="dot"></i>🙋 אני</button>` +
    ppl.map(p => `<button class="chip ${who.includes(p.id) ? 'on' : ''}" data-p="${p.id}" style="--c:${colorOf(p.id)}" aria-pressed="${who.includes(p.id)}"><i class="dot"></i>${esc(p.e)} ${esc(pName(p.id))}</button>`).join('');
  const from = m === 'day' ? d : m === 'week' ? addDays(d, -d.getDay()) : new Date(d.getFullYear(), d.getMonth(), 1);
  const to = m === 'day' ? addDays(d, 1) : m === 'week' ? addDays(from, 7) : new Date(d.getFullYear(), d.getMonth() + 1, 1);
  await Promise.all([loadHol(from), loadHol(addDays(to, -1)), loadOthers(force)]);
  const ev = calEvents(m === 'month' ? addDays(from, -7) : from, m === 'month' ? addDays(to, 7) : to);
  if (m === 'day') drawDay(d, ev, jump); else if (m === 'week') drawWeek(from, ev); else drawMonth(d, ev);
}

function drawDay(d, ev, jump) {
  const h = holOf(d), isT = ymd(d) === today();
  const g1 = `${d.getDate()}.${d.getMonth() + 1}`, hol1 = [...(h?.hol || []), ...(h?.mod || [])].length ? ' · ' + esc([...(h?.hol || []), ...(h?.mod || [])].join(', ')) : '';
  $('#calTitle').innerHTML = hebMain() ? `<b>${isT ? 'היום · ' : ''}יום ${DAYS[d.getDay()]}, ${esc(hebDate(d))}</b><small>${g1}${hol1}</small>` : `<b>${isT ? 'היום · ' : ''}יום ${DAYS[d.getDay()]}, ${g1}</b><small>${esc(hebDate(d))}${hol1}</small>`;
  const timed = ev.filter(e => e.hasTime), allDay = ev.filter(e => !e.hasTime);
  // משימות שחופפות בזמן — זו ליד זו
  const cols = []; let group = [], gEnd = 0;
  const flush = () => { const n = Math.max(1, ...group.map(g => g.col + 1)); group.forEach(g => { g.n = n; }); group = []; };
  for (const e of timed) {
    const s = +e.start, en = Math.max(+e.end, s + 30 * 60e3);
    if (s >= gEnd) { flush(); cols.length = 0; }
    let c = cols.findIndex(x => x <= s); if (c < 0) c = cols.length; cols[c] = en; e.col = c; group.push(e); gEnd = Math.max(gEnd, en);
  }
  flush();
  // שבת וחג: רקע רך מהדלקת הנרות ועד ההבדלה
  const shade = [];
  const sod0 = +d, eod = +addDays(d, 1);
  for (const w of Z.windows()) { const a = Math.max(sod0, +new Date(w.start)), b = Math.min(eod, +new Date(w.end)); if (a < b) shade.push([a, b, w.name]); }
  if (!shade.length && h?.candles) shade.push([+new Date(h.candles), eod, h.hol[0] || 'שבת']);
  if (!shade.length && h?.havdalah) shade.push([sod0, +new Date(h.havdalah), h.hol[0] || 'שבת']);
  const y = t => (t - sod0) / 36e5 * HOUR_PX;
  $('#calBody').innerHTML = `
    ${allDay.length ? `<div class="cal-allday"><small>בלי שעה</small>${allDay.map(e => `<button class="cal-pill${e.done ? ' done' : ''}${e.ext ? ' ext' : ''}" data-ev="${e.id}" style="--c:${e.color}" aria-label="${esc(evLabel(e))}">${evIcon(e)} ${esc(e.busy ? 'תפוס/ה' : e.text)}</button>`).join('')}</div>` : ''}
    ${h?.candles ? `<div class="cal-zman">🕯️ הדלקת נרות ${hm(new Date(h.candles))}</div>` : ''}${h?.havdalah ? `<div class="cal-zman">✨ צאת ${esc(h.hol[0] && !/שבת/.test(h.hol[0]) ? 'החג' : 'השבת')} ${hm(new Date(h.havdalah))}</div>` : ''}
    <div class="cal-day" id="calDay" style="height:${24 * HOUR_PX}px" aria-label="ציר השעות של היום. לחיצה על שעה ריקה מוסיפה משימה">
      ${shade.map(([a, b, n]) => `<div class="cal-shade" style="top:${y(a)}px;height:${y(b) - y(a)}px"><span>🕯️ ${esc(n)}</span></div>`).join('')}
      ${Array.from({ length: 24 }, (_, i) => `<div class="cal-hr" style="top:${i * HOUR_PX}px"><span>${String(i).padStart(2, '0')}:00</span></div>`).join('')}
      ${timed.map(e => { const top = y(+e.start), ht = Math.max(e.dur ? y(+e.end) - top : 0, 26);
        return `<button class="cal-ev${e.done ? ' done' : ''}${e.busy ? ' busy' : ''}${e.ext ? ' ext' : ''}" data-ev="${e.id}" data-t="${+e.start}" aria-label="${esc(evLabel(e))}"
          style="--c:${e.color};${e.cat ? `box-shadow:inset -5px 0 0 ${e.cat.color};` : ''}top:${top}px;height:${ht - 2}px;right:calc(52px + (100% - 56px) * ${e.col / e.n});width:calc((100% - 56px) / ${e.n} - 3px)">
          <b dir="ltr">${hm(e.start)}${e.dur && e.n === 1 ? '–' + hm(e.end) : ''}</b> ${e.cat ? esc(e.cat.icon) : evIcon(e)} ${esc(e.busy ? 'תפוס/ה' : e.text)}${e.owner !== S.myP ? ` <small>· ${esc(pName(e.owner))}</small>` : ''}</button>`; }).join('')}
      ${isT ? `<div class="cal-now" style="top:${y(Date.now())}px"><i></i></div>` : ''}
    </div>`;
  // נפתח על השעה של עכשיו (או 7:00 ביום אחר / על הדבר הראשון)
  const first = timed[0] ? +timed[0].start : null;
  const target = isT ? y(Date.now()) - 120 : first ? y(first) - 60 : 7 * HOUR_PX;
  if (jump) $('#main').scrollTop = Math.max(0, $('#calDay').offsetTop + target - 20);
}

function drawWeek(from, ev) {
  const to = addDays(from, 6);
  const gw = `${from.getDate()}.${from.getMonth() + 1} – ${to.getDate()}.${to.getMonth() + 1}`, hw = `${esc(hebDate(from))} – ${esc(hebDate(to))}`;
  $('#calTitle').innerHTML = hebMain() ? `<b>${hw}</b><small>${gw}</small>` : `<b>${gw}</b><small>${hw}</small>`;
  $('#calBody').innerHTML = `<div class="cal-week">${Array.from({ length: 7 }, (_, i) => {
    const d = addDays(from, i), list = ev.filter(e => ymd(e.start) === ymd(d)), h = holOf(d);
    return `<button class="cal-col${ymd(d) === today() ? ' today' : ''}${dayKind(d, h)}" data-day="${ymd(d)}" aria-label="יום ${DAYS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}, ${list.length} דברים">
      <span class="cal-dh"><b>${DSH[d.getDay()]}׳</b>${hebMain() ? `<i>${hebDay(d)}</i><small>${d.getDate()}</small>` : `<i>${d.getDate()}</i><small>${hebDay(d)}</small>`}</span>
      ${h?.hol.length ? `<span class="cal-holname">${esc(h.hol[0])}</span>` : ''}${h?.mod?.length ? `<span class="cal-holname mod">${esc(h.mod[0])}</span>` : ''}
      ${list.map(e => `<span class="cal-wi${e.done ? ' done' : ''}${e.ext ? ' ext' : ''}" style="--c:${e.color}">${e.hasTime ? `<b>${hm(e.start)}</b>` : ''}${esc(e.busy ? 'תפוס/ה' : e.text)}</span>`).join('')}
    </button>`; }).join('')}</div>`;
}

function drawMonth(d, ev) {
  const first = new Date(d.getFullYear(), d.getMonth(), 1), last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const hm1 = hebMonth(first), hm2 = hebMonth(last), hy = hebDate(last).split(' ').pop();
  const gm = `${MONTHS_HE[d.getMonth()]} ${d.getFullYear()}`, hmo = `${esc(hm1 === hm2 ? hm1 : hm1 + '–' + hm2)} ${esc(hy)}`;
  $('#calTitle').innerHTML = hebMain() ? `<b>${hmo}</b><small>${gm}</small>` : `<b>${gm}</b><small>${hmo}</small>`;
  const start = addDays(first, -first.getDay()), weeks = Math.ceil((first.getDay() + last.getDate()) / 7);
  $('#calBody').innerHTML = `<div class="cal-month"><div class="cal-mh">${DSH.map(x => `<span>${x}׳</span>`).join('')}</div>${Array.from({ length: weeks * 7 }, (_, i) => {
    const c = addDays(start, i), list = ev.filter(e => ymd(e.start) === ymd(c)), h = holOf(c), out = c.getMonth() !== d.getMonth();
    const dots = [...new Set(list.map(e => e.color))].slice(0, 4);
    return `<button class="cal-cell${out ? ' out' : ''}${ymd(c) === today() ? ' today' : ''}${dayKind(c, h)}" data-day="${ymd(c)}" aria-label="${c.getDate()}.${c.getMonth() + 1}, ${esc(hebDate(c))}${h?.hol.length ? ', ' + esc(h.hol.join(', ')) : ''}, ${list.length ? list.length + ' דברים' : 'פנוי'}">
      ${hebMain() ? `<b>${hebDay(c)}</b><small>${c.getDate()}</small>` : `<b>${c.getDate()}</b><small>${hebDay(c)}</small>`}${h?.hol.length ? `<em>${esc(h.hol[0])}</em>` : h?.mod?.length ? `<em class="mod">${esc(h.mod[0])}</em>` : ''}<span class="cal-dots">${dots.map(x => `<i style="background:${x}"></i>`).join('')}${list.length > 4 ? '+' : ''}</span></button>`;
  }).join('')}</div>
  <p class="note" style="padding:8px 16px">לחיצה על יום פותחת אותו לפי שעות.</p>`;
}

function calMove(n) {
  const d = CAL.day;
  CAL.jump = true; enterAnim($('#v-cal'));
  CAL.day = CAL.mode === 'day' ? addDays(d, n) : CAL.mode === 'week' ? addDays(d, 7 * n) : new Date(d.getFullYear(), d.getMonth() + n, 1);
  renderCal();
}
$h('#calMode').onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; CAL.mode = b.dataset.m; CAL.jump = true; renderCal(); };
$h('#calPrev').onclick = () => calMove(-1);
$h('#calNext').onclick = () => calMove(1);
$h('#calToday').onclick = () => { CAL.day = sod(new Date()); CAL.jump = true; enterAnim($('#v-cal')); renderCal(); };
$h('#calWho').onclick = async e => {
  const b = e.target.closest('[data-p]'); if (!b) return;
  const cur = calWho(), id = b.dataset.p, on = !cur.includes(id);
  if (id === 'me') { S.settings.calMe = S.settings.calMe === false; await db.setKV('settings', S.settings); return renderCal(); }
  if (id === '*') { const all = S.settings.calMe !== false && others().every(p => cur.includes(p.id)); S.settings.calMe = true; S.settings.calWho = all ? [] : others().map(p => p.id); await db.setKV('settings', S.settings); return renderCal(true); }
  S.settings.calWho = on ? [...cur, id] : cur.filter(x => x !== id); await db.setKV('settings', S.settings);
  await renderCal(true);
  const p = person(id);
  if (on && p?.uid && !(CAL.other[p.uid] || []).length && !S.items.some(x => ownerP(x) === id && x.due)) toast(`ל${pName(id)} אין כרגע מה להראות, או שעוד לא שיתף/ה את היומן`);
};
$h('#calBody').addEventListener('click', e => {
  const evb = e.target.closest('[data-ev]');
  if (evb) return openCalEvent(evb.dataset.ev, evb.dataset.t);
  const day = e.target.closest('[data-day]');
  if (day) { CAL.day = new Date(day.dataset.day + 'T00:00'); CAL.mode = 'day'; CAL.jump = true; return renderCal(); }
  const grid = e.target.closest('#calDay');
  if (grid) { // שעה ריקה → הוספה בדיוק לשעה הזאת (בעיגול לחצי שעה)
    const mins = Math.max(0, Math.min(23 * 60 + 30, Math.floor((e.clientY - grid.getBoundingClientRect().top) / HOUR_PX * 2) * 30));
    openQuick({ day: CAL.day, time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` });
  }
});
// משיכה הצידה ביומי/שבועי/חודשי — הבא או הקודם
(() => {
  let x0 = null, y0 = 0;
  $('#calBody').addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  $('#calBody').addEventListener('touchend', e => {
    if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) calMove(dx > 0 ? 1 : -1); // בעברית: החלקה ימינה = הבא
  });
})();
function openCalEvent(id, t) {
  const x = S.ext.find(e => e.id === id);
  if (x) { // 📅 מהיומן של הטלפון: לקריאה בלבד
    sheet(`<h3>📅 ${esc(x.text)}</h3><p class="note">${whenLabel(x)}${x.dur && x.hasTime ? ' · ⏱️ ' + durLbl(x.dur) : ''}${x.place ? ' · 📍 ' + esc(x.place) : ''}</p>
      <p class="note" style="margin-top:8px"><span class="ext-tag">📅 מהיומן</span> הגיע מהיומן ${esc(x.calName || S.extHost || 'שלך')}. משנים או מוחקים אותו שם, וזה מתעדכן כאן לבד תוך 15 דקות.</p>
      <button class="btn" id="ceClose" style="margin-top:14px">סגירה</button>`); $('#ceClose').onclick = closeSheet; return;
  }
  const it = item(id);
  if (!it) { // של מישהו אחר (מהיומן שלו)
    const r = Object.values(CAL.other).flat().find(x => x.id === id); if (!r) return;
    const d = r.data, s = t ? new Date(+t) : new Date(d.due);
    return sheet(`<h3>${r.busy ? '⛔ תפוס/ה' : esc(d.text)}</h3><p class="note">${whenLabel({ ...d, due: s.toISOString() })}${d.dur ? ' · ⏱️ ' + durLbl(d.dur) : ''}</p>
      ${r.busy ? '<p class="note">זה פרטי, אז רואים רק שהזמן הזה תפוס.</p>' : ''}<button class="btn" id="ceClose" style="margin-top:14px">סגירה</button>`), $('#ceClose').onclick = closeSheet;
  }
  const open = it.status === 'open';
  sheet(`<h3>${evIcon({ kind: it.kind, it, done: !open })} ${esc(it.text)}</h3>
    <p class="note">${it.due ? whenLabel(it) : 'בלי תאריך'}${it.dur ? ' · ⏱️ ' + durLbl(it.dur) : ''}${it.place ? ' · 📍 ' + esc(it.place) : ''}${S.uid ? ' · ' + esc(assignLabel(it)) : ''}</p>
    <div class="three" style="margin-top:14px">${open ? '<button class="btn pri" id="ceDone">✅ עשיתי</button>' : '<button class="btn" disabled>✅ בוצע</button>'}<button class="btn" id="ceEdit">✏️ עריכה</button><button class="btn danger" id="ceDel">🗑️ מחיקה</button></div>
    ${open ? `<button class="btn" id="ceFocus">⏱️ טיימר פוקוס</button>` : ''}
    <button class="btn" id="ceSteps">${it.steps?.length ? `📝 שלבים (${stepsLbl(it).slice(3)})` : '✂️ לפרק לשלבים'}</button>
    ${S.uid ? `<button class="btn" id="ceCm">💬 תגובות${it.comments?.length ? ` (${it.comments.length})` : ''}</button>` : ''}
    ${canBump(it) ? `<button class="btn" id="ceBump">🔔 להקפיץ ל${esc(pName(it.forP))}</button>` : ''}
    ${S.uid ? '<button class="btn" id="ceAssign">📎 שיוך</button>' : ''}`);
  // מחיקה מיידית — ו"↩️ בטל" מופיע מיד למעלה
  $('#ceDel').onclick = () => askRemove(id, renderCal);
  $('#ceDone')?.addEventListener('click', async () => { closeSheet(); await markDone(id, true); toast('✅ ' + it.text); renderCal(); });
  $('#ceEdit').onclick = () => openEdit(id);
  $('#ceBump')?.addEventListener('click', () => { closeSheet(); bumpTask(id); });
  $('#ceCm')?.addEventListener('click', () => openComments(id));
  $('#ceSteps').onclick = () => openSteps(id);
  $('#ceFocus')?.addEventListener('click', () => openFocusPick(id));
  $('#ceAssign')?.addEventListener('click', () => openAssign(id));
  $('#ceClose')?.addEventListener('click', closeSheet);
}

// הגדרות ← 📅 יומן: מה מוצג וצבע לכל אדם
function drawCalCard() {
  const el = $('#calCard'); if (!el) return;
  const sh = calShow();
  el.innerHTML = `<h4>📅 יומן</h4><p class="note">מה מופיע ביומן שלי:</p>
    ${[['mine', '🙋 מה שרשמתי לעצמי'], ['assigned', '📥 מה שהקצו לי (וגם "מישהו מאיתנו")'], ['groups', '📤 מה שרשמתי בשביל אחרים'], ['thoughts', '💭 מחשבות שיש להן תאריך']]
      .map(([k, l]) => `<label class="set-row" style="cursor:pointer"><span>${l}</span><input type="checkbox" data-show="${k}" ${sh[k] ? 'checked' : ''}></label>`).join('')}
    <p class="note" style="margin-top:10px">צבע לכל אחד:</p>
    ${S.uid ? S.people.map(p => `<div class="set-row"><span>${esc(p.e)} ${esc(p.id === S.myP ? 'אני' : pName(p.id))}</span><button class="color-dot" data-pc="${p.id}" style="background:${colorOf(p.id)}" aria-label="הצבע של ${esc(p.name)}${canColor(p.id) ? ' — לשינוי' : ''}"></button></div>`).join('') : '<p class="note">אחרי כניסה אפשר לבחור צבע לכל אחד.</p>'}
    <p class="note" style="margin-top:10px">🏥 שעות משמרות (בשביל "תכניס לפסי משמרות בראשון ערב…"):</p>
    ${[['morning', 'בוקר'], ['evening', 'ערב'], ['night', 'לילה']].map(([k, l]) => `<div class="set-row"><span>${l}</span><span style="display:flex;gap:6px;align-items:center"><input type="time" data-sh="${k}" data-i="0" value="${shiftHours()[k][0]}">–<input type="time" data-sh="${k}" data-i="1" value="${shiftHours()[k][1]}"></span></div>`).join('')}
    <p class="note" style="margin-top:10px">📅 התאריך הגדול (הראשי):</p>
    <div class="seg" id="setMainDate" style="margin-top:6px"><button data-md="greg" class="${hebMain() ? '' : 'on'}">לועזי (20.10)</button><button data-md="heb" class="${hebMain() ? 'on' : ''}">עברי (ח׳ חשוון)</button></div>
    <p class="note">את מי עוד רואים ביומן בוחרים בראש מסך היומן. מי רואה את היומן <b>שלך</b> נקבע בכל קבוצה, ב"👥 הקבוצות שלי".</p>`;
  el.querySelectorAll('[data-show]').forEach(c => c.onchange = async () => { S.settings.calShow = { ...calShow(), [c.dataset.show]: c.checked }; await db.setKV('settings', S.settings); toast('נשמר ✓'); });
  el.querySelectorAll('[data-pc]').forEach(b => b.onclick = () => openColorPick(b.dataset.pc));
  el.querySelectorAll('[data-md]').forEach(b => b.onclick = async () => { S.settings.mainDate = b.dataset.md; await db.setKV('settings', S.settings); drawCalCard(); renderAll(); toast(hebMain() ? '📅 עכשיו התאריך העברי גדול' : '📅 עכשיו התאריך הלועזי גדול'); });
  el.querySelectorAll('[data-sh]').forEach(c => c.onchange = async () => {
    const sh = shiftHours(); sh[c.dataset.sh] = [...sh[c.dataset.sh]]; sh[c.dataset.sh][+c.dataset.i] = c.value || sh[c.dataset.sh][+c.dataset.i];
    S.settings.shifts = sh; await db.setKV('settings', S.settings); toast('🏥 נשמר');
  });
  el.querySelectorAll('[data-col]').forEach(c => c.onchange = async () => { S.settings.calColors = { ...(S.settings.calColors || {}), [c.dataset.col || S.myP]: c.value }; await db.setKV('settings', S.settings); toast('🎨 נשמר'); });
}

// ---------- מסך מחשבות ----------
function renderThoughts() {
  const list = openItems().filter(x => x.kind === 'thought').sort((a, b) => new Date(b.created) - new Date(a.created));
  const ago = iso => { const d = Math.round((sod(new Date()) - sod(new Date(iso))) / 864e5); return d === 0 ? 'היום' : d === 1 ? 'אתמול' : `לפני ${d} ימים`; };
  $('#thoughtList').innerHTML = (list.length ? `<div class="card"><p class="note">כל מה שכתבת בלי תאריך נאסף כאן. כשיש לך רגע, עבור על הרשימה והחלט מה לעשות עם כל דבר.</p></div>` : '') +
    (list.length ? list.map(x => `<div class="card" data-id="${x.id}"><div class="row" style="border:none;padding:0"><div class="ic" style="background:var(--card2);width:34px;height:34px;font-size:16px">💭</div>
      <div class="nm" data-op="edit">${esc(x.text)}<small>${ago(x.created)}</small></div></div>
      <div class="th-acts"><button class="act pri" data-op="toTask">📋 למשימה</button><button class="act" data-op="date">📅 תאריך</button>
      <button class="act" data-op="star">⭐ להיום</button><button class="act" data-op="remove">🗑️ מחק</button></div></div>`).join('')
      : `<div class="empty-state"><span class="em">💭</span>התיבה ריקה.<br>כל מחשבה שעולה לך בראש, פשוט כתוב לי בשיחה, למשל: "רעיון: לסדר את המחסן"</div>`);
}
$h('#thoughtList').addEventListener('click', e => {
  const op = e.target.closest('[data-op]')?.dataset.op, id = e.target.closest('[data-id]')?.dataset.id;
  if (!op || !id) return;
  ({ toTask: () => OPS.toTask(id), date: () => openEdit(id, 'date', 'task'), star: () => OPS.star(id), remove: () => OPS.remove(id), edit: () => openEdit(id) })[op]?.();
});

// ---------- חלון עריכה ----------
// ↩️ כפתור "חזור" (אנדרואיד): סוגר חלון → חוזר למסך הקודם → רק מהשיחה יוצאים מהאפליקציה.
// בדפדפן יש רק רשומה אחת "מלכודת" מעל הבסיס, כל עוד לא נמצאים בשיחה או שיש חלון פתוח. את המסכים הקודמים זוכרים כאן.
const NAV = { stack: [], trapped: false, ignore: 0 };
const curView = () => document.querySelector('.view.on')?.id?.slice(2) || 'chat';
const sheetOpen = () => $('#sheetBg').classList.contains('on');
function syncTrap() {
  const want = curView() !== 'chat' || sheetOpen() || ($('#tour') && !$('#tour').hidden) || !$('#focus').hidden;
  try {
    if (want && !NAV.trapped) { history.pushState({ trap: 1 }, ''); NAV.trapped = true; }
    else if (!want && NAV.trapped && history.state?.trap) { NAV.ignore++; NAV.trapped = false; history.back(); }
  } catch { /* */ }
}
addEventListener('popstate', () => {
  if (NAV.ignore) { NAV.ignore--; return syncTrap(); }
  NAV.trapped = false;
  if (sheetOpen()) { $('#sheetBg').classList.remove('on'); $('#sheet').style.transform = ''; }
  else if ($('#tour') && !$('#tour').hidden) $('#tourX')?.click();
  else if (!$('#focus').hidden) $('#fcHide')?.click();
  else if (curView() !== 'chat') showView(NAV.stack.pop() || 'chat', true);
  syncTrap();
});
// הלחיצה הראשונה באפליקציה "מפעילה" את כפתור חזור (דפדפנים מדלגים על רשומות שנוספו בלי לחיצה)
addEventListener('pointerdown', () => syncTrap(), { capture: true });
// HTML שמתחיל ב-<!--full--> נפתח כמסך מלא (כמו "✨ מה חדש"), וכפתור החזור עדיין סוגר אותו
function sheet(html) { clearTimeout(nxTimer); $('#sheet').classList.toggle('full', html.startsWith('<!--full-->')); $('#sheet').innerHTML = html; $('#sheetBg').classList.add('on'); syncTrap(); }
function closeSheet() { clearTimeout(nxTimer); $('#sheetBg').classList.remove('on'); $('#sheet').style.transform = ''; setTimeout(() => { if (!sheetOpen()) $('#sheet').classList.remove('full'); }, 300); setTimeout(syncTrap, 0); }

$h('#sheetBg').addEventListener('click', e => { if (e.target.id === 'sheetBg') closeSheet(); });

// משיכה כלפי מטה: בחלון — סוגרת אותו; במסך (משימות, מחשבות, הגדרות) — חוזרת לשיחה
function pullDown(el, scroller, ok, close) {
  let y0 = null, x0 = 0, dy = 0;
  el.addEventListener('touchstart', e => {
    if (!ok() || scroller().scrollTop > 2 || e.touches.length > 1) { y0 = null; return; }
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; el.style.transition = 'none';
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (y0 == null) return;
    const d = e.touches[0].clientY - y0, dx = Math.abs(e.touches[0].clientX - x0);
    if (dy === 0 && (d < 0 || dx > Math.abs(d))) { y0 = null; el.style.transform = ''; return; } // גלילה רגילה / הצידה
    if (scroller().scrollTop > 2) { y0 = null; el.style.transform = ''; return; }
    dy = Math.max(0, d); if (e.cancelable) e.preventDefault();
    el.style.transform = `translateY(${dy * .6}px)`;
    $('#pullHint').classList.toggle('on', dy > 40);
    $('#pullHint').textContent = dy > 110 ? '⬆️ עזוב כדי לסגור' : '⬇️ המשך למשוך כדי לסגור';
  }, { passive: false });
  el.addEventListener('touchend', () => {
    if (y0 == null) return; y0 = null; $('#pullHint').classList.remove('on');
    el.style.transition = 'transform .2s'; el.style.transform = '';
    if (dy > 110) close();
  });
}
document.body.insertAdjacentHTML('beforeend', '<div class="pull-hint" id="pullHint"></div>');
pullDown($('#sheet'), () => $('#sheet'), () => $('#sheetBg').classList.contains('on'), closeSheet);
pullDown($('#main'), () => $('#main'), () => !$('#v-chat').classList.contains('on'), () => showView('chat'));

// ➕ הוספה מהירה בלי צ'אט
function openQuick(pre = {}) {
  let kind = pre.kind || 'task';
  const KT = { task: ['📌', 'משימה חדשה'], remind: ['⏰', 'תזכורת'], meeting: ['👥', 'פגישה'], thought: ['💭', 'מחשבה'] }, focus = pre.mode || null;
  if (pre.mode === 'remind') kind = 'task';
  const plc = PLUS.find(x => x[0] === (pre.tpl ? 'tpl' : focus));
  sheet(`${focus ? `<div class="pl-head"><span class="pl-ic" style="background:${plc?.[3] || 'var(--g1)'}">${pre.tpl ? '📋' : KT[focus][0]}</span><h3>${pre.tpl ? 'מתבנית' : pre.stars != null && pre.forP ? `מטלה ל${esc(pName(pre.forP))}` : KT[focus][1]}</h3><button class="chip" id="qBack">↩️ החלפה</button></div>` : '<h3>➕ הוספה</h3>'}
    <div ${pre.tpl ? '' : 'hidden'}><label>📋 בוחרים תבנית</label><div class="chips" id="qTpl" style="padding:0;flex-wrap:wrap">${allTemplates().map(t => `<button class="chip" data-t="${t.id}">${t.ic} ${esc(t.name)}</button>`).join('')}</div></div>
    <div class="seg" id="qKind" style="margin-top:10px" ${focus ? 'hidden' : ''}>${[['task', '📌 משימה'], ['meeting', '👥 פגישה'], ['thought', '💭 מחשבה']].map(([k, l]) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${l}</button>`).join('')}</div>
    <label>מה</label><input id="qText" placeholder="למשל: לקנות מתנה לאמא" enterkeyhint="done" value="${esc(pre.text || '')}">
    <div id="qWhen"><label>מתי</label><div class="chips" id="qDay" style="padding:0;flex-wrap:wrap">${[['0', 'היום'], ['1', 'מחר'], ['x', '📅 תאריך'], ['', 'בלי תאריך']].map(([k, l]) => `<button class="chip ${k === '0' ? 'on' : ''}" data-d="${k}">${l}</button>`).join('')}</div>
    <input type="date" id="qDate" hidden style="margin-top:8px">
    <div class="two"><div><label>שעה (לא חובה)</label><input type="time" id="qTime" value="${pre.time || ''}"></div>
    <div><label>כמה זמן</label><select id="qDur"><option value="">לא ידוע</option><option value="0">רק תזכורת</option>${[15, 30, 45, 60, 90, 120, 180].map(m => `<option value="${m}">${durLbl(m)}</option>`).join('')}</select></div></div></div>
    ${pre.stars != null ? starPicker(pre.stars) : ''}
    <label>קטגוריה</label><div id="qCat">${catChips(defGroup()?.id || null, '')}</div>
    <label class="set-row" id="qShabRow" style="cursor:pointer;border:none;padding:8px 0 0"><span>🕯️ להזכיר גם בשבת ובחג</span><input type="checkbox" id="qShab"></label>
    <button class="btn" id="qRecur" style="margin-top:12px" ${focus === 'thought' ? 'hidden' : ''}>🔁 חוזר? (כל יום / שבוע…, ולכמה זמן)</button>
    <button class="btn pri" id="qSave" style="margin-top:8px">➕ הוסף</button>
    <button class="btn" id="qCancel">ביטול</button>`);
  $('#qRecur').onclick = () => openRecur(null, { text: $('#qText').value.trim(), time: $('#qTime').value });
  let qcat = '', qsteps = null, qstars = pre.stars || 0;
  if ($('#stPick')) pickChips($('#stPick'), 'data-n', v => { qstars = +v; });
  pickChips($('#qCat'), 'data-cat', v => { qcat = v; });
  $('#qTpl').addEventListener('click', e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    const on = !b.classList.contains('on'); $('#qTpl').querySelectorAll('[data-t]').forEach(x => x.classList.toggle('on', x === b && on));
    const t = allTemplates().find(x => x.id === b.dataset.t);
    qsteps = on ? t.steps : null; if (on) { $('#qText').value = t.name; toast(`📝 ${t.steps.length} שלבים יתווספו`); }
  });
  let day = '0';
  if (pre.day) { // מהיומן: יום ושעה מוכנים
    const diff = Math.round((sod(pre.day) - sod(new Date())) / 864e5);
    day = diff === 0 || diff === 1 ? String(diff) : 'x';
    [...$('#qDay').children].forEach(x => x.classList.toggle('on', x.dataset.d === day));
    if (day === 'x') { $('#qDate').hidden = false; $('#qDate').value = ymd(pre.day); }
    if (pre.time) $('#qDur').value = '30';
  }
  const syncKind = () => { $('#qWhen').style.display = kind === 'thought' ? 'none' : ''; };
  $('#qKind').onclick = e => { const b = e.target.closest('button'); if (!b) return; kind = b.dataset.k; [...$('#qKind').children].forEach(x => x.classList.toggle('on', x === b)); syncKind(); };
  $('#qDay').onclick = e => {
    const b = e.target.closest('[data-d]'); if (!b) return; day = b.dataset.d;
    [...$('#qDay').children].forEach(x => x.classList.toggle('on', x === b));
    $('#qDate').hidden = day !== 'x'; if (day === 'x') { $('#qDate').value ||= ymd(addDays(new Date(), 2)); try { $('#qDate').showPicker?.(); } catch { /* */ } }
  };
  $('#qCancel').onclick = closeSheet;
  $('#qBack')?.addEventListener('click', () => openPlus());
  const PH = { task: 'למשל: לקנות מתנה לאמא', remind: 'למשל: להתקשר לבנק', meeting: 'למשל: פגישה עם רואה החשבון', thought: 'למשל: רעיון לטיול בחופש' };
  if (focus) $('#qText').placeholder = PH[focus];
  if (focus === 'remind') $('#qTime').previousElementSibling.textContent = '⏰ באיזו שעה להזכיר';
  if (focus === 'remind') { $('#qTime').value ||= hm(new Date(Math.ceil((Date.now() + 30 * 60e3) / 9e5) * 9e5)); $('#qDur').value = '0'; }
  if (focus === 'thought') { $('#qWhen').style.display = 'none'; $('#qShabRow').hidden = true; }
  setTimeout(() => $('#qText')?.focus(), 300);
  $('#qSave').onclick = async () => {
    const text = $('#qText').value.trim(); if (!text) return toast('צריך לכתוב מה', true);
    const ts = $('#qTime').value; let due = null;
    if (kind !== 'thought' && day !== '') {
      due = day === 'x' ? new Date(($('#qDate').value || ymd(new Date())) + 'T00:00') : sod(addDays(new Date(), +day));
      if (ts) { const [h, m] = ts.split(':'); due.setHours(+h, +m); }
    }
    const dv = $('#qDur').value;
    const back = pre.day ? 'cal' : pre.stars != null ? 'kids' : 'chat';
    closeSheet(); if (back === 'chat') showView('chat');
    await createItem({ kind, text, due, hasTime: !!(due && ts), repeat: null, dur: dv === '' ? null : +dv, forP: pre.forP && pre.forP !== S.myP ? pre.forP : null, private: false, group: pre.forP && pre.forP !== S.myP ? sharedGroup(pre.forP)?.id || null : null, cat: qcat || null, steps: qsteps ? mkSteps(qsteps) : null, stars: qstars || null, shabbatOk: $('#qShab')?.checked || null }, null);
    toast('✅ נוסף');
  };
}
// ➕ הכפתור הראשי: רק אריחים גדולים ויפים. לוחצים על אחד — נפתח רק מה ששייך אליו
const PLUS = [
  ['task', '📌', 'משימה', 'linear-gradient(135deg,#7C3AED,#A855F7)'],
  ['remind', '⏰', 'תזכורת', 'linear-gradient(135deg,#F59E0B,#F97316)'],
  ['meeting', '👥', 'פגישה', 'linear-gradient(135deg,#3B82F6,#06B6D4)'],
  ['shop', '🛒', 'קניות', 'linear-gradient(135deg,#22C55E,#14B8A6)'],
  ['med', '💊', 'תרופה / קבוע', 'linear-gradient(135deg,#14B8A6,#0EA5E9)'],
  ['habit', '🔥', 'הרגל', 'linear-gradient(135deg,#F97316,#EF4444)'],
  ['timer', '⏱️', 'טיימר', 'linear-gradient(135deg,#6366F1,#8B5CF6)'],
  ['thought', '💭', 'מחשבה', 'linear-gradient(135deg,#A855F7,#EC4899)'],
  ['menu', '🍲', 'תפריט שבת', 'linear-gradient(135deg,#EAB308,#F59E0B)'],
  ['kid', '⭐', 'מטלה לילד', 'linear-gradient(135deg,#FACC15,#FB923C)'],
  ['tpl', '📋', 'מתבנית', 'linear-gradient(135deg,#64748B,#475569)'],
];
const PLUS_GO = [
  ['cal', '📅', 'יומן', 'linear-gradient(135deg,#3B82F6,#6366F1)'],
  ['tasks', '📋', 'המשימות', 'linear-gradient(135deg,#7C3AED,#A855F7)'],
  ['shop', '🛒', 'רשימות קניות', 'linear-gradient(135deg,#22C55E,#14B8A6)'],
  ['recur', '🔁', 'הקבועים שלי', 'linear-gradient(135deg,#14B8A6,#0EA5E9)'],
  ['habits', '🔥', 'ההרגלים', 'linear-gradient(135deg,#F97316,#EF4444)'],
  ['kids', '⭐', 'הילדים', 'linear-gradient(135deg,#FACC15,#FB923C)'],
  ['thoughts', '💭', 'המחשבות', 'linear-gradient(135deg,#A855F7,#EC4899)'],
  ['kesef', '💰', 'כסף בכיף (תקציב וחסכונות)', 'linear-gradient(135deg,#16A34A,#65A30D)'],
  ['settings', '⚙️', 'הגדרות', 'linear-gradient(135deg,#64748B,#334155)'],
  ['help', '❓', 'עזרה', 'linear-gradient(135deg,#0EA5E9,#2563EB)'],
];
function openPlus() {
  const kids = kidsList();
  sheet(`<h3>➕ מה מוסיפים?</h3>
    <div class="plus-grid">${PLUS.filter(([k]) => k !== 'kid' || kids.length).map(([k, ic, l, bg], i) => `<button class="plus-tile" data-pl="${k}" style="--d:${i * 40}ms"><span class="pl-ic" style="background:${bg}">${ic}</span>${l}</button>`).join('')}</div>
    <div class="plus-sec">🧭 לעבור ל…</div>
    <div class="plus-grid small">${PLUS_GO.filter(([k]) => k !== 'kids' || kids.length).map(([k, ic, l, bg], i) => `<button class="plus-tile" data-go="${k}" style="--d:${(i + 11) * 30}ms"><span class="pl-ic" style="background:${bg}">${ic}</span>${l}</button>`).join('')}</div>
    <p class="note plus-tip">💡 אפשר גם פשוט לכתוב או להגיד בשיחה, למשל "תזכיר לי מחר ב-10 להתקשר לבנק"</p>`);
  $('#sheet').querySelector('.plus-grid.small').onclick = e => {
    const k = e.target.closest('[data-go]')?.dataset.go; if (!k) return;
    if (k === 'kesef') { closeSheet(); return window.open(KESEF_URL, '_blank', 'noopener'); }
    if (k === 'help') return openHelp();
    closeSheet();
    if (k === 'recur') return OPS.recurList();
    if (k === 'habits') { showView('tasks'); return setTimeout(() => $('.habits')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250); }
    showView(k);
  };
  $('#sheet').querySelector('.plus-grid').onclick = e => {
    const k = e.target.closest('[data-pl]')?.dataset.pl; if (!k) return;
    if (['task', 'remind', 'meeting', 'thought'].includes(k)) return openQuick({ mode: k, kind: k === 'remind' ? 'task' : k });
    if (k === 'tpl') return openQuick({ mode: 'task', kind: 'task', tpl: true });
    if (k === 'shop') { closeSheet(); showView('shop'); return setTimeout(() => $('#shopIn')?.focus(), 350); }
    if (k === 'med') return openRecur(null, {});
    if (k === 'habit') return openHabit(null);
    if (k === 'timer') return pickFocusTask();
    if (k === 'menu') return openMenu();
    if (k === 'kid') {
      if (kids.length === 1) return openQuick({ mode: 'task', forP: kids[0].id, kind: 'task', stars: 1 });
      sheet(`<h3>⭐ מטלה ל…</h3><div class="plus-grid">${kids.map(p => `<button class="plus-tile" data-kid="${p.id}"><span class="pl-ic" style="background:linear-gradient(135deg,#FACC15,#FB923C)">${esc(p.e)}</span>${esc(pName(p.id))}</button>`).join('')}</div>`);
      $('#sheet').querySelector('.plus-grid').onclick = ev => { const id = ev.target.closest('[data-kid]')?.dataset.kid; if (id) openQuick({ mode: 'task', forP: id, kind: 'task', stars: 1 }); };
    }
  };
}
$h('#plusBtn').onclick = () => openPlus();

function openEdit(id, focus, forceKind) {
  const it = item(id); if (!it) return toast('המשימה הזאת כבר לא קיימת', true);
  let kind = forceKind || it.kind;
  const d = it.due ? new Date(it.due) : null;
  const custom = it.repeat && (it.repeat.times || it.repeat.until || it.med || ['days', 'months', 'yearly', 'hebDay'].includes(it.repeat.type));
  const rep = custom ? 'keep' : it.repeat?.erev ? 'erevShabbat' : it.repeat?.type || '';
  sheet(`<h3>✏️ עריכה</h3>
    <label>סוג</label><div class="seg" id="eKind">${[['task', '📌 משימה'], ['meeting', '👥 פגישה'], ['thought', '💭 מחשבה']].map(([k, l]) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${l}</button>`).join('')}</div>
    <label>מה</label><input id="eText" value="${esc(it.text)}">${it.raw && it.raw !== it.text ? `<p class="note" style="margin-top:4px">✍️ במקור כתבת: "${esc(it.raw)}"</p>` : ''}
    <div id="eWhen"><div class="two"><div><label>תאריך</label><input type="date" id="eDate" value="${d ? ymd(d) : ''}"></div>
    <div><label>שעה (לא חובה)</label><input type="time" id="eTime" value="${d && it.hasTime ? hm(d) : ''}"></div></div>
    <label>חוזר</label><select id="eRep"><option value="">לא חוזר</option><option value="daily">כל יום</option><option value="weekly">כל שבוע</option><option value="monthly">כל חודש</option><option value="erevShabbat">🕯️ כל ערב שבת</option><option value="roshChodesh">🌙 כל ראש חודש</option><option value="erevChag">🍷 כל ערב חג</option>${custom ? `<option value="keep">🔁 ${esc(whenLabel(it))}</option>` : ''}</select>${it.repeat ? '<button class="chip" id="eRecur" style="margin-top:8px">🔁 הגדרות קבוע (שעות, לכמה זמן, תרופה)</button>' : ''}</div>
    <div id="eWhen2"><div class="two"><div><label>כמה זמן</label><select id="eDur"><option value="">לא ידוע</option><option value="0">רק תזכורת</option>${[15, 30, 45, 60, 90, 120, 180, 240].map(m => `<option value="${m}">${durLbl(m)}</option>`).join('')}</select></div>
    <div><label>איפה (לא חובה)</label><input id="ePlace" value="${esc(it.place || '')}" list="placeList"><datalist id="placeList">${knownPlaces().concat(C.CITIES).map(x => `<option value="${esc(x)}">`).join('')}</datalist></div></div></div>
    ${it.forP && isKid(it.forP) ? starPicker(it.stars || 0) : ''}
    ${it.kind !== 'thought' ? `<label class="set-row" style="cursor:pointer;border:none;padding:10px 0 0"><span>🕯️ להזכיר גם בשבת ובחג</span><input type="checkbox" id="eShab" ${it.shabbatOk ? 'checked' : ''}></label><p class="note">${it.shabbatOk ? '' : 'כבוי: מה שנופל בשבת או בחג עובר למוצאי שבת/חג.'}</p>` : ''}
    ${it.kind !== 'thought' ? `<label>🔢 ספירה: מתוך כמה (למשל 5 פרקים). ריק = בלי</label><div style="display:flex;gap:8px;align-items:center"><input type="number" id="eProg" min="2" max="99" class="num" style="width:90px" value="${it.prog?.of || ''}">${it.prog?.of ? `<span class="note">עכשיו: ${it.prog.n || 0}/${it.prog.of}</span>` : ''}</div>` : ''}
    <label>קטגוריה</label><div id="eCat">${catChips(it.group_id, it.cat || '')}</div>
    ${S.uid ? `<label>שייכת ל</label><div class="set-row" style="border:none;padding:4px 0"><b>${esc(assignLabel(it))}</b><button class="act pri" id="eAssign">📎 שיוך</button></div>` : ''}
    ${it.kind !== 'thought' ? `<button class="btn" id="eFocus" style="margin-top:12px">⏱️ טיימר פוקוס על זה</button>` : ''}
    <button class="btn" id="eSteps">${it.steps?.length ? `📝 שלבים (${stepsLbl(it).slice(3)})` : '✂️ לפרק לשלבים'}</button>
    ${S.uid ? `<button class="btn" id="eCm">💬 תגובות${it.comments?.length ? ` (${it.comments.length})` : ''}</button>` : ''}
    <button class="btn pri" id="eSave" style="margin-top:16px">💾 שמור</button>
    <div class="two"><button class="btn" id="eCancel">ביטול</button><button class="btn danger" id="eDel">🗑️ מחק</button></div>`);
  $('#eRep').value = rep;
  let ecat = it.cat || '', estars = it.stars || 0;
  if ($('#stPick')) pickChips($('#stPick'), 'data-n', v => { estars = +v; });
  pickChips($('#eCat'), 'data-cat', v => { ecat = v; });
  if (it.dur != null && ![0, 15, 30, 45, 60, 90, 120, 180, 240].includes(it.dur)) $('#eDur').insertAdjacentHTML('beforeend', `<option value="${it.dur}">${durLbl(it.dur)}</option>`);
  $('#eDur').value = it.dur == null ? '' : String(it.dur);
  const syncKind = () => { $('#eWhen').style.display = $('#eWhen2').style.display = kind === 'thought' ? 'none' : ''; };
  syncKind();
  $('#eKind').onclick = e => { const b = e.target.closest('button'); if (!b) return; kind = b.dataset.k; [...$('#eKind').children].forEach(x => x.classList.toggle('on', x === b)); syncKind(); };
  $('#eAssign')?.addEventListener('click', () => openAssign(id));
  $('#eCm')?.addEventListener('click', () => openComments(id));
  $('#eSteps').onclick = () => openSteps(id);
  $('#eRecur')?.addEventListener('click', () => openRecur(it));
  $('#eFocus')?.addEventListener('click', () => openFocusPick(id));
  if (focus === 'date') setTimeout(() => { try { $('#eDate').showPicker?.(); } catch { $('#eDate').focus(); } }, 350);
  $('#eCancel').onclick = closeSheet;
  $('#eDel').onclick = () => askRemove(id);
  $('#eSave').onclick = async () => {
    const text = $('#eText').value.trim(); if (!text) return toast('צריך לכתוב מה', true);
    const ds = $('#eDate').value, ts = $('#eTime').value, rt = $('#eRep').value;
    let due = null, hasTime = !!ts, repeat = null;
    if (kind !== 'thought') {
      if (ds) { due = new Date(ds + 'T00:00'); if (ts) { const [h, m] = ts.split(':'); due.setHours(+h, +m); } }
      else if (ts) { due = sod(new Date()); const [h, m] = ts.split(':'); due.setHours(+h, +m); if (due <= new Date() && !rt) due = addDays(due, 1); }
      if (rt === 'keep') { repeat = it.repeat; due = it.due ? new Date(it.due) : null; hasTime = it.hasTime; }
      else if (rt) {
        const base = due || new Date();
        repeat = rt === 'erevShabbat' ? { type: 'weekly', dows: [5], erev: true } : rt === 'roshChodesh' || rt === 'erevChag' ? { type: rt } : rt === 'daily' ? { type: 'daily' } : rt === 'weekly' ? { type: 'weekly', dows: it.repeat?.type === 'weekly' && !ds ? it.repeat.dows : [base.getDay()] } : { type: 'monthly', dom: base.getDate() };
        due = nextOccurrence(repeat, ts ? +ts.split(':')[0] : 9, ts ? +ts.split(':')[1] : 0, new Date(Math.min(sod(base), Date.now()) - 1));
        if (due && due < new Date() && hasTime) due = nextOccurrence(repeat, due.getHours(), due.getMinutes(), new Date());
      }
    } else hasTime = false;
    Object.assign(it, { kind, text, due: due ? due.toISOString() : null, hasTime: kind === 'thought' ? false : hasTime, repeat, askAt: null, askedKey: null });
    if ($('#eShab')) it.shabbatOk = $('#eShab').checked || null;
    const pv = +($('#eProg')?.value || 0); it.prog = pv > 1 ? { n: Math.min(pv, it.prog?.n || 0), of: pv } : null;
    const dv = $('#eDur').value; it.dur = dv === '' ? null : +dv; it.place = $('#ePlace').value.trim() || null; it.cat = ecat || null; if ($('#stPick')) it.stars = estars || null;
    it.res = C.findRes(text, S.resources); if (!it.res.length) it.res = null;
    await save(it); closeSheet(); renderAll();
    toast('✏️ נשמר');
    scanConflicts();
    if (S.pending === id) S.pending = null;
  };
}

// ---------- 📎 שיוך: רק לי / קבוצה / אדם בקבוצה / קשר ישיר ----------
function assignLabel(it) {
  const g = groupOf(it.group_id);
  if (it.forP === 'any') return `👨‍👩‍👧 מישהו מאיתנו · ${gLabel(g)}`;
  if (it.forP && it.forP !== S.myP) return `🙋 ${whoIn(it.forP, it.group_id)}${g && g.kind !== 'pair' ? ' · ' + gLabel(g) : ''}`;
  return g ? `👥 ${gLabel(g)}` : '🔒 רק לי';
}
function openAssign(id) {
  const it = item(id); if (!it) return toast('המשימה הזאת כבר לא קיימת', true);
  if (!S.uid) { toast('כדי לשייך צריך קודם להיכנס', true); return showGate(); }
  const gs = sync.myGroups(), cur = (g, p) => (it.group_id || null) === (g || null) && (it.forP || null) === (p || null);
  const opt = (g, p, label, sub) => `<div class="pick${cur(g, p) ? ' on' : ''}" data-g="${g || ''}" data-p="${p || ''}"><div class="ck">${cur(g, p) ? '✓' : ''}</div>${label}${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  let html = opt(null, null, '🔒 רק לי', 'אף אחד אחר לא רואה');
  for (const g of gs.filter(g => g.kind !== 'pair')) {
    html += `<p class="note" style="margin:12px 0 6px">${esc(gLabel(g))}</p>` + opt(g.id, null, `👥 כל ${esc(g.name)}`, 'כולם בקבוצה רואים');
    if (g.kind === 'family' || g.members.filter(m => m.user_id).length > 2) html += opt(g.id, 'any', '👨‍👩‍👧 מישהו מאיתנו', 'אבדוק שמישהו פנוי');
    for (const m of g.members.filter(m => m.user_id !== S.uid)) { const pid = m.user_id ? 'u:' + m.user_id : 'm:' + m.id; html += opt(g.id, pid, `🙋 ${esc(m.profile?.emoji || m.emoji || '🙂')} ${esc(m.nickname)}`, m.user_id ? 'יקבל/תקבל "עשית?"' : 'רק שם — אשאל אותך'); }
  }
  const pairs = gs.filter(g => g.kind === 'pair');
  if (pairs.length) html += `<p class="note" style="margin:12px 0 6px">👤 קשרים ישירים (רק שניכם)</p>` + pairs.map(g => { const o = pairOther(g); return o ? opt(g.id, o.id, `👤 ${esc(o.e)} ${esc(o.name)}`, 'רק שניכם רואים') : opt(g.id, null, '👤 ממתין שיצטרף…', 'אפשר לשתף כבר עכשיו'); }).join('');
  sheet(`<h3>📎 שיוך</h3><p class="note" style="margin-bottom:10px">${esc(it.text)}</p><div id="asList">${html}</div>
    <div class="two" style="margin-top:12px"><button class="btn" id="asNewPerson" style="margin:0">➕ אדם חדש</button><button class="btn" id="asNewGroup" style="margin:0">➕ קבוצה חדשה</button></div>`);
  $('#asList').onclick = async e => {
    const el = e.target.closest('.pick'); if (!el) return;
    const g = el.dataset.g || null, p = el.dataset.p || null;
    closeSheet(); await setAssign(it, g, p);
  };
  $('#asNewPerson').onclick = () => { closeSheet(); openNewPair(it.id); };
  $('#asNewGroup').onclick = () => { closeSheet(); openNewGroup(); };
}
// הצטרפתי לקבוצה → כולם בה מקבלים הודעה
async function announceJoin(gid) {
  const g = groupOf(gid); if (!g) return;
  const myNick = g.members.find(m => m.user_id === S.uid)?.nickname || sync.myProfile()?.full_name || 'מישהו';
  for (const m of g.members) if (m.user_id && m.user_id !== S.uid) await queueNotify(m.user_id, 'join', `👥 ${myNick} הצטרף/ה ל"${g.name}"`, 'עכשיו אפשר לתת לו/ה משימות ולשלוח הודעות', `join:${gid}`);
}
// מישהו חדש בקבוצה שלי → לפעמון
async function watchJoins() {
  if (!S.uid) return;
  const known = await db.getKV('knownMembers', null), now = {};
  for (const g of sync.myGroups()) for (const m of g.members) {
    now[m.id] = 1;
    if (known && !known[m.id] && m.user_id !== S.uid) await bell('👥', `${m.nickname} הצטרף/ה ל"${g.name}"`, '', { view: 'settings' }, 'join:' + m.id);
  }
  await db.setKV('knownMembers', now);
}
// הודעה לטלפון לכל מי שבקבוצה (חוץ ממני ומילדים בלי טלפון)
async function notifyGroup(gid, title, it) {
  const g = groupOf(gid); if (!g) return;
  for (const m of g.members) if (m.user_id && m.user_id !== S.uid && !(it.private)) await queueNotify(m.user_id, 'group', title, `${it.text}${it.due ? ' · ' + whenLabel(it) : ''}`, it.id);
}
async function setAssign(it, g, p) {
  const before = it.forU;
  it.group_id = g; it.forP = p === 'any' ? 'any' : (p && p !== S.myP ? p : null);
  it.forU = it.forP && it.forP !== 'any' ? person(it.forP)?.uid || null : null;
  it.private = !g; it.askedKey = null;
  if (it.kind === 'thought' && it.forP) it.kind = 'task';
  await save(it); renderAll(); scanConflicts();
  toast(`📎 ${assignLabel(it)}`);
  if (it.forU && it.forU !== S.uid && it.forU !== before)
    await queueNotify(it.forU, 'share', `📎 ${nameIn(S.myP, g)} שייך/ה לך משימה`, `${it.text}${it.due ? ' · ' + whenLabel(it) : ''}`, it.id);
  else if (g && !it.forU) await notifyGroup(g, `📎 ${nameIn(S.myP, g)} שייך/ה ל"${groupOf(g)?.name || 'הקבוצה'}"`, it);
}

function openPicker(mustSwapFor) {
  const t3 = curTop3();
  let sel = t3.ids.filter(x => item(x));
  const cands = rankForToday(openItems().filter(x => x.kind === 'task' && isMine(x) && (!x.due || x.due && new Date(x.due) < addDays(sod(new Date()), 2))));
  if (mustSwapFor && !cands.find(x => x.id === mustSwapFor)) cands.unshift(item(mustSwapFor));
  const extra = top3Items().filter(x => !cands.includes(x));
  const all = [...extra, ...cands];
  if (mustSwapFor) sel = sel.concat(mustSwapFor);
  const draw = () => {
    $('#pickList').innerHTML = all.length ? all.map(x => `<div class="pick${sel.includes(x.id) ? ' on' : ''}" data-id="${x.id}"><div class="ck">${sel.includes(x.id) ? '✓' : ''}</div>${esc(x.text)}<small>${esc(whenLabel(x))}</small></div>`).join('')
      : '<p class="note" style="padding:6px 0">אין משימות פתוחות. כתוב כאן משימה חדשה:</p>';
    $('#pickCount').textContent = sel.length ? `נבחרו ${sel.length}` : '';
  };
  sheet(`<h3>⭐ החשובים של היום</h3><p class="note" style="margin-bottom:10px">בוחרים את מה שחייב לקרות היום, כמה שרוצים. <b id="pickCount"></b></p>
    <div id="pickList"></div>
    <label>או להוסיף משימה חדשה להיום</label><div style="display:flex;gap:8px"><input id="pickNew" placeholder="למשל: לשלוח הצעת מחיר"><button class="round mic" id="pickAdd" style="width:46px;height:46px;font-size:18px">＋</button></div>
    <button class="btn pri" id="pickSave" style="margin-top:16px">💾 שמור</button>`);
  draw();
  $('#pickList').onclick = e => {
    const id = e.target.closest('.pick')?.dataset.id; if (!id) return;
    if (sel.includes(id)) sel = sel.filter(x => x !== id);
    else sel.push(id);
    draw();
  };
  $('#pickAdd').onclick = async () => {
    const text = $('#pickNew').value.trim(); if (!text) return;
    const it = { id: db.newId(), kind: 'task', text, due: sod(new Date()).toISOString(), hasTime: false, repeat: null, status: 'open', created: new Date().toISOString() };
    S.items.push(it); await save(it); await addLog(it, 'created');
    all.unshift(it); sel.push(it.id); $('#pickNew').value = ''; draw();
  };
  $('#pickSave').onclick = async () => {
    S.top3 = { date: today(), ids: sel }; await db.setKV('top3', S.top3); closeSheet(); renderAll(); toast('⭐ נשמר');
  };
}

// ---------- ניווט ותצוגה ----------
function showView(v, fromPop) {
  const from = curView(), tabs = ['thoughts', 'kids', 'tasks'];
  if (!fromPop && v !== from) { if (v === 'chat') NAV.stack = []; else if (!(tabs.includes(v) && tabs.includes(from))) NAV.stack.push(from); }
  if (v === 'settings') { drawDemoCard(); renderProfile(); drawPush(); drawLockCard(); drawMonthly(); drawCalCard(); drawCatCard(); drawViewCard(); drawGcal(); }
  document.querySelectorAll('nav button[data-v]').forEach(x => x.classList.toggle('on', x.dataset.v === (['thoughts', 'kids'].includes(v) ? 'tasks' : v)));
  $('#setBtn')?.classList.toggle('on', v === 'settings');
  seeView(v);
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + v));
  enterAnim($('#v-' + v));
  if (v === 'shop') renderShop();
  if (v === 'kids') renderKids();
  $('#composer').style.display = v === 'chat' ? 'flex' : 'none';
  if (v === 'chat') { renderChat(); const ud = $('#unreadDiv'); if (ud) requestAnimationFrame(() => ud.scrollIntoView({ block: 'start' })); else $('#main').scrollTop = $('#main').scrollHeight; } else $('#main').scrollTop = 0;
  if (v === 'cal') { CAL.jump = true; renderCal(true); }
  setTimeout(syncTrap, 0);
}
document.querySelectorAll('.tabs2').forEach(t => t.onclick = e => { const b = e.target.closest('[data-v]'); if (b) showView(b.dataset.v); });
document.querySelectorAll('nav button[data-v]').forEach(b => b.onclick = () => showView(b.dataset.v));
$h('#todayBtn').onclick = () => { showView('chat'); send('מה יש לי היום?'); };
$h('#t3edit').onclick = () => openPicker();

function renderChat() {
  $('#chat').innerHTML = ''; lastDay = null;
  const n = S.msgs.filter(m => m.role === 'bot' && m.ts > (S.chatFrom || '')).length; let shown = false;
  S.msgs.forEach(m => {
    if (n && !shown && m.role === 'bot' && m.ts > (S.chatFrom || '')) { shown = true; const d = document.createElement('div'); d.className = 'unread-div'; d.id = 'unreadDiv'; d.textContent = `📩 ${n === 1 ? 'הודעה אחת שלא נקראה' : n + ' הודעות שלא נקראו'}`; $('#chat').appendChild(d); }
    appendMsg(m, false);
  });
}
function renderAll() {
  const n = new Date();
  $('#hdate').textContent = hebMain() ? `יום ${DAYS[n.getDay()]}, ${hebDate(n)} · ${n.getDate()}.${n.getMonth() + 1}` : `יום ${DAYS[n.getDay()]}, ${n.getDate()}.${n.getMonth() + 1} · ${hebDate(n)}`;
  renderTop3(); renderDayline(); renderTasks(); renderThoughts(); renderRes(); renderCal(); renderShop(); renderKids();
  document.querySelectorAll('.tabs2 [data-v="kids"]').forEach(b => { b.hidden = !kidsList().length; });
  const s = streak(); $('#streak').textContent = s >= 2 ? `🔥 ${s} ימים ברצף` : s === 1 ? '🔥 יום 1' : '';
}

// הודעה קצרה למעלה. עם act — גם כפתור (למשל "↩️ בטל" אחרי מחיקה), והיא נשארת יותר זמן
function toast(t, err, act) {
  const el = $('#toast'); el.textContent = t; el.classList.toggle('err', !!err); el.classList.add('show');
  if (act) {
    const b = document.createElement('button'); b.className = 'toast-act'; b.textContent = act.l;
    b.onclick = () => { el.classList.remove('show'); act.run(); }; el.append(' ', b);
  }
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), act ? 6000 : 2400);
}
// "לחיצה נוספת לאישור" במקום חלון אישור של הדפדפן
function tapAgain(btn, q) {
  if (!btn) return true;
  if (btn.dataset.armed) { clearTimeout(btn._t); delete btn.dataset.armed; btn.textContent = btn._orig; return true; }
  btn._orig = btn.textContent; btn.dataset.armed = '1'; btn.textContent = q;
  btn._t = setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn._orig; }, 4000);
  return false;
}
function confetti(n = 70) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cols = ['#7C3AED', '#EC4899', '#F97316', '#22C55E', '#06B6D4', '#FACC15'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('div'); p.className = 'conf';
    p.style.left = Math.random() * 100 + '%'; p.style.background = cols[i % cols.length];
    p.style.animationDuration = (1.6 + Math.random() * 1.6) + 's'; p.style.animationDelay = Math.random() * .3 + 's';
    $('#app').appendChild(p); setTimeout(() => p.remove(), 3600);
  }
}

// ---------- כתיבה וקול ----------
const inp = $('#inp');
inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { const v = inp.value; inp.value = ''; updateMic(); send(v); } });
inp.addEventListener('input', updateMic);
function updateMic() { $('#mic').textContent = inp.value.trim() ? '➤' : '🎤'; }

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
// הקלטה: לחיצה קצרה = מקליט עד ⏹️ · החזקה = מקליט ונשלח כשעוזבים · החזקה וגרירה למעלה = נעילה · גרירה הצידה = ביטול
let rec = null;
const R = { on: false, hold: false, locked: false, cancel: false, stopping: false, skip: false, text: '', cur: '', mid: '', t0: 0, timer: null, sx: 0, sy: 0, down: 0 };
const mic = $('#mic');
function recBegin() {
  if (!SR) { toast('🎤 הדפדפן הזה לא תומך בהקלטה. אפשר ללחוץ על המיקרופון במקלדת של הטלפון'); inp.focus(); return false; }
  Object.assign(R, { on: true, hold: false, locked: false, cancel: false, stopping: false, text: '', cur: '', mid: '', t0: Date.now() });
  $('#composer').classList.add('recording'); $('#recBar').hidden = false; mic.classList.add('rec');
  clearInterval(R.timer); R.timer = setInterval(drawRec, 250); drawRec();
  recRun(); return true;
}
function recRun() {
  rec = new SR(); rec.lang = 'he-IL'; rec.interimResults = true; rec.continuous = true;
  rec.onresult = e => { let fin = '', mid = ''; for (const r of e.results) r.isFinal ? fin += r[0].transcript : mid += r[0].transcript; R.cur = fin; R.mid = mid; drawRec(); };
  rec.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { R.cancel = true; toast('🎤 צריך לאשר גישה למיקרופון', true); }
    else if (e.error === 'network') { R.stopping = true; toast('🎤 ההקלטה צריכה אינטרנט', true); }
    else if (!['no-speech', 'aborted'].includes(e.error)) toast('🎤 לא הצלחתי לשמוע, נסה שוב', true);
  };
  rec.onend = () => {
    R.text = [R.text, R.cur, R.mid].map(x => x.trim()).filter(Boolean).join(' '); R.cur = R.mid = ''; rec = null;
    // הדפדפן עוצר לבד אחרי שקט, אז כל עוד ההקלטה פתוחה ממשיכים להקשיב (עד 5 דקות)
    if (R.on && !R.stopping && !R.cancel && Date.now() - R.t0 < 300e3) { try { return recRun(); } catch { /* */ } }
    recFinish();
  };
  rec.start();
}
function recStop(cancel) {
  if (!R.on) return;
  R.cancel = R.cancel || !!cancel; R.stopping = true; R.hold = false; drawRec();
  if (rec) { try { cancel ? rec.abort() : rec.stop(); } catch { recFinish(); } } else recFinish();
}
function recFinish() {
  if (!R.on) return;
  R.on = false; clearInterval(R.timer);
  $('#composer').classList.remove('recording'); $('#recBar').hidden = true; $('#recLock').hidden = true; mic.classList.remove('rec'); updateMic();
  const t = R.text.trim();
  if (R.cancel) return;
  if (t) send(t, true); else toast('🎤 לא שמעתי כלום. נסה שוב, קרוב יותר לטלפון');
}
function drawRec() {
  if (!R.on) return;
  const sec = Math.floor((Date.now() - R.t0) / 1000);
  $('#recTime').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const said = [R.text, R.cur, R.mid].filter(Boolean).join(' ').trim();
  $('#recTxt').textContent = said || (R.hold ? '⬆️ למעלה לנעילה · ↔️ הצידה לביטול' : 'מקשיב… דבר עכשיו');
  $('#recLock').hidden = !R.hold;
  mic.textContent = R.hold ? '🎙️' : '➤';
}
mic.addEventListener('contextmenu', e => e.preventDefault());
mic.addEventListener('pointerdown', e => {
  if (inp.value.trim() || R.on) return; // שליחת טקסט / עצירה — בלחיצה רגילה
  e.preventDefault(); R.skip = true;
  if (!recBegin()) return;
  Object.assign(R, { hold: true, sx: e.clientX, sy: e.clientY, down: Date.now() });
  try { mic.setPointerCapture(e.pointerId); } catch { /* */ }
  drawRec();
});
mic.addEventListener('pointermove', e => {
  if (!R.hold) return;
  const dx = e.clientX - R.sx, dy = e.clientY - R.sy;
  $('#recLock').classList.toggle('hot', dy < -30);
  if (dy < -60) { R.hold = false; R.locked = true; navigator.vibrate?.(25); drawRec(); toast('🔒 ההקלטה נעולה. אפשר לעזוב ולדבר'); }
  else if (Math.abs(dx) > 90) { recStop(true); toast('🗑️ ההקלטה בוטלה'); }
});
const recUp = () => {
  if (!R.hold) return;
  R.hold = false;
  if (Date.now() - R.down < 400) { R.locked = true; drawRec(); return; } // לחיצה קצרה — ממשיכים להקליט עד ⏹️
  recStop(false);
};
mic.addEventListener('pointerup', recUp);
mic.addEventListener('pointercancel', () => { if (R.hold) { R.hold = false; R.locked = true; drawRec(); } });
mic.addEventListener('click', () => {
  if (R.skip) { R.skip = false; return; }
  if (R.on) return recStop(false);
  if (inp.value.trim()) { const v = inp.value; inp.value = ''; updateMic(); send(v); }
});
$h('#recStop').onclick = () => recStop(false);
$h('#recCancel').onclick = () => { recStop(true); toast('🗑️ ההקלטה בוטלה'); };

const CHIPS = ['מה יש לי היום?', 'מה יש מחר?', 'סיכום', 'עזרה'];
$('#chips').innerHTML = CHIPS.map(c => `<button class="chip">${c}</button>`).join('');
$h('#chips').onclick = e => { const c = e.target.closest('.chip'); if (c) send(c.textContent); };

// ---------- דברים משותפים (רכב וכו') ----------
function renderRes() {
  const custom = S.resources.filter(r => !C.DEFAULT_RES.some(d => d.id === r.id));
  $('#resList').innerHTML = S.resources.map(r => `<span class="chip" style="display:inline-block;margin:4px 0 0 6px">${r.e} ${esc(r.n)}${custom.includes(r) ? ` <b data-del="${r.id}" style="cursor:pointer">✕</b>` : ''}</span>`).join('');
}
$h('#resAdd').onclick = async () => {
  const n = $('#resNew').value.trim(); if (!n) return;
  const bare = n.replace(/^ה/, '');
  const custom = (await db.getKV('resources', [])).concat({ id: db.newId(), e: '🔑', n, words: [...new Set([n, bare, 'ה' + bare])] });
  await db.setKV('resources', custom); S.resources = C.DEFAULT_RES.concat(custom); $('#resNew').value = ''; renderRes(); toast('נוסף ✓');
  sync.saveRes(custom).catch(() => {});
};
$h('#resList').onclick = async e => {
  const id = e.target.dataset?.del; if (!id) return;
  const custom = (await db.getKV('resources', [])).filter(r => r.id !== id);
  await db.setKV('resources', custom); S.resources = C.DEFAULT_RES.concat(custom); renderRes();
  sync.saveRes(custom).catch(() => {});
};

// ---------- הגדרות וגיבוי ----------
async function saveSettings() {
  Object.assign(S.settings, { morning: $('#setMorning').value || '07:00', evening: $('#setEvening').value || '20:00',
    city: $('#setCity').value, candleMin: +$('#setCandle').value || 20, melody: $('#setMelody').value,
    shabbatAlerts: [...document.querySelectorAll('#setShAlerts .on')].map(b => +b.dataset.m) });
  await db.setKV('settings', S.settings); toast('נשמר ✓');
  await Z.loadCalendar(S.settings.city, S.settings.candleMin); renderZman(); syncSchedule();
}
function drawShabbatSettings() {
  $('#setCity').innerHTML = Z.CITIES.map(c => `<option>${c[0]}</option>`).join('');
  $('#setCity').value = S.settings.city; $('#setCandle').value = S.settings.candleMin;
  $('#setMelody').innerHTML = Object.entries(Z.MELODIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join(''); $('#setMelody').value = S.settings.melody;
  $('#setShAlerts').innerHTML = [[180, '3 שעות'], [120, 'שעתיים'], [60, 'שעה'], [30, 'חצי שעה'], [15, 'רבע שעה']].map(([m, l]) => `<button class="chip ${(S.settings.shabbatAlerts || []).includes(m) ? 'on' : ''}" data-m="${m}">${l}</button>`).join('');
}
$h('#setCity').onchange = () => { const c = Z.cityOf($('#setCity').value); $('#setCandle').value = c[3]; saveSettings(); };
$h('#setCandle').onchange = saveSettings; $('#setMelody').onchange = () => { Z.play($('#setMelody').value); saveSettings(); };
$h('#setShAlerts').onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; b.classList.toggle('on'); saveSettings(); };
$h('#testMelody').onclick = () => Z.play($('#setMelody').value);
$h('#setMorning').onchange = saveSettings; $('#setEvening').onchange = saveSettings;
$h('#backupBtn').onclick = async () => {
  const data = await db.exportAll();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = `zman-bekef-backup-${today()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('💾 הגיבוי נשמר');
};
$h('#restoreBtn').onclick = () => $('#restoreFile').click();
$h('#restoreFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { const items = await db.importAll(JSON.parse(await f.text())); await sync.queueMany(items); await load(); toast('📂 השחזור הצליח'); }
  catch (err) { toast(err.message || 'הקובץ לא תקין', true); }
  e.target.value = '';
};
$h('#clearChatBtn').onclick = async e => {
  if (!tapAgain(e.currentTarget, '🧹 בטוח? לחץ שוב למחיקה')) return;
  await db.clear('msgs'); S.msgs = []; renderChat(); toast('🧹 השיחה נוקתה');
};
// ---------- התקנה על המסך (כמו אפליקציה רגילה) ----------
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; drawInstallBanner(); });
addEventListener('appinstalled', () => { installEvt = null; drawInstallBanner(); toast('🎉 האפליקציה הותקנה על המסך'); confetti(); });
function openInstallSheet() {
  if (installEvt) { installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; drawInstallBanner(); }); return; }
  sheet(`<h3>📲 התקנה על המסך</h3><p class="note" style="margin-bottom:12px">ככה "זמן בכיף" יופיע עם אייקון במסך הבית, כמו וואטסאפ — ייפתח במסך מלא, יעבוד גם בלי אינטרנט, ויוכל לשלוח התראות</p>
    ${isIOS() ? `<div class="card"><p class="note"><b>🍏 באייפון (Safari):</b><br>1. כפתור השיתוף <b>⬆️</b> בתחתית המסך<br>2. <b>"הוסף למסך הבית"</b><br>3. <b>"הוסף"</b> — וזהו!</p></div>`
      : `<div class="card" style="margin-bottom:10px"><p class="note"><b>🤖 באנדרואיד:</b><br>1. פותחים את הקישור ב-<b>Chrome</b><br>2. <b>⋮</b> (שלוש הנקודות למעלה)<br>3. גוללים למטה ← <b>"התקנת אפליקציה"</b><br>4. מאשרים — וזהו!</p></div>
         <div class="card"><p class="note"><b>💻 במחשב (Chrome / Edge):</b> סמל ההתקנה בשורת הכתובת, או ⋮ ← "התקנה".</p></div>`}`);
}
function drawInstallBanner() {
  const el = $('#installBanner'); if (!el) return;
  if (db.BDIKA) { el.innerHTML = ''; el.hidden = true; return; } // 📱 עמדת בדיקה: בלי באנר התקנה
  let hidden = false; try { hidden = localStorage.getItem('zman-install-hide') === '1'; } catch { /* */ }
  if (isStandalone() || hidden || !location.protocol.startsWith('https')) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="inst"><div class="em">📲</div><p><b>להתקין כאפליקציה?</b><br>אייקון במסך הבית + התראות</p>
    <button class="act pri" id="instGo">התקנה</button><button class="chip" id="instX" aria-label="סגירה">✕</button></div>`;
  $('#instGo').onclick = openInstallSheet;
  $('#instX').onclick = () => { try { localStorage.setItem('zman-install-hide', '1'); } catch { /* */ } drawInstallBanner(); };
}
$h('#installBtn').onclick = openInstallSheet;
drawInstallBanner();

// חזרה מהמייל של "שכחתי סיסמה" — בוחרים סיסמה חדשה
const RECOVERY = /type=recovery/.test(location.hash);
function openNewPassword() {
  sheet(`<h3>🔑 סיסמה חדשה</h3><p class="note">בוחרים סיסמה חדשה לחשבון (אותה סיסמה גם ב"כסף בכיף").</p>
    <input id="npPass" type="password" autocomplete="new-password" placeholder="סיסמה חדשה (לפחות 6 תווים)" dir="ltr">
    <div id="npErr" style="color:#FB7185;font-size:13px;min-height:16px;margin-top:6px"></div>
    <button class="btn pri" id="npSave">💾 שמור סיסמה</button>`);
  $('#npSave').onclick = async () => {
    const p = $('#npPass').value; if (p.length < 6) return $('#npErr').textContent = 'הסיסמה צריכה להיות לפחות 6 תווים';
    try { await sync.setPassword(p); closeSheet(); toast('✅ הסיסמה החדשה נשמרה'); history.replaceState(null, '', location.pathname); }
    catch (x) { $('#npErr').textContent = x.message; }
  };
}

// ---------- נעילה ----------
let pinBuf = '', fails = 0, lockedUntil = 0, hiddenAt = 0;
function showLock() {
  const st = lock.settings(); if (!st) return;
  pinBuf = ''; drawDots(); $('#lockErr').textContent = '';
  $('#lockBio').hidden = !st.cred;
  $('#lockBio').textContent = isIOS() ? '😊 פתיחה עם Face ID (בפנים)' : '😊 פתיחה בפנים או בטביעת אצבע';
  $('#lock').classList.add('on');
  if (st.cred && !isIOS()) tryBio(true);
}
$h('#lock').addEventListener('click', e => { if (e.target.closest('#lockPad') || e.target.closest('#lockBio')) return; if (lock.settings()?.cred) tryBio(false); });
function unlockNow() { $('#lock').classList.remove('on'); fails = 0; }
async function tryBio(auto) {
  try { if (await lock.bioUnlock()) unlockNow(); }
  catch (e) { if (!auto && e.name !== 'NotAllowedError') $('#lockErr').textContent = 'הזיהוי לא הצליח — אפשר להקליד קוד'; }
}
function drawDots() { document.querySelectorAll('#lockDots i').forEach((d, i) => d.classList.toggle('f', i < pinBuf.length)); }
$('#lockPad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map(k => k ? `<button data-k="${k}" aria-label="${k === '⌫' ? 'מחיקה' : k}">${k}</button>` : '<span></span>').join('');
$h('#lockPad').addEventListener('click', async e => {
  const b = e.target.closest('[data-k]'); if (!b) return;
  if (Date.now() < lockedUntil) { $('#lockErr').textContent = `יותר מדי ניסיונות. נסה שוב בעוד ${Math.ceil((lockedUntil - Date.now()) / 1000)} שניות`; return; }
  const k = b.dataset.k;
  pinBuf = k === '⌫' ? pinBuf.slice(0, -1) : (pinBuf + k).slice(0, 4);
  drawDots(); $('#lockErr').textContent = '';
  if (pinBuf.length === 4) {
    if (await lock.pinOk(pinBuf)) { unlockNow(); return; }
    fails++; pinBuf = ''; drawDots();
    $('#lockDots').classList.remove('shake'); void $('#lockDots').offsetWidth; $('#lockDots').classList.add('shake');
    if (fails >= 5) { lockedUntil = Date.now() + 30000; fails = 0; $('#lockErr').textContent = 'יותר מדי ניסיונות. המתן 30 שניות'; }
    else $('#lockErr').textContent = 'קוד שגוי';
  }
});
$h('#lockBio').onclick = () => tryBio(false);
// שכחתי את קוד הנעילה → פותחים עם הסיסמה של החשבון, והנעילה מתבטלת
$h('#lockForgot').onclick = () => {
  if (!sync.user()) { $('#lockErr').textContent = 'בלי חשבון אי אפשר לשחזר. אפשר למחוק את האפליקציה ולהתקין מחדש (מה שבענן חוזר)'; return; }
  $('#lockRec').hidden = false; $('#lockForgot').hidden = true; $('#lockPad').hidden = true; $('#lockDots').hidden = true; $('#lockRecPass').focus();
};
$h('#lockRecGo').onclick = async () => {
  const b = $('#lockRecGo'); b.disabled = true;
  const ok = await sync.verifyPassword($('#lockRecPass').value);
  b.disabled = false;
  if (!ok) { $('#lockErr').textContent = navigator.onLine ? 'הסיסמה לא נכונה' : 'צריך אינטרנט כדי לבדוק את הסיסמה'; return; }
  lock.disable(); $('#lockRecPass').value = ''; $('#lockRec').hidden = true; $('#lockForgot').hidden = false; $('#lockPad').hidden = false; $('#lockDots').hidden = false; unlockNow();
  toast('🔓 הנעילה בוטלה. אפשר להגדיר קוד חדש בהגדרות ← נעילה');
};
document.addEventListener('visibilitychange', () => {
  const st = lock.settings(); if (!st) return;
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt >= (st.minutes ?? 5) * 60000) showLock();
});
showLock();
function drawLockCard() {
  const el = $('#lockCard'); if (!el) return;
  const st = lock.settings();
  if (!st) {
    el.innerHTML = `<h4>🔒 נעילת האפליקציה</h4><p class="note">כדי שלא כל מי שמחזיק את הטלפון יראה את המשימות וההודעות</p><button class="btn" id="lkOn">הפעלת נעילה</button>`;
    $('#lkOn').onclick = async () => {
      const bio = await lock.bioSupported();
      el.innerHTML = `<h4>🔒 בחירת קוד (4 ספרות)</h4>
        <div class="two"><input id="lk1" class="fam-in" type="password" inputmode="numeric" maxlength="4" placeholder="קוד" style="text-align:center;letter-spacing:8px">
        <input id="lk2" class="fam-in" type="password" inputmode="numeric" maxlength="4" placeholder="שוב" style="text-align:center;letter-spacing:8px"></div>
        ${bio ? '<label class="set-row" style="cursor:pointer"><span>😊 גם פתיחה בפנים / טביעת אצבע<br><small class="note">מה שהטלפון שלך יודע: Face ID, זיהוי פנים או טביעת אצבע</small></span><input type="checkbox" id="lkBio" checked></label>' : ''}
        <div id="lkErr" style="color:#FB7185;font-size:13px;min-height:18px"></div><button class="btn pri" id="lkSave">הפעלה</button>`;
      el.querySelectorAll('input').forEach(i => i.oninput = () => $('#lkErr').textContent = '');
      $('#lkSave').onclick = async () => {
        const a = $('#lk1').value, b = $('#lk2').value;
        if (!/^\d{4}$/.test(a)) return $('#lkErr').textContent = 'הקוד צריך להיות 4 ספרות';
        if (a !== b) return $('#lkErr').textContent = 'הקודים לא זהים';
        try { await lock.enable(a, !!$('#lkBio')?.checked, 5); drawLockCard(); toast('🔒 הנעילה הופעלה — תינעל אחרי 5 דקות שהאפליקציה סגורה'); }
        catch (e) { if (e.name === 'NotAllowedError') { await lock.enable(a, false, 5); drawLockCard(); toast('🔒 הנעילה הופעלה עם קוד בלבד'); } else $('#lkErr').textContent = 'לא הצלחתי להפעיל פתיחה בפנים / טביעת אצבע. נסה בלי'; }
      };
    };
    return;
  }
  el.innerHTML = `<h4>🔒 הנעילה פעילה <small>${st.cred ? '😊 פנים / אצבע + קוד' : 'קוד בלבד'}</small></h4><p class="note" style="margin-bottom:6px">לנעול כשחוזרים לאפליקציה אחרי:</p>
    <div class="chips" style="padding:0 0 10px;flex-wrap:wrap">${[[0, 'מיד'], [1, 'דקה'], [5, '5 דקות'], [15, 'רבע שעה']].map(([m, l]) => `<button class="chip ${(st.minutes ?? 5) === m ? 'on' : ''}" data-min="${m}">${l}</button>`).join('')}</div>
    <div style="display:flex;gap:8px"><input id="lkOff" class="fam-in" type="password" inputmode="numeric" maxlength="4" placeholder="הקוד — כדי לכבות" style="text-align:center"><button class="act" id="lkOffBtn">כיבוי</button></div>
    <div id="lkErr" style="color:#FB7185;font-size:13px;min-height:18px"></div>`;
  el.querySelectorAll('[data-min]').forEach(b => b.onclick = () => { lock.setMinutes(+b.dataset.min); drawLockCard(); });
  $('#lkOffBtn').onclick = async () => { if (!(await lock.pinOk($('#lkOff').value))) return $('#lkErr').textContent = 'קוד שגוי'; lock.disable(); drawLockCard(); toast('הנעילה כובתה'); };
}
$h('#shareAppBtn').onclick = shareApp;
$h('#feedbackBtn').onclick = () => openFeedback();
$h('#helpBtn').onclick = () => openHelp();
$h('#meBtn').onclick = () => showView('settings');
$h('#setBtn').onclick = () => showView(curView() === 'settings' ? 'chat' : 'settings');
$h('#helpBtn2').onclick = () => openHelp();

// ---------- הפעלה ----------
async function load() {
  S.items = await db.all('items');
  S.log = await db.all('log');
  S.msgs = (await db.all('msgs')).sort((a, b) => a.ts.localeCompare(b.ts));
  if (S.msgs.length > 300) { for (const m of S.msgs.slice(0, S.msgs.length - 300)) await db.del('msgs', m.id); S.msgs = S.msgs.slice(-300); }
  S.top3 = await db.getKV('top3', null);
  S.settings = await db.getKV('settings', S.settings);
  S.travel = await db.getKV('travel', {}); S.alerted = await db.getKV('alerted', []);
  S.resources = C.DEFAULT_RES.concat(await db.getKV('resources', []));
  S.seen = await db.getKV('seen', {}); S.seenSince = await db.getKV('seenSince', null); S.chatSeen = await db.getKV('chatSeen', '');
  if (!S.seenSince) { S.seenSince = new Date().toISOString(); await db.setKV('seenSince', S.seenSince); S.chatSeen = S.seenSince; await db.setKV('chatSeen', S.chatSeen); }
  S.chatFrom = S.chatSeen;
  S.focus = await db.getKV('focus', null); S.templates = await db.getKV('templates', []); S.bell = await db.getKV('bell', []); S.cats = await db.getKV('cats', []); drawBellBadge();
  S.settings = { morning: '07:00', evening: '20:00', city: 'ירושלים', candleMin: 40, shabbatAlerts: [60], melody: 'bells', ...S.settings };
  $('#setMorning').value = S.settings.morning; $('#setEvening').value = S.settings.evening; drawShabbatSettings();
  // השאלה האחרונה שעוד לא נענתה — כדי ש"כן" / "עוד לא" יתייחסו אליה
  const lastQ = [...S.msgs].reverse().find(m => m.role === 'bot' && m.acts?.some(a => a.op === 'done'));
  S.pending = lastQ && !lastQ.used ? lastQ.acts.find(a => a.op === 'done').a[0] : null;
  renderAll(); renderChat();
  if (S.focus) { if (S.focus.end <= Date.now()) setTimeout(endFocus, 1500); else drawFocus(false); }
  $('#main').scrollTop = $('#main').scrollHeight;
}

async function tick() {
  if (S.day !== today()) { S.day = today(); renderAll(); }
  await Z.loadCalendar(S.settings.city, S.settings.candleMin);
  renderZman();
  await shabbatAlerts();
  if (Z.quietAt(Date.now())) { await followUps(true); return; } // 🕯️ מצב שבת/חג: בלי שאלות, סיכומים או התראות (חוץ מתרופות שסומנו "גם בשבת")
  const m = nowMin();
  if (m >= minutes(S.settings.morning) && m < minutes(S.settings.evening)) await morning();
  if (m >= minutes(S.settings.evening)) await evening();
  await followUps();
  await scanConflicts();
  syncSchedule();
}

// ---------- שבת וחגים ----------
async function shabbatAlerts() {
  const w = Z.nextWindow(); if (!w) return;
  const start = +new Date(w.start), now = Date.now();
  if (now >= start) return;
  for (const off of [...(S.settings.shabbatAlerts || [])].sort((a, b) => a - b)) {
    const key = `sh:${w.start}:${off}`;
    if (now >= start - off * 60e3 && !S.alerted.includes(key)) {
      // מסמנים גם את ההתראות המוקדמות יותר — שלא יקפצו כולן ביחד
      for (const o of S.settings.shabbatAlerts) if (o >= off) S.alerted.push(`sh:${w.start}:${o}`);
      await db.setKV('alerted', S.alerted);
      const left = Math.round((start - now) / 60e3);
      await bot('🕯️', 'linear-gradient(135deg,#F59E0B,#FACC15)', `עוד ${durLbl(left)} ${w.name === 'שבת' ? 'נכנסת שבת' : 'נכנס ' + w.name}`,
        `הדלקת נרות ב-${hm(new Date(start))} · ${w.name === 'שבת' ? 'צאת שבת' : 'צאת החג'} ${hm(new Date(w.end))}\nבזמן הזה לא יהיו תזכורות. ${w.name === 'שבת' ? 'שבת שלום! 🕊️' : 'חג שמח!'}`);
      Z.play(S.settings.melody); buzz(true);
      break;
    }
  }
}
let zLine = '';
async function renderZman() {
  const el = $('#hzman'); if (!el) return;
  const w = Z.nextWindow(), now = Date.now();
  if (w && +new Date(w.start) - now < 2.2 * 864e5) {
    const inIt = now >= +new Date(w.start);
    zLine = `🕯️ ${w.name}${inIt ? ' (עכשיו)' : ''}: כניסה ${hm(new Date(w.start))} · יציאה ${hm(new Date(w.end))}`;
  } else {
    const t = await Z.zmanim(S.settings.city);
    zLine = t ? `☀️ הנץ ${hm(new Date(t.sunrise))} · סוף ק"ש ${hm(new Date(t.sofZmanShma))} · שקיעה ${hm(new Date(t.sunset))}` : '';
  }
  el.textContent = zLine;
}

// ---------- משפחה: שינויים שהגיעו מטלפון אחר ----------
async function onRemoteItem(local, next, live) {
  const i = S.items.findIndex(x => x.id === next.id);
  if (i >= 0) S.items[i] = next; else S.items.push(next);
  if (!S.uid) return;
  if (next.kind === 'msg') {
    if (next.status !== 'open') return;
    const fresh = Date.now() - new Date(next.created) < 3 * 864e5;
    if (!local) return next.forP === S.myP && fresh && !(next.replies || []).some(r => r.p === S.myP) ? showIncoming(next) : undefined;
    const before = local?.replies?.length || 0;
    for (const r of (next.replies || []).slice(before)) if (r.p !== S.myP) await showReply(next, r);
    return;
  }
  if (!live) return;
  const newCm = (next.comments || []).filter(c => c.p !== S.myP && !(local?.comments || []).some(x => x.id === c.id));
  for (const c of newCm) await bell('💬', `${person(c.p) ? pName(c.p) : 'מישהו'} הגיב/ה על "${next.text.slice(0, 40)}"`, c.text, { item: next.id, comments: true }, 'cm:' + c.id);
  if (newCm.length) { buzz(); if ($('#cmList') && $('#sheetBg').classList.contains('on')) openComments(next.id); }
  const fromOther = next.doneBy && next.doneBy !== S.myP;
  const wasOpen = local && local.status === 'open' && !(local.repeat && isToday(local.lastDone));
  const nowDone = next.status === 'done' || (next.repeat && isToday(next.lastDone));
  const involvesMe = next.by === S.uid || next.forP === S.myP;
  if (wasOpen && nowDone && fromOther && involvesMe) {
    await bell('✅', `${person(next.doneBy)?.name || 'מישהו'} סיים/ה`, next.text, { item: next.id }, `done:${next.id}:${next.doneAt || next.lastDone}`);
    await bot(person(next.doneBy)?.e || '🎉', 'var(--g3)', `${person(next.doneBy)?.name || 'מישהו מהמשפחה'} סימן/ה ✅`, next.text);
    confetti(60);
  } else if (!local && next.status === 'open' && next.forP === S.myP && next.by !== S.uid) {
    const from = personOfUid(next.by);
    await bell('📥', `${from?.name || 'מישהו'} נתן/ה לך ${next.kind === 'meeting' ? 'פגישה' : 'משימה'}`, `${next.text}${next.due ? ' · ' + whenLabel(next) : ''}`, { item: next.id }, 'share:' + next.id);
    await bot(from?.e || '🙋', 'var(--g6)', `משימה חדשה בשבילך${from ? ' מ' + from.name : ''}`, `${next.text}${next.due ? '\n' + whenLabel(next) : ''}`,
      [{ l: '⭐ לחשובים של היום', op: 'star', a: [next.id] }, { l: '✏️ תקן', op: 'edit', a: [next.id] }]);
    buzz();
  } else if (local && next.status === 'open' && next.forP === S.myP && local.forP !== S.myP && next.by !== S.uid) {
    await bell('📎', 'שייכו לך משימה', `${next.text}${next.due ? ' · ' + whenLabel(next) : ''}`, { item: next.id }, `asg:${next.id}:${next.forP}`);
  } else if (next.status === 'open' && isTask(next) && next.group_id && next.by !== S.uid && next.forP !== S.myP && (!local || local.group_id !== next.group_id)) {
    await bell('📎', `${personOfUid(next.by)?.name || 'מישהו'} שיתף/ה ב"${groupOf(next.group_id)?.name || 'קבוצה'}"`, `${next.text}${next.due ? ' · ' + whenLabel(next) : ''}`, { item: next.id }, `grp:${next.id}:${next.group_id}`);
  }
}

// ---------- מסך פתיחה: כניסה ← שם ואייקון (← הצטרפות אם הגיעו מקישור הזמנה) ----------
const joinCode = (new URLSearchParams(location.search).get('join') || '').toUpperCase();
const joinName = new URLSearchParams(location.search).get('name') || '';
let joinHandled = false;
async function gateStep() {
  if (!sync.user()) return 'auth';
  if (!sync.myProfile()?.full_name) return 'profile';
  if (joinCode && !joinHandled && !sync.myGroups().some(g => g.code === joinCode || g.child_code === joinCode)) return 'join';
  return null;
}
async function showGate() {
  S.uid = sync.user()?.id || null;
  buildPeople();
  const step = await gateStep();
  const g = $('#gate'), body = $('#gateBody');
  if (!step) { g.classList.remove('on'); renderAll(); renderFamily(); renderMe(); return true; }
  g.classList.add('on');
  const err = m => { body.querySelector('.err').textContent = m; };
  const busy = (b, on) => { b.disabled = on; b.style.opacity = on ? .6 : 1; };

  if (step === 'auth') {
    body.innerHTML = `<div class="g-logo">⏰</div><h2>ברוכים הבאים ל"זמן בכיף"</h2>
      <p class="note">${joinCode ? '👋 הוזמנת לקבוצה! קודם נכנסים או נרשמים. ' : ''}יש לך <b>כסף בכיף</b>? אותו מייל ואותה סיסמה. חדש? נרשמים כאן.</p>
      <input id="gEmail" type="email" autocomplete="email" placeholder="מייל" dir="ltr">
      <input id="gPass" type="password" autocomplete="current-password" placeholder="סיסמה (לפחות 6 תווים)" dir="ltr">
      <div class="err"></div>
      <button class="btn pri" id="gIn">כניסה</button>
      <button class="btn" id="gUp">אין לי חשבון — הרשמה</button>
      <button class="link" id="gForgot">🔑 שכחתי סיסמה</button>`;
    $('#gForgot').onclick = async e => {
      const em = $('#gEmail').value.trim();
      if (!/^\S+@\S+\.\S+$/.test(em)) { err('קודם כותבים למעלה את המייל, ואז "שכחתי סיסמה"'); $('#gEmail').focus(); return; }
      busy(e.target, true);
      try { await sync.resetPassword(em); err(''); body.querySelector('.err').insertAdjacentHTML('afterend', `<p class="note" style="color:#86EFAC">📧 שלחנו מייל ל-${esc(em)} עם קישור. לוחצים עליו, חוזרים לכאן ובוחרים סיסמה חדשה. (לא הגיע? בודקים בספאם)</p>`); e.target.hidden = true; }
      catch (x) { err(x.message); busy(e.target, false); }
    };
    const go = async (fn, b) => {
      const e = $('#gEmail').value.trim(), p = $('#gPass').value;
      if (!/^\S+@\S+\.\S+$/.test(e)) return err('צריך מייל תקין');
      if (p.length < 6) return err('הסיסמה צריכה להיות לפחות 6 תווים');
      busy(b, true);
      try { await fn(e, p); fresh = true; await sync.connected(true); await afterGate(); }
      catch (x) { err(x.message); busy(b, false); }
    };
    $('#gIn').onclick = e => go(sync.signIn, e.target);
    $('#gUp').onclick = e => go(sync.signUp, e.target);
    body.querySelectorAll('input').forEach(i => i.oninput = () => err(''));
    return false;
  }
  if (step === 'profile') {
    // הצעה מהשם שב"כסף בכיף"
    const old = (await sync.loadPeople()).find(x => x.uid === S.uid);
    let face = Math.max(0, FACES.indexOf(old?.e || '🧔'));
    body.innerHTML = `<h2>🙋 איך קוראים לך?</h2>
      <p class="note">השם המלא שלך — ככה יזהו אותך. בכל קבוצה אפשר גם כינוי משלה ("אבא", "מוישי").</p>
      <div style="display:flex;gap:8px"><button class="round" id="gFace" style="background:var(--card2);border:1px solid var(--line);width:50px;height:50px;font-size:24px">${FACES[face]}</button>
      <input id="gMe" placeholder="שם מלא, למשל: משה כהן" value="${esc(joinName || old?.name || '')}" style="flex:1"></div>
      <div class="err"></div>
      <button class="btn pri" id="gSave">המשך</button>
      <button class="link" id="gOut">יציאה מהחשבון</button>`;
    $('#gFace').onclick = e => { face = (face + 1) % FACES.length; e.target.textContent = FACES[face]; };
    $('#gSave').onclick = async e => {
      const name = $('#gMe').value.trim(); if (!name) return err('צריך לכתוב שם');
      busy(e.target, true);
      try { await sync.saveProfile(name, FACES[face]); await sync.loadGroups(); toast(`🎉 ברוך הבא, ${name}!`); await afterGate(); } catch (x) { err(x.message); busy(e.target, false); }
    };
    $('#gOut').onclick = signOut;
    return false;
  }
  // step === 'join': הגיעו מקישור הזמנה
  const pr = sync.myProfile();
  body.innerHTML = `<h2>👋 הוזמנת לקבוצה</h2>
    <p class="note">קוד: <b dir="ltr" style="letter-spacing:2px">${esc(joinCode)}</b><br>איך יקראו לך בקבוצה הזאת?</p>
    <input id="gNick" placeholder="כינוי, למשל: אבא / מוישי" value="${esc(pr?.full_name?.split(' ')[0] || '')}">
    <div class="err"></div>
    <button class="btn pri" id="gJoin">🔑 הצטרפות</button>
    <button class="link" id="gSkip">לא עכשיו</button>`;
  $('#gJoin').onclick = async e => {
    busy(e.target, true);
    try { const jg = await sync.joinGroup(joinCode, $('#gNick').value.trim() || pr?.full_name, pr?.emoji); announceJoin(jg); joinHandled = true; confetti(); toast('🎉 הצטרפת לקבוצה!'); history.replaceState(null, '', location.pathname); await afterGate(); }
    catch (x) { err(x.message); busy(e.target, false); }
  };
  $('#gSkip').onclick = () => { joinHandled = true; afterGate(); };
  return false;
}
let fresh = false;
async function afterGate() {
  if (!(await showGate())) return;
  if (fresh) { fresh = false; S.items = await db.all('items'); }
  await migrateToGroups();
  buildPeople(); renderAll(); renderFamily(); renderMe();
  if (!started) boot();
}
async function signOut(e) {
  const btn = e?.currentTarget;
  if (!tapAgain(btn, '👋 בטוח? לחץ שוב לצאת')) return;
  try { await sync.signOut(!btn || btn.dataset.force === '1'); }
  catch (x) {
    if (x.message !== 'pending') return toast(x.message, true);
    const n = await sync.pendingCount();
    toast(`⚠️ ${n} שינויים עוד לא עלו לענן (אין אינטרנט?). כדאי להתחבר לאינטרנט ולנסות שוב`, true);
    btn.dataset.force = '1'; btn._orig = btn.textContent; btn.dataset.armed = '1'; btn.textContent = '⚠️ לצאת בכל זאת (השינויים יימחקו)';
    return;
  }
  S.uid = null; S.myP = null; S.people = [];
  await load(); showGate();
}

// מעבר חד-פעמי: מה שנרשם עם המשפחה של "כסף בכיף" עובר לקבוצה "המשפחה"
async function migrateToGroups() {
  if (!S.uid || await db.getKV('migratedGroups', false)) return;
  const hh = sync.household(), mine = S.items.filter(it => it.status !== 'deleted' && (!it.by || it.by === S.uid));
  try {
    let gid = null;
    if (hh && (mine.length || sync.myGroups().some(g => g.source_household === hh.id))) gid = await sync.importHousehold(hh.id);
    buildPeople();
    const oldPeople = await db.getKV('people', []) || [];
    for (const it of S.items) {
      // forP ישן (מרשימת כסף בכיף) → זיהוי לפי חשבון
      const map = v => { if (!v || v === 'any' || /^[um]:/.test(v)) return v; const op = oldPeople.find(x => x.id === v); return op?.uid ? 'u:' + op.uid : null; };
      it.forP = map(it.forP); if (it.from) it.from = map(it.from); if (it.doneBy) it.doneBy = map(it.doneBy);
      if (it.replies) it.replies = it.replies.map(r => ({ ...r, p: map(r.p) }));
      if (!it.group_id && gid && !it.private && it.status !== 'deleted' && (!it.by || it.by === S.uid)) it.group_id = gid; // רק מה שלי עובר לקבוצה
      if (!it.by) it.by = S.uid;
      await db.put('items', it);
      if (it.by === S.uid) await sync.queue(it);
    }
    await db.setKV('migratedGroups', true);
    if (gid) await bot('👨‍👩‍👧', 'var(--g6)', 'עברנו לקבוצות!', `מה שרשמתם עם המשפחה נמצא עכשיו בקבוצה "${groupOf(gid)?.name || 'המשפחה'}".\nאפשר לפתוח עוד קבוצות — שותפים, צוות, חברים — באזור האישי ⚙️`);
  } catch (e) { console.warn('migrate', e); }
}

// ---------- הקבוצות שלי (בהגדרות) ----------
const joinLink = code => `${location.origin}${location.pathname.replace(/[^/]*$/, '')}guide/?join=${code}`;
// קוד QR (ספרייה קטנה שנטענת רק כשצריך)
let qrLib = null;
const loadQR = () => qrLib ??= new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'vendor/qrcode.js'; sc.onload = () => res(window.qrcode); sc.onerror = () => { qrLib = null; rej(new Error('qr')); }; document.head.appendChild(sc); });
async function qrSvg(text) { const qr = (await loadQR())(0, 'M'); qr.addData(text); qr.make(); return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
async function fillQR(root) {
  for (const el of root.querySelectorAll('[data-qr]')) { try { el.innerHTML = await qrSvg(joinLink(el.dataset.qr)); } catch { el.remove(); } }
}
async function zoomQR(code, label) {
  sheet(`<h3 style="text-align:center">${esc(label)}</h3><div class="qr qr-big" id="qrBig"></div><div class="code" style="text-align:center;font-size:30px;font-weight:800;letter-spacing:3px;direction:ltr">${esc(code)}</div>
    <p class="note" style="text-align:center">מכוונים את המצלמה של הטלפון השני לריבוע ולוחצים על הקישור שמופיע.</p><button class="btn" id="qrClose">סגירה</button>`);
  $('#qrClose').onclick = closeSheet;
  try { $('#qrBig').innerHTML = await qrSvg(joinLink(code)); } catch { $('#qrBig').textContent = 'צריך אינטרנט כדי ליצור את הריבוע'; }
}
const inviteText = (g, code) => {
  const link = joinLink(code);
  return g.kind === 'pair'
    ? `היי! הוספתי אותך ב"זמן בכיף" ⏰ — ככה נוכל לתת אחד לשני משימות ולשלוח הודעות, רק שנינו.\n${link}\n\nקוד (למקרה שצריך): ${code}`
    : `הצטרפו ל"${g.name}" ב"זמן בכיף" ⏰\nהכל בקישור אחד — התקנה, הצטרפות והסבר:\n${link}\n\nקוד: ${code}`;
};
const waHref = t => `https://wa.me/?text=${encodeURIComponent(t)}`;
function renderFamily() {
  const el = $('#familyCard'); if (!el) return;
  if (!S.uid) { el.hidden = true; return; }
  el.hidden = false;
  const gs = sync.myGroups(), hh = sync.household();
  const canImport = hh && !gs.some(g => g.source_household === hh.id);
  const card = g => {
    const me = g.members.find(m => m.user_id === S.uid), admin = me?.role === 'admin';
    const mem = g.members.map(m => `<div class="fam-row"><button class="color-dot sm" data-pc="${m.user_id ? 'u:' + m.user_id : 'm:' + m.id}" style="background:${colorOf(m.user_id ? 'u:' + m.user_id : 'm:' + m.id)}" aria-label="צבע"></button><span style="flex:1;min-width:110px">${m.user_id ? '📱' : '✏️'} <span class="face-sm">${faceHtml(person(m.user_id ? 'u:' + m.user_id : 'm:' + m.id) || { e: m.profile?.emoji || m.emoji })}</span> <b>${esc(m.nickname)}</b>${m.user_id === S.uid ? ' (אני)' : ''}${m.user_id && m.profile?.full_name && m.profile.full_name !== m.nickname ? ` <span class="note">· ${esc(m.profile.full_name)}</span>` : ''}</span>
      ${g.kind !== 'pair' && admin && m.user_id !== S.uid ? `<button class="chip" data-role="${m.id}" data-to="${m.role === 'admin' ? 'member' : g.kind === 'family' && m.role === 'member' ? 'child' : 'admin'}">${{ admin: '⭐ מנהל', member: '🙂 חבר', child: '🧒 ילד' }[m.role]}</button><button class="chip" data-rm="${m.id}">✕</button>` : `<span class="note">${g.kind === 'pair' ? '' : { admin: '⭐ מנהל', member: '🙂 חבר', child: '🧒 ילד' }[m.role]}</span>`}</div>`).join('');
    return `<div class="grp" data-g="${g.id}">
      <div class="grp-h"><b>${esc(gLabel(g))}</b><span class="note">הכינוי שלי: <b>${esc(me?.nickname || '')}</b></span></div>
      ${mem}
      ${g.kind === 'pair' && g.members.length < 2 ? '<p class="note">⏳ ממתין שיצטרף בקישור ששלחת</p>' : ''}
      ${me && me.role !== 'child' ? (() => { const v = me.cal_share || (['family', 'pair'].includes(g.kind) ? 'all' : 'busy');
        return `<div class="note" style="margin-top:8px">📅 מי ${g.kind === 'pair' ? 'שם' : 'בקבוצה'} רואה את היומן שלי:</div><div class="chips" style="padding:6px 0 0;flex-wrap:wrap">${[['all', '👀 הכל'], ['busy', '⛔ רק "תפוס/ה"'], ['none', '🚫 לא']].map(([k, l]) => `<button class="chip ${v === k ? 'on' : ''}" data-cal="${g.id}" data-cv="${k}" aria-pressed="${v === k}">${l}</button>`).join('')}</div>${v === 'all' ? '<div class="note" style="font-size:11px">מה שסימנת 🔒 פרטי תמיד מופיע אצלם רק כ"תפוס/ה".</div>' : ''}`; })() : ''}
      ${(admin || g.kind === 'pair') && g.code ? `<div class="codes">${g.kind !== 'pair' || g.members.length < 2 ? `<div class="code-box" style="background:rgba(124,58,237,.25);border-color:rgba(196,181,253,.4)"><div class="note">${g.kind === 'family' ? '👨‍👩 קוד להורה' : '🔑 קוד הצטרפות'}</div><div class="qr" data-qr="${g.code}" role="img" aria-label="קוד QR להצטרפות"></div><div class="code">${g.code}</div><button class="chip" data-zoom="${g.code}" data-zl="${g.kind === 'family' ? '👨‍👩 קוד להורה' : '🔑 קוד הצטרפות'}">🔍 להגדיל</button> <button class="chip" data-copy="${g.code}">📋 העתקה</button> <a class="chip" href="${waHref(inviteText(g, g.code))}" target="_blank" rel="noopener" style="text-decoration:none">💬 וואטסאפ</a></div>` : ''}
        ${g.kind === 'family' && g.child_code ? `<div class="code-box" style="background:rgba(249,115,22,.25);border-color:rgba(253,186,116,.4)"><div class="note">🧒 קוד לילד</div><div class="qr" data-qr="${g.child_code}" role="img" aria-label="קוד QR לילד"></div><div class="code">${g.child_code}</div><button class="chip" data-zoom="${g.child_code}" data-zl="🧒 קוד לילד">🔍 להגדיל</button> <button class="chip" data-copy="${g.child_code}">📋 העתקה</button> <a class="chip" href="${waHref(inviteText(g, g.child_code))}" target="_blank" rel="noopener" style="text-decoration:none">💬 וואטסאפ</a></div>` : ''}</div>` : ''}
      <div class="chips" style="padding:8px 0 0;flex-wrap:wrap">
        <button class="chip" data-nick="${g.id}">✏️ הכינוי שלי</button>
        ${admin && g.kind !== 'pair' ? `<button class="chip" data-addname="${g.id}">➕ רק שם (בלי טלפון)</button><button class="chip" data-rename="${g.id}">✏️ שם הקבוצה</button>` : ''}
        ${admin && g.kind !== 'pair' && g.code ? `<button class="chip" data-rotate="${g.id}">🔄 להחליף קודים</button>` : ''}
        <button class="chip" data-leave="${me?.id || ''}">🚪 יציאה</button>
        ${g.kind !== 'pair' ? `<button class="chip ${S.settings.defGroup === g.id ? 'on' : ''}" data-def="${g.id}">⭐ ראשית</button>` : ''}
      </div></div>`;
  };
  el.innerHTML = `<h4>👥 הקבוצות שלי<small id="syncState">${demo.DEMO ? '🎭 הדגמה, בלי ענן' : navigator.onLine ? 'מסונכרן ✓' : 'ממתין לרשת…'}</small></h4>
    ${gs.length ? gs.map(card).join('') : '<p class="note">עוד אין קבוצות. משימות שתרשום יהיו רק שלך — עד שתפתח קבוצה או תצטרף לאחת.</p>'}
    <div class="two" style="margin-top:10px"><button class="btn pri" id="gNewBtn" style="margin:0">➕ קבוצה חדשה</button><button class="btn" id="gJoinBtn" style="margin:0">🔑 הצטרפות עם קוד</button></div>
    <button class="btn" id="gPairBtn">👤 קשר ישיר עם אדם אחד</button>
    ${canImport ? `<button class="btn" id="gImportBtn">📥 ליצור קבוצה מהמשפחה של "כסף בכיף"</button>` : ''}
    <div id="grpErr" style="color:#FB7185;font-size:13px;min-height:16px"></div>`;
  const err = m => { $('#grpErr').textContent = m; };
  const run = async fn => { try { await fn(); buildPeople(); renderAll(); renderFamily(); renderProfile(); } catch (x) { err(x.message); } };
  $('#gNewBtn').onclick = () => openNewGroup();
  $('#gJoinBtn').onclick = () => openJoin();
  $('#gPairBtn').onclick = () => openNewPair();
  $('#gImportBtn')?.addEventListener('click', () => run(async () => { await sync.importHousehold(hh.id); confetti(); toast('👨‍👩‍👧 הקבוצה נוצרה מהמשפחה!'); }));
  fillQR(el); hydrateFaces(el);
  el.querySelectorAll('[data-zoom]').forEach(b => b.onclick = () => zoomQR(b.dataset.zoom, b.dataset.zl));
  el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = '✅ הועתק'; } catch { b.textContent = b.dataset.copy; } });
  el.querySelectorAll('[data-role]').forEach(b => b.onclick = () => run(() => sync.setRole(b.dataset.role, b.dataset.to)));
  el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'להסיר?'; return; } run(async () => { await sync.removeMember(b.dataset.rm); toast('✅ הוסר. הוא כבר לא רואה את הקבוצה'); }); });
  el.querySelectorAll('[data-rotate]').forEach(b => b.onclick = () => {
    const g = groupOf(b.dataset.rotate);
    sheet(`<h3>🔄 להחליף את קודי ההצטרפות</h3><p class="note" style="margin-bottom:12px">ל"${esc(g.name)}" יהיה קוד חדש${g.child_code ? ' (וגם קוד ילד חדש)' : ''}. <b>הקוד הישן, הקישור הישן וה-QR הישן יפסיקו לעבוד מיד.</b><br>מי שכבר בקבוצה נשאר בה. מישהו שלא אמור להיות שם? מוציאים אותו עם ✕ ליד השם.</p>
      <button class="btn danger" id="rtGo">🔄 כן, להחליף קודים</button><button class="btn" id="rtNo">ביטול</button>`);
    $('#rtNo').onclick = closeSheet;
    $('#rtGo').onclick = () => { closeSheet(); run(async () => { await sync.rotateCodes(g.id); toast('🔄 הקודים הוחלפו. הישנים כבר לא עובדים'); }); };
  });
  el.querySelectorAll('[data-leave]').forEach(b => b.onclick = () => { if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'בטוח? לצאת'; return; } run(() => sync.removeMember(b.dataset.leave)); });
  el.querySelectorAll('[data-def]').forEach(b => b.onclick = async () => { S.settings.defGroup = b.dataset.def; await db.setKV('settings', S.settings); renderFamily(); toast('⭐ זו הקבוצה הראשית'); });
  el.querySelectorAll('[data-nick]').forEach(b => b.onclick = () => openNick(b.dataset.nick));
  el.querySelectorAll('[data-pc]').forEach(b => b.onclick = () => openColorPick(b.dataset.pc));
  el.querySelectorAll('[data-cal]').forEach(b => b.onclick = () => run(async () => { await sync.setCalShare(b.dataset.cal, b.dataset.cv); toast({ all: '👀 עכשיו רואים את היומן שלך', busy: '⛔ רואים רק מתי את/ה תפוס/ה', none: '🚫 היומן שלך מוסתר מהקבוצה' }[b.dataset.cv]); }));
  el.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => {
    const g = groupOf(b.dataset.rename);
    sheet(`<h3>✏️ שם הקבוצה</h3><input id="rnName" class="fam-in" value="${esc(g.name)}"><button class="btn pri" id="rnSave" style="margin-top:12px">💾 שמור</button>`);
    $('#rnSave').onclick = () => { closeSheet(); run(() => sync.renameGroup(g.id, $('#rnName').value.trim() || g.name)); };
  });
  el.querySelectorAll('[data-addname]').forEach(b => b.onclick = () => {
    let face = 2;
    sheet(`<h3>➕ רק שם (בלי טלפון)</h3><p class="note" style="margin-bottom:10px">למשל ילד קטן. אפשר לתת לו משימות — והשאלה "עשית?" תחזור אליך.</p>
      <div style="display:flex;gap:8px"><button class="round" id="anFace" style="background:var(--card2);border:1px solid var(--line);width:46px;height:46px">${FACES[face]}</button><input id="anName" class="fam-in" placeholder="השם, למשל: יעל"></div>
      <button class="btn pri" id="anSave" style="margin-top:12px">הוספה</button>`);
    $('#anFace').onclick = e => { face = (face + 1) % FACES.length; e.target.textContent = FACES[face]; };
    $('#anSave').onclick = () => { const n = $('#anName').value.trim(); if (!n) return; closeSheet(); run(() => sync.addName(b.dataset.addname, n, FACES[face])); };
  });
}
function openNewGroup() {
  if (!S.uid) return showGate();
  const pr = sync.myProfile();
  let kind = 'partners';
  sheet(`<h3>➕ קבוצה חדשה</h3>
    <label>סוג</label><div class="seg" id="ngKind">${['family', 'partners', 'team', 'friends', 'other'].map(k => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${KINDS[k][0]} ${KINDS[k][1]}</button>`).join('')}</div>
    <label>שם הקבוצה</label><input id="ngName" placeholder="למשל: אני ויוסי — העסק">
    <label>הכינוי שלך בקבוצה</label><input id="ngNick" value="${esc(pr?.full_name?.split(' ')[0] || '')}" placeholder="למשל: מוישי">
    <button class="btn pri" id="ngSave" style="margin-top:14px">✨ יצירה</button>`);
  $('#ngKind').onclick = e => { const b = e.target.closest('button'); if (!b) return; kind = b.dataset.k; [...$('#ngKind').children].forEach(x => x.classList.toggle('on', x === b)); };
  $('#ngSave').onclick = async () => {
    const name = $('#ngName').value.trim(); if (!name) return toast('צריך שם לקבוצה', true);
    try {
      const gid = await sync.createGroup(name, kind, $('#ngNick').value.trim() || pr?.full_name, pr?.emoji);
      closeSheet(); buildPeople(); renderAll(); renderFamily(); confetti();
      const g = groupOf(gid);
      if (S.restart) { S.restart = false; setTimeout(() => { welcomeMe(); openEditMe(); }, 1200); }
      await bot(KINDS[kind][0], 'var(--g6)', `הקבוצה "${name}" נוצרה!`, `קוד הצטרפות: ${g?.code || ''}${g?.child_code ? `\nקוד לילד: ${g.child_code}` : ''}\nשלח/י את הקישור למי שצריך להצטרף 👇`,
        [{ l: '💬 שליחה בוואטסאפ', op: 'shareGroup', a: [gid], pri: true }]);
      showView('chat');
    } catch (x) { toast(x.message, true); }
  };
}
function openJoin() {
  if (!S.uid) return showGate();
  const pr = sync.myProfile();
  sheet(`<h3>🔑 הצטרפות לקבוצה</h3><label>הקוד שקיבלת (8 תווים)</label><input id="jCode" dir="ltr" style="text-transform:uppercase;letter-spacing:3px;text-align:center">
    <label>איך יקראו לך בקבוצה?</label><input id="jNick" value="${esc(pr?.full_name?.split(' ')[0] || '')}">
    <button class="btn pri" id="jGo" style="margin-top:14px">🔑 הצטרפות</button>`);
  $('#jGo').onclick = async () => {
    const c = $('#jCode').value.trim(); if (c.length < 6) return toast('הקוד הוא 8 תווים', true);
    try { const gid = await sync.joinGroup(c, $('#jNick').value.trim() || pr?.full_name, pr?.emoji); announceJoin(gid); if (S.restart) { S.restart = false; setTimeout(() => { welcomeMe(); openEditMe(); }, 1200); } closeSheet(); buildPeople(); renderAll(); renderFamily(); confetti(); toast(`🎉 הצטרפת ל"${groupOf(gid)?.name || 'קבוצה'}"`); }
    catch (x) { toast(x.message, true); }
  };
}
// קשר ישיר עם אדם אחד (בלי קבוצה): יוצרים "זוג" ושולחים לו קישור
async function openNewPair(itemId) {
  if (!S.uid) return showGate();
  const pr = sync.myProfile();
  sheet(`<h3>👤 קשר ישיר עם אדם אחד</h3><p class="note" style="margin-bottom:10px">רק שניכם — בלי קבוצה. שולחים לו קישור, וכשהוא נכנס אפשר לתת לו משימות ולשלוח הודעות.</p>
    <label>איך קוראים לו? (בשבילך)</label><input id="npName" placeholder="למשל: דני הקבלן">
    <button class="btn pri" id="npGo" style="margin-top:14px">💬 יצירה ושליחה בוואטסאפ</button>`);
  $('#npGo').onclick = async () => {
    const other = $('#npName').value.trim() || 'קשר ישיר';
    try {
      const gid = await sync.createGroup(`${pr?.full_name || 'אני'} ↔ ${other}`, 'pair', pr?.full_name, pr?.emoji);
      closeSheet(); buildPeople(); renderFamily();
      const g = groupOf(gid);
      if (itemId && item(itemId)) await setAssign(item(itemId), gid, null);
      window.open(waHref(inviteText(g, g.code)), '_blank');
      toast(`👤 נשלח! כש${other} יצטרף — תוכל לשייך לו משימות`);
    } catch (x) { toast(x.message, true); }
  };
}
function openNick(gid) {
  const g = groupOf(gid), me = g?.members.find(m => m.user_id === S.uid); if (!me) return;
  sheet(`<h3>✏️ הכינוי שלי ב"${esc(g.name)}"</h3><input id="nkName" class="fam-in" value="${esc(me.nickname)}"><button class="btn pri" id="nkSave" style="margin-top:12px">💾 שמור</button>`);
  $('#nkSave').onclick = async () => { try { await sync.setNickname(gid, $('#nkName').value.trim(), null); closeSheet(); buildPeople(); renderAll(); renderFamily(); toast('✅ נשמר'); } catch (x) { toast(x.message, true); } };
}

let started = false;
// כרטיס "האזור האישי" — תמיד בראש ההגדרות
function renderProfile() {
  const el = $('#meCard'); if (!el) return;
  const p = person(S.myP), u = sync.user(), gs = sync.myGroups();
  if (!u) {
    el.innerHTML = `<h4>👤 האזור האישי</h4><p class="note">לא מחובר. נכנסים (או נרשמים) — ואז אפשר ליצור קבוצות, לתת משימות ולשלוח הודעות.</p>
      <button class="btn pri" id="pLogin">🔑 כניסה / הרשמה</button>`;
    $('#pLogin').onclick = () => showGate();
    return;
  }
  const weekAgo = Date.now() - 7 * 864e5;
  const doneWeek = S.log.filter(l => l.action === 'done' && new Date(l.ts) > weekAgo).length;
  const stat = (n, l, pre = '') => `<div class="me-stat"><b data-count="${n}" data-pre="${pre}">${pre}${n}</b><span>${l}</span></div>`;
  el.innerHTML = `<h4 style="margin-bottom:10px">👤 האזור האישי</h4><div class="me-top"><button class="me-face" id="pFace" aria-label="שינוי תמונה או אייקון">${p ? faceHtml(p) : '🙋'}<em class="me-cam">📷</em></button>
      <div class="me-txt"><b>${esc(p?.name || '')}</b><span dir="ltr">${esc(u.email || '')}</span>
      <span>${gs.length ? gs.map(g => `${gLabel(g)} · "${esc(g.members.find(m => m.user_id === S.uid)?.nickname || '')}"`).join('<br>') : 'עוד לא בשום קבוצה'}</span></div></div>
    <div class="me-stats">${stat(streak(), 'ימים ברצף', '🔥 ')}${stat(doneWeek, 'בוצעו השבוע')}${stat(tasksOpen().length, 'פתוחות שלי')}${stat(openItems().filter(x => x.kind === 'thought' && byMe(x)).length, 'מחשבות')}</div>
    <div class="two" style="margin-top:10px"><button class="btn" id="pEdit" style="margin:0">✏️ שם ואייקון</button><button class="btn danger" id="pOut" style="margin:0">יציאה</button></div>`;
  el.querySelectorAll('[data-count]').forEach(b => countUp(b, b.dataset.count, b.dataset.pre));
  $('#pEdit').onclick = openEditMe; $('#pFace').onclick = openEditMe; hydrateFaces(el);
  $('#pOut').onclick = signOut;
}
function renderMe() {
  renderProfile();
  const el = $('#meBtn'); if (!el) return;
  const p = person(S.myP);
  el.hidden = !p; if (p) { el.textContent = p.e; el.title = p.name; $('#hello').textContent = `שלום ${p.name.split(' ')[0]} 👋 · `; } else $('#hello').textContent = '';
}
async function welcomeMe() {
  renderMe();
  const p = person(S.myP);
  if (!p) return;
  const key = 'welcomed2:' + S.uid;
  if (await db.getKV(key, false)) return;
  await db.setKV(key, true);
  const gs = sync.myGroups();
  await bot(p.e, 'var(--g1)', `שלום ${p.name}! 👋`, `נכנסת עם ${sync.user()?.email || 'החשבון שלך'}.\n${gs.length ? `👥 הקבוצות שלך: ${gs.map(g => gLabel(g)).join(', ')}` : 'עוד אין לך קבוצות — כל מה שתרשום יהיה רק שלך.'}\nאפשר לפתוח קבוצה (משפחה, שותפים, צוות) או קשר ישיר עם אדם אחד — באזור האישי ⚙️`,
    [{ l: '➕ קבוצה חדשה', op: 'newGroup', pri: true }, { l: '✏️ שם ואייקון', op: 'editMe' }, { l: 'זה לא אני', op: 'switchUser' }]);
}
function openEditMe() {
  const p = person(S.myP); if (!p) return;
  let face = Math.max(0, FACES.indexOf(p.e));
  sheet(`<h3>🙋 התמונה והשם שלי</h3>
    <div class="ph-box"><div class="ph-big">${faceHtml(p)}</div>
      <div class="ph-acts"><label class="btn pri ph-btn">📸 לצלם<input type="file" accept="image/*" capture="user" id="phCam" hidden></label>
      <label class="btn ph-btn">🖼️ מהגלריה / קובץ<input type="file" accept="image/*" id="phGal" hidden></label>
      ${p.photo ? '<button class="btn danger ph-btn" id="phDel">🗑️ להסיר תמונה</button>' : ''}</div></div>
    <p class="note" style="margin:6px 0 10px">רק מי שבקבוצה איתך רואה את התמונה. בלי תמונה — מופיע האייקון.</p>
    <label>אייקון ושם מלא (בכל הקבוצות)</label>
    <div style="display:flex;gap:8px"><button class="round" id="meFace" style="background:var(--card2);border:1px solid var(--line);width:48px;height:48px">${FACES[face]}</button>
    <input id="meName" class="fam-in" value="${esc(p.name)}"></div><button class="btn pri" id="meSave" style="margin-top:14px">💾 שמור</button>`);
  hydrateFaces($('#sheet'));
  const upload = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    if (demo.DEMO) return toast('🎭 בהדגמה לא מעלים תמונות', true);
    if (!S.uid) return toast('צריך להיכנס לחשבון', true);
    try { toast('⏳ מעלה…'); const blob = await shrinkPhoto(f); await sync.uploadPhoto(blob); await sync.loadGroups(); buildPeople(); renderProfile(); renderFamily(); confetti(40); toast('🖼️ התמונה נשמרה'); openEditMe(); }
    catch (x) { toast('לא הצלחתי להעלות: ' + x.message, true); }
  };
  $('#phCam').onchange = upload; $('#phGal').onchange = upload;
  $('#phDel')?.addEventListener('click', async e => { if (!tapAgain(e.currentTarget, '🗑️ בטוח? לחץ שוב')) return; try { await sync.removePhoto(); await sync.loadGroups(); buildPeople(); renderProfile(); renderFamily(); toast('🗑️ התמונה הוסרה'); openEditMe(); } catch (x) { toast(x.message, true); } });
  $('#meFace').onclick = e => { face = (face + 1) % FACES.length; e.target.textContent = FACES[face]; };
  $('#meSave').onclick = async () => {
    const name = $('#meName').value.trim(); if (!name) return toast('צריך שם', true);
    try { await sync.saveProfile(name, FACES[face]); await sync.loadGroups(); } catch (x) { return toast(x.message, true); }
    closeSheet(); buildPeople(); renderAll(); renderFamily(); renderMe(); toast('✅ נשמר');
  };
}

// ---------- ✨ מה חדש ----------
// קופץ פעם אחת אחרי עדכון. 'zman-news' = הגרסה האחרונה שראו בטלפון הזה. משתמש חדש לא מקבל (יש לו את המדריך)
const NEWS_KEY = 'zman-news';
// מפתח מהדורה: תאריך, ו-rev כשרוצים לפתוח שוב באותו יום
const nKey = n => n ? n.v + (n.rev ? '.' + n.rev : '') : '';
const lsGetN = () => { try { return localStorage.getItem(NEWS_KEY); } catch { return null; } };
const lsSetN = v => { try { localStorage.setItem(NEWS_KEY, v); } catch { /* */ } };
const newsFor = items => items.filter(i => !iAmKid() || i.kids);
const NEWS_GO = {
  news: () => openNews(true),
  plus: () => openPlus(),
  tasks: () => showView('tasks'),
  shop: () => showView('shop'),
  cal: () => { showView('cal'); spot('.cal-who, #calWho'); },
  settings: () => showView('settings'),
  photo: () => openEditMe(),
  recur: () => OPS.recurList(),
  habits: () => { showView('tasks'); spot('.habits'); },
  view: () => { showView('settings'); spot('#viewCard'); },
  calendar: () => { showView('settings'); spot('#calSubCard'); },
};
// מאיר רכיב במסך לכמה שניות
function spot(sel) {
  setTimeout(() => { const el = $(sel); if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.remove('spot'); void el.offsetWidth; el.classList.add('spot'); setTimeout(() => el.classList.remove('spot'), 2600); }, 350);
}
function maybeNews(tries = 0) {
  if (!NEWS.length || demo.DEMO) return;
  const last = nKey(NEWS[0]), seen = lsGetN();
  if (seen === last) return;
  // אין סימון: משתמש ותיק (יש נתונים) רואה רק את העדכון האחרון. משתמש חדש לא מקבל כלום
  if (!seen && !S.items.length) return lsSetN(last);
  const fresh = NEWS.filter(n => !seen ? nKey(n) === last : nKey(n) > seen);
  const items = newsFor(fresh.flatMap(n => n.items));
  if (!items.length) return lsSetN(last);
  // קודם כניסה, נעילה, חלון פתוח או סיור, ורק אחר כך
  const busy = $('#gate').classList.contains('on') || $('#lock').classList.contains('on') || sheetOpen() || ($('#tour') && !$('#tour').hidden);
  if (busy) { if (tries < 20) setTimeout(() => maybeNews(tries + 1), 1500); return; }
  openNews(false, items);
}
// newsBack = איפה עצרנו ברשימה, כדי לחזור אליה אחרי "👀 תראו לי"
let newsBack = null;
// ✨ מה חדש: מסך מלא נוצץ בסגנון סטוריז. כרטיס לכל חידוש, פסי התקדמות למעלה, מעבר אוטומטי, ובסוף "🎉 זהו!"
const NX_MS = 6500;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('no-anim');
function openNews(all = false, items = null, restore = false) {
  lsSetN(nKey(NEWS[0]));
  $('.news-fab')?.remove(); clearTimeout(nxTimer);
  const seen = newsBack?.seen || [];
  const dLabel = v => new Date(v + 'T12:00:00').toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
  // כל חידוש = כרטיס. בהיסטוריה: מכל הימים (החדש קודם), עם התאריך על הכרטיס
  const list = all ? NEWS.flatMap(n => newsFor(n.items).map(it => ({ ...it, v: n.v }))) : (items || newsFor(NEWS[0].items)).map(it => ({ ...it, v: it.v || NEWS[0].v }));
  const n = list.length, many = n > 20, calm = reducedMotion();
  const stars = Array.from({ length: 16 }, (_, k) => `<i style="--x:${(k * 37) % 100}%;--y:${(k * 53) % 100}%;--s:${.6 + (k % 4) * .25};--t:${2 + (k % 5) * .6}s;--dl:${(k % 7) * .4}s">${k % 3 ? '✦' : '✧'}</i>`).join('');
  const card = (it, k) => `<section class="nx-card" data-k="${k}">
      <div class="nx-emo">${it.e}</div><h2>${esc(it.t)}</h2><p>${esc(it.d)}</p>
      ${it.go && it.go !== 'news' ? `<button class="nx-go ${seen.includes(it.go) ? 'seen' : ''}" data-ng="${it.go}">${seen.includes(it.go) ? '✓ ' : ''}👀 תראו לי</button>` : ''}
      <small class="nx-day">${all ? '📅 ' + dLabel(it.v) : `${k + 1} מתוך ${n}`}</small></section>`;
  const end = `<section class="nx-card nx-end" data-k="${n}"><div class="nx-emo">🎉</div><h2>זהו! תיהנו</h2><p>${all ? 'זו כל ההיסטוריה.' : 'אפשר לראות הכל שוב ב־⚙️ ← "✨ מה חדש".'}</p>
      <button class="nx-done" id="nxDone">יאללה, להמשיך ✨</button></section>`;
  sheet(`<!--full--><div class="nx ${calm ? 'calm' : ''}">
    <div class="nx-bg">${stars}</div>
    ${many ? `<div class="nx-count"><span id="nxCnt">1</span> / ${n + 1}</div>` : `<div class="nx-bars">${[...list, 0].map(() => '<i><b></b></i>').join('')}</div>`}
    <div class="nx-top"><div><b class="nx-title">✨ ${all ? 'כל מה שחדש' : 'יש חדש!'}</b><small>${all ? `${n} חידושים` : `${dLabel(NEWS[0].v)} · <span class="nx-pill">${n} חידושים</span>`}</small></div><button class="nx-x" id="nxX" aria-label="סגירה">✕</button></div>
    <div class="nx-track" id="nxTrack">${list.map(card).join('')}${end}</div>
    <div class="nx-hint">${calm ? 'מחליקים ←' : 'מחליקים או נוגעים בצד ←'}</div></div>`);
  const sh = $('#sheet'), track = sh.querySelector('#nxTrack'), cards = [...track.children], bars = [...sh.querySelectorAll('.nx-bars i')];
  let idx = -1, paused = false;
  const auto = !all && !calm;
  const show = k => { k = Math.max(0, Math.min(cards.length - 1, k)); cards[k].scrollIntoView({ inline: 'start', block: 'nearest', behavior: calm ? 'auto' : 'smooth' }); };
  const setIdx = k => {
    if (k === idx) return; idx = k; clearTimeout(nxTimer);
    cards.forEach((c, j) => c.classList.toggle('on', j === k));
    bars.forEach((b, j) => { b.className = j < k ? 'done' : j === k ? (auto ? 'run' : 'done') : ''; });
    const cnt = sh.querySelector('#nxCnt'); if (cnt) cnt.textContent = k + 1;
    if (newsBack) newsBack.idx = k;
    if (k === cards.length - 1 && !all && !calm) confetti();
    if (auto && k < cards.length - 1) nxTimer = setTimeout(() => { if (!paused && sh.classList.contains('full')) show(k + 1); }, NX_MS);
  };
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && e.intersectionRatio > .6) setIdx(+e.target.dataset.k); }), { root: track, threshold: [.6] });
  cards.forEach(c => io.observe(c));
  // נגיעה בצד: שמאל = הבא, ימין = הקודם (עברית). אצבע על המסך עוצרת את המעבר האוטומטי
  track.addEventListener('click', e => { if (e.target.closest('button')) return; const r = track.getBoundingClientRect(); show(idx + (e.clientX < r.left + r.width / 2 ? 1 : -1)); });
  track.addEventListener('pointerdown', () => { paused = true; sh.querySelector('.nx').classList.add('paused'); });
  const resume = () => { if (!paused) return; paused = false; sh.querySelector('.nx')?.classList.remove('paused'); if (auto && idx < cards.length - 1) { clearTimeout(nxTimer); nxTimer = setTimeout(() => show(idx + 1), NX_MS / 2); } };
  track.addEventListener('pointerup', resume); track.addEventListener('pointercancel', resume);
  const goTo = key => {
    const f = NEWS_GO[key]; if (!f) return;
    newsBack = { all, items, idx, seen: [...new Set([...seen, key])] };
    closeSheet(); setTimeout(() => { f(); newsFab(); }, 250);
  };
  sh.querySelectorAll('[data-ng]').forEach(b => b.onclick = e => { e.stopPropagation(); goTo(b.dataset.ng); });
  const done = () => { newsBack = null; closeSheet(); };
  sh.querySelector('#nxX').onclick = done; sh.querySelector('#nxDone').onclick = done;
  const start = restore && newsBack?.idx != null ? newsBack.idx : 0;
  setTimeout(() => { if (start) cards[start].scrollIntoView({ inline: 'start', block: 'nearest' }); setIdx(start); }, 30);
  if (!restore && !all && !calm) setTimeout(() => confetti(), 250);
}
// ✨ כפתור צף: חזרה לרשימת "מה חדש" אחרי שניסו משהו. נשאר עד "הבנתי ✓" או ✕
function newsFab() {
  $('.news-fab')?.remove();
  if (!newsBack) return;
  const d = document.createElement('div'); d.className = 'news-fab';
  d.innerHTML = '<button class="nf-go">✨ חזרה למה חדש</button><button class="nf-x" aria-label="סגירה">✕</button>';
  d.querySelector('.nf-go').onclick = () => { const b = newsBack; if (b) openNews(b.all, b.items, true); };
  d.querySelector('.nf-x').onclick = () => { newsBack = null; d.remove(); };
  $('#app').appendChild(d);
}
$h('#toNews').onclick = () => openNews(true);

// ---------- 📱 עמדת בדיקה: ?bdika=1&news=<v>|<i>, או הודעה {bdika:'news', v, i} מהדף שמסביב ----------
function bdikaNews(v, i) {
  const it = NEWS.find(n => n.v === v)?.items?.[+i]; if (!it) return;
  closeSheet(); $('.news-fab')?.remove();
  const f = typeof it.go === 'function' ? it.go : NEWS_GO[it.go];
  if (!f || it.go === 'news') return showView('chat');
  setTimeout(() => { try { f(); } catch (e) { console.warn('bdika', e); } }, 200);
}
if (db.BDIKA) {
  document.documentElement.classList.add('bdika');
  addEventListener('message', e => { const d = e.data || {}; if (d.bdika === 'news') bdikaNews(d.v, d.i); });
  const q = new URLSearchParams(location.search).get('news');
  if (q) { const [v, i] = q.split('|'); setTimeout(() => bdikaNews(v, i), 1500); }
}

// ---------- 📆 חיבור ליומן של הטלפון (מנוי ICS שמתעדכן לבד). אותו מסך כמו בכסף בכיף ----------
async function openCalendarSub(renew = false) {
  const draw = (url, isDemo) => {
    const webcal = url.replace(/^https:/, 'webcal:'), g = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
    sheet(`<h3>📅 חיבור ליומן של הטלפון</h3><p class="note" style="margin:-6px 0 12px">${isDemo ? '🎭 <b>יומן לדוגמה</b> (משפחה מדומה), כדי לנסות. בטלפון האמיתי מקבלים יומן אישי.<br>' : ''}יומן <b>"⏰ זמן בכיף"</b> שמתעדכן לבד: משימות עם תאריך, פגישות ותזכורות קבועות (כמו תרופות), עם תזכורת 10 דקות לפני.</p>
      <div class="cal-steps">
        <div class="cal-step"><b>🍏 אייפון / Mac</b><small>לוחצים ← "הירשם" (Subscribe) ← "הוסף". וזהו.</small>
          <a class="btn pri" href="${webcal}">🍏 להוסיף ליומן של אייפון</a></div>
        <div class="cal-step"><b>📅 Google / אנדרואיד</b><small>נפתח Google Calendar (גם בדפדפן, לא צריך את האפליקציה) ← "הוספה" (Add). היומן נכנס לחשבון הגוגל שלך, ומופיע בכל יומן בטלפון שמחובר לחשבון. נפתח דף פרסום של גוגל? מתחברים לחשבון הגוגל, ולוחצים שוב.</small>
          <a class="btn pri" href="${g}" target="_blank" rel="noopener" style="background:linear-gradient(135deg,#3B82F6,#22C55E)">📅 להוסיף ל־Google יומן</a></div>
        <div class="cal-step cal-tip"><b>📱 משתמשים ב"לוח עברי" (או יומן סמסונג)?</b><small>אחרי ההוספה בגוגל: ב"לוח עברי" ← ⚙️ הגדרות ← <b>חשבונות</b> ← תחת חשבון הגוגל מסמנים <b>✓</b> ליד <b>"⏰ זמן בכיף"</b> (אם כתוב "לא מסונכרן"). ולהפך: אירוע חדש ב"לוח עברי" נשמר לרוב ביומן <b>"Samsung Calendar"</b> שבתוך חשבון הגוגל. לכל יומן בגוגל יש כתובת סודית משלו, אז מחברים כל אחד בנפרד למטה ב־<b>"➕ עוד יומן"</b>: גם את "Samsung Calendar", וגם את "היומן המשפחתי".</small></div>
        <div class="cal-step"><b>💻 מחשב / אחר</b><small>מעתיקים את הקישור ← ביומן: "הוספת יומן" ← "מכתובת URL" / "From URL" ← מדביקים.</small>
          <button class="btn" id="calCopy">📋 העתקת הקישור</button></div>
      </div>
      <div class="card cal-in" id="calIn" style="margin-top:12px"><b>📥 ולהפך: היומן שלך, באפליקציה</b><p class="note">⏳ בודק…</p></div>
      <p class="note" style="margin-top:10px">⏳ <b>חשוב לדעת:</b> גוגל מרענן יומן כזה <b>כל כמה שעות</b> (לא מיד), ואייפון בערך כל שעה. רוצים גם את היומן שלך בתוך האפליקציה? ראו "📥 ולהפך" למעלה.${isDemo ? '' : '<br>🔒 הקישור אישי ופרטי. מישהו קיבל אותו בטעות? <button class="chip" id="calRenew" style="margin-top:4px">🔄 חידוש קישור (הישן מפסיק לעבוד)</button>'}</p>`);
    $('#calCopy').onclick = async () => { try { await navigator.clipboard.writeText(url); toast('📋 הקישור הועתק'); } catch { toast(url); } };
    $('#calRenew')?.addEventListener('click', e => {
      if (!e.target.dataset.armed) { e.target.dataset.armed = '1'; e.target.textContent = '⚠️ בטוח? הקישור הישן יפסיק לעבוד. לחיצה שנייה'; return; }
      openCalendarSub(true);
    });
    drawCalIn($('#calIn'));
  };
  if (demo.DEMO) return draw(`${sync.CAL_FN}?t=demo`, true);
  sheet(`<h3>📅 חיבור ליומן של הטלפון</h3><p class="note" style="margin:-6px 0 12px">⏳ ${renew ? 'מחדש' : 'מכין'} קישור אישי…</p>`);
  try { const url = await sync.calendarURL(renew); if (renew) toast('🔄 קישור חדש. צריך להוסיף אותו שוב ליומן'); draw(url, false); }
  catch (e) { sync.fail('calendar', e); sheet(`<h3>📅 חיבור ליומן</h3><p class="note" style="color:#FB7185">${esc(e.message)}</p>`); }
}
$h('#calSubBtn').onclick = () => openCalendarSub();

// ---------- 📥 ולהפך: האירועים מהיומן של הטלפון בתוך האפליקציה (לקריאה בלבד) ----------
// נשמרים גם בטלפון, כדי שיופיעו גם בלי אינטרנט. השרת קורא את היומן כל 15 דקות
const extOf = r => {
  const allDay = !!r.all_day, s0 = allDay ? (([y, m, d]) => new Date(y, m - 1, d))(r.starts_at.slice(0, 10).split('-').map(Number)) : new Date(r.starts_at);
  const dur = allDay ? null : Math.max(5, Math.round((new Date(r.ends_at || +s0 + 36e5) - s0) / 6e4));
  return { id: `ext-${r.cal_id || ''}-${r.uid}-${r.starts_at}`, ext: true, cal: r.cal_id || null, busy: true, kind: 'ext', status: 'open', text: (r.title || '(בלי שם)').slice(0, 200), place: r.location || null,
    due: s0.toISOString(), hasTime: !allDay, dur, by: S.uid, forP: S.myP };
};
async function loadExt(first) {
  if (demo.DEMO) { // 🎭 בהדגמה: כמה אירועים לדוגמה "מהיומן", כדי לראות איך זה נראה
    const d = n => { const x = sod(new Date()); x.setDate(x.getDate() + n); return x; }, at = (n, h, m = 0) => { const x = d(n); x.setHours(h, m); return x.toISOString(); };
    S.ext = [{ uid: 'd1', starts_at: at(0, 18), ends_at: at(0, 19), title: 'חוג ציור של נועה', location: 'מתנ"ס' },
      { uid: 'd2', starts_at: at(1, 16, 30), ends_at: at(1, 17, 30), title: 'רופא שיניים' },
      { uid: 'd3', starts_at: ymd(d(3)) + 'T00:00:00Z', all_day: true, title: 'חתונה של שירה' }].map(extOf);
    S.extHost = 'calendar.google.com'; return;
  }
  if (first) { const c = await db.getKV('ext'); if (Array.isArray(c)) { S.ext = c; S.extHost = (await db.getKV('extHost')) || ''; } }
  if (!S.uid || !navigator.onLine) return;
  const cals = await sync.myCalendars().catch(() => null); if (cals === null) return;
  const rows = cals.length ? await sync.externalEvents() : [];
  if (rows === null) return; // שגיאת רשת: נשאר מה שנשמר
  const nm = Object.fromEntries(cals.map(c => [c.id, c.label || c.host]));
  S.ext = rows.map(r => ({ ...extOf(r), calName: nm[r.cal_id] || '' })); S.extHost = cals.map(c => c.label || c.host).join(', ');
  await db.setKV('ext', S.ext); await db.setKV('extHost', S.extHost);
  if (curView() === 'cal') renderCal(); renderDayline?.();
  if (started) scanConflicts(); // משהו שלי מתנגש עם אירוע מהיומן? מופיע בשיחה ובפעמון
}
setInterval(() => { if (!document.hidden) loadExt(); }, 15 * 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (S._extAt || 0) > 5 * 60e3) { S._extAt = Date.now(); loadExt(); } });

// הכרטיס "📥 ולהפך" בתוך מסך החיבור (כמו בכסף בכיף)
const fmtExt = x => `${new Date(x.due).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' })}${x.hasTime ? ' · ' + hm(new Date(x.due)) : ' · כל היום'}`;
async function drawCalIn(el) {
  if (!el) return;
  const head = '<b>📥 ולהפך: היומן שלך, באפליקציה</b>';
  if (demo.DEMO) { el.innerHTML = `${head}<p class="note" style="margin-top:4px">מדביקים כאן את הקישור הסודי של היומן שלך (גוגל / אייפון), והאירועים מופיעים ביומן של זמן בכיף. אפשר כמה יומנים (שלי + המשפחתי). 🎭 במצב הדגמה לא מתחברים. <a href="guide/#calin" target="_blank" style="color:#F9A8D4">איך מוצאים את הקישור?</a></p>`; return; }
  let cals = []; try { cals = await sync.myCalendars(); } catch { /* */ }
  const now = Date.now(), ev = S.ext.filter(x => +new Date(x.due) + (x.dur || 1440) * 6e4 >= now).slice(0, 8);
  const form = `<div class="cal-add" ${cals.length ? 'hidden' : ''}>
      <input id="calUrl" dir="ltr" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" class="cal-inp">
      <input id="calLbl" maxlength="40" placeholder="שם (לא חובה). למשל: היומן המשפחתי" class="cal-inp" style="margin-top:6px">
      <div id="calErr" style="color:#FB7185;font-size:13px;min-height:16px"></div><button class="btn pri" id="calGo">🔗 ${cals.length ? 'חיבור עוד יומן' : 'חיבור היומן שלי'}</button></div>`;
  el.innerHTML = `${head}<p class="note" style="margin:4px 0 8px">${cals.length ? '' : 'מדביקים את <b>"הכתובת הסודית בפורמט iCal"</b> של היומן שלך (בגוגל: ⚙️ ← "הגדרות של היומנים שלי" ← בוחרים יומן ← "כתובת סודית בפורמט iCal"; לכל יומן כתובת משלו), והאירועים (חתונה, טיפול, פגישה בעבודה…) מופיעים ביומן של זמן בכיף בכחול, עם <span class="ext-tag">📅 מהיומן</span>. האפליקציה גם תזהיר אם משהו חדש מתנגש איתם. '}🔒 מוצפן, ורק את/ה רואה. מתעדכן כל 15 דקות.</p>
    ${cals.length ? `<div class="cal-list">${cals.map(c => `<div class="cal-li"><div><b>📅 ${esc(c.label || c.host)}</b><small>${c.label ? `<span dir="ltr">${esc(c.host)}</span> · ` : ''}${c.last_error ? `<span style="color:#FB7185">⚠️ ${esc(c.last_error)}</span>` : c.last_sync ? `עודכן ${new Date(c.last_sync).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} · ${c.events} אירועים` : '⏳ קורא בפעם הראשונה…'}</small></div><button class="chip cal-off" data-off="${c.id}">🔌 ניתוק</button></div>`).join('')}</div>
      ${ev.length ? `<p class="note" style="margin:8px 0 4px">הקרובים:</p><div class="xcal-list">${ev.map(x => `<div><span>${esc(fmtExt(x))}${cals.length > 1 && x.calName ? ' · ' + esc(x.calName) : ''}</span><b>${esc(x.text)}</b></div>`).join('')}</div>` : '<p class="note" style="margin-top:6px">אין אירועים קרובים.</p>'}
      ${cals.length < 5 ? '<button class="chip" id="calMore" style="margin-top:10px">➕ עוד יומן (למשל היומן המשפחתי)</button>' : ''}` : '<a class="chip" href="guide/#calin" target="_blank" style="text-decoration:none;display:inline-block;margin-bottom:8px">📖 איך מוצאים את הקישור בגוגל / אייפון?</a>'}
    ${form}`;
  el.querySelector('#calMore')?.addEventListener('click', e => { e.currentTarget.hidden = true; el.querySelector('.cal-add').hidden = false; el.querySelector('#calUrl').focus(); });
  el.querySelector('#calGo').onclick = async e => {
    const b = e.currentTarget, v = el.querySelector('#calUrl').value.trim(), lbl = el.querySelector('#calLbl').value.trim(); if (!v) return el.querySelector('#calUrl').focus();
    b.disabled = true; b.textContent = '⏳ מתחבר וקורא את היומן…';
    try { const h = await sync.connectCalendar(v, lbl); toast(`📥 היומן חובר (${lbl || h})`); confetti(); await loadExt(); drawCalIn(el); }
    catch (err) { sync.fail('calendar', err); el.querySelector('#calErr').textContent = err.message; b.disabled = false; b.textContent = '🔗 חיבור'; }
  };
  el.querySelectorAll('[data-off]').forEach(b => b.onclick = async () => {
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '⚠️ בטוח? מוחק את הקישור והאירועים'; return; }
    try { await sync.disconnectCalendar(b.dataset.off); toast('🔌 היומן נותק. הקישור והאירועים שלו נמחקו'); await loadExt(); if (curView() === 'cal') renderCal(); drawCalIn(el); } catch (err) { toast(err.message, true); }
  });
}

async function boot() {
  started = true;
  await welcomeMe();
  if (!S.msgs.length) {
    const o = others()[0];
    const ex = o ? `\n🙋 תזכיר ל${nameIn(o.id, o.nicks[0]?.g)} מחר ב-5 לקנות חלב\n💌 ${nameIn(o.id, o.nicks[0]?.g)}, קבעתי לנו פגישה ביום שלישי ב-8` : '';
    await bot('👋', 'var(--g1)', 'שלום! אני "זמן בכיף"', `כתוב או אמור לי כל דבר, ואני אסדר:\n📌 תזכיר לי מחר ב-10 להתקשר לבנק\n🔁 כל יום חמישי ב-9 לשלם לגננת\n👥 פגישה עם יוסי ביום שלישי ב-4\n💭 רעיון: לסדר את המחסן\n✅ סיימתי לשלוח הצעת מחיר${ex}\n\nליד כל משימה יש 📎 שיוך — רק לי, לקבוצה, או לאדם מסוים.\nכשיגיע הזמן, אשאל אותך אם עשית את זה.`);
  }
  await tick();
  setInterval(tick, 30000);
  setTimeout(maybeNews, 1200);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { document.title = 'זמן בכיף'; tick(); seeView(curView()); } });
}

(async () => {
  if (demo.DEMO) await demo.ensureSeed();
  await load();
  demo.init({ showView, sheet, closeSheet, toast, confetti, sendNotes: sendDemoNotes, calMode: m => { CAL.mode = m; CAL.jump = true; renderCal(); } });
  await sync.start({
    onItem: onRemoteItem,
    onRemote: () => { clearTimeout(S._rr); S._rr = setTimeout(() => { renderAll(); renderFamily(); if (started) scanConflicts(); }, 250); },
    onGroups: () => { buildPeople(); renderAll(); renderFamily(); renderMe(); watchJoins(); },
    onRemoved: gone => removedFromGroups(gone),
    onBusy: b => { S.busy = b; },
    onCats: c => { S.cats = c; renderAll(); drawCatCard(); },
    onRes: async r => { await db.setKV('resources', r); S.resources = C.DEFAULT_RES.concat(r); renderRes(); },
    onStatus: st => { const el = $('#syncState'); if (el) el.textContent = st === 'ok' ? 'מסונכרן ✓' : 'ממתין לרשת…'; },
  });
  S.items = await db.all('items');
  if (await showGate()) {
    buildPeople(); renderAll(); renderFamily(); boot();
    sync.whenReady().then(async () => { await migrateToGroups(); buildPeople(); renderAll(); renderFamily(); renderMe(); S._extAt = Date.now(); loadExt(); });
    loadExt(true).then(() => { if (curView() === 'cal') renderCal(); });
  }
  if (startView() === 'chat') seeView('chat'); drawUnread();
  if (startView() !== 'chat' && !new URLSearchParams(location.search).has('take') && !new URLSearchParams(location.search).has('dose')) showView(startView());
  if (RECOVERY && sync.user()) openNewPassword();
  else { setTimeout(deepLinkTask, 800); gcalReturn(); }
  { const q = new URLSearchParams(location.search), id = q.get('take') || q.get('dose');
    if (id) { history.replaceState(null, '', location.pathname); setTimeout(() => doseLink(q.get('take') ? 'take' : 'dose', id, q.get('at')), 900); } }
  navigator.serviceWorker?.addEventListener('message', e => { const d = e.data || {}; if (d.type === 'dose') doseLink(d.kind, d.id, d.at); });
  try { navigator.storage?.persist?.(); } catch { /* */ } // שהדפדפן לא ימחק את הנתונים כשחסר מקום
})();

if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !db.BDIKA) { // בעמדת הבדיקה: בלי שירות מטמון
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(r => r.update?.()).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadController) return; if (document.hidden) S.reloadOnShow = true; else toast('✨ יש גרסה חדשה', false, { l: '🔄 לעדכן', run: () => location.reload() }); });
  // בכל חזרה לאפליקציה: בודקים אם יש גרסה חדשה. אם התעדכנה כשהייתה ברקע — נטענת מחדש לבד
  document.addEventListener('visibilitychange', () => { if (document.hidden) return; if (S.reloadOnShow && !sheetOpen()) return location.reload(); navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {}); });
}

// לבדיקות מהדפדפן
window.__zman = { demo, openCalendarSub, openNews, maybeNews, shrinkPhoto, faceHtml, removedFromGroups, startFocus, endFocus, renderAll, CAL, renderCal, showView, bell, openBell, bumpTask, openCatEdit, drawCatCard, renderTasks, openQuick, showIncoming, showReply, openEdit, buildPeople, openAssign, renderFamily, renderProfile, S, parse, send, forWhom, sync, OPS, scanConflicts, openConflict, allConflicts, Z, tick, onRemoteItem, inviteOf, desiredSchedule, welcomeMe };
