import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useMatch, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  newIdempotencyKey,
  unwrap,
  type ChatMessage,
  type ChatMessagePage,
  type ChatSession,
  type Job,
  type Plant,
  type Proposal,
  type Scenario,
  type ScenarioRevision,
  type ScenarioRevisionPage,
} from '@pg/api-client';
import { Badge, Button, Field, formatDateTime, formatNumber, Icon, JobStatus, MetricValue, Notice, Select, Skeleton, StateView } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { productLabel } from '../../productCopy';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { TERMINAL_JOB_STATES, useJob } from '../jobs/useJob';
import { isUuid } from '../map/publishedLayers';
import { cityDisplayName } from '../../city';
import { useRevision, useZone, zk } from '../zones/queries';
import { ProposalOutcome } from './ProposalOutcome';

/** URL keys: the open chat session and the job of its pending answer; reload resumes both. */
export const CHAT = 'chat';
export const CHAT_JOB = 'chatJob';

const short = (id: string) => id.slice(0, 8);
const PENDING: ChatMessage['state'][] = ['queued', 'streaming'];
const STATE_TONE = { queued: 'info', streaming: 'info', completed: 'positive', failed: 'negative', cancelled: 'neutral' } as const;
const PROPOSAL_TONE = { pending: 'info', applied: 'positive', rejected: 'neutral', expired: 'neutral' } as const;
const QUICK_PROMPTS = [
  'Предложи увеличить на 1 количество одного подходящего растения в текущем проекте.',
  'Какие территории сейчас требуют внимания в первую очередь?',
  'Объясни стоимость, уход и ожидаемый эффект текущего проекта.',
];

/**
 * The binding a session was created with, as the server returned it. There is no read operation
 * for a ChatSession, so the server response is remembered per viewer; messages themselves always
 * come from listChatMessages.
 */
const SESSIONS_KEY = 'pg.chat.sessions';
function rememberedSession(id: string): ChatSession | null {
  try {
    const all = JSON.parse(window.localStorage.getItem(SESSIONS_KEY) ?? '{}') as Record<string, ChatSession>;
    return all[id] ?? null;
  } catch {
    return null;
  }
}
function rememberSession(session: ChatSession) {
  try {
    const all = JSON.parse(window.localStorage.getItem(SESSIONS_KEY) ?? '{}') as Record<string, ChatSession>;
    const kept = Object.values(all)
      .filter((s) => s.id !== session.id)
      .slice(-19);
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(Object.fromEntries([...kept, session].map((s) => [s.id, s]))));
  } catch {
    /* per-viewer convenience only */
  }
}

function useSetUrl() {
  const [, setParams] = useSearchParams();
  return (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
}

function useScenarioById(scenarioId: string | null) {
  return useQuery({
    queryKey: zk.scenario(scenarioId ?? ''),
    enabled: Boolean(scenarioId),
    queryFn: ({ signal }) => unwrap<Scenario>(api.GET('/v1/scenarios/{scenario_id}', { params: { path: { scenario_id: scenarioId! } }, signal })),
  });
}

/** What the open page is about: a project page binds its zone and the viewed (or current) revision. */
function useRouteContext() {
  const match = useMatch('/projects/:scenarioId');
  const [params] = useSearchParams();
  const scenarioId = isUuid(match?.params.scenarioId ?? null) ? match!.params.scenarioId! : null;
  const scenario = useScenarioById(scenarioId);
  const s = scenario.data?.data ?? null;
  const viewed = params.get('revision');
  const zoneParam = params.get('zone');
  return {
    scenario: s,
    zoneId: s?.zone_id ?? (isUuid(zoneParam) ? zoneParam : null),
    revisionId: s ? (isUuid(viewed) ? viewed : s.current_revision_id) : null,
    loading: Boolean(scenarioId) && scenario.isPending,
  };
}

function SessionBinding({ session }: { session: ChatSession | null }) {
  const zone = useZone(session?.zone_id ?? null);
  if (!session) return <p className="pg-muted asst-binding">{t('assistant.binding.unknown')}</p>;
  return (
    <dl className="pg-dl asst-binding" data-binding-zone={session.zone_id ?? ''} data-binding-revision={session.scenario_revision_id ?? ''}>
      <dt>{t('assistant.binding.zone')}</dt>
      <dd>{session.zone_id ? (zone.data?.data.name ?? short(session.zone_id)) : t('assistant.binding.none')}</dd>
      <dt>{t('assistant.binding.revision')}</dt>
      <dd>{session.scenario_revision_id ? 'Текущая версия проекта' : t('assistant.binding.none')}</dd>
      <dt>{t('assistant.binding.created')}</dt>
      <dd>{formatDateTime(session.created_at)}</dd>
    </dl>
  );
}

type Level = 'city' | 'zone' | 'revision';

/** Starts a session bound to the city, zone or exact ScenarioRevision of the open page. */
function NewSession() {
  const { user, city } = useSession();
  const ctx = useRouteContext();
  const zone = useZone(ctx.zoneId);
  const setUrl = useSetUrl();
  const levels: Level[] = ['city', ...(ctx.zoneId ? (['zone'] as const) : []), ...(ctx.revisionId ? (['revision'] as const) : [])];
  const [chosen, setChosen] = useState<Level | null>(null);
  const level = chosen && levels.includes(chosen) ? chosen : levels[levels.length - 1]!;
  const create = useMutation({
    mutationFn: async () =>
      (
        await unwrap<ChatSession>(
          api.POST('/v1/chat/sessions', {
            params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: {
              city_id: city!.id,
              zone_id: level === 'city' ? null : ctx.zoneId,
              scenario_revision_id: level === 'revision' ? ctx.revisionId : null,
            },
          }),
        )
      ).data,
    onSuccess: (s) => {
      rememberSession(s);
      setUrl({ [CHAT]: s.id, [CHAT_JOB]: null });
    },
  });
  if (!city) return <StateView compact state="empty" title={t('assistant.noCity')} description={t('assistant.noCity.desc')} />;
  if (ctx.loading) return <Skeleton lines={2} />;
  const label: Record<Level, string> = {
    city: t('assistant.level.city', { city: cityDisplayName(city.name) }),
    zone: t('assistant.level.zone', { zone: zone.data?.data.name ?? short(ctx.zoneId ?? '') }),
    revision: `Проект «${ctx.scenario?.name ?? 'без названия'}» · текущая версия`,
  };
  return (
    <div className="asst-new">
      <section className="asst-welcome">
        <span className="asst-welcome__mark"><Icon name="sprout" size={22} /></span>
        <div>
          <strong>Помощник по городскому озеленению</strong>
          <p>Разбирает контекст города и участка, объясняет расчёты и готовит изменения проекта для вашего подтверждения.</p>
        </div>
      </section>
      <Field label={t('assistant.level')} hint={t('assistant.level.hint')}>
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} value={level} onChange={(e) => setChosen(e.target.value as Level)} data-testid="chat-level">
            {levels.map((l) => (
              <option key={l} value={l}>
                {label[l]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button variant="primary" icon="chat" busy={create.isPending} onClick={() => create.mutate()}>
        {t('assistant.start')}
      </Button>
      {create.isError ? <ApiErrorView compact error={create.error} onRetry={() => create.mutate()} /> : null}
    </div>
  );
}

function useChatMessages(sessionId: string, polling: boolean) {
  return useQuery({
    queryKey: ['chat-messages', sessionId],
    queryFn: async ({ signal }) => {
      const items: ChatMessage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = (
          await unwrap<ChatMessagePage>(
            api.GET('/v1/chat/sessions/{session_id}/messages', { params: { path: { session_id: sessionId }, query: { limit: 200, ...(cursor ? { cursor } : {}) } }, signal }),
          )
        ).data;
        items.push(...res.items);
        if (!res.next_cursor) break;
        cursor = res.next_cursor;
      }
      return items;
    },
    // The job stream drives updates; without a tracked job a pending answer is re-read slowly.
    refetchInterval: (q) => (polling && q.state.data?.some((m) => PENDING.includes(m.state)) ? 4000 : false),
  });
}

/** Proposed placement quantities next to the base revision's, both as the server stored them. */
function ProposalChanges({ proposal }: { proposal: Proposal }) {
  const base = useRevision(proposal.base_revision_id);
  if (base.isPending) return <Skeleton lines={1} />;
  if (base.isError) return <ApiErrorView compact error={base.error} onRetry={() => void base.refetch()} />;
  const before = new Map(base.data.placements.map((p) => [p.id, p.quantity]));
  const changed = proposal.proposed_revision.placements.filter((p) => before.get(p.id) !== p.quantity);
  if (!changed.length) return <p className="pg-muted">{t('assistant.proposal.noChange')}</p>;
  return (
    <ul className="asst-changes">
      {changed.map((p) => (
        <ProposalChange key={p.id} placement={p} before={before.get(p.id)} />
      ))}
    </ul>
  );
}

function ProposalChange({
  placement,
  before,
}: {
  placement: Proposal['proposed_revision']['placements'][number];
  before: number | undefined;
}) {
  const plant = useQuery({
    queryKey: ['plant', placement.plant_id],
    queryFn: async ({ signal }) =>
      (await unwrap<Plant>(api.GET('/v1/plants/{plant_id}', { params: { path: { plant_id: placement.plant_id } }, signal }))).data,
  });
  const plantName = plant.data?.russian_name ?? t('assistant.proposal.selectedPlant');
  return (
    <li data-placement-id={placement.id} data-before={before ?? ''} data-after={placement.quantity}>
      {t('assistant.proposal.change', {
        plant: plantName,
        before: before === undefined ? t('none') : (formatNumber(before) ?? String(before)),
        after: formatNumber(placement.quantity) ?? String(placement.quantity),
      })}
    </li>
  );
}

/**
 * A reviewable proposal (getProposal). Nothing is applied automatically: apply and reject are
 * explicit, confirmed user actions. Apply re-reads the scenario for a fresh If-Match and sends the
 * proposal's base_revision_id; a 412 keeps the proposal on screen and offers to re-read.
 */
export function ProposalCard({ id }: { id: string }) {
  const { user, cityId } = useSession();
  const qc = useQueryClient();
  const proposal = useQuery({
    queryKey: ['proposal', id],
    staleTime: 0,
    queryFn: async ({ signal }) => (await unwrap<Proposal>(api.GET('/v1/proposals/{proposal_id}', { params: { path: { proposal_id: id } }, signal }))).data,
  });
  const p = proposal.data;
  const scenario = useScenarioById(p?.scenario_id ?? null);
  const appliedRevisions = useQuery({
    queryKey: ['assistant-proposal-revisions', p?.scenario_id ?? ''],
    enabled: p?.status === 'applied',
    queryFn: async ({ signal }) => (
      await unwrap<ScenarioRevisionPage>(
        api.GET('/v1/scenarios/{scenario_id}/revisions', { params: { path: { scenario_id: p!.scenario_id }, query: { limit: 200 } }, signal }),
      )
    ).data.items,
  });
  const [step, setStep] = useState<'idle' | 'apply' | 'reject'>('idle');
  const [reason, setReason] = useState('');
  const [applied, setApplied] = useState<ScenarioRevision | null>(null);
  const applyKey = useRef<string | null>(null);
  const rejectKey = useRef<string | null>(null);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['proposal', id] }),
      p ? qc.invalidateQueries({ queryKey: zk.scenario(p.scenario_id) }) : null,
      p ? qc.invalidateQueries({ queryKey: zk.revisions(p.scenario_id) }) : null,
    ]);
  const apply = useMutation({
    mutationFn: async () => {
      const fresh = await qc.fetchQuery({
        queryKey: zk.scenario(p!.scenario_id),
        staleTime: 0,
        queryFn: ({ signal }) => unwrap<Scenario>(api.GET('/v1/scenarios/{scenario_id}', { params: { path: { scenario_id: p!.scenario_id } }, signal })),
      });
      if (!fresh.etag) throw new ApiError('invalid', null, null, 'ETag missing');
      applyKey.current ??= newIdempotencyKey();
      return (
        await unwrap<ScenarioRevision>(
          api.POST('/v1/proposals/{proposal_id}/apply', {
            params: { path: { proposal_id: id }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': applyKey.current, 'If-Match': fresh.etag } },
            body: { base_revision_id: p!.base_revision_id },
          }),
        )
      ).data;
    },
    onSuccess: (revision) => {
      applyKey.current = null;
      setApplied(revision);
      setStep('idle');
      void refresh();
    },
    onError: (error) => {
      // A decided conflict is final for this attempt; a network failure may be replayed as is.
      if (error instanceof ApiError && !error.retryable) applyKey.current = null;
      if (error instanceof ApiError && error.category === 'revision_conflict') setStep('idle');
    },
  });
  const reject = useMutation({
    mutationFn: async () => {
      rejectKey.current ??= newIdempotencyKey();
      return (
        await unwrap<Proposal>(
          api.POST('/v1/proposals/{proposal_id}/reject', {
            params: { path: { proposal_id: id }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': rejectKey.current } },
            body: { reason: reason.trim() },
          }),
        )
      ).data;
    },
    onSuccess: (value) => {
      rejectKey.current = null;
      qc.setQueryData(['proposal', id], value);
      setStep('idle');
    },
    onError: (error) => {
      if (error instanceof ApiError && !error.retryable) rejectKey.current = null;
    },
  });

  if (proposal.isPending) return <Skeleton lines={2} />;
  if (proposal.isError) return <ApiErrorView compact error={proposal.error} onRetry={() => void proposal.refetch()} />;
  const value = proposal.data;
  const current = scenario.data?.data.current_revision_id ?? null;
  const appliedRevision = applied ?? appliedRevisions.data?.find((revision) => revision.parent_revision_id === value.base_revision_id) ?? null;
  const conflict = apply.error instanceof ApiError && apply.error.category === 'revision_conflict' ? apply.error : null;
  const conflictCurrent = conflict?.problem?.current_revision_id ?? current;
  const projectLink = (revisionId: string) => `/projects/${value.scenario_id}?${new URLSearchParams({ ...(cityId ? { city: cityId } : {}), revision: revisionId })}`;
  return (
    <section className="asst-proposal" aria-label={t('assistant.proposal')} data-proposal-id={value.id} data-proposal-status={value.status}>
      <header className="asst-proposal__head">
        <strong>{t('assistant.proposal')}</strong>
        <Badge tone={PROPOSAL_TONE[value.status]}>{t(`assistant.proposal.status.${value.status}`)}</Badge>
      </header>
      <p>{productLabel(value.summary)}</p>
      <ProposalChanges proposal={value} />
      <dl className="pg-dl">
        <dt>{t('assistant.proposal.base')}</dt>
        <dd>{t('assistant.proposal.base.current')}</dd>
        <dt>{t('assistant.proposal.expires')}</dt>
        <dd>{formatDateTime(value.expires_at)}</dd>
      </dl>
      {value.status === 'pending' && current && current !== value.base_revision_id && !conflict ? (
        <Notice tone="warning" title={t('assistant.proposal.outdated')}>
          {t('assistant.proposal.outdated.desc', { current: short(current) })}
        </Notice>
      ) : null}
      {applied ? (
        <Notice tone="info" title={t('assistant.proposal.applied')}>
          <Link to={projectLink(applied.id)} data-applied-revision={applied.id}>
            {t('assistant.proposal.openRevision', { revision: short(applied.id) })}
          </Link>
        </Notice>
      ) : null}
      {appliedRevision ? <ProposalOutcome scenarioId={value.scenario_id} baseRevisionId={value.base_revision_id} appliedRevisionId={appliedRevision.id} /> : null}
      {conflict ? (
        <div data-conflict="true">
        <Notice tone="warning" title={t('assistant.proposal.conflict')}>
          <p>{t('assistant.proposal.conflict.desc')}</p>
          <div className="asst-actions">
            <Button
              size="sm"
              icon="refresh"
              onClick={() => {
                apply.reset();
                void refresh();
              }}
            >
              {t('assistant.proposal.reread')}
            </Button>
            {conflictCurrent ? <Link to={projectLink(conflictCurrent)}>{t('assistant.proposal.openCurrent', { revision: short(conflictCurrent) })}</Link> : null}
          </div>
        </Notice>
        </div>
      ) : apply.isError ? (
        <ApiErrorView compact error={apply.error} onRetry={() => apply.mutate()} />
      ) : null}
      {value.status === 'pending' && !applied ? (
        step === 'apply' ? (
          <div className="asst-confirm" role="group" aria-label={t('assistant.proposal.apply')}>
            <p>{t('assistant.proposal.apply.confirm', { base: short(value.base_revision_id) })}</p>
            <div className="asst-actions">
              <Button size="sm" variant="primary" busy={apply.isPending} onClick={() => apply.mutate()}>
                {t('assistant.proposal.apply.do')}
              </Button>
              <Button size="sm" onClick={() => setStep('idle')}>
                {t('assistant.cancelAction')}
              </Button>
            </div>
          </div>
        ) : step === 'reject' ? (
          <div className="asst-confirm" role="group" aria-label={t('assistant.proposal.reject')}>
            <Field label={t('assistant.proposal.reason')} required>
              {({ id: fieldId, describedBy }) => (
                <textarea id={fieldId} className="pg-input" rows={2} aria-describedby={describedBy} value={reason} onChange={(e) => setReason(e.target.value)} />
              )}
            </Field>
            <div className="asst-actions">
              <Button size="sm" variant="danger" busy={reject.isPending} disabled={!reason.trim()} onClick={() => reject.mutate()}>
                {t('assistant.proposal.reject.do')}
              </Button>
              <Button size="sm" onClick={() => setStep('idle')}>
                {t('assistant.cancelAction')}
              </Button>
            </div>
            {reject.isError ? <ApiErrorView compact error={reject.error} onRetry={() => reject.mutate()} /> : null}
          </div>
        ) : (
          <div className="asst-actions">
            <Button size="sm" variant="primary" onClick={() => setStep('apply')}>
              {t('assistant.proposal.apply')}
            </Button>
            <Button size="sm" onClick={() => setStep('reject')}>
              {t('assistant.proposal.reject')}
            </Button>
          </div>
        )
      ) : null}
    </section>
  );
}

function MessageView({ message, onRetry, retryBusy }: { message: ChatMessage; onRetry?: () => void; retryBusy?: boolean }) {
  const mine = message.role === 'user';
  return (
    <li className={mine ? 'asst-msg is-user' : 'asst-msg is-assistant'} data-message-id={message.id} data-state={message.state} data-role={message.role}>
      <div className="asst-msg__meta">
        <span>{mine ? t('assistant.you') : t('assistant.title')}</span>
        {!mine && message.state !== 'completed' ? <Badge tone={STATE_TONE[message.state]}>{t(`assistant.state.${message.state}`)}</Badge> : null}
        <time className="pg-muted" dateTime={message.created_at}>
          {formatDateTime(message.created_at)}
        </time>
      </div>
      {message.text ? <RichMessageText text={message.text} /> : PENDING.includes(message.state) ? <Skeleton lines={1} /> : null}
      {message.facts.length ? (
        <div className="asst-facts" aria-label={t('assistant.facts')}>
          <p className="asst-facts__title">{t('assistant.facts')}</p>
          {message.facts.map((f) => (
            <div key={f.id} data-fact-key={f.metric.key} data-fact-value={f.metric.value ?? ''}>
              <MetricValue label={f.label} metric={f.metric} detailed={false} />
            </div>
          ))}
        </div>
      ) : null}
      {message.proposal_id ? <ProposalCard id={message.proposal_id} /> : null}
      {onRetry ? (
        <Button size="sm" icon="refresh" busy={retryBusy} onClick={onRetry}>
          {t('assistant.retry')}
        </Button>
      ) : null}
    </li>
  );
}

function inlineMessage(text: string, line: number) {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => (
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={`${line}-${index}`}>{part.slice(2, -2)}</strong>
      : <span key={`${line}-${index}`}>{part}</span>
  ));
}

/** A tiny safe renderer for the provider's headings and lists; no raw HTML is accepted. */
function RichMessageText({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: ReactElement[] = [];
  for (let index = 0; index < lines.length;) {
    const value = lines[index]!.trim();
    if (!value) { index += 1; continue; }
    if (/^[-•]\s+/.test(value)) {
      const items: { value: string; line: number }[] = [];
      while (index < lines.length && /^[-•]\s+/.test(lines[index]!.trim())) {
        items.push({ value: lines[index]!.trim().replace(/^[-•]\s+/, ''), line: index });
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`}>{items.map((item) => <li key={item.line}>{inlineMessage(item.value, item.line)}</li>)}</ul>);
      continue;
    }
    blocks.push(<p key={`line-${index}`}>{inlineMessage(value, index)}</p>);
    index += 1;
  }
  return <div className="asst-msg__text">{blocks}</div>;
}

/** One chat session: durable messages, the pending answer's job, cancel and retry. */
function Conversation({ sessionId }: { sessionId: string }) {
  const { user } = useSession();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const setUrl = useSetUrl();
  const jobId = isUuid(params.get(CHAT_JOB)) ? params.get(CHAT_JOB) : null;
  const job = useJob(jobId);
  const terminal = job.data ? TERMINAL_JOB_STATES.includes(job.data.state) : false;
  const messages = useChatMessages(sessionId, !jobId || terminal);
  const [draft, setDraft] = useState('');
  const sendKey = useRef<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!job.data) return;
    void qc.invalidateQueries({ queryKey: ['chat-messages', sessionId] });
    // A finished answer is read from the messages; failures stay visible until a retry.
    if (job.data.state === 'succeeded') setUrl({ [CHAT_JOB]: null });
  }, [job.data?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
  }, [messages.data?.length]);

  const send = useMutation({
    mutationFn: async (text: string) => {
      sendKey.current ??= newIdempotencyKey();
      return (
        await unwrap<Job>(
          api.POST('/v1/chat/sessions/{session_id}/messages', {
            params: { path: { session_id: sessionId }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': sendKey.current } },
            body: { text, scenario_revision_id: null },
          }),
        )
      ).data;
    },
    onSuccess: (j, text) => {
      sendKey.current = null;
      if (draft.trim() === text) setDraft('');
      qc.setQueryData(['job', j.id], j);
      setUrl({ [CHAT_JOB]: j.id });
      void qc.invalidateQueries({ queryKey: ['chat-messages', sessionId] });
    },
    onError: (error) => {
      // Network failures replay with the same key; a decided rejection starts over.
      if (error instanceof ApiError && !error.retryable) sendKey.current = null;
    },
  });
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await unwrap<Job>(
          api.POST('/v1/jobs/{job_id}/cancel', {
            params: { path: { job_id: jobId! }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } },
            body: { reason: t('assistant.cancel.reason') },
          }),
        )
      ).data,
    onSuccess: (j) => {
      qc.setQueryData(['job', j.id], j);
      void qc.invalidateQueries({ queryKey: ['chat-messages', sessionId] });
    },
  });
  const resend = (text: string) => {
    sendKey.current = null;
    send.mutate(text);
  };

  if (messages.isPending) return <Skeleton lines={3} />;
  if (messages.isError) {
    if (messages.error instanceof ApiError && messages.error.category === 'not_found') {
      return (
        <StateView
          compact
          state="not_found"
          title={t('assistant.notFound')}
          description={t('assistant.notFound.desc')}
          actions={<Button size="sm" onClick={() => setUrl({ [CHAT]: null, [CHAT_JOB]: null })}>{t('assistant.new')}</Button>}
        />
      );
    }
    return <ApiErrorView compact error={messages.error} onRetry={() => void messages.refetch()} />;
  }
  const items = messages.data;
  const busy = items.some((m) => PENDING.includes(m.state)) || (job.data ? !terminal : false);
  const previousUserText = (index: number) => [...items.slice(0, index)].reverse().find((m) => m.role === 'user')?.text ?? null;
  const submit = () => {
    const text = draft.trim();
    if (text && !busy) send.mutate(text);
  };
  return (
    <div className="asst-conversation" data-chat-session={sessionId} data-chat-busy={busy ? 'true' : 'false'}>
      {items.length ? (
        <ol className="asst-messages" ref={listRef} aria-live="polite">
          {items.map((m, i) => {
            const retryText = m.role === 'assistant' && (m.state === 'failed' || m.state === 'cancelled') && i === items.length - 1 ? previousUserText(i) : null;
            return <MessageView key={m.id} message={m} onRetry={retryText && !busy ? () => resend(retryText) : undefined} retryBusy={send.isPending} />;
          })}
        </ol>
      ) : (
        <section className="asst-empty">
          <span className="asst-empty__icon"><Icon name="chat" size={23} /></span>
          <div><strong>С чего начать</strong><p>{t('assistant.empty')} Выберите готовый вопрос или сформулируйте свой.</p></div>
          <div className="asst-prompts">
            {QUICK_PROMPTS.map((prompt) => <button key={prompt} type="button" onClick={() => setDraft(prompt)}>{prompt}</button>)}
          </div>
        </section>
      )}
      {job.data && (!terminal || job.data.state !== 'succeeded') ? (
        <div data-chat-job={job.data.id} data-job-state={job.data.state} data-job-transport={job.transport}>
          <JobStatus job={job.data} onCancel={terminal ? undefined : () => cancel.mutate()} />
        </div>
      ) : null}
      {cancel.isError ? <ApiErrorView compact error={cancel.error} onRetry={() => cancel.mutate()} /> : null}
      <form
        className="asst-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t('assistant.input')} hint={busy ? t('assistant.input.busy') : t('assistant.input.hint')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              className="pg-input"
              rows={3}
              maxLength={10000}
              aria-describedby={describedBy}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                sendKey.current = null;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" icon="chat" busy={send.isPending} disabled={!draft.trim() || busy}>
          {t('assistant.send')}
        </Button>
      </form>
      {send.isError ? <ApiErrorView compact error={send.error} onRetry={() => send.mutate(draft.trim() || previousUserText(items.length) || '')} /> : null}
    </div>
  );
}

/** Assistant panel body: a session from the URL, or a new one bound to the open page. */
export function Assistant() {
  const { hasRole } = useSession();
  const [params] = useSearchParams();
  const setUrl = useSetUrl();
  const createOk = useOperationAvailable('createChatSession');
  const sessionId = isUuid(params.get(CHAT)) ? params.get(CHAT)! : null;
  if (!hasRole('specialist')) return <Notice tone="neutral" title={t('assistant.specialistOnly')}>{t('assistant.specialistOnly.desc')}</Notice>;
  if (createOk === false) return <OperationUnavailable operationId="createChatSession" compact />;
  return (
    <div className="asst">
      <p className="pg-muted asst-hint">{t('assistant.factsHint')}</p>
      {sessionId ? (
        <>
          <div className="asst-session">
            <SessionBinding session={rememberedSession(sessionId)} />
            <Button size="sm" onClick={() => setUrl({ [CHAT]: null, [CHAT_JOB]: null })}>
              {t('assistant.new')}
            </Button>
          </div>
          <Conversation key={sessionId} sessionId={sessionId} />
        </>
      ) : (
        <NewSession />
      )}
    </div>
  );
}
