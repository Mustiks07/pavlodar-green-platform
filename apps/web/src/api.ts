import { keepPreviousData, QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ApiError, createApiClient, unwrap, type City, type Health, type MapFeature, type MapLayer, type User } from '@pg/api-client';

export const REQUEST_TIMEOUT_MS = 15_000;

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export const api = createApiClient({ timeoutMs: REQUEST_TIMEOUT_MS, getCsrfToken: () => csrfToken });

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Never retry validation/permission errors; transient ones at most twice (TZ §24).
      retry: (count, err) => err instanceof ApiError && err.retryable && count < 2,
      retryDelay: (n) => Math.min(8000, 1000 * 2 ** n) + Math.random() * 300,
    },
    // A write while offline fails at once with a network error instead of waiting silently;
    // drafts stay local and the user decides when to retry.
    mutations: { retry: false, networkMode: 'always' },
  },
});

export const qk = {
  health: ['health'] as const,
  capabilities: ['capabilities'] as const,
  me: ['me'] as const,
  cities: ['cities'] as const,
  city: (id: string) => ['city', id] as const,
  layers: (cityId: string) => ['map-layers', cityId] as const,
  feature: (featureId: string) => ['map-feature', featureId] as const,
  list: (resource: string, params: Record<string, unknown>) => ['list', resource, params] as const,
};

export function useHealth() {
  return useQuery({
    queryKey: qk.health,
    queryFn: async ({ signal }) => (await unwrap<Health>(api.GET('/health/ready', { signal }))).data,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    // The result is shared through SessionContext and read by components that mount later
    // (lazy routes). Tracked-property notifications would skip re-rendering the provider when
    // only status changes, leaving consumers with a stale "pending" snapshot.
    notifyOnChangeProps: 'all',
    queryFn: async ({ signal }) => {
      const { data } = await unwrap<User>(api.GET('/v1/me', { signal }));
      setCsrfToken(data.csrf_token);
      return data;
    },
    retry: (count, err) => err instanceof ApiError && err.category !== 'unauthenticated' && err.retryable && count < 2,
  });
}

export function useCities(enabled: boolean) {
  return useQuery({
    queryKey: qk.cities,
    enabled,
    notifyOnChangeProps: 'all', // shared through SessionContext, see useMe
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/cities', { params: { query: { limit: 200 } }, signal }))).data,
  });
}

export function useCity(cityId: string | null) {
  return useQuery({
    queryKey: qk.city(cityId ?? ''),
    enabled: Boolean(cityId),
    queryFn: async ({ signal }) =>
      (await unwrap<City>(api.GET('/v1/cities/{city_id}', { params: { path: { city_id: cityId! } }, signal }))).data,
  });
}

/**
 * Published layer manifests of the city (all pages). A publish in this tab invalidates the key;
 * a publish elsewhere shows up on focus/reconnect, and a tile 404 (version switched) refetches.
 */
export function useMapLayers(cityId: string | null) {
  return useQuery({
    queryKey: qk.layers(cityId ?? ''),
    enabled: Boolean(cityId),
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const items: MapLayer[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const { data } = await unwrap(api.GET('/v1/map/layers', { params: { query: { city_id: cityId!, limit: 200, ...(cursor ? { cursor } : {}) } }, signal }));
        items.push(...data.items);
        if (!data.next_cursor) return { items, truncated: false };
        cursor = data.next_cursor;
      }
      return { items, truncated: true };
    },
  });
}

/**
 * Server card of a published map feature (getMapFeature): label, geometry and source lineage of
 * the current published version. 404 covers both "not in the current version" and "no grant".
 */
export function useMapFeature(featureId: string | null) {
  const available = useOperationAvailable('getMapFeature');
  return {
    available,
    query: useQuery({
      queryKey: qk.feature(featureId ?? ''),
      enabled: Boolean(featureId) && available !== false,
      staleTime: 60_000,
      queryFn: async ({ signal }) =>
        (await unwrap<MapFeature>(api.GET('/v1/map/features/{feature_id}', { params: { path: { feature_id: featureId! } }, signal }))).data,
    }),
  };
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** Cursor pagination for any list endpoint; filters are part of the key so a stale page set never mixes in. */
export function useCursorList<T>(
  resource: string,
  params: Record<string, string | number | undefined>,
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: qk.list(resource, params),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export interface ServerCapabilities {
  release: string;
  operations: ReadonlySet<string>;
}

/**
 * The API publishes only implemented operations at /openapi.json (ADR-003). The UI uses
 * it to explain an unavailable feature precisely instead of reporting "not found".
 * When the document itself cannot be read, capabilities are unknown and nothing is blocked.
 */
export function useCapabilities() {
  return useQuery({
    queryKey: qk.capabilities,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }): Promise<ServerCapabilities | null> => {
      const res = await fetch('/openapi.json', { signal, credentials: 'same-origin' }).catch(() => null);
      if (!res?.ok) return null;
      const doc = (await res.json().catch(() => null)) as { info?: { version?: string }; paths?: Record<string, Record<string, { operationId?: string }>> } | null;
      if (!doc?.paths) return null;
      const operations = new Set<string>();
      for (const item of Object.values(doc.paths)) for (const op of Object.values(item)) if (op?.operationId) operations.add(op.operationId);
      return { release: doc.info?.version ?? '?', operations };
    },
  });
}

/** true = implemented, false = server says not implemented, null = unknown yet. */
export function useOperationAvailable(operationId: string): boolean | null {
  const caps = useCapabilities();
  if (!caps.data) return null;
  return caps.data.operations.has(operationId);
}
