import { describe, expect, it } from 'vitest';
import { checkPhone, isMinorOn, normalisePhone } from '../lib/phone.js';

/**
 * No OTP is sent, so normalisation and the UNIQUE index are the only checks a
 * phone number gets (BUILD_PLAN s7.2). The tests that matter are the ones about
 * one number arriving in several shapes: if those normalise differently, the
 * index guards nothing and three students share a contact number.
 */

describe('normalisePhone', () => {
  it('reduces every written form of one number to ten digits', () => {
    for (const written of [
      '9876543211',
      '+91 9876543211',
      '+919876543211',
      '91 98765 43211',
      '09876543211',
      '0 98765 43211',
      '98765-43211',
      ' 9876543211 ',
      '+91-98765-43211',
    ]) {
      expect(normalisePhone(written), written).toBe('9876543211');
    }
  });

  it('does not strip a leading 91 that is part of a ten-digit number', () => {
    // 9123456789 is a real mobile that happens to start with 91. Stripping it
    // would turn a valid number into eight digits and reject the student.
    expect(normalisePhone('9123456789')).toBe('9123456789');
  });
});

describe('checkPhone', () => {
  it('accepts a plausible number and reports it normalised', () => {
    const result = checkPhone('+91 98765 43211');
    expect(result).toMatchObject({ ok: true, phone: '9876543211', suspicious: false });
  });

  it.each([
    ['12345', 'too short'],
    ['1234567890', 'starts with 1'],
    ['5876543210', 'starts with 5'],
    ['9999999999', 'all one digit'],
  ])('rejects %s (%s)', (input) => {
    expect(checkPhone(input).ok).toBe(false);
  });

  it('accepts a sequential number but marks it suspicious', () => {
    // 9876543210 is an issued, real-looking number. Rejecting it would lose a
    // paying student; ignoring it entirely would hide the one case worth a look.
    const result = checkPhone('9876543210');
    expect(result).toMatchObject({ ok: true, suspicious: true });
  });

  it('gives every rejection a message a student can act on', () => {
    const result = checkPhone('123');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(10);
  });
});

describe('isMinorOn', () => {
  const exam = new Date('2026-11-10T09:00:00+05:30');

  it('is true for a student who is 17 on the exam date', () => {
    expect(isMinorOn('2009-06-01', exam)).toBe(true);
  });

  it('is false for a student who turned 18 before the exam', () => {
    expect(isMinorOn('2008-06-01', exam)).toBe(false);
  });

  it('is false on the eighteenth birthday itself', () => {
    expect(isMinorOn('2008-11-10', exam)).toBe(false);
  });

  it('is true one day short of eighteen', () => {
    // The boundary that decides whether guardian consent is collected, so it
    // is pinned rather than left to a library.
    expect(isMinorOn('2008-11-11', exam)).toBe(true);
  });

  it('treats an unparseable date as not-a-minor rather than throwing', () => {
    expect(isMinorOn('not-a-date', exam)).toBe(false);
  });
});
