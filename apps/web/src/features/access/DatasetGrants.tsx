import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, newIdempotencyKey, problemCodeEntry, unwrap, type AuditEvent, type DatasetGrant, type UserSummary } from '@pg/api-client';
import { Badge, Button, Dialog, Field, formatDateTime, Notice, Select, Skeleton, StateView } from '@pg/ui';
import { api, useOperationAvailable, type Page } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';

const PAGE = 200;
/** Bound on automatic paging; a longer list says it is incomplete instead of looping forever. */
const MAX_PAGES = 25;

/** Reads every page of a small administrative list (city users, grants of one dataset). */
async function allPages<T>(load: (cursor: string | undefined) => Promise<Page<T>>): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await load(cursor);
    items.push(...page.items);
    if (!page.next_cursor) return { items, complete: true };
    cursor = page.next_cursor;
  }
  return { items, complete: false };
}

export const grantKeys = {
  principals: (cityId: string) => ['city-principals', cityId] as const,
  grants: (datasetId: string) => ['dataset-grants', datasetId] as const,
  history: (datasetId: string) => ['dataset-grant-history', datasetId] as const,
};

/** Active users explicitly assigned to the city (listCityPrincipals, admin). */
export function useCityPrincipals(cityId: string) {
  const available = useOperationAvailable('listCityPrincipals');
  const query = useQuery({
    queryKey: grantKeys.principals(cityId),
    enabled: available !== false,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      allPages<UserSummary>(
        async (cursor) =>
          (await unwrap(api.GET('/v1/cities/{city_id}/principals', { params: { path: { city_id: cityId }, query: { cursor, limit: PAGE } }, signal })))
            .data,
      ),
  });
  return { available, query };
}

const ROLE_KEY: Record<UserSummary['roles'][number], AppKey> = { admin: 'grants.role.admin', specialist: 'grants.role.specialist', viewer: 'grants.role.viewer' };

export function RoleBadges({ roles }: { roles: UserSummary['roles'] }) {
  return (
    <span className="pg-flags">
      {roles.map((r) => (
        <Badge key={r} tone={r === 'admin' ? 'accent' : 'neutral'}>
          {t(ROLE_KEY[r])}
        </Badge>
      ))}
    </span>
  );
}

const codeOf = (e: unknown) => (e instanceof ApiError ? (e.problem?.code ?? null) : null);
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null);

/**
 * Explicit content access to one restricted dataset. City admin rights allow managing these
 * grants; they never imply access to the dataset's content, and the panel says so.
 */
export function DatasetGrantsPanel({ datasetId, cityId, datasetName }: { datasetId: string; cityId: string; datasetName: string | null }) {
  const { user, hasRole } = useSession();
  const listOk = useOperationAvailable('listDatasetGrants');
  const grantOk = useOperationAvailable('grantDatasetAccess');
  const revokeOk = useOperationAvailable('revokeDatasetAccess');
  const qc = useQueryClient();
  const principals = useCityPrincipals(cityId);
  const grants = useQuery({
    queryKey: grantKeys.grants(datasetId),
    enabled: listOk !== false && hasRole('admin'),
    retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status !== null && e.status < 500),
    queryFn: ({ signal }) =>
      allPages<DatasetGrant>(
        async (cursor) =>
          (await unwrap(api.GET('/v1/datasets/{dataset_id}/grants', { params: { path: { dataset_id: datasetId }, query: { cursor, limit: PAGE } }, signal })))
            .data,
      ),
  });
  const people = useMemo(() => new Map((principals.query.data?.items ?? []).map((p) => [p.id, p])), [principals.query.data]);
  const granted = useMemo(() => new Set((grants.data?.items ?? []).map((g) => g.user_id)), [grants.data]);

  const [notice, setNotice] = useState<{ tone: 'info' | 'warning'; title: string; text?: string } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: grantKeys.grants(datasetId) });
    void qc.invalidateQueries({ queryKey: grantKeys.history(datasetId) });
    void qc.invalidateQueries({ queryKey: ['list', 'audit'] });
    // Own grants change which restricted datasets (and names) the admin can read.
    void qc.invalidateQueries({ queryKey: ['restricted-datasets'] });
    void qc.invalidateQueries({ queryKey: ['list', 'datasets'] });
  };
  const nameOf = (id: string) => people.get(id)?.display_name ?? t('grants.user.unknown', { id: id.slice(0, 8) });

  if (!hasRole('admin')) {
    return <StateView compact state="forbidden" title={t('grants.forbidden')} description={t('grants.forbidden.desc')} />;
  }
  if (listOk === false) return <OperationUnavailable compact operationId="listDatasetGrants" />;

  const mine = user ? granted.has(user.id) : false;
  return (
    <section className="acc-panel" aria-labelledby={`acc-h-${datasetId}`}>
      <h3 id={`acc-h-${datasetId}`}>{t('grants.title')}</h3>
      <p className="pg-muted">
        {datasetName ?? t('grants.dataset.hidden')} · <code className="pg-code" title={datasetId}>{datasetId.slice(0, 8)}</code>
      </p>
      <Notice tone="info" icon="lock" title={t('grants.policy')}>
        {t('grants.policy.desc')}
      </Notice>
      {grants.isPending ? (
        <Skeleton lines={3} />
      ) : grants.isError ? (
        codeOf(grants.error) === 'grant_not_applicable' ? (
          <Notice tone="neutral" icon="slash" title={t('grants.notRestricted')}>
            {t('grants.notRestricted.desc')}
          </Notice>
        ) : statusOf(grants.error) === 404 ? (
          <StateView compact state="not_found" title={t('grants.notFound')} description={t('grants.notFound.desc')} />
        ) : (
          <ApiErrorView compact error={grants.error} onRetry={() => void grants.refetch()} />
        )
      ) : (
        <>
          <p className="acc-self" role="status">
            <Badge tone={mine ? 'positive' : 'neutral'} icon={mine ? 'check' : 'shield'}>
              {mine ? t('grants.self.granted') : t('grants.self.adminOnly')}
            </Badge>{' '}
            {mine ? t('grants.self.granted.desc') : t('grants.self.adminOnly.desc')}
          </p>
          {notice ? (
            <Notice tone={notice.tone} title={notice.title} actions={<Button size="sm" variant="ghost" onClick={() => setNotice(null)}>{t('grants.notice.close')}</Button>}>
              {notice.text}
            </Notice>
          ) : null}
          {principals.query.isError ? <ApiErrorView compact error={principals.query.error} onRetry={() => void principals.query.refetch()} /> : null}
          {grants.data.items.length === 0 ? (
            <StateView compact state="empty" title={t('grants.empty')} description={t('grants.empty.desc')} />
          ) : (
            <table className="acc-table">
              <caption className="pg-sr-only">{t('grants.list')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('grants.col.user')}</th>
                  <th scope="col">{t('grants.col.roles')}</th>
                  <th scope="col">
                    <span className="pg-sr-only">{t('grants.col.action')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {grants.data.items.map((g) => {
                  const p = people.get(g.user_id);
                  return (
                    <tr key={g.user_id}>
                      <td>
                        {p ? p.display_name : <span className="pg-unknown">{t('grants.user.unknown', { id: g.user_id.slice(0, 8) })}</span>}
                        {user?.id === g.user_id ? <> · {t('grants.you')}</> : null}
                      </td>
                      <td>{p ? <RoleBadges roles={p.roles} /> : <span className="pg-muted">{t('grants.user.notInCity')}</span>}</td>
                      <td className="acc-table__act">
                        {revokeOk === false ? null : (
                          <RevokeGrant
                            datasetId={datasetId}
                            datasetName={datasetName}
                            userId={g.user_id}
                            userName={nameOf(g.user_id)}
                            onDone={(n) => {
                              setNotice(n);
                              refresh();
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {grants.data.complete ? null : <p className="pg-muted">{t('grants.incomplete', { n: grants.data.items.length })}</p>}
          {grantOk === false ? (
            <OperationUnavailable compact operationId="grantDatasetAccess" />
          ) : (
            <GrantForm
              datasetId={datasetId}
              datasetName={datasetName}
              candidates={(principals.query.data?.items ?? []).filter((p) => !granted.has(p.id))}
              loading={principals.query.isPending}
              principalsOk={principals.available}
              onDone={(n) => {
                setNotice(n);
                refresh();
              }}
            />
          )}
          <GrantHistory datasetId={datasetId} nameOf={nameOf} />
        </>
      )}
    </section>
  );
}

type Outcome = { tone: 'info' | 'warning'; title: string; text?: string };

function GrantForm({
  datasetId,
  datasetName,
  candidates,
  loading,
  principalsOk,
  onDone,
}: {
  datasetId: string;
  datasetName: string | null;
  candidates: UserSummary[];
  loading: boolean;
  principalsOk: boolean | null;
  onDone: (n: Outcome) => void;
}) {
  const { user } = useSession();
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  // One key per confirmed intent: a retry after a network failure cannot create a second event.
  const [key, setKey] = useState(newIdempotencyKey);
  const target = candidates.find((c) => c.id === userId) ?? null;
  const grant = useMutation({
    mutationFn: async () =>
      (
        await unwrap(
          api.POST('/v1/datasets/{dataset_id}/grants', {
            params: { path: { dataset_id: datasetId }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': key } },
            body: { user_id: userId, reason: reason.trim() },
          }),
        )
      ).data,
    onSuccess: () => {
      setConfirm(false);
      onDone({ tone: 'info', title: t('grants.granted', { name: target?.display_name ?? userId.slice(0, 8) }), text: t('grants.audited') });
      setUserId('');
      setReason('');
    },
    onError: (e) => {
      if (codeOf(e) === 'grant_exists') {
        setConfirm(false);
        onDone({ tone: 'warning', title: t('grants.exists'), text: t('grants.exists.desc') });
        setUserId('');
      }
    },
  });
  const reasonError = reason.length > 0 && reason.trim().length === 0 ? t('grants.reason.required') : null;
  const err = grant.isError && codeOf(grant.error) !== 'grant_exists' ? grant.error : null;
  const errCode = codeOf(err);
  return (
    <form
      className="acc-form"
      aria-labelledby={`acc-grant-${datasetId}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!userId || !reason.trim()) return;
        setKey(newIdempotencyKey());
        grant.reset();
        setConfirm(true);
      }}
    >
      <h4 id={`acc-grant-${datasetId}`}>{t('grants.add')}</h4>
      {principalsOk === false ? (
        <OperationUnavailable compact operationId="listCityPrincipals" />
      ) : (
        <Field label={t('grants.field.user')} hint={t('grants.field.user.hint')} required>
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} value={userId} disabled={loading} onChange={(e) => setUserId(e.target.value)}>
              <option value="">{loading ? t('grants.field.user.loading') : candidates.length ? t('grants.field.user.choose') : t('grants.field.user.none')}</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name} — {c.roles.map((r) => t(ROLE_KEY[r])).join(', ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field label={t('grants.field.reason')} hint={t('grants.field.reason.hint')} required error={reasonError}>
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            className="pg-input acc-reason"
            rows={2}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" variant="primary" icon="plus" disabled={!userId || !reason.trim()}>
        {t('grants.add.submit')}
      </Button>
      <Dialog
        open={confirm}
        title={t('grants.confirm.title')}
        onClose={() => setConfirm(false)}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>{t('grants.cancel')}</Button>
            <Button variant="primary" busy={grant.isPending} onClick={() => grant.mutate()}>
              {t('grants.confirm.grant')}
            </Button>
          </>
        }
      >
        <dl className="pg-dl">
          <dt>{t('grants.confirm.user')}</dt>
          <dd>{target?.display_name ?? '—'}</dd>
          <dt>{t('grants.confirm.dataset')}</dt>
          <dd>{datasetName ?? <code className="pg-code">{datasetId.slice(0, 8)}</code>}</dd>
          <dt>{t('grants.field.reason')}</dt>
          <dd className="acc-quote">{reason.trim()}</dd>
        </dl>
        <p>{t('grants.confirm.grant.desc')}</p>
        {err ? (
          errCode === 'grant_city_mismatch' || errCode === 'grant_not_applicable' ? (
            <Notice tone="negative" title={problemCodeEntry(errCode)?.title_ru ?? errCode}>
              {t(errCode === 'grant_city_mismatch' ? 'grants.cityMismatch.desc' : 'grants.notRestricted.desc')}
            </Notice>
          ) : (
            <ApiErrorView compact error={err} />
          )
        ) : null}
      </Dialog>
    </form>
  );
}

function RevokeGrant({
  datasetId,
  datasetName,
  userId,
  userName,
  onDone,
}: {
  datasetId: string;
  datasetName: string | null;
  userId: string;
  userName: string;
  onDone: (n: Outcome) => void;
}) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const revoke = useMutation({
    mutationFn: async () =>
      (
        await unwrap(
          api.DELETE('/v1/datasets/{dataset_id}/grants/{user_id}', {
            params: { path: { dataset_id: datasetId, user_id: userId }, header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': key } },
            body: { reason: reason.trim() },
          }),
        )
      ).data,
    onSuccess: () => {
      setOpen(false);
      onDone({ tone: 'info', title: t('grants.revoked', { name: userName }), text: t('grants.audited') });
    },
    onError: (e) => {
      // The grant is already gone (another admin revoked it): nothing to undo, refresh the list.
      if (statusOf(e) === 404) {
        setOpen(false);
        onDone({ tone: 'warning', title: t('grants.gone'), text: t('grants.gone.desc') });
      }
    },
  });
  const self = user?.id === userId;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon="x"
        aria-label={t('grants.revoke.label', { name: userName })}
        onClick={() => {
          setKey(newIdempotencyKey());
          setReason('');
          revoke.reset();
          setOpen(true);
        }}
      >
        {t('grants.revoke')}
      </Button>
      <Dialog
        open={open}
        title={t('grants.revoke.title')}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('grants.cancel')}</Button>
            <Button variant="danger" busy={revoke.isPending} disabled={!reason.trim()} onClick={() => revoke.mutate()}>
              {t('grants.revoke.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('grants.revoke.desc', { name: userName, dataset: datasetName ?? datasetId.slice(0, 8) })}</p>
        {self ? (
          <Notice tone="warning" title={t('grants.revoke.self')}>
            {t('grants.revoke.self.desc')}
          </Notice>
        ) : null}
        <Field label={t('grants.field.reason')} hint={t('grants.field.reason.hint')} required>
          {({ id, describedBy }) => (
            <textarea id={id} className="pg-input acc-reason" rows={2} aria-describedby={describedBy} value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
        </Field>
        {revoke.isError && statusOf(revoke.error) !== 404 ? <ApiErrorView compact error={revoke.error} /> : null}
      </Dialog>
    </>
  );
}

const HISTORY_ACTIONS = new Set(['dataset.grant_added', 'dataset.grant_revoked']);

/**
 * Grant decisions of this dataset from the audit log. The log has no server-side filter, so pages
 * are read in the server's order and filtered here for display only; the panel states how much of
 * the log it has read.
 */
function GrantHistory({ datasetId, nameOf }: { datasetId: string; nameOf: (id: string) => string }) {
  const available = useOperationAvailable('listAuditEvents');
  const log = useInfiniteQuery({
    queryKey: grantKeys.history(datasetId),
    enabled: available !== false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page<AuditEvent>) => last.next_cursor ?? undefined,
    queryFn: async ({ pageParam, signal }) =>
      (await unwrap(api.GET('/v1/audit', { params: { query: { cursor: pageParam, limit: PAGE } }, signal }))).data,
  });
  const read = log.data?.pages.reduce((n, p) => n + p.items.length, 0) ?? 0;
  const events = (log.data?.pages.flatMap((p) => p.items) ?? [])
    .filter((e) => e.object_id === datasetId && HISTORY_ACTIONS.has(e.action))
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  return (
    <details className="acc-history" open>
      <summary>{t('grants.history')}</summary>
      {available === false ? (
        <OperationUnavailable compact operationId="listAuditEvents" />
      ) : log.isPending ? (
        <Skeleton lines={2} />
      ) : log.isError ? (
        <ApiErrorView compact error={log.error} onRetry={() => void log.refetch()} />
      ) : (
        <>
          {events.length === 0 ? (
            <p className="pg-muted">{t('grants.history.empty')}</p>
          ) : (
            <ol className="acc-history__list">
              {events.map((e) => (
                <li key={e.id}>
                  <Badge tone={e.action === 'dataset.grant_added' ? 'positive' : 'neutral'}>
                    {t(e.action === 'dataset.grant_added' ? 'grants.history.added' : 'grants.history.revoked')}
                  </Badge>{' '}
                  <time dateTime={e.occurred_at}>{formatDateTime(e.occurred_at)}</time> · {t('grants.history.by', { name: nameOf(e.actor_id) })}
                  {e.reason ? <span className="acc-quote"> — «{e.reason}»</span> : null}
                </li>
              ))}
            </ol>
          )}
          {events.length ? <p className="pg-muted">{t('grants.history.noSubject')}</p> : null}
          <p className="pg-muted">
            {log.hasNextPage ? t('grants.history.partial', { n: read }) : t('grants.history.complete', { n: read })}{' '}
            {log.hasNextPage ? (
              <Button size="sm" variant="ghost" busy={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                {t('grants.history.more')}
              </Button>
            ) : null}
          </p>
        </>
      )}
    </details>
  );
}
