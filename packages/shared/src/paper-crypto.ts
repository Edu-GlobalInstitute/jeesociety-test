import type { EncryptedPaper, Paper } from './types.js';

/**
 * AES-256-GCM over the paper JSON, using WebCrypto so that the builder (Node)
 * and the exam client (browser) run byte-for-byte the same implementation. If
 * these two ever drifted apart the failure would land at the start instant, on
 * 10,000 machines at once, which is the worst possible time to find out.
 *
 * GCM is authenticated: a corrupted or truncated download fails to decrypt
 * rather than rendering a mangled paper. The client treats that as "re-download
 * and retry", not as "show the student half a question".
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;

function subtle(): SubtleCrypto {
  const webcrypto = globalThis.crypto;
  if (!webcrypto?.subtle) {
    throw new Error('WebCrypto is unavailable in this environment');
  }
  return webcrypto.subtle;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Generates the key that is withheld until starts_at. base64url, 32 bytes. */
export function generatePaperKey(): string {
  const key = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(key);
  return toBase64Url(key);
}

async function importKey(keyB64: string, usage: KeyUsage): Promise<CryptoKey> {
  const raw = fromBase64Url(keyB64);
  if (raw.length !== KEY_BYTES) {
    throw new Error(`paper key must be ${KEY_BYTES} bytes, got ${raw.length}`);
  }
  return subtle().importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [usage]);
}

export async function encryptPaper(paper: Paper, keyB64: string): Promise<EncryptedPaper> {
  const key = await importKey(keyB64, 'encrypt');
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(paper));
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return {
    v: 1,
    alg: 'AES-GCM',
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptPaper(blob: EncryptedPaper, keyB64: string): Promise<Paper> {
  if (blob.v !== 1 || blob.alg !== 'AES-GCM') {
    throw new Error(`unsupported paper envelope: v${blob.v} ${blob.alg}`);
  }
  const key = await importKey(keyB64, 'decrypt');
  const plaintext = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(blob.iv) as BufferSource },
    key,
    fromBase64Url(blob.ct) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Paper;
}
