import { describe, expect, it } from 'vitest';
import {
  decryptPaper,
  encryptPaper,
  fromBase64Url,
  generatePaperKey,
  toBase64Url,
} from '../paper-crypto.js';
import type { Paper } from '../types.js';

const paper: Paper = {
  testId: 1,
  name: 'JEE Mock 1',
  durationMinutes: 180,
  questions: [
    { id: 'q1', kind: 'scq', subject: 'physics', body: 'A body falls...', options: [{ key: 'A', body: '1' }] },
    { id: 'q21', kind: 'integer', subject: 'physics', body: 'Give the acceleration...', unit: 'm/s²' },
  ],
};

describe('paper crypto', () => {
  it('round-trips a paper', async () => {
    const key = generatePaperKey();
    const blob = await encryptPaper(paper, key);
    await expect(decryptPaper(blob, key)).resolves.toEqual(paper);
  });

  it('produces a blob that reveals nothing without the key', async () => {
    const blob = await encryptPaper(paper, generatePaperKey());
    expect(JSON.stringify(blob)).not.toContain('A body falls');
    expect(JSON.stringify(blob)).not.toContain('Prove that');
  });

  it('refuses the wrong key rather than returning garbage', async () => {
    const blob = await encryptPaper(paper, generatePaperKey());
    await expect(decryptPaper(blob, generatePaperKey())).rejects.toThrow();
  });

  it('refuses a tampered ciphertext (GCM is authenticated)', async () => {
    const key = generatePaperKey();
    const blob = await encryptPaper(paper, key);
    const bytes = fromBase64Url(blob.ct);
    bytes[0] = bytes[0]! ^ 0xff;
    await expect(decryptPaper({ ...blob, ct: toBase64Url(bytes) }, key)).rejects.toThrow();
  });

  it('uses a fresh IV per encryption', async () => {
    const key = generatePaperKey();
    const a = await encryptPaper(paper, key);
    const b = await encryptPaper(paper, key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects a key of the wrong length', async () => {
    await expect(encryptPaper(paper, toBase64Url(new Uint8Array(16)))).rejects.toThrow(
      /32 bytes/,
    );
  });
});
