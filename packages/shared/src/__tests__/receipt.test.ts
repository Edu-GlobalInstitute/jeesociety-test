import { describe, expect, it } from 'vitest';
import { generateReceipt, parseReceipt } from '../receipt.js';

describe('generateReceipt', () => {
  it('uses the documented format', () => {
    const receipt = generateReceipt(7, new Date(Date.UTC(2026, 9, 25)), () => 0.123456);
    expect(receipt).toBe('JEE-7-20261025-123456');
  });

  it('pads the random part to six digits', () => {
    expect(generateReceipt(7, new Date(Date.UTC(2026, 9, 25)), () => 0)).toBe(
      'JEE-7-20261025-000000',
    );
  });

  it('round-trips through the parser', () => {
    const receipt = generateReceipt(12, new Date(Date.UTC(2026, 9, 25)));
    expect(parseReceipt(receipt)).toMatchObject({ testId: '12', auto: false });
  });

  it('recognises an auto-submit receipt as produced by the sweep', () => {
    expect(parseReceipt('JEE-7-AUTO-a1b2c3')).toMatchObject({ testId: '7', auto: true });
  });

  it('rejects anything that is not a receipt', () => {
    expect(parseReceipt('not-a-receipt')).toBeNull();
    expect(parseReceipt('JEE-7-20261025-12345')).toBeNull();
  });
});
