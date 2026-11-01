/**
 * Design-system catalogue (dev builds only, never routed in production).
 * Data comes from contracts/fixtures (envelope synthetic, expected_valid=true). Variants
 * derived from a fixture keep status "synthetic" and say which fixture they come from.
 */
import { useState, type ReactNode } from 'react';
import { ApiError, type CostResult, type Job, type Metric, type Plant, type ProblemDetails, type Rate, type SourceReadinessPage, type StockItem, type StockItemPage, type SurvivalResult } from '@pg/api-client';
import {
  Badge,
  Button,
  Card,
  CostBreakdown,
  CostSummary,
  HeightBasisBadge,
  HeightBasisLegend,
  PeriodText,
  PlantReviewDetails,
  PlantSafetyFlags,
  SourceReadinessList,
  ReadinessBadge,
  readinessMeaning,
  StockOfferRow,
  TraitTable,
  type ReadinessState,
  DataTable,
  Dialog,
  Field,
  Input,
  JobStatus,
  Legend,
  MetricValue,
  Notice,
  PageHeader,
  ProvenanceBadge,
  SaveStatus,
  Select,
  Skeleton,
  StateView,
  SurvivalStrip,
  SyntheticBanner,
  type SaveState,
  type ViewState,
} from '@pg/ui';
import metricMissing from '@contracts/fixtures/metric_missing.json';
import costMissingRate from '@contracts/fixtures/cost_missing_rate.json';
import problemConflict from '@contracts/fixtures/problem_revision_conflict.json';
import jobQueued from '@contracts/fixtures/job_queued.json';
import survivalSynthetic from '@contracts/fixtures/survival_synthetic.json';
import { ApiErrorView } from '../shell/ApiErrorView';
import plantGenus from '@contracts/fixtures/plant_genus_requires_review.json';
import plantRisk from '@contracts/fixtures/plant_research_risk_excluded.json';
import stockUnknownVsZero from '@contracts/fixtures/stock_unknown_vs_zero.json';
import stockExternal from '@contracts/fixtures/stock_listing_only_external.json';
import costWater from '@contracts/fixtures/cost_incomplete_with_water.json';
import readinessMixed from '@contracts/fixtures/source_readiness_mixed.json';
import rateFuture from '@contracts/fixtures/rate_future_period_unverified.json';

interface Envelope<T> {
  fixture_only: true;
  schema: string;
  expected_valid: boolean;
  data: T;
}

function fixture<T>(f: unknown): T {
  const e = f as Envelope<T>;
  if (!e.fixture_only || !e.expected_valid) throw new Error(`Fixture ${e.schema} is not a valid positive example`);
  return e.data;
}

const METRIC_NA = fixture<Metric>(metricMissing);
const COST = fixture<CostResult>(costMissingRate);
const CONFLICT = fixture<ProblemDetails>(problemConflict);
const JOB = fixture<Job>(jobQueued);
const SURVIVAL = fixture<SurvivalResult>(survivalSynthetic);
const PLANT_GENUS = fixture<Plant>(plantGenus);
const PLANT_RISK = fixture<Plant>(plantRisk);
const STOCK_PAGE = fixture<StockItemPage>(stockUnknownVsZero);
const STOCK_EXTERNAL = fixture<StockItem>(stockExternal);
const COST_WATER = fixture<CostResult>(costWater);
const READINESS = fixture<SourceReadinessPage>(readinessMixed);
const RATE_FUTURE = fixture<Rate>(rateFuture);

// Derived variants: same fixture identity, explicitly synthetic.
const METRIC_SYNTH: Metric = {
  ...METRIC_NA,
  status: 'synthetic',
  value: 0.4,
  missing_reason: null,
  qualitative_confidence: 'low',
};
const JOB_RUNNING: Job = { ...JOB, state: 'running', phase: 'cost', started_at: '2026-10-29T08:00:05Z' };
const JOB_FAILED: Job = {
  ...JOB,
  state: 'failed',
  phase: 'cost',
  attempt: 2,
  completed_at: '2026-10-29T08:01:00Z',
  error: { ...CONFLICT, status: 422, code: 'RATE_MISSING', title: 'Нет ставки', detail: 'Цена не предоставлена', current_revision_id: null },
};
const COST_COMPLETE: CostResult = {
  ...COST,
  status: 'complete',
  known_subtotal: '1250000.00',
  total: '1250000.00',
  data_gaps: [],
};

const ALL_STATES: ViewState[] = [
  'loading',
  'empty',
  'partial',
  'unavailable',
  'error',
  'stale',
  'forbidden',
  'conflict',
  'unauthenticated',
  'timeout',
  'network',
  'not_found',
];

const SAVE_STATES: SaveState[] = ['idle', 'editing', 'saving', 'saved', 'failed', 'conflict'];

const TOKENS = [
  ['--pg-accent', 'accent'],
  ['--pg-positive', 'positive'],
  ['--pg-negative', 'negative'],
  ['--pg-warning', 'warning'],
  ['--pg-info', 'info'],
  ['--pg-neutral', 'neutral'],
  ['--pg-prov-measured', 'measured'],
  ['--pg-prov-estimated', 'estimated'],
  ['--pg-prov-synthetic', 'synthetic'],
  ['--pg-prov-unavailable', 'unavailable'],
] as const;

const SEQ = ['--pg-seq-1', '--pg-seq-2', '--pg-seq-3', '--pg-seq-4', '--pg-seq-5'];
const DIV = ['--pg-div-neg-2', '--pg-div-neg-1', '--pg-div-0', '--pg-div-pos-1', '--pg-div-pos-2'];
const CAT = Array.from({ length: 8 }, (_, i) => `--pg-cat-${i + 1}`);

interface DemoRow {
  id: string;
  label: string;
  group: string;
}
const ROWS: DemoRow[] = Array.from({ length: 400 }, (_, i) => ({
  id: `row-${String(i + 1).padStart(3, '0')}`,
  label: `Синтетическая строка ${i + 1}`,
  group: ['A', 'B', 'C'][i % 3]!,
}));

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="gal-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

export default function UiGallery() {
  const [log, setLog] = useState<string[]>([]);
  const note = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString('ru-RU')} — ${s}`, ...l].slice(0, 6));
  const [selected, setSelected] = useState<string | null>('row-003');
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');

  return (
    <div className="app-page gal">
      <SyntheticBanner />
      <PageHeader
        title="Дизайн-система и состояния интерфейса"
        description="Каталог компонентов WP-02. Данные — только contracts/fixtures (synthetic); производные варианты помечены. Маршрут доступен лишь в dev-сборке."
      />
      <div className="gal-log" role="log" aria-live="polite" aria-label="Журнал действий каталога">
        {log.length === 0 ? <span className="pg-muted">Нажмите любую кнопку — действие отобразится здесь.</span> : log.map((l) => <div key={l}>{l}</div>)}
      </div>

      <nav className="gal-toc" aria-label="Разделы каталога">
        {[
          ['g-tokens', 'Токены'],
          ['g-controls', 'Controls'],
          ['g-prov', 'Происхождение'],
          ['g-states', 'Состояния'],
          ['g-errors', 'Ошибки API'],
          ['g-data', 'Метрики и смета'],
          ['g-progress', 'Сохранение и задания'],
          ['g-legend', 'Легенды'],
          ['g-table', 'Таблица'],
          ['g-ready', 'Готовность данных'],
          ['g-catalog', 'Каталог и партии'],
          ['g-cost', 'Смета по статьям'],
          ['g-height', 'Высоты 3D'],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>

      <Section id="g-tokens" title="Токены">
        <div className="gal-swatches">
          {TOKENS.map(([v, label]) => (
            <div key={v} className="gal-swatch">
              <span style={{ background: `var(${v})` }} />
              <code className="pg-code">{v}</code>
              <small>{label}</small>
            </div>
          ))}
        </div>
        <div className="gal-scales">
          {[
            ['Последовательная шкала (потребность)', SEQ],
            ['Расходящаяся (изменение)', DIV],
            ['Категориальная (типы)', CAT],
          ].map(([label, vars]) => (
            <div key={label as string}>
              <p className="pg-muted">{label as string}</p>
              <div className="gal-ramp">
                {(vars as string[]).map((v) => (
                  <span key={v} style={{ background: `var(${v})` }} title={v} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <p>
          Типографика: <strong>заголовок</strong>, обычный текст, <span className="pg-muted">вторичный</span>,{' '}
          <code className="pg-code">machine_key</code>. Табличные цифры: 1 234 567,50 ₸.
        </p>
      </Section>

      <Section id="g-controls" title="Controls">
        <div className="gal-row">
          <Button variant="primary" icon="plus" onClick={() => note('primary')}>
            Основное действие
          </Button>
          <Button onClick={() => note('secondary')}>Второстепенное</Button>
          <Button variant="ghost" onClick={() => note('ghost')}>
            Ghost
          </Button>
          <Button variant="danger" icon="x" onClick={() => note('danger')}>
            Опасное
          </Button>
          <Button disabled title="Недоступно: нет прав specialist">
            Недоступно
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => {
              setBusy(true);
              note('busy start (2 с)');
              window.setTimeout(() => setBusy(false), 2000);
            }}
          >
            Сохранить
          </Button>
          <Button iconOnly icon="refresh" aria-label="Обновить" onClick={() => note('icon button')} />
          <Button onClick={() => setDialog(true)}>Открыть диалог</Button>
        </div>
        <div className="gal-grid">
          <Field label="Название сценария" hint="Отображается в отчётах и сравнении" required>
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Капитальный бюджет, ₸" error="Отрицательная сумма недопустима">
            {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} defaultValue="-100.00" inputMode="decimal" />}
          </Field>
          <Field label="Стратегия ухода">
            {({ id }) => (
              <Select id={id} defaultValue="standard">
                <option value="standard">стандартная</option>
                <option value="water_saving">экономия воды</option>
                <option value="intensive">интенсивная</option>
              </Select>
            )}
          </Field>
        </div>
        <div className="gal-row">
          <Badge tone="positive" icon="checkCircle">
            утверждено
          </Badge>
          <Badge tone="warning" icon="alert">
            требует проверки
          </Badge>
          <Badge tone="negative" icon="error">
            исключено
          </Badge>
          <Badge tone="info">на проверке</Badge>
          <Badge tone="neutral" icon="lock">
            ограниченный
          </Badge>
        </div>
        <Dialog
          open={dialog}
          title="Перейти в статус «на проверке»"
          onClose={() => {
            setDialog(false);
            note('dialog closed');
          }}
          footer={
            <>
              <Button onClick={() => setDialog(false)}>Отмена</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setDialog(false);
                  note('dialog confirmed');
                }}
              >
                Подтвердить
              </Button>
            </>
          }
        >
          <p>Переход статуса требует причины и проверяется сервером (F-SCEN-01).</p>
          <Field label="Причина" required>
            {({ id }) => <Input id={id} />}
          </Field>
        </Dialog>
      </Section>

      <Section id="g-prov" title="Происхождение данных">
        <p className="pg-muted">Значок, слово и узор — статус не передаётся одним цветом.</p>
        <div className="gal-row">
          <ProvenanceBadge status="measured" />
          <ProvenanceBadge status="estimated" />
          <ProvenanceBadge status="synthetic" />
          <ProvenanceBadge status="unavailable" />
        </div>
        <Notice tone="synthetic" title="Синтетический профиль">
          Результаты на синтетических входах не проходят data gates и сохраняют метку в экспорте.
        </Notice>
      </Section>

      <Section id="g-states" title="Состояния">
        <div className="gal-states">
          {ALL_STATES.map((s) => (
            <Card key={s} title={s}>
              {s === 'loading' ? (
                <>
                  <StateView compact state="loading" timeoutSeconds={15} />
                  <Skeleton lines={2} />
                </>
              ) : (
                <StateView
                  compact
                  state={s}
                  description={`Пример состояния «${s}»`}
                  actions={
                    <Button size="sm" icon="refresh" onClick={() => note(`state ${s}: action`)}>
                      Действие
                    </Button>
                  }
                />
              )}
            </Card>
          ))}
        </div>
      </Section>

      <Section id="g-errors" title="Ошибки API → состояние">
        <p className="pg-muted">412 — из fixture problem_revision_conflict; остальные — категории транспорта без тела ответа.</p>
        <div className="gal-states">
          <Card title="412 revision conflict (fixture)">
            <ApiErrorView compact error={new ApiError('revision_conflict', 412, CONFLICT)} onRetry={() => note('412 reload current')} />
          </Card>
          <Card title="401">
            <ApiErrorView compact error={new ApiError('unauthenticated', 401, null)} />
          </Card>
          <Card title="403">
            <ApiErrorView compact error={new ApiError('forbidden', 403, null)} />
          </Card>
          <Card title="503 / прокси без API">
            <ApiErrorView compact error={new ApiError('unavailable', 502, null)} onRetry={() => note('503 retry')} />
          </Card>
          <Card title="timeout">
            <ApiErrorView compact error={new ApiError('timeout', null, null)} onRetry={() => note('timeout retry')} />
          </Card>
        </div>
        <Notice
          tone="warning"
          icon="conflict"
          title="Сценарий изменён в другой вкладке"
          actions={
            <>
              <Button size="sm" variant="primary" onClick={() => note('conflict: compare')}>
                Сравнить с текущей ревизией
              </Button>
              <Button size="sm" onClick={() => note('conflict: keep local')}>
                Сохранить мои правки как новую ветку
              </Button>
            </>
          }
        >
          Ваши несохранённые правки не потеряны. Сервер вернул current_revision_id{' '}
          <code className="pg-code">{CONFLICT.current_revision_id?.slice(-4)}</code>; без сравнения повтор запроса не выполняется.
        </Notice>
      </Section>

      <Section id="g-data" title="Метрики, смета, приживаемость">
        <div className="gal-grid">
          <MetricValue label="Снижение температуры воздуха (fixture metric_missing)" metric={METRIC_NA} />
          <MetricValue label="Тот же показатель, synthetic-вариант" metric={METRIC_SYNTH} />
        </div>
        <div className="gal-grid">
          <Card title="Смета — fixture cost_missing_rate">
            <CostSummary cost={COST} />
          </Card>
          <Card title="Смета — производный complete-вариант (synthetic)">
            <CostSummary cost={COST_COMPLETE} />
          </Card>
          <Card title="Приживаемость — fixture survival_synthetic">
            <SurvivalStrip result={SURVIVAL} synthetic />
          </Card>
        </div>
        <Notice tone="info" title="Stale-результат">
          Расчёт выполнен по предыдущей версии набора данных. Старые цифры доступны для сравнения; пересчёт запускается явно.
        </Notice>
      </Section>

      <Section id="g-progress" title="Сохранение и фоновые задания">
        <div className="gal-row">
          {SAVE_STATES.map((s) => (
            <SaveStatus key={s} state={s} revisionLabel="…0005" onRetry={() => note('save retry')} />
          ))}
        </div>
        <div className="gal-grid">
          <JobStatus job={JOB} onCancel={() => note('job cancel (queued)')} />
          <JobStatus job={JOB_RUNNING} onCancel={() => note('job cancel (running)')} />
          <JobStatus job={JOB_FAILED} />
        </div>
      </Section>

      <Section id="g-legend" title="Легенды">
        <div className="gal-grid">
          <Card>
            <Legend
              title="Пример категориальной шкалы"
              classes={[
                { key: 'a', label: 'Класс A', swatch: 'var(--pg-cat-1)' },
                { key: 'b', label: 'Класс B', swatch: 'var(--pg-cat-2)' },
                { key: 'c', label: 'Класс C (оценка)', swatch: 'var(--pg-cat-3)', pattern: 'hatched' },
              ]}
              unit={null}
              period={{ from: '2026-06-01', to: '2026-08-31' }}
              source={<ProvenanceBadge status="synthetic" />}
            />
          </Card>
          <Card>
            <Legend
              title="Последовательная шкала"
              classes={SEQ.map((v, i) => ({ key: v, label: `ступень ${i + 1}`, swatch: `var(${v})` }))}
              unit="m2_per_person"
              period={null}
              source={<ProvenanceBadge status="synthetic" />}
              stale
            />
          </Card>
          <Card>
            <Legend title="Слой без легенды от сервера" classes={null} unit={null} period={null} source="OSM contributors (ODbL)" />
          </Card>
        </div>
      </Section>

      <Section id="g-ready" title="Готовность источников — fixture source_readiness_mixed">
        <p className="pg-muted">Шесть состояний источника и их смысл; ниже — ответ формата GET /v1/source-readiness из канонической fixture.</p>
        <div className="gal-states">
          {(['not_provided', 'provided_empty', 'available', 'load_failed', 'stale', 'research_unverified'] as ReadinessState[]).map((st) => (
            <Card key={st}>
              <ReadinessBadge state={st} />
              <p className="pg-muted">{readinessMeaning(st)}</p>
            </Card>
          ))}
        </div>
        <SourceReadinessList items={READINESS.items} today="2026-10-29" />
        <p>
          Период ставки — fixture rate_future_period_unverified:{' '}
          <PeriodText from={RATE_FUTURE.valid_from} to={RATE_FUTURE.valid_to} today="2026-10-29" /> · статус{' '}
          <code className="pg-code">{RATE_FUTURE.applicability_status}</code>
        </p>
      </Section>

      <Section id="g-catalog" title="Каталог: таксон отдельно от партии поставщика — канонические fixtures">
        <div className="gal-grid">
          <Card title={`${PLANT_GENUS.russian_name} — plant_genus_requires_review`}>
            <PlantSafetyFlags plant={PLANT_GENUS} />
            <PlantReviewDetails plant={PLANT_GENUS} />
            <TraitTable traits={PLANT_GENUS.traits} />
          </Card>
          <Card title={`${PLANT_RISK.russian_name} — plant_research_risk_excluded`}>
            <PlantSafetyFlags plant={PLANT_RISK} />
            <PlantReviewDetails plant={PLANT_RISK} />
          </Card>
          <div className="gal-col">
            {STOCK_PAGE.items.map((s) => (
              <StockOfferRow key={s.id} item={s} />
            ))}
            <StockOfferRow item={STOCK_EXTERNAL} />
          </div>
        </div>
      </Section>

      <Section id="g-cost" title="Смета по статьям — fixtures cost_incomplete_with_water и cost_missing_rate">
        <CostSummary cost={COST_WATER} />
        <CostBreakdown cost={COST_WATER} />
        <CostBreakdown cost={COST} />
      </Section>

      <Section id="g-height" title="Происхождение высот в 3D">
        <div className="gal-grid">
          <Card title="Легенда основания высоты">
            <HeightBasisLegend />
          </Card>
          <Card title="Значки в карточке здания">
            <div className="gal-row">
              <HeightBasisBadge basis="measured" />
              <HeightBasisBadge basis="recorded_unverified" />
              <HeightBasisBadge basis="floors_estimate" />
              <HeightBasisBadge basis="visual_placeholder" />
              <HeightBasisBadge basis="unknown" />
            </div>
          </Card>
        </div>
      </Section>

      <Section id="g-table" title="Таблица: собственный scroll, клавиатура, windowing">
        <p className="pg-muted">400 синтетических строк; ↑/↓, Home/End, PageUp/PageDown, Enter — выбор.</p>
        <DataTable
          caption="Синтетическая демонстрационная таблица"
          columns={[
            { key: 'id', header: 'ID', render: (r: DemoRow) => <code className="pg-code">{r.id}</code>, width: '8rem' },
            { key: 'label', header: 'Название', render: (r: DemoRow) => r.label },
            { key: 'group', header: 'Группа', render: (r: DemoRow) => r.group },
            { key: 'prov', header: 'Происхождение', render: () => <ProvenanceBadge status="synthetic" /> },
          ]}
          rows={ROWS}
          getRowId={(r) => r.id}
          selectedId={selected}
          onSelect={(r) => {
            setSelected(r.id);
            note(`row ${r.id}`);
          }}
          maxHeight="320px"
          footer={<span>Выбрано: {selected ?? '—'}</span>}
        />
      </Section>
    </div>
  );
}
