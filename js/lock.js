// נעילת האפליקציה במכשיר: טביעת אצבע / Face ID (דרך WebAuthn) + קוד PIN לגיבוי
const KEY = 'zman-lock';
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function settings() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}
function save(s) {
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* מצב פרטי */ }
}

async function hash(pin) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('zman-bekef:' + pin));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function bioSupported() {
  try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch { return false; }
}

export async function enable(pin, useBio, minutes = 1) {
  const s = { pinHash: await hash(pin), cred: null, minutes };
  if (useBio) {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: rand(32),
      rp: { name: 'זמן בכיף', id: location.hostname },
      user: { id: rand(16), name: 'zman-bekef', displayName: 'זמן בכיף' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000,
    } });
    s.cred = b64(cred.rawId);
  }
  save(s);
  return s;
}

export function disable() { save(null); }
export function setMinutes(m) { const s = settings(); if (s) { s.minutes = m; save(s); } }

export async function bioUnlock() {
  const s = settings();
  if (!s?.cred) return false;
  await navigator.credentials.get({ publicKey: {
    challenge: rand(32),
    allowCredentials: [{ type: 'public-key', id: unb64(s.cred), transports: ['internal'] }],
    userVerification: 'required',
    timeout: 60000,
  } });
  return true;
}

export async function pinOk(pin) {
  const s = settings();
  return !!s && (await hash(pin)) === s.pinHash;
}
