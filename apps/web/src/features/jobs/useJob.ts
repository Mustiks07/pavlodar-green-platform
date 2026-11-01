import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap, type Job, type JobEvent } from '@pg/api-client';
import { api, useOperationAvailable } from '../../api';

export const TERMINAL_JOB_STATES: Job['state'][] = ['succeeded', 'failed', 'cancelled'];
export type JobTransport = 'stream' | 'polling';

const jobKey = (id: string) => ['job', id] as const;

/**
 * Job state from the resumable SSE stream (streamJobEvents, ADR-035) with getJob polling as the
 * fallback: while the stream is unavailable, failing or reconnecting, the job is polled with
 * backoff. Events carry state/phase/progress; the full Job (result_ref_id, error, attempt) is read
 * with getJob when it starts and after a terminal event. EventSource resumes with Last-Event-ID.
 */
export function useJob(jobId: string | null) {
  const qc = useQueryClient();
  const streamOk = useOperationAvailable('streamJobEvents');
  const [startedAt] = useState(() => Date.now());
  const [streaming, setStreaming] = useState(false);
  const query = useQuery({
    queryKey: jobKey(jobId ?? ''),
    enabled: Boolean(jobId),
    queryFn: async ({ signal }) => (await unwrap<Job>(api.GET('/v1/jobs/{job_id}', { params: { path: { job_id: jobId! } }, signal }))).data,
    refetchInterval: (q) => {
      const s = q.state.data?.state;
      if (s && TERMINAL_JOB_STATES.includes(s)) return false;
      if (streaming) return false;
      const age = Date.now() - startedAt;
      return age < 15_000 ? 1000 : age < 120_000 ? 3000 : 6000;
    },
  });
  const terminal = query.data ? TERMINAL_JOB_STATES.includes(query.data.state) : false;

  useEffect(() => {
    if (!jobId || terminal || streamOk === false || typeof EventSource === 'undefined') {
      setStreaming(false);
      return;
    }
    const source = new EventSource(`/v1/jobs/${jobId}/events`);
    source.onopen = () => setStreaming(true);
    source.addEventListener('job', (e) => {
      let event: JobEvent;
      try {
        event = JSON.parse((e as MessageEvent<string>).data) as JobEvent;
      } catch {
        return;
      }
      if (event.job_id !== jobId) return;
      qc.setQueryData<Job>(jobKey(jobId), (old) => (old ? { ...old, state: event.state, phase: event.phase, progress: event.progress } : old));
      if (TERMINAL_JOB_STATES.includes(event.state)) {
        source.close();
        setStreaming(false);
        // The terminal Job carries result_ref_id / error / completed_at.
        void qc.invalidateQueries({ queryKey: jobKey(jobId) });
      }
    });
    // A transport error: the browser retries (CONNECTING) or gives up (CLOSED); poll meanwhile.
    source.onerror = () => setStreaming(source.readyState === EventSource.OPEN);
    return () => {
      source.close();
      setStreaming(false);
    };
  }, [jobId, terminal, streamOk, qc]);

  return { ...query, transport: (streaming ? 'stream' : 'polling') as JobTransport };
}
