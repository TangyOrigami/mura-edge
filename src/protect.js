// Mirrors mura-backend/internal/protect/token.go. The Go side pins golden
// vectors (golden_test.go) that test/vectors.test.js asserts here too; change
// one side and both tests say so.

const enc = new TextEncoder();

async function hmacKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmac(key, msg) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant time over equal lengths; length itself is not secret.
function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function importEdgeKey(raw) {
  return hmacKey(raw);
}

/** "{exp}.{b64url HMAC(edge, "tok|{episode}|{exp}")}" — token.go DeliveryToken. */
export async function deliveryToken(key, episodeID, expUnix) {
  const e = String(expUnix);
  return `${e}.${b64url(await hmac(key, `tok|${episodeID}|${e}`))}`;
}

export async function verifyDeliveryToken(key, episodeID, tok, nowUnix) {
  if (typeof tok !== 'string') return false;
  const dot = tok.indexOf('.');
  if (dot < 1) return false;
  const e = tok.slice(0, dot);
  if (!/^\d+$/.test(e) || nowUnix >= Number(e)) return false;
  const want = b64url(await hmac(key, `tok|${episodeID}|${e}`));
  return equal(tok.slice(dot + 1), want);
}

/** token.go IsDecoy: 16 hex nonce + first 8 bytes of HMAC(edge, "decoy|nonce"). */
export async function isDecoy(key, id) {
  if (id.length !== 32) return false;
  const mac = hex((await hmac(key, `decoy|${id.slice(0, 16)}`)).slice(0, 8));
  return equal(id.slice(16), mac);
}

/** token.go EdgeReportSig. */
export async function edgeReportSig(key, tile, ip) {
  return b64url(await hmac(key, `report|${tile}|${ip}`));
}

export function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
