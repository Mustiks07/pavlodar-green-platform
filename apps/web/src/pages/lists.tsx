import { lazy, Suspense, useEffect, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, NavLink, useNavigate, useSearchParams } from 'react-router';
import {
  unwrap,
  type AuditEvent,
  type City,
  type Coefficient,
  type Dataset,
  type DetectedProblem,
  type Plant,
  type Program,
  type Rate,
  type Scenario,
  type SourceReadiness,
  type WorkOrder,
  type Zone,
  type ZoneContext,
} from '@pg/api-client';
import { Badge, Button, Card, Field, Icon, Notice, Skeleton, SourceReadinessList, StateView, formatDate, formatDateTime, formatNumber, Input, MoneyText, PageHeader, Select, UnitText, type Column, type IconName, type Tone } from '@pg/ui';
import { api, useOperationAvailable } from '../api';
import { ApiErrorView } from '../shell/ApiErrorView';
import { OperationUnavailable } from '../shell/OperationUnavailable';
import { t, type AppKey } from '../i18n';
import { productLabel } from '../productCopy';
import { ResourceList } from '../features/resources/ResourceList';
import { CityGate } from '../shell/gates';
import { DatasetDetail, PlantDetail, useSelected } from '../features/resources/details';
import { AccessAdmin, CityUsers } from '../features/access/AccessAdmin';
import { ProgramDetail } from '../features/programs/ProgramDetail';
import { ProgramCreateDialog } from '../features/programs/ProgramCreateDialog';
import { CreateWorkOrder, WO_TONE, WorkOrderDetail } from '../features/execution/WorkOrders';
import { CohortsPanel } from '../features/execution/Cohorts';
import { ProgramCarePlan } from '../features/execution/ProgramCarePlan';
import { useCityPrincipals } from '../features/access/DatasetGrants';
import { useSession } from '../shell/session';
import { plantImage } from '../features/plants/images';
import { useZones } from '../features/zones/queries';
import { cityDisplayName } from '../city';
// The wizard (preview, upload, job tracking) is its own chunk: loaded only on the imports page.
const ImportWizard = lazy(async () => ({ default: (await import('../features/imports/ImportWizard')).ImportWizard }));

const short = (id: string | null) => (id ? <code className="pg-code">{id.slice(0, 8)}</code> : t('none'));

/** URL-backed filter (TZ §22: filters survive reload and links). Unknown values are dropped. */
function useFilter<T extends string = string>(name: string, allowed?: readonly T[]): [T | '', (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(name) ?? '';
  const value = (allowed && !allowed.includes(raw as T) ? '' : raw) as T | '';
  return [
    value,
    (v) => {
      const next = new URLSearchParams(params);
      if (v) next.set(name, v);
      else next.delete(name);
      setParams(next, { replace: true });
    },
  ];
}

const PAGE_EYEBROW: Partial<Record<AppKey, AppKey>> = {
  'page.problems': 'page.problems.eyebrow',
  'page.program': 'page.program.eyebrow',
  'page.projects': 'page.projects.eyebrow',
  'page.catalog': 'page.catalog.eyebrow',
  'page.execution': 'page.execution.eyebrow',
  'page.imports': 'page.imports.eyebrow',
  'page.reference': 'page.reference.eyebrow',
  'page.sources': 'page.sources.eyebrow',
  'page.admin': 'page.admin.eyebrow',
};

function Page({ title, description, children }: { title: AppKey; description: AppKey; children: React.ReactNode }) {
  const eyebrow = PAGE_EYEBROW[title];
  return (
    <div className="app-page">
      <PageHeader title={t(title)} description={t(description)} eyebrow={eyebrow ? t(eyebrow) : undefined} />
      {children}
    </div>
  );
}

function WorkspaceOverview({
  items,
}: {
  items: Array<{ icon: IconName; label: string; value: string | number; note: string; tone?: 'accent' | 'warning' | 'positive' }>;
}) {
  return (
    <section className="app-overview" aria-label="Краткая сводка раздела">
      {items.map((item) => (
        <article className={`app-overview__item${item.tone ? ` is-${item.tone}` : ''}`} key={item.label}>
          <span className="app-overview__icon"><Icon name={item.icon} size={19} /></span>
          <span className="app-overview__copy">
            <small>{item.label}</small>
            <strong>{item.value}</strong>
            <em>{item.note}</em>
          </span>
        </article>
      ))}
    </section>
  );
}

function WorkspaceSteps({
  label,
  items,
}: {
  label: string;
  items: Array<{ icon: IconName; title: string; description: string }>;
}) {
  return (
    <section className="workspace-steps" aria-label={label}>
      {items.map((item, index) => (
        <article className="workspace-step" key={item.title}>
          <span className="workspace-step__number">{index + 1}</span>
          <span className="workspace-step__icon"><Icon name={item.icon} size={18} /></span>
          <span className="workspace-step__copy"><strong>{item.title}</strong><small>{item.description}</small></span>
        </article>
      ))}
    </section>
  );
}

const WORKSPACE_IMAGES = ['/workspaces/courtyard.webp', '/workspaces/street-corridor.webp', '/workspaces/embankment-square.webp'] as const;

function workspaceImage(name: string, index = 0): string {
  const value = name.toLocaleLowerCase('ru');
  if (value.includes('двор') || value.includes('квартал')) return WORKSPACE_IMAGES[0];
  if (value.includes('коридор') || value.includes('улиц')) return WORKSPACE_IMAGES[1];
  if (value.includes('сквер') || value.includes('набереж')) return WORKSPACE_IMAGES[2];
  return WORKSPACE_IMAGES[index % WORKSPACE_IMAGES.length]!;
}

function ZoneLabel({ id }: { id: string }) {
  const { city } = useSession();
  const zones = useZones(city?.id ?? null);
  const zone = zones.data?.items.find((item) => item.id === id);
  if (zones.isPending) return <span className="pg-muted">Загрузка участка…</span>;
  return <span>{zone?.name ?? 'Участок'}</span>;
}

function CatalogStatus({ plant }: { plant: Plant }) {
  const status = plant.expert_status === 'approved'
    ? { tone: 'positive' as const, label: 'Подтверждено экспертом', icon: 'checkCircle' as const }
    : plant.expert_status === 'rejected'
      ? { tone: 'negative' as const, label: 'Исключено экспертом', icon: 'error' as const }
      : { tone: 'warning' as const, label: 'На экспертной проверке', icon: 'clock' as const };
  return (
    <span className="plant-catalog-status">
      <Badge tone={status.tone} icon={status.icon}>{status.label}</Badge>
      {plant.taxon_rank === 'genus' ? <Badge tone="warning">Нужно уточнить вид</Badge> : null}
      {plant.exclusion_basis ? <Badge tone="negative" icon="alert">Есть ограничение</Badge> : null}
    </span>
  );
}

function CatalogSpotlight({ plants, onPick }: { plants: Plant[]; onPick: (id: string) => void }) {
  const withImages = plants.filter((plant) => plantImage(plant.latin_name));
  const featured = [
    ...withImages.filter((plant) => !plant.exclusion_basis && plant.sensitive_site_status !== 'excluded'),
    ...withImages.filter((plant) => plant.exclusion_basis || plant.sensitive_site_status === 'excluded'),
  ].slice(0, 3);
  if (!featured.length) return null;
  return (
    <section className="plant-spotlight" aria-labelledby="plant-spotlight-title">
      <div className="plant-spotlight__head"><span><small>Подбор для городских участков</small><strong id="plant-spotlight-title">Растения каталога</strong></span><p>Откройте карточку, чтобы изучить характеристики, ограничения и предложения поставщиков.</p></div>
      <div className="plant-spotlight__grid">
        {featured.map((plant) => (
          <button key={plant.id} type="button" className="plant-spotlight__card" onClick={() => onPick(plant.id)}>
            <span className="plant-spotlight__media"><img src={plantImage(plant.latin_name)!} alt="" /></span>
            <span className="plant-spotlight__copy"><strong>{plant.russian_name}</strong><i>{plant.latin_name}</i><small>{t(`stratum.${plant.stratum}` as AppKey)}</small></span>
            <Icon name="chevronRight" size={17} />
          </button>
        ))}
      </div>
    </section>
  );
}

/** One data workspace, with task routes kept out of the permanent product navigation. */
function DataSectionNav() {
  const [params] = useSearchParams();
  const { hasRole } = useSession();
  const city = params.get('city');
  const suffix = city ? `?city=${encodeURIComponent(city)}` : '';
  const items = [
    { path: '/sources', label: t('nav.sources'), show: true },
    { path: '/imports', label: t('nav.imports'), show: hasRole('specialist') },
    { path: '/reference', label: t('nav.reference'), show: true },
  ];
  return (
    <nav className="app-data-nav" aria-label={t('data.nav.label')}>
      {items.filter((item) => item.show).map((item) => (
        <NavLink key={item.path} to={`${item.path}${suffix}`} className={({ isActive }) => (isActive ? 'is-active' : undefined)}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

const SEVERITY_TONE: Record<DetectedProblem['severity'], Tone> = { high: 'negative', medium: 'warning', low: 'neutral' };
const PROBLEM_KINDS: DetectedProblem['kind'][] = [
  'green_deficit',
  'degraded_green',
  'soil_risk',
  'heat',
  'missing_protective_green',
  'data_gap',
];

function ZoneReadiness({ cityId, show }: { cityId: string; show: boolean }) {
  const zones = useZones(cityId);
  const contexts = useQueries({
    queries: (zones.data?.items ?? []).map((zone) => ({
      queryKey: ['zone-context', zone.id],
      enabled: show,
      queryFn: async ({ signal }: { signal: AbortSignal }) => (
        await unwrap<ZoneContext>(api.GET('/v1/zones/{zone_id}/context', { params: { path: { zone_id: zone.id } }, signal }))
      ).data,
      staleTime: 60_000,
    })),
  });
  if (!show || zones.isPending || contexts.some((query) => query.isPending)) return null;
  const cards = (zones.data?.items ?? []).map((zone, index) => ({ zone, context: contexts[index]?.data })).filter((item) => item.context);
  if (!cards.length) return null;
  return (
    <section className="problem-readiness" aria-labelledby="problem-readiness-title">
      <header><span><small>Готовность территорий</small><strong id="problem-readiness-title">Что проверить перед проектированием</strong></span><p>Платформа уже собрала блокирующие входные данные отдельно для каждого выбранного участка.</p></header>
      <div className="problem-readiness__grid">
        {cards.map(({ zone, context }, index) => {
          const gaps = context!.data_gaps.filter((gap) => gap.blocking);
          return (
            <article key={zone.id}>
              <img className="problem-readiness__image" src={workspaceImage(zone.name, index)} alt="" loading="lazy" />
              <span className="problem-readiness__icon"><Icon name={gaps.length ? 'alert' : 'check'} size={18} /></span>
              <div><strong>{zone.name}</strong><small>{gaps.length ? `${gaps.length} ${gaps.length === 1 ? 'обязательная проверка' : gaps.length < 5 ? 'обязательные проверки' : 'обязательных проверок'}` : 'контекст готов'}</small></div>
              <ul>{gaps.slice(0, 2).map((gap) => <li key={gap.code}>{gap.message}</li>)}</ul>
              <Link to={`/?city=${cityId}&zone=${zone.id}`}>Открыть участок на карте</Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ProblemHighlights({ cityId, problems, onSelect }: { cityId: string; problems: DetectedProblem[]; onSelect: (id: string) => void }) {
  const zones = useZones(cityId);
  if (!problems.length || zones.isPending) return null;
  const zoneById = new Map((zones.data?.items ?? []).map((zone) => [zone.id, zone]));
  return (
    <section className="problem-highlights" aria-labelledby="problem-highlights-title">
      <header><span><small>Территории для решения</small><strong id="problem-highlights-title">От городской проблемы — к проекту участка</strong></span><p>Откройте карточку, проверьте причину и сразу перейдите к территории на карте.</p></header>
      <div className="problem-highlights__grid">
        {problems.slice(0, 3).map((problem, index) => {
          const zone = zoneById.get(problem.zone_id);
          return (
            <button type="button" className="problem-highlight" key={problem.id} onClick={() => onSelect(problem.id)}>
              <img src={workspaceImage(zone?.name ?? '', index)} alt="" loading="lazy" />
              <span className="problem-highlight__body">
                <span><Badge tone={SEVERITY_TONE[problem.severity]}>{t(`severity.${problem.severity}` as AppKey)}</Badge><small>{zone?.name ?? 'Территория Павлодара'}</small></span>
                <strong>{t(`problem.${problem.kind}` as AppKey)}</strong>
                <em>{problem.description}</em>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function ProblemsPage() {
  const [selected, setSelected] = useSelected('problem');
  const [rows, setRows] = useState<DetectedProblem[]>([]);
  const [severity, setSeverity] = useFilter('severity', ['high', 'medium', 'low'] as const);
  const [kind, setKind] = useFilter('kind', PROBLEM_KINDS);
  const current = rows.find((problem) => problem.id === selected) ?? null;
  const columns: Column<DetectedProblem>[] = [
    { key: 'kind', header: t('col.kind'), render: (p) => t(`problem.${p.kind}` as AppKey) },
    {
      key: 'severity',
      header: t('col.severity'),
      render: (p) => (
        <Badge tone={SEVERITY_TONE[p.severity]} icon={p.severity === 'high' ? 'alert' : 'dot'}>
          {t(`severity.${p.severity}` as AppKey)}
        </Badge>
      ),
    },
    { key: 'zone', header: t('col.zone'), render: (p) => <ZoneLabel id={p.zone_id} /> },
    { key: 'desc', header: t('col.description'), render: (p) => p.description },
    { key: 'status', header: t('col.status'), render: (p) => t(`problemStatus.${p.status}` as AppKey) },
    { key: 'src', header: t('col.sources'), render: (p) => p.source_refs.length, align: 'end' },
  ];
  return (
    <Page title="page.problems" description="page.problems.desc">
      <CityGate>
        {(city) => (
          <>
            <WorkspaceOverview
              items={[
                { icon: 'alertMap', label: 'Выявлено', value: rows.length, note: 'загружено по городу', tone: 'accent' },
                { icon: 'alert', label: 'Высокий приоритет', value: rows.filter((item) => item.severity === 'high' && item.status === 'open').length, note: 'требуют решения', tone: 'warning' },
                { icon: 'target', label: 'В работе', value: rows.filter((item) => item.status === 'acknowledged').length, note: 'принято специалистом' },
                { icon: 'check', label: 'Разобрано', value: rows.filter((item) => item.status === 'dismissed').length, note: 'решение зафиксировано', tone: 'positive' },
              ]}
            />
            <ZoneReadiness cityId={city.id} show={rows.length === 0} />
            <ProblemHighlights cityId={city.id} problems={rows} onSelect={setSelected} />
            <div className={current ? 'app-split is-open' : 'app-split'}>
            <ResourceList
              resource="problems"
              operationId="listProblems"
              caption={t('page.problems')}
              params={{ city: city.id, severity, kind }}
              columns={columns}
              getRowId={(p) => p.id}
              selectedId={selected}
              onSelect={(problem) => setSelected(problem.id)}
              onRows={setRows}
              empty={{ title: t('page.problems.empty'), description: t('page.problems.empty.desc') }}
              toolbar={
                <>
                  <Field label={t('filter.severity')}>
                    {({ id }) => (
                      <Select id={id} value={severity} onChange={(e) => setSeverity(e.target.value)}>
                        <option value="">{t('filter.all')}</option>
                        {(['high', 'medium', 'low'] as const).map((s) => (
                          <option key={s} value={s}>
                            {t(`severity.${s}`)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('filter.kind')}>
                    {({ id }) => (
                      <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
                        <option value="">{t('filter.all')}</option>
                        {PROBLEM_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`problem.${k}` as AppKey)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </>
              }
              fetchPage={async (cursor, signal) =>
                (
                  await unwrap(
                    api.GET('/v1/problems', {
                      params: {
                        query: {
                          city_id: city.id,
                          cursor,
                          limit: 100,
                          severity: severity || undefined,
                          kind: kind || undefined,
                        },
                      },
                      signal,
                    }),
                  )
                ).data
              }
            />
            {current ? (
              <ProblemInspector
                problem={current}
                cityId={city.id}
                onClose={() => setSelected(null)}
                onChanged={(changed) =>
                  setRows((values) => values.map((item) => (item.id === changed.id ? changed : item)))
                }
              />
            ) : null}
            </div>
          </>
        )}
      </CityGate>
    </Page>
  );
}

function ProblemInspector({
  problem,
  cityId,
  onClose,
  onChanged,
}: {
  problem: DetectedProblem;
  cityId: string;
  onClose: () => void;
  onChanged: (problem: DetectedProblem) => void;
}) {
  const { hasRole, user } = useSession();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const dismiss = async () => {
    if (!reason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const response = await unwrap(
        api.POST('/v1/problems/{problem_id}/dismiss', {
          params: {
            path: { problem_id: problem.id },
            header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': crypto.randomUUID() },
          },
          body: { reason: reason.trim() },
        }),
      );
      onChanged(response.data);
      setReason('');
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card
      title={t(`problem.${problem.kind}` as AppKey)}
      actions={<Button variant="ghost" icon="x" iconOnly aria-label="Закрыть карточку проблемы" onClick={onClose} />}
    >
      <div className="pg-cluster">
        <Badge tone={SEVERITY_TONE[problem.severity]} icon={problem.severity === 'high' ? 'alert' : 'dot'}>
          {t(`severity.${problem.severity}` as AppKey)}
        </Badge>
        <Badge tone="neutral">{t(`problemStatus.${problem.status}` as AppKey)}</Badge>
      </div>
      <section className="gal-col">
        <h4>{t('col.description')}</h4>
        <p>{problem.description}</p>
      </section>
      <Notice tone="info" icon="info" title={t('col.recommendation')}>
        {problem.recommendation}
      </Notice>
      <dl className="pg-dl">
        <dt>{t('col.zone')}</dt>
        <dd><ZoneLabel id={problem.zone_id} /></dd>
        <dt>{t('col.sources')}</dt>
        <dd>{problem.source_refs.length}</dd>
      </dl>
      <Link className="pg-btn pg-btn--primary pg-btn--md" to={`/?city=${encodeURIComponent(cityId)}&zone=${encodeURIComponent(problem.zone_id)}`}>
        Открыть на карте
      </Link>
      {hasRole('specialist') && problem.status !== 'dismissed' ? (
        <section className="gal-col">
          <Field label="Причина отклонения" hint="Решение сохранится в журнале аудита">
            {({ id }) => (
              <textarea
                id={id}
                className="pg-input"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
          <Button variant="secondary" disabled={!reason.trim() || saving} onClick={dismiss}>
            {saving ? 'Сохраняем…' : 'Отклонить проблему'}
          </Button>
          {error ? <ApiErrorView error={error} onRetry={dismiss} /> : null}
        </section>
      ) : null}
      {problem.dismissal_reason ? (
        <Notice tone="neutral" title="Причина отклонения">
          {problem.dismissal_reason}
        </Notice>
      ) : null}
      <details>
        <summary>Технические детали</summary>
        <dl className="pg-dl">
          <dt>Правило</dt>
          <dd>{short(problem.rule_version_id)}</dd>
          <dt>ID проблемы</dt>
          <dd>{short(problem.id)}</dd>
        </dl>
      </details>
    </Card>
  );
}

const WF_TONE: Record<Program['status'], Tone> = { draft: 'neutral', in_review: 'info', approved: 'positive', archived: 'neutral' };

export function ProgramsPage() {
  const columns: Column<Program>[] = [
    { key: 'name', header: t('col.name'), render: (p) => p.name },
    { key: 'status', header: t('col.status'), render: (p) => <Badge tone={WF_TONE[p.status]}>{t(`wf.${p.status}` as AppKey)}</Badge> },
    { key: 'budget', header: t('col.budget'), render: (p) => <MoneyText value={p.capital_budget} />, align: 'end' },
    { key: 'rev', header: 'Оптимизация', render: (p) => <Badge tone={p.current_revision_id ? 'positive' : 'neutral'}>{p.current_revision_id ? 'результат готов' : 'ещё не запускалась'}</Badge> },
    { key: 'upd', header: t('col.updated'), render: (p) => formatDateTime(p.updated_at) },
  ];
  return (
    <Page title="page.program" description="page.program.desc">
      <CityGate>{(city) => <ProgramList city={city} columns={columns} />}</CityGate>
    </Page>
  );
}

function ProgramList({ city, columns }: { city: City; columns: Column<Program>[] }) {
  const { hasRole } = useSession();
  const [selected, setSelected] = useSelected();
  const [rows, setRows] = useState<Program[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const current = rows.find((p) => p.id === selected) ?? null;
  useEffect(() => {
    if (!selected && rows.length) setSelected(rows[0]!.id);
  }, [rows, selected, setSelected]);
  return (
    <>
      <WorkspaceOverview
        items={[
          { icon: 'target', label: 'Всего программ', value: rows.length, note: 'в городском контуре', tone: 'accent' },
          { icon: 'check', label: 'Утверждено', value: rows.filter((item) => item.status === 'approved').length, note: 'готовы к исполнению', tone: 'positive' },
          { icon: 'clock', label: 'На рассмотрении', value: rows.filter((item) => item.status === 'in_review').length, note: 'ожидают решения' },
          { icon: 'table', label: 'Черновики', value: rows.filter((item) => item.status === 'draft').length, note: 'можно продолжить' },
        ]}
      />
      <div className={selected ? 'app-split program-workspace is-open' : 'app-split program-workspace'}>
        <ResourceList
        selectedId={selected}
        onSelect={(p) => setSelected(p.id)}
        onRows={setRows}
        resource="programs"
        operationId="listPrograms"
        caption={t('page.program')}
        params={{ city: city.id }}
        columns={columns}
        getRowId={(p) => p.id}
        toolbar={hasRole('specialist') ? <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>{t('program.create')}</Button> : null}
        empty={{
          title: t('page.program.empty'),
          description: t('page.program.empty.desc'),
          actions: (
            <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/projects?city=${city.id}`}>
              {t('empty.toProjects')}
            </Link>
          ),
        }}
        fetchPage={async (cursor, signal) => (await unwrap(api.GET('/v1/programs', { params: { query: { city_id: city.id, cursor, limit: 100 } }, signal }))).data}
      />
        {current ? <ProgramDetail program={current} timeZone={city.timezone} onClose={() => setSelected(null)} /> : null}
      </div>
      <ProgramCreateDialog
        cityId={city.id}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(program) => {
          setRows((items) => [program, ...items.filter((item) => item.id !== program.id)]);
          setSelected(program.id);
        }}
      />
    </>
  );
}

function ProjectsList({ city }: { city: City }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Scenario[]>([]);
  const zones = useQuery({
    queryKey: ['project-zone-names', city.id],
    queryFn: async ({ signal }) =>
      (await unwrap(api.GET('/v1/zones', { params: { query: { city_id: city.id, limit: 200 } }, signal }))).data.items as Zone[],
  });
  const zoneNames = new Map((zones.data ?? []).map((zone) => [zone.id, zone.name]));
  const columns: Column<Scenario>[] = [
    { key: 'name', header: t('col.name'), render: (s) => s.name },
    { key: 'zone', header: t('col.zone'), render: (s) => zoneNames.get(s.zone_id) ?? 'Загрузка участка…' },
    { key: 'status', header: t('col.status'), render: (s) => <Badge tone={WF_TONE[s.status]}>{t(`wf.${s.status}` as AppKey)}</Badge> },
    { key: 'upd', header: t('col.updated'), render: (s) => formatDateTime(s.updated_at) },
  ];
  return (
    <>
      <WorkspaceOverview
        items={[
          { icon: 'sprout', label: 'Проекты участков', value: rows.length, note: 'варианты озеленения', tone: 'accent' },
          { icon: 'check', label: 'Утверждено', value: rows.filter((item) => item.status === 'approved').length, note: 'готово к исполнению', tone: 'positive' },
          { icon: 'clock', label: 'На рассмотрении', value: rows.filter((item) => item.status === 'in_review').length, note: 'ожидает решения' },
          { icon: 'map', label: 'Участки города', value: zones.data?.length ?? '—', note: 'доступно для проекта' },
        ]}
      />
      <WorkspaceSteps
        label="Как подготовить проект участка"
        items={[
          { icon: 'map', title: 'Выберите участок', description: 'Откройте существующую территорию или нарисуйте новую на карте' },
          { icon: 'sprout', title: 'Соберите вариант', description: 'Добавьте растения и разместите их внутри границ участка' },
          { icon: 'refresh', title: 'Запустите расчёт', description: 'Получите стоимость, план ухода и ожидаемые эффекты' },
          { icon: 'check', title: 'Согласуйте решение', description: 'Сравните варианты и передайте выбранный проект в программу' },
        ]}
      />
      {(zones.data ?? []).length ? (
        <section className="project-showcase" aria-labelledby="project-showcase-title">
          <header>
            <span><small>Готовые территории</small><strong id="project-showcase-title">Откройте проект в контексте места</strong></span>
            <p>У каждой территории — собственный характер, набор вариантов и путь от идеи до исполнения.</p>
          </header>
          <div className="project-showcase__grid">
            {(zones.data ?? []).slice(0, 3).map((zone, index) => {
              const zoneScenarios = rows.filter((scenario) => scenario.zone_id === zone.id);
              const featured = zoneScenarios.find((scenario) => scenario.status === 'approved') ?? zoneScenarios[0];
              const href = featured ? `/projects/${featured.id}?city=${city.id}` : `/?city=${city.id}&zone=${zone.id}`;
              return (
                <Link className="project-showcase__card" to={href} key={zone.id}>
                  <img src={workspaceImage(zone.name, index)} alt="" loading="lazy" />
                  <span className="project-showcase__shade" aria-hidden />
                  <span className="project-showcase__copy">
                    <small>{zoneScenarios.length ? `${zoneScenarios.length} ${zoneScenarios.length === 1 ? 'вариант' : 'варианта'}` : 'готов к проектированию'}</small>
                    <strong>{zone.name}</strong>
                    <em>{featured ? `Открыть «${featured.name}»` : 'Открыть на карте'}</em>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}
      <ResourceList
        resource="scenarios"
        operationId="listScenarios"
        onRows={setRows}
        onSelect={(scenario) => navigate('/projects/' + scenario.id + '?city=' + city.id)}
        caption={t('page.projects')}
        params={{ city: city.id }}
        columns={columns}
        getRowId={(scenario) => scenario.id}
        empty={{ title: t('page.projects.empty'), description: t('page.projects.empty.desc') }}
        fetchPage={async (cursor, signal) =>
          (await unwrap(api.GET('/v1/scenarios', { params: { query: { city_id: city.id, cursor, limit: 100 } }, signal }))).data
        }
      />
    </>
  );
}

export function ProjectsPage() {
  return (
    <Page title="page.projects" description="page.projects.desc">
      <CityGate>{(city) => <ProjectsList city={city} />}</CityGate>
    </Page>
  );
}

export function CatalogPage() {
  const [selected, setSelected] = useSelected();
  const [rows, setRows] = useState<Plant[]>([]);
  const [q, setQ] = useFilter('q');
  const [stratum, setStratum] = useFilter('stratum', ['tree', 'shrub', 'perennial', 'grass'] as const);
  const columns: Column<Plant>[] = [
    {
      key: 'name',
      header: t('col.name'),
      render: (p) => {
        const image = plantImage(p.latin_name);
        return (
          <span className="plant-list-name">
            <span className="plant-list-name__media" aria-hidden="true">
              {image ? <img src={image} alt="" loading="lazy" /> : <Icon name="sprout" size={22} />}
            </span>
            <span className="plant-list-name__copy">
              <strong>{p.russian_name + (p.cultivar ? ` «${p.cultivar}»` : '')}</strong>
              <i>{p.latin_name}</i>
            </span>
          </span>
        );
      },
    },
    { key: 'str', header: t('col.stratum'), render: (p) => t(`stratum.${p.stratum}` as AppKey) },
    { key: 'flags', header: t('col.expert'), render: (p) => <CatalogStatus plant={p} /> },
  ];
  return (
    <Page title="page.catalog" description="page.catalog.desc">
      <WorkspaceOverview
        items={[
          { icon: 'book', label: 'В каталоге', value: rows.length, note: 'загружено растений', tone: 'accent' },
          { icon: 'sprout', label: 'Деревья', value: rows.filter((item) => item.stratum === 'tree').length, note: 'для городских посадок', tone: 'positive' },
          { icon: 'layers', label: 'Кустарники', value: rows.filter((item) => item.stratum === 'shrub').length, note: 'для нижнего яруса' },
          { icon: 'check', label: 'С характеристиками', value: rows.filter((item) => item.traits.length > 0).length, note: 'карточки для подбора', tone: 'positive' },
        ]}
      />
      <CatalogSpotlight plants={rows} onPick={setSelected} />
      <div className={selected ? 'app-split is-open' : 'app-split'}>
      <ResourceList
        onRows={setRows}
        selectedId={selected}
        onSelect={(p) => setSelected(p.id)}
        resource="plants"
            operationId="listPlants"
        caption={t('page.catalog')}
        params={{ q, stratum }}
        columns={columns}
        getRowId={(p) => p.id}
        empty={{ title: t('page.catalog.empty') }}
        toolbar={
          <>
            <Field label={t('filter.search')}>
              {({ id }) => <Input id={id} type="search" defaultValue={q} onKeyDown={(e) => e.key === 'Enter' && setQ(e.currentTarget.value.trim())} onBlur={(e) => setQ(e.currentTarget.value.trim())} />}
            </Field>
            <Field label={t('filter.stratum')}>
              {({ id }) => (
                <Select id={id} value={stratum} onChange={(e) => setStratum(e.target.value)}>
                  <option value="">{t('filter.all')}</option>
                  {(['tree', 'shrub', 'perennial', 'grass'] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`stratum.${s}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        }
        fetchPage={async (cursor, signal) =>
          (
            await unwrap(
              api.GET('/v1/plants', {
                params: { query: { cursor, limit: 100, q: q || undefined, stratum: stratum || undefined } },
                signal,
              }),
            )
          ).data
        }
      />
      {selected ? <PlantDetail plantId={selected} onClose={() => setSelected(null)} /> : null}
      </div>
    </Page>
  );
}


export function ExecutionPage() {
  const session = useSession();
  const [status, setStatus] = useFilter('status', ['planned', 'assigned', 'in_progress', 'completed', 'cancelled'] as const);
  const [zoneId, setZoneId] = useFilter('zone');
  const [operation, setOperation] = useFilter('operation');
  const [assignee, setAssignee] = useFilter('assignee');
  const [plannedFrom, setPlannedFrom] = useFilter('from');
  const [plannedTo, setPlannedTo] = useFilter('to');
  const [executionParams, setExecutionParams] = useSearchParams();
  const [order, setOrder] = useSelected('order');
  const [cohort, setCohort] = useSelected('cohort');
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const zones = useZones(session.city?.id ?? null);
  const clearWorkFilters = () => {
    const next = new URLSearchParams(executionParams);
    for (const key of ['status', 'zone', 'operation', 'assignee', 'from', 'to']) next.delete(key);
    setExecutionParams(next, { replace: true });
  };
  const activeWorkFilters = [status, zoneId, operation, assignee, plannedFrom, plannedTo].filter(Boolean).length;
  const orderPresence = useQuery({
    queryKey: ['execution-order-presence', session.city?.id ?? ''],
    enabled: Boolean(session.city),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/work-orders', { params: { query: { city_id: session.city!.id, limit: 1 } }, signal }))
    ).data.items as WorkOrder[],
  });
  const hasOrders = Boolean(orderPresence.data?.length);
  const columns: Column<WorkOrder>[] = [
    { key: 'op', header: t('col.operation'), render: (w) => w.operation },
    { key: 'zone', header: t('col.zone'), render: (w) => <ZoneLabel id={w.zone_id} /> },
    { key: 'win', header: t('col.window'), render: (w) => `${formatDate(w.planned_start)} – ${formatDate(w.planned_end)}` },
    {
      key: 'done',
      header: t('col.progress'),
      align: 'end',
      render: (w) => (
        <>
          {formatNumber(w.completed_quantity, 1)} / {formatNumber(w.quantity, 1)} <UnitText unit={w.unit} />
        </>
      ),
    },
    { key: 'who', header: t('col.assignee'), render: (w) => w.assignee_group ?? t('none') },
    { key: 'st', header: t('col.status'), render: (w) => <Badge tone={WO_TONE[w.status]}>{t(`wo.${w.status}` as AppKey)}</Badge> },
  ];
  return (
    <Page title="page.execution" description="page.execution.desc">
      <CityGate>
        {(city) => (
          <>
            <ProgramCarePlan cityId={city.id} />
            {orderPresence.isError ? <ApiErrorView compact error={orderPresence.error} onRetry={() => void orderPresence.refetch()} /> : null}
            {hasOrders ? <div className="execution-live-head">
              <span><small>Фактическое исполнение</small><strong>Наряды и подтверждённые результаты</strong></span>
              <p>Этот блок начинает заполняться только после утверждения проектов и передачи расчётного плана бригадам.</p>
            </div> : null}
            {hasOrders ? <WorkspaceOverview
              items={[
                { icon: 'calendar', label: 'Все работы', value: orders.length, note: 'в текущем контуре', tone: 'accent' },
                { icon: 'clock', label: 'Запланировано', value: orders.filter((item) => item.status === 'planned' || item.status === 'assigned').length, note: 'ожидают начала' },
                { icon: 'refresh', label: 'Выполняется', value: orders.filter((item) => item.status === 'in_progress').length, note: 'активные задания', tone: 'warning' },
                { icon: 'check', label: 'Завершено', value: orders.filter((item) => item.status === 'completed').length, note: 'результат зафиксирован', tone: 'positive' },
              ]}
            /> : null}
            {hasOrders ? <section className="execution-visual" aria-labelledby="execution-visual-title">
              <img src="/workspaces/execution-care.webp" alt="Бригада выполняет посадку и фиксирует результат" />
              <div>
                <small>Единый цикл исполнения</small>
                <h2 id="execution-visual-title">От посадки до подтверждённого результата</h2>
                <p>Наряд, бригада, фактический расход воды и осмотр сохраняются в одной истории участка.</p>
                <span className="execution-visual__flow"><b>01</b> Посадка <i /> <b>02</b> Уход <i /> <b>03</b> Осмотр</span>
              </div>
            </section> : null}
            {hasOrders ? <WorkspaceSteps
              label="Как выполняются городские работы"
              items={[
                { icon: 'calendar', title: 'Запланировать', description: 'Создать наряд из утверждённого проекта участка' },
                { icon: 'user', title: 'Назначить', description: 'Указать бригаду, сроки и плановый объём работ' },
                { icon: 'refresh', title: 'Выполнить', description: 'Фиксировать фактический объём, воду и время бригады' },
                { icon: 'check', title: 'Проверить результат', description: 'Провести осмотр и сравнить факт с прогнозом проекта' },
              ]}
            /> : null}
            {!orderPresence.isPending && !orderPresence.isError && !hasOrders ? (
              <section className="execution-ready" aria-labelledby="execution-ready-title">
                <div className="execution-ready__intro">
                  <span className="execution-ready__mark"><Icon name="calendar" size={22} /></span>
                  <span><small>Следующий управленческий шаг</small><strong id="execution-ready-title">Согласуйте один из рассчитанных проектов выше</strong><p>После внутреннего утверждения его календарь превращается в наряды. Только затем платформа принимает фактические объёмы, осмотры и замены — поэтому здесь нет выдуманных результатов выполнения.</p></span>
                  <span className="execution-ready__actions">
                    <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/projects?city=${city.id}`}>Все проекты</Link>
                    <CreateWorkOrder city={city} onCreated={(id) => {
                      setOrder(id);
                      void orderPresence.refetch();
                    }} />
                  </span>
                </div>
              </section>
            ) : null}
            {hasOrders ? <section className="app-section" aria-labelledby="exec-orders-h">
              <h2 id="exec-orders-h">{t('exec.orders')}</h2>
              <div className={order ? 'app-split is-open' : 'app-split'}>
                <ResourceList
                  resource="work-orders"
                  operationId="listWorkOrders"
                  caption={t('page.execution')}
                  params={{ city: city.id, status, zoneId, operation, assignee, plannedFrom, plannedTo }}
                  columns={columns}
                  getRowId={(w) => w.id}
                  onRows={setOrders}
                  selectedId={order}
                  onSelect={(w) => setOrder(w.id)}
                  empty={{
                    title: t('page.execution.empty'),
                    description: t('page.execution.empty.desc'),
                    actions: (
                      <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/projects?city=${city.id}`}>
                        {t('empty.toProjects')}
                      </Link>
                    ),
                  }}
                  toolbar={
                    <>
                      <Field label={t('filter.status')}>
                        {({ id }) => (
                          <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
                            <option value="">{t('filter.all')}</option>
                            {(['planned', 'assigned', 'in_progress', 'completed', 'cancelled'] as const).map((s) => (
                              <option key={s} value={s}>
                                {t(`wo.${s}`)}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field label="Участок">
                        {({ id }) => (
                          <Select id={id} value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                            <option value="">Все участки</option>
                            {(zones.data?.items ?? []).map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
                          </Select>
                        )}
                      </Field>
                      <Field label="Операция">
                        {({ id }) => <Input id={id} type="search" value={operation} placeholder="Например, полив" onChange={(e) => setOperation(e.target.value)} />}
                      </Field>
                      <Field label="Бригада">
                        {({ id }) => <Input id={id} type="search" value={assignee} placeholder="Название группы" onChange={(e) => setAssignee(e.target.value)} />}
                      </Field>
                      <Field label="Работы с">
                        {({ id }) => <Input id={id} type="date" value={plannedFrom} onChange={(e) => setPlannedFrom(e.target.value)} />}
                      </Field>
                      <Field label="Работы до">
                        {({ id }) => <Input id={id} type="date" value={plannedTo} onChange={(e) => setPlannedTo(e.target.value)} />}
                      </Field>
                      {activeWorkFilters ? <Button size="sm" variant="ghost" icon="x" onClick={clearWorkFilters}>Сбросить фильтры ({activeWorkFilters})</Button> : null}
                      <CreateWorkOrder city={city} onCreated={setOrder} />
                    </>
                  }
                  fetchPage={async (cursor, signal) =>
                    (
                      await unwrap(
                        api.GET('/v1/work-orders', {
                          params: {
                            query: {
                              city_id: city.id,
                              cursor,
                              limit: 100,
                              zone_id: zoneId || undefined,
                              status: status || undefined,
                              operation: operation.trim() || undefined,
                              assignee_group: assignee.trim() || undefined,
                              planned_from: plannedFrom || undefined,
                              planned_to: plannedTo || undefined,
                            },
                          },
                          signal,
                        }),
                      )
                    ).data
                  }
                />
                {order ? <WorkOrderDetail key={order} id={order} timeZone={city.timezone} onClose={() => setOrder(null)} /> : null}
              </div>
            </section> : null}
            {hasOrders ? <section className="app-section" aria-labelledby="exec-cohorts-h">
              <h2 id="exec-cohorts-h">{t('exec.cohorts')}</h2>
              <p className="pg-muted">{t('exec.cohorts.desc')}</p>
              <CohortsPanel city={city} selected={cohort} onSelect={setCohort} />
            </section> : null}
          </>
        )}
      </CityGate>
    </Page>
  );
}

const ACCESS_TONE: Record<Dataset['access_level'], Tone> = { public: 'positive', internal: 'info', restricted: 'warning' };
const DATASET_KIND_LABELS: Record<Dataset['kind'], string> = {
  boundary: 'Граница города', zones: 'Проектные участки', soil: 'Почвы', green_inventory: 'Зелёные насаждения',
  buildings: 'Здания', roads: 'Дороги', water: 'Водные объекты', population: 'Население', social_poi: 'Социальные объекты',
  restrictions: 'Ограничения', weather: 'Погода', raster: 'Растровый слой', catalog: 'Каталог растений', stock: 'Предложения поставщиков',
  models: 'Модели', rates: 'Тарифы и расценки', observations: 'Наблюдения',
};

function datasetColumns(): Column<Dataset>[] {
  return [
    { key: 'name', header: t('col.name'), render: (d) => productLabel(d.name) },
    { key: 'kind', header: t('col.kind'), render: (d) => DATASET_KIND_LABELS[d.kind] },
    { key: 'owner', header: t('col.owner'), render: (d) => d.owner },
    { key: 'lic', header: t('col.license'), render: (d) => d.license },
    {
      key: 'acc',
      header: t('col.access'),
      render: (d) => (
        <Badge tone={ACCESS_TONE[d.access_level]} icon={d.access_level === 'restricted' ? 'lock' : undefined}>
          {t(`access.${d.access_level}` as AppKey)}
        </Badge>
      ),
    },
    { key: 'ver', header: t('col.version'), render: (d) => <Badge tone={d.current_version_id ? 'positive' : 'neutral'}>{d.current_version_id ? 'опубликована' : t('notPublished')}</Badge> },
    { key: 'cr', header: t('col.created'), render: (d) => formatDateTime(d.created_at) },
  ];
}

function DatasetList({ title }: { title: AppKey }) {
  const [selected, setSelected] = useSelected();
  const [rows, setRows] = useState<Dataset[]>([]);
  const current = rows.find((d) => d.id === selected) ?? null;
  return (
    <CityGate>
      {(city) => (
        <>
          <WorkspaceOverview
            items={[
              { icon: 'database', label: 'Наборы данных', value: rows.length, note: 'загружено для города', tone: 'accent' },
              { icon: 'check', label: 'Опубликовано', value: rows.filter((item) => item.current_version_id).length, note: 'доступно платформе', tone: 'positive' },
              { icon: 'map', label: 'Открытые', value: rows.filter((item) => item.access_level === 'public').length, note: 'общегородской доступ' },
              { icon: 'lock', label: 'Ограниченные', value: rows.filter((item) => item.access_level === 'restricted').length, note: 'по выданным правам', tone: 'warning' },
            ]}
          />
          <div className={selected ? 'app-split is-open' : 'app-split'}>
          <ResourceList
          selectedId={selected}
          onSelect={(d) => setSelected(d.id)}
          onRows={setRows}
          resource="datasets"
            operationId="listDatasets"
          caption={t(title)}
          params={{ city: city.id }}
          columns={datasetColumns()}
          getRowId={(d) => d.id}
          empty={{ title: t('page.imports.empty') }}
          fetchPage={async (cursor, signal) =>
            (await unwrap(api.GET('/v1/datasets', { params: { query: { city_id: city.id, cursor, limit: 100 } }, signal }))).data
          }
        />
          {current ? <DatasetDetail dataset={current} onClose={() => setSelected(null)} /> : null}
          </div>
        </>
      )}
    </CityGate>
  );
}

export function ImportsPage() {
  return (
    <Page title="page.imports" description="page.imports.desc">
      <DataSectionNav />
      <CityGate>
        {(city) => (
          <Suspense fallback={<Skeleton lines={6} />}>
            <ImportWizard city={city} />
          </Suspense>
        )}
      </CityGate>
      <section className="app-section" aria-labelledby="imp-registry-h">
        <h2 id="imp-registry-h">{t('sources.registry')}</h2>
        <DatasetList title="page.imports" />
      </section>
    </Page>
  );
}

function ReadinessSection() {
  const available = useOperationAvailable('listSourceReadiness');
  const [, setSelected] = useSelected();
  return (
    <CityGate>
      {(city) => <ReadinessForCity cityId={city.id} available={available} onOpen={(id) => setSelected(id)} />}
    </CityGate>
  );
}

function ReadinessForCity({ cityId, available, onOpen }: { cityId: string; available: boolean | null; onOpen: (id: string) => void }) {
  // Names for display only; the same list the registry section below shows.
  const names = useQuery({
    queryKey: ['dataset-names', cityId],
    queryFn: async ({ signal }) => {
      const { data } = await unwrap(api.GET('/v1/datasets', { params: { query: { city_id: cityId, limit: 200 } }, signal }));
      return Object.fromEntries(data.items.map((d) => [d.id, productLabel(d.name)])) as Record<string, string>;
    },
  });
  const q = useQuery({
    queryKey: ['source-readiness', cityId],
    enabled: available !== false,
    queryFn: async ({ signal }) => {
      const items: SourceReadiness[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const { data } = await unwrap(api.GET('/v1/source-readiness', { params: { query: { city_id: cityId, limit: 200, cursor } }, signal }));
        items.push(...data.items);
        if (!data.next_cursor) break;
        cursor = data.next_cursor;
      }
      return items;
    },
  });
  if (available === false) return <OperationUnavailable operationId="listSourceReadiness" />;
  if (q.isPending) return <Skeleton lines={4} />;
  if (q.isError) return <ApiErrorView error={q.error} onRetry={() => void q.refetch()} />;
  if (q.data.length === 0) return <StateView compact state="empty" title={t('sources.readiness.empty')} />;
  const today = new Date().toISOString().slice(0, 10);
  return <SourceReadinessList items={q.data} today={today} onOpenDataset={onOpen} datasetNames={names.data} />;
}

export function SourcesPage() {
  return (
    <Page title="page.sources" description="page.sources.desc">
      <DataSectionNav />
      <WorkspaceSteps
        label="Как данные попадают в платформу"
        items={[
          { icon: 'database', title: 'Зарегистрировать', description: 'Указать владельца, назначение, лицензию и уровень доступа' },
          { icon: 'upload', title: 'Загрузить версию', description: 'Добавить новый файл без перезаписи предыдущих данных' },
          { icon: 'check', title: 'Проверить качество', description: 'Исправить блокирующие ошибки структуры и геометрии' },
          { icon: 'map', title: 'Опубликовать', description: 'Сделать версию доступной карте, расчётам и проектам' },
        ]}
      />
      <section className="app-section" aria-labelledby="readiness-h">
        <h2 id="readiness-h">{t('sources.readiness')}</h2>
        <p className="pg-muted">{t('sources.readiness.desc')}</p>
        <ReadinessSection />
      </section>
      <section className="app-section" aria-labelledby="registry-h">
        <h2 id="registry-h">{t('sources.registry')}</h2>
        <DatasetList title="page.sources" />
      </section>
    </Page>
  );
}

export function ReferencePage() {
  const columns: Column<Rate>[] = [
    { key: 'cat', header: t('col.category'), render: (r) => r.category },
    { key: 'unit', header: t('col.unit'), render: (r) => <UnitText unit={r.unit} /> },
    { key: 'price', header: t('col.price'), render: (r) => <MoneyText value={r.unit_price} />, align: 'end' },
    { key: 'tax', header: t('col.tax'), render: (r) => t(`tax.${r.tax_mode}` as AppKey) },
    { key: 'from', header: t('col.validFrom'), render: (r) => formatDate(r.valid_from) },
    { key: 'src', header: t('col.sources'), render: (r) => r.source_refs.length, align: 'end' },
  ];
  const coefficientColumns: Column<Coefficient>[] = [
    { key: 'key', header: 'Показатель', render: (item) => item.key },
    { key: 'value', header: 'Значение', render: (item) => formatNumber(item.value), align: 'end' },
    { key: 'unit', header: t('col.unit'), render: (item) => <UnitText unit={item.unit} /> },
    { key: 'scope', header: 'Применимость', render: (item) => item.applicability },
    { key: 'status', header: t('col.status'), render: (item) => <Badge tone={item.expert_status === 'approved' ? 'positive' : item.expert_status === 'rejected' ? 'negative' : 'warning'}>{item.expert_status === 'approved' ? 'Утверждён' : item.expert_status === 'rejected' ? 'Отклонён' : 'На проверке'}</Badge> },
    { key: 'src', header: t('col.sources'), render: (item) => item.source_refs.length, align: 'end' },
  ];
  return (
    <Page title="page.reference" description="page.reference.desc">
      <DataSectionNav />
      <CityGate>
        {(city) => (
          <div className="gal-col">
            <section className="app-section" aria-labelledby="rates-heading">
              <h2 id="rates-heading">Расценки</h2>
              <ResourceList
                resource="rates"
                operationId="listRates"
                caption="Расценки"
                params={{ city: city.id }}
                columns={columns}
                getRowId={(r) => r.version_id}
                empty={{ title: t('page.reference.empty') }}
                fetchPage={async (cursor, signal) =>
                  (await unwrap(api.GET('/v1/rates', { params: { query: { city_id: city.id, cursor, limit: 100 } }, signal }))).data
                }
              />
            </section>
            <section className="app-section" aria-labelledby="coefficients-heading">
              <h2 id="coefficients-heading">Экологические коэффициенты</h2>
              <p className="pg-muted">Версионированные параметры, которые используются в воспроизводимых расчётах.</p>
              <ResourceList
                resource="coefficients"
                operationId="listCoefficients"
                caption="Экологические коэффициенты"
                params={{ city: city.id }}
                columns={coefficientColumns}
                getRowId={(item) => item.version_id}
                empty={{ title: 'Коэффициенты ещё не зарегистрированы' }}
                fetchPage={async (cursor, signal) =>
                  (await unwrap(api.GET('/v1/coefficients', { params: { query: { cursor, limit: 100 } }, signal }))).data
                }
              />
            </section>
          </div>
        )}
      </CityGate>
    </Page>
  );
}

export function AdminPage() {
  const { me, hasRole } = useSession();
  return (
    <Page title="page.admin" description="page.admin.desc">
      {me.data && !hasRole('admin') ? (
        <StateView state="forbidden" title={t('grants.forbidden')} description={t('page.admin.forbidden.desc')} />
      ) : (
        <CityGate>
          {(city) => (
            <>
              <section className="app-section" aria-labelledby="adm-access-h">
                <h2 id="adm-access-h">{t('grants.section')}</h2>
                <AccessAdmin city={city} />
              </section>
              <section className="app-section" aria-labelledby="adm-users-h">
                <h2 id="adm-users-h">{t('grants.users', { city: cityDisplayName(city.name) })}</h2>
                <CityUsers city={city} />
              </section>
              <section className="app-section" aria-labelledby="adm-audit-h">
                <h2 id="adm-audit-h">{t('page.admin.audit')}</h2>
                <AuditLog cityId={city.id} />
              </section>
            </>
          )}
        </CityGate>
      )}
    </Page>
  );
}

function AuditLog({ cityId }: { cityId: string }) {
  // Actor names come from the city's user list; actors outside it keep their id.
  const principals = useCityPrincipals(cityId).query.data?.items;
  const people = new Map((principals ?? []).map((p) => [p.id, p.display_name]));
  const columns: Column<AuditEvent>[] = [
    { key: 'at', header: t('col.time'), render: (a) => formatDateTime(a.occurred_at) },
    { key: 'actor', header: t('col.actor'), render: (a) => people.get(a.actor_id) ?? short(a.actor_id) },
    { key: 'act', header: t('col.action'), render: (a) => <code className="pg-code">{a.action}</code> },
    { key: 'obj', header: t('col.object'), render: (a) => <>{a.object_type} {short(a.object_id)}</> },
    { key: 'why', header: t('col.reason'), render: (a) => a.reason ?? t('none') },
  ];
  return (
    <ResourceList
      resource="audit"
      operationId="listAuditEvents"
      caption={t('page.admin.audit')}
      params={{}}
      columns={columns}
      getRowId={(a) => a.id}
      empty={{ title: t('page.admin.empty') }}
      fetchPage={async (cursor, signal) =>
        (await unwrap(api.GET('/v1/audit', { params: { query: { cursor, limit: 100 } }, signal }))).data
      }
    />
  );
}
