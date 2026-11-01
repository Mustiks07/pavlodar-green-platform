import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, isProblem, newIdempotencyKey, toApiError, unwrap, type ExportArtifact, type ExportRequest, type Job } from '@pg/api-client';
import { Badge, Button, formatDateTime, formatNumber, JobStatus, Notice, Skeleton, StateView } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { useJob } from '../jobs/useJob';

type Kind = ExportRequest['target_kind'];
type Format = ExportRequest['format'];
const FORMATS: Format[] = ['pdf', 'xlsx'];

/**
 * Export state lives in the URL as repeated `export=<target>:<format>:<job|art>:<id>` entries, so
 * reload resumes a running export and keeps a finished artifact.
 */
const PARAM = 'export';
type Entry = { target: string; format: Format; kind: 'job' | 'art'; id: string };
const parse = (v: string): Entry | null => {
  const [target, format, kind, id] = v.split(':');
  return target && (format === 'pdf' || format === 'xlsx') && (kind === 'job' || kind === 'art') && id ? { target, format, kind, id } : null;
};
function useExportEntries(target: string) {
  const [params, setParams] = useSearchParams();
  const all = params.getAll(PARAM).map(parse).filter((e): e is Entry => e !== null);
  const set = (format: Format, next: Omit<Entry, 'target' | 'format'> | null) => {
    const live = new URLSearchParams(window.location.search);
    const kept = live.getAll(PARAM).filter((v) => !(v.startsWith(`${target}:${format}:`)));
    live.delete(PARAM);
    for (const v of kept) live.append(PARAM, v);
    if (next) live.append(PARAM, `${target}:${format}:${next.kind}:${next.id}`);
    setParams(live, { replace: true });
  };
  return { entries: all.filter((e) => e.target === target), set };
}

/** Bytes of a downloaded file, hex SHA-256 (integrity check against the server value only). */
async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const filenameOf = (res: Response, fallback: string) => {
  const cd = res.headers.get('Content-Disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(cd)?.[1];
  return star ? decodeURIComponent(star) : (plain ?? fallback);
};

interface Downloaded {
  bytes: number;
  type: string;
  filename: string;
  matches: boolean;
}

/**
 * A finished artifact (getExport): format, creation time, SHA-256 and the state of its signed link.
 * Downloads go through the server's download_url; an expired or rejected link is renewed by
 * calling getExport again, never by starting a new export. The file is not built or altered here.
 */
function ArtifactRow({ id, format, onGone }: { id: string; format: Format; onGone: () => void }) {
  const qc = useQueryClient();
  const artifact = useQuery({
    queryKey: ['export', id],
    retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status !== null && e.status < 500),
    queryFn: async ({ signal }) => (await unwrap<ExportArtifact>(api.GET('/v1/exports/{export_id}', { params: { path: { export_id: id } }, signal }))).data,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const [downloaded, setDownloaded] = useState<Downloaded | null>(null);
  const download = useMutation({
    mutationFn: async () => {
      // Renew a link that is about to expire; on a rejected token renew once and retry.
      let a = artifact.data!;
      if (Date.parse(a.expires_at) - Date.now() < 10_000) a = (await artifact.refetch()).data ?? a;
      let res = await fetch(a.download_url, { credentials: 'same-origin' });
      if (res.status === 403 || res.status === 410) {
        const body = await res.clone().json().catch(() => null);
        if (isProblem(body) && /export_download_(expired|invalid)/.test(body.code)) {
          a = (await qc.fetchQuery({ queryKey: ['export', id], staleTime: 0, queryFn: async () => (await unwrap<ExportArtifact>(api.GET('/v1/exports/{export_id}', { params: { path: { export_id: id } } }))).data })) ?? a;
          res = await fetch(a.download_url, { credentials: 'same-origin' });
        }
      }
      if (!res.ok) throw toApiError(res.status, await res.json().catch(() => null));
      const blob = await res.blob();
      const filename = filenameOf(res, `pavlodar_${a.target_kind}_${a.target_id}.${format}`);
      // Size, media type and SHA-256 are all server facts of the immutable artifact (contract 1.12.0).
      const type = res.headers.get('Content-Type') ?? '';
      const result: Downloaded = { bytes: blob.size, type, filename, matches: blob.size === a.byte_size && type.startsWith(a.media_type) && (await sha256Hex(blob)) === a.sha256 };
      if (result.matches) {
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
      }
      return result;
    },
    onSuccess: setDownloaded,
  });

  if (artifact.isPending) return <Skeleton lines={2} />;
  if (artifact.isError) {
    if (artifact.error instanceof ApiError && artifact.error.category === 'not_found') {
      return <StateView compact state="not_found" title={t('export.notFound')} description={t('export.notFound.desc')} actions={<Button size="sm" onClick={onGone}>{t('export.forget')}</Button>} />;
    }
    return <ApiErrorView compact error={artifact.error} onRetry={() => void artifact.refetch()} />;
  }
  const a = artifact.data;
  const expired = Date.parse(a.expires_at) <= now;
  return (
    <div className="exp-artifact" data-export-id={a.id} data-format={a.format}>
      <dl className="pg-dl">
        <dt>{t('export.format')}</dt>
        <dd>{a.format.toUpperCase()}</dd>
        <dt>{t('export.created')}</dt>
        <dd>{formatDateTime(a.created_at)}</dd>
        <dt>SHA-256</dt>
        <dd>
          <code className="pg-code" title={a.sha256}>
            {a.sha256.slice(0, 16)}…
          </code>
        </dd>
        <dt>{t('export.link')}</dt>
        <dd data-link-state={expired ? 'expired' : 'valid'}>
          {expired ? <Badge tone="neutral">{t('export.link.expired')}</Badge> : <Badge tone="positive">{t('export.link.valid', { time: formatDateTime(a.expires_at) ?? a.expires_at })}</Badge>}
        </dd>
        <dt>{t('export.size')}</dt>
        <dd data-byte-size={a.byte_size}>{t('export.size.value', { bytes: formatNumber(a.byte_size) ?? String(a.byte_size) })}</dd>
        <dt>{t('export.mediaType')}</dt>
        <dd>
          <code className="pg-code">{a.media_type}</code>
        </dd>
      </dl>
      <Button size="sm" variant="primary" icon="upload" busy={download.isPending} onClick={() => download.mutate()}>
        {t('export.download', { format: a.format.toUpperCase() })}
      </Button>
      {downloaded ? (
        downloaded.matches ? (
          <p className="pg-muted" role="status" data-download-ok="true">
            {t('export.downloaded', { name: downloaded.filename })}
          </p>
        ) : (
          <Notice tone="negative" title={t('export.mismatch')}>
            {t('export.mismatch.desc')}
          </Notice>
        )
      ) : null}
      {download.isError ? <ApiErrorView compact error={download.error} onRetry={() => download.mutate()} /> : null}
    </div>
  );
}

/** A running export job: progress, cancel; hands over to its artifact once the server finished. */
function JobRow({ id, onDone, onReset }: { id: string; onDone: (artifactId: string) => void; onReset: () => void }) {
  const { user, hasRole } = useSession();
  const job = useJob(id);
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await unwrap<Job>(
          api.POST('/v1/jobs/{job_id}/cancel', {
            params: { path: { job_id: id }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { reason: t('export.cancel.reason') },
          }),
        )
      ).data,
    onSuccess: (j) => qc.setQueryData(['job', j.id], j),
  });
  const done = job.data?.state === 'succeeded' ? job.data.result_ref_id : null;
  useEffect(() => {
    if (done) onDone(done);
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps
  if (job.isPending) return <Skeleton lines={1} />;
  if (job.isError) return <ApiErrorView compact error={job.error} onRetry={() => void job.refetch()} />;
  const active = ['queued', 'running', 'cancel_requested'].includes(job.data.state);
  return (
    <div className="exp-job" data-job-transport={job.transport}>
      <JobStatus job={job.data} onCancel={active && hasRole('specialist') ? () => cancel.mutate() : undefined} />
      {job.data.state === 'failed' || job.data.state === 'cancelled' ? (
        <Button size="sm" onClick={onReset}>
          {t('export.again')}
        </Button>
      ) : null}
    </div>
  );
}

function FormatRow({ kind, target, format }: { kind: Kind; target: string; format: Format }) {
  const { user, hasRole } = useSession();
  const startOk = useOperationAvailable('startExport');
  const { entries, set } = useExportEntries(target);
  const entry = entries.find((e) => e.format === format) ?? null;
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: async () =>
      (
        await unwrap<Job>(
          api.POST('/v1/exports', {
            params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { target_kind: kind, target_id: target, format, language: 'ru' },
          }),
        )
      ).data,
    onSuccess: (j) => {
      qc.setQueryData(['job', j.id], j);
      set(format, { kind: 'job', id: j.id });
    },
  });
  return (
    <section className="exp-row" aria-label={format.toUpperCase()} data-format={format}>
      <h4>{format.toUpperCase()}</h4>
      {entry?.kind === 'art' ? (
        <ArtifactRow id={entry.id} format={format} onGone={() => set(format, null)} />
      ) : entry?.kind === 'job' ? (
        <JobRow id={entry.id} onDone={(artifactId) => set(format, { kind: 'art', id: artifactId })} onReset={() => set(format, null)} />
      ) : startOk === false ? (
        <OperationUnavailable compact operationId="startExport" />
      ) : hasRole('specialist') ? (
        <Button size="sm" busy={start.isPending} onClick={() => start.mutate()}>
          {t('export.start', { format: format.toUpperCase() })}
        </Button>
      ) : (
        <p className="pg-muted">{t('export.role')}</p>
      )}
      {start.isError ? <ApiErrorView compact error={start.error} onRetry={() => start.mutate()} /> : null}
    </section>
  );
}

/** PDF/XLSX of an immutable target (calculation snapshot or program revision), built by the server. */
export function ExportPanel({ kind, target }: { kind: Kind; target: string }) {
  const available = useOperationAvailable('getExport');
  if (available === false) return <OperationUnavailable compact operationId="getExport" />;
  return (
    <div className="exp-panel" data-target={target}>
      <h3>{t('export.title')}</h3>
      <p className="pg-muted">{t(kind === 'calculation' ? 'export.desc.calculation' : 'export.desc.program')}</p>
      <div className="exp-rows">
        {FORMATS.map((f) => (
          <FormatRow key={f} kind={kind} target={target} format={f} />
        ))}
      </div>
    </div>
  );
}
