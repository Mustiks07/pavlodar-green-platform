import createClient from 'openapi-fetch';
import type { components, paths } from './generated/schema';

export type Schemas = components['schemas'];
export type ProblemDetails = Schemas['Problem'];

/**
 * UI-facing error categories. They map 1:1 to the status codes in TZ §23, plus the
 * transport failures that never reach the server. Components choose a state view by
 * category, never by parsing `detail` text.
 */
export type ApiErrorCategory =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'state_conflict'
  | 'revision_conflict'
  | 'invalid'
  | 'rate_limited'
  | 'unavailable'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted';

export class ApiError extends Error {
  readonly category: ApiErrorCategory;
  readonly status: number | null;
  readonly problem: ProblemDetails | null;

  constructor(category: ApiErrorCategory, status: number | null, problem: ProblemDetails | null, message?: string) {
    super(message ?? problem?.detail ?? category);
    this.name = 'ApiError';
    this.category = category;
    this.status = status;
    this.problem = problem;
  }

  get requestId(): string | null {
    return this.problem?.request_id ?? null;
  }

  /** Only transient failures are retried; validation/permission errors never are (TZ §24). */
  get retryable(): boolean {
    return ['unavailable', 'network', 'timeout', 'rate_limited'].includes(this.category);
  }
}

export function categoryForStatus(status: number): ApiErrorCategory {
  switch (status) {
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'state_conflict';
    case 412:
      return 'revision_conflict';
    case 422:
      return 'invalid';
    case 429:
      return 'rate_limited';
    case 502:
    case 503:
    case 504:
      return 'unavailable';
    default:
      return status >= 500 ? 'server' : 'invalid';
  }
}

export function isProblem(body: unknown): body is ProblemDetails {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.status === 'number' && typeof b.code === 'string' && typeof b.title === 'string';
}

export function toApiError(status: number, body: unknown): ApiError {
  const problem = isProblem(body) ? body : null;
  // A proxy that cannot reach the API answers 500/502 without problem+json:
  // that is an unavailable backend, not a server-side bug report.
  if (!problem && status >= 500) return new ApiError('unavailable', status, null);
  return new ApiError(categoryForStatus(status), status, problem);
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface ApiClientOptions {
  baseUrl?: string;
  /** Hard limit per request so the UI never shows an endless spinner (TZ §22). */
  timeoutMs?: number;
  getCsrfToken?: () => string | null;
  fetch?: typeof fetch;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function createApiClient(options: ApiClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const guardedFetch = async (input: Request): Promise<Response> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    const headers = new Headers(input.headers);
    if (MUTATING.has(input.method)) {
      const token = options.getCsrfToken?.();
      if (token && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
    }
    const request = new Request(input, { headers, signal, credentials: 'same-origin' });
    try {
      return await baseFetch(request);
    } catch (err) {
      if (timeout.aborted) throw new ApiError('timeout', null, null);
      if (input.signal.aborted) throw new ApiError('aborted', null, null);
      throw new ApiError('network', null, null, err instanceof Error ? err.message : String(err));
    }
  };

  return createClient<paths>({ baseUrl: options.baseUrl ?? '', fetch: guardedFetch });
}

export type ApiClient = ReturnType<typeof createApiClient>;

export interface ApiResult<T> {
  data: T;
  etag: string | null;
}

/** Converts an openapi-fetch result into data or a typed ApiError. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ApiResult<T>> {
  const { data, error, response } = await call;
  if (!response.ok) throw toApiError(response.status, error);
  if (data === undefined && response.status !== 204) {
    throw new ApiError('server', response.status, null, 'Empty response body');
  }
  return { data: data as T, etag: response.headers.get('ETag') };
}
