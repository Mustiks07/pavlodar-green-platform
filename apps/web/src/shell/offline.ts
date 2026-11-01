import { useEffect, useRef, useState } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { ApiError } from '@pg/api-client';
import { configuredBasemapUrl } from '../features/map/basemap';
import { useHealth } from '../api';

/**
 * Registers the offline shell worker (public/sw.js) in production builds only: the dev server
 * serves modules that change on every edit and must never be answered from a cache.
 */
export function registerOfflineShell() {
  if (!('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) {
    // A worker left by a production preview on this origin would serve its stale shell.
    void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
    return;
  }
  const q = new URLSearchParams({ v: __BUILD_ID__ });
  const basemap = configuredBasemapUrl();
  if (basemap) q.set('basemap', basemap);
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`/sw.js?${q.toString()}`, { scope: '/' }).catch((e: unknown) => {
      // The app works without it; only cold start without network is lost.
      console.warn('[offline shell] not registered', e);
    });
  });
}

/**
 * offline     — the browser reports no network;
 * unreachable — network present, the platform API does not answer;
 * reconnected — just back online, data is being refreshed (shown briefly);
 * online      — the API answers.
 */
export type NetworkState = 'online' | 'offline' | 'unreachable' | 'reconnected';

/**
 * TanStack Query v5 starts "online" and only reacts to events; a cold start without network
 * would then fire every query and fail. Align it with the browser before the first query.
 */
export function syncOnlineManager() {
  onlineManager.setOnline(navigator.onLine);
  onlineManager.setEventListener((setOnline) => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  });
}

function useBrowserOnline() {
  const [online, setOnline] = useState(() => onlineManager.isOnline());
  useEffect(() => onlineManager.subscribe(setOnline), []);
  return online;
}

export function useNetworkState(): { state: NetworkState; lastContact: number | null } {
  const online = useBrowserOnline();
  const health = useHealth();
  // No answer from the API at all: transport failure, or a gateway in front of it (502/504).
  const transport =
    health.error instanceof ApiError &&
    (health.error.category === 'network' || health.error.category === 'timeout' || health.error.status === 502 || health.error.status === 504);
  const base: NetworkState = !online ? 'offline' : transport ? 'unreachable' : 'online';
  const [recent, setRecent] = useState(false);
  const prev = useRef(base);
  useEffect(() => {
    const was = prev.current;
    prev.current = base;
    if (base !== 'online' || was === 'online') return;
    setRecent(true);
    const id = window.setTimeout(() => setRecent(false), 5000);
    return () => window.clearTimeout(id);
  }, [base]);
  // A failed health check after going offline must not count as contact.
  const lastContact = health.isSuccess || health.data ? health.dataUpdatedAt || null : null;
  return { state: base === 'online' && recent ? 'reconnected' : base, lastContact };
}
