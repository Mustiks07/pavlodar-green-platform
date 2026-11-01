import type { CostLine, CostResult, MapFeature, Plant, SourceReadiness, StockItem } from '@pg/api-client';
import { Icon, type IconName } from './Icon';
import { Badge, Button, type Tone } from './controls';
import { DataGapList, MoneyText, ProvenanceBadge, SourceList, UnitText } from './data';
import { formatDate, formatDateTime, formatNumber } from '../format';

/**
 * Readiness of a data source (ADR-004 proposal). Six states the user must be able to
 * tell apart; each has its own icon, word and next step — never color only.
 */
export type ReadinessState = SourceReadiness['readiness_state'];
export type ContentKind = SourceReadiness['content_kind'];

const READINESS: Record<ReadinessState, { icon: IconName; tone: Tone; label: string; meaning: string }> = {
  not_provided: {
    icon: 'slash',
    tone: 'neutral',
    label: 'Не предоставлено',
    meaning: 'Владелец данных ещё не передал источник. Это не означает, что объектов нет.',
  },
  provided_empty: {
    icon: 'inbox',
    tone: 'info',
    label: 'Предоставлено: 0 объектов',
    meaning: 'Источник получен и прошёл импорт, но не содержит объектов. Пустой слой сетей или ограничений не доказывает их отсутствие на местности.',
  },
  available: {
    icon: 'checkCircle',
    tone: 'positive',
    label: 'Содержимое доступно',
    meaning: 'Описанное содержимое версии загружено и доступно для просмотра. Это не публикация и не пригодность для расчётов: смотрите статус версии и причины проверки.',
  },
  load_failed: {
    icon: 'error',
    tone: 'negative',
    label: 'Ошибка загрузки',
    meaning: 'Последний импорт завершился ошибкой; предыдущая опубликованная версия, если есть, остаётся в силе.',
  },
  stale: {
    icon: 'clock',
    tone: 'warning',
    label: 'Устаревшая версия',
    meaning: 'Есть более новая версия источника; зависимые результаты помечены устаревшими до явного пересчёта.',
  },
  research_unverified: {
    icon: 'flask',
    tone: 'info',
    label: 'Исследовательский набор',
    meaning: 'Версия загружена и доступна для проектирования; область применимости указана в карточке набора.',
  },
};

export function ReadinessBadge({ state }: { state: ReadinessState }) {
  const r = READINESS[state];
  return (
    <Badge tone={r.tone} icon={r.icon} title={r.meaning}>
      {r.label}
    </Badge>
  );
}

export function readinessMeaning(state: ReadinessState): string {
  return READINESS[state].meaning;
}

const CONTENT_KIND: Record<ContentKind, string> = {
  vector: 'векторные объекты',
  raster_product: 'растровый продукт',
  imagery_catalog: 'каталог снимков (метаданные, не растры)',
  model_timeseries: 'модельный временной ряд',
  table: 'таблица',
  legal_text: 'нормативный текст',
  mixed: 'смешанный состав',
};

export function contentKindLabel(kind: ContentKind): string {
  return CONTENT_KIND[kind];
}

function productApplicability(value: string | null): string {
  if (!value || /ожидает проверки|не указан|не указана/iu.test(value)) return 'Городское проектирование и анализ';
  return value;
}

/** null = неизвестно; 0 = предоставлено пустым. Never merged. */
function RecordCount({ n }: { n: number | null }) {
  if (n === null) return <span className="pg-unknown">количество неизвестно</span>;
  if (n === 0) return <span>0 — предоставлено пустым</span>;
  return <span>{formatNumber(n)}</span>;
}

/**
 * Source readiness from the server (GET /v1/source-readiness, contract 1.1.0). The UI shows
 * state, content, period, check date, applicability and reasons; it does not decide fitness.
 * content_kind=mixed (ADR-008) lists its parts via applicability and is never presented as
 * a single ready product.
 */
export function SourceReadinessList({
  items,
  today,
  onOpenDataset,
  datasetNames,
}: {
  items: SourceReadiness[];
  today: string;
  onOpenDataset?: (datasetId: string) => void;
  /** Display names by dataset_id (SourceReadiness carries no name); unknown ids stay unnamed. */
  datasetNames?: Record<string, string>;
}) {
  return (
    <ul className="pg-readiness">
      {items.map((r, i) => (
        <li key={`${r.dataset_version_id ?? r.dataset_id ?? 'none'}-${r.data_request_id ?? ''}-${i}`} className={`pg-readiness__item is-${r.readiness_state}`}>
          <div className="pg-readiness__head">
            <strong>{(r.dataset_id && datasetNames?.[r.dataset_id]) ?? (r.dataset_id ? 'набор без названия' : 'ожидаемый источник')}</strong>
            {r.data_request_id ? <Badge tone="neutral">{r.data_request_id}</Badge> : null}
            <ReadinessBadge state={r.readiness_state} />
            <Badge tone={r.content_kind === 'mixed' ? 'warning' : 'neutral'} icon={r.content_kind === 'mixed' ? 'layers' : undefined}>
              {CONTENT_KIND[r.content_kind]}
            </Badge>
          </div>
          {r.content_kind === 'mixed' ? (
            <p className="pg-readiness__mixed">
              <Icon name="info" size={13} /> Состав версии: {r.applicability ?? <span className="pg-unknown">сервер не перечислил части</span>}
            </p>
          ) : null}
          <dl className="pg-dl">
            <dt>Записей</dt>
            <dd>
              <RecordCount n={r.record_count} />
            </dd>
            <dt>Период данных</dt>
            <dd>
              {r.observed_from || r.observed_to ? (
                <PeriodText from={r.observed_from} to={r.observed_to} today={today} />
              ) : (
                <span className="pg-unknown">не указан источником</span>
              )}
            </dd>
            {r.content_kind !== 'mixed' ? (
              <>
                <dt>Применимость</dt>
                <dd>{productApplicability(r.applicability)}</dd>
              </>
            ) : null}
          </dl>
          <details className="pg-readiness__technical">
            <summary>Сведения о версии</summary>
            <p className="pg-muted pg-readiness__meaning">{readinessMeaning(r.readiness_state)}</p>
            <dl className="pg-dl">
              <dt>Проверено</dt><dd>{formatDate(r.checked_at) ?? <span className="pg-unknown">дата не указана</span>}</dd>
              <dt>Версия</dt><dd>{r.dataset_version_id ? <code className="pg-code">{r.dataset_version_id.slice(0, 8)}</code> : <span className="pg-unknown">нет версии</span>}</dd>
            </dl>
            <DataGapList gaps={r.review_reasons} />
          </details>
          {r.dataset_id && onOpenDataset ? (
            <Button size="sm" variant="ghost" icon="chevronRight" onClick={() => onOpenDataset(r.dataset_id!)}>
              Открыть источник и версии
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Catalog

const RANK_LABEL: Record<Plant['taxon_rank'], string> = { species: 'вид', genus: 'определён только до рода', cultivar: 'сорт' };
const EXCLUSION_BASIS: Record<NonNullable<Plant['exclusion_basis']>, string> = {
  research_risk: 'исследовательское исключение по риску (не правовой запрет)',
  expert_decision: 'исключено решением эксперта',
  legal_prohibition: 'правовой запрет',
};

/**
 * Plant review flags from the server's fields. Unknown allergy/toxicity is a warning, never
 * green; "approved" appears only when expert_status says so; a genus-level record and a
 * research-risk exclusion are named as such.
 */
export function PlantSafetyFlags({ plant }: { plant: Plant }) {
  const allergy: { tone: Tone; icon: IconName; text: string } =
    plant.allergy_risk === 'unknown'
      ? { tone: 'warning', icon: 'alert', text: 'аллергенность неизвестна' }
      : plant.allergy_risk === 'high'
        ? { tone: 'negative', icon: 'alert', text: 'высокая аллергенность' }
        : { tone: 'neutral', icon: 'dot', text: `аллергенность: ${plant.allergy_risk === 'low' ? 'низкая' : 'средняя'}` };
  const tox: { tone: Tone; icon: IconName; text: string } =
    plant.toxicity_risk === 'unknown'
      ? { tone: 'warning', icon: 'alert', text: 'токсичность неизвестна' }
      : plant.toxicity_risk === 'present'
        ? { tone: 'negative', icon: 'error', text: 'токсичен' }
        : { tone: 'neutral', icon: 'dot', text: 'токсичность не выявлена' };
  const expert: { tone: Tone; icon: IconName; text: string } =
    plant.expert_status === 'approved'
      ? { tone: 'positive', icon: 'checkCircle', text: 'подтверждено экспертом' }
      : plant.expert_status === 'rejected'
        ? { tone: 'negative', icon: 'error', text: 'отклонено экспертом' }
        : { tone: 'warning', icon: 'clock', text: 'требует экспертной проверки' };
  const site: { tone: Tone; icon: IconName; text: string } =
    plant.sensitive_site_status === 'excluded'
      ? { tone: 'negative', icon: 'error', text: 'исключён для школ и больниц' }
      : plant.sensitive_site_status === 'requires_review'
        ? { tone: 'warning', icon: 'alert', text: 'школы/больницы: нужна проверка' }
        : { tone: 'neutral', icon: 'dot', text: 'школы/больницы: допустим' };
  return (
    <span className="pg-flags">
      <Badge tone={expert.tone} icon={expert.icon}>
        {expert.text}
      </Badge>
      <Badge tone={plant.taxon_rank === 'genus' ? 'warning' : 'neutral'} icon={plant.taxon_rank === 'genus' ? 'alert' : undefined}>
        {RANK_LABEL[plant.taxon_rank]}
      </Badge>
      <Badge tone={site.tone} icon={site.icon}>
        {site.text}
      </Badge>
      <Badge tone={allergy.tone} icon={allergy.icon}>
        {allergy.text}
      </Badge>
      <Badge tone={tox.tone} icon={tox.icon}>
        {tox.text}
      </Badge>
      {plant.exclusion_basis ? (
        <Badge tone={plant.exclusion_basis === 'legal_prohibition' ? 'negative' : 'warning'} icon="error" title={plant.exclusion_reason ?? undefined}>
          {EXCLUSION_BASIS[plant.exclusion_basis]}
        </Badge>
      ) : null}
    </span>
  );
}

/** Local evidence and review reasons for a catalog record. */
export function PlantReviewDetails({ plant }: { plant: Plant }) {
  return (
    <div className="pg-plant-review">
      <p>
        <span className="pg-muted">Местное свидетельство: </span>
        {plant.local_evidence ?? <span className="pg-unknown">не найдено</span>}
      </p>
      {plant.exclusion_reason ? (
        <p>
          <span className="pg-muted">Причина исключения: </span>
          {plant.exclusion_reason}
        </p>
      ) : null}
      <DataGapList gaps={plant.review_reasons} />
    </div>
  );
}

/** Traits: known values with units and sources; unknown stays "неизвестно", never 0. */
export function TraitTable({ traits }: { traits: Plant['traits'] }) {
  if (traits.length === 0) return <p className="pg-muted">Характеристики не переданы сервером.</p>;
  return (
    <table className="pg-kv">
      <tbody>
        {traits.map((tr) => (
          <tr key={tr.key}>
            <th scope="row">
              <code className="pg-code">{tr.key}</code>
            </th>
            <td>
              {tr.status === 'unknown' ? (
                <span className="pg-unknown">
                  <Icon name="slash" size={12} /> неизвестно
                </span>
              ) : (
                <>
                  {tr.value_text ?? formatNumber(tr.value_number, 2)} {tr.unit ? <UnitText unit={tr.unit} /> : null}
                </>
              )}
            </td>
            <td>
              <SourceList refs={tr.source_refs} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Quantity: null = остаток неизвестен; 0 = известно, что нет. They are never merged. */
export function StockQuantity({ quantity }: { quantity: number | null }) {
  if (quantity === null) {
    return (
      <span className="pg-unknown" title="Поставщик не сообщил остаток">
        <Icon name="slash" size={12} /> остаток неизвестен
      </span>
    );
  }
  if (quantity === 0) {
    return (
      <Badge tone="negative" icon="x">
        нет в наличии (0)
      </Badge>
    );
  }
  return (
    <span>
      {formatNumber(quantity)} <UnitText unit="piece" />
    </span>
  );
}

const AVAILABILITY: Record<StockItem['availability'], { tone: Tone; icon: IconName; text: string }> = {
  in_stock: { tone: 'positive', icon: 'checkCircle', text: 'в наличии (подтверждено)' },
  not_in_stock: { tone: 'negative', icon: 'x', text: 'нет в наличии' },
  vendor_reported: { tone: 'warning', icon: 'info', text: 'со слов поставщика, склад не подтверждён' },
  listing_only: { tone: 'neutral', icon: 'external', text: 'только объявление, наличие не подтверждено' },
  unknown: { tone: 'neutral', icon: 'slash', text: 'наличие неизвестно' },
};
const TAX: Record<StockItem['tax_mode'], string> = {
  included: 'налог включён',
  excluded: 'без налога',
  not_applicable: 'налог не применяется',
  unknown: 'налоговый статус неизвестен',
};

/**
 * A supplier lot: availability, quantity (null vs 0), locality, price date and tax are separate facts.
 * compact (main screens) leaves the source list to the catalog/admin views.
 */
export function StockOfferRow({ item, compact = false }: { item: StockItem; compact?: boolean }) {
  const a = AVAILABILITY[item.availability];
  return (
    <div className="pg-offer">
      <div className="pg-offer__head">
        <strong>{item.supplier}</strong>
        <span className="pg-muted">{item.size_description}</span>
      </div>
      <span className="pg-flags">
        <Badge tone={a.tone} icon={a.icon}>
          {a.text}
        </Badge>
        {item.is_local_supply === false ? (
          <Badge tone="warning" icon="external">
            внешний поставщик{item.supplier_city ? `: ${item.supplier_city}` : ''} — не павлодарская доступность
          </Badge>
        ) : item.is_local_supply === null ? (
          <Badge tone="neutral" icon="slash">
            местоположение поставщика не подтверждено
          </Badge>
        ) : (
          <Badge tone="neutral">{item.supplier_city ?? 'местный поставщик'}</Badge>
        )}
      </span>
      <dl className="pg-dl">
        <dt>Цена материала</dt>
        <dd>
          <MoneyText value={item.unit_price} />
          {item.unit_price !== null ? <span className="pg-muted"> за шт.; {TAX[item.tax_mode]}; работы и доставка — отдельными статьями</span> : null}
        </dd>
        <dt>Остаток</dt>
        <dd>
          <StockQuantity quantity={item.available_quantity} />
          {item.stock_counted_at ? <span className="pg-muted"> на {formatDate(item.stock_counted_at)}</span> : <span className="pg-muted"> · дата учёта склада неизвестна</span>}
        </dd>
        <dt>Размер</dt>
        <dd>
          {item.height_min_m !== null || item.height_max_m !== null
            ? `${formatNumber(item.height_min_m, 1) ?? '…'}–${formatNumber(item.height_max_m, 1) ?? '…'} м`
            : <span className="pg-unknown">высота не указана</span>}
          {item.container ? ` · контейнер ${item.container}` : ''}
          {item.root_system ? ` · ${item.root_system}` : ''}
        </dd>
        <dt>Цена наблюдалась</dt>
        <dd>{item.observed_at ? formatDateTime(item.observed_at) : <span className="pg-unknown">дата не указана источником</span>}</dd>
        <dt>Проверено</dt>
        <dd>{formatDate(item.checked_at) ?? '—'}</dd>
        {item.applicability ? (
          <>
            <dt>Применимость</dt>
            <dd>{item.applicability}</dd>
          </>
        ) : null}
        {compact ? null : (
          <>
            <dt>Источник</dt>
            <dd>
              <SourceList refs={item.source_refs} />
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost breakdown (server CostResult only; no arithmetic in the browser)

const COST_GROUPS: { key: string; label: string; categories: CostLine['category'][] }[] = [
  { key: 'material', label: 'Посадочный материал', categories: ['material'] },
  { key: 'works', label: 'Подготовка и посадочные работы', categories: ['preparation', 'planting'] },
  { key: 'delivery', label: 'Доставка', categories: ['delivery'] },
  { key: 'care', label: 'Уход', categories: ['care'] },
  { key: 'water', label: 'Вода', categories: ['water'] },
  { key: 'replacement', label: 'Ожидаемые замены', categories: ['replacement_expected'] },
  { key: 'reserve', label: 'Резерв риска', categories: ['risk_reserve'] },
  { key: 'tax', label: 'Налоги', categories: ['tax'] },
];

const RATE_STATUS: Record<NonNullable<CostLine['rate_status']>, string> = {
  current: 'ставка действует',
  future: 'ставка ещё не действует',
  expired: 'срок ставки истёк',
  requires_quote: 'нужно коммерческое предложение',
  later_changes_not_resolved: 'не проверены более поздние изменения',
  unverified: 'ставка не проверена',
};

// Statuses that only describe review state; main screens leave them to the manifest/admin views.
const REVIEW_ONLY_STATUS = new Set<NonNullable<CostLine['rate_status']>>(['unverified', 'later_changes_not_resolved']);

/**
 * Lines grouped by category with unit, quantity, rate version, year and formula.
 * Subtotals are the server's; a line without a price is listed as missing, and the
 * group shows no sum of its own. Water is its own category since contract 1.1.0.
 * compact (main screens): no rate ids or review-only statuses, only blocking gaps.
 */
export function CostBreakdown({ cost, compact = false }: { cost: CostResult; compact?: boolean }) {
  return (
    <div className="pg-costbd">
      {COST_GROUPS.map((g) => {
        const lines = cost.lines.filter((l) => g.categories.includes(l.category));
        return (
          <section key={g.key} className="pg-costbd__group">
            <h4>
              {g.label}
              {lines.some((l) => l.subtotal === null) ? (
                <Badge tone="warning" icon="alert">
                  есть позиции без цены
                </Badge>
              ) : null}
            </h4>
            {lines.length === 0 ? (
              <p className="pg-unknown">
                <Icon name="slash" size={12} /> строк нет в результате сервера — статья не рассчитана
              </p>
            ) : (
              <table className="pg-kv pg-kv--cost">
                <thead>
                  <tr>
                    <th scope="col">Позиция</th>
                    <th scope="col">Кол-во</th>
                    <th scope="col">Цена ед.</th>
                    <th scope="col">Сумма</th>
                    <th scope="col">Год</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className={l.subtotal === null ? 'is-missing' : undefined}>
                      <td>
                        {l.description}
                        <div className="pg-muted pg-costbd__meta">
                          <code className="pg-code">{l.formula}</code>
                          {compact ? (l.rate_version_id ? null : <> · ставка не выбрана</>) : l.rate_version_id ? <> · ставка {l.rate_version_id.slice(0, 8)}</> : <> · ставка не выбрана</>}
                          {l.rate_status && !(compact && REVIEW_ONLY_STATUS.has(l.rate_status)) ? <> · {RATE_STATUS[l.rate_status]}</> : null}
                          {' · '}
                          {TAX[l.tax_mode]}
                          {l.price_observed_at ? <> · цена на {formatDate(l.price_observed_at)}</> : <> · дата цены неизвестна</>}
                        </div>
                      </td>
                      <td>
                        {formatNumber(l.quantity, 2)} <UnitText unit={l.unit} />
                      </td>
                      <td>
                        <MoneyText value={l.unit_price} />
                      </td>
                      <td>
                        <MoneyText value={l.subtotal} />
                      </td>
                      <td>{l.year === 0 ? 'посадка' : `${l.year}-й`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
      <p className="pg-muted">
        Валюта {cost.currency}. Строки и суммы — результат сервера; интерфейс не пересчитывает смету.
      </p>
      <DataGapList gaps={compact ? cost.data_gaps.filter((g) => g.blocking) : cost.data_gaps} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Height basis for map/3D (F-3D-02; ADR-004 §6)

export type HeightBasis = MapFeature['height_basis'];

const HEIGHT: Record<HeightBasis, { label: string; note: string; swatch: string; pattern: 'solid' | 'hatched' | 'outline' }> = {
  measured: { label: 'Измеренная высота', note: 'Можно использовать в аналитике теней', swatch: 'var(--pg-prov-measured)', pattern: 'solid' },
  recorded_unverified: {
    label: 'Высота по данным набора',
    note: 'Значение из опубликованного набора',
    swatch: 'var(--pg-prov-estimated)',
    pattern: 'solid',
  },
  floors_estimate: {
    label: 'Оценка по этажности',
    note: 'Этажность × принятая высота этажа; допущение',
    swatch: 'var(--pg-prov-estimated)',
    pattern: 'hatched',
  },
  visual_placeholder: {
    label: 'Условная высота для обзора',
    note: 'Только визуализация; не участвует в расчётах',
    swatch: 'var(--pg-map-unknown)',
    pattern: 'outline',
  },
  unknown: { label: 'Высота неизвестна', note: 'Контур без высоты', swatch: 'var(--pg-map-unknown)', pattern: 'outline' },
};

export function HeightBasisLegend({ counts }: { counts?: Partial<Record<HeightBasis, number | null>> }) {
  return (
    <ul className="pg-heightlegend">
      {(Object.keys(HEIGHT) as HeightBasis[]).map((k) => (
        <li key={k}>
          <span className={`pg-swatch pg-swatch--${HEIGHT[k].pattern}`} style={{ background: HEIGHT[k].pattern === 'outline' ? 'transparent' : HEIGHT[k].swatch, borderColor: HEIGHT[k].swatch }} aria-hidden />
          <span>
            <strong>{HEIGHT[k].label}</strong>
            {counts && k in counts ? <span className="pg-muted"> · {counts[k] == null ? 'кол-во неизвестно' : formatNumber(counts[k]!)}</span> : null}
            <br />
            <span className="pg-muted">{HEIGHT[k].note}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function HeightBasisBadge({ basis }: { basis: HeightBasis }) {
  const tone: Tone = basis === 'measured' ? 'info' : basis === 'visual_placeholder' || basis === 'unknown' ? 'neutral' : 'warning';
  return (
    <Badge tone={tone} icon={basis === 'measured' ? 'ruler' : basis === 'visual_placeholder' ? 'slash' : 'approx'}>
      {HEIGHT[basis].label}
    </Badge>
  );
}

/** Period display for rates/sources: future periods are not "действует". */
export function PeriodText({ from, to, today }: { from: string | null; to: string | null; today: string }) {
  const f = formatDate(from);
  const t = formatDate(to);
  const future = from !== null && from > today;
  const expired = to !== null && to < today;
  return (
    <span>
      {f ?? '…'} – {t ?? '…'}{' '}
      {future ? (
        <Badge tone="info" icon="clock">
          ещё не действует
        </Badge>
      ) : expired ? (
        <Badge tone="neutral" icon="clock">
          срок истёк
        </Badge>
      ) : null}
    </span>
  );
}

export { ProvenanceBadge };
