import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, toApiError, unwrap } from './transport';

const problem = (status: number, code: string) => ({
  type: 'https://team-vtiposhnik.example/problems/x',
  title: 't',
  status,
  detail: 'd',
  code,
  request_id: '00000000-0000-0000-0000-000000000009',
  current_revision_id: null,
  field_errors: [],
  blockers: [],
});

describe('toApiError', () => {
  it('maps problem+json statuses to categories', () => {
    expect(toApiError(401, problem(401, 'AUTH')).category).toBe('unauthenticated');
    expect(toApiError(403, problem(403, 'FORBIDDEN')).category).toBe('forbidden');
    expect(toApiError(412, problem(412, 'REVISION_CONFLICT')).category).toBe('revision_conflict');
    expect(toApiError(409, problem(409, 'STATE')).category).toBe('state_conflict');
    expect(toApiError(422, problem(422, 'INVALID')).category).toBe('invalid');
  });
  it('treats a bodiless 5xx from the proxy as unavailable backend', () => {
    const e = toApiError(502, '');
    expect(e.category).toBe('unavailable');
    expect(e.retryable).toBe(true);
  });
  it('never retries permission or validation errors', () => {
    expect(toApiError(403, problem(403, 'F')).retryable).toBe(false);
    expect(toApiError(422, problem(422, 'I')).retryable).toBe(false);
  });
});

describe('client transport', () => {
  it('adds CSRF only to mutating requests and returns ETag', async () => {
    const seen: Request[] = [];
    const fetchStub = async (req: Request) => {
      seen.push(req);
      return new Response(JSON.stringify({ status: 'ok', release: 'test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"r1"' },
      });
    };
    const api = createApiClient({ baseUrl: 'http://x', fetch: fetchStub as typeof fetch, getCsrfToken: () => 'csrf-1' });
    const res = await unwrap(api.GET('/health/ready'));
    expect(res.etag).toBe('"r1"');
    expect(seen[0]!.headers.get('X-CSRF-Token')).toBeNull();
    await api.POST('/v1/problems/{problem_id}/dismiss', {
      params: {
        path: { problem_id: '00000000-0000-0000-0000-000000000001' },
        header: { 'X-CSRF-Token': 'csrf-1', 'Idempotency-Key': 'key-12345678' },
      },
      body: { reason: 'r' },
    } as never);
    expect(seen[1]!.headers.get('X-CSRF-Token')).toBe('csrf-1');
  });
  it('turns a timeout into a typed error instead of hanging', async () => {
    const never = (req: Request) =>
      new Promise<Response>((_, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const api = createApiClient({ baseUrl: 'http://x', fetch: never as typeof fetch, timeoutMs: 20 });
    await expect(unwrap(api.GET('/health/ready'))).rejects.toMatchObject({ category: 'timeout' });
  });
  it('turns a refused connection into a network error', async () => {
    const refused = async () => {
      throw new TypeError('Failed to fetch');
    };
    const api = createApiClient({ baseUrl: 'http://x', fetch: refused as typeof fetch });
    const err = await unwrap(api.GET('/health/ready')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).category).toBe('network');
  });
});
