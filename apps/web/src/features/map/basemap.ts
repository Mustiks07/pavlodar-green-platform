import { useEffect, useState } from 'react';
import type { StyleSpecification } from 'maplibre-gl';

/**
 * Basemap style (MapLibre GL 6). Configurable with VITE_BASEMAP_STYLE_URL; default OpenFreeMap
 * "liberty". An empty value disables the external basemap (offline/closed profile). The style's
 * own attribution (OpenFreeMap, OpenMapTiles, OpenStreetMap) is kept and shown by MapLibre.
 */
export const DEFAULT_BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export function configuredBasemapUrl(): string | null {
  const v = import.meta.env.VITE_BASEMAP_STYLE_URL;
  if (v === undefined) return DEFAULT_BASEMAP_STYLE_URL;
  return v.trim() === '' ? null : v.trim();
}

export type BasemapState =
  | { status: 'loading' }
  | { status: 'ready'; style: StyleSpecification; url: string; flattenedExtrusions: number }
  | { status: 'disabled' }
  | { status: 'failed'; url: string; reason: string };

/**
 * Basemap building extrusions use OpenMapTiles render_height (OSM height, levels × default or a
 * fixed default). Shown in 3D they would read as verified heights, so they are flattened to
 * footprints; the platform's own buildings carry height_basis instead (F-3D-02, ADR-004 §6).
 */
export function flattenExtrusions(style: StyleSpecification): { style: StyleSpecification; count: number } {
  let count = 0;
  const layers = style.layers.map((l) => {
    if (l.type !== 'fill-extrusion') return l;
    count += 1;
    return { ...l, paint: { ...(l.paint ?? {}), 'fill-extrusion-height': 0, 'fill-extrusion-base': 0 } };
  });
  return { style: { ...style, layers }, count };
}

export function useBasemapStyle(timeoutMs = 12_000): BasemapState {
  const url = configuredBasemapUrl();
  const [state, setState] = useState<BasemapState>(url ? { status: 'loading' } : { status: 'disabled' });
  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    // A cleaned-up effect (unmount, StrictMode re-run) must not report its own abort as a failure:
    // the map is created once from the first settled state.
    let active = true;
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    fetch(url, { signal: ctrl.signal, credentials: 'omit' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = (await r.json()) as StyleSpecification;
        if (json?.version !== 8 || !Array.isArray(json.layers)) throw new Error('not a MapLibre style v8');
        const { style, count } = flattenExtrusions(json);
        if (active) setState({ status: 'ready', style, url, flattenedExtrusions: count });
      })
      .catch((e: unknown) => {
        if (active) setState({ status: 'failed', url, reason: timedOut ? `нет ответа за ${timeoutMs / 1000} с` : String((e as Error)?.message ?? e) });
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      active = false;
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [url, timeoutMs]);
  return state;
}
