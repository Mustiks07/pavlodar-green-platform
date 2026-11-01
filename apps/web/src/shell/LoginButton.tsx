import { useState } from 'react';
import type { ApiError } from '@pg/api-client';
import { Button, Notice, tUi } from '@pg/ui';
import { t } from '../i18n';
import { beginLogin } from './session';

export function LoginButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <>
      <Button
        variant="primary"
        icon="login"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const err = await beginLogin();
          // On success the page navigates away; keep busy until then.
          if (err) {
            setError(err);
            setBusy(false);
          }
        }}
      >
        {t('auth.login')}
      </Button>
      {error ? (
        <Notice tone="negative" title={t('auth.failed')}>
          {error.category === 'unavailable' ? t('auth.idpUnavailable') : (error.problem?.detail ?? error.message)}
          {error.requestId ? (
            <>
              {' '}
              · {tUi('state.requestId')}: <code className="pg-code">{error.requestId}</code>
            </>
          ) : null}
        </Notice>
      ) : null}
    </>
  );
}
