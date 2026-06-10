// Characterization tests for createPersistentMap — the localStorage-backed
// pub-sub map behind label colours and captions.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPersistentMap } from './persistentMap.ts';

beforeEach(() => {
  localStorage.clear();
});

describe('createPersistentMap', () => {
  it('round-trips values through get/set', () => {
    const m = createPersistentMap<number>('pm.test');
    expect(m.get('a')).toBeUndefined();
    m.set('a', 1);
    expect(m.get('a')).toBe(1);
  });

  it('persists to localStorage so a fresh map reads prior writes', () => {
    createPersistentMap<number>('pm.test').set('a', 9);
    const reopened = createPersistentMap<number>('pm.test');
    expect(reopened.get('a')).toBe(9);
  });

  it('removes a key', () => {
    const m = createPersistentMap<number>('pm.test');
    m.set('a', 1);
    m.remove('a');
    expect(m.get('a')).toBeUndefined();
  });

  it('calls onChange with the affected key on set and remove', () => {
    const onChange = vi.fn();
    const m = createPersistentMap<number>('pm.test', onChange);
    m.set('a', 1);
    expect(onChange).toHaveBeenLastCalledWith('a');
    m.remove('a');
    expect(onChange).toHaveBeenLastCalledWith('a');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not fire onChange or notify when removing an absent key', () => {
    const onChange = vi.fn();
    const sub = vi.fn();
    const m = createPersistentMap<number>('pm.test', onChange);
    m.subscribe(sub);
    m.remove('never-set');
    expect(onChange).not.toHaveBeenCalled();
    expect(sub).not.toHaveBeenCalled();
  });

  it('notifies subscribers until they unsubscribe', () => {
    const m = createPersistentMap<number>('pm.test');
    const sub = vi.fn();
    const unsubscribe = m.subscribe(sub);
    m.set('a', 1);
    expect(sub).toHaveBeenCalledTimes(1);
    unsubscribe();
    m.set('b', 2);
    expect(sub).toHaveBeenCalledTimes(1);
  });
});
