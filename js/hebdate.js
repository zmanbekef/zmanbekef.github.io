// תאריך עברי באותיות (למשל: ז׳ בחשוון תשפ״ז)
const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];

export function gematria(n) {
  let s = HUNDREDS[Math.floor(n / 100)] + TENS[Math.floor((n % 100) / 10)] + ONES[n % 10];
  s = s.replace('יה', 'טו').replace('יו', 'טז');
  return s.length === 1 ? s + '׳' : s.slice(0, -1) + '״' + s.slice(-1);
}

export function hebDate(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('he-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(d);
    const get = t => parts.find(p => p.type === t)?.value;
    const day = parseInt(get('day'), 10), year = parseInt(get('year'), 10);
    let month = get('month') || '';
    if (!day || !year) return '';
    if (month === 'חשון') month = 'חשוון';
    return `${gematria(day)} ב${month.replace(/^ב/, '')} ${gematria(year % 1000)}`;
  } catch { return ''; }
}
