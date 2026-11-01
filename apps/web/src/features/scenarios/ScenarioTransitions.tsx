import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { newIdempotencyKey, unwrap, type Scenario } from '@pg/api-client';
import { Button, Dialog, Field, Input } from '@pg/ui';
import { api } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { useSession } from '../../shell/session';
import { zk } from '../zones/queries';

type Target = Scenario['status'];

/**
 * Offered transitions are a convenience; the server checks rights, critical data gaps and
 * the workflow and answers 409/422 with blockers, which are shown verbatim.
 */
const OFFERED: Record<Target, { target: Target; role: 'specialist' | 'admin' }[]> = {
  draft: [
    { target: 'in_review', role: 'specialist' },
    { target: 'archived', role: 'specialist' },
  ],
  in_review: [
    { target: 'approved', role: 'admin' },
    { target: 'draft', role: 'specialist' },
    { target: 'archived', role: 'specialist' },
  ],
  approved: [{ target: 'archived', role: 'admin' }],
  archived: [],
};

export function ScenarioTransitions({ scenario, etag }: { scenario: Scenario; etag: string | null }) {
  const { user, hasRole } = useSession();
  const qc = useQueryClient();
  const [target, setTarget] = useState<Target | null>(null);
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const run = useMutation({
    mutationFn: async () =>
      unwrap<Scenario>(
        api.POST('/v1/scenarios/{scenario_id}/transitions', {
          params: {
            path: { scenario_id: scenario.id },
            header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': key, 'If-Match': etag ?? '' },
          },
          body: { target_status: target!, reason: reason.trim(), revision_id: scenario.current_revision_id },
        }),
      ),
    onSuccess: () => {
      setTarget(null);
      void qc.invalidateQueries({ queryKey: zk.scenario(scenario.id) });
      void qc.invalidateQueries({ queryKey: ['list', 'scenarios'] });
    },
  });

  const options = OFFERED[scenario.status].filter((o) => hasRole(o.role));
  if (options.length === 0) {
    return <p className="pg-muted">{scenario.status === 'archived' ? t('transition.none.archived') : t('transition.none.role')}</p>;
  }
  return (
    <>
      <p className="pg-muted">{t('transition.hint')}</p>
      <div className="scn-actions">
        {options.map((o) => (
          <Button
            key={o.target}
            variant={o.target === 'archived' ? 'secondary' : 'primary'}
            onClick={() => {
              setTarget(o.target);
              setReason('');
              setKey(newIdempotencyKey());
              run.reset();
            }}
          >
            {t(`transition.to.${o.target}` as AppKey)}
          </Button>
        ))}
      </div>
      <Dialog
        open={target !== null}
        title={target ? t(`transition.to.${target}` as AppKey) : ''}
        onClose={() => setTarget(null)}
        footer={
          <>
            <Button onClick={() => setTarget(null)}>{t('action.cancel')}</Button>
            <Button variant="primary" busy={run.isPending} disabled={reason.trim().length < 3} onClick={() => run.mutate()}>
              {t('transition.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('transition.dialog.desc', { revision: scenario.current_revision_id.slice(0, 8) })}</p>
        <Field label={t('transition.reason')} required hint={t('transition.reason.hint')}>
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {run.isError ? <ApiErrorView compact error={run.error} /> : null}
      </Dialog>
    </>
  );
}
