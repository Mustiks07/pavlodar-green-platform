import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, newIdempotencyKey, unwrap, type AddressResult } from '@pg/api-client';
import { Button, Icon, Select, SidePanel, type IconName } from '@pg/ui';
import { api, setCsrfToken, useHealth } from '../api';
import { t, type AppKey } from '../i18n';
import { NAV, type NavItem } from '../nav';
import { prefetchRoute } from '../routeLoaders';
import { useNetworkState } from './offline';
import { useSession } from './session';
import { useUi } from './ui-store';
import { Assistant, CHAT } from '../features/assistant/Assistant';
import { cityDisplayName } from '../city';
import { useZones } from '../features/zones/queries';
import { DemoTour } from './DemoTour';

const CONTRACT_VERSION = __CONTRACT_VERSION__;

function useCityQuery() {
  const [params] = useSearchParams();
  const city = params.get('city');
  return city ? `?city=${encodeURIComponent(city)}` : '';
}

function NavList({ onNavigate, collapsed }: { onNavigate?: () => void; collapsed: boolean }) {
  const q = useCityQuery();
  const { hasRole } = useSession();
  const visible = NAV.filter((item) => item.sidebar !== false && (!item.requiredRole || hasRole(item.requiredRole)));
  const groups = visible.reduce<Record<string, NavItem[]>>((acc, item) => {
    (acc[item.group] ??= []).push(item);
    return acc;
  }, {});
  return (
    <>
      {Object.entries(groups).map(([group, items]) => (
        <div key={group} className="app-nav__group" data-group={group}>
          {collapsed ? null : <p className="app-nav__group-title">{t(group as AppKey)}</p>}
          <ul>
            {items.map((item) => (
              <li key={item.path}>
                <NavLink
                  to={`${item.path}${q}`}
                  end={item.path === '/'}
                  className={({ isActive }) => (isActive ? 'app-nav__link is-active' : 'app-nav__link')}
                  title={collapsed ? t(item.label) : undefined}
                  onClick={onNavigate}
                  onMouseEnter={() => prefetchRoute(item.path)}
                  onFocus={() => prefetchRoute(item.path)}
                >
                  <Icon name={item.icon as IconName} size={18} />
                  <span className={collapsed ? 'pg-sr-only' : undefined}>{t(item.label)}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function HealthIndicator() {
  const health = useHealth();
  const net = useNetworkState();
  // Offline the last health answer is history, not the current state of the API.
  const status = net.state === 'offline' ? 'offline' : health.isError ? 'unavailable' : health.data?.status ?? 'unknown';
  const icon: IconName =
    status === 'ok' ? 'checkCircle' : status === 'degraded' ? 'alert' : status === 'unknown' ? 'dot' : status === 'offline' ? 'slash' : 'error';
  return (
    <span
      className={`app-status__item app-status__api is-${status}`}
      title={`${status === 'ok' ? t('status.system.ok') : t(`status.api.${status}` as AppKey)} · ${t('status.contract', { version: CONTRACT_VERSION })}`}
    >
      <Icon name={icon} size={13} />
      {status === 'ok' ? t('status.system.ok') : `${t('status.api')}: ${t(`status.api.${status}` as AppKey)}`}
      {health.isError && health.error instanceof ApiError && health.error.status ? (
        <span className="pg-muted"> · HTTP {health.error.status}</span>
      ) : null}
    </span>
  );
}

/** Explicit online/offline/unreachable state; data on screen may be older than the last contact. */
function NetworkBanner() {
  const qc = useQueryClient();
  const { state, lastContact } = useNetworkState();
  const prev = useRef(state);
  useEffect(() => {
    // Back from "server not answering": refresh what is on screen (offline -> online TanStack does itself).
    if (prev.current === 'unreachable' && (state === 'online' || state === 'reconnected')) void qc.invalidateQueries();
    prev.current = state;
  }, [state, qc]);
  if (state === 'online') return null;
  const since = lastContact
    ? t('net.since', { time: new Date(lastContact).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) })
    : '';
  if (state === 'reconnected') {
    return (
      <div className="app-net is-positive" role="status">
        <Icon name="checkCircle" size={16} /> {t('net.reconnected')}
      </div>
    );
  }
  return (
    <div className="app-net is-warning" role="status" data-net={state}>
      <Icon name={state === 'offline' ? 'slash' : 'alert'} size={16} />
      <div>
        <strong>{state === 'offline' ? t('net.offline') : t('net.unreachable')}</strong>{' '}
        {state === 'offline' ? t('net.offline.desc', { since }) : t('net.unreachable.desc', { since })}
      </div>
      {state === 'unreachable' ? (
        <Button size="sm" icon="refresh" onClick={() => void qc.refetchQueries({ queryKey: ['health'] })}>
          {t('net.retry')}
        </Button>
      ) : null}
    </div>
  );
}

function UserMenu() {
  const { user } = useSession();
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/auth/logout', { params: { header: { 'X-CSRF-Token': user?.csrf_token ?? '', 'Idempotency-Key': newIdempotencyKey() } } })),
    onSuccess: () => {
      setCsrfToken(null);
      qc.clear();
      window.location.assign('/');
    },
  });
  if (!user) return null;
  const roles = user.roles.map((r) => t(`role.${r}` as AppKey)).join(', ');
  return (
    <div className="app-user">
      <span className="app-user__avatar" aria-hidden><Icon name="user" size={17} /></span>
      <span className="app-user__identity">
        <span className="app-user__name">{user.display_name}</span>
        <span className="app-user__role">{roles}</span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon={logout.isError ? 'error' : 'logout'}
        iconOnly
        busy={logout.isPending}
        aria-label={t('top.logout')}
        title={logout.isError ? `${t('top.logout')}: ${(logout.error as Error).message}` : t('top.logout')}
        onClick={() => logout.mutate()}
      />
    </div>
  );
}

function CitySelect() {
  const { cities, city, setCityId } = useSession();
  const items = cities.data?.items ?? [];
  if (items.length < 2) {
    return <span className="app-city">{city ? cityDisplayName(city.name) : t('top.city.none')}</span>;
  }
  return (
    <label className="app-city">
      <span className="pg-sr-only">{t('top.city')}</span>
      <Select value={city?.id ?? ''} onChange={(e) => setCityId(e.target.value)}>
        <option value="" disabled>
          {t('city.choose')}
        </option>
        {items.map((c) => (
          <option key={c.id} value={c.id}>
            {cityDisplayName(c.name)}
          </option>
        ))}
      </Select>
    </label>
  );
}

function GlobalSearch() {
  const { city } = useSession();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const query = useDeferredValue(value.trim());
  const zones = useZones(city?.id ?? null);
  const zoneMatches = (zones.data?.items ?? [])
    .filter((zone) => zone.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')))
    .slice(0, 4);
  const result = useQuery({
    queryKey: ['global-address-search', city?.id, query],
    enabled: Boolean(city && query.length >= 3),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/addresses', { params: { query: { city_id: city!.id, q: query, limit: 6 } }, signal }))
    ).data.items as AddressResult[],
  });
  const choose = (item: AddressResult) => {
    const lon = item.position.coordinates[0];
    const lat = item.position.coordinates[1];
    if (lon === undefined || lat === undefined) return;
    navigate(`/?city=${encodeURIComponent(city!.id)}&ll=${lon.toFixed(6)},${lat.toFixed(6)}&z=16`);
    setValue(item.label);
    setOpen(false);
  };
  const chooseZone = (zoneId: string, name: string) => {
    navigate(`/?city=${encodeURIComponent(city!.id)}&zone=${encodeURIComponent(zoneId)}`);
    setValue(name);
    setOpen(false);
  };
  return (
    <div className="app-search">
      <Icon name="target" size={17} />
      <input
        value={value}
        onChange={(event) => { setValue(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Поиск участков, адресов и объектов…"
        aria-label="Поиск по городу"
      />
      {open && query.length >= 3 ? (
        <div className="app-search__results">
          {zoneMatches.map((zone) => <button key={zone.id} type="button" onClick={() => chooseZone(zone.id, zone.name)}><Icon name="map" size={16} /><span><strong>{zone.name}</strong><small>Проектный участок</small></span></button>)}
          {result.data?.map((item) => <button key={item.id} type="button" onClick={() => choose(item)}><Icon name="alertMap" size={16} /><span>{item.label}</span></button>)}
          {result.isPending ? <p>Ищем адреса…</p> : null}
          {!result.isPending && zoneMatches.length === 0 && !result.data?.length ? <p>{result.isError ? 'По участкам совпадений нет — откройте карту для поиска объекта' : 'Ничего не найдено'}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function ThemeToggle() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const systemDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const label = dark ? t('top.theme.toLight') : t('top.theme.toDark');
  return (
    <Button
      className="app-top__theme"
      variant="ghost"
      icon={dark ? 'sun' : 'moon'}
      iconOnly
      aria-label={label}
      title={label}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    />
  );
}

function AssistantPanel() {
  const open = useUi((s) => s.assistantOpen);
  const setOpen = useUi((s) => s.setAssistantOpen);
  const [params] = useSearchParams();
  const resumed = params.has(CHAT);
  // A chat link (or a reload mid-conversation) reopens the panel on that session.
  useEffect(() => {
    if (resumed) setOpen(true);
  }, [resumed, setOpen]);
  if (!open) return null;
  return (
    <SidePanel id="assistant" title={t('assistant.title')} collapsed={false} onCollapsedChange={(c) => setOpen(!c)} defaultWidth={380}>
      <Assistant />
    </SidePanel>
  );
}

export function AppShell() {
  const { navCollapsed, setNavCollapsed, mobileNavOpen, setMobileNavOpen, assistantOpen, setAssistantOpen } = useUi();
  const { city } = useSession();
  const location = useLocation();
  const cityQuery = useCityQuery();
  const [demoTourOpen, setDemoTourOpen] = useState(false);

  useEffect(() => setMobileNavOpen(false), [location.pathname, setMobileNavOpen]);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen, setMobileNavOpen]);

  return (
    <div className={navCollapsed ? 'app is-nav-collapsed' : 'app'}>
      <a href="#main" className="app-skip">
        {t('app.skip')}
      </a>
      <nav
        id="app-nav"
        className={mobileNavOpen ? 'app-nav is-open' : 'app-nav'}
        aria-label={t('nav.label')}
      >
        <a className="app-brand" href={`/${city ? `?city=${city.id}` : ''}`}>
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span className="app-brand__copy">
            <strong>{t('app.name')}</strong>
            <small>{t('app.city')}</small>
          </span>
        </a>
        <div className="app-nav__scroll">
          <NavList collapsed={navCollapsed && !mobileNavOpen} onNavigate={() => setMobileNavOpen(false)} />
        </div>
        <footer className="app-status">
          <HealthIndicator />
        </footer>
        <div className="app-nav__user">
          <UserMenu />
          <Button
            className="app-nav__toggle"
            variant="ghost"
            icon={navCollapsed ? 'chevronRight' : 'chevronLeft'}
            onClick={() => setNavCollapsed(!navCollapsed)}
            aria-label={navCollapsed ? t('nav.expand') : t('nav.collapse')}
            iconOnly={navCollapsed}
          >
            {t('nav.collapse')}
          </Button>
        </div>
      </nav>
      <section className="app-workspace">
        <header className="app-top">
          <Button
            className="app-top__menu"
            variant="ghost"
            iconOnly
            icon="menu"
            aria-label={mobileNavOpen ? t('nav.close') : t('nav.open')}
            aria-expanded={mobileNavOpen}
            aria-controls="app-nav"
            onClick={() => setMobileNavOpen(!mobileNavOpen)}
          />
          <CitySelect />
          <GlobalSearch />
          <span className="app-top__spacer" />
          <Button variant="secondary" icon="sprout" onClick={() => setDemoTourOpen(true)} className="app-top__tour">
            Демо 3 минуты
          </Button>
          <Button
            variant={assistantOpen ? 'primary' : 'secondary'}
            icon="chat"
            aria-pressed={assistantOpen}
            onClick={() => setAssistantOpen(!assistantOpen)}
            className="app-top__assistant"
          >
            {t('top.assistant')}
          </Button>
          <NavLink to={`/sources${cityQuery}`} className="app-top__link" title={t('top.sources')}>
            <Icon name="database" size={17} />
            <span>{t('top.sources')}</span>
          </NavLink>
          <ThemeToggle />
        </header>
        <div className="app-body">
          <main id="main" className="app-main" tabIndex={-1}>
            <NetworkBanner />
            <Outlet />
          </main>
          <AssistantPanel />
        </div>
      </section>
      {mobileNavOpen ? <div className="app-nav__scrim" onClick={() => setMobileNavOpen(false)} aria-hidden /> : null}
      <DemoTour open={demoTourOpen} onClose={() => setDemoTourOpen(false)} />
    </div>
  );
}
