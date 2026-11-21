// ロック：4桁のパスコードと、パスキー（指紋・顔認証）
//
// パスコードはそのまま保存せず、PBKDF2 でハッシュにして保存する。
// パスキーは、この端末の指紋・顔認証で本人確認できたかを確かめる。
// 署名も公開鍵で検証する。データの暗号化ではなく「人に見られないためのロック」。

import { loadLock, saveLock, clearLock } from './storage.js';

const ITERATIONS = 150000;
const MAX_FAILS = 5;
const WAIT_MS = 30000;
const enc = new TextEncoder();

// ---- 小さな道具 ----

export function toB64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const random = (n) => crypto.getRandomValues(new Uint8Array(n));

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hashPin(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

// ---- 状態 ----

export function isEnabled() {
  const l = loadLock();
  return !!(l && l.hash && l.salt);
}

export function info() {
  const l = loadLock();
  return { enabled: isEnabled(), passkey: !!(l && l.passkey && l.passkey.id) };
}

/** 間違いが続いたときの待ち時間（ミリ秒） */
export function waitRemaining() {
  const l = loadLock();
  return l && l.lockedUntil > Date.now() ? l.lockedUntil - Date.now() : 0;
}

// ---- パスコード ----

export async function setPin(pin) {
  const prev = loadLock() || {};
  const salt = random(16);
  const hash = await hashPin(pin, salt, ITERATIONS);
  saveLock({ ...prev, salt: toB64u(salt), hash: toB64u(hash), iterations: ITERATIONS, fails: 0, lockedUntil: 0 });
}

/** @returns {Promise<{ok:boolean, waitMs?:number}>} */
export async function checkPin(pin) {
  const l = loadLock();
  if (!l || !l.hash) return { ok: true };
  if (l.lockedUntil > Date.now()) return { ok: false, waitMs: l.lockedUntil - Date.now() };
  const hash = await hashPin(pin, fromB64u(l.salt), l.iterations || ITERATIONS);
  const cur = loadLock() || l;
  if (sameBytes(hash, fromB64u(l.hash))) {
    saveLock({ ...cur, fails: 0, lockedUntil: 0 });
    return { ok: true };
  }
  const fails = (cur.fails || 0) + 1;
  const lockedUntil = fails >= MAX_FAILS ? Date.now() + WAIT_MS : 0;
  saveLock({ ...cur, fails, lockedUntil });
  return { ok: false, waitMs: lockedUntil ? WAIT_MS : 0 };
}

// ---- パスキー（指紋・顔認証） ----

export async function passkeySupported() {
  if (!window.isSecureContext || !window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function registerPasskey() {
  const l = loadLock();
  if (!l || !l.hash) throw new Error('先にパスコードを設定してください。');
  const challenge = random(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: '完済ナビ' },
      user: { id: random(16), name: '完済ナビのロック解除', displayName: '完済ナビのロック解除' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
        requireResidentKey: false,
      },
      timeout: 120000,
      attestation: 'none',
    },
  });
  if (!cred) throw new Error('登録できませんでした。');

  const clientData = JSON.parse(new TextDecoder().decode(cred.response.clientDataJSON));
  if (clientData.type !== 'webauthn.create' || clientData.challenge !== toB64u(challenge)) {
    throw new Error('登録の確認に失敗しました。');
  }

  let publicKey = null;
  let alg = null;
  try {
    const spki = cred.response.getPublicKey?.();
    alg = cred.response.getPublicKeyAlgorithm?.() ?? null;
    if (spki && (alg === -7 || alg === -257)) publicKey = toB64u(spki);
  } catch {
    /* 古いブラウザでは公開鍵を取り出せない。その場合は署名の検証を省く */
  }
  saveLock({ ...(loadLock() || l), passkey: { id: toB64u(cred.rawId), publicKey, alg, createdAt: new Date().toISOString() } });
}

/** ECDSA の DER 形式の署名を、WebCrypto が使う r||s 形式（64バイト）にする */
function derToRaw(der) {
  const b = new Uint8Array(der);
  let p = 0;
  if (b[p++] !== 0x30) throw new Error('bad signature');
  let len = b[p++];
  if (len & 0x80) p += len & 0x7f;
  const readInt = () => {
    if (b[p++] !== 0x02) throw new Error('bad signature');
    const l = b[p++];
    let v = b.slice(p, p + l);
    p += l;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error('bad signature');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  return concat(r, s);
}

async function verifySignature(passkey, authData, clientDataJSON, signature) {
  const spki = fromB64u(passkey.publicKey);
  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const signed = concat(authData, clientHash);
  if (passkey.alg === -7) {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), signed);
  }
  const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, new Uint8Array(signature), signed);
}

/**
 * 指紋・顔認証でロックを解除する
 * @returns {Promise<boolean>} 本人と確認できたら true。キャンセルなどは例外（NotAllowedError）
 */
export async function unlockWithPasskey(signal) {
  const l = loadLock();
  if (!l || !l.passkey) return false;
  const challenge = random(32);
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: fromB64u(l.passkey.id) }],
      userVerification: 'required',
      timeout: 120000,
    },
    signal,
  });
  if (!assertion || toB64u(assertion.rawId) !== l.passkey.id) return false;

  const res = assertion.response;
  const clientData = JSON.parse(new TextDecoder().decode(res.clientDataJSON));
  if (clientData.type !== 'webauthn.get') return false;
  if (clientData.challenge !== toB64u(challenge)) return false;
  if (clientData.origin !== location.origin) return false;

  const authData = new Uint8Array(res.authenticatorData);
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(location.hostname)));
  if (!sameBytes(authData.slice(0, 32), rpHash)) return false;
  const flags = authData[32];
  if (!(flags & 0x01) || !(flags & 0x04)) return false; // 本人がその場にいて、本人確認できた

  if (l.passkey.publicKey) {
    const ok = await verifySignature(l.passkey, authData, res.clientDataJSON, res.signature);
    if (!ok) return false;
  }
  saveLock({ ...(loadLock() || l), fails: 0, lockedUntil: 0 });
  return true;
}

/** このアプリでのパスキーの利用をやめる（パスワードマネージャーにも「もう使わない」と伝える） */
export async function forgetPasskey() {
  const l = loadLock();
  if (!l || !l.passkey) return;
  const id = l.passkey.id;
  delete l.passkey;
  saveLock(l);
  try {
    if (PublicKeyCredential.signalUnknownCredential) {
      await PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: id });
    }
  } catch {
    /* 対応していなければ何もしない */
  }
}

export async function disable() {
  await forgetPasskey();
  clearLock();
}

/** パスキーのエラーを、わかりやすい言葉にする */
export function describeError(e) {
  switch (e && e.name) {
    case 'NotAllowedError':
      return '操作がキャンセルされたか、時間切れになりました。';
    case 'InvalidStateError':
      return 'この端末には、すでに登録されています。';
    case 'SecurityError':
      return 'このページの場所では使えません（https で開いてください）。';
    case 'NotSupportedError':
      return 'この端末・ブラウザでは使えません。';
    default:
      return (e && e.message) || 'うまくいきませんでした。';
  }
}
