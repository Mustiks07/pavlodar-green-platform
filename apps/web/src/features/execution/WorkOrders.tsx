import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, newIdempotencyKey, unwrap, type City, type Scenario, type ScenarioRevision, type WorkCompletion, type WorkOrder, type WorkOrderCreate } from '@pg/api-client';
import { Badge, Button, Card, Dialog, Field, formatDate, formatDateTime, formatNumber, Input, Notice, Select, Skeleton, StateView, UnitText, unitLabel, type Tone } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { todayIn, zonedIso } from '../shadow/queries';

export const WO_TONE: Record<WorkOrder['status'], Tone> = { planned: 'neutral', assigned: 'info', in_progress: 'warning', completed: 'positive', cancelled: 'neutral' };
/** Hints for the buttons; the server decides every transition. */
const NEXT: Record<WorkOrder['status'], WorkOrder['status'][]> = {
  planned: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
const keys = {
  order: (id: string) => ['work-order', id] as const,
  completions: (id: string) => ['work-completions', id] as const,
};
const isConflict = (e: unknown) => e instanceof ApiError && (e.category === 'revision_conflict' || e.status === 412);

function useWorkOrder(id: string) {
  return useQuery({
    queryKey: keys.order(id),
    queryFn: async ({ signal }) => unwrap<WorkOrder>(api.GET('/v1/work-orders/{work_order_id}', { params: { path: { work_order_id: id } }, signal })),
  });
}

function TransitionButton({ order, etag, target, onDone }: { order: WorkOrder; etag: string; target: WorkOrder['status']; onDone: (conflict: boolean) => void }) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: async () =>
      unwrap<WorkOrder>(
        api.POST('/v1/work-orders/{work_order_id}/transitions', {
          params: { path: { work_order_id: order.id }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey(), 'If-Match': etag } },
          body: { target_status: target, reason: reason.trim() },
        }),
      ),
    onSuccess: () => {
      setOpen(false);
      onDone(false);
    },
    onError: (e) => {
      if (isConflict(e)) {
        setOpen(false);
        onDone(true);
      }
    },
  });
  return (
    <>
      <Button size="sm" variant={target === 'cancelled' ? 'ghost' : 'secondary'} onClick={() => setOpen(true)}>
        {t(`exec.to.${target}` as AppKey)}
      </Button>
      <Dialog
        open={open}
        title={t(`exec.to.${target}` as AppKey)}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('grants.cancel')}</Button>
            <Button variant={target === 'cancelled' ? 'danger' : 'primary'} busy={run.isPending} disabled={!reason.trim()} onClick={() => run.mutate()}>
              {t(`exec.to.${target}` as AppKey)}
            </Button>
          </>
        }
      >
        {target === 'completed' ? <p>{t('exec.complete.desc')}</p> : null}
        {target === 'cancelled' ? <p>{t('exec.cancel.desc')}</p> : null}
        <Field label={t('grants.field.reason')} required hint={t('grants.field.reason.hint')}>
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {run.isError && !isConflict(run.error) ? <ApiErrorView compact error={run.error} /> : null}
      </Dialog>
    </>
  );
}

function CompletionForm({ order, etag, timeZone, active, onDone }: { order: WorkOrder; etag: string; timeZone: string; active: WorkCompletion[]; onDone: (conflict: boolean) => void }) {
  const { user } = useSession();
  const [date, setDate] = useState(() => todayIn(timeZone));
  const [time, setTime] = useState('10:00');
  const [quantity, setQuantity] = useState('');
  const [water, setWater] = useState('');
  const [crew, setCrew] = useState('');
  const [note, setNote] = useState('');
  const [correction, setCorrection] = useState('');
  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
  const record = useMutation({
    mutationFn: async () =>
      unwrap<WorkCompletion>(
        api.POST('/v1/work-orders/{work_order_id}/completions', {
          params: { path: { work_order_id: order.id }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey(), 'If-Match': etag } },
          body: {
            performed_at: zonedIso(date, time, timeZone),
            quantity: num(quantity) ?? 0,
            water_m3: num(water),
            crew_minutes: crew.trim() === '' ? null : Math.round(Number(crew)),
            note: note.trim(),
            correction_of_id: correction || null,
          },
        }),
      ),
    onSuccess: () => {
      setQuantity('');
      setNote('');
      setCorrection('');
      onDone(false);
    },
    onError: (e) => {
      if (isConflict(e)) onDone(true);
    },
  });
  const qty = num(quantity);
  return (
    <form
      className="exec-form"
      onSubmit={(e) => {
        e.preventDefault();
        record.mutate();
      }}
    >
      <h4>{t('exec.completion.add')}</h4>
      <Field label={t('exec.completion.correction')} hint={t('exec.completion.correction.hint')}>
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} value={correction} onChange={(e) => setCorrection(e.target.value)}>
            <option value="">{t('exec.completion.new')}</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {t('exec.completion.fix', { date: formatDate(c.performed_at) ?? '', qty: formatNumber(c.quantity, 2) ?? '' })}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('shadow.date')} required>
        {({ id }) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
      </Field>
      <Field label={t('shadow.time')} required>
        {({ id }) => <Input id={id} type="time" value={time} onChange={(e) => setTime(e.target.value)} />}
      </Field>
      <Field label={t('exec.completion.quantity', { unit: unitLabel(order.unit).label })} required>
        {({ id }) => <Input id={id} inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
      </Field>
      <Field label={t('exec.completion.water')}>
        {({ id }) => <Input id={id} inputMode="decimal" value={water} onChange={(e) => setWater(e.target.value)} />}
      </Field>
      <Field label={t('exec.completion.crew')}>
        {({ id }) => <Input id={id} inputMode="numeric" value={crew} onChange={(e) => setCrew(e.target.value)} />}
      </Field>
      <Field label={t('exec.completion.note')} required>
        {({ id }) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <Button type="submit" variant="primary" busy={record.isPending} disabled={qty === null || !Number.isFinite(qty) || qty < 0 || !note.trim()}>
        {t('exec.completion.save')}
      </Button>
      {record.isError && !isConflict(record.error) ? <ApiErrorView compact error={record.error} /> : null}
    </form>
  );
}

function CohortFromOrder({ order, timeZone }: { order: WorkOrder; timeZone: string }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const revision = useQuery({
    queryKey: ['scenario-revision', order.scenario_revision_id],
    queryFn: async ({ signal }) => (await unwrap<ScenarioRevision>(api.GET('/v1/scenario-revisions/{revision_id}', { params: { path: { revision_id: order.scenario_revision_id } }, signal }))).data,
  });
  const [placement, setPlacement] = useState('');
  const [date, setDate] = useState(() => todayIn(timeZone));
  const create = useMutation({
    mutationFn: async () =>
      unwrap(
        api.POST('/v1/cohorts', {
          params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
          body: { work_order_id: order.id, placement_id: placement, planting_date: date },
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['list', 'cohorts'] }),
  });
  if (revision.isPending) return <Skeleton lines={1} />;
  if (revision.isError) return <ApiErrorView compact error={revision.error} onRetry={() => void revision.refetch()} />;
  return (
    <form
      className="exec-form"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h4>{t('exec.cohort.create')}</h4>
      <p className="pg-muted">{t('exec.cohort.create.desc')}</p>
      <Field label={t('exec.cohort.placement')} required>
        {({ id }) => (
          <Select id={id} value={placement} onChange={(e) => setPlacement(e.target.value)}>
            <option value="">{t('exec.cohort.placement.choose')}</option>
            {revision.data.placements.map((p) => (
              <option key={p.id} value={p.id}>
                {t('exec.cohort.placement.option', { id: p.id.slice(0, 8), qty: p.quantity, date: formatDate(p.planting_date) ?? p.planting_date })}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('exec.cohort.planted')} required>
        {({ id }) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
      </Field>
      <Button type="submit" busy={create.isPending} disabled={!placement || !date}>
        {t('exec.cohort.create.submit')}
      </Button>
      {create.isSuccess ? <p role="status" className="pg-muted">{t('exec.cohort.created')}</p> : null}
      {create.isError ? <ApiErrorView compact error={create.error} /> : null}
    </form>
  );
}

/**
 * One work order: server status and completed total, transitions with a reason and If-Match,
 * append-only completions where a correction supersedes its predecessor (the server total counts
 * only chain leaves), and a cohort from a completed piece-based order.
 */
export function WorkOrderDetail({ id, timeZone, onClose }: { id: string; timeZone: string; onClose: () => void }) {
  const { hasRole } = useSession();
  const qc = useQueryClient();
  const order = useWorkOrder(id);
  const listOk = useOperationAvailable('listWorkCompletions');
  const completions = useQuery({
    queryKey: keys.completions(id),
    enabled: listOk !== false && hasRole('specialist'),
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/work-orders/{work_order_id}/completions', { params: { path: { work_order_id: id }, query: { limit: 200 } }, signal }))).data.items,
  });
  const [conflict, setConflict] = useState(false);
  const superseded = useMemo(() => new Set((completions.data ?? []).map((c) => c.correction_of_id).filter(Boolean)), [completions.data]);
  const refresh = (wasConflict: boolean) => {
    setConflict(wasConflict);
    void qc.invalidateQueries({ queryKey: keys.order(id) });
    void qc.invalidateQueries({ queryKey: keys.completions(id) });
    void qc.invalidateQueries({ queryKey: ['list', 'work-orders'] });
  };
  const close = <Button variant="ghost" size="sm" icon="x" iconOnly aria-label={t('exec.close')} onClick={onClose} />;
  if (order.isPending) return <Card actions={close}><Skeleton lines={4} /></Card>;
  if (order.isError) return <Card actions={close}><ApiErrorView compact error={order.error} onRetry={() => void order.refetch()} /></Card>;
  const { data: o, etag } = order.data;
  const rows = [...(completions.data ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const active = rows.filter((c) => !superseded.has(c.id));
  return (
    <Card title={o.operation} actions={close}>
      <div className="exec-detail" data-work-order-id={o.id} data-status={o.status}>
        {conflict ? <Notice tone="warning" title={t('exec.conflict')}>{t('exec.conflict.desc')}</Notice> : null}
        <span className="pg-flags">
          <Badge tone={WO_TONE[o.status]}>{t(`wo.${o.status}` as AppKey)}</Badge>
        </span>
        <dl className="pg-dl">
          <dt>{t('col.progress')}</dt>
          <dd data-completed={o.completed_quantity}>
            {formatNumber(o.completed_quantity, 2)} / {formatNumber(o.quantity, 2)} <UnitText unit={o.unit} />
          </dd>
          <dt>{t('col.window')}</dt>
          <dd>
            {formatDate(o.planned_start)} – {formatDate(o.planned_end)}
          </dd>
          <dt>{t('col.assignee')}</dt>
          <dd>{o.assignee_group ?? t('none')}</dd>
          <dt>{t('exec.revision')}</dt>
          <dd>Утверждённая версия проекта</dd>
          <dt>{t('col.updated')}</dt>
          <dd>{formatDateTime(o.updated_at, timeZone)}</dd>
        </dl>
        {hasRole('specialist') && etag && NEXT[o.status].length ? (
          <span className="scn-actions">
            {NEXT[o.status].map((s) => (
              <TransitionButton key={s} order={o} etag={etag} target={s} onDone={refresh} />
            ))}
          </span>
        ) : null}
        <h4>{t('exec.completions')}</h4>
        {!hasRole('specialist') ? (
          <p className="pg-muted">{t('exec.completions.role')}</p>
        ) : listOk === false ? (
          <OperationUnavailable compact operationId="listWorkCompletions" />
        ) : completions.isPending ? (
          <Skeleton lines={2} />
        ) : completions.isError ? (
          <ApiErrorView compact error={completions.error} onRetry={() => void completions.refetch()} />
        ) : rows.length === 0 ? (
          <p className="pg-muted">{t('exec.completions.empty')}</p>
        ) : (
          <table className="acc-table exec-completions">
            <caption className="pg-sr-only">{t('exec.completions')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('exec.completion.when')}</th>
                <th scope="col">{t('exec.completion.qty')}</th>
                <th scope="col">{t('exec.completion.note')}</th>
                <th scope="col">{t('col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={superseded.has(c.id) ? 'is-superseded' : undefined} data-completion-id={c.id}>
                  <td>{formatDateTime(c.performed_at, timeZone)}</td>
                  <td>
                    {formatNumber(c.quantity, 2)} <UnitText unit={o.unit} />
                  </td>
                  <td>{c.note}</td>
                  <td>
                    {superseded.has(c.id) ? (
                      <Badge tone="neutral">{t('exec.completion.superseded')}</Badge>
                    ) : c.correction_of_id ? (
                      <Badge tone="info">{t('exec.completion.correction.of', { id: c.correction_of_id.slice(0, 8) })}</Badge>
                    ) : (
                      <Badge tone="positive">{t('exec.completion.active')}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="pg-muted">{t('exec.completions.note')}</p>
        {hasRole('specialist') && etag && o.status === 'in_progress' ? <CompletionForm order={o} etag={etag} timeZone={timeZone} active={active} onDone={refresh} /> : null}
        {hasRole('specialist') && o.status === 'completed' && o.unit === 'piece' ? <CohortFromOrder order={o} timeZone={timeZone} /> : null}
      </div>
    </Card>
  );
}

/** New work order for an approved scenario revision (the server checks approval and dates). */
export function CreateWorkOrder({ city, onCreated }: { city: City; onCreated: (id: string) => void }) {
  const { user, hasRole } = useSession();
  const ok = useOperationAvailable('createWorkOrder');
  const [open, setOpen] = useState(false);
  const scenarios = useQuery({
    queryKey: ['approved-scenarios', city.id],
    enabled: open,
    queryFn: async ({ signal }) => (await unwrap(api.GET('/v1/scenarios', { params: { query: { city_id: city.id, limit: 200 } }, signal }))).data.items.filter((s: Scenario) => s.status === 'approved'),
  });
  const [form, setForm] = useState({ scenario: '', operation: '', start: todayIn(city.timezone), end: todayIn(city.timezone), quantity: '', unit: 'piece', assignee: '' });
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async () => {
      const s = scenarios.data!.find((x) => x.id === form.scenario)!;
      const body: WorkOrderCreate = {
        city_id: city.id,
        scenario_revision_id: s.current_revision_id,
        zone_id: s.zone_id,
        operation: form.operation.trim(),
        planned_start: form.start,
        planned_end: form.end,
        quantity: Number(form.quantity.replace(',', '.')),
        unit: form.unit,
        assignee_group: form.assignee.trim() || null,
      };
      return (await unwrap<WorkOrder>(api.POST('/v1/work-orders', { params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } }, body }))).data;
    },
    onSuccess: (o) => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['list', 'work-orders'] });
      onCreated(o.id);
    },
  });
  if (!hasRole('specialist') || ok === false) return null;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const valid = form.scenario && form.operation.trim() && Number(form.quantity.replace(',', '.')) > 0 && form.start <= form.end;
  return (
    <>
      <Button icon="plus" onClick={() => setOpen(true)}>
        {t('exec.create')}
      </Button>
      <Dialog
        open={open}
        title={t('exec.create')}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('grants.cancel')}</Button>
            <Button variant="primary" busy={create.isPending} disabled={!valid} onClick={() => create.mutate()}>
              {t('exec.create.submit')}
            </Button>
          </>
        }
      >
        {scenarios.isPending ? (
          <Skeleton lines={2} />
        ) : scenarios.isError ? (
          <ApiErrorView compact error={scenarios.error} onRetry={() => void scenarios.refetch()} />
        ) : scenarios.data.length === 0 ? (
          <StateView compact state="empty" title={t('exec.create.noApproved')} description={t('exec.create.noApproved.desc')} />
        ) : (
          <div className="exec-form">
            <Field label={t('exec.create.scenario')} required>
              {({ id }) => (
                <Select id={id} value={form.scenario} onChange={set('scenario')}>
                  <option value="">{t('exec.create.scenario.choose')}</option>
                  {scenarios.data.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('col.operation')} required>
              {({ id }) => <Input id={id} value={form.operation} onChange={set('operation')} />}
            </Field>
            <Field label={t('exec.create.start')} required>
              {({ id }) => <Input id={id} type="date" value={form.start} onChange={set('start')} />}
            </Field>
            <Field label={t('exec.create.end')} required>
              {({ id }) => <Input id={id} type="date" value={form.end} onChange={set('end')} />}
            </Field>
            <Field label={t('exec.create.quantity')} required>
              {({ id }) => <Input id={id} inputMode="decimal" value={form.quantity} onChange={set('quantity')} />}
            </Field>
            <Field label={t('exec.create.unit')} required>
              {({ id }) => (
                <Select id={id} value={form.unit} onChange={set('unit')}>
                  {['piece', 'm2', 'm3', 'm'].map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('col.assignee')}>
              {({ id }) => <Input id={id} value={form.assignee} onChange={set('assignee')} />}
            </Field>
          </div>
        )}
        {create.isError ? <ApiErrorView compact error={create.error} /> : null}
      </Dialog>
    </>
  );
}
