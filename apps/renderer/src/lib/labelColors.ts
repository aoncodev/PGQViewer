// User-driven per-label colour overrides.
//
// `colorForLabel(label, theme)` consults this module first; when there's an
// override for that label, the override's hue replaces the hash-derived one.
// Otherwise the hash-based default applies, exactly as before.
//
// Overrides live in localStorage so they survive reloads. We expose a tiny
// pub-sub so views that cache colours (the Cytoscape canvas) can listen
// without coupling to React state.

import { invalidateLabelColor } from './colors';
import { createPersistentMap } from './persistentMap';

/**
 * The eight hues across the wheel — coral, amber, emerald, teal, sky,
 * indigo, violet, fuchsia. Deliberately skips the muddy yellow-green
 * range (~70-110°). Canonical source; colors.ts hashes labels onto this.
 */
export const PICKER_HUES = [15, 40, 150, 180, 210, 250, 290, 325];

// Changing an override must drop the affected label's memoised colour.
const store = createPersistentMap<number>('pgviewer.labelColors', (label) =>
  invalidateLabelColor(label),
);

/** Subscribe to override changes; returns an unsubscribe handle. */
export const subscribeLabelOverrides = store.subscribe;
export const getLabelOverride = store.get;
export const setLabelOverride = store.set;
export const clearLabelOverride = store.remove;
