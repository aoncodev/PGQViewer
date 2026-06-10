// Accent palette catalogue.
//
// A palette is just an `accent` hue (plus hover / fg / ring / selection
// derivatives). Light / dark surface tokens are untouched — palette and
// dark-mode are independent settings.
//
// All concrete colour values live in styles.css under `[data-palette="…"]`
// rules; this module owns the identifiers, display names, and the swatch
// previewed in the picker.
//
// Hues walk around the wheel ~45° apart, biased away from muddy yellow-green.
// Each entry's swatch is an approximate hex of the light-mode `--accent` so
// the picker preview matches what you'll see.
//
// Blue is the default: the de facto standard interactive/button accent
// across modern tools (Tailwind blue-600 territory), bright enough to read
// as an action color on both themes.

export const PALETTES = [
  { id: 'blue', name: 'Blue', swatch: '#2563EB' },
  { id: 'indigo', name: 'Indigo', swatch: '#5258D9' },
  { id: 'sky', name: 'Sky', swatch: '#4FA5D8' },
  { id: 'emerald', name: 'Emerald', swatch: '#1FA37A' },
  { id: 'amber', name: 'Amber', swatch: '#E5A93C' },
  { id: 'orange', name: 'Orange', swatch: '#E37A30' },
  { id: 'rose', name: 'Rose', swatch: '#E74E5D' },
  { id: 'fuchsia', name: 'Fuchsia', swatch: '#DC4ABA' },
  { id: 'violet', name: 'Violet', swatch: '#7E4DD8' },
] as const;

export type PaletteId = (typeof PALETTES)[number]['id'];

export const DEFAULT_PALETTE: PaletteId = 'blue';

const VALID_IDS: ReadonlySet<string> = new Set(PALETTES.map((p) => p.id));

export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === 'string' && VALID_IDS.has(v);
}

export function paletteById(id: PaletteId): (typeof PALETTES)[number] {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
