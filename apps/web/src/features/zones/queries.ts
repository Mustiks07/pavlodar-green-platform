import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { unwrap, type Scenario, type ScenarioRevision, type Zone, type ZoneContext, type ZonePage } from '@pg/api-client';
import { api, useOperationAvailable } from '../../api';

export const zk = {
  zones: (cityId: string) => ['zones', cityId] as const,
  zone: (id: string) => ['zone', id] as const,
  zoneVersion: (versionId: string) => ['zone-version', versionId] as const,
  zoneContext: (id: string) => ['zone-context', id] as const,
  zoneScenarios: (cityId: string, zoneId: string) => ['zone-scenarios', cityId, zoneId] as const,
  scenario: (id: string) => ['scenario', id] as const,
  revisions: (id: string) => ['scenario-revisions', id] as const,
  revision: (id: string) => ['scenario-revision', id] as const,
};

const MAX_ZONE_PAGES = 10;

/**
 * All zones of the city for the map (bounded: 10 pages x 200). Map tiles replace this
 * list in WP-04 once MVT publication exists; until then the bound is shown to the user.
 */
export function useZones(cityId: string | null) {
  const available = useOperationAvailable('listZones');
  return useQuery({
    queryKey: zk.zones(cityId ?? ''),
    enabled: Boolean(cityId) && available !== false,
    queryFn: async ({ signal }) => {
      const items: Zone[] = [];
      let cursor: string | undefined;
      let truncated = false;
      for (let page = 0; page < MAX_ZONE_PAGES; page++) {
        const { data } = await unwrap<ZonePage>(api.GET('/v1/zones', { params: { query: { city_id: cityId!, limit: 200, cursor } }, signal }));
        items.push(...data.items);
        if (!data.next_cursor) break;
        cursor = data.next_cursor;
        if (page === MAX_ZONE_PAGES - 1) truncated = true;
      }
      return { items, truncated };
    },
  });
}

export function useZone(zoneId: string | null) {
  return useQuery({
    queryKey: zk.zone(zoneId ?? ''),
    enabled: Boolean(zoneId),
    queryFn: ({ signal }) => unwrap<Zone>(api.GET('/v1/zones/{zone_id}', { params: { path: { zone_id: zoneId! } }, signal })),
  });
}

export function useZoneContext(zoneId: string | null) {
  const available = useOperationAvailable('getZoneContext');
  return {
    available,
    query: useQuery({
      queryKey: zk.zoneContext(zoneId ?? ''),
      enabled: Boolean(zoneId) && available !== false,
      queryFn: async ({ signal }) =>
        (await unwrap<ZoneContext>(api.GET('/v1/zones/{zone_id}/context', { params: { path: { zone_id: zoneId! } }, signal }))).data,
    }),
  };
}

export function useZoneScenarios(cityId: string, zoneId: string) {
  return useQuery({
    queryKey: zk.zoneScenarios(cityId, zoneId),
    queryFn: async ({ signal }) =>
      (await unwrap(api.GET('/v1/scenarios', { params: { query: { city_id: cityId, zone_id: zoneId, limit: 50 } }, signal }))).data,
  });
}

/** Scenario with its ETag: appending a revision sends it back as If-Match. */
export function useScenario(scenarioId: string) {
  return useQuery({
    queryKey: zk.scenario(scenarioId),
    queryFn: ({ signal }) => unwrap<Scenario>(api.GET('/v1/scenarios/{scenario_id}', { params: { path: { scenario_id: scenarioId } }, signal })),
  });
}

export function useRevisions(scenarioId: string) {
  return useQuery({
    queryKey: zk.revisions(scenarioId),
    queryFn: async ({ signal }) =>
      (await unwrap(api.GET('/v1/scenarios/{scenario_id}/revisions', { params: { path: { scenario_id: scenarioId }, query: { limit: 200 } }, signal })))
        .data,
  });
}

export function useRevision(revisionId: string | null) {
  return useQuery({
    queryKey: zk.revision(revisionId ?? ''),
    enabled: Boolean(revisionId),
    // Keep the previous revision on screen while the next one loads, so an open editor
    // (with unsaved edits and a pending re-base) is not unmounted mid-flow.
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) =>
      (await unwrap<ScenarioRevision>(api.GET('/v1/scenario-revisions/{revision_id}', { params: { path: { revision_id: revisionId! } }, signal })))
        .data,
  });
}

/** Immutable historical geometry of a zone (GET /v1/zone-versions/{version_id}, contract 1.1.0). */
export function useZoneVersion(versionId: string | null) {
  const available = useOperationAvailable('getZoneVersion');
  return {
    available,
    query: useQuery({
      queryKey: zk.zoneVersion(versionId ?? ''),
      enabled: Boolean(versionId) && available !== false,
      staleTime: Infinity, // versions never change
      queryFn: async ({ signal }) =>
        (await unwrap<Zone>(api.GET('/v1/zone-versions/{version_id}', { params: { path: { version_id: versionId! } }, signal }))).data,
    }),
  };
}
