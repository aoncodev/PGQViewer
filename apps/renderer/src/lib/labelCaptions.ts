// User-driven per-label caption overrides.
//
// `vertexLabel()` in GraphCanvas consults this module first; when a label
// has a caption set, that property's value becomes the displayed text on the
// node. Falls back to the default name/title/id heuristic otherwise.
//
// Overrides live in localStorage so they survive reloads. We expose a tiny
// pub-sub so views that cache labels (the Cytoscape canvas) can listen
// without coupling to React state.

import { createPersistentMap } from './persistentMap';

// Maps a label to the property name whose value is shown on the node.
const store = createPersistentMap<string>('pgviewer.labelCaptions');

export const subscribeLabelCaptions = store.subscribe;
export const getLabelCaption = store.get;
export const setLabelCaption = store.set;
export const clearLabelCaption = store.remove;
