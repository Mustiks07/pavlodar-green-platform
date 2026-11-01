import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { City, User } from '@pg/api-client';
import { ApiError, toApiError } from '@pg/api-client';
import { REQUEST_TIMEOUT_MS, useCities, useMe } from '../api';

const RETURN_KEY = 'pg.auth.returnTo';

/**
 * Login keeps the deep link: the current path+query is stored before the BFF redirect
 * and restored after the session is established (TZ §03). Server still checks rights.
 *
 * The BFF answers /auth/login with a 302 to the identity provider, or with
 * problem+json (e.g. 503 oidc_unavailable). A manual-redirect probe lets the UI show
 * that problem in place instead of navigating the user onto a raw JSON error page.
 */
export async function beginLogin(): Promise<ApiError | null> {
  try {
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ path: window.location.pathname + window.location.search, at: Date.now() }));
  } catch {
    /* without storage the user returns to the start page */
  }
  let res: Response;
  try {
    res = await fetch('/auth/login', { redirect: 'manual', credentials: 'same-origin', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    return new ApiError(err instanceof DOMException && err.name === 'TimeoutError' ? 'timeout' : 'network', null, null);
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    window.location.assign('/auth/login');
    return null;
  }
  const body: unknown = await res.json().catch(() => null);
  return toApiError(res.status, body);
}

const RETURN_TTL_MS = 10 * 60_000;

/**
 * The BFF callback lands on "/". Only that landing is redirected to the stored deep link;
 * a later explicit navigation (a shared link, a bookmark) is never overridden.
 */
function consumeReturnTo(): string | null {
  try {
    const raw = window.sessionStorage.getItem(RETURN_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
    if (!raw) return null;
    const { path, at } = JSON.parse(raw) as { path?: unknown; at?: unknown };
    const landedOnCallbackTarget = window.location.pathname === '/' && window.location.search === '';
    if (!landedOnCallbackTarget || typeof at !== 'number' || Date.now() - at > RETURN_TTL_MS) return null;
    return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : null;
  } catch {
    return null;
  }
}

export interface SessionValue {
  me: ReturnType<typeof useMe>;
  user: User | null;
  cities: ReturnType<typeof useCities>;
  cityId: string | null;
  city: City | null;
  setCityId: (id: string) => void;
  hasRole: (role: User['roles'][number]) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const user = me.data ?? null;
  const cities = useCities(Boolean(user));
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) return;
    const back = consumeReturnTo();
    if (back) navigate(back, { replace: true });
  }, [user, navigate]);

  const items = cities.data?.items ?? [];
  const requested = params.get('city');
  const city = items.find((c) => c.id === requested) ?? (items.length === 1 ? items[0]! : null);

  const setCityId = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('city', id);
    setParams(next);
  };

  const hasRole = (role: User['roles'][number]) => {
    if (!user) return false;
    if (user.roles.includes('admin')) return true;
    if (role === 'viewer') return user.roles.length > 0;
    return user.roles.includes(role);
  };

  return (
    <SessionContext.Provider value={{ me, user, cities, cityId: city?.id ?? null, city, setCityId, hasRole }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
