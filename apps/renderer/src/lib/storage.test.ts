// Characterization tests for the localStorage readers. jsdom supplies the
// `window.localStorage` these run against.

import { beforeEach, describe, expect, it } from 'vitest';

import { readFlag, readJSON, readNumber } from './storage.ts';

beforeEach(() => {
  localStorage.clear();
});

describe('readFlag', () => {
  it('is true only when the key holds "1"', () => {
    localStorage.setItem('f', '1');
    expect(readFlag('f')).toBe(true);
  });

  it('is false for "0", other strings, and missing keys', () => {
    localStorage.setItem('zero', '0');
    localStorage.setItem('yes', 'yes');
    expect(readFlag('zero')).toBe(false);
    expect(readFlag('yes')).toBe(false);
    expect(readFlag('missing')).toBe(false);
  });
});

describe('readNumber', () => {
  it('parses a finite number', () => {
    localStorage.setItem('n', '42');
    expect(readNumber('n', 7)).toBe(42);
    localStorage.setItem('f', '3.5');
    expect(readNumber('f', 7)).toBe(3.5);
  });

  it('returns the fallback for a missing key', () => {
    expect(readNumber('missing', 7)).toBe(7);
  });

  it('returns the fallback for unparseable content', () => {
    localStorage.setItem('bad', 'abc');
    expect(readNumber('bad', 7)).toBe(7);
  });
});

describe('readJSON', () => {
  const asStringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

  it('parses and returns a value the validator accepts', () => {
    localStorage.setItem('list', JSON.stringify(['a', 'b']));
    expect(readJSON('list', asStringArray, [])).toEqual(['a', 'b']);
  });

  it('returns the fallback for a missing key', () => {
    expect(readJSON('missing', asStringArray, ['fallback'])).toEqual(['fallback']);
  });

  it('returns the fallback for malformed JSON', () => {
    localStorage.setItem('broken', '{not json');
    expect(readJSON('broken', asStringArray, [])).toEqual([]);
  });

  it('returns the fallback when the validator rejects the shape', () => {
    localStorage.setItem('wrong', JSON.stringify([1, 2, 3]));
    expect(readJSON('wrong', asStringArray, ['fallback'])).toEqual(['fallback']);
  });
});
