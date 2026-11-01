import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { newIdempotencyKey, unwrap, type Dataset, type DatasetVersion, type Plant, type QualityIssue, type QualityReport, type StockItem } from '@pg/api-client';
import {
  Badge,
  Button,
  Card,
  contentKindLabel,
  DataGapList,
  Dialog,
  formatDate,
  Field,
  formatDateTime,
  Input,
  Notice,
  PlantReviewDetails,
  PlantSafetyFlags,
  ReadinessBadge,
  Skeleton,
  StateView,
  StockOfferRow,
  TraitTable,
  type Tone,
} from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { productLabel } from '../../productCopy';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { plantImage } from '../plants/images';

/** Selected row id kept in the URL so reload and shared links restore the detail. */
export function useSelected(name = 'selected'): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  return [
    params.get(name),
    (id) => {
      const next = new URLSearchParams(params);
      if (id) next.set(name, id);
      else next.delete(name);
      setParams(next, { replace: true });
    },
  ];
}

const VERSION_TONE: Record<DatasetVersion['status'], Tone> = {
  quarantine: 'warning',
  validating: 'info',
  needs_review: 'warning',
  published: 'positive',
  rejected: 'negative',
};
const VERSION_LABEL: Record<DatasetVersion['status'], string> = {
  quarantine: 'карантин',
  validating: 'проверяется',
  needs_review: 'нужна проверка',
  published: 'опубликована',
  rejected: 'отклонена',
};

const SEVERITY: Record<QualityIssue['severity'], { tone: Tone; label: string }> = {
  error: { tone: 'negative', label: 'ошибка' },
  warning: { tone: 'warning', label: 'предупреждение' },
  info: { tone: 'info', label: 'сведения' },
};

function QualitySummary({ versionId }: { versionId: string }) {
  const available = useOperationAvailable('getQualityReport');
  // Counts come from the first page; issues are paged with issues_next_cursor (bounded by the server).
  const q = useInfiniteQuery({
    queryKey: ['quality', versionId],
    enabled: available !== false,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await unwrap<QualityReport>(
          api.GET('/v1/dataset-versions/{version_id}/quality', { params: { path: { version_id: versionId }, query: { cursor: pageParam, limit: 50 } }, signal }),
        )
      ).data,
    getNextPageParam: (last) => (last.issues_truncated ? (last.issues_next_cursor ?? undefined) : undefined),
  });
  if (available === false) return <OperationUnavailable compact operationId="getQualityReport" />;
  if (q.isPending) return <Skeleton lines={2} />;
  if (q.isError && !q.data) return <ApiErrorView compact error={q.error} onRetry={() => void q.refetch()} />;
  const r = q.data!.pages[0]!;
  const pages = q.data!.pages;
  const issues = pages.flatMap((p) => p.issues);
  const total = r.error_count + r.warning_count;
  return (
    <div className="app-quality">
      <dl className="pg-dl">
        <dt>Записей в поставке</dt>
        <dd>{r.record_count === 0 ? <Badge tone="info" icon="inbox">предоставлено: 0 записей</Badge> : r.record_count}</dd>
        <dt>Структурно валидных</dt>
        <dd>
          {r.valid_count} <span className="pg-muted">(это не означает пригодность для решений)</span>
        </dd>
        <dt>Ошибок / предупреждений</dt>
        <dd>
          {r.error_count} / {r.warning_count}
        </dd>
      </dl>
      {r.publish_allowed ? (
        <Notice tone="info" icon="checkCircle" title="Проверка качества не блокирует публикацию" />
      ) : (
        <Notice tone="warning" icon="lock" title="Публикация заблокирована проверкой качества">
          Версия остаётся в проверке и не используется в расчётах и на карте, пока причины ниже не устранены.
        </Notice>
      )}
      {issues.length ? (
        <ul className="app-issues" aria-label="Замечания проверки качества">
          {issues.map((iss, n) => (
            <li key={`${iss.code}-${iss.source_record_id ?? ''}-${n}`}>
              <Badge tone={SEVERITY[iss.severity].tone} icon={iss.severity === 'error' ? 'error' : iss.severity === 'warning' ? 'alert' : 'info'}>
                {SEVERITY[iss.severity].label}
              </Badge>{' '}
              <code className="pg-code">{iss.code}</code> {iss.message}
              {iss.source_record_id ? <span className="pg-muted"> · запись {iss.source_record_id}</span> : null}
              {iss.geometry ? <span className="pg-muted"> · есть геометрия</span> : null}
              {iss.suggested_action ? <div className="pg-muted">Что сделать: {iss.suggested_action}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="app-quality__more">
        <span className="pg-muted">
          Показано замечаний: {issues.length}
          {total > 0 ? ` из ${total} (ошибки и предупреждения)` : ''}
        </span>
        {q.hasNextPage ? (
          <Button size="sm" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Загрузить ещё замечания
          </Button>
        ) : null}
      </div>
      {q.isFetchNextPageError ? <ApiErrorView compact error={q.error} onRetry={() => void q.fetchNextPage()} /> : null}
    </div>
  );
}

/** Admin-only. The server decides; refusal reasons (blockers) are shown verbatim. */
function PublishVersion({ version, datasetId }: { version: DatasetVersion; datasetId: string }) {
  const { hasRole, user } = useSession();
  const available = useOperationAvailable('publishDatasetVersion');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  // One key per publish intent: a retry after a network failure cannot publish twice.
  const [key, setKey] = useState(newIdempotencyKey);
  const publish = useMutation({
    mutationFn: async () =>
      unwrap(
        api.POST('/v1/dataset-versions/{version_id}/publish', {
          params: { path: { version_id: version.id }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': key } },
          body: { reason: reason.trim() },
        }),
      ),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['dataset-versions', datasetId] });
      void qc.invalidateQueries({ queryKey: ['list', 'datasets'] });
      // Publication creates/replaces the dataset's map layer manifests (ADR-012).
      void qc.invalidateQueries({ queryKey: ['map-layers'] });
    },
  });
  if (!hasRole('admin') || version.status === 'published' || version.status === 'rejected') return null;
  if (available === false) return null;
  return (
    <>
      <Button
        size="sm"
        icon="upload"
        onClick={() => {
          setKey(newIdempotencyKey());
          publish.reset();
          setOpen(true);
        }}
      >
        Опубликовать версию…
      </Button>
      <Dialog
        open={open}
        title="Публикация версии источника"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Отмена</Button>
            <Button variant="primary" busy={publish.isPending} disabled={reason.trim().length < 3} onClick={() => publish.mutate()}>
              Опубликовать
            </Button>
          </>
        }
      >
        <p>
          Опубликованная версия станет текущей для карты и расчётов. Сервер проверит лицензию, CRS, схему и замечания качества и откажет,
          если есть блокирующие причины.
        </p>
        <Field label="Причина решения" required hint="Сохраняется в журнале аудита">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {publish.isError ? <ApiErrorView compact error={publish.error} /> : null}
      </Dialog>
    </>
  );
}

/** Admin-only rejection with a reason; the server keeps the version and its report for audit. */
function RejectVersion({ version, datasetId }: { version: DatasetVersion; datasetId: string }) {
  const { hasRole, user } = useSession();
  const available = useOperationAvailable('rejectDatasetVersion');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const reject = useMutation({
    mutationFn: async () =>
      unwrap(
        api.POST('/v1/dataset-versions/{version_id}/reject', {
          params: { path: { version_id: version.id }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': key } },
          body: { reason: reason.trim() },
        }),
      ),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['dataset-versions', datasetId] });
    },
  });
  if (!hasRole('admin') || version.status === 'published' || version.status === 'rejected' || available === false) return null;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon="x"
        onClick={() => {
          setKey(newIdempotencyKey());
          reject.reset();
          setOpen(true);
        }}
      >
        Отклонить версию…
      </Button>
      <Dialog
        open={open}
        title="Отклонение версии источника"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Отмена</Button>
            <Button variant="danger" busy={reject.isPending} disabled={reason.trim().length < 3} onClick={() => reject.mutate()}>
              Отклонить
            </Button>
          </>
        }
      >
        <p>Отклонённая версия не публикуется и не используется в расчётах. Файл, отчёт качества и решение сохраняются для аудита.</p>
        <Field label="Причина решения" required hint="Сохраняется в журнале аудита">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {reject.isError ? <ApiErrorView compact error={reject.error} /> : null}
      </Dialog>
    </>
  );
}

export function DatasetDetail({
  dataset,
  onClose,
  highlightVersionId = null,
  hideClose = false,
}: {
  dataset: Dataset;
  onClose: () => void;
  highlightVersionId?: string | null;
  hideClose?: boolean;
}) {
  const available = useOperationAvailable('listDatasetVersions');
  const { hasRole } = useSession();
  const versions = useQuery({
    queryKey: ['dataset-versions', dataset.id],
    enabled: available !== false,
    queryFn: async ({ signal }) =>
      (await unwrap(api.GET('/v1/datasets/{dataset_id}/versions', { params: { path: { dataset_id: dataset.id }, query: { limit: 50 } }, signal })))
        .data,
  });
  return (
    <Card
      title={productLabel(dataset.name)}
      actions={hideClose ? undefined : <Button variant="ghost" size="sm" icon="x" iconOnly aria-label="Закрыть карточку источника" onClick={onClose} />}
    >
      <dl className="pg-dl">
        <dt>Тип</dt>
        <dd>
          <code className="pg-code">{dataset.kind}</code>
        </dd>
        <dt>Владелец</dt>
        <dd>{dataset.owner}</dd>
        <dt>Лицензия</dt>
        <dd>{dataset.license}</dd>
        <dt>Исходный адрес</dt>
        <dd>{dataset.source_uri ?? 'не указан'}</dd>
        <dt>Зарегистрирован</dt>
        <dd>{formatDateTime(dataset.created_at)}</dd>
      </dl>
      {dataset.access_level === 'restricted' && hasRole('admin') ? (
        <p>
          <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/admin?city=${dataset.city_id}&grants=${dataset.id}`}>
            Управлять доступом к набору
          </Link>
        </p>
      ) : null}
      {dataset.current_version_id ? null : (
        <Notice tone="neutral" icon="slash" title="Опубликованной версии нет">
          Источник зарегистрирован, но ни одна версия не опубликована. В расчётах и на карте он не используется; это не означает, что
          объектов нет.
        </Notice>
      )}
      <h4>Версии</h4>
      {available === false ? (
        <OperationUnavailable compact operationId="listDatasetVersions" />
      ) : versions.isPending ? (
        <Skeleton lines={3} />
      ) : versions.isError ? (
        <ApiErrorView compact error={versions.error} onRetry={() => void versions.refetch()} />
      ) : versions.data.items.length === 0 ? (
        <StateView compact state="empty" title="Версий нет" description="Данные не загружались. Следующий шаг — загрузка в карантин (роль specialist)." />
      ) : (
        <ul className="app-versions">
          {[...versions.data.items].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((v) => (
            <li key={v.id} className={[v.id === dataset.current_version_id ? 'is-current' : '', v.id === highlightVersionId ? 'is-new' : ''].join(' ').trim() || undefined}>
              <div className="app-versions__head">
                <Badge tone={VERSION_TONE[v.status]}>{VERSION_LABEL[v.status]}</Badge>
                {v.id === dataset.current_version_id ? <Badge tone="accent">текущая</Badge> : null}
                {v.id === highlightVersionId ? <Badge tone="info">только что загружена</Badge> : null}
                <code className="pg-code">{v.id.slice(0, 8)}</code>
              </div>
              <span className="pg-flags">
                <ReadinessBadge state={v.readiness_state} />
                <Badge tone={v.content_kind === 'mixed' ? 'warning' : 'neutral'}>{contentKindLabel(v.content_kind)}</Badge>
                {v.data_request_id ? <Badge tone="neutral">{v.data_request_id}</Badge> : null}
              </span>
              {v.applicability ? (
                <p className={v.content_kind === 'mixed' ? 'pg-readiness__mixed' : 'pg-muted'}>
                  {v.content_kind === 'mixed' ? 'Состав версии: ' : 'Применимость: '}
                  {v.applicability}
                </p>
              ) : null}
              <dl className="pg-dl">
                <dt>Записей</dt>
                <dd>{v.record_count === null ? <span className="pg-unknown">неизвестно</span> : v.record_count === 0 ? '0 — предоставлено пустым' : v.record_count}</dd>
                <dt>Период данных</dt>
                <dd>{v.observed_from || v.observed_to ? `${formatDate(v.observed_from) ?? '…'} – ${formatDate(v.observed_to) ?? '…'}` : <span className="pg-unknown">не указан</span>}</dd>
                <dt>Проверено</dt>
                <dd>{formatDate(v.checked_at) ?? <span className="pg-unknown">не проверялось</span>}</dd>
                <dt>Дата наблюдения</dt>
                <dd>{v.observed_at ? formatDateTime(v.observed_at) : <span className="pg-unknown">не указана источником</span>}</dd>
                <dt>Загружена</dt>
                <dd>{formatDateTime(v.created_at)}</dd>
                <dt>Опубликована</dt>
                <dd>{v.published_at ? formatDateTime(v.published_at) : '—'}</dd>
                <dt>Метод</dt>
                <dd>{v.method}</dd>
                <dt>Исходная СК</dt>
                <dd>
                  <code className="pg-code">{v.source_crs}</code>
                </dd>
                <dt>SHA-256</dt>
                <dd>
                  <code className="pg-code" title={v.sha256}>
                    {v.sha256.slice(0, 12)}…
                  </code>
                </dd>
              </dl>
              <DataGapList gaps={v.review_reasons} />
              {v.quality_report_id ? <QualitySummary versionId={v.id} /> : <p className="pg-muted">Отчёт качества ещё не сформирован.</p>}
              <span className="scn-actions">
                <PublishVersion version={v} datasetId={dataset.id} />
                <RejectVersion version={v} datasetId={dataset.id} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <Notice tone="info" title="Пригодность для расчётов">
        Состояние версии — данные сервера. Ограничения для конкретного расчёта показываются в его результате; интерфейс не делает
        собственных выводов о пригодности.
      </Notice>
    </Card>
  );
}

export function PlantDetail({ plantId, onClose }: { plantId: string; onClose: () => void }) {
  const plantOk = useOperationAvailable('getPlant');
  const stockOk = useOperationAvailable('listStock');
  const plant = useQuery({
    queryKey: ['plant', plantId],
    enabled: plantOk !== false,
    queryFn: async ({ signal }) => (await unwrap<Plant>(api.GET('/v1/plants/{plant_id}', { params: { path: { plant_id: plantId } }, signal }))).data,
  });
  const stock = useQuery({
    queryKey: ['stock', plantId],
    enabled: stockOk !== false,
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/stock', { params: { query: { plant_id: plantId, limit: 50 } }, signal }))).data,
  });
  const close = <Button variant="ghost" size="sm" icon="x" iconOnly aria-label="Закрыть карточку растения" onClick={onClose} />;
  if (plantOk === false) return <Card actions={close}><OperationUnavailable compact operationId="getPlant" /></Card>;
  if (plant.isPending) return <Card actions={close}><Skeleton lines={5} /></Card>;
  if (plant.isError) return <Card actions={close}><ApiErrorView compact error={plant.error} onRetry={() => void plant.refetch()} /></Card>;
  const p = plant.data;
  const image = plantImage(p.latin_name);
  return (
    <Card title={`${p.russian_name}${p.cultivar ? ` «${p.cultivar}»` : ''}`} actions={close}>
      <div className="plant-detail-hero">
        {image ? <img src={image} alt={`${p.russian_name} — ${p.latin_name}`} /> : null}
        <span>
          <small>Растение для городского озеленения</small>
          <i>{p.latin_name}</i>
        </span>
      </div>
      <PlantSafetyFlags plant={p} />
      <PlantReviewDetails plant={p} />
      {p.expert_status !== 'approved' ? (
        <Notice tone="warning" icon="clock" title="Автоматический подбор с этим растением не утверждается">
          Запись каталога — таксономическая карточка, а не утверждённый для посадки вид. Решение принимает эксперт; сервер исключит или
          пометит растение при подборе.
        </Notice>
      ) : null}
      <h4>Характеристики и источники</h4>
      <TraitTable traits={p.traits} />
      <h4>Посадочный материал (партии поставщиков)</h4>
      {stockOk === false ? (
        <OperationUnavailable compact operationId="listStock" />
      ) : stock.isPending ? (
        <Skeleton lines={3} />
      ) : stock.isError ? (
        <ApiErrorView compact error={stock.error} onRetry={() => void stock.refetch()} />
      ) : stock.data.items.length === 0 ? (
        <StateView compact state="empty" title="Предложений поставщиков нет" description="Наличие и цена не подтверждены; смета по этому растению будет неполной." />
      ) : (
        stock.data.items.map((s: StockItem) => <StockOfferRow key={s.id} item={s} />)
      )}
    </Card>
  );
}
