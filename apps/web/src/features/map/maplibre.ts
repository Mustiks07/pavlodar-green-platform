/**
 * The one entry point to MapLibre for every map in the app. MapLibre 6 ships a separate module
 * worker: Vite bundles it and this module publishes its URL before any Map is created. With
 * lazy routes each map must import from here, or a map can start without a worker and never
 * load its style.
 */
import * as maplibregl from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol as PMTilesProtocol } from 'pmtiles';
import { ARCHIVE_PROTOCOL, archiveLayerId, archiveProtocolToHttp, TILE_PROTOCOL, tileLayerId, tileProtocolToHttp } from './publishedLayers';

maplibregl.setWorkerUrl(mapWorkerUrl);

/** status: HTTP status of a published-layer tile, null = network failure. */
export type TileStatus = { layerId: string; status: number | null };
const tileListeners = new Set<(s: TileStatus) => void>();
export function onTileStatus(fn: (s: TileStatus) => void): () => void {
  tileListeners.add(fn);
  return () => void tileListeners.delete(fn);
}
const notify = (s: TileStatus) => tileListeners.forEach((fn) => fn(s));

/**
 * At most this many published-layer tiles are in flight. Tiles share the origin's connections
 * (6 per host on HTTP/1.1) with the app's own API calls; unbounded, a z17 fit over a few dozen
 * layers queued 170+ tiles and the zone card waited seconds for its data (ADR-013 P1).
 */
const MAX_TILE_FETCHES = 4;
let inFlight = 0;
const waiting: Array<() => void> = [];
function acquire(signal: AbortSignal): Promise<void> {
  if (inFlight < MAX_TILE_FETCHES) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const go = () => {
      signal.removeEventListener('abort', cancel);
      inFlight++;
      resolve();
    };
    // A tile MapLibre no longer needs leaves the queue without ever being requested.
    const cancel = () => {
      const i = waiting.indexOf(go);
      if (i >= 0) waiting.splice(i, 1);
      reject(new DOMException('Tile request aborted', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    waiting.push(go);
  });
}
function release() {
  inFlight--;
  waiting.shift()?.();
}

/**
 * Published-layer tiles (ADR-012) are fetched here instead of by MapLibre directly: MapLibre
 * treats a 404 tile as empty without any event, but a 404 means the manifest's version is no
 * longer current and the client must refetch the layer list. Every status reaches the UI.
 * Same-origin fetch: the session cookie authorizes each tile, the browser cache honours the
 * server's private max-age/ETag.
 */
maplibregl.addProtocol(TILE_PROTOCOL, async (params, abort) => {
  const url = tileProtocolToHttp(params.url, window.location.protocol);
  const layerId = tileLayerId(url) ?? '';
  await acquire(abort.signal);
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: abort.signal, credentials: 'same-origin' });
    } catch (e) {
      if (!abort.signal.aborted) notify({ layerId, status: null });
      throw e;
    }
    notify({ layerId, status: res.status });
    if (res.ok) return { data: await res.arrayBuffer() };
    // Not current any more: draw nothing for this tile; the listener refetches the manifests.
    if (res.status === 404) return { data: new ArrayBuffer(0) };
    throw new Error(`HTTP ${res.status}`);
  } finally {
    release();
  }
});

/**
 * Published PMTiles archives (getMapArchive, ADR-031): the pmtiles library reads the header,
 * directories and tiles with single Range requests to the same-origin archive URL (the session
 * cookie authorizes each one). Wrapped so every failure reaches the UI like a tile status: a 404
 * means the manifest is no longer current and the layer list is refetched.
 */
const archives = new PMTilesProtocol({ metadata: false });
const statusOf = (e: unknown) => {
  const m = /([1-5]\d\d)/.exec(e instanceof Error ? e.message : String(e));
  return m ? Number(m[1]) : null;
};
maplibregl.addProtocol(ARCHIVE_PROTOCOL, async (params, abort) => {
  const url = archiveProtocolToHttp(params.url, window.location.protocol);
  const layerId = archiveLayerId(url) ?? '';
  const isTile = /\.pmtiles\/\d+\/\d+\/\d+$/.test(url);
  if (isTile) await acquire(abort.signal);
  try {
    const result = (await archives.tile({ ...params, url: `pmtiles://${url}` }, abort)) as { data: maplibregl.AddProtocolResponseData };
    if (isTile) {
      notify({ layerId, status: 200 });
      return result;
    }
    // The library's TileJSON points tiles at its own pmtiles:// scheme; route them back through
    // this protocol so tile statuses and the request bound apply to them too.
    const json = result.data as { tiles?: string[] };
    if (Array.isArray(json?.tiles)) json.tiles = json.tiles.map((t) => t.replace(/^pmtiles:\/\/https?:\/\//, `${ARCHIVE_PROTOCOL}://`));
    return result;
  } catch (e) {
    if (abort.signal.aborted) throw e;
    const status = statusOf(e);
    notify({ layerId, status });
    if (status === 404 && isTile) return { data: new ArrayBuffer(0) };
    throw e;
  } finally {
    if (isTile) release();
  }
});

export { maplibregl };
