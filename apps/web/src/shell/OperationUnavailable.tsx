import { StateView } from '@pg/ui';
import { t } from '../i18n';

/** Product-safe fallback; the technical operation id stays available for diagnostics. */
export function OperationUnavailable({ operationId, compact }: { operationId: string; compact?: boolean }) {
  return (
    <StateView
      compact={compact}
      state="unavailable"
      title={t('op.unavailable.title')}
      description={<>{t('op.unavailable.desc')} {t('op.unavailable.next')}<details><summary>Техническая информация</summary><code className="pg-code">{operationId}</code></details></>}
    />
  );
}
