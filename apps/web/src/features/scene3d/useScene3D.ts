import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { SceneBuilding, SceneHandle, ScenePlanting } from './types';

export type Scene3DState = 'off' | 'loading' | 'on' | 'load_failed' | 'context_lost' | 'no_webgl';

/** Loaded on first use only: keeps Three out of the 2D bundle. */
const loadModule = () => import('./threeLayer');

/**
 * The style can take a layer: addLayer only needs the style itself (MapLibre 6.16 `_checkLoaded`),
 * while isStyleLoaded() also waits for every tile, which never settles while the camera moves.
 */
function styleReady(m: MapLibreMap): boolean {
  return m.isStyleLoaded() || Boolean((m as unknown as { style?: { _loaded?: boolean } }).style?._loaded);
}

/** Resolves once the style can take a layer (an early click waits instead of failing). */
function styleLoaded(m: MapLibreMap): Promise<void> {
  if (styleReady(m)) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (!styleReady(m)) return;
      m.off('styledata', check);
      resolve();
    };
    m.on('styledata', check);
  });
}

function hasWebGL2(): boolean {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

/**
 * Owns the 3D layer lifecycle on an existing MapLibre map: lazy load, camera tilt, buildings,
 * context loss/restore and full release on exit or unmount.
 */
export function useScene3D(getMap: () => MapLibreMap | null, buildings: SceneBuilding[], plantings: ScenePlanting[] = []) {
  const [state, setState] = useState<Scene3DState>('off');
  const handle = useRef<SceneHandle | null>(null);
  const prevCamera = useRef<{ pitch: number; bearing: number } | null>(null);
  const wanted = useRef(false);

  const teardown = useCallback(() => {
    handle.current?.remove();
    handle.current = null;
    const m = getMap();
    if (m && prevCamera.current) {
      m.easeTo({ pitch: prevCamera.current.pitch, bearing: prevCamera.current.bearing, duration: 200 });
      m.dragRotate.disable();
      m.touchZoomRotate.disableRotation();
    }
    prevCamera.current = null;
  }, [getMap]);

  const enable = useCallback(async () => {
    const m = getMap();
    if (!m) return;
    if (!hasWebGL2()) {
      setState('no_webgl');
      return;
    }
    wanted.current = true;
    setState('loading');
    try {
      const [mod] = await Promise.all([loadModule(), styleLoaded(m)]);
      if (!wanted.current) return;
      const c = m.getCenter();
      // A layer object left from before a context loss cannot draw on the new context.
      if (m.getLayer('scene3d')) m.removeLayer('scene3d');
      handle.current = mod.createThreeLayer(m, {
        id: 'scene3d',
        origin: [c.lng, c.lat],
      });
      // Keep the 2D camera from the first activation; a re-enable after context restore must not
      // replace it with the tilted one. Arriving already tilted (a 3D link) means the 2D camera
      // to return to is flat and north-up.
      const tilted = m.getPitch() > 0;
      prevCamera.current ??= tilted ? { pitch: 0, bearing: 0 } : { pitch: m.getPitch(), bearing: m.getBearing() };
      m.dragRotate.enable();
      m.touchZoomRotate.enableRotation();
      if (!tilted) m.easeTo({ pitch: 55, duration: 250 });
      setState('on');
    } catch (err) {
      console.error('[3d] module load failed', err);
      setState('load_failed');
    }
  }, [getMap]);

  const disable = useCallback(() => {
    wanted.current = false;
    teardown();
    setState('off');
  }, [teardown]);

  useEffect(() => {
    handle.current?.setBuildings(buildings);
  }, [buildings, state]);

  useEffect(() => {
    handle.current?.setPlantings(plantings);
  }, [plantings, state]);

  // Loss is observed on the map, not inside the layer: MapLibre destroys its style (and calls
  // our onRemove) before canvas listeners registered by the layer would run.
  useEffect(() => {
    const m = getMap();
    if (!m || state !== 'on') return;
    const onLost = () => {
      handle.current = null;
      setState('context_lost');
    };
    m.on('webglcontextlost', onLost);
    return () => {
      m.off('webglcontextlost', onLost);
    };
  }, [state, getMap]);

  // MapLibre 6 snapshots and restores its style on context restore, but drops custom layers
  // ("cannot be restored after WebGL context loss"). Recreate ours after every MapLibre
  // webglcontextrestored as soon as the restored style is loaded. Not on 'idle': a map that keeps
  // moving (rotation, a pinch) never becomes idle, and a second loss must not stack callbacks.
  useEffect(() => {
    const m = getMap();
    if (!m || state !== 'context_lost') return;
    let restored = false;
    const recreate = () => {
      if (!restored || !wanted.current || !styleReady(m)) return;
      restored = false;
      m.off('render', recreate);
      m.off('styledata', recreate);
      void enable();
    };
    const onRestored = () => {
      handle.current = null;
      restored = true;
      m.on('render', recreate);
      m.on('styledata', recreate);
      recreate();
    };
    m.on('webglcontextrestored', onRestored);
    return () => {
      m.off('webglcontextrestored', onRestored);
      m.off('render', recreate);
      m.off('styledata', recreate);
    };
  }, [state, getMap, enable]);

  useEffect(() => () => {
    wanted.current = false;
    handle.current?.remove();
    handle.current = null;
  }, []);

  return { state, enable, disable, stats: () => handle.current?.stats() ?? null, handle };
}
