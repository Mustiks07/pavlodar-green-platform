import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const JOB = '11111111-1111-4111-8111-111111111111';
const base = {
  id: JOB,
  kind: 'import',
  state: 'queued',
  phase: null,
  progress: null,
  input_ref_id: JOB,
  result_ref_id: null,
  attempt: 1,
  created_at: '2026-10-30T10:00:00Z',
  started_at: null,
  completed_at: null,
  error: null,
};
let serverJob: Record<string, unknown> = base;
let streamAvailable: boolean | null = true;
const get = vi.fn(async () => ({ data: serverJob, response: new Response(null, { status: 200 }) }));

vi.mock('../../api', () => ({
  api: { GET: (...args: unknown[]) => get(...(args as [])) },
  useOperationAvailable: () => streamAvailable,
}));
vi.mock('@pg/api-client', async (orig) => {
  const actual = await orig<typeof import('@pg/api-client')>();
  return { ...actual, unwrap: async (p: Promise<{ data: unknown }>) => ({ data: (await p).data }) };
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: object) {
    for (const fn of this.listeners.get('job') ?? []) fn(new MessageEvent('job', { data: JSON.stringify(data) }));
  }
  fail(state: number) {
    this.readyState = state;
    this.onerror?.();
  }
}

const { useJob } = await import('./useJob');

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  serverJob = base;
  streamAvailable = true;
  get.mockClear();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

describe('useJob', () => {
  it('follows the SSE stream and reads the full job once it is terminal', async () => {
    const { result } = renderHook(() => useJob(JOB), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.state).toBe('queued'));
    const es = FakeEventSource.instances.at(-1)!;
    expect(es.url).toBe(`/v1/jobs/${JOB}/events`);
    act(() => es.open());
    expect(result.current.transport).toBe('stream');
    act(() => es.emit({ event_id: '7', job_id: JOB, state: 'running', phase: 'validating', progress: 0.5, occurred_at: '2026-10-30T10:00:01Z' }));
    await waitFor(() => expect(result.current.data).toMatchObject({ state: 'running', phase: 'validating', progress: 0.5 }));
    const reads = get.mock.calls.length;
    serverJob = { ...base, state: 'succeeded', progress: 1, result_ref_id: '22222222-2222-4222-8222-222222222222' };
    act(() => es.emit({ event_id: '8', job_id: JOB, state: 'succeeded', phase: null, progress: 1, occurred_at: '2026-10-30T10:00:02Z' }));
    expect(es.closed).toBe(true);
    await waitFor(() => expect(result.current.data?.result_ref_id).toBe('22222222-2222-4222-8222-222222222222'));
    expect(get.mock.calls.length).toBe(reads + 1);
  });

  it('ignores events of other jobs and malformed data', async () => {
    const { result } = renderHook(() => useJob(JOB), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.state).toBe('queued'));
    const es = FakeEventSource.instances.at(-1)!;
    act(() => es.emit({ event_id: '1', job_id: '33333333-3333-4333-8333-333333333333', state: 'failed', phase: null, progress: null, occurred_at: 'x' }));
    act(() => es.listeners.get('job')!.forEach((fn) => fn(new MessageEvent('job', { data: '{not json' }))));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.data?.state).toBe('queued');
    expect(es.closed).toBe(false);
  });

  it('polls when the server does not offer the stream', async () => {
    streamAvailable = false;
    const { result } = renderHook(() => useJob(JOB), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.state).toBe('queued'));
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(result.current.transport).toBe('polling');
  });

  it('falls back to polling while the stream errors, and back to the stream when it reopens', async () => {
    const { result } = renderHook(() => useJob(JOB), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.state).toBe('queued'));
    const es = FakeEventSource.instances.at(-1)!;
    act(() => es.open());
    expect(result.current.transport).toBe('stream');
    act(() => es.fail(FakeEventSource.CONNECTING));
    expect(result.current.transport).toBe('polling');
    act(() => es.open());
    expect(result.current.transport).toBe('stream');
    act(() => es.fail(FakeEventSource.CLOSED));
    expect(result.current.transport).toBe('polling');
  });

  it('opens no stream for a job that is already terminal', async () => {
    serverJob = { ...base, state: 'cancelled' };
    const { result } = renderHook(() => useJob(JOB), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.state).toBe('cancelled'));
    await waitFor(() => expect(FakeEventSource.instances.every((e) => e.closed)).toBe(true));
  });
});
