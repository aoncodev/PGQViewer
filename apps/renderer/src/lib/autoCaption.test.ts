import { describe, expect, it } from 'vitest';

import { pickAutoCaption } from './autoCaption.ts';

describe('pickAutoCaption', () => {
  it('prefers a conventional name-ish column', () => {
    expect(pickAutoCaption({ name: 'Alice', id: 1 })).toBe('Alice');
    expect(pickAutoCaption({ title: 'The Matrix', release_year: 1999 })).toBe('The Matrix');
  });

  it('falls back to a *name/*title column (keyless company_graph case)', () => {
    // employees PROPERTIES (department, full_name) — no plain `name`, key hidden.
    expect(pickAutoCaption({ department: 'Engineering', full_name: 'Ada' })).toBe('Ada');
    expect(pickAutoCaption({ job_title: 'CEO', salary: 100 })).toBe('CEO');
  });

  it('prefers exact name over a *name column', () => {
    expect(pickAutoCaption({ full_name: 'Ada', name: 'short' })).toBe('short');
  });

  it('uses a conventional id when no name-ish column exists', () => {
    expect(pickAutoCaption({ id: 42, weight: 3 })).toBe('42');
    expect(pickAutoCaption({ id: 0 })).toBe('0'); // numeric 0 is a valid id
  });

  it('falls back to the first string, then any scalar — never blank with data', () => {
    expect(pickAutoCaption({ color: 'red', n: 3 })).toBe('red');
    expect(pickAutoCaption({ zone: 2, active: true })).toBe('2');
  });

  it('skips null/undefined and object-valued properties', () => {
    expect(pickAutoCaption({ name: null, full_name: 'Bob' })).toBe('Bob');
    expect(pickAutoCaption({ meta: { a: 1 }, label_text: 'ok' })).toBe('ok');
  });

  it('returns empty only when there is no scalar property', () => {
    expect(pickAutoCaption({})).toBe('');
    expect(pickAutoCaption({ blob: { x: 1 }, arr: [1, 2] })).toBe('');
  });
});
