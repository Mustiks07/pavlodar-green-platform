import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  newIdempotencyKey,
  unwrap,
  type PriorityNormalization,
  type PriorityResult,
  type Program,
  type ProgramCreate,
  type Scenario,
  type Zone,
} from '@pg/api-client';
import { Badge, Button, Dialog, Field, Input, Select, Skeleton } from '@pg/ui';
import { api } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { useSession } from '../../shell/session';
import { PriorityDashboard } from './PriorityDashboard';

const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));
const integerOrNull = (value: string) => (value.trim() === '' ? null : Number.parseInt(value, 10));
const equalWeights = (factors: PriorityNormalization['factors']) => Object.fromEntries(
  factors.map((factor) => [factor.factor, String(Math.round(100 / factors.length))]),
);

/**
 * Creates the immutable priority result first, then freezes the same weights and candidates in a
 * Program. The browser never ranks zones or chooses scenarios itself: it only collects inputs and
 * renders the server result.
 */
export function ProgramCreateDialog({ cityId, open, onClose, onCreated }: { cityId: string; open: boolean; onClose: () => void; onCreated: (program: Program) => void }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const [name, setName] = useState('Городская программа озеленения');
  const [budget, setBudget] = useState('');
  const [water, setWater] = useState('');
  const [crew, setCrew] = useState('');
  const [visits, setVisits] = useState('');
  const [careBudget, setCareBudget] = useState('');
  const [normalizationId, setNormalizationId] = useState('');
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [priority, setPriority] = useState<PriorityResult | null>(null);

  const scenarios = useQuery({
    queryKey: ['program-candidate-scenarios', cityId],
    enabled: open,
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/scenarios', { params: { query: { city_id: cityId, limit: 200 } }, signal }))).data.items as Scenario[],
  });
  const zones = useQuery({
    queryKey: ['program-candidate-zones', cityId],
    enabled: open,
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/zones', { params: { query: { city_id: cityId, limit: 200 } }, signal }))).data.items as Zone[],
  });
  const normalizations = useQuery({
    queryKey: ['priority-normalizations'],
    enabled: open,
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/priority-normalizations', { signal }))).data.items as PriorityNormalization[],
  });
  const normalization = normalizations.data?.find((item) => item.id === normalizationId) ?? null;
  const zoneNames = useMemo(() => new Map((zones.data ?? []).map((zone) => [zone.id, zone.name])), [zones.data]);
  const selectedScenarios = (scenarios.data ?? []).filter((scenario) => candidateIds.includes(scenario.current_revision_id));
  const selectedZoneIds = [...new Set(selectedScenarios.map((scenario) => scenario.zone_id))];
  const benefitWeights = (normalization?.factors ?? []).map((factor) => ({ factor: factor.factor, weight: Number(weights[factor.factor] ?? 0) }));
  const weightTotal = benefitWeights.reduce((total, item) => total + (Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 0), 0);
  const weightsValid = benefitWeights.length > 0 && benefitWeights.some((item) => Number.isFinite(item.weight) && item.weight > 0) && benefitWeights.every((item) => Number.isFinite(item.weight) && item.weight >= 0);

  useEffect(() => {
    const first = normalizations.data?.[0];
    if (!first || normalizationId) return;
    setNormalizationId(first.id);
    setWeights(equalWeights(first.factors));
  }, [normalizations.data, normalizationId]);

  const resetPriority = () => {
    setPriority(null);
  };
  const calculate = useMutation({
    mutationFn: async () =>
      (
        await unwrap<PriorityResult>(
          api.POST('/v1/priorities', {
            params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { city_id: cityId, zone_ids: selectedZoneIds, weights: benefitWeights, normalization_version_id: normalizationId },
          }),
        )
      ).data,
    onSuccess: setPriority,
  });
  const create = useMutation({
    mutationFn: async () => {
      const body: ProgramCreate = {
        city_id: cityId,
        name: name.trim(),
        capital_budget: budget.trim(),
        resource_limits: [
          {
            period: 'year:1',
            water_m3: numberOrNull(water),
            crew_minutes: integerOrNull(crew),
            max_visits: integerOrNull(visits),
            care_budget: careBudget.trim() || null,
          },
        ],
        candidate_revision_ids: candidateIds,
        required_zone_ids: [],
        excluded_zone_ids: [],
        benefit_weights: benefitWeights,
        diversity_caps: [],
        coverage_requirements: [],
        priority_result_id: priority!.id,
      };
      return (
        await unwrap<Program>(
          api.POST('/v1/programs', {
            params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body,
          }),
        )
      ).data;
    },
    onSuccess: (program) => {
      void qc.invalidateQueries({ queryKey: ['list', 'programs'] });
      onCreated(program);
      onClose();
    },
  });

  const changeNormalization = (id: string) => {
    const next = normalizations.data?.find((item) => item.id === id);
    setNormalizationId(id);
    setWeights(equalWeights(next?.factors ?? []));
    resetPriority();
  };
  const toggleCandidate = (revisionId: string) => {
    setCandidateIds((current) => (current.includes(revisionId) ? current.filter((id) => id !== revisionId) : [...current, revisionId]));
    resetPriority();
  };
  const loading = scenarios.isPending || zones.isPending || normalizations.isPending;
  const sourceError = scenarios.error ?? zones.error ?? normalizations.error;
  const canCalculate = name.trim().length > 0 && budget.trim().length > 0 && selectedZoneIds.length > 0 && weightsValid && Boolean(normalizationId);

  return (
    <Dialog
      open={open}
      title={t('program.create.title')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" busy={create.isPending} disabled={!priority || !canCalculate} onClick={() => create.mutate()}>
            {t('program.create.submit')}
          </Button>
        </>
      }
    >
      <p className="pg-muted">{t('program.create.desc')}</p>
      {loading ? <Skeleton lines={6} /> : null}
      {sourceError ? <ApiErrorView compact error={sourceError} /> : null}
      {!loading && !sourceError ? (
        <div className="scn-form">
          <Field label={t('program.field.name')} required>
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={name} onChange={(event) => setName(event.target.value)} />}
          </Field>
          <Field label={t('program.field.budget')} required hint={t('program.field.moneyHint')}>
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="15000000.00" />}
          </Field>
          <div className="program-resource-grid">
            <Field label={t('program.field.water')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={water} onChange={(event) => setWater(event.target.value)} />}
            </Field>
            <Field label={t('program.field.crew')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="numeric" value={crew} onChange={(event) => setCrew(event.target.value)} />}
            </Field>
            <Field label={t('program.field.visits')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="numeric" value={visits} onChange={(event) => setVisits(event.target.value)} />}
            </Field>
            <Field label={t('program.field.careBudget')} hint={t('program.field.moneyHint')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={careBudget} onChange={(event) => setCareBudget(event.target.value)} />}
            </Field>
          </div>
          <Field label={t('program.field.normalization')} required>
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} value={normalizationId} onChange={(event) => changeNormalization(event.target.value)}>
                {(normalizations.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.method_version}</option>)}
              </Select>
            )}
          </Field>
          {normalization ? (
            <fieldset className="priority-weight-panel">
              <legend>{t('program.field.weights')}</legend>
              <div className="priority-weight-panel__head">
                <strong>Настройте, что важнее для города</strong>
                <span>Сумма автоматически нормализуется до 100%</span>
              </div>
              {normalization.factors.map((factor) => {
                const raw = Number(weights[factor.factor] ?? 0);
                const percent = weightTotal > 0 ? Math.round(raw / weightTotal * 100) : 0;
                return (
                  <label className="priority-weight" key={factor.factor}>
                    <span className="priority-weight__head">
                      <span>
                        <strong>{factor.label}</strong>
                        <small>{factor.group === 'need' ? 'Потребность территории' : 'Готовность к реализации'}</small>
                      </span>
                      <span className="priority-weight__percent">{percent}%</span>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={Number.isFinite(raw) ? raw : 0}
                      aria-label={`Вес: ${factor.label}`}
                      onChange={(event) => {
                        setWeights((current) => ({ ...current, [factor.factor]: event.target.value }));
                        resetPriority();
                      }}
                    />
                  </label>
                );
              })}
            </fieldset>
          ) : null}
          <fieldset className="program-candidate-list">
            <legend>{t('program.field.candidates')}</legend>
            {(scenarios.data ?? []).filter((scenario) => scenario.status !== 'archived').map((scenario) => (
              <label key={scenario.id} className="scn-check">
                <input type="checkbox" checked={candidateIds.includes(scenario.current_revision_id)} onChange={() => toggleCandidate(scenario.current_revision_id)} />
                <span><strong>{scenario.name}</strong><small>{zoneNames.get(scenario.zone_id) ?? scenario.zone_id.slice(0, 8)} · {t(`wf.${scenario.status}` as AppKey)}</small></span>
              </label>
            ))}
          </fieldset>
          <div className="scn-actions">
            <Button variant="secondary" busy={calculate.isPending} disabled={!canCalculate} onClick={() => calculate.mutate()}>
              {priority ? t('program.priority.recalculate') : t('program.priority.calculate')}
            </Button>
            {priority ? <Badge tone="positive">{t('program.priority.ready')}</Badge> : <span className="pg-muted">{t('program.priority.required')}</span>}
          </div>
          {calculate.isError ? <ApiErrorView compact error={calculate.error} /> : null}
          {create.isError ? <ApiErrorView compact error={create.error} /> : null}
          {priority ? (
            <PriorityDashboard
              result={priority}
              zoneNames={zoneNames}
              cityId={cityId}
              factorLabels={new Map(normalization?.factors.map((factor) => [factor.factor, factor.label]))}
            />
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
