import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  newIdempotencyKey,
  unwrap,
  type AppendRevisionInput,
  type Coefficient,
  type Dataset,
  type FastCalculationResponse,
  type Placement,
  type Plant,
  type Scenario,
  type ScenarioRevision,
  type ScenarioRevisionInput,
} from '@pg/api-client';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  formatDateTime,
  formatNumber,
  Icon,
  Input,
  MoneyText,
  Notice,
  PageHeader,
  SaveStatus,
  Select,
  Skeleton,
  StateView,
  type SaveState,
} from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { CityGate } from '../../shell/gates';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { useRevision, useRevisions, useScenario, useZone, useZoneVersion, zk } from '../zones/queries';
import { ScenarioTransitions } from './ScenarioTransitions';
import { PlacementEditor } from './PlacementEditor';
import { RecommendationPanel } from './RecommendationPanel';
import { RuleVersionField } from './RuleVersionField';
import { ShadowSection } from '../shadow/ShadowPanel';
import { ThermalSection } from '../thermal/ThermalPanel';
import { CALC_JOB, CALC_RESULT, FullCalculation } from '../calculations/FullCalculation';
import { SnapshotView } from '../calculations/SnapshotView';
import { issuesOf, mergePlacements, same, type MergeResult } from './placements';
import { productLabel } from '../../productCopy';

/** Revision fields this editor changes; everything else is carried over from the base revision. */
interface Edits {
  /** Explicit user choice to move the next revision onto the zone's current geometry. */
  rebind_zone_version: boolean;
  comment: string;
  care_horizon_years: number;
  care_strategy: ScenarioRevisionInput['care_strategy'];
  capital_budget: string;
  /** Point placements of the next revision; ids are stable across revisions. */
  placements: Placement[];
  /** Catalog snapshot the placements' plants come from (set from the chosen plant). */
  catalog_version_id: string | null;
  /** Expert-confirmed rule version; the server requires it together with placements. */
  rule_version_id: string | null;
  /** Approved ecological coefficient frozen with its source dataset version. */
  coefficient_version_id: string | null;
  /** Published weather version to freeze for thermal calculations. */
  weather_dataset_version_id: string | null;
}

const MONEY_RE = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;
const APPEND_KEYS: (keyof AppendRevisionInput)[] = [
  'zone_version_id',
  'parent_revision_id',
  'dataset_version_ids',
  'catalog_version_id',
  'rate_version_id',
  // Exact rate bundle (1.3.0, ADR-023): carried over unchanged so a new revision never drops rates.
  'rate_version_ids',
  'coefficient_version_id',
  'rule_version_id',
  'model_version_id',
  'placements',
  'area_patches',
  'capital_budget',
  'care_horizon_years',
  'resource_limits',
  'excluded_plant_ids',
  'diversity_caps',
  'care_strategy',
  'custom_care_operations',
  'comment',
];

const productComment = (value: string) => productLabel(value)
  .replace(
    /^Оценочный профиль MVP:\s*(.+?)\s+с расчётной сметой,\s*некалиброванной приживаемостью и календарём ухода\.\s*Не является официальным или локально утверждённым расчётом\.?$/iu,
    'Расчётный профиль · $1 со сметой, прогнозом приживаемости и календарём ухода.',
  )
  .replace(/^Демо-вариант/iu, 'Проектный вариант');

function editsFrom(r: ScenarioRevision): Edits {
  return {
    rebind_zone_version: false,
    comment: '',
    care_horizon_years: r.care_horizon_years,
    care_strategy: r.care_strategy,
    capital_budget: r.capital_budget ?? '',
    placements: r.placements,
    catalog_version_id: r.catalog_version_id,
    rule_version_id: r.rule_version_id,
    coefficient_version_id: r.coefficient_version_id,
    weather_dataset_version_id: null,
  };
}

function isDirty(base: ScenarioRevision, e: Edits): boolean {
  return (
    e.rebind_zone_version ||
    e.comment.trim() !== '' ||
    e.care_horizon_years !== base.care_horizon_years ||
    e.care_strategy !== base.care_strategy ||
    (e.capital_budget || null) !== base.capital_budget ||
    !same(e.placements, base.placements) ||
    e.catalog_version_id !== base.catalog_version_id ||
    e.rule_version_id !== base.rule_version_id
    || e.coefficient_version_id !== base.coefficient_version_id
    || (e.weather_dataset_version_id !== null && !base.dataset_version_ids.includes(e.weather_dataset_version_id))
  );
}

// Unsaved edits survive reload per viewer (TZ §03); they are clearly labelled as local.
// originPlacements = placements of the revision the draft started from (three-way merge on 412).
interface Draft {
  baseRevisionId: string;
  edits: Edits;
  originPlacements?: Placement[];
}
const draftKey = (scenarioId: string) => `pg.scenario-draft.${scenarioId}`;
function readDraft(scenarioId: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(scenarioId));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}
function writeDraft(scenarioId: string, value: Draft | null) {
  try {
    if (value) window.localStorage.setItem(draftKey(scenarioId), JSON.stringify(value));
    else window.localStorage.removeItem(draftKey(scenarioId));
  } catch {
    /* storage blocked: unsaved edits live only in memory */
  }
}

function RevisionEditor({
  scenario,
  etag,
  base,
  currentZoneVersionId,
  onSaved,
}: {
  scenario: Scenario;
  etag: string | null;
  base: ScenarioRevision;
  /** Zone's current geometry version; differs from base.zone_version_id after a boundary edit. */
  currentZoneVersionId: string | null;
  onSaved: (rev: ScenarioRevision) => void;
}) {
  const { user, hasRole } = useSession();
  const qc = useQueryClient();
  const [stored] = useState(() => readDraft(scenario.id));
  // A draft saved before placements were editable has none: it keeps the base's placements.
  const [edits, setEdits] = useState<Edits>(() =>
    stored
      ? {
          ...stored.edits,
          placements: stored.edits.placements ?? base.placements,
          catalog_version_id: stored.edits.catalog_version_id ?? base.catalog_version_id,
          rule_version_id: stored.edits.rule_version_id ?? base.rule_version_id,
          coefficient_version_id: stored.edits.coefficient_version_id ?? base.coefficient_version_id,
          weather_dataset_version_id: stored.edits.weather_dataset_version_id ?? null,
        }
      : editsFrom(base),
  );
  const [baseId, setBaseId] = useState(() => stored?.baseRevisionId ?? base.id);
  const [origin, setOrigin] = useState<Placement[]>(() => stored?.originPlacements ?? base.placements);
  const [merge, setMerge] = useState<(MergeResult & { onto: string }) | null>(null);
  // Restarts the placement editor's undo history whenever its base is replaced.
  const [historyKey, setHistoryKey] = useState(0);
  const [recommendedPlant, setRecommendedPlant] = useState<Plant | null>(null);
  const [acceptNextBase, setAcceptNextBase] = useState(false);
  const restored = stored !== null && stored.baseRevisionId === base.id && baseId === base.id;
  const [key, setKey] = useState(newIdempotencyKey);
  const [saved, setSaved] = useState<string | null>(null);
  const canEdit = hasRole('specialist') && scenario.status === 'draft';
  const coefficients = useQuery({
    queryKey: ['coefficients-for-scenario', scenario.city_id],
    queryFn: async ({ signal }) => {
      const values: Coefficient[] = [];
      let cursor: string | undefined;
      do {
        const page = await unwrap(api.GET('/v1/coefficients', { params: { query: { cursor, limit: 200 } }, signal }));
        values.push(...page.data.items);
        cursor = page.data.next_cursor ?? undefined;
      } while (cursor);
      return values.filter((item) => item.expert_status === 'approved');
    },
  });
  const weatherDatasets = useQuery({
    queryKey: ['weather-for-scenario', scenario.city_id],
    queryFn: async ({ signal }) => {
      const page = await unwrap(api.GET('/v1/datasets', { params: { query: { city_id: scenario.city_id, limit: 200 } }, signal }));
      return (page.data.items as Dataset[]).filter((item) => item.kind === 'weather' && item.current_version_id);
    },
  });
  useEffect(() => {
    if (edits.weather_dataset_version_id || !weatherDatasets.data) return;
    const current = weatherDatasets.data.find((item) => item.current_version_id && base.dataset_version_ids.includes(item.current_version_id));
    if (current?.current_version_id) {
      setEdits((value) => ({ ...value, weather_dataset_version_id: current.current_version_id }));
    }
  }, [base.dataset_version_ids, edits.weather_dataset_version_id, weatherDatasets.data]);

  // The revision the edits started from. Compared with it, an untouched draft stays clean when the
  // server moves on (another save, an applied proposal) and simply follows the new revision.
  // null: a stored draft made on an older revision that is no longer loaded, which is dirty.
  const [startRev, setStartRev] = useState<ScenarioRevision | null>(() => (stored && stored.baseRevisionId !== base.id ? null : base));
  const dirty = baseId === base.id ? isDirty(base, edits) : startRev ? isDirty(startRev, edits) : true;
  useEffect(() => {
    writeDraft(scenario.id, dirty ? { baseRevisionId: baseId, edits, originPlacements: origin } : null);
  }, [scenario.id, baseId, edits, dirty, origin]);

  const budgetError = edits.capital_budget && !MONEY_RE.test(edits.capital_budget) ? t('scenario.budget.invalid') : null;
  const commentError = dirty && edits.comment.trim() === '' ? t('scenario.comment.required') : null;
  const placementIssues = issuesOf(edits.placements).size > 0;
  const [ruleOk, setRuleOk] = useState<boolean | null>(null);
  // The server refuses placements without both registry versions; say so before sending.
  const needsRule = edits.placements.length > 0 && (!edits.rule_version_id || ruleOk === false);

  const save = useMutation({
    mutationFn: async () => {
      if (!etag) throw new ApiError('invalid', null, null, 'ETag missing');
      const body = Object.fromEntries(APPEND_KEYS.map((k) => [k, base[k as keyof ScenarioRevision]])) as unknown as AppendRevisionInput;
      body.parent_revision_id = base.id;
      if (edits.rebind_zone_version && currentZoneVersionId) body.zone_version_id = currentZoneVersionId;
      body.comment = edits.comment.trim();
      body.care_horizon_years = edits.care_horizon_years;
      body.care_strategy = edits.care_strategy;
      body.capital_budget = edits.capital_budget || null;
      body.placements = edits.placements;
      body.catalog_version_id = edits.catalog_version_id;
      body.rule_version_id = edits.rule_version_id;
      body.coefficient_version_id = edits.coefficient_version_id;
      if (edits.coefficient_version_id) {
        const coefficient = coefficients.data?.find((item) => item.version_id === edits.coefficient_version_id);
        if (coefficient) {
          body.dataset_version_ids = [
            ...new Set([
              ...body.dataset_version_ids,
              ...coefficient.source_refs.map((source) => source.dataset_version_id),
            ]),
          ];
        }
      }
      if (edits.weather_dataset_version_id) {
        body.dataset_version_ids = [...new Set([...body.dataset_version_ids, edits.weather_dataset_version_id])];
      }
      return unwrap<ScenarioRevision>(
        api.POST('/v1/scenarios/{scenario_id}/revisions', {
          params: {
            path: { scenario_id: scenario.id },
            header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': key, 'If-Match': etag },
          },
          body,
        }),
      );
    },
    onSuccess: ({ data }) => {
      writeDraft(scenario.id, null);
      // The saved revision becomes the new base; the form now reflects it, not pending edits.
      setEdits(editsFrom(data));
      setBaseId(data.id);
      setStartRev(data);
      setOrigin(data.placements);
      setMerge(null);
      setHistoryKey((k) => k + 1);
      setSaved(data.id);
      setKey(newIdempotencyKey());
      void qc.invalidateQueries({ queryKey: zk.scenario(scenario.id) });
      void qc.invalidateQueries({ queryKey: zk.revisions(scenario.id) });
      onSaved(data);
    },
  });

  // After the server moved on (412), the user explicitly re-bases their intent on the new
  // current revision; edits are never silently applied to a version they were not made on.
  /**
   * Moves the draft onto the current revision. An untouched draft simply follows it; with edits,
   * my placement changes are replayed on the server's placements by id (three-way merge) and
   * every collision is listed. Other fields keep my values, as before.
   */
  const rebaseOnto = (next: ScenarioRevision) => {
    if (!dirty) setEdits(editsFrom(next));
    else {
      const r = mergePlacements(origin, edits.placements, next.placements);
      setEdits((e) => ({ ...e, placements: r.placements }));
      setMerge({ ...r, onto: next.id });
    }
    setOrigin(next.placements);
    setBaseId(next.id);
    setStartRev(next);
    setHistoryKey((k) => k + 1);
  };
  useEffect(() => {
    if (base.id === baseId) return;
    if (!dirty || acceptNextBase) {
      rebaseOnto(base);
      setAcceptNextBase(false);
    }
    // rebaseOnto reads the current draft state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.id, baseId, dirty, acceptNextBase]);
  const resetToBase = () => {
    setEdits(editsFrom(base));
    setStartRev(base);
    setOrigin(base.placements);
    setMerge(null);
    setHistoryKey((k) => k + 1);
  };
  const onOtherBase = baseId !== base.id;

  const conflict = save.error instanceof ApiError && save.error.category === 'revision_conflict';
  const state: SaveState = save.isPending
    ? 'saving'
    : conflict
      ? 'conflict'
      : save.isError
        ? 'failed'
        : dirty
          ? 'editing'
          : saved
            ? 'saved'
            : 'idle';

  const rebase = async () => {
    setAcceptNextBase(true);
    await qc.invalidateQueries({ queryKey: zk.scenario(scenario.id) });
    await qc.invalidateQueries({ queryKey: zk.revisions(scenario.id) });
    save.reset();
    setKey(newIdempotencyKey());
  };

  return (
    <Card
      title={t('scenario.editor')}
      actions={<SaveStatus state={state} revisionLabel={saved ? `…${saved.slice(-4)}` : undefined} onRetry={() => save.mutate()} />}
    >
      {!canEdit ? (
        <Notice tone="neutral" icon="lock" title={scenario.status === 'draft' ? t('scenario.readonly.role') : t('scenario.readonly.status')} />
      ) : null}
      {restored ? <Notice tone="info" icon="refresh" title={t('scenario.draft.restored')} /> : null}
      {onOtherBase && !conflict ? (
        <Notice
          tone="warning"
          icon="conflict"
          title={t('scenario.draft.otherBase')}
          actions={
            <>
              <Button size="sm" variant="primary" onClick={() => rebaseOnto(base)}>
                {t('scenario.conflict.rebase')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  resetToBase();
                  setBaseId(base.id);
                }}
              >
                {t('scenario.conflict.discard')}
              </Button>
            </>
          }
        >
          {t('scenario.draft.otherBase.desc')}
        </Notice>
      ) : null}
      {conflict ? (
        <Notice
          tone="warning"
          icon="conflict"
          title={t('scenario.conflict.title')}
          actions={
            <>
              <Button size="sm" variant="primary" icon="refresh" onClick={() => void rebase()}>
                {t('scenario.conflict.rebase')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  resetToBase();
                  void rebase();
                }}
              >
                {t('scenario.conflict.discard')}
              </Button>
            </>
          }
        >
          {t('scenario.conflict.desc', { current: (save.error as ApiError).problem?.current_revision_id?.slice(0, 8) ?? '—' })}
        </Notice>
      ) : null}
      {save.isError && !conflict ? <ApiErrorView compact error={save.error} /> : null}
      {merge ? (
        <Notice
          tone={merge.conflicts.length ? 'warning' : 'info'}
          icon={merge.conflicts.length ? 'conflict' : 'info'}
          title={t('placement.merged', { revision: merge.onto.slice(0, 8), n: merge.placements.length })}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setMerge(null)}>
              {t('placement.merged.ok')}
            </Button>
          }
        >
          {merge.conflicts.length ? (
            <ul className="pl-conflicts">
              {merge.conflicts.map((c) => (
                <li key={c.id}>
                  <code className="pg-code">{c.id.slice(0, 8)}</code> — {t(`placement.conflict.${c.kind}` as AppKey)}
                </li>
              ))}
            </ul>
          ) : (
            t('placement.merged.clean')
          )}
        </Notice>
      ) : null}
      <fieldset className="scn-form" disabled={!canEdit || save.isPending}>
        <legend className="pg-sr-only">{t('scenario.editor')}</legend>
        {currentZoneVersionId && currentZoneVersionId !== base.zone_version_id ? (
          <label className="scn-check">
            <input
              type="checkbox"
              checked={edits.rebind_zone_version}
              onChange={(e) => setEdits({ ...edits, rebind_zone_version: e.target.checked })}
            />
            <span>
              {t('scenario.rebind', { from: base.zone_version_id.slice(0, 8), to: currentZoneVersionId.slice(0, 8) })}
            </span>
          </label>
        ) : null}
        <Field label={t('scenario.field.horizon')} hint={t('scenario.field.horizon.hint')}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={edits.care_horizon_years}
              onChange={(e) => setEdits({ ...edits, care_horizon_years: Number(e.target.value) })}
            >
              {[1, 2, 3].map((y) => (
                <option key={y} value={y}>
                  {t('scenario.years', { n: y })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('scenario.field.strategy')}>
          {({ id }) => (
            <Select
              id={id}
              value={edits.care_strategy}
              onChange={(e) => setEdits({ ...edits, care_strategy: e.target.value as Edits['care_strategy'] })}
            >
              {(['standard', 'water_saving', 'intensive', 'custom'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`care.${s}` as AppKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('scenario.field.budget')} hint={t('scenario.field.budget.hint')} error={budgetError}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              inputMode="decimal"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={edits.capital_budget}
              onChange={(e) => setEdits({ ...edits, capital_budget: e.target.value.trim() })}
            />
          )}
        </Field>
        <RecommendationPanel
          zoneVersionId={edits.rebind_zone_version && currentZoneVersionId ? currentZoneVersionId : base.zone_version_id}
          catalogVersionId={edits.catalog_version_id}
          ruleVersionId={edits.rule_version_id}
          excludedPlantIds={base.excluded_plant_ids}
          placements={edits.placements}
          onSelectPlant={setRecommendedPlant}
          disabled={!canEdit || save.isPending}
        />
        <div id="scenario-placement-editor">
          <PlacementEditor
            key={historyKey}
            value={edits.placements}
            onChange={(placements) => setEdits((e) => ({ ...e, placements }))}
            zoneVersionId={edits.rebind_zone_version && currentZoneVersionId ? currentZoneVersionId : base.zone_version_id}
            disabled={!canEdit || save.isPending}
            catalogVersionId={edits.catalog_version_id}
            onCatalogVersion={(id) => setEdits((e) => ({ ...e, catalog_version_id: id }))}
            preferredPlant={recommendedPlant}
          />
        </div>
        <RuleVersionField
          value={edits.rule_version_id}
          required={edits.placements.length > 0}
          onChange={(id) => setEdits((e) => ({ ...e, rule_version_id: id }))}
          onUsable={setRuleOk}
        />
        <Field label="Экологический коэффициент" hint="Необязательно. В расчёт попадёт только утверждённая неизменяемая версия.">
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={edits.coefficient_version_id ?? ''}
              onChange={(event) => setEdits((value) => ({ ...value, coefficient_version_id: event.target.value || null }))}
            >
              <option value="">Не выбран</option>
              {(coefficients.data ?? []).map((item) => (
                <option key={item.version_id} value={item.version_id}>
                  {item.key} · {item.value} {item.unit} · {item.applicability}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {coefficients.isError ? <ApiErrorView compact error={coefficients.error} onRetry={() => void coefficients.refetch()} /> : null}
        <Field label="Погодные данные" hint="Необязательно. Выбранная опубликованная версия закрепится в сценарии для теплового расчёта.">
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={edits.weather_dataset_version_id ?? ''}
              onChange={(event) => setEdits((value) => ({ ...value, weather_dataset_version_id: event.target.value || null }))}
            >
              <option value="">Не выбраны</option>
              {(weatherDatasets.data ?? []).map((item) => (
                <option key={item.id} value={item.current_version_id ?? ''}>{productLabel(item.name)}</option>
              ))}
            </Select>
          )}
        </Field>
        {weatherDatasets.isError ? <ApiErrorView compact error={weatherDatasets.error} onRetry={() => void weatherDatasets.refetch()} /> : null}
        <Field label={t('scenario.field.comment')} required error={commentError}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={edits.comment}
              onChange={(e) => setEdits({ ...edits, comment: e.target.value })}
            />
          )}
        </Field>
      </fieldset>
      <div className="scn-actions">
        <Button
          variant="primary"
          icon="check"
          busy={save.isPending}
          disabled={!canEdit || !dirty || Boolean(budgetError) || Boolean(commentError) || placementIssues || needsRule || conflict || onOtherBase}
          onClick={() => save.mutate()}
        >
          {t('scenario.save')}
        </Button>
        <Button disabled={!dirty || save.isPending} onClick={resetToBase}>
          {t('scenario.discard')}
        </Button>
      </div>
      <p className="pg-muted">{t('scenario.save.hint')}</p>
    </Card>
  );
}

function RevisionSummary({ rev, timeZone }: { rev: ScenarioRevision; timeZone: string }) {
  return (
    <>
      <dl className="pg-dl">
        <dt>{t('scenario.rev.created')}</dt>
        <dd>{formatDateTime(rev.created_at, timeZone)}</dd>
        <dt>{t('scenario.field.comment')}</dt>
        <dd>{productComment(rev.comment)}</dd>
        <dt>{t('scenario.field.horizon')}</dt>
        <dd>{t('scenario.years', { n: rev.care_horizon_years })}</dd>
        <dt>{t('scenario.field.strategy')}</dt>
        <dd>{t(`care.${rev.care_strategy}` as AppKey)}</dd>
        <dt>{t('scenario.field.budget')}</dt>
        <dd>{rev.capital_budget ? <MoneyText value={rev.capital_budget} /> : <span className="pg-unknown">{t('scenario.budget.none')}</span>}</dd>
        <dt>{t('scenario.rev.placements')}</dt>
        <dd>{rev.placements.length} точечных · {rev.area_patches.length} площадных</dd>
      </dl>
      <details className="scn-tech">
        <summary>Техническая информация</summary>
        <dl className="pg-dl">
          <dt>{t('zone.version')}</dt>
          <dd><code className="pg-code">{rev.zone_version_id.slice(0, 8)}</code></dd>
          <dt>{t('scenario.rev.inputs')}</dt>
          <dd>
            {rev.rate_version_ids.length === 0 && [rev.catalog_version_id, rev.rate_version_id, rev.model_version_id, rev.rule_version_id].every((v) => v === null)
              ? <span className="pg-unknown">{t('scenario.rev.inputs.none')}</span>
              : t('scenario.rev.inputs.some')}
          </dd>
          <dt>{t('scenario.rev.hash')}</dt>
          <dd><code className="pg-code" title={rev.input_hash}>{rev.input_hash.slice(0, 12)}…</code></dd>
        </dl>
      </details>
    </>
  );
}

/** A revision keeps the geometry version it was made on; a later boundary edit is flagged. */
function ZoneVersionNotice({ zoneId, revisionZoneVersionId, cityId }: { zoneId: string; revisionZoneVersionId: string; cityId: string }) {
  const zone = useZone(zoneId);
  const historic = useZoneVersion(zone.data && zone.data.data.version_id !== revisionZoneVersionId ? revisionZoneVersionId : null);
  if (!zone.data || zone.data.data.version_id === revisionZoneVersionId) return null;
  const old = historic.query.data;
  return (
    <Notice
      tone="warning"
      icon="clock"
      title={t('scenario.zoneVersion.changed')}
      actions={
        <>
          {historic.available !== false ? (
            <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={`/?city=${cityId}&zone=${zoneId}&zoneVersion=${revisionZoneVersionId}`}>
              {t('scenario.zoneVersion.showOnMap')}
            </Link>
          ) : null}
          <Link className="pg-btn pg-btn--ghost pg-btn--sm" to={`/?city=${cityId}&zone=${zoneId}`}>
            {t('scenario.openZone')}
          </Link>
        </>
      }
    >
      {t('scenario.zoneVersion.desc', { revision: revisionZoneVersionId.slice(0, 8), current: zone.data.data.version_id.slice(0, 8) })}
      {historic.available === false ? (
        <OperationUnavailable compact operationId="getZoneVersion" />
      ) : historic.query.isError ? (
        <ApiErrorView compact error={historic.query.error} onRetry={() => void historic.query.refetch()} />
      ) : old ? (
        <span className="scn-areas">
          {t('scenario.zoneVersion.areas', {
            then: formatNumber(old.area_m2, 0) ?? '—',
            now: formatNumber(zone.data.data.area_m2, 0) ?? '—',
          })}
        </span>
      ) : null}
    </Notice>
  );
}

function FastCalculationCard({ revisionId }: { revisionId: string }) {
  const { user } = useSession();
  const [key, setKey] = useState(newIdempotencyKey);
  const calculation = useMutation({
    mutationFn: () =>
      unwrap<FastCalculationResponse>(
        api.POST('/v1/calculations/fast', {
          params: {
            header: {
              'X-CSRF-Token': user?.csrf_token ?? '',
              'Idempotency-Key': key,
            },
          },
          body: {
            scenario_revision_id: revisionId,
            mode: 'fast',
            include_modules: ['cost', 'survival', 'care'],
            seed: 0,
          },
        }),
      ),
    onSuccess: () => setKey(newIdempotencyKey()),
  });
  const value = calculation.data?.data.snapshot;
  return (
    <div className="scn-calculation">
      <p className="pg-muted">{t('scenario.calc.next')}</p>
      <Button icon="refresh" busy={calculation.isPending} onClick={() => calculation.mutate()}>
        {t('scenario.calc.run')}
      </Button>
      {calculation.isError ? <ApiErrorView compact error={calculation.error} onRetry={() => calculation.mutate()} /> : null}
      {value ? <SnapshotView snapshot={value} /> : null}
    </div>
  );
}

function ProjectJourney({ status, plantCount }: { status: Scenario['status']; plantCount: number }) {
  const reviewed = status === 'in_review' || status === 'approved';
  const steps = [
    { label: 'Участок', note: 'границы и контекст', done: true },
    { label: 'Состав посадок', note: plantCount ? `${plantCount} растений` : 'добавьте растения', done: plantCount > 0 },
    { label: 'Расчёт и эффекты', note: 'стоимость, уход, тени', done: reviewed },
    { label: 'Согласование', note: status === 'in_review' ? 'на рассмотрении' : reviewed ? 'пройдено' : 'после расчёта', done: status === 'approved' },
    { label: 'Исполнение', note: status === 'approved' ? 'можно создать работы' : 'после утверждения', done: false },
  ];
  const current = status === 'approved' ? 4 : status === 'in_review' ? 3 : plantCount ? 2 : 1;
  return (
    <nav className="scn-journey" aria-label="Этапы проекта участка">
      {steps.map((step, index) => (
        <div className={`scn-journey__step${step.done ? ' is-done' : ''}${index === current ? ' is-current' : ''}`} key={step.label}>
          <span className="scn-journey__mark">{step.done ? <Icon name="check" size={15} /> : index + 1}</span>
          <span><strong>{step.label}</strong><small>{step.note}</small></span>
        </div>
      ))}
    </nav>
  );
}

function ProjectOverview({ revision }: { revision: ScenarioRevision }) {
  const plants = revision.placements.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <section className="scn-overview" aria-label="Сводка проекта">
      <article><span className="scn-overview__icon"><Icon name="sprout" size={19} /></span><span><small>Растений</small><strong>{plants}</strong><em>{revision.placements.length} групп посадок</em></span></article>
      <article><span className="scn-overview__icon"><Icon name="map" size={19} /></span><span><small>Площадные посадки</small><strong>{revision.area_patches.length}</strong><em>контуров покрытия</em></span></article>
      <article><span className="scn-overview__icon"><Icon name="calendar" size={19} /></span><span><small>Горизонт ухода</small><strong>{revision.care_horizon_years}</strong><em>лет планирования</em></span></article>
      <article><span className="scn-overview__icon"><Icon name="target" size={19} /></span><span><small>Лимит капитальных затрат</small><strong>{revision.capital_budget ? <MoneyText value={revision.capital_budget} /> : '—'}</strong><em>{revision.capital_budget ? 'не итоговая стоимость' : 'не задан'}</em></span></article>
    </section>
  );
}

function ScenarioBody({ scenarioId, cityId, timeZone }: { scenarioId: string; cityId: string; timeZone: string }) {
  const scenario = useScenario(scenarioId);
  const revisions = useRevisions(scenarioId);
  const [params, setParams] = useSearchParams();
  const viewed = params.get('revision');
  const current = useRevision(scenario.data?.data.current_revision_id ?? null);
  const shown = useRevision(viewed && viewed !== scenario.data?.data.current_revision_id ? viewed : null);
  const calcOk = useOperationAvailable('calculateFast');
  const zoneQ = useZone(scenario.data?.data.zone_id ?? null);
  const transitionOk = useOperationAvailable('transitionScenario');
  const peerScenarios = useQuery({
    queryKey: ['scenario-peers', cityId, scenario.data?.data.zone_id ?? ''],
    enabled: Boolean(scenario.data?.data.zone_id),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/scenarios', { params: { query: { city_id: cityId, limit: 200 } }, signal }))
    ).data.items.filter((item) => item.zone_id === scenario.data!.data.zone_id),
  });

  const setViewed = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('revision', id);
    else next.delete('revision');
    // A calculation is bound to one exact immutable revision. Never carry an old result across
    // revision navigation; FullCalculation will discover the latest snapshot for the new one.
    next.delete(CALC_JOB);
    next.delete(CALC_RESULT);
    setParams(next, { replace: true });
  };

  const revRows = useMemo(() => revisions.data?.items ?? [], [revisions.data]);

  if (scenario.isPending) return <Skeleton lines={6} block />;
  if (scenario.isError) return <ApiErrorView error={scenario.error} onRetry={() => void scenario.refetch()} />;
  const s = scenario.data.data;
  const isOld = Boolean(viewed) && viewed !== s.current_revision_id;
  const calculationRevisionId = isOld ? shown.data?.id ?? null : current.data?.id ?? null;
  const compareRevisions = (peerScenarios.data ?? []).map((item) => item.current_revision_id).slice(0, 3);
  const compareHref = `/compare?city=${encodeURIComponent(cityId)}${compareRevisions.length >= 2 ? `&revisions=${encodeURIComponent(compareRevisions.join(','))}` : ''}`;

  return (
    <>
      <PageHeader
        eyebrow={t('page.projects.eyebrow')}
        title={s.name}
        description={
          <>
            <Badge tone={s.status === 'approved' ? 'positive' : s.status === 'in_review' ? 'info' : 'neutral'}>
              {t(`wf.${s.status}` as AppKey)}
            </Badge>{' '}
            <Link to={`/?city=${cityId}&zone=${s.zone_id}`}>{t('scenario.openZone')}</Link> · {t('col.updated')}:{' '}
            {formatDateTime(s.updated_at, timeZone)}
          </>
        }
        actions={
          <>
            <a className="pg-btn pg-btn--secondary" href="#scenario-recommendation">Подобрать растения</a>
            <Link className="pg-btn pg-btn--primary" to={compareHref}>Сравнить варианты участка</Link>
          </>
        }
      />
      <ProjectJourney status={s.status} plantCount={current.data?.placements.reduce((sum, item) => sum + item.quantity, 0) ?? 0} />
      {current.data ? <ProjectOverview revision={current.data} /> : null}
      <Card title="Результат проекта · стоимость, приживаемость, уход и эффект">
        {calculationRevisionId ? <FullCalculation key={calculationRevisionId} revisionId={calculationRevisionId} timeZone={timeZone} /> : <Skeleton lines={1} />}
      </Card>
      <div className="scn-grid">
        <div className="scn-main">
          {isOld ? (
            <Card title={t('scenario.rev.viewOld')}>
              <Notice tone="info" icon="clock" title={t('scenario.rev.immutable')} actions={<Button size="sm" onClick={() => setViewed(null)}>{t('scenario.rev.toCurrent')}</Button>} />
              {shown.isPending ? <Skeleton lines={5} /> : shown.isError ? <ApiErrorView compact error={shown.error} /> : <RevisionSummary rev={shown.data} timeZone={timeZone} />}
            </Card>
          ) : current.isPending ? (
            <Skeleton lines={6} />
          ) : current.isError ? (
            <ApiErrorView error={current.error} onRetry={() => void current.refetch()} />
          ) : (
            <>
              <Card title={t('scenario.rev.current')}>
                <ZoneVersionNotice zoneId={s.zone_id} revisionZoneVersionId={current.data.zone_version_id} cityId={cityId} />
                <RevisionSummary rev={current.data} timeZone={timeZone} />
              </Card>
              <RevisionEditor
                key={s.id}
                scenario={s}
                etag={scenario.data.etag}
                base={current.data}
                currentZoneVersionId={zoneQ.data?.data.version_id ?? null}
                onSaved={() => setViewed(null)}
              />
            </>
          )}
          <Card title={t('scenario.calc')}>
            {calcOk === null ? (
              <Skeleton lines={1} />
            ) : calcOk === false ? (
              <OperationUnavailable compact operationId="calculateFast" />
            ) : calculationRevisionId ? (
              <FastCalculationCard key={calculationRevisionId} revisionId={calculationRevisionId} />
            ) : (
              <Skeleton lines={1} />
            )}
          </Card>
          <Card title={t('shadow.card')}>
            {calculationRevisionId ? (
              <ShadowSection key={calculationRevisionId} revisionId={calculationRevisionId} cityId={cityId} zoneId={s.zone_id} timeZone={timeZone} />
            ) : (
              <Skeleton lines={1} />
            )}
          </Card>
          <Card title="Тепловой эффект">
            {calculationRevisionId ? (
              <ThermalSection key={calculationRevisionId} revisionId={calculationRevisionId} cityId={cityId} timeZone={timeZone} />
            ) : (
              <Skeleton lines={1} />
            )}
          </Card>
          <Card title={t('scenario.review')}>
            {transitionOk === null ? (
              <Skeleton lines={1} />
            ) : transitionOk === false ? (
              <OperationUnavailable compact operationId="transitionScenario" />
            ) : (
              <ScenarioTransitions scenario={s} etag={scenario.data.etag} />
            )}
          </Card>
        </div>
        <Card title={t('scenario.history')}>
          {revisions.isPending ? (
            <Skeleton lines={4} />
          ) : revisions.isError ? (
            <ApiErrorView compact error={revisions.error} onRetry={() => void revisions.refetch()} />
          ) : revRows.length === 0 ? (
            <StateView compact state="empty" title={t('scenario.history.empty')} />
          ) : (
            <DataTable
              caption={t('scenario.history')}
              columns={[
                {
                  key: 'id',
                  header: t('scenario.rev.column'),
                  render: (r: ScenarioRevision) => (
                    <>
                      <strong>Версия {Math.max(1, revRows.length - revRows.indexOf(r))}</strong>
                      {r.id === s.current_revision_id ? <Badge tone="accent">{t('scenario.rev.currentShort')}</Badge> : null}
                    </>
                  ),
                },
                { key: 'at', header: t('scenario.rev.created'), render: (r: ScenarioRevision) => formatDateTime(r.created_at, timeZone) },
                { key: 'c', header: t('scenario.field.comment'), render: (r: ScenarioRevision) => productComment(r.comment) },
              ]}
              rows={revRows}
              getRowId={(r) => r.id}
              selectedId={viewed ?? s.current_revision_id}
              onSelect={(r) => setViewed(r.id === s.current_revision_id ? null : r.id)}
              maxHeight="24rem"
            />
          )}
        </Card>
      </div>
    </>
  );
}

export function ScenarioPage() {
  const { scenarioId } = useParams();
  if (!scenarioId) return <Navigate to="/projects" replace />;
  return (
    <div className="app-page">
      <CityGate>{(city) => <ScenarioBody key={scenarioId} scenarioId={scenarioId} cityId={city.id} timeZone={city.timezone} />}</CityGate>
    </div>
  );
}
