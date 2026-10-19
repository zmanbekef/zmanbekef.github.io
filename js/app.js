import * as db from './db.js';
import { parse, matchScore, whenLabel, nextOccurrence, sod, addDays, ymd, hm, DAYS } from './parse.js';
import { hebDate, gematria } from './hebdate.js';
import * as sync from './sync.js';
import * as C from './conflicts.js';
import * as Z from './zmanim.js';
import * as help from './help.js';
import * as lock from './lock.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => ymd(new Date());
const isToday = iso => iso && ymd(new Date(iso)) === today();

const S = { items: [], msgs: [], log: [], top3: null, settings: { morning: '07:00', evening: '20:00', city: 'ירושלים', candleMin: 40, shabbatAlerts: [60], melody: 'bells' }, pending: null, day: today(),
  people: [], uid: null, myP: null, who: 'all', busy: [], resources: C.DEFAULT_RES, travel: {}, alerted: [] };
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
  if (S.uid) list.push({ id: 'u:' + S.uid, uid: S.uid, name: pr?.full_name || 'אני', e: pr?.emoji || '🙂', nicks: [] });
  for (const g of sync.myGroups()) for (const m of g.members) {
    const id = m.user_id ? 'u:' + m.user_id : 'm:' + m.id;
    let p = list.find(x => x.id === id);
    if (!p) { p = { id, uid: m.user_id || null, name: m.user_id ? (m.profile?.full_name || m.nickname) : m.nickname, e: m.profile?.emoji || m.emoji || '🙂', nicks: [] }; list.push(p); }
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
  S.msgs.push(m); await db.put('msgs', m);
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
const KEEP = new Set(['assign', 'newGroup', 'shareGroup', 'editMe', 'edit', 'star', 'pickTop3', 'goto', 'conflict', 'replyText', 'replyNo']);
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
  if (it.repeat) {
    it.lastDone = now.toISOString();
    const from = new Date(Math.max(now, new Date(it.due || now)));
    it.due = nextOccurrence(it.repeat, it.hasTime ? new Date(it.due).getHours() : 9, it.hasTime ? new Date(it.due).getMinutes() : 0, from)?.toISOString() || null;
    it.askAt = null; it.askedKey = null;
  } else { it.status = 'done'; it.doneAt = now.toISOString(); }
  if (it.kind === 'thought') it.kind = 'task';
  it.doneBy = S.myP;
  await save(it); await addLog(it, 'done');
  if (S.pending === id) S.pending = null;
  renderAll();
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

const OPS = {
  done: id => markDone(id),
  async undoDone(id) {
    const it = item(id); if (!it) return;
    if (it.repeat) { it.lastDone = null; } else { it.status = 'open'; it.doneAt = null; }
    const i = S.log.findLastIndex(l => l.itemId === id && l.action === 'done');
    if (i >= 0) { await db.del('log', S.log[i].id); S.log.splice(i, 1); }
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
  async remove(id) {
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
    else if (t3.ids.filter(x => item(x)).length >= 3) { toast('כבר יש 3 חשובים. בחר מי יוצא'); return openPicker(id); }
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
  const pi = parse(text).intent;
  if (!['query', 'summary', 'morning', 'yes', 'no', 'done'].includes(pi) && help.isHelpRequest(text)) { $('#inp').blur(); return openHelp(text, help.wantsGuide(text) && !help.answer(text).length); }
  await me(text, voice);
  await think();
  const f = forWhom(text);
  if (f.msg) return sendMessage(f);
  const zm = Z.findZman(f.text);
  const pl = C.findPlace(zm ? zm.rest : f.text, knownPlaces());
  const p = parse(pl.text);
  if (zm && p.intent === 'item') {
    const at = await Z.zmanTime(S.settings.city, zm, p.due && !p.hasTime ? p.due : null);
    if (at) { p.due = at; p.hasTime = true; p.needsWhen = false; if (p.kind === 'thought') p.kind = 'task'; }
    else return bot('🤔', 'var(--card2)', 'לא הצלחתי לחשב את הזמן', 'צריך אינטרנט כדי לקבל את זמני היום. נסה שוב עוד רגע');
  }
  p.forP = f.forP; p.private = f.private; p.group = f.group || null; p.place = pl.place; p.res = C.findRes(text, S.resources);

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
    if ((m = t.match(new RegExp(`^(משימה|תזכורת)\\s+(?:ל|בשביל\\s+)${n}${E}\\s*[:,]?\\s*`)))) {
      t = 'משימה: ' + t.slice(m[0].length); forP = self ? null : p.id; break;
    }
    if ((m = t.match(new RegExp(`^ל?${n}\\s*:\\s*`)))) { t = t.slice(m[0].length); forP = self ? null : p.id; break; }
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
    dur: p.dur ?? null, place: p.place || null, res: p.res?.length ? p.res : null,
  };
  S.items.push(it); await save(it); await addLog(it, 'created'); renderAll();
  await createReply(it, p, fp);
  const qw = it.due && it.hasTime && it.kind === 'task' && !it.dur ? Z.quietAt(new Date(it.due)) : null;
  if (qw) await bot('🕯️', 'linear-gradient(135deg,#F59E0B,#FACC15)', `זה נופל ב${qw.name}`, `בשבת ובחג אין תזכורות. אזכיר לך ב${qw.name === 'שבת' ? 'מוצאי שבת' : 'מוצאי החג'}, ב-${hm(new Date(qw.end))}`);
  if (it.kind !== 'thought' && it.hasTime && it.dur == null) await askDur(it);
  else await scanConflicts();
}

async function createReply(it, p, fp) {
  const edit = { l: '✏️ תקן', op: 'edit', a: [it.id] }, undo = { l: '↩️ בטל', op: 'undo', a: [it.id] }, assign = { l: '📎 שיוך', op: 'assign', a: [it.id] };
  const extra = [S.uid ? gLabel(groupOf(it.group_id)) : '', it.dur ? `⏱️ ${durLbl(it.dur)}` : '', it.place ? `📍 ${it.place}` : '', ...(it.res || []).map(r => resOf(r)?.e + ' ' + resOf(r)?.n)].filter(Boolean).join(' · ');
  if (it.forP === 'any') return bot('👨‍👩‍👧', 'var(--g6)', `מישהו מאיתנו: ${it.text}`, `${it.due ? whenLabel(it) : 'בלי תאריך'}${extra ? ' · ' + extra : ''}\nאבדוק שלפחות אחד מכם פנוי, ואתריע אם לא`, [assign, edit, undo]);
  if (fp) {
    const sub = `${it.due ? whenLabel(it) : 'בלי תאריך'}\n${fp.uid ? `השאלה "עשית?" תגיע לטלפון של ${nameIn(fp.id, it.group_id)}, ואעדכן אותך כשיסיים/תסיים 🎉` : `ל${nameIn(fp.id, it.group_id)} עוד אין חשבון באפליקציה, אז אשאל אותך`}`;
    return bot(fp.e || '🙋', 'var(--g6)', `בשביל ${nameIn(fp.id, it.group_id)}: ${it.text}`, sub, [assign, edit, undo]);
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
let following = false;
async function followUps() {
  if (following) return; following = true;
  try {
    const now = new Date();
    // פגישה בעוד חצי שעה
    for (const it of tasksOpen().filter(x => x.kind === 'meeting' && x.hasTime && x.due)) {
      const d = new Date(it.due), key = 'pre:' + it.due;
      if (d > now && d - now <= 30 * 60e3 && it.askedKey !== key) {
        it.askedKey = key; await save(it);
        await bot('🔔', 'var(--g5)', `בעוד ${Math.max(1, Math.round((d - now) / 60e3))} דקות: ${it.text}`, `ב-${hm(d)}`);
        buzz();
      }
    }
    const due = tasksOpen().filter(x => {
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
          { l: '✅ כן, עשיתי', op: 'done', a: [it.id], pri: true }, { l: '⏰ עוד לא', op: 'snoozeAsk', a: [it.id] },
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
      await bot('⭐', 'var(--g1)', cand.length === 3 ? 'אלה 3 החשובים של היום?' : 'אלה החשובים של היום?', cand.map((x, i) => `${i + 1}. ${x.text}`).join('\n'),
        [{ l: '👍 מתאים', op: 'top3ok', a: [cand.map(x => x.id)], pri: true }, { l: '✏️ לבחור אחרים', op: 'pickTop3' }]);
    } else {
      await bot('⭐', 'var(--g1)', 'מה הכי חשוב לך היום?', 'כתוב לי עד 3 דברים, ואז לחץ ⭐ כדי לשים אותם למעלה');
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
  if (!list.length && !late.length) return bot('📋', 'var(--g2)', `${name} אין שום דבר מתוכנן`, 'כתוב לי מה תרצה להוסיף');
  const line = x => `${x.hasTime ? hm(new Date(x.due)) : '•'} ${x.kind === 'meeting' ? '👥 ' : ''}${x.text}${day === 'week' ? ` (${whenLabel(x).split(' ב-')[0]})` : ''}`;
  let sub = list.map(line).join('\n');
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
    const cloud = sync.saveFeedback({ kind, message, contact, device }).catch(() => false);
    let mailed = false;
    try {
      const r = await fetch(`https://formsubmit.co/ajax/${FEEDBACK_FORM}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _subject: `💌 משוב חדש — זמן בכיף (${FKINDS[kind]})`, _template: 'table', _captcha: 'false',
          'אפליקציה': 'זמן בכיף ⏰', 'סוג': FKINDS[kind], 'משוב': message, 'פרטים לחזרה': contact || '—', 'מכשיר': device || '—' }),
      });
      mailed = r.ok;
    } catch { mailed = false; }
    const saved = await cloud;
    if (mailed || saved) { closeSheet(); confetti(); toast('💌 תודה! המשוב נשלח'); return; }
    e.target.disabled = false; e.target.textContent = '📨 שליחה';
    $('#fErr').innerHTML = `לא הצלחתי לשלוח (אין אינטרנט?). אפשר <a href="mailto:${FEEDBACK_TO}?subject=${encodeURIComponent('משוב — זמן בכיף')}&body=${encodeURIComponent(message)}" style="color:#F9A8D4">לשלוח במייל רגיל</a>`;
  };
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
    <button class="btn" id="hOpenGuide" style="margin-bottom:12px">📖 המדריך המלא (עם תמונות)</button>
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
  const add = (key, at, cat, title, body) => { if (+at > now && +at < until) out.push({ id: `${uid}:${key}`, to_uid: uid, at: outOfQuiet(at).toISOString(), cat, title, body, url: APP_URL }); };
  for (const it of tasksOpen()) {
    if (!it.due || !it.hasTime) continue;
    const t = new Date(it.askAt || it.due);
    if (it.kind === 'meeting') add(`pre:${it.id}`, new Date(+t - 30 * 60e3), 'task', `🔔 בעוד חצי שעה: ${it.text}`, `ב-${hm(t)}${it.place ? ' · ' + it.place : ''}`);
    else add(`task:${it.id}`, t, 'task', `⏰ ${it.text}`, 'הגיע הזמן. עשית את זה?');
  }
  for (const w of Z.windows().filter(w => +new Date(w.start) > now).slice(0, 3))
    for (const off of S.settings.shabbatAlerts || [])
      add(`sh:${w.start}:${off}`, new Date(+new Date(w.start) - off * 60e3), 'shabbat', `🕯️ עוד ${durLbl(off)} ${w.name === 'שבת' ? 'נכנסת שבת' : 'נכנס ' + w.name}`, `הדלקת נרות ב-${hm(new Date(w.start))}`);
  for (let i = 0; i < 7; i++) {
    const d = addDays(sod(new Date()), i), at = (hhmm) => { const [h, m] = hhmm.split(':'); const x = new Date(d); x.setHours(+h, +m, 0, 0); return x; };
    const am = at(S.settings.morning), pm = at(S.settings.evening);
    if (!Z.quietAt(am)) add(`am:${ymd(d)}`, am, 'summary', '☀️ בוקר טוב!', 'בוא נראה מה יש היום ונבחר את 3 החשובים');
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
    if (changed.length && !(await sync.upsertNotify(changed))) return;
    const removed = gone.filter(id => { const at = had[id]?.split('|')[0]; return !at || new Date(at) > new Date(); });
    if (removed.length) await sync.deleteNotify(removed);
    const next = {}; for (const r of want) next[r.id] = sig(r);
    await db.setKV('sched', next);
  } finally { schedBusy = false; }
}

// כרטיס ההגדרות
const PUSH_CATS = [['msg', '💬 הודעות ותגובות מהמשפחה'], ['task', '⏰ הגיע הזמן של משימה'], ['conflict', '⚠️ התנגשות חדשה'], ['summary', '☀️🌙 סיכום בוקר וערב'], ['shabbat', '🕯️ לפני שבת וחג']];
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
  $('#pushOn')?.addEventListener('click', async () => { try { await sync.enablePush(S.settings.push || {}); toast('🔔 ההתראות הופעלו'); await syncSchedule(); } catch (e) { toast(e.message, true); } drawPush(); });
  $('#pushOff')?.addEventListener('click', async () => { await sync.disablePush(); toast('ההתראות כובו בטלפון הזה'); drawPush(); });
  $('#pushTest')?.addEventListener('click', async () => { await queueNotify(S.uid, 'msg', '🧪 התראת ניסיון', 'אם רואים את זה — ההתראות עובדות! אפשר גם לנעול את הטלפון ולנסות שוב.', 'test'); toast('📨 נשלח. תוך דקה תקפוץ התראה'); });
  el.querySelectorAll('[data-cat]').forEach(c => c.onchange = async () => {
    S.settings.push = { ...(S.settings.push || {}), [c.dataset.cat]: c.checked }; await db.setKV('settings', S.settings); await sync.savePrefs(S.settings.push); toast('נשמר ✓');
  });
}

// ---------- הודעות והזמנות בין בני הבית ----------
const REACT = { heart: '❤️', yes: '✅', no: '❌', alt: '🕐', like: '👍', text: '💬' };
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
  const txt = { heart: '❤️', like: '👍', yes: 'אישר/ה ✅', no: 'לא יכול/ה ❌', alt: 'מציע/ה זמן אחר 🕐', text: '' }[r.r];
  if (to?.uid) await queueNotify(to.uid, 'msg', `${person(S.myP)?.e || ''} ${person(S.myP)?.name || ''} ${txt}`.trim(), r.text || m.text, m.id);
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
    const freeFor = (o, t) => S.items.concat(S.busy).filter(x => x.status === 'open' && x.due && x.hasTime && x.dur > 0 && (ownerOf(x) === o)).every(y => !(t < C.endOf(y) && C.startOf(y) < t + dur));
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
const ctx = () => ({ items: S.items, busy: S.busy, owner: ownerOf, adults, resources: S.resources, travel: S.travel });
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
const nameOf = x => x.busy ? `${who(ownerOf(x))} תפוס/ה` : x.text;
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
  const pool = S.items.concat(S.busy).filter(x => x.status === 'open' && x.due && x.hasTime && x.dur > 0 && C.endOf(x) > t0 && C.startOf(x) < t1);
  const bar = x => { const l = (C.startOf(x) - t0) / W * 100, w = Math.max(2, x.dur * 60e3 / W * 100); const hot = pair.includes(x);
    return `<div class="tl-bar${hot ? ' hot' : ''}${x.busy ? ' busy' : ''}" style="right:${l}%;width:${w}%" title="${esc(nameOf(x))}">${esc(x.busy ? '🔒 תפוס' : x.text)}</div>`; };
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
  const busyFor = o => S.items.concat(S.busy).filter(x => x.status === 'open' && x.due && x.hasTime && x.dur > 0 && ownerOf(x) === o);
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
  if (list.length < 3) {
    const b = document.createElement('button'); b.className = 't3 empty';
    b.textContent = list.length ? '＋ להוסיף עוד חשוב' : '⭐ לבחור את החשובים של היום';
    b.onclick = () => openPicker(); box.appendChild(b);
  }
  const n = list.filter(isDoneToday).length;
  $('#t3bar').style.width = list.length ? (n / list.length * 100) + '%' : '0';
  $('#t3txt').textContent = !list.length ? 'עוד לא נבחרו' : n === list.length ? '🎉 סיימת את כל החשובים!' : `${n} מתוך ${list.length} בוצעו`;
  $('#t3edit').hidden = !list.length;
}

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
  const meta = [owner, it.kind === 'meeting' ? '👥 פגישה' : '', whenLabel(it) + (it.hasTime && it.dur ? `–${hm(new Date(C.endOf(it)))}` : ''), it.place ? '📍 ' + it.place : '', ...(it.res || []).map(r => resOf(r)?.e || '')].filter(Boolean).join(' · ');
  const warn = S.conflictIds?.has(it.id) && it.status === 'open' ? '<button class="warn" data-op="conf" aria-label="התנגשות">⚠️</button>' : '';
  return `<div class="row${d}" data-id="${it.id}"><button class="cb" data-op="check">${d ? '✓' : ''}</button>${warn}
    <div class="nm" data-op="edit">${esc(it.text)}${meta ? `<small class="${late ? 'late' : ''}">${esc(meta)}</small>` : ''}</div>
    ${S.uid && it.status === 'open' ? '<button class="star on" data-op="assign" aria-label="שיוך" style="font-size:16px">📎</button>' : ''}${it.status === 'open' && it.kind === 'task' && isMine(it) ? `<button class="star${star ? ' on' : ''}" data-op="star" aria-label="לחשובים של היום">⭐</button>` : ''}</div>`;
}
function renderTasks() {
  const now = new Date(), t0 = sod(now), t1 = addDays(t0, 1), t2 = addDays(t0, 2);
  // סינון: הכל / שלי / רק לי (בלי קבוצה) / קבוצה מסוימת
  const pass = x => S.who === 'all' || (S.who === 'mine' && isMine(x)) || (S.who === 'solo' && !x.group_id) || x.group_id === S.who;
  const open = rankForToday(allTasksOpen().filter(pass));
  const isLate = x => x.due && (x.hasTime ? new Date(x.due) < now : new Date(x.due) < t0);
  const gs = sync.myGroups();
  $('#whoFilter').hidden = !gs.length;
  if (gs.length) $('#whoFilter').innerHTML = [['all', 'הכל'], ['mine', '🙋 שלי'], ['solo', '🔒 רק לי'], ...gs.map(g => [g.id, gLabel(g)])]
    .map(([k, l]) => `<button class="chip ${S.who === k ? 'on' : ''}" data-w="${k}">${esc(l)}</button>`).join('');
  const groups = [
    ['⚠️ באיחור', open.filter(isLate)],
    ['☀️ היום', open.filter(x => !isLate(x) && x.due && new Date(x.due) < t1 && !x.repeat)],
    ['🌅 מחר', open.filter(x => x.due && new Date(x.due) >= t1 && new Date(x.due) < t2 && !x.repeat)],
    ['📆 בהמשך', open.filter(x => x.due && new Date(x.due) >= t2 && !x.repeat)],
    ['🔁 קבועות', open.filter(x => x.repeat && !isLate(x))],
    ['📝 בלי תאריך', open.filter(x => !x.due)],
    ['✅ בוצעו היום', S.items.filter(x => pass(x) && x.status !== 'deleted' && isTask(x) && ((x.status === 'done' && isToday(x.doneAt)) || (x.repeat && isToday(x.lastDone))))],
  ].filter(g => g[1].length);
  $('#taskList').innerHTML = groups.length ? groups.map(([h, l]) => `<div class="card"><h4>${h}<small>${l.length}</small></h4>${l.map(rowHtml).join('')}</div>`).join('')
    : `<div class="empty-state"><span class="em">🌤️</span>אין משימות כרגע.<br>כתוב לי בשיחה, למשל: "תזכיר לי מחר ב-10 להתקשר לבנק"</div>`;
  const lateN = tasksOpen().filter(isLate).length;
  $('#lateBadge').hidden = !lateN; $('#lateBadge').textContent = lateN;
}
$('#whoFilter').addEventListener('click', e => { const b = e.target.closest('[data-w]'); if (b) { S.who = b.dataset.w; renderTasks(); } });
$('#taskList').addEventListener('click', e => {
  const op = e.target.closest('[data-op]')?.dataset.op, id = e.target.closest('.row')?.dataset.id;
  if (!op || !id) return;
  const it = S.items.find(x => x.id === id);
  if (op === 'check') return isDoneToday(it) && !(it.repeat && it.status === 'open' && !isToday(it.lastDone)) ? OPS.undoDone(id) : markDone(id, true).then(() => toast('✅ ' + it.text));
  if (op === 'edit') return openEdit(id);
  if (op === 'star') return OPS.star(id);
  if (op === 'conf') return openConflict(id);
  if (op === 'assign') return openAssign(id);
});

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
  if (S.settings.calColors?.[pid]) return S.settings.calColors[pid];
  if (!pid || pid === S.myP) return '#7C3AED';
  const i = others().findIndex(p => p.id === pid);
  return CAL_COLORS[(i < 0 ? 0 : i) % CAL_COLORS.length];
}
// מי מוצג ביומן חוץ ממני (ברירת מחדל: מי שבמשפחה או בקשר ישיר איתי)
function calWho() {
  if (Array.isArray(S.settings.calWho)) return S.settings.calWho.filter(id => person(id));
  return others().filter(p => p.uid && p.nicks.some(n => ['family', 'pair'].includes(n.kind))).map(p => p.id);
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
      text: it.text, kind: it.kind,
    });
  };
  for (const it of S.items) {
    if (!['open', 'done'].includes(it.status) || ['msg', 'reply'].includes(it.kind) || !it.due) continue;
    const cat = calCat(it), owner = it.forP && it.forP !== 'any' ? it.forP : ownerP(it) || S.myP;
    if (cat === 'other' ? !who.has(owner) : !show[cat]) continue;
    seen.add(it.id); push(it, owner, true, false);
  }
  for (const pid of who) {
    const p = person(pid); if (!p?.uid) continue;
    for (const r of CAL.other[p.uid] || []) if (!seen.has(r.id)) push({ ...r.data, id: r.id }, pid, false, r.busy);
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
const holOf = d => CAL.hol[`${d.getFullYear()}-${d.getMonth()}`]?.[ymd(d)] || null;
const hebDay = d => { try { const n = +new Intl.DateTimeFormat('he-u-ca-hebrew', { day: 'numeric' }).format(d); return gematria(n); } catch { return ''; } };
const hebMonth = d => { try { return new Intl.DateTimeFormat('he-u-ca-hebrew', { month: 'long' }).format(d).replace('חשון', 'חשוון'); } catch { return ''; } };
const evLabel = e => `${e.kind === 'meeting' ? 'פגישה' : e.kind === 'thought' ? 'מחשבה' : 'משימה'}: ${e.busy ? 'תפוס' : e.text}${e.hasTime ? `, ${hm(e.start)}${e.dur ? ' עד ' + hm(e.end) : ''}` : ''}${e.owner !== S.myP ? ', של ' + pName(e.owner) : ''}${e.done ? ', בוצע' : ''}`;
const evIcon = e => e.busy ? '⛔' : e.done ? '✅' : e.kind === 'meeting' ? '👥' : e.kind === 'thought' ? '💭' : e.it?.repeat ? '🔁' : '📌';

async function renderCal(force) {
  if (!$('#v-cal').classList.contains('on')) return;
  const d = CAL.day, m = CAL.mode, jump = CAL.jump; CAL.jump = false;
  document.querySelectorAll('#calMode button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  // שורת האנשים: אני + מי שבקבוצות שלי ויש לו חשבון
  const ppl = others().filter(p => p.uid), who = calWho();
  $('#calWho').hidden = !ppl.length;
  $('#calWho').innerHTML = `<button class="chip on" style="--c:${colorOf(S.myP)}" disabled><i class="dot"></i>🙋 אני</button>` +
    ppl.map(p => `<button class="chip ${who.includes(p.id) ? 'on' : ''}" data-p="${p.id}" style="--c:${colorOf(p.id)}" aria-pressed="${who.includes(p.id)}"><i class="dot"></i>${esc(p.e)} ${esc(pName(p.id))}</button>`).join('');
  const from = m === 'day' ? d : m === 'week' ? addDays(d, -d.getDay()) : new Date(d.getFullYear(), d.getMonth(), 1);
  const to = m === 'day' ? addDays(d, 1) : m === 'week' ? addDays(from, 7) : new Date(d.getFullYear(), d.getMonth() + 1, 1);
  await Promise.all([loadHol(from), loadHol(addDays(to, -1)), loadOthers(force)]);
  const ev = calEvents(m === 'month' ? addDays(from, -7) : from, m === 'month' ? addDays(to, 7) : to);
  if (m === 'day') drawDay(d, ev, jump); else if (m === 'week') drawWeek(from, ev); else drawMonth(d, ev);
}

function drawDay(d, ev, jump) {
  const h = holOf(d), isT = ymd(d) === today();
  $('#calTitle').innerHTML = `<b>${isT ? 'היום · ' : ''}יום ${DAYS[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}</b><small>${esc(hebDate(d))}${h?.hol.length ? ' · ' + esc(h.hol.join(', ')) : ''}</small>`;
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
    ${allDay.length ? `<div class="cal-allday"><small>בלי שעה</small>${allDay.map(e => `<button class="cal-pill${e.done ? ' done' : ''}" data-ev="${e.id}" style="--c:${e.color}" aria-label="${esc(evLabel(e))}">${evIcon(e)} ${esc(e.busy ? 'תפוס/ה' : e.text)}</button>`).join('')}</div>` : ''}
    ${h?.candles ? `<div class="cal-zman">🕯️ הדלקת נרות ${hm(new Date(h.candles))}</div>` : ''}${h?.havdalah ? `<div class="cal-zman">✨ צאת ${esc(h.hol[0] && !/שבת/.test(h.hol[0]) ? 'החג' : 'השבת')} ${hm(new Date(h.havdalah))}</div>` : ''}
    <div class="cal-day" id="calDay" style="height:${24 * HOUR_PX}px" aria-label="ציר השעות של היום. לחיצה על שעה ריקה מוסיפה משימה">
      ${shade.map(([a, b, n]) => `<div class="cal-shade" style="top:${y(a)}px;height:${y(b) - y(a)}px"><span>🕯️ ${esc(n)}</span></div>`).join('')}
      ${Array.from({ length: 24 }, (_, i) => `<div class="cal-hr" style="top:${i * HOUR_PX}px"><span>${String(i).padStart(2, '0')}:00</span></div>`).join('')}
      ${timed.map(e => { const top = y(+e.start), ht = Math.max(e.dur ? y(+e.end) - top : 0, 26);
        return `<button class="cal-ev${e.done ? ' done' : ''}${e.busy ? ' busy' : ''}" data-ev="${e.id}" data-t="${+e.start}" aria-label="${esc(evLabel(e))}"
          style="--c:${e.color};top:${top}px;height:${ht - 2}px;right:calc(52px + (100% - 56px) * ${e.col / e.n});width:calc((100% - 56px) / ${e.n} - 3px)">
          <b>${hm(e.start)}${e.dur && e.n === 1 ? '–' + hm(e.end) : ''}</b> ${evIcon(e)} ${esc(e.busy ? 'תפוס/ה' : e.text)}${e.owner !== S.myP ? ` <small>· ${esc(pName(e.owner))}</small>` : ''}</button>`; }).join('')}
      ${isT ? `<div class="cal-now" style="top:${y(Date.now())}px"><i></i></div>` : ''}
    </div>`;
  // נפתח על השעה של עכשיו (או 7:00 ביום אחר / על הדבר הראשון)
  const first = timed[0] ? +timed[0].start : null;
  const target = isT ? y(Date.now()) - 120 : first ? y(first) - 60 : 7 * HOUR_PX;
  if (jump) $('#main').scrollTop = Math.max(0, $('#calDay').offsetTop + target - 20);
}

function drawWeek(from, ev) {
  const to = addDays(from, 6);
  $('#calTitle').innerHTML = `<b>${from.getDate()}.${from.getMonth() + 1} – ${to.getDate()}.${to.getMonth() + 1}</b><small>${esc(hebDate(from))} – ${esc(hebDate(to))}</small>`;
  $('#calBody').innerHTML = `<div class="cal-week">${Array.from({ length: 7 }, (_, i) => {
    const d = addDays(from, i), list = ev.filter(e => ymd(e.start) === ymd(d)), h = holOf(d);
    return `<button class="cal-col${ymd(d) === today() ? ' today' : ''}${d.getDay() === 6 || h?.hol.length ? ' hol' : ''}" data-day="${ymd(d)}" aria-label="יום ${DAYS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}, ${list.length} דברים">
      <span class="cal-dh"><b>${DSH[d.getDay()]}׳</b><i>${d.getDate()}</i><small>${hebDay(d)}</small></span>
      ${h?.hol.length ? `<span class="cal-holname">${esc(h.hol[0])}</span>` : ''}
      ${list.map(e => `<span class="cal-wi${e.done ? ' done' : ''}" style="--c:${e.color}">${e.hasTime ? `<b>${hm(e.start)}</b>` : ''}${esc(e.busy ? 'תפוס/ה' : e.text)}</span>`).join('')}
    </button>`; }).join('')}</div>`;
}

function drawMonth(d, ev) {
  const first = new Date(d.getFullYear(), d.getMonth(), 1), last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const hm1 = hebMonth(first), hm2 = hebMonth(last), hy = hebDate(last).split(' ').pop();
  $('#calTitle').innerHTML = `<b>${MONTHS_HE[d.getMonth()]} ${d.getFullYear()}</b><small>${esc(hm1 === hm2 ? hm1 : hm1 + '–' + hm2)} ${esc(hy)}</small>`;
  const start = addDays(first, -first.getDay()), weeks = Math.ceil((first.getDay() + last.getDate()) / 7);
  $('#calBody').innerHTML = `<div class="cal-month"><div class="cal-mh">${DSH.map(x => `<span>${x}׳</span>`).join('')}</div>${Array.from({ length: weeks * 7 }, (_, i) => {
    const c = addDays(start, i), list = ev.filter(e => ymd(e.start) === ymd(c)), h = holOf(c), out = c.getMonth() !== d.getMonth();
    const dots = [...new Set(list.map(e => e.color))].slice(0, 4);
    return `<button class="cal-cell${out ? ' out' : ''}${ymd(c) === today() ? ' today' : ''}${c.getDay() === 6 || h?.hol.length ? ' hol' : ''}" data-day="${ymd(c)}" aria-label="${c.getDate()}.${c.getMonth() + 1}, ${esc(hebDate(c))}${h?.hol.length ? ', ' + esc(h.hol.join(', ')) : ''}, ${list.length ? list.length + ' דברים' : 'פנוי'}">
      <b>${c.getDate()}</b><small>${hebDay(c)}</small>${h?.hol.length ? `<em>${esc(h.hol[0])}</em>` : ''}<span class="cal-dots">${dots.map(x => `<i style="background:${x}"></i>`).join('')}${list.length > 4 ? '+' : ''}</span></button>`;
  }).join('')}</div>
  <p class="note" style="padding:8px 16px">לחיצה על יום פותחת אותו לפי שעות.</p>`;
}

function calMove(n) {
  const d = CAL.day;
  CAL.jump = true;
  CAL.day = CAL.mode === 'day' ? addDays(d, n) : CAL.mode === 'week' ? addDays(d, 7 * n) : new Date(d.getFullYear(), d.getMonth() + n, 1);
  renderCal();
}
$('#calMode').onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; CAL.mode = b.dataset.m; CAL.jump = true; renderCal(); };
$('#calPrev').onclick = () => calMove(-1);
$('#calNext').onclick = () => calMove(1);
$('#calToday').onclick = () => { CAL.day = sod(new Date()); CAL.jump = true; renderCal(); };
$('#calWho').onclick = async e => {
  const b = e.target.closest('[data-p]'); if (!b) return;
  const cur = calWho(), id = b.dataset.p, on = !cur.includes(id);
  S.settings.calWho = on ? [...cur, id] : cur.filter(x => x !== id); await db.setKV('settings', S.settings);
  await renderCal(true);
  const p = person(id);
  if (on && p?.uid && !(CAL.other[p.uid] || []).length && !S.items.some(x => ownerP(x) === id && x.due)) toast(`ל${pName(id)} אין כרגע מה להראות, או שעוד לא שיתף/ה את היומן`);
};
$('#calBody').addEventListener('click', e => {
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
    ${open ? '<button class="btn pri" id="ceDone" style="margin-top:14px">✅ עשיתי</button>' : '<p class="note" style="margin-top:10px">✅ בוצע</p>'}
    <div class="two"><button class="btn" id="ceEdit">✏️ עריכה</button>${S.uid ? '<button class="btn" id="ceAssign">📎 שיוך</button>' : '<button class="btn" id="ceClose">סגירה</button>'}</div>`);
  $('#ceDone')?.addEventListener('click', async () => { closeSheet(); await markDone(id, true); toast('✅ ' + it.text); renderCal(); });
  $('#ceEdit').onclick = () => openEdit(id);
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
    ${[S.people.find(p => p.id === S.myP) || { id: null, e: '🙋', name: 'אני' }, ...others().filter(p => p.uid)].map(p => `<label class="set-row"><span>${esc(p.e)} ${esc(p.id === S.myP || !p.id ? 'אני' : nameIn(p.id, p.nicks?.[0]?.g))}</span><input type="color" data-col="${p.id || ''}" value="${colorOf(p.id)}" class="cal-color" aria-label="הצבע של ${esc(p.name)}"></label>`).join('')}
    <p class="note">את מי עוד רואים ביומן בוחרים בראש מסך היומן. מי רואה את היומן <b>שלך</b> נקבע בכל קבוצה, ב"👥 הקבוצות שלי".</p>`;
  el.querySelectorAll('[data-show]').forEach(c => c.onchange = async () => { S.settings.calShow = { ...calShow(), [c.dataset.show]: c.checked }; await db.setKV('settings', S.settings); toast('נשמר ✓'); });
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
$('#thoughtList').addEventListener('click', e => {
  const op = e.target.closest('[data-op]')?.dataset.op, id = e.target.closest('[data-id]')?.dataset.id;
  if (!op || !id) return;
  ({ toTask: () => OPS.toTask(id), date: () => openEdit(id, 'date', 'task'), star: () => OPS.star(id), remove: () => OPS.remove(id), edit: () => openEdit(id) })[op]?.();
});

// ---------- חלון עריכה ----------
function sheet(html) { $('#sheet').innerHTML = html; $('#sheetBg').classList.add('on'); }
function closeSheet() { $('#sheetBg').classList.remove('on'); $('#sheet').style.transform = ''; }
$('#sheetBg').addEventListener('click', e => { if (e.target.id === 'sheetBg') closeSheet(); });

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
  let kind = 'task';
  sheet(`<h3>➕ הוספה מהירה</h3>
    <div class="seg" id="qKind">${[['task', '📌 משימה'], ['meeting', '👥 פגישה'], ['thought', '💭 מחשבה']].map(([k, l]) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${l}</button>`).join('')}</div>
    <label>מה</label><input id="qText" placeholder="למשל: לקנות מתנה לאמא" enterkeyhint="done">
    <div id="qWhen"><label>מתי</label><div class="chips" id="qDay" style="padding:0;flex-wrap:wrap">${[['0', 'היום'], ['1', 'מחר'], ['x', '📅 תאריך'], ['', 'בלי תאריך']].map(([k, l]) => `<button class="chip ${k === '0' ? 'on' : ''}" data-d="${k}">${l}</button>`).join('')}</div>
    <input type="date" id="qDate" hidden style="margin-top:8px">
    <div class="two"><div><label>שעה (לא חובה)</label><input type="time" id="qTime" value="${pre.time || ''}"></div>
    <div><label>כמה זמן</label><select id="qDur"><option value="">לא ידוע</option><option value="0">רק תזכורת</option>${[15, 30, 45, 60, 90, 120, 180].map(m => `<option value="${m}">${durLbl(m)}</option>`).join('')}</select></div></div></div>
    <button class="btn pri" id="qSave" style="margin-top:16px">➕ הוסף</button>
    <button class="btn" id="qCancel">ביטול</button>`);
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
  setTimeout(() => $('#qText')?.focus(), 300);
  $('#qSave').onclick = async () => {
    const text = $('#qText').value.trim(); if (!text) return toast('צריך לכתוב מה', true);
    const ts = $('#qTime').value; let due = null;
    if (kind !== 'thought' && day !== '') {
      due = day === 'x' ? new Date(($('#qDate').value || ymd(new Date())) + 'T00:00') : sod(addDays(new Date(), +day));
      if (ts) { const [h, m] = ts.split(':'); due.setHours(+h, +m); }
    }
    const dv = $('#qDur').value;
    const back = pre.day ? 'cal' : 'chat';
    closeSheet(); if (back === 'chat') showView('chat');
    await createItem({ kind, text, due, hasTime: !!(due && ts), repeat: null, dur: dv === '' ? null : +dv, forP: null, private: false, group: null }, null);
    toast('✅ נוסף');
  };
}
$('#plusBtn').onclick = () => openQuick();

function openEdit(id, focus, forceKind) {
  const it = item(id); if (!it) return toast('המשימה הזאת כבר לא קיימת', true);
  let kind = forceKind || it.kind;
  const d = it.due ? new Date(it.due) : null;
  const rep = it.repeat?.type || '';
  sheet(`<h3>✏️ עריכה</h3>
    <label>סוג</label><div class="seg" id="eKind">${[['task', '📌 משימה'], ['meeting', '👥 פגישה'], ['thought', '💭 מחשבה']].map(([k, l]) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${l}</button>`).join('')}</div>
    <label>מה</label><input id="eText" value="${esc(it.text)}">${it.raw && it.raw !== it.text ? `<p class="note" style="margin-top:4px">✍️ במקור כתבת: "${esc(it.raw)}"</p>` : ''}
    <div id="eWhen"><div class="two"><div><label>תאריך</label><input type="date" id="eDate" value="${d ? ymd(d) : ''}"></div>
    <div><label>שעה (לא חובה)</label><input type="time" id="eTime" value="${d && it.hasTime ? hm(d) : ''}"></div></div>
    <label>חוזר</label><select id="eRep"><option value="">לא חוזר</option><option value="daily">כל יום</option><option value="weekly">כל שבוע</option><option value="monthly">כל חודש</option></select></div>
    <div id="eWhen2"><div class="two"><div><label>כמה זמן</label><select id="eDur"><option value="">לא ידוע</option><option value="0">רק תזכורת</option>${[15, 30, 45, 60, 90, 120, 180, 240].map(m => `<option value="${m}">${durLbl(m)}</option>`).join('')}</select></div>
    <div><label>איפה (לא חובה)</label><input id="ePlace" value="${esc(it.place || '')}" list="placeList"><datalist id="placeList">${knownPlaces().concat(C.CITIES).map(x => `<option value="${esc(x)}">`).join('')}</datalist></div></div></div>
    ${S.uid ? `<label>שייכת ל</label><div class="set-row" style="border:none;padding:4px 0"><b>${esc(assignLabel(it))}</b><button class="act pri" id="eAssign">📎 שיוך</button></div>` : ''}
    <button class="btn pri" id="eSave" style="margin-top:16px">💾 שמור</button>
    <div class="two"><button class="btn" id="eCancel">ביטול</button><button class="btn danger" id="eDel">🗑️ מחק</button></div>`);
  $('#eRep').value = rep;
  if (it.dur != null && ![0, 15, 30, 45, 60, 90, 120, 180, 240].includes(it.dur)) $('#eDur').insertAdjacentHTML('beforeend', `<option value="${it.dur}">${durLbl(it.dur)}</option>`);
  $('#eDur').value = it.dur == null ? '' : String(it.dur);
  const syncKind = () => { $('#eWhen').style.display = $('#eWhen2').style.display = kind === 'thought' ? 'none' : ''; };
  syncKind();
  $('#eKind').onclick = e => { const b = e.target.closest('button'); if (!b) return; kind = b.dataset.k; [...$('#eKind').children].forEach(x => x.classList.toggle('on', x === b)); syncKind(); };
  $('#eAssign')?.addEventListener('click', () => openAssign(id));
  if (focus === 'date') setTimeout(() => { try { $('#eDate').showPicker?.(); } catch { $('#eDate').focus(); } }, 350);
  $('#eCancel').onclick = closeSheet;
  $('#eDel').onclick = () => { closeSheet(); OPS.remove(id); };
  $('#eSave').onclick = async () => {
    const text = $('#eText').value.trim(); if (!text) return toast('צריך לכתוב מה', true);
    const ds = $('#eDate').value, ts = $('#eTime').value, rt = $('#eRep').value;
    let due = null, hasTime = !!ts, repeat = null;
    if (kind !== 'thought') {
      if (ds) { due = new Date(ds + 'T00:00'); if (ts) { const [h, m] = ts.split(':'); due.setHours(+h, +m); } }
      else if (ts) { due = sod(new Date()); const [h, m] = ts.split(':'); due.setHours(+h, +m); if (due <= new Date() && !rt) due = addDays(due, 1); }
      if (rt) {
        const base = due || new Date();
        repeat = rt === 'daily' ? { type: 'daily' } : rt === 'weekly' ? { type: 'weekly', dows: it.repeat?.type === 'weekly' && !ds ? it.repeat.dows : [base.getDay()] } : { type: 'monthly', dom: base.getDate() };
        due = nextOccurrence(repeat, ts ? +ts.split(':')[0] : 9, ts ? +ts.split(':')[1] : 0, new Date(Math.min(sod(base), Date.now()) - 1));
        if (due && due < new Date() && hasTime) due = nextOccurrence(repeat, due.getHours(), due.getMinutes(), new Date());
      }
    } else hasTime = false;
    Object.assign(it, { kind, text, due: due ? due.toISOString() : null, hasTime: kind === 'thought' ? false : hasTime, repeat, askAt: null, askedKey: null });
    const dv = $('#eDur').value; it.dur = dv === '' ? null : +dv; it.place = $('#ePlace').value.trim() || null;
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
async function setAssign(it, g, p) {
  const before = it.forU;
  it.group_id = g; it.forP = p === 'any' ? 'any' : (p && p !== S.myP ? p : null);
  it.forU = it.forP && it.forP !== 'any' ? person(it.forP)?.uid || null : null;
  it.private = !g; it.askedKey = null;
  if (it.kind === 'thought' && it.forP) it.kind = 'task';
  await save(it); renderAll(); scanConflicts();
  toast(`📎 ${assignLabel(it)}`);
  if (it.forU && it.forU !== S.uid && it.forU !== before)
    await queueNotify(it.forU, 'msg', `📎 ${nameIn(S.myP, g)} שייך/ה לך משימה`, `${it.text}${it.due ? ' · ' + whenLabel(it) : ''}`, it.id);
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
    $('#pickCount').textContent = `${sel.length} מתוך 3`;
  };
  sheet(`<h3>⭐ 3 החשובים של היום</h3><p class="note" style="margin-bottom:10px">בחר עד 3 דברים שחייבים לקרות היום. <b id="pickCount"></b></p>
    <div id="pickList"></div>
    <label>או להוסיף משימה חדשה להיום</label><div style="display:flex;gap:8px"><input id="pickNew" placeholder="למשל: לשלוח הצעת מחיר"><button class="round mic" id="pickAdd" style="width:46px;height:46px;font-size:18px">＋</button></div>
    <button class="btn pri" id="pickSave" style="margin-top:16px">💾 שמור</button>`);
  draw();
  $('#pickList').onclick = e => {
    const id = e.target.closest('.pick')?.dataset.id; if (!id) return;
    if (sel.includes(id)) sel = sel.filter(x => x !== id);
    else if (sel.length >= 3) return toast('אפשר עד 3. הורד אחד קודם', true);
    else sel.push(id);
    draw();
  };
  $('#pickAdd').onclick = async () => {
    const text = $('#pickNew').value.trim(); if (!text) return;
    if (sel.length >= 3) return toast('אפשר עד 3. הורד אחד קודם', true);
    const it = { id: db.newId(), kind: 'task', text, due: sod(new Date()).toISOString(), hasTime: false, repeat: null, status: 'open', created: new Date().toISOString() };
    S.items.push(it); await save(it); await addLog(it, 'created');
    all.unshift(it); sel.push(it.id); $('#pickNew').value = ''; draw();
  };
  $('#pickSave').onclick = async () => {
    if (sel.length > 3) return toast('אפשר עד 3', true);
    S.top3 = { date: today(), ids: sel }; await db.setKV('top3', S.top3); closeSheet(); renderAll(); toast('⭐ נשמר');
  };
}

// ---------- ניווט ותצוגה ----------
function showView(v) {
  if (v === 'settings') { renderProfile(); drawPush(); drawLockCard(); drawMonthly(); drawCalCard(); }
  document.querySelectorAll('nav button[data-v]').forEach(x => x.classList.toggle('on', x.dataset.v === (v === 'thoughts' ? 'tasks' : v)));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + v));
  $('#composer').style.display = v === 'chat' ? 'flex' : 'none';
  if (v === 'chat') { renderChat(); $('#main').scrollTop = $('#main').scrollHeight; } else $('#main').scrollTop = 0;
  if (v === 'cal') { CAL.jump = true; renderCal(true); }
}
document.querySelectorAll('.tabs2').forEach(t => t.onclick = e => { const b = e.target.closest('[data-v]'); if (b) showView(b.dataset.v); });
document.querySelectorAll('nav button[data-v]').forEach(b => b.onclick = () => showView(b.dataset.v));
$('#todayBtn').onclick = () => { showView('chat'); send('מה יש לי היום?'); };
$('#t3edit').onclick = () => openPicker();

function renderChat() {
  $('#chat').innerHTML = ''; lastDay = null;
  S.msgs.forEach(m => appendMsg(m, false));
}
function renderAll() {
  const n = new Date();
  $('#hdate').textContent = `יום ${DAYS[n.getDay()]}, ${n.getDate()}.${n.getMonth() + 1} · ${hebDate(n)}`;
  renderTop3(); renderTasks(); renderThoughts(); renderRes(); renderCal();
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
$('#recStop').onclick = () => recStop(false);
$('#recCancel').onclick = () => { recStop(true); toast('🗑️ ההקלטה בוטלה'); };

const CHIPS = ['מה יש לי היום?', 'מה יש מחר?', 'סיכום', 'עזרה'];
$('#chips').innerHTML = CHIPS.map(c => `<button class="chip">${c}</button>`).join('');
$('#chips').onclick = e => { const c = e.target.closest('.chip'); if (c) send(c.textContent); };

// ---------- דברים משותפים (רכב וכו') ----------
function renderRes() {
  const custom = S.resources.filter(r => !C.DEFAULT_RES.some(d => d.id === r.id));
  $('#resList').innerHTML = S.resources.map(r => `<span class="chip" style="display:inline-block;margin:4px 0 0 6px">${r.e} ${esc(r.n)}${custom.includes(r) ? ` <b data-del="${r.id}" style="cursor:pointer">✕</b>` : ''}</span>`).join('');
}
$('#resAdd').onclick = async () => {
  const n = $('#resNew').value.trim(); if (!n) return;
  const bare = n.replace(/^ה/, '');
  const custom = (await db.getKV('resources', [])).concat({ id: db.newId(), e: '🔑', n, words: [...new Set([n, bare, 'ה' + bare])] });
  await db.setKV('resources', custom); S.resources = C.DEFAULT_RES.concat(custom); $('#resNew').value = ''; renderRes(); toast('נוסף ✓');
  sync.saveRes(custom).catch(() => {});
};
$('#resList').onclick = async e => {
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
$('#setCity').onchange = () => { const c = Z.cityOf($('#setCity').value); $('#setCandle').value = c[3]; saveSettings(); };
$('#setCandle').onchange = saveSettings; $('#setMelody').onchange = () => { Z.play($('#setMelody').value); saveSettings(); };
$('#setShAlerts').onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; b.classList.toggle('on'); saveSettings(); };
$('#testMelody').onclick = () => Z.play($('#setMelody').value);
$('#setMorning').onchange = saveSettings; $('#setEvening').onchange = saveSettings;
$('#backupBtn').onclick = async () => {
  const data = await db.exportAll();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = `zman-bekef-backup-${today()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('💾 הגיבוי נשמר');
};
$('#restoreBtn').onclick = () => $('#restoreFile').click();
$('#restoreFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { const items = await db.importAll(JSON.parse(await f.text())); await sync.queueMany(items); await load(); toast('📂 השחזור הצליח'); }
  catch (err) { toast(err.message || 'הקובץ לא תקין', true); }
  e.target.value = '';
};
$('#clearChatBtn').onclick = async e => {
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
  let hidden = false; try { hidden = localStorage.getItem('zman-install-hide') === '1'; } catch { /* */ }
  if (isStandalone() || hidden || !location.protocol.startsWith('https')) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="inst"><div class="em">📲</div><p><b>להתקין כאפליקציה?</b><br>אייקון במסך הבית + התראות</p>
    <button class="act pri" id="instGo">התקנה</button><button class="chip" id="instX" aria-label="סגירה">✕</button></div>`;
  $('#instGo').onclick = openInstallSheet;
  $('#instX').onclick = () => { try { localStorage.setItem('zman-install-hide', '1'); } catch { /* */ } drawInstallBanner(); };
}
$('#installBtn').onclick = openInstallSheet;
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
  $('#lockBio').textContent = isIOS() ? '👆 לחיצה כאן — ונפתח עם Face ID' : '👆 פתיחה בטביעת אצבע';
  $('#lock').classList.add('on');
  if (st.cred && !isIOS()) tryBio(true);
}
$('#lock').addEventListener('click', e => { if (e.target.closest('#lockPad') || e.target.closest('#lockBio')) return; if (lock.settings()?.cred) tryBio(false); });
function unlockNow() { $('#lock').classList.remove('on'); fails = 0; }
async function tryBio(auto) {
  try { if (await lock.bioUnlock()) unlockNow(); }
  catch (e) { if (!auto && e.name !== 'NotAllowedError') $('#lockErr').textContent = 'הזיהוי לא הצליח — אפשר להקליד קוד'; }
}
function drawDots() { document.querySelectorAll('#lockDots i').forEach((d, i) => d.classList.toggle('f', i < pinBuf.length)); }
$('#lockPad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map(k => k ? `<button data-k="${k}" aria-label="${k === '⌫' ? 'מחיקה' : k}">${k}</button>` : '<span></span>').join('');
$('#lockPad').addEventListener('click', async e => {
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
$('#lockBio').onclick = () => tryBio(false);
// שכחתי את קוד הנעילה → פותחים עם הסיסמה של החשבון, והנעילה מתבטלת
$('#lockForgot').onclick = () => {
  if (!sync.user()) { $('#lockErr').textContent = 'בלי חשבון אי אפשר לשחזר. אפשר למחוק את האפליקציה ולהתקין מחדש (מה שבענן חוזר)'; return; }
  $('#lockRec').hidden = false; $('#lockForgot').hidden = true; $('#lockPad').hidden = true; $('#lockDots').hidden = true; $('#lockRecPass').focus();
};
$('#lockRecGo').onclick = async () => {
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
        ${bio ? '<label class="set-row" style="cursor:pointer"><span>גם טביעת אצבע / Face ID</span><input type="checkbox" id="lkBio" checked></label>' : ''}
        <div id="lkErr" style="color:#FB7185;font-size:13px;min-height:18px"></div><button class="btn pri" id="lkSave">הפעלה</button>`;
      el.querySelectorAll('input').forEach(i => i.oninput = () => $('#lkErr').textContent = '');
      $('#lkSave').onclick = async () => {
        const a = $('#lk1').value, b = $('#lk2').value;
        if (!/^\d{4}$/.test(a)) return $('#lkErr').textContent = 'הקוד צריך להיות 4 ספרות';
        if (a !== b) return $('#lkErr').textContent = 'הקודים לא זהים';
        try { await lock.enable(a, !!$('#lkBio')?.checked, 5); drawLockCard(); toast('🔒 הנעילה הופעלה — תינעל אחרי 5 דקות שהאפליקציה סגורה'); }
        catch (e) { if (e.name === 'NotAllowedError') { await lock.enable(a, false, 5); drawLockCard(); toast('🔒 הנעילה הופעלה עם קוד בלבד'); } else $('#lkErr').textContent = 'לא הצלחתי להפעיל טביעת אצבע. נסה בלי'; }
      };
    };
    return;
  }
  el.innerHTML = `<h4>🔒 הנעילה פעילה <small>${st.cred ? '👆 + קוד' : 'קוד בלבד'}</small></h4><p class="note" style="margin-bottom:6px">לנעול כשחוזרים לאפליקציה אחרי:</p>
    <div class="chips" style="padding:0 0 10px;flex-wrap:wrap">${[[0, 'מיד'], [1, 'דקה'], [5, '5 דקות'], [15, 'רבע שעה']].map(([m, l]) => `<button class="chip ${(st.minutes ?? 5) === m ? 'on' : ''}" data-min="${m}">${l}</button>`).join('')}</div>
    <div style="display:flex;gap:8px"><input id="lkOff" class="fam-in" type="password" inputmode="numeric" maxlength="4" placeholder="הקוד — כדי לכבות" style="text-align:center"><button class="act" id="lkOffBtn">כיבוי</button></div>
    <div id="lkErr" style="color:#FB7185;font-size:13px;min-height:18px"></div>`;
  el.querySelectorAll('[data-min]').forEach(b => b.onclick = () => { lock.setMinutes(+b.dataset.min); drawLockCard(); });
  $('#lkOffBtn').onclick = async () => { if (!(await lock.pinOk($('#lkOff').value))) return $('#lkErr').textContent = 'קוד שגוי'; lock.disable(); drawLockCard(); toast('הנעילה כובתה'); };
}
$('#shareAppBtn').onclick = shareApp;
$('#feedbackBtn').onclick = () => openFeedback();
$('#helpBtn').onclick = () => openHelp();
$('#meBtn').onclick = () => showView('settings');
$('#helpBtn2').onclick = () => openHelp();

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
  S.settings = { morning: '07:00', evening: '20:00', city: 'ירושלים', candleMin: 40, shabbatAlerts: [60], melody: 'bells', ...S.settings };
  $('#setMorning').value = S.settings.morning; $('#setEvening').value = S.settings.evening; drawShabbatSettings();
  // השאלה האחרונה שעוד לא נענתה — כדי ש"כן" / "עוד לא" יתייחסו אליה
  const lastQ = [...S.msgs].reverse().find(m => m.role === 'bot' && m.acts?.some(a => a.op === 'done'));
  S.pending = lastQ && !lastQ.used ? lastQ.acts.find(a => a.op === 'done').a[0] : null;
  renderAll(); renderChat();
  $('#main').scrollTop = $('#main').scrollHeight;
}

async function tick() {
  if (S.day !== today()) { S.day = today(); renderAll(); }
  await Z.loadCalendar(S.settings.city, S.settings.candleMin);
  renderZman();
  await shabbatAlerts();
  if (Z.quietAt(Date.now())) return; // 🕯️ מצב שבת/חג: בלי שאלות, סיכומים או התראות
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
  const fromOther = next.doneBy && next.doneBy !== S.myP;
  const wasOpen = local && local.status === 'open' && !(local.repeat && isToday(local.lastDone));
  const nowDone = next.status === 'done' || (next.repeat && isToday(next.lastDone));
  const involvesMe = next.by === S.uid || next.forP === S.myP;
  if (wasOpen && nowDone && fromOther && involvesMe) {
    await bot(person(next.doneBy)?.e || '🎉', 'var(--g3)', `${person(next.doneBy)?.name || 'מישהו מהמשפחה'} סימן/ה ✅`, next.text);
    confetti(60);
  } else if (!local && next.status === 'open' && next.forP === S.myP && next.by !== S.uid) {
    const from = personOfUid(next.by);
    await bot(from?.e || '🙋', 'var(--g6)', `משימה חדשה בשבילך${from ? ' מ' + from.name : ''}`, `${next.text}${next.due ? '\n' + whenLabel(next) : ''}`,
      [{ l: '⭐ לחשובים של היום', op: 'star', a: [next.id] }, { l: '✏️ תקן', op: 'edit', a: [next.id] }]);
    buzz();
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
    try { await sync.joinGroup(joinCode, $('#gNick').value.trim() || pr?.full_name, pr?.emoji); joinHandled = true; confetti(); toast('🎉 הצטרפת לקבוצה!'); history.replaceState(null, '', location.pathname); await afterGate(); }
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
      if (!it.group_id && gid && !it.private && it.status !== 'deleted') it.group_id = gid;
      if (!it.by) it.by = S.uid;
      await db.put('items', it);
      if (it.by === S.uid) await sync.queue(it);
    }
    await db.setKV('migratedGroups', true);
    if (gid) await bot('👨‍👩‍👧', 'var(--g6)', 'עברנו לקבוצות!', `מה שרשמתם עם המשפחה נמצא עכשיו בקבוצה "${groupOf(gid)?.name || 'המשפחה'}".\nאפשר לפתוח עוד קבוצות — שותפים, צוות, חברים — באזור האישי ⚙️`);
  } catch (e) { console.warn('migrate', e); }
}

// ---------- הקבוצות שלי (בהגדרות) ----------
const inviteText = (g, code) => {
  const link = `${location.origin}${location.pathname}guide/?join=${code}`;
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
    const mem = g.members.map(m => `<div class="fam-row"><span style="flex:1;min-width:110px">${m.user_id ? '📱' : '✏️'} ${esc(m.profile?.emoji || m.emoji || '🙂')} <b>${esc(m.nickname)}</b>${m.user_id === S.uid ? ' (אני)' : ''}${m.user_id && m.profile?.full_name && m.profile.full_name !== m.nickname ? ` <span class="note">· ${esc(m.profile.full_name)}</span>` : ''}</span>
      ${g.kind !== 'pair' && admin && m.user_id !== S.uid ? `<button class="chip" data-role="${m.id}" data-to="${m.role === 'admin' ? 'member' : g.kind === 'family' && m.role === 'member' ? 'child' : 'admin'}">${{ admin: '⭐ מנהל', member: '🙂 חבר', child: '🧒 ילד' }[m.role]}</button><button class="chip" data-rm="${m.id}">✕</button>` : `<span class="note">${g.kind === 'pair' ? '' : { admin: '⭐ מנהל', member: '🙂 חבר', child: '🧒 ילד' }[m.role]}</span>`}</div>`).join('');
    return `<div class="grp" data-g="${g.id}">
      <div class="grp-h"><b>${esc(gLabel(g))}</b><span class="note">הכינוי שלי: <b>${esc(me?.nickname || '')}</b></span></div>
      ${mem}
      ${g.kind === 'pair' && g.members.length < 2 ? '<p class="note">⏳ ממתין שיצטרף בקישור ששלחת</p>' : ''}
      ${me && me.role !== 'child' ? (() => { const v = me.cal_share || (['family', 'pair'].includes(g.kind) ? 'all' : 'busy');
        return `<div class="note" style="margin-top:8px">📅 מי ${g.kind === 'pair' ? 'שם' : 'בקבוצה'} רואה את היומן שלי:</div><div class="chips" style="padding:6px 0 0;flex-wrap:wrap">${[['all', '👀 הכל'], ['busy', '⛔ רק "תפוס/ה"'], ['none', '🚫 לא']].map(([k, l]) => `<button class="chip ${v === k ? 'on' : ''}" data-cal="${g.id}" data-cv="${k}" aria-pressed="${v === k}">${l}</button>`).join('')}</div>${v === 'all' ? '<div class="note" style="font-size:11px">מה שסימנת 🔒 פרטי תמיד מופיע אצלם רק כ"תפוס/ה".</div>' : ''}`; })() : ''}
      ${(admin || g.kind === 'pair') && g.code ? `<div class="codes">${g.kind !== 'pair' || g.members.length < 2 ? `<div class="code-box" style="background:rgba(124,58,237,.25);border-color:rgba(196,181,253,.4)"><div class="note">${g.kind === 'family' ? '👨‍👩 קוד להורה' : '🔑 קוד הצטרפות'}</div><div class="code">${g.code}</div><button class="chip" data-copy="${g.code}">📋 העתקה</button> <a class="chip" href="${waHref(inviteText(g, g.code))}" target="_blank" rel="noopener" style="text-decoration:none">💬 וואטסאפ</a></div>` : ''}
        ${g.kind === 'family' && g.child_code ? `<div class="code-box" style="background:rgba(249,115,22,.25);border-color:rgba(253,186,116,.4)"><div class="note">🧒 קוד לילד</div><div class="code">${g.child_code}</div><button class="chip" data-copy="${g.child_code}">📋 העתקה</button> <a class="chip" href="${waHref(inviteText(g, g.child_code))}" target="_blank" rel="noopener" style="text-decoration:none">💬 וואטסאפ</a></div>` : ''}</div>` : ''}
      <div class="chips" style="padding:8px 0 0;flex-wrap:wrap">
        <button class="chip" data-nick="${g.id}">✏️ הכינוי שלי</button>
        ${admin && g.kind !== 'pair' ? `<button class="chip" data-addname="${g.id}">➕ רק שם (בלי טלפון)</button><button class="chip" data-rename="${g.id}">✏️ שם הקבוצה</button>` : ''}
        <button class="chip" data-leave="${me?.id || ''}">🚪 יציאה</button>
        ${g.kind !== 'pair' ? `<button class="chip ${S.settings.defGroup === g.id ? 'on' : ''}" data-def="${g.id}">⭐ ראשית</button>` : ''}
      </div></div>`;
  };
  el.innerHTML = `<h4>👥 הקבוצות שלי<small id="syncState">${navigator.onLine ? 'מסונכרן ✓' : 'ממתין לרשת…'}</small></h4>
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
  el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = '✅ הועתק'; } catch { b.textContent = b.dataset.copy; } });
  el.querySelectorAll('[data-role]').forEach(b => b.onclick = () => run(() => sync.setRole(b.dataset.role, b.dataset.to)));
  el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'להסיר?'; return; } run(() => sync.removeMember(b.dataset.rm)); });
  el.querySelectorAll('[data-leave]').forEach(b => b.onclick = () => { if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'בטוח? לצאת'; return; } run(() => sync.removeMember(b.dataset.leave)); });
  el.querySelectorAll('[data-def]').forEach(b => b.onclick = async () => { S.settings.defGroup = b.dataset.def; await db.setKV('settings', S.settings); renderFamily(); toast('⭐ זו הקבוצה הראשית'); });
  el.querySelectorAll('[data-nick]').forEach(b => b.onclick = () => openNick(b.dataset.nick));
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
      await bot(KINDS[kind][0], 'var(--g6)', `הקבוצה "${name}" נוצרה!`, `קוד הצטרפות: ${g?.code || ''}${g?.child_code ? `\nקוד לילד: ${g.child_code}` : ''}\nשלח/י את הקישור למי שצריך להצטרף 👇`,
        [{ l: '💬 שליחה בוואטסאפ', op: 'shareGroup', a: [gid], pri: true }]);
      showView('chat');
    } catch (x) { toast(x.message, true); }
  };
}
function openJoin() {
  if (!S.uid) return showGate();
  const pr = sync.myProfile();
  sheet(`<h3>🔑 הצטרפות לקבוצה</h3><label>הקוד שקיבלת (6 תווים)</label><input id="jCode" dir="ltr" style="text-transform:uppercase;letter-spacing:3px;text-align:center">
    <label>איך יקראו לך בקבוצה?</label><input id="jNick" value="${esc(pr?.full_name?.split(' ')[0] || '')}">
    <button class="btn pri" id="jGo" style="margin-top:14px">🔑 הצטרפות</button>`);
  $('#jGo').onclick = async () => {
    const c = $('#jCode').value.trim(); if (c.length < 6) return toast('הקוד הוא 6 תווים', true);
    try { const gid = await sync.joinGroup(c, $('#jNick').value.trim() || pr?.full_name, pr?.emoji); closeSheet(); buildPeople(); renderAll(); renderFamily(); confetti(); toast(`🎉 הצטרפת ל"${groupOf(gid)?.name || 'קבוצה'}"`); }
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
  const stat = (n, l) => `<div class="me-stat"><b>${n}</b><span>${l}</span></div>`;
  el.innerHTML = `<h4 style="margin-bottom:10px">👤 האזור האישי</h4><div class="me-top"><button class="me-face" id="pFace" aria-label="שינוי אייקון">${p?.e || '🙋'}</button>
      <div class="me-txt"><b>${esc(p?.name || '')}</b><span dir="ltr">${esc(u.email || '')}</span>
      <span>${gs.length ? gs.map(g => `${gLabel(g)} · "${esc(g.members.find(m => m.user_id === S.uid)?.nickname || '')}"`).join('<br>') : 'עוד לא בשום קבוצה'}</span></div></div>
    <div class="me-stats">${stat('🔥 ' + streak(), 'ימים ברצף')}${stat(doneWeek, 'בוצעו השבוע')}${stat(tasksOpen().length, 'פתוחות שלי')}${stat(openItems().filter(x => x.kind === 'thought' && byMe(x)).length, 'מחשבות')}</div>
    <div class="two" style="margin-top:10px"><button class="btn" id="pEdit" style="margin:0">✏️ שם ואייקון</button><button class="btn danger" id="pOut" style="margin:0">יציאה</button></div>`;
  $('#pEdit').onclick = openEditMe; $('#pFace').onclick = openEditMe;
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
  sheet(`<h3>🙋 השם שלי</h3><p class="note" style="margin-bottom:10px">השם המלא והאייקון — בכל הקבוצות. את הכינוי בכל קבוצה משנים בכרטיס הקבוצה.</p>
    <div style="display:flex;gap:8px"><button class="round" id="meFace" style="background:var(--card2);border:1px solid var(--line);width:48px;height:48px">${FACES[face]}</button>
    <input id="meName" class="fam-in" value="${esc(p.name)}"></div><button class="btn pri" id="meSave" style="margin-top:14px">💾 שמור</button>`);
  $('#meFace').onclick = e => { face = (face + 1) % FACES.length; e.target.textContent = FACES[face]; };
  $('#meSave').onclick = async () => {
    const name = $('#meName').value.trim(); if (!name) return toast('צריך שם', true);
    try { await sync.saveProfile(name, FACES[face]); await sync.loadGroups(); } catch (x) { return toast(x.message, true); }
    closeSheet(); buildPeople(); renderAll(); renderFamily(); renderMe(); toast('✅ נשמר');
  };
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { document.title = 'זמן בכיף'; tick(); } });
}

(async () => {
  await load();
  await sync.start({
    onItem: onRemoteItem,
    onRemote: () => { clearTimeout(S._rr); S._rr = setTimeout(() => { renderAll(); renderFamily(); if (started) scanConflicts(); }, 250); },
    onGroups: () => { buildPeople(); renderAll(); renderFamily(); renderMe(); },
    onBusy: b => { S.busy = b; },
    onRes: async r => { await db.setKV('resources', r); S.resources = C.DEFAULT_RES.concat(r); renderRes(); },
    onStatus: st => { const el = $('#syncState'); if (el) el.textContent = st === 'ok' ? 'מסונכרן ✓' : 'ממתין לרשת…'; },
  });
  S.items = await db.all('items');
  if (await showGate()) {
    buildPeople(); renderAll(); renderFamily(); boot();
    sync.whenReady().then(async () => { await migrateToGroups(); buildPeople(); renderAll(); renderFamily(); renderMe(); });
  }
  if (RECOVERY && sync.user()) openNewPassword();
  try { navigator.storage?.persist?.(); } catch { /* */ } // שהדפדפן לא ימחק את הנתונים כשחסר מקום
})();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(r => r.update?.()).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) toast('✨ יש גרסה חדשה', false, { l: '🔄 לעדכן', run: () => location.reload() }); });
}

// לבדיקות מהדפדפן
window.__zman = { CAL, renderCal, showView, buildPeople, openAssign, renderFamily, renderProfile, S, parse, send, forWhom, sync, OPS, scanConflicts, openConflict, allConflicts, Z, tick, onRemoteItem, inviteOf, desiredSchedule, welcomeMe };
