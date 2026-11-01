import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { tUi } from '../i18n';

/** Every significant feature state from TZ §22, plus transport failures. */
export type ViewState =
  | 'loading'
  | 'empty'
  | 'partial'
  | 'unavailable'
  | 'error'
  | 'stale'
  | 'forbidden'
  | 'conflict'
  | 'unauthenticated'
  | 'timeout'
  | 'network'
  | 'not_found';

const META: Record<Exclude<ViewState, 'loading'>, { icon: IconName; tone: string; title: string }> = {
  empty: { icon: 'inbox', tone: 'neutral', title: tUi('state.empty') },
  partial: { icon: 'alert', tone: 'warning', title: tUi('state.partial') },
  unavailable: { icon: 'slash', tone: 'neutral', title: tUi('state.unavailable') },
  error: { icon: 'error', tone: 'negative', title: tUi('state.error') },
  stale: { icon: 'clock', tone: 'warning', title: tUi('state.stale') },
  forbidden: { icon: 'lock', tone: 'neutral', title: tUi('state.forbidden') },
  conflict: { icon: 'conflict', tone: 'warning', title: tUi('state.conflict') },
  unauthenticated: { icon: 'login', tone: 'info', title: tUi('state.unauthenticated') },
  timeout: { icon: 'clock', tone: 'negative', title: tUi('state.timeout') },
  network: { icon: 'error', tone: 'negative', title: tUi('state.network') },
  not_found: { icon: 'slash', tone: 'neutral', title: tUi('state.notFound') },
};

export interface StateViewProps {
  state: ViewState;
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Technical details (request id, codes) behind a disclosure, not on the first screen. */
  details?: ReactNode;
  compact?: boolean;
  /** For loading: transport timeout, so the user knows the wait is bounded. */
  timeoutSeconds?: number;
}

export function StateView({ state, title, description, actions, details, compact, timeoutSeconds }: StateViewProps) {
  const cls = compact ? 'pg-state pg-state--compact' : 'pg-state';
  if (state === 'loading') {
    return (
      <div className={cls} role="status" aria-live="polite">
        <span className="pg-spinner pg-spinner--lg" aria-hidden />
        <p className="pg-state__title">{title ?? tUi('state.loading')}</p>
        <SlowHint timeoutSeconds={timeoutSeconds} />
      </div>
    );
  }
  const meta = META[state];
  const assertive = state === 'error' || state === 'network' || state === 'timeout' || state === 'conflict';
  return (
    <div className={`${cls} pg-state--${meta.tone}`} role={assertive ? 'alert' : 'status'}>
      <span className="pg-state__icon">
        <Icon name={meta.icon} size={compact ? 18 : 28} />
      </span>
      <p className="pg-state__title">{title ?? meta.title}</p>
      {description ? <div className="pg-state__desc">{description}</div> : null}
      {actions ? <div className="pg-state__actions">{actions}</div> : null}
      {details ? (
        <details className="pg-state__details">
          <summary>{tUi('state.details')}</summary>
          <div>{details}</div>
        </details>
      ) : null}
    </div>
  );
}

function SlowHint({ timeoutSeconds }: { timeoutSeconds: number | undefined }) {
  const [slow, setSlow] = useState(false);
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  useEffect(() => {
    const id = window.setTimeout(() => setSlow(true), 4000);
    const sync = () => setOffline(navigator.onLine === false);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);
  // Offline, a load waits for the network instead of failing: say so instead of spinning.
  if (offline) return <p className="pg-state__desc">{tUi('state.loading.offline')}</p>;
  if (!slow || !timeoutSeconds) return null;
  return <p className="pg-state__desc">{tUi('state.loading.slow', { seconds: timeoutSeconds })}</p>;
}

/** Placeholder geometry only. Never renders digits so it cannot be mistaken for data. */
export function Skeleton({ lines = 3, block = false }: { lines?: number; block?: boolean }) {
  return (
    <div className="pg-skeleton" aria-hidden>
      {block ? <div className="pg-skeleton__block" /> : null}
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="pg-skeleton__line" style={{ width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

/** Inline notice used inside cards: stale result, partial data, synthetic profile. */
export function Notice({
  tone,
  icon,
  title,
  children,
  actions,
}: {
  tone: 'info' | 'warning' | 'negative' | 'synthetic' | 'neutral';
  icon?: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const defaultIcon: Record<typeof tone, IconName> = {
    info: 'info',
    warning: 'alert',
    negative: 'error',
    synthetic: 'flask',
    neutral: 'info',
  };
  return (
    <div className={`pg-notice pg-notice--${tone}`} role={tone === 'negative' ? 'alert' : 'note'}>
      <Icon name={icon ?? defaultIcon[tone]} size={18} />
      <div className="pg-notice__body">
        <p className="pg-notice__title">{title}</p>
        {children ? <div className="pg-notice__text">{children}</div> : null}
        {actions ? <div className="pg-notice__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function SyntheticBanner() {
  return (
    <div className="pg-synthetic-banner" role="note">
      <Icon name="flask" size={14} /> {tUi('prov.synthetic.banner')}
    </div>
  );
}
