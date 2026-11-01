import type { ReactNode } from 'react';
import type { City } from '@pg/api-client';
import { Button, StateView } from '@pg/ui';
import { t } from '../i18n';
import { ApiErrorView } from './ApiErrorView';
import { useSession } from './session';
import { cityDisplayName } from '../city';

export type GateResult = { city: City; view: null } | { city: null; view: ReactNode };

/** Resolves session + accessible city, or the state view explaining why there is none. */
export function useCityGate(): GateResult {
  const { me, cities, city, setCityId } = useSession();
  if (me.isPending) return { city: null, view: <StateView state="loading" /> };
  if (me.isError) return { city: null, view: <ApiErrorView error={me.error} onRetry={() => void me.refetch()} /> };
  if (cities.isPending) return { city: null, view: <StateView state="loading" /> };
  if (cities.isError) return { city: null, view: <ApiErrorView error={cities.error} onRetry={() => void cities.refetch()} /> };
  const items = cities.data.items;
  if (items.length === 0) {
    return { city: null, view: <StateView state="empty" title={t('city.empty')} description={t('city.empty.desc')} /> };
  }
  if (!city) {
    return {
      city: null,
      view: (
        <StateView
          state="empty"
          title={t('city.choose')}
          actions={items.map((c) => (
            <Button key={c.id} variant="primary" onClick={() => setCityId(c.id)}>
              {cityDisplayName(c.name)}
            </Button>
          ))}
        />
      ),
    };
  }
  return { city, view: null };
}

export function CityGate({ children }: { children: (city: City) => ReactNode }) {
  const gate = useCityGate();
  return <>{gate.city ? children(gate.city) : gate.view}</>;
}
