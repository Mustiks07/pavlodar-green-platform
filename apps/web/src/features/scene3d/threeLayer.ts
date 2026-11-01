/**
 * Three.js inside MapLibre (WP-06 foundation). Loaded only through a dynamic import so the
 * 2D map never ships Three. Shares MapLibre's WebGL2 context and depth buffer; every GPU
 * object it creates is tracked and released in onRemove.
 *
 * Coordinates: a local frame at `origin` with X east, Y north, Z up, in metres. The model
 * matrix maps it to MapLibre mercator units with the same scale on all three axes
 * (meterInMercatorCoordinateUnits), so heights and footprints share one metric.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MercatorCoordinate, type CustomLayerInterface, type Map as MapLibreMap } from 'maplibre-gl';
import type { BasisStyle, HeightBasis, SceneBuilding, SceneHandle, ScenePlanting, SceneStats } from './types';

/**
 * One WebGLRenderer per MapLibre GL context, reused across layer mounts. Three 0.180 creates
 * 4 placeholder textures (WebGLState) and 3 framebuffers in the WebGLRenderer constructor that
 * renderer.dispose() never deletes; a new renderer per mount would leak them in the shared
 * context (measured: +4 textures, +3 framebuffers per toggle; see ADR-007). The cached renderer
 * is dropped on context loss and goes away with the context when the map is removed.
 */
const renderers = new WeakMap<WebGL2RenderingContext, THREE.WebGLRenderer>();

function rendererFor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext): THREE.WebGLRenderer {
  const cached = renderers.get(gl);
  if (cached && !gl.isContextLost()) return cached;
  const r = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
  r.autoClear = false;
  renderers.set(gl, r);
  canvas.addEventListener('webglcontextlost', () => renderers.delete(gl), { once: true });
  return r;
}

const BASES: HeightBasis[] = ['measured', 'recorded_unverified', 'floors_estimate', 'visual_placeholder', 'unknown'];

function cssColor(name: string, fallback: string): THREE.Color {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return new THREE.Color(v || fallback);
}

/**
 * Visual language per height basis. Only "measured" looks like a solid physical model;
 * recorded/estimated heights are visibly provisional; placeholders are ghosts with dashed
 * edges; unknown heights are not extruded at all (no invented value).
 */
function materialsFor(basis: HeightBasis): { fill: THREE.Material | null; edge: THREE.LineBasicMaterial | THREE.LineDashedMaterial } {
  switch (basis) {
    case 'measured':
      return {
        fill: new THREE.MeshLambertMaterial({ color: cssColor('--pg-prov-measured', '#1f5aa6') }),
        edge: new THREE.LineBasicMaterial({ color: 0x0b1f3a }),
      };
    case 'recorded_unverified':
      return {
        fill: new THREE.MeshLambertMaterial({ color: cssColor('--pg-prov-estimated', '#8a5a00'), transparent: true, opacity: 0.85 }),
        edge: new THREE.LineBasicMaterial({ color: 0x3d2800 }),
      };
    case 'floors_estimate':
      return {
        fill: new THREE.MeshLambertMaterial({ color: cssColor('--pg-prov-estimated', '#8a5a00'), transparent: true, opacity: 0.45, depthWrite: false }),
        edge: new THREE.LineDashedMaterial({ color: 0x3d2800, dashSize: 2, gapSize: 1.2 }),
      };
    case 'visual_placeholder':
      return {
        fill: new THREE.MeshBasicMaterial({ color: cssColor('--pg-map-unknown', '#9aa5a0'), transparent: true, opacity: 0.18, depthWrite: false }),
        edge: new THREE.LineDashedMaterial({ color: cssColor('--pg-map-unknown', '#9aa5a0'), dashSize: 1.2, gapSize: 1.2 }),
      };
    case 'unknown':
      return { fill: null, edge: new THREE.LineDashedMaterial({ color: cssColor('--pg-map-unknown', '#9aa5a0'), dashSize: 0.8, gapSize: 0.8 }) };
  }
}

function ringToLocal(ring: [number, number][], origin: MercatorCoordinate, scale: number): THREE.Vector2[] {
  const pts = ring.map(([lng, lat]) => {
    const m = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
    return new THREE.Vector2((m.x - origin.x) / scale, -(m.y - origin.y) / scale);
  });
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first && last && pts.length > 1 && first.equals(last)) pts.pop();
  return pts;
}

export interface ThreeLayerOptions {
  id: string;
  origin: [number, number];
  onContextLost?: () => void;
}

export function createThreeLayer(map: MapLibreMap, options: ThreeLayerOptions): SceneHandle {
  const origin = MercatorCoordinate.fromLngLat({ lng: options.origin[0], lat: options.origin[1] }, 0);
  const scale = origin.meterInMercatorCoordinateUnits();
  const modelMatrix = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new THREE.Vector3(scale, -scale, scale));

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sunlike = new THREE.DirectionalLight(0xffffff, 1.4);
  // Fixed shading direction for legibility only; solar position (date/time) is a separate
  // control in WP-06 and must not be inferred from this light.
  sunlike.position.set(-0.5, -0.8, 1).normalize();
  scene.add(sunlike);
  const content = new THREE.Group();
  scene.add(content);

  let renderer: THREE.WebGLRenderer | null = null;
  let buildings: SceneBuilding[] = [];
  let plantings: ScenePlanting[] = [];
  let disposed = false;
  let geometriesAfterRelease: number | null = null;
  const owned = new Set<THREE.BufferGeometry | THREE.Material>();
  let lastCalls = 0;
  let lastTriangles = 0;
  let lastMvp: number[] | null = null;
  let canvasRect = { width: 1, height: 1 };

  const clearContent = () => {
    for (const child of [...content.children]) content.remove(child);
    for (const o of owned) o.dispose();
    owned.clear();
  };

  const build = () => {
    clearContent();
    for (const basis of BASES) {
      const group = buildings.filter((b) => b.height_basis === basis && b.footprint.length >= 3);
      if (group.length === 0) continue;
      const { fill, edge } = materialsFor(basis);
      const fills: THREE.BufferGeometry[] = [];
      const edges: THREE.BufferGeometry[] = [];
      for (const b of group) {
        const shape = new THREE.Shape(ringToLocal(b.footprint, origin, scale));
        // Unknown height is never extruded; any other basis uses the delivered value only.
        const h = basis === 'unknown' || b.height_m === null || !(b.height_m > 0) ? 0 : b.height_m;
        const geom = h > 0 ? new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }) : new THREE.ShapeGeometry(shape);
        if (h > 0 && fill) fills.push(geom);
        const e = new THREE.EdgesGeometry(geom, 20);
        edges.push(e);
        if (!(h > 0 && fill)) geom.dispose();
      }
      if (fill && fills.length) {
        const merged = mergeGeometries(fills, false);
        fills.forEach((g) => g.dispose());
        if (merged) {
          owned.add(merged);
          owned.add(fill);
          const mesh = new THREE.Mesh(merged, fill);
          mesh.userData.basis = basis;
          content.add(mesh);
        }
      } else fill?.dispose();
      const mergedEdges = mergeGeometries(edges, false);
      edges.forEach((g) => g.dispose());
      if (mergedEdges) {
        owned.add(mergedEdges);
        owned.add(edge);
        const lines = new THREE.LineSegments(mergedEdges, edge);
        if (edge instanceof THREE.LineDashedMaterial) lines.computeLineDistances();
        lines.userData.basis = basis;
        content.add(lines);
      } else edge.dispose();
    }
    for (const planting of plantings) {
      const mercator = MercatorCoordinate.fromLngLat({ lng: planting.position[0], lat: planting.position[1] }, 0);
      const x = (mercator.x - origin.x) / scale;
      const y = -(mercator.y - origin.y) / scale;
      // Missing dimensions remain visibly schematic: these sizes are a map marker, not a claimed
      // biological measurement. Source-backed dimensions, when present, are used as delivered.
      const known = planting.height_m !== null && planting.height_m > 0;
      const height = known ? planting.height_m! : 3;
      const crownRadius = planting.crown_radius_m && planting.crown_radius_m > 0
        ? planting.crown_radius_m
        : known ? Math.max(0.65, height * 0.22) : 0.9;
      const trunkHeight = Math.max(0.5, height * 0.48);
      const trunkGeometry = new THREE.CylinderGeometry(Math.max(0.08, crownRadius * 0.14), Math.max(0.1, crownRadius * 0.18), trunkHeight, 8);
      trunkGeometry.rotateX(Math.PI / 2);
      trunkGeometry.translate(x, y, trunkHeight / 2);
      const crownGeometry = new THREE.SphereGeometry(crownRadius, 12, 8);
      crownGeometry.translate(x, y, Math.max(trunkHeight, height - crownRadius * 0.7));
      const trunkMaterial = new THREE.MeshLambertMaterial({
        color: planting.conflict ? 0x9f1d18 : planting.selected ? 0xc77a11 : 0x795548,
        transparent: !known,
        opacity: known ? 1 : 0.72,
      });
      const crownMaterial = new THREE.MeshLambertMaterial({
        color: planting.conflict ? 0xd92d20 : planting.selected ? 0xf2a93b : planting.locked ? 0x386b57 : 0x16805f,
        transparent: !known,
        opacity: known ? 0.94 : 0.7,
      });
      for (const ownedPart of [trunkGeometry, crownGeometry, trunkMaterial, crownMaterial]) owned.add(ownedPart);
      const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
      const crown = new THREE.Mesh(crownGeometry, crownMaterial);
      trunk.userData.planting = planting.id;
      crown.userData.planting = planting.id;
      content.add(trunk, crown);
    }
    map.triggerRepaint();
  };

  const onLost = () => options.onContextLost?.();

  const layer: CustomLayerInterface = {
    id: options.id,
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      renderer = rendererFor(m.getCanvas(), gl);
      m.getCanvas().addEventListener('webglcontextlost', onLost);
      build();
    },
    render(_gl, args) {
      if (!renderer) return;
      // MapLibre 6: mainMatrix maps 0..1 mercator coordinates to clip space (mercator projection).
      // modelViewProjectionMatrix is in world-pixel units and does not fit a mercator model matrix.
      lastMvp = Array.from(args.defaultProjectionData.mainMatrix as ArrayLike<number>);
      const mvp = new THREE.Matrix4().fromArray(lastMvp);
      camera.projectionMatrix = mvp.multiply(modelMatrix);
      const c = map.getCanvas();
      canvasRect = { width: c.clientWidth, height: c.clientHeight };
      renderer.resetState();
      renderer.render(scene, camera);
      lastCalls = renderer.info.render.calls;
      lastTriangles = renderer.info.render.triangles;
    },
    onRemove(m) {
      m.getCanvas().removeEventListener('webglcontextlost', onLost);
      // Disposing geometries/materials releases their buffers, VAOs and programs. The renderer
      // itself is kept for this context (see rendererFor); only its per-frame lists are dropped.
      clearContent();
      geometriesAfterRelease = renderer?.info.memory.geometries ?? null;
      renderer?.renderLists.dispose();
      renderer = null;
      disposed = true;
    },
  };

  map.addLayer(layer);

  return {
    setBuildings(next) {
      buildings = next;
      if (renderer) build();
    },
    setPlantings(next) {
      plantings = next;
      if (renderer) build();
    },
    stats(): SceneStats {
      const counts = Object.fromEntries(BASES.map((b) => [b, 0])) as Record<HeightBasis, number>;
      for (const b of buildings) counts[b.height_basis] += 1;
      return {
        buildingsByBasis: counts,
        plantings: plantings.length,
        geometries: renderer?.info.memory.geometries ?? 0,
        textures: renderer?.info.memory.textures ?? 0,
        programs: renderer?.info.programs?.length ?? 0,
        drawCalls: lastCalls,
        triangles: lastTriangles,
        disposed,
        geometriesAfterRelease,
      };
    },
    describe(): BasisStyle[] {
      return BASES.filter((b) => buildings.some((x) => x.height_basis === b)).map((basis) => {
        const parts = content.children.filter((c) => c.userData.basis === basis);
        const mesh = parts.find((c): c is THREE.Mesh => c instanceof THREE.Mesh);
        const lines = parts.find((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);
        const fillMat = mesh?.material as THREE.Material | undefined;
        return {
          basis,
          extruded: Boolean(mesh),
          fillOpacity: fillMat ? (fillMat.transparent ? fillMat.opacity : 1) : null,
          dashedEdges: lines?.material instanceof THREE.LineDashedMaterial,
        };
      });
    },
    alignmentErrorPx(lngLat) {
      if (!lastMvp) return null;
      const m = MercatorCoordinate.fromLngLat({ lng: lngLat[0], lat: lngLat[1] }, 0);
      const local = new THREE.Vector3((m.x - origin.x) / scale, -(m.y - origin.y) / scale, 0);
      const clip = new THREE.Vector4(local.x, local.y, local.z, 1)
        .applyMatrix4(modelMatrix)
        .applyMatrix4(new THREE.Matrix4().fromArray(lastMvp));
      const x = ((clip.x / clip.w + 1) / 2) * canvasRect.width;
      const y = ((1 - clip.y / clip.w) / 2) * canvasRect.height;
      const p = map.project({ lng: lngLat[0], lat: lngLat[1] });
      return Math.hypot(p.x - x, p.y - y);
    },
    remove() {
      if (map.getLayer(options.id)) map.removeLayer(options.id);
    },
  };
}
