// Characterization tests for the layout registry helpers extracted from
// GraphCanvas.tsx.

import { beforeEach, describe, expect, it } from 'vitest';

import { layoutOpts, pickLayout, readInitialLayout } from './graphLayouts.ts';

describe('pickLayout', () => {
  it('keeps the requested layout at or below the heavy threshold', () => {
    expect(pickLayout('fcose', 500)).toBe('fcose');
    expect(pickLayout('fcose', 1000)).toBe('fcose');
  });

  it('substitutes a heavy layout above the threshold via HEAVY_SUB', () => {
    expect(pickLayout('klay', 5000)).toBe('dagre');
  });

  it('falls back to concentric when no fast substitute exists', () => {
    expect(pickLayout('fcose', 5000)).toBe('concentric');
  });

  it('falls back to concentric when the substitute is itself heavy', () => {
    expect(pickLayout('cose', 5000)).toBe('concentric');
  });

  it('leaves non-heavy layouts unchanged at any size', () => {
    expect(pickLayout('dagre', 50000)).toBe('dagre');
    expect(pickLayout('concentric', 50000)).toBe('concentric');
  });
});

describe('layoutOpts', () => {
  it('maps each id to its Cytoscape layout name', () => {
    expect(layoutOpts('fcose', false).name).toBe('fcose');
    expect(layoutOpts('dagre', false).name).toBe('dagre');
    expect(layoutOpts('coseBilkent', false).name).toBe('cose-bilkent');
  });
});

describe('readInitialLayout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to fcose when nothing is stored', () => {
    expect(readInitialLayout()).toBe('fcose');
  });

  it('returns a stored valid layout id', () => {
    localStorage.setItem('pgviewer.graph.layout', 'dagre');
    expect(readInitialLayout()).toBe('dagre');
  });

  it('ignores an unrecognised stored value', () => {
    localStorage.setItem('pgviewer.graph.layout', 'bogus');
    expect(readInitialLayout()).toBe('fcose');
  });
});
