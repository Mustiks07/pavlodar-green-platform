import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  newIdempotencyKey,
  putUpload,
  sha256Hex,
  unwrap,
  type City,
  type Dataset,
  type DatasetCreate,
  type ImportRequest,
  type Job,
  type UploadTicket,
} from '@pg/api-client';
import { Badge, Button, Card, Field, formatNumber, Input, JobStatus, Notice, Select, Skeleton, StateView } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { TERMINAL_JOB_STATES, useJob } from '../jobs/useJob';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { DatasetDetail } from '../resources/details';
import { productLabel } from '../../productCopy';
import {
  buildFieldMapping,
  CONTENT_TYPE,
  coordinateLikeColumns,
  formatFromName,
  PARSER_SUPPORTED,
  previewCsv,
  previewGeoJson,
  type FilePreview,
  type ImportFormat,
} from './preview';

const KINDS: DatasetCreate['kind'][] = ['zones', 'green_inventory', 'soil', 'restrictions', 'buildings', 'roads', 'water', 'population', 'social_poi', 'boundary', 'observations', 'catalog', 'stock', 'rates', 'weather', 'raster'];
const MAX_BYTES = 500_000_000; // contract UploadRequest.byte_size maximum
const PREVIEW_BYTES = 20_000_000;
const KIND_LABELS: Partial<Record<DatasetCreate['kind'], string>> = {
  zones: 'Проектные участки', green_inventory: 'Зелёные насаждения', soil: 'Почвы', restrictions: 'Ограничения',
  buildings: 'Здания', roads: 'Дороги', water: 'Водные объекты', population: 'Население', social_poi: 'Социальные объекты',
  boundary: 'Граница города', observations: 'Наблюдения', catalog: 'Каталог растений', stock: 'Посадочный материал',
  rates: 'Расценки', weather: 'Погода', raster: 'Растровый слой',
};

type Step = 'idle' | 'hashing' | 'ticket' | 'uploading' | 'starting' | 'tracking';

const TERMINAL = TERMINAL_JOB_STATES;

function DatasetPicker({ city, value, onChange }: { city: City; value: string; onChange: (id: string) => void }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const createOk = useOperationAvailable('createDataset');
  const list = useQuery({
    queryKey: ['datasets-for-import', city.id],
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/datasets', { params: { query: { city_id: city.id, limit: 200 } }, signal }))).data.items,
  });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Omit<DatasetCreate, 'city_id'>>({ name: '', kind: 'zones', owner: '', license: '', access_level: 'internal', source_uri: null });
  const [key, setKey] = useState(newIdempotencyKey);
  const create = useMutation({
    mutationFn: async () =>
      unwrap<Dataset>(
        api.POST('/v1/datasets', {
          params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': key } },
          body: { ...form, city_id: city.id, name: form.name.trim(), owner: form.owner.trim(), license: form.license.trim(), source_uri: form.source_uri?.trim() || null },
        }),
      ),
    onSuccess: ({ data }) => {
      void qc.invalidateQueries({ queryKey: ['datasets-for-import', city.id] });
      void qc.invalidateQueries({ queryKey: ['list', 'datasets'] });
      setCreating(false);
      setKey(newIdempotencyKey());
      onChange(data.id);
    },
  });
  if (list.isPending) return <Skeleton lines={2} />;
  if (list.isError) return <ApiErrorView compact error={list.error} onRetry={() => void list.refetch()} />;
  return (
    <div className="imp-dataset">
      <Field label={t('imp.dataset')} hint={t('imp.dataset.hint')}>
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">{t('imp.dataset.choose')}</option>
            {list.data.map((d) => (
              <option key={d.id} value={d.id}>
                {productLabel(d.name)} · {KIND_LABELS[d.kind] ?? d.kind}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {createOk === false ? null : creating ? (
        <Card title={t('imp.dataset.new')}>
          <div className="imp-grid">
            <Field label={t('col.name')} required>
              {({ id }) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
            </Field>
            <Field label={t('col.kind')}>
              {({ id }) => (
                <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as DatasetCreate['kind'] })}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k] ?? k}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('col.owner')} required hint={t('imp.owner.hint')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />}
            </Field>
            <Field label={t('col.license')} required hint={t('imp.license.hint')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })} />}
            </Field>
            <Field label={t('col.access')}>
              {({ id }) => (
                <Select id={id} value={form.access_level} onChange={(e) => setForm({ ...form, access_level: e.target.value as DatasetCreate['access_level'] })}>
                  {(['internal', 'restricted', 'public'] as const).map((a) => (
                    <option key={a} value={a}>
                      {t(`access.${a}` as AppKey)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('imp.sourceUri')}>
              {({ id }) => <Input id={id} type="url" value={form.source_uri ?? ''} onChange={(e) => setForm({ ...form, source_uri: e.target.value })} />}
            </Field>
          </div>
          {create.isError ? <ApiErrorView compact error={create.error} /> : null}
          <div className="scn-actions">
            <Button
              variant="primary"
              busy={create.isPending}
              disabled={!form.name.trim() || !form.owner.trim() || !form.license.trim()}
              onClick={() => create.mutate()}
            >
              {t('imp.dataset.create')}
            </Button>
            <Button onClick={() => setCreating(false)}>{t('action.cancel')}</Button>
          </div>
        </Card>
      ) : (
        <Button icon="plus" onClick={() => setCreating(true)}>
          {t('imp.dataset.new')}
        </Button>
      )}
    </div>
  );
}

function PreviewView({ preview, format }: { preview: FilePreview; format: ImportFormat }) {
  if (preview.kind === 'geojson') {
    return (
      <div className="imp-preview">
        <p>
          {t('imp.preview.features', { n: formatNumber(preview.featureCount) ?? '0' })} ·{' '}
          {Object.entries(preview.geometryTypes)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ') || '—'}
        </p>
        {preview.bbox ? (
          <p className="pg-muted">
            {t('imp.preview.bbox')}: {preview.bbox.map((v) => v.toFixed(5)).join(', ')}
          </p>
        ) : null}
        {preview.problems.length ? (
          <ul className="draw-issues">
            {preview.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  const coords = coordinateLikeColumns(preview.header);
  return (
    <div className="imp-preview">
      {coords.length ? (
        <Notice tone="warning" title={t('imp.csv.noGeometry')}>
          {t('imp.csv.noGeometry.desc', { cols: coords.join(', ') })}
        </Notice>
      ) : (
        <p className="pg-muted">{t('imp.csv.table')}</p>
      )}
      <div className="pg-table-wrap">
        <div className="pg-table-scroll" style={{ maxHeight: '14rem' }}>
          <table className="pg-table pg-table--compact">
            <caption className="pg-sr-only">{t('imp.preview.csvCaption')}</caption>
            <thead>
              <tr>
                {preview.header.map((h, i) => (
                  <th key={`${h}-${i}`} scope="col">
                    {h || '—'}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i}>
                  {preview.header.map((_, j) => (
                    <td key={j}>{r[j] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pg-table-foot">
          {t('imp.preview.rows', { n: preview.previewedRows })}
          {preview.truncated ? ` · ${t('imp.preview.partial')}` : ''}
        </div>
      </div>
      {preview.problems.length ? (
        <ul className="draw-issues">
          {preview.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <p className="pg-muted">{t(format === 'csv' ? 'imp.csv.limits' : 'imp.geojson.limits')}</p>
    </div>
  );
}

export function ImportWizard({ city }: { city: City }) {
  const { user, hasRole } = useSession();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const jobId = params.get('job');
  const ticketOk = useOperationAvailable('createUploadTicket');
  const putOk = useOperationAvailable('putUploadContent');
  const importOk = useOperationAvailable('startImport');

  const [datasetId, setDatasetId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<ImportFormat | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [rename, setRename] = useState<Record<string, string>>({});
  const [method, setMethod] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [resolution, setResolution] = useState('');
  const [step, setStep] = useState<Step>('idle');
  const [sent, setSent] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [keys, setKeys] = useState(() => ({ ticket: newIdempotencyKey(), put: newIdempotencyKey(), start: newIdempotencyKey() }));
  const [ticket, setTicket] = useState<UploadTicket | null>(null);
  const job = useJob(jobId);
  const finished = job.data && TERMINAL.includes(job.data.state) ? job.data.id : null;
  // A finished import adds a version: refresh the dataset card and readiness, not just the job.
  useEffect(() => {
    if (!finished) return;
    const ds = params.get('importDataset');
    if (ds) void qc.invalidateQueries({ queryKey: ['dataset-versions', ds] });
    void qc.invalidateQueries({ queryKey: ['source-readiness'] });
    void qc.invalidateQueries({ queryKey: ['list', 'datasets'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  const fields = useMemo(() => (preview?.kind === 'geojson' ? preview.fields : preview?.kind === 'csv' ? preview.header : []), [preview]);

  useEffect(() => {
    setInclude(Object.fromEntries(fields.map((f) => [f, true])));
    setRename({});
  }, [fields]);

  const onFile = async (f: File | null) => {
    setFile(f);
    setPreview(null);
    setError(null);
    setTicket(null);
    setKeys({ ticket: newIdempotencyKey(), put: newIdempotencyKey(), start: newIdempotencyKey() });
    const fmt = f ? formatFromName(f.name) : null;
    setFormat(fmt);
    if (!f || !fmt || !PARSER_SUPPORTED[fmt]) return;
    const slice = f.size > PREVIEW_BYTES ? f.slice(0, PREVIEW_BYTES) : f;
    const text = await slice.text();
    setPreview(fmt === 'geojson' ? (f.size > PREVIEW_BYTES ? null : previewGeoJson(text)) : previewCsv(text, f.size > PREVIEW_BYTES));
  };

  const run = async () => {
    if (!file || !format || !datasetId || !user) return;
    setError(null);
    try {
      const contentType = CONTENT_TYPE[format];
      let tk = ticket;
      if (!tk) {
        setStep('hashing');
        const sha256 = await sha256Hex(file);
        setStep('ticket');
        const { data } = await unwrap<UploadTicket>(
          api.POST('/v1/datasets/{dataset_id}/uploads', {
            params: { path: { dataset_id: datasetId }, header: { 'X-CSRF-Token': user.csrf_token, 'Idempotency-Key': keys.ticket } },
            body: { filename: file.name, content_type: contentType, byte_size: file.size, sha256 },
          }),
        );
        if (data.required_content_type !== contentType) {
          throw new ApiError('invalid', null, null, t('imp.err.contentType', { want: data.required_content_type, have: contentType }));
        }
        tk = data;
        setTicket(data);
      }
      setStep('uploading');
      setSent({ done: 0, total: file.size });
      await putUpload(tk.put_url, file, {
        csrfToken: user.csrf_token,
        idempotencyKey: keys.put,
        contentType,
        onProgress: (done, total) => setSent({ done, total }),
      });
      setStep('starting');
      const body: ImportRequest = {
        upload_id: tk.upload_id,
        format,
        source_crs: 'EPSG:4326',
        field_mapping: buildFieldMapping(fields, include, rename),
        observed_at: observedAt ? `${observedAt}T00:00:00Z` : null,
        method: method.trim(),
        spatial_resolution_m: resolution ? Number(resolution) : null,
      };
      const { data: started } = await unwrap<Job>(
        api.POST('/v1/datasets/{dataset_id}/imports', {
          params: { path: { dataset_id: datasetId }, header: { 'X-CSRF-Token': user.csrf_token, 'Idempotency-Key': keys.start } },
          body,
        }),
      );
      qc.setQueryData(['job', started.id], started);
      const next = new URLSearchParams(params);
      next.set('job', started.id);
      next.set('importDataset', datasetId);
      setParams(next, { replace: true });
      setStep('tracking');
    } catch (e) {
      setError(e);
      setStep('idle');
    }
  };

  const cancel = useMutation({
    mutationFn: async () =>
      unwrap<Job>(
        api.POST('/v1/jobs/{job_id}/cancel', {
          params: { path: { job_id: jobId! }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
          body: { reason: t('imp.cancel.reason') },
        }),
      ),
    onSuccess: ({ data }) => qc.setQueryData(['job', data.id], data),
  });

  const resetTracking = () => {
    const next = new URLSearchParams(params);
    next.delete('job');
    next.delete('importDataset');
    setParams(next, { replace: true });
    setStep('idle');
    setTicket(null);
    setFile(null);
    setPreview(null);
    setFormat(null);
    setSent(null);
    setKeys({ ticket: newIdempotencyKey(), put: newIdempotencyKey(), start: newIdempotencyKey() });
  };

  if (!hasRole('specialist')) return <Notice tone="neutral" icon="lock" title={t('imp.role')} />;
  for (const [op, ok] of [['createUploadTicket', ticketOk], ['putUploadContent', putOk], ['startImport', importOk]] as const) {
    if (ok === false) return <OperationUnavailable compact operationId={op} />;
  }

  // Tracking an import (also after reload: ?job= in the URL)
  if (jobId) {
    const j = job.data;
    const resultDatasetId = params.get('importDataset');
    return (
      <Card title={t('imp.tracking')}>
        {job.isPending ? <Skeleton lines={2} /> : job.isError ? <ApiErrorView compact error={job.error} onRetry={() => void job.refetch()} /> : null}
        {j ? <span hidden data-job-transport={job.transport} /> : null}
        {j ? <JobStatus job={j} timeZone={city.timezone} onCancel={j.state === 'queued' || j.state === 'running' ? () => cancel.mutate() : undefined} /> : null}
        {cancel.isError ? <ApiErrorView compact error={cancel.error} /> : null}
        {j?.state === 'succeeded' && resultDatasetId ? (
          <>
            <Notice tone="info" icon="checkCircle" title={t('imp.done')}>
              {t('imp.done.desc')}
            </Notice>
            <ImportedVersion datasetId={resultDatasetId} versionId={j.result_ref_id} cityId={city.id} />
          </>
        ) : null}
        {j?.state === 'failed' ? <Notice tone="negative" title={t('imp.failed')}>{j.error?.detail ?? t('imp.failed.desc')}</Notice> : null}
        {j && TERMINAL.includes(j.state) ? (
          <Button icon="plus" onClick={resetTracking}>
            {t('imp.another')}
          </Button>
        ) : null}
      </Card>
    );
  }

  const unsupported = format !== null && !PARSER_SUPPORTED[format];
  const tooBig = file !== null && file.size > MAX_BYTES;
  const blocking = !datasetId || !file || !format || unsupported || tooBig || !method.trim() || (preview?.fatal ?? false);
  const busy = step !== 'idle';

  return (
    <Card title={t('imp.new')}>
      <Notice tone="info" title={t('imp.formats')}>
        <span className="pg-flags">
          <Badge tone="positive" icon="checkCircle">GeoJSON</Badge>
          <Badge tone="positive" icon="checkCircle">CSV</Badge>
          <Badge tone="neutral" icon="slash">KML — {t('imp.notSupported')}</Badge>
          <Badge tone="neutral" icon="slash">SHP ZIP — {t('imp.notSupported')}</Badge>
        </span>
        <p className="pg-muted">{t('imp.formats.desc')}</p>
      </Notice>

      <DatasetPicker city={city} value={datasetId} onChange={setDatasetId} />

      <Field label={t('imp.file')} hint={t('imp.file.hint')}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            className="pg-input imp-file"
            type="file"
            accept=".geojson,.json,.csv,.kml,.zip,application/geo+json,text/csv"
            disabled={busy}
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
          />
        )}
      </Field>

      {file ? (
        <p className="pg-muted">
          {file.name} · {formatNumber(file.size / 1024, 1)} КБ · {format ? format : t('imp.format.unknown')}
        </p>
      ) : null}
      {file && !format ? <Notice tone="negative" title={t('imp.format.unknown')}>{t('imp.format.unknown.desc')}</Notice> : null}
      {unsupported ? (
        <Notice tone="warning" icon="slash" title={t('imp.unsupported', { format: format === 'kml' ? 'KML' : 'SHP ZIP' })}>
          {t('imp.unsupported.desc')}
        </Notice>
      ) : null}
      {tooBig ? <Notice tone="negative" title={t('imp.tooBig')} /> : null}
      {file && format && !unsupported && !preview && file.size > PREVIEW_BYTES ? <p className="pg-muted">{t('imp.preview.skipped')}</p> : null}
      {preview && format ? <PreviewView preview={preview} format={format} /> : null}

      {format && !unsupported ? (
        <>
          {fields.length ? (
            <fieldset className="imp-fields">
              <legend>{t('imp.fields')}</legend>
              <p className="pg-muted">{t('imp.fields.hint')}</p>
              {fields.map((f) => (
                <div key={f} className="imp-field-row">
                  <label>
                    <input type="checkbox" checked={include[f] ?? true} disabled={busy} onChange={(e) => setInclude({ ...include, [f]: e.target.checked })} /> <code className="pg-code">{f}</code>
                  </label>
                  <Input
                    aria-label={t('imp.fields.rename', { f })}
                    placeholder={f}
                    value={rename[f] ?? ''}
                    disabled={busy || !(include[f] ?? true)}
                    onChange={(e) => setRename({ ...rename, [f]: e.target.value })}
                  />
                </div>
              ))}
            </fieldset>
          ) : null}
          <div className="imp-grid">
            <Field label={t('imp.crs')} hint={t('imp.crs.hint')}>
              {({ id, describedBy }) => (
                <Select id={id} aria-describedby={describedBy} value="EPSG:4326" disabled>
                  <option value="EPSG:4326">EPSG:4326 (WGS84)</option>
                </Select>
              )}
            </Field>
            <Field label={t('imp.method')} required hint={t('imp.method.hint')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={method} disabled={busy} onChange={(e) => setMethod(e.target.value)} />}
            </Field>
            <Field label={t('imp.observedAt')} hint={t('imp.observedAt.hint')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="date" value={observedAt} disabled={busy} onChange={(e) => setObservedAt(e.target.value)} />}
            </Field>
            <Field label={t('imp.resolution')} hint={t('imp.resolution.hint')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={resolution} disabled={busy} onChange={(e) => setResolution(e.target.value.replace(',', '.'))} />}
            </Field>
          </div>
        </>
      ) : null}

      {busy ? (
        <div className="imp-steps" role="status" aria-live="polite">
          <span className={step === 'hashing' ? 'is-active' : undefined}>{t('imp.step.hash')}</span>
          <span className={step === 'ticket' ? 'is-active' : undefined}>{t('imp.step.ticket')}</span>
          <span className={step === 'uploading' ? 'is-active' : undefined}>
            {t('imp.step.upload')}
            {sent && step === 'uploading' ? ` ${Math.round((sent.done / Math.max(1, sent.total)) * 100)} %` : ''}
          </span>
          <span className={step === 'starting' ? 'is-active' : undefined}>{t('imp.step.start')}</span>
          {step === 'uploading' && sent ? (
            <div className="pg-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((sent.done / Math.max(1, sent.total)) * 100)}>
              <span style={{ width: `${(sent.done / Math.max(1, sent.total)) * 100}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <ApiErrorView compact error={error} /> : null}
      {error && ticket ? <p className="pg-muted">{t('imp.retry.ticketKept')}</p> : null}

      <div className="scn-actions">
        <Button variant="primary" icon="upload" busy={busy} disabled={blocking} onClick={() => void run()}>
          {error ? t('imp.retry') : t('imp.start')}
        </Button>
      </div>
      <p className="pg-muted">{t('imp.after')}</p>
    </Card>
  );
}

function ImportedVersion({ datasetId, versionId, cityId }: { datasetId: string; versionId: string | null; cityId: string }) {
  const ds = useQuery({
    queryKey: ['dataset-for-import-result', datasetId],
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/datasets', { params: { query: { city_id: cityId, limit: 200 } }, signal }))).data.items.find((d) => d.id === datasetId) ?? null,
  });
  if (ds.isPending) return <Skeleton lines={3} />;
  if (ds.isError) return <ApiErrorView compact error={ds.error} />;
  if (!ds.data) return <StateView compact state="not_found" />;
  return (
    <div className="imp-result">
      {versionId ? (
        <p className="pg-muted">
          {t('imp.version')} <code className="pg-code">{versionId.slice(0, 8)}</code>
        </p>
      ) : null}
      <DatasetDetail dataset={ds.data} onClose={() => undefined} highlightVersionId={versionId} hideClose />
    </div>
  );
}
