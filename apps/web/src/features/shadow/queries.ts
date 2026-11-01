import { useQuery } from '@tanstack/react-query';
import { ApiError, unwrap, type SpatialResult, type SpatialResultArtifact } from '@pg/api-client';
import { api, useOperationAvailable } from '../../api';

export const shadowKeys = {
  result: (id: string) => ['spatial-result', id] as const,
  artifact: (id: string) => ['spatial-result-artifact', id] as const,
};

const noRetryOn4xx = (n: number, e: unknown) => n < 2 && !(e instanceof ApiError && e.status !== null && e.status < 500);

/** Immutable server result (getSpatialResult); never recomputed in the browser. */
export function useSpatialResult(id: string | null) {
  const available = useOperationAvailable('getSpatialResult');
  return {
    available,
    query: useQuery({
      queryKey: shadowKeys.result(id ?? ''),
      enabled: Boolean(id) && available !== false,
      staleTime: Infinity,
      retry: noRetryOn4xx,
      queryFn: async ({ signal }) =>
        (await unwrap<SpatialResult>(api.GET('/v1/spatial-results/{result_id}', { params: { path: { result_id: id! } }, signal }))).data,
    }),
  };
}

/** Shadow geometry only from GET /v1/spatial-results/{id}/artifact (getSpatialResultArtifact). */
export function useShadowArtifact(result: SpatialResult | undefined) {
  const available = useOperationAvailable('getSpatialResultArtifact');
  const id = result && result.artifact_url ? result.id : null;
  return {
    available,
    query: useQuery({
      queryKey: shadowKeys.artifact(id ?? ''),
      enabled: Boolean(id) && available !== false,
      staleTime: Infinity,
      retry: noRetryOn4xx,
      queryFn: async ({ signal }) =>
        (await unwrap<SpatialResultArtifact>(api.GET('/v1/spatial-results/{result_id}/artifact', { params: { path: { result_id: id! } }, signal }))).data,
    }),
  };
}

/**
 * ISO date-time with the city's UTC offset for a wall-clock date and time in that time zone.
 * Only formats the request; the sun position and shadows are computed by the server.
 */
export function zonedIso(date: string, time: string, timeZone: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const asUtc = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const offsetMinutes = (instant: number) => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(instant).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  };
  // Two passes settle the offset around DST changes.
  let offset = offsetMinutes(asUtc);
  offset = offsetMinutes(asUtc - offset * 60_000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date}T${time}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Today's date (YYYY-MM-DD) in the city's time zone. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
}
