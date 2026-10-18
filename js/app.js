import * as db from './db.js';
import { parse, matchScore, whenLabel, nextOccurrence, sod, addDays, ymd, hm, DAYS } from './parse.js';
import { hebDate } from './hebdate.js';
import * as sync from './sync.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => ymd(new Date());
const isToday = iso => iso && ymd(new Date(iso)) === today();

const S = { items: [], msgs: [], log: [], top3: null, settings: { morning: '07:00', evening: '20:00' }, pending: null, day: today(),
  people: [], uid: null, myP: null, who: 'all' };
const item = id => S.items.find(x => x.id === id && x.status !== 'deleted');
const openItems = () => S.items.filter(x => x.status === 'open');
const allTasksOpen = () => openItems().filter(x => x.kind !== 'thought');

// ---------- בני הבית ----------
const FACES = ['🧔', '👩', '👦', '👧', '👴', '👵', '🧑', '👶'];
const person = pid => S.people.find(p => p.id === pid);
const personOfUid = uid => uid && S.people.find(p => p.uid === uid);
const family = () => S.people.length > 1;
// מי אחראי על המשימה: מי שהיא בשבילו, ואם אין — מי שרשם
const ownerP = it => it.forP || personOfUid(it.by)?.id || null;
const byMe = it => !it.by || it.by === S.uid;
// למי שאין חשבון (למשל ילד קטן) — השאלה "עשית?" חוזרת למי שרשם
const isMine = it => !S.uid || (it.forP ? it.forP === S.myP || (!person(it.forP)?.uid && byMe(it)) : byMe(it));
const tasksOpen = () => allTasksOpen().filter(isMine);
const who = pid => { const p = person(pid); return p ? `${p.e} ${p.name}` : ''; };

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
  d.innerHTML = `<div class="in"><div class="ic" style="background:${m.bg || 'var(--card2)'}">${m.ic || '🤖'}</div><div><b>${esc(m.title)}</b>${m.sub ? `<div class="sub">${esc(m.sub)}</div>` : ''}</div></div>`;
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
const KEEP = new Set(['edit', 'star', 'pickTop3', 'goto']);
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
    it.status = 'deleted'; await save(it); await addLog(it, 'deleted');
    if (S.top3) S.top3.ids = S.top3.ids.filter(x => x !== id), await db.setKV('top3', S.top3);
    renderAll(); toast('🗑️ נמחק');
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
};

// ---------- טיפול במה שכתבת ----------
async function send(text, voice) {
  text = text.trim(); if (!text) return;
  await me(text, voice);
  await think();
  const f = forWhom(text);
  const p = parse(f.text);
  p.forP = f.forP; p.private = f.private;

  if (p.intent === 'help') return help();
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

// "תזכיר לרחל מחר ב-5 לקנות חלב" / "רחל: לקנות חלב" / "משימה לרחל ..." / "פרטי: ..."
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function forWhom(text) {
  let t = text.trim(), forP = null, priv = false, m;
  if ((m = t.match(/^(?:פרטי|🔒)\s*[:\-–]?\s*/))) { priv = true; t = t.slice(m[0].length); }
  if (/\(פרטי\)|\s🔒/.test(t)) { priv = true; t = t.replace(/\s*\(פרטי\)|\s*🔒/g, ''); }
  const names = S.people.filter(p => p.name).sort((a, b) => b.name.length - a.name.length);
  for (const p of names) {
    const n = reEsc(p.name), E = '(?=[\\s:,]|$)';
    const self = p.id === S.myP;
    if ((m = t.match(new RegExp(`^(תזכיר|תזכירי|להזכיר|תגיד|תגידי|תבקש|תבקשי)\\s+(?:מ|ל|את\\s+)${n}${E}\\s*[:,]?\\s*`)))) {
      t = 'תזכיר לי ' + t.slice(m[0].length); forP = self ? null : p.id; break;
    }
    if ((m = t.match(new RegExp(`^(משימה|תזכורת)\\s+(?:ל|בשביל\\s+)${n}${E}\\s*[:,]?\\s*`)))) {
      t = 'משימה: ' + t.slice(m[0].length); forP = self ? null : p.id; break;
    }
    if ((m = t.match(new RegExp(`^ל?${n}\\s*:\\s*`)))) { t = t.slice(m[0].length); forP = self ? null : p.id; break; }
    if ((m = t.match(new RegExp(`(^|\\s)בשביל\\s+${n}${E}`)))) { t = t.replace(m[0], ' ').trim(); forP = self ? null : p.id; break; }
  }
  return { text: t, forP, private: priv };
}

async function createItem(p, raw) {
  const fp = p.forP ? person(p.forP) : null;
  const it = {
    id: db.newId(), kind: p.kind === 'thought' && fp ? 'task' : p.kind, text: p.text || raw, due: p.due ? p.due.toISOString() : null, hasTime: !!p.hasTime,
    repeat: p.repeat, status: 'open', created: new Date().toISOString(), askAt: null, askedKey: null,
    forP: fp?.id || null, forU: fp?.uid || null, private: !!p.private,
  };
  S.items.push(it); await save(it); await addLog(it, 'created'); renderAll();
  const edit = { l: '✏️ תקן', op: 'edit', a: [it.id] }, undo = { l: '↩️ בטל', op: 'undo', a: [it.id] };
  if (fp) {
    const sub = `${it.due ? whenLabel(it) : 'בלי תאריך'}\n${fp.uid ? `השאלה "עשית?" תגיע לטלפון של ${fp.name}, ואעדכן אותך כשיסיים/תסיים 🎉` : `ל${fp.name} עוד אין חשבון באפליקציה, אז אשאל אותך`}`;
    return bot(fp.e || '🙋', 'var(--g6)', `בשביל ${fp.name}: ${it.text}`, sub, [edit, undo]);
  }
  if (it.private) toast('🔒 פרטי — רק אתה רואה את זה');

  if (it.kind === 'thought') {
    return bot(KIND.thought.ic, KIND.thought.bg, 'נשמר בתיבת המחשבות', `${it.text}\nאין לזה תאריך, וזה בסדר. אפשר לטפל בזה מתי שתרצה.`, [
      { l: '📅 תן תאריך', op: 'edit', a: [it.id, 'date'] }, { l: '⭐ להיום', op: 'star', a: [it.id] },
      { l: '📋 זו משימה', op: 'toTask', a: [it.id] }, undo]);
  }
  if (it.kind === 'meeting') {
    if (!it.due) return bot(KIND.meeting.ic, KIND.meeting.bg, it.text, 'מתי הפגישה? כתוב לי יום ושעה, או בחר כאן', [{ l: '📅 לבחור מועד', op: 'edit', a: [it.id, 'date'], pri: true }, edit, undo]);
    return bot(KIND.meeting.ic, KIND.meeting.bg, it.text, `👥 פגישה · ${whenLabel(it)}${it.hasTime ? '\nאזכיר לך חצי שעה לפני' : ''}`, [edit, undo]);
  }
  if (p.needsWhen) {
    return bot(KIND.task.ic, KIND.task.bg, it.text, 'מתי להזכיר לך?', [
      { l: 'בעוד שעה', op: 'when', a: [it.id, 'hour'] }, { l: 'הערב', op: 'when', a: [it.id, 'evening'] },
      { l: 'מחר בבוקר', op: 'when', a: [it.id, 'tomorrowMorning'] }, { l: '📅 תאריך אחר', op: 'edit', a: [it.id, 'date'] },
      { l: 'בלי תאריך', op: 'when', a: [it.id, 'none'] }]);
  }
  const k = it.repeat ? KIND.rep : KIND.task;
  const how = !it.due ? 'בלי תאריך · נמצא במסך המשימות'
    : it.hasTime ? `${whenLabel(it)}\nכשיגיע הזמן אשאל אותך אם עשית את זה`
    : `${whenLabel(it)}\nאשאל עליו בסיכום הערב`;
  const acts = [edit, undo];
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
function buzz() { try { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(80); } catch { /* */ } if (document.hidden) document.title = '🔔 זמן בכיף'; }

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

function help() {
  return bot('💡', 'var(--g2)', 'מה אפשר לכתוב לי', [
    '📌 תזכיר לי מחר ב-10 להתקשר לבנק', '🔁 כל יום חמישי ב-9 לשלם לגננת', '👥 פגישה עם יוסי ביום שלישי ב-4',
    '💭 רעיון: לסדר את המחסן', '✅ סיימתי לשלוח הצעת מחיר', '📋 מה יש לי היום? / מחר? / השבוע?', '🌙 סיכום',
  ].join('\n'));
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
  const owner = family() ? who(ownerP(it)) : '';
  const meta = [it.private ? '🔒' : '', owner, it.kind === 'meeting' ? '👥 פגישה' : '', whenLabel(it)].filter(Boolean).join(' · ');
  return `<div class="row${d}" data-id="${it.id}"><button class="cb" data-op="check">${d ? '✓' : ''}</button>
    <div class="nm" data-op="edit">${esc(it.text)}${meta ? `<small class="${late ? 'late' : ''}">${esc(meta)}</small>` : ''}</div>
    ${it.status === 'open' && it.kind === 'task' && isMine(it) ? `<button class="star${star ? ' on' : ''}" data-op="star" aria-label="לחשובים של היום">⭐</button>` : ''}</div>`;
}
function renderTasks() {
  const now = new Date(), t0 = sod(now), t1 = addDays(t0, 1), t2 = addDays(t0, 2);
  const pass = x => S.who === 'all' || ownerP(x) === S.who || (S.who === S.myP && isMine(x));
  const open = rankForToday(allTasksOpen().filter(pass));
  const isLate = x => x.due && (x.hasTime ? new Date(x.due) < now : new Date(x.due) < t0);
  $('#whoFilter').hidden = !family();
  if (family()) $('#whoFilter').innerHTML = `<button class="chip ${S.who === 'all' ? 'on' : ''}" data-w="all">כולם</button>` +
    S.people.map(p => `<button class="chip ${S.who === p.id ? 'on' : ''}" data-w="${p.id}">${p.e} ${esc(p.id === S.myP ? 'שלי' : p.name)}</button>`).join('');
  const groups = [
    ['⚠️ באיחור', open.filter(isLate)],
    ['☀️ היום', open.filter(x => !isLate(x) && x.due && new Date(x.due) < t1 && !x.repeat)],
    ['🌅 מחר', open.filter(x => x.due && new Date(x.due) >= t1 && new Date(x.due) < t2 && !x.repeat)],
    ['📆 בהמשך', open.filter(x => x.due && new Date(x.due) >= t2 && !x.repeat)],
    ['🔁 קבועות', open.filter(x => x.repeat && !isLate(x))],
    ['📝 בלי תאריך', open.filter(x => !x.due)],
    ['✅ בוצעו היום', S.items.filter(x => pass(x) && x.status !== 'deleted' && x.kind !== 'thought' && ((x.status === 'done' && isToday(x.doneAt)) || (x.repeat && isToday(x.lastDone))))],
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
});

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
function closeSheet() { $('#sheetBg').classList.remove('on'); }
$('#sheetBg').addEventListener('click', e => { if (e.target.id === 'sheetBg') closeSheet(); });

function openEdit(id, focus, forceKind) {
  const it = item(id); if (!it) return toast('המשימה הזאת כבר לא קיימת', true);
  let kind = forceKind || it.kind;
  const d = it.due ? new Date(it.due) : null;
  const rep = it.repeat?.type || '';
  let forP = ownerP(it) || S.myP, priv = !!it.private;
  const mineToLock = !it.by || it.by === S.uid;
  sheet(`<h3>✏️ עריכה</h3>
    <label>סוג</label><div class="seg" id="eKind">${[['task', '📌 משימה'], ['meeting', '👥 פגישה'], ['thought', '💭 מחשבה']].map(([k, l]) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${l}</button>`).join('')}</div>
    <label>מה</label><input id="eText" value="${esc(it.text)}">
    <div id="eWhen"><div class="two"><div><label>תאריך</label><input type="date" id="eDate" value="${d ? ymd(d) : ''}"></div>
    <div><label>שעה (לא חובה)</label><input type="time" id="eTime" value="${d && it.hasTime ? hm(d) : ''}"></div></div>
    <label>חוזר</label><select id="eRep"><option value="">לא חוזר</option><option value="daily">כל יום</option><option value="weekly">כל שבוע</option><option value="monthly">כל חודש</option></select></div>
    ${family() ? `<label>בשביל מי</label><div class="seg" id="eFor">${S.people.map(p => `<button data-p="${p.id}" class="${p.id === forP ? 'on' : ''}">${p.e} ${esc(p.id === S.myP ? 'אני' : p.name)}</button>`).join('')}</div>` : ''}
    ${S.uid && mineToLock ? `<label>מי רואה</label><div class="seg" id="ePriv"><button data-v="0" class="${it.private ? '' : 'on'}">👨‍👩‍👧 כל המשפחה</button><button data-v="1" class="${it.private ? 'on' : ''}">🔒 רק אני</button></div>` : ''}
    <button class="btn pri" id="eSave" style="margin-top:16px">💾 שמור</button>
    <div class="two"><button class="btn" id="eCancel">ביטול</button><button class="btn danger" id="eDel">🗑️ מחק</button></div>`);
  $('#eRep').value = rep;
  const syncKind = () => { $('#eWhen').style.display = kind === 'thought' ? 'none' : ''; };
  syncKind();
  $('#eKind').onclick = e => { const b = e.target.closest('button'); if (!b) return; kind = b.dataset.k; [...$('#eKind').children].forEach(x => x.classList.toggle('on', x === b)); syncKind(); };
  if ($('#eFor')) $('#eFor').onclick = e => { const b = e.target.closest('button'); if (!b) return; forP = b.dataset.p; [...$('#eFor').children].forEach(x => x.classList.toggle('on', x === b)); };
  if ($('#ePriv')) $('#ePriv').onclick = e => { const b = e.target.closest('button'); if (!b) return; priv = b.dataset.v === '1'; [...$('#ePriv').children].forEach(x => x.classList.toggle('on', x === b)); };
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
    if (family()) {
      const fp = forP && forP !== S.myP ? person(forP) : null;
      const creatorP = personOfUid(it.by)?.id || S.myP;
      it.forP = fp && fp.id !== creatorP ? fp.id : (forP === S.myP && creatorP !== S.myP ? S.myP : null);
      it.forU = it.forP ? person(it.forP)?.uid || null : null;
    }
    if (mineToLock) it.private = priv;
    await save(it); closeSheet(); renderAll();
    toast('✏️ נשמר');
    if (S.pending === id) S.pending = null;
  };
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
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x.dataset.v === v));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + v));
  $('#composer').style.display = v === 'chat' ? 'flex' : 'none';
  if (v === 'chat') { renderChat(); $('#main').scrollTop = $('#main').scrollHeight; } else $('#main').scrollTop = 0;
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showView(b.dataset.v));
$('#todayBtn').onclick = () => { showView('chat'); send('מה יש לי היום?'); };
$('#t3edit').onclick = () => openPicker();

function renderChat() {
  $('#chat').innerHTML = ''; lastDay = null;
  S.msgs.forEach(m => appendMsg(m, false));
}
function renderAll() {
  const n = new Date();
  $('#hdate').textContent = `יום ${DAYS[n.getDay()]}, ${n.getDate()}.${n.getMonth() + 1} · ${hebDate(n)}`;
  renderTop3(); renderTasks(); renderThoughts();
  const s = streak(); $('#streak').textContent = s >= 2 ? `🔥 ${s} ימים ברצף` : s === 1 ? '🔥 יום 1' : '';
}

function toast(t, err) {
  const el = $('#toast'); el.textContent = t; el.classList.toggle('err', !!err); el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2400);
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
let rec = null;
$('#mic').onclick = () => {
  if (inp.value.trim()) { const v = inp.value; inp.value = ''; updateMic(); send(v); return; }
  if (rec) { rec.stop(); return; }
  if (!SR) { toast('🎤 הדפדפן הזה לא תומך בהקלטה. אפשר ללחוץ על המיקרופון במקלדת של הטלפון'); inp.focus(); return; }
  rec = new SR(); rec.lang = 'he-IL'; rec.interimResults = true; rec.continuous = false;
  let finalText = '';
  $('#mic').classList.add('rec'); inp.placeholder = '🎤 מקשיב… דבר עכשיו';
  rec.onresult = e => {
    let txt = ''; for (const r of e.results) txt += r[0].transcript;
    inp.value = txt; if (e.results[e.results.length - 1].isFinal) finalText = txt;
  };
  rec.onerror = e => { if (e.error === 'not-allowed') toast('🎤 צריך לאשר גישה למיקרופון', true); else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('🎤 לא הצלחתי לשמוע, נסה שוב', true); };
  rec.onend = () => {
    $('#mic').classList.remove('rec'); inp.placeholder = 'כתוב או אמור… למשל: תזכיר לי מחר ב-10'; rec = null;
    const t = (finalText || inp.value).trim(); inp.value = ''; updateMic();
    if (t) send(t, true);
  };
  rec.start();
};

const CHIPS = ['מה יש לי היום?', 'מה יש מחר?', 'סיכום', 'עזרה'];
$('#chips').innerHTML = CHIPS.map(c => `<button class="chip">${c}</button>`).join('');
$('#chips').onclick = e => { const c = e.target.closest('.chip'); if (c) send(c.textContent); };

// ---------- הגדרות וגיבוי ----------
async function saveSettings() { S.settings = { morning: $('#setMorning').value || '07:00', evening: $('#setEvening').value || '20:00' }; await db.setKV('settings', S.settings); toast('נשמר ✓'); }
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
  try { await db.importAll(JSON.parse(await f.text())); await load(); toast('📂 השחזור הצליח'); }
  catch (err) { toast(err.message || 'הקובץ לא תקין', true); }
  e.target.value = '';
};
$('#clearChatBtn').onclick = async () => {
  if (!confirm('למחוק את כל ההודעות בשיחה? המשימות והמחשבות נשארות.')) return;
  await db.clear('msgs'); S.msgs = []; renderChat(); toast('🧹 השיחה נוקתה');
};
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
$('#installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); installEvt = null; $('#installBtn').hidden = true; };

// ---------- הפעלה ----------
async function load() {
  S.items = await db.all('items');
  S.log = await db.all('log');
  S.msgs = (await db.all('msgs')).sort((a, b) => a.ts.localeCompare(b.ts));
  if (S.msgs.length > 300) { for (const m of S.msgs.slice(0, S.msgs.length - 300)) await db.del('msgs', m.id); S.msgs = S.msgs.slice(-300); }
  S.top3 = await db.getKV('top3', null);
  S.settings = await db.getKV('settings', S.settings);
  $('#setMorning').value = S.settings.morning; $('#setEvening').value = S.settings.evening;
  // השאלה האחרונה שעוד לא נענתה — כדי ש"כן" / "עוד לא" יתייחסו אליה
  const lastQ = [...S.msgs].reverse().find(m => m.role === 'bot' && m.acts?.some(a => a.op === 'done'));
  S.pending = lastQ && !lastQ.used ? lastQ.acts.find(a => a.op === 'done').a[0] : null;
  renderAll(); renderChat();
  $('#main').scrollTop = $('#main').scrollHeight;
}

async function tick() {
  if (S.day !== today()) { S.day = today(); renderAll(); }
  const m = nowMin();
  if (m >= minutes(S.settings.morning) && m < minutes(S.settings.evening)) await morning();
  if (m >= minutes(S.settings.evening)) await evening();
  await followUps();
  renderTasks();
}

// ---------- משפחה: שינויים שהגיעו מטלפון אחר ----------
async function onRemoteItem(local, next, live) {
  const i = S.items.findIndex(x => x.id === next.id);
  if (i >= 0) S.items[i] = next; else S.items.push(next);
  if (!live || !S.uid) return;
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

// ---------- מסך פתיחה: כניסה ← משפחה ← שם ----------
const joinCode = (new URLSearchParams(location.search).get('join') || '').toUpperCase();
async function gateStep() {
  if (!sync.user()) return 'auth';
  if (!sync.household()) return 'family';
  S.people = await db.getKV('people', []);
  const mine = personOfUid(S.uid);
  if (!mine) return 'name';
  S.myP = mine.id;
  return null;
}
async function showGate() {
  S.uid = sync.user()?.id || null;
  const step = await gateStep();
  const g = $('#gate'), body = $('#gateBody');
  if (!step) { g.classList.remove('on'); renderAll(); renderFamily(); return true; }
  g.classList.add('on');
  const err = m => { body.querySelector('.err').textContent = m; };
  const busy = (b, on) => { b.disabled = on; b.style.opacity = on ? .6 : 1; };

  if (step === 'auth') {
    body.innerHTML = `<div class="g-logo">⏰</div><h2>ברוכים הבאים ל"זמן בכיף"</h2>
      <p class="note">${joinCode ? '👋 הוזמנת למשפחה! קודם נרשמים. ' : ''}אותו מייל ואותה סיסמה כמו באפליקציית <b>כסף בכיף</b>. מי שכבר רשום שם, פשוט נכנס.</p>
      <input id="gEmail" type="email" autocomplete="email" placeholder="מייל" dir="ltr">
      <input id="gPass" type="password" autocomplete="current-password" placeholder="סיסמה (לפחות 6 תווים)" dir="ltr">
      <div class="err"></div>
      <button class="btn pri" id="gIn">כניסה</button>
      <button class="btn" id="gUp">אין לי חשבון — הרשמה</button>`;
    const go = async (fn, b) => {
      const e = $('#gEmail').value.trim(), p = $('#gPass').value;
      if (!/^\S+@\S+\.\S+$/.test(e)) return err('צריך מייל תקין');
      if (p.length < 6) return err('הסיסמה צריכה להיות לפחות 6 תווים');
      busy(b, true);
      try { await fn(e, p); try { await sync.loadHousehold(); } catch { /* */ } fresh = true; await afterGate(); }
      catch (x) { err(x.message); busy(b, false); }
    };
    $('#gIn').onclick = e => go(sync.signIn, e.target);
    $('#gUp').onclick = e => go(sync.signUp, e.target);
    body.querySelectorAll('input').forEach(i => i.oninput = () => err(''));
    return false;
  }
  if (step === 'family') {
    body.innerHTML = `<h2>👨‍👩‍👧 המשפחה</h2>
      <p class="note">מי שמתחיל פותח משפחה ושולח קוד לבני הבית. מי שקיבל קוד מצטרף איתו.</p>
      ${joinCode ? '' : `<input id="gName" placeholder="שם המשפחה, למשל: משפחת כהן"><button class="btn pri" id="gNew">פתיחת משפחה חדשה</button><div class="or">או</div>`}
      <input id="gCode" placeholder="קוד הצטרפות (6 תווים)" value="${esc(joinCode)}" dir="ltr" style="text-transform:uppercase;letter-spacing:3px;text-align:center">
      <button class="btn ${joinCode ? 'pri' : ''}" id="gJoin">🔑 הצטרפות עם קוד</button>
      <div class="err"></div>
      <button class="link" id="gOut">יציאה מהחשבון</button>`;
    const run = async (fn, b) => { busy(b, true); try { await fn(); fresh = true; confetti(); await afterGate(); } catch (x) { err(x.message); busy(b, false); } };
    $('#gNew')?.addEventListener('click', e => run(() => sync.createHousehold($('#gName').value.trim()), e.target));
    $('#gJoin').onclick = e => { const c = $('#gCode').value.trim(); if (c.length < 6) return err('הקוד הוא 6 תווים'); run(() => sync.joinHousehold(c), e.target); };
    $('#gOut').onclick = signOut;
    return false;
  }
  // step === 'name'
  S.people = await sync.loadPeople();
  if (personOfUid(S.uid)) return showGate();
  const free = S.people.filter(p => !p.uid);
  let face = 0;
  body.innerHTML = `<h2>🙋 איך קוראים לך?</h2>
    <p class="note">כל מה שתרשום יופיע עם השם שלך, ואפשר יהיה לתת לך משימות.</p>
    ${free.length ? `<p class="note">אולי זה אתה?</p><div class="chips" style="flex-wrap:wrap;padding:0 0 12px">${free.map(p => `<button class="chip" data-claim="${p.id}">אני ${p.e} ${esc(p.name)}</button>`).join('')}</div>` : ''}
    <div style="display:flex;gap:8px"><button class="round" id="gFace" style="background:var(--card2);border:1px solid var(--line);width:48px;height:48px">${FACES[0]}</button>
    <input id="gMe" placeholder="השם שלך" style="flex:1"></div>
    <div class="err"></div>
    <button class="btn pri" id="gSave">המשך</button>
    <button class="link" id="gOut">יציאה מהחשבון</button>`;
  const finish = async p => { try { S.people = await sync.savePerson(p); S.myP = p.id; confetti(); toast('🎉 ברוך הבא!'); await afterGate(); } catch (x) { err(x.message); } };
  body.querySelectorAll('[data-claim]').forEach(b => b.onclick = () => finish({ ...free.find(p => p.id === b.dataset.claim), uid: S.uid }));
  $('#gFace').onclick = e => { face = (face + 1) % FACES.length; e.target.textContent = FACES[face]; };
  $('#gSave').onclick = () => {
    const name = $('#gMe').value.trim(); if (!name) return err('צריך לכתוב שם');
    if (S.people.some(p => p.name === name)) return err('השם הזה כבר קיים. אם זה אתה, לחץ עליו למעלה');
    finish({ id: db.newId(), name, e: FACES[face], uid: S.uid });
  };
  $('#gOut').onclick = signOut;
  return false;
}
let fresh = false;
async function afterGate() {
  if (!(await showGate())) return;
  if (fresh) { fresh = false; await sync.connected(true); S.items = await db.all('items'); renderAll(); }
  if (!started) boot();
}
async function signOut() {
  if (!confirm('לצאת מהחשבון? המשימות נשארות שמורות בענן, ויחזרו כשתיכנס שוב.')) return;
  await sync.signOut(); S.uid = null; S.myP = null; S.people = [];
  await load(); showGate();
}

// ---------- כרטיס המשפחה בהגדרות ----------
function renderFamily() {
  const hh = sync.household(), el = $('#familyCard'); if (!el) return;
  if (!hh) { el.hidden = true; return; }
  el.hidden = false;
  const meP = person(S.myP);
  const url = location.origin + location.pathname;
  const share = (code, label) => `<div class="set-row"><span>${label}</span><b dir="ltr" style="letter-spacing:2px">${esc(code)}</b></div>
    <a class="btn" href="https://wa.me/?text=${encodeURIComponent(`הצטרפות ל"זמן בכיף" של ${hh.name}: ${url}?join=${code}`)}" target="_blank" rel="noopener" style="display:grid;place-items:center;text-decoration:none">💬 שליחת הזמנה בוואטסאפ</a>`;
  el.innerHTML = `<h4>👨‍👩‍👧 ${esc(hh.name)}<small id="syncState">${navigator.onLine ? 'מסונכרן ✓' : 'ממתין לרשת…'}</small></h4>
    <div class="set-row"><span>אני</span><b>${meP ? `${meP.e} ${esc(meP.name)}` : ''}</b></div>
    <div class="set-row"><span>בני הבית</span><span>${S.people.map(p => `${p.e} ${esc(p.name)}${p.uid ? '' : ' <small style="color:var(--muted)">(בלי חשבון)</small>'}`).join('<br>')}</span></div>
    ${sync.isParent() && hh.invite_code ? share(hh.invite_code, 'קוד להורה / בן זוג') : ''}
    ${sync.isParent() && hh.child_code ? share(hh.child_code, 'קוד לילד (רואה רק את שלו)') : ''}
    <p class="note" style="margin-top:8px">זה אותו חשבון ואותה משפחה כמו ב"כסף בכיף".</p>
    <button class="btn danger" id="signOutBtn">יציאה מהחשבון</button>`;
  $('#signOutBtn').onclick = signOut;
}

let started = false;
async function boot() {
  started = true;
  if (!S.msgs.length) {
    const ex = family() ? `\n🙋 תזכיר ל${S.people.find(p => p.id !== S.myP)?.name || 'רחל'} מחר ב-5 לקנות חלב` : '';
    await bot('👋', 'var(--g1)', 'שלום! אני "זמן בכיף"', `כתוב או אמור לי כל דבר, ואני אסדר:\n📌 תזכיר לי מחר ב-10 להתקשר לבנק\n🔁 כל יום חמישי ב-9 לשלם לגננת\n👥 פגישה עם יוסי ביום שלישי ב-4\n💭 רעיון: לסדר את המחסן\n✅ סיימתי לשלוח הצעת מחיר${ex}\n🔒 פרטי: ... (רק אתה תראה)\n\nכשיגיע הזמן, אשאל אותך אם עשית את זה.`);
  }
  await tick();
  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { document.title = 'זמן בכיף'; tick(); } });
}

(async () => {
  await load();
  await sync.start({
    onItem: onRemoteItem,
    onRemote: () => { renderAll(); renderFamily(); },
    onStatus: st => { const el = $('#syncState'); if (el) el.textContent = st === 'ok' ? 'מסונכרן ✓' : 'ממתין לרשת…'; },
  });
  S.people = await db.getKV('people', []);
  S.items = await db.all('items');
  if (await showGate()) boot();
})();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

// לבדיקות מהדפדפן
window.__zman = { S, parse, send, forWhom, sync };
