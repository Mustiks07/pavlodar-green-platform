import { ApiError, problemCodeEntry } from '@pg/api-client';
import { Button, DataGapList, StateView, tUi, type ViewState } from '@pg/ui';
import { REQUEST_TIMEOUT_MS } from '../api';
import { t } from '../i18n';
import { LoginButton } from './LoginButton';

/** Maps a typed API failure to the matching state view with a real next action. */
export function ApiErrorView({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const e = error instanceof ApiError ? error : new ApiError('server', null, null, String(error));
  const detail = e.problem?.detail ?? '';
  const retry = onRetry ? (
    <Button icon="refresh" onClick={onRetry}>
      {tUi('action.retry')}
    </Button>
  ) : null;

  let state: ViewState = 'error';
  let title: string | undefined;
  let description: string;
  let actions = retry;

  switch (e.category) {
    case 'unauthenticated':
      state = 'unauthenticated';
      title = t('auth.title');
      description = t('auth.desc');
      actions = <LoginButton />;
      break;
    case 'forbidden':
      state = 'forbidden';
      description = t('api.forbidden.desc');
      actions = null;
      break;
    case 'not_found':
      state = 'not_found';
      description = t('api.notFound.desc');
      actions = null;
      break;
    case 'revision_conflict':
      state = 'conflict';
      description = t('api.conflict.desc');
      break;
    case 'state_conflict':
      state = 'conflict';
      description = t('api.stateConflict.desc', { detail });
      break;
    case 'invalid':
      description = t('api.invalid.desc', { detail: detail || e.message });
      break;
    case 'rate_limited':
      title = t('api.rateLimited');
      description = t('api.rateLimited.desc');
      break;
    case 'unavailable':
      state = 'unavailable';
      title = t('api.unavailable.title');
      description = t('api.unavailable.desc');
      break;
    case 'timeout':
      state = 'timeout';
      description = t('api.timeout.desc', { seconds: REQUEST_TIMEOUT_MS / 1000 });
      break;
    case 'network':
      state = 'network';
      description = t('api.network.desc');
      break;
    default:
      description = t('api.server.desc');
  }

  const details =
    e.requestId || e.status || e.problem?.code ? (
      <>
        {e.status ? <>HTTP {e.status} · </> : null}
        {e.problem?.code ? <code className="pg-code">{e.problem.code}</code> : null}
        {e.requestId ? (
          <>
            {' '}
            · {tUi('state.requestId')}: <code className="pg-code">{e.requestId}</code>
          </>
        ) : null}
      </>
    ) : undefined;

  // Canonical Russian title for the server's code (contracts/problem_codes.json); the
  // category title is only the fallback for codes the registry does not list.
  const registered = e.problem ? problemCodeEntry(e.problem.code) : null;
  if (registered && e.category !== 'unauthenticated') title = registered.title_ru;
  const blockers = e.problem?.blockers ?? [];
  const fieldErrors = e.problem?.field_errors ?? [];
  const body =
    blockers.length || fieldErrors.length ? (
      <>
        <p>{description}</p>
        {blockers.length ? (
          <div className="app-blockers">
            <p className="app-blockers__title">{t('api.blockers')}</p>
            <DataGapList gaps={blockers} />
          </div>
        ) : null}
        {fieldErrors.length ? (
          <ul className="app-field-errors">
            {fieldErrors.map((f) => (
              <li key={`${f.path}:${f.code}`}>
                <code className="pg-code">{f.path}</code> {f.message}
              </li>
            ))}
          </ul>
        ) : null}
      </>
    ) : (
      description
    );

  return <StateView state={state} title={title} description={body} actions={actions} details={details} compact={compact} />;
}
