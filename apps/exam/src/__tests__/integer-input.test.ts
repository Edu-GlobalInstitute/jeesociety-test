import { describe, expect, it } from 'vitest';
import { LIMITS, answerMatches } from '@jee/shared';
import { filterIntegerInput } from '../components/QuestionView.js';

/**
 * The integer field filters as the student types, which means this function can
 * silently eat a correct answer. Tested as a pair with answerMatches: it is not
 * enough that the filter produces something tidy, what it produces has to still
 * score.
 */

describe('filterIntegerInput', () => {
  it('keeps a plain integer', () => {
    expect(filterIntegerInput('12')).toBe('12');
  });

  it('keeps a decimal', () => {
    expect(filterIntegerInput('2.5')).toBe('2.5');
  });

  it('keeps a leading minus', () => {
    expect(filterIntegerInput('-4')).toBe('-4');
  });

  it('drops letters and symbols a phone keyboard offers', () => {
    expect(filterIntegerInput('12abc')).toBe('12');
    expect(filterIntegerInput('1,200')).toBe('1200');
    expect(filterIntegerInput('12 m/s')).toBe('12');
  });

  it('keeps only the first decimal point', () => {
    expect(filterIntegerInput('1.2.3')).toBe('1.23');
  });

  it('moves a stray minus to the front rather than dropping the digits', () => {
    expect(filterIntegerInput('4-')).toBe('-4');
    expect(filterIntegerInput('-1-2')).toBe('-12');
  });

  it('allows a half-typed value to exist while being typed', () => {
    // Rejecting these would make the field fight the student mid-answer.
    expect(filterIntegerInput('-')).toBe('-');
    expect(filterIntegerInput('9.')).toBe('9.');
  });

  it('holds the answer to the contract length, so a sync is never rejected', () => {
    const long = filterIntegerInput('1'.repeat(80));
    expect(long).toHaveLength(LIMITS.maxAnswerChars);
  });

  it('produces values that still score against the key', () => {
    // The pairing that matters: filtered input must survive scoring.
    expect(answerMatches('12', filterIntegerInput('12abc'))).toBe(true);
    expect(answerMatches('-4', filterIntegerInput('4-'))).toBe(true);
    expect(answerMatches('2.5', filterIntegerInput('2.50'))).toBe(true);
    expect(answerMatches('1200', filterIntegerInput('1,200'))).toBe(true);
  });
});
