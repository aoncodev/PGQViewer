// Characterization tests for formatValue — the shared value renderer used
// by the canvas panels, results table, and CSV/GraphML export.

import { describe, expect, it } from 'vitest';

import { formatValue, toFiniteNumber } from './format.ts';

describe('formatValue', () => {
  it('renders nullish values with the defaults', () => {
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('—');
  });

  it('honours custom nullish text', () => {
    expect(formatValue(null, { nullText: '' })).toBe('');
    expect(formatValue(undefined, { undefinedText: '' })).toBe('');
    expect(formatValue(null, { nullText: '∅' })).toBe('∅');
    expect(formatValue(undefined, { undefinedText: '∅' })).toBe('∅');
  });

  it('stringifies primitives', () => {
    expect(formatValue('hello')).toBe('hello');
    expect(formatValue(42)).toBe('42');
    expect(formatValue(0)).toBe('0');
    expect(formatValue(true)).toBe('true');
    expect(formatValue(false)).toBe('false');
  });

  it('JSON-encodes objects and arrays', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue([1, 2, 3])).toBe('[1,2,3]');
  });

  it('does not truncate when maxLen is unset', () => {
    const long = 'x'.repeat(100);
    expect(formatValue(long)).toBe(long);
  });

  it('truncates strings longer than maxLen with an ellipsis', () => {
    expect(formatValue('x'.repeat(50), { maxLen: 40 })).toBe('x'.repeat(37) + '…');
  });

  it('leaves strings exactly maxLen long untouched', () => {
    const exact = 'x'.repeat(40);
    expect(formatValue(exact, { maxLen: 40 })).toBe(exact);
  });

  it('truncates JSON output too', () => {
    const out = formatValue({ k: 'x'.repeat(100) }, { maxLen: 40 });
    expect(out).toHaveLength(38);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('toFiniteNumber', () => {
  it('passes finite numbers through', () => {
    expect(toFiniteNumber(8.8)).toBe(8.8);
    expect(toFiniteNumber(0)).toBe(0);
    expect(toFiniteNumber(-3)).toBe(-3);
  });

  it('coerces numeric strings (server-stringified PG numerics)', () => {
    expect(toFiniteNumber('8.8')).toBe(8.8);
    expect(toFiniteNumber('  42 ')).toBe(42);
    expect(toFiniteNumber('-0.5')).toBe(-0.5);
  });

  it('rejects non-numeric and degenerate values', () => {
    expect(toFiniteNumber('abc')).toBeNull();
    expect(toFiniteNumber('')).toBeNull();
    expect(toFiniteNumber('   ')).toBeNull();
    expect(toFiniteNumber(null)).toBeNull();
    expect(toFiniteNumber(undefined)).toBeNull();
    expect(toFiniteNumber(NaN)).toBeNull();
    expect(toFiniteNumber(Infinity)).toBeNull();
    expect(toFiniteNumber('Infinity')).toBeNull();
    expect(toFiniteNumber({})).toBeNull();
    expect(toFiniteNumber(true)).toBeNull();
  });
});
