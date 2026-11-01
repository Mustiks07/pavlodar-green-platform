import { useState } from 'react';
import type { ApiError, CareOperation, ResourceLimit } from '@pg/api-client';
import { Badge, Field, formatNumber, Input, Notice, Select } from '@pg/ui';
import './CarePlanEditor.css';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const numeric = (value: string, integer = false) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return integer ? Math.round(parsed) : parsed;
};

export function CarePlanEditor({
  operations,
  limits,
  horizon,
  disabled,
  error,
  onOperationsChange,
  onLimitsChange,
}: {
  operations: CareOperation[];
  limits: ResourceLimit[];
  horizon: number;
  disabled: boolean;
  error: ApiError | null;
  onOperationsChange: (operations: CareOperation[]) => void;
  onLimitsChange: (limits: ResourceLimit[]) => void;
}) {
  const years = Array.from({ length: horizon }, (_, index) => index);
  const [year, setYear] = useState(0);
  const activeYear = Math.min(year, Math.max(0, horizon - 1));
  const annualOperations = operations.filter((item) => item.year_offset === activeYear);
  const totals = annualOperations.reduce(
    (sum, item) => ({
      water_m3: sum.water_m3 + item.water_m3,
      crew_minutes: sum.crew_minutes + item.crew_minutes,
      max_visits: sum.max_visits + item.visits,
    }),
    { water_m3: 0, crew_minutes: 0, max_visits: 0 },
  );
  const period = `year:${activeYear}`;
  const limitIndex = limits.findIndex((item) => item.period === period);
  const limit = limitIndex >= 0
    ? limits[limitIndex]!
    : { period, water_m3: null, crew_minutes: null, max_visits: null, care_budget: null };
  const exceeded = {
    water_m3: limit.water_m3 !== null && totals.water_m3 > limit.water_m3,
    crew_minutes: limit.crew_minutes !== null && totals.crew_minutes > limit.crew_minutes,
    max_visits: limit.max_visits !== null && totals.max_visits > limit.max_visits,
  };
  const updateLimit = (field: 'water_m3' | 'crew_minutes' | 'max_visits', raw: string) => {
    const next = { ...limit, [field]: raw === '' ? null : numeric(raw, field !== 'water_m3') };
    if (limitIndex >= 0) onLimitsChange(limits.map((item, index) => (index === limitIndex ? next : item)));
    else onLimitsChange([...limits, next].sort((a, b) => a.period.localeCompare(b.period)));
  };
  const updateOperation = (id: string, field: keyof CareOperation, raw: string) => {
    onOperationsChange(operations.map((operation) => {
      if (operation.id !== id) return operation;
      const value = numeric(raw, field === 'month' || field === 'crew_minutes' || field === 'visits');
      const next = { ...operation, [field]: value };
      if (field === 'water_m3' && operation.unit === 'm3' && operation.quantity === operation.water_m3) next.quantity = value;
      return next;
    }));
  };
  const fieldError = (field: string) => {
    if (!error?.problem?.field_errors || limitIndex < 0) return null;
    return error.problem.field_errors.find((item) => item.path === `/resource_limits/${limitIndex}/${field}`)?.message ?? null;
  };

  return (
    <section id="scenario-care-editor" className="care-plan-editor" aria-labelledby="care-plan-editor-title">
      <header>
        <span><small>Ресурсный сценарий</small><h3 id="care-plan-editor-title">План ухода и доступные ресурсы</h3></span>
        <Badge tone={Object.values(exceeded).some(Boolean) ? 'warning' : 'positive'}>
          {Object.values(exceeded).some(Boolean) ? 'нужно согласовать ресурсы' : 'в пределах заданных лимитов'}
        </Badge>
      </header>
      <p>Изменения сохранятся новой версией проекта и будут проверены сервером. Они не меняют прогноз приживаемости сами по себе.</p>
      <div className="care-plan-editor__years" role="tablist" aria-label="Год ухода">
        {years.map((item) => (
          <button key={item} type="button" role="tab" aria-selected={activeYear === item} onClick={() => setYear(item)}>
            {item + 1}-й год
          </button>
        ))}
      </div>
      <div className="care-plan-editor__limits">
        <Field label="Лимит воды, м³" hint={`По плану: ${formatNumber(totals.water_m3, 1)} м³`} error={fieldError('water_m3')}>
          {({ id, describedBy, invalid }) => <Input id={id} type="number" min="0" step="0.1" value={limit.water_m3 ?? ''} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} onChange={(event) => updateLimit('water_m3', event.target.value)} />}
        </Field>
        <Field label="Лимит работы бригады, мин" hint={`По плану: ${totals.crew_minutes} мин`} error={fieldError('crew_minutes')}>
          {({ id, describedBy, invalid }) => <Input id={id} type="number" min="0" step="1" value={limit.crew_minutes ?? ''} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} onChange={(event) => updateLimit('crew_minutes', event.target.value)} />}
        </Field>
        <Field label="Лимит выездов" hint={`По плану: ${totals.max_visits}`} error={fieldError('max_visits')}>
          {({ id, describedBy, invalid }) => <Input id={id} type="number" min="0" step="1" value={limit.max_visits ?? ''} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} onChange={(event) => updateLimit('max_visits', event.target.value)} />}
        </Field>
      </div>
      {Object.values(exceeded).some(Boolean) ? (
        <Notice tone="warning" title="План превышает введённый ресурс">
          Сохранение отправит точные значения на серверную проверку. Текущая версия проекта останется без изменений при отклонении.
        </Notice>
      ) : null}
      <div className="care-plan-editor__operations">
        {annualOperations.map((operation) => (
          <article key={operation.id}>
            <header><strong>{operation.operation}</strong><span>{operation.placement_ids.length} групп посадок</span></header>
            <div>
              <Field label="Месяц">
                {({ id }) => <Select id={id} value={operation.month} disabled={disabled} onChange={(event) => updateOperation(operation.id, 'month', event.target.value)}>{MONTHS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</Select>}
              </Field>
              <Field label={operation.unit === 'm3' && operation.quantity === operation.water_m3 ? 'Вода и объём для сметы, м³' : 'Плановый расход воды, м³'}>
                {({ id }) => <Input id={id} type="number" min="0" step="0.1" value={operation.water_m3} disabled={disabled} onChange={(event) => updateOperation(operation.id, 'water_m3', event.target.value)} />}
              </Field>
              <Field label="Работа бригады, мин">
                {({ id }) => <Input id={id} type="number" min="0" step="1" value={operation.crew_minutes} disabled={disabled} onChange={(event) => updateOperation(operation.id, 'crew_minutes', event.target.value)} />}
              </Field>
              <Field label="Выезды">
                {({ id }) => <Input id={id} type="number" min="0" step="1" value={operation.visits} disabled={disabled} onChange={(event) => updateOperation(operation.id, 'visits', event.target.value)} />}
              </Field>
              {operation.unit === 'm3' && operation.quantity === operation.water_m3 ? null : (
                <Field label={`Объём для сметы, ${operation.unit}`}>
                  {({ id }) => <Input id={id} type="number" min="0" step="0.1" value={operation.quantity} disabled={disabled} onChange={(event) => updateOperation(operation.id, 'quantity', event.target.value)} />}
                </Field>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
