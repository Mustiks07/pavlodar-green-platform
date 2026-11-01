// WCAG contrast check of design tokens (light and dark). Exit 1 if a pair fails.
//   node scripts/check-contrast.mjs
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../../packages/ui/src/tokens.css', import.meta.url), 'utf8');

function block(selector) {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`selector not found: ${selector}`);
  const start = css.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === '{') depth++;
    if (css[j] === '}' && --depth === 0) return css.slice(start + 1, j);
  }
  throw new Error('unbalanced css');
}

function vars(text) {
  const out = {};
  for (const m of text.matchAll(/(--pg-[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}

function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

const light = vars(block(':root {'));
const dark = { ...light, ...vars(block(":root[data-theme='dark']")) };

// [foreground, background, minimum]
const PAIRS = [
  ['--pg-text', '--pg-bg', 4.5],
  ['--pg-text', '--pg-surface', 4.5],
  ['--pg-text-muted', '--pg-surface', 4.5],
  ['--pg-text-muted', '--pg-surface-2', 4.5],
  ['--pg-text-subtle', '--pg-surface', 4.5],
  ['--pg-text-on-accent', '--pg-accent', 4.5],
  ['--pg-accent-text', '--pg-accent-soft', 4.5],
  ['--pg-accent-text', '--pg-surface', 4.5],
  ['--pg-positive', '--pg-positive-soft', 4.5],
  ['--pg-negative', '--pg-negative-soft', 4.5],
  ['--pg-warning', '--pg-warning-soft', 4.5],
  ['--pg-text', '--pg-warning-soft', 4.5],
  ['--pg-text', '--pg-positive-soft', 4.5],
  ['--pg-info', '--pg-info-soft', 4.5],
  ['--pg-neutral', '--pg-neutral-soft', 4.5],
  ['--pg-positive', '--pg-surface', 4.5],
  ['--pg-negative', '--pg-surface', 4.5],
  ['--pg-warning', '--pg-surface', 4.5],
  ['--pg-prov-measured', '--pg-prov-measured-soft', 4.5],
  ['--pg-prov-estimated', '--pg-prov-estimated-soft', 4.5],
  ['--pg-prov-synthetic', '--pg-prov-synthetic-soft', 4.5],
  ['--pg-prov-unavailable', '--pg-prov-unavailable-soft', 4.5],
  ['--pg-border-strong', '--pg-surface', 3],
  ['--pg-focus', '--pg-surface', 3],
  ['--pg-focus', '--pg-bg', 3],
  ['--pg-sidebar-text', '--pg-sidebar', 4.5],
  ['--pg-sidebar-muted', '--pg-sidebar', 4.5],
  ['--pg-sidebar-positive', '--pg-sidebar', 4.5],
  ['--pg-sidebar-warning', '--pg-sidebar', 4.5],
  ['--pg-sidebar-negative', '--pg-sidebar', 4.5],
  ['--pg-map-boundary', '--pg-map-bg', 3],
  // Published-layer semantics over the light basemap (non-text graphics, WCAG 1.4.11: 3:1).
  ['--pg-basemap-positive', '--pg-basemap-halo', 3],
  ['--pg-basemap-negative', '--pg-basemap-halo', 3],
  ['--pg-basemap-warning', '--pg-basemap-halo', 3],
  ['--pg-basemap-neutral', '--pg-basemap-halo', 3],
  ['--pg-basemap-unknown', '--pg-basemap-halo', 3],
  // Layer-family identity colours: over the basemap and over the platform map background.
  ['--pg-basemap-road', '--pg-basemap-halo', 3],
  ['--pg-basemap-green', '--pg-basemap-halo', 3],
  ['--pg-basemap-water', '--pg-basemap-halo', 3],
  ['--pg-basemap-building', '--pg-basemap-halo', 3],
  ['--pg-map-road', '--pg-map-bg', 3],
  ['--pg-map-green', '--pg-map-bg', 3],
  ['--pg-map-water', '--pg-map-bg', 3],
  ['--pg-map-building', '--pg-map-bg', 3],
];

let failed = 0;
for (const [theme, t] of [
  ['light', light],
  ['dark', dark],
]) {
  for (const [fg, bg, min] of PAIRS) {
    const r = ratio(t[fg], t[bg]);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${theme.padEnd(5)} ${fg} on ${bg}: ${r.toFixed(2)} (min ${min})`);
  }
}
console.log(failed ? `\n${failed} pair(s) below WCAG AA` : '\nall token pairs meet WCAG AA');
process.exit(failed ? 1 : 0);
