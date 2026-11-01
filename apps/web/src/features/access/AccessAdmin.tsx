import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unwrap, type City, type Dataset } from '@pg/api-client';
import { Badge, Button, Field, Input, Notice, Skeleton, StateView } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSelected } from '../resources/details';
import { isUuid } from '../map/publishedLayers';
import { cityDisplayName } from '../../city';
import { DatasetGrantsPanel, RoleBadges, useCityPrincipals } from './DatasetGrants';
import { productLabel } from '../../productCopy';

/**
 * Administration of explicit access to restricted datasets. The server lists only datasets the
 * admin may read, so restricted datasets of other users stay hidden even here; they are opened by
 * id (the grant operations need city admin rights only, not content access).
 */
export function AccessAdmin({ city }: { city: City }) {
  const [selected, setSelected] = useSelected('grants');
  const [typed, setTyped] = useState('');
  const available = useOperationAvailable('listDatasets');
  const visible = useQuery({
    queryKey: ['restricted-datasets', city.id],
    enabled: available !== false,
    queryFn: async ({ signal }) => {
      const items: Dataset[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 25; i++) {
        const page = (await unwrap(api.GET('/v1/datasets', { params: { query: { city_id: city.id, cursor, limit: 100 } }, signal }))).data;
        items.push(...page.items);
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
      }
      return items.filter((d) => d.access_level === 'restricted');
    },
  });
  const current = visible.data?.find((d) => d.id === selected) ?? null;
  const typedId = typed.trim().toLowerCase();
  const typedError = typedId && !isUuid(typedId) ? t('grants.open.invalid') : null;
  return (
    <div className="acc-admin">
      <div className="acc-admin__pick">
        <h3>{t('grants.datasets')}</h3>
        {available === false ? (
          <OperationUnavailable compact operationId="listDatasets" />
        ) : visible.isPending ? (
          <Skeleton lines={3} />
        ) : visible.isError ? (
          <ApiErrorView compact error={visible.error} onRetry={() => void visible.refetch()} />
        ) : visible.data.length === 0 ? (
          <StateView compact state="empty" title={t('grants.datasets.empty')} description={t('grants.datasets.empty.desc')} />
        ) : (
          <ul className="acc-datasets">
            {visible.data.map((d) => (
              <li key={d.id}>
                <button type="button" className={d.id === selected ? 'acc-datasets__item is-selected' : 'acc-datasets__item'} aria-pressed={d.id === selected} onClick={() => setSelected(d.id)}>
                  <span>{productLabel(d.name)}</span>
                  <Badge tone="warning" icon="lock">
                    {t('access.restricted')}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="acc-open"
          onSubmit={(e) => {
            e.preventDefault();
            if (isUuid(typedId)) setSelected(typedId);
          }}
        >
          <Field label={t('grants.open')} hint={t('grants.open.hint')} error={typedError}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                spellCheck={false}
                placeholder="00000000-0000-0000-0000-000000000000"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={!isUuid(typedId)}>
            {t('grants.open.submit')}
          </Button>
        </form>
      </div>
      <div className="acc-admin__detail">
        {selected ? (
          <DatasetGrantsPanel key={selected} datasetId={selected} cityId={city.id} datasetName={current?.name ?? null} />
        ) : (
          <StateView compact state="empty" title={t('grants.pick')} description={t('grants.pick.desc')} />
        )}
      </div>
    </div>
  );
}

/** Users explicitly assigned to the city. Roles are shown as roles, never as dataset access. */
export function CityUsers({ city }: { city: City }) {
  const { available, query } = useCityPrincipals(city.id);
  if (available === false) return <OperationUnavailable compact operationId="listCityPrincipals" />;
  if (query.isPending) return <Skeleton lines={3} />;
  if (query.isError) return <ApiErrorView compact error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data.items.length === 0) return <StateView compact state="empty" title={t('grants.users.empty')} />;
  return (
    <>
      <Notice tone="neutral" icon="shield" title={t('grants.users.note')}>
        {t('grants.users.note.desc')}
      </Notice>
      <table className="acc-table">
        <caption className="pg-sr-only">{t('grants.users', { city: cityDisplayName(city.name) })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('grants.col.user')}</th>
            <th scope="col">{t('grants.col.roles')}</th>
          </tr>
        </thead>
        <tbody>
          {query.data.items.map((p) => (
            <tr key={p.id}>
              <td>
                {p.display_name} <code className="pg-code" title={p.id}>{p.id.slice(0, 8)}</code>
              </td>
              <td>
                <RoleBadges roles={p.roles} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {query.data.complete ? null : <p className="pg-muted">{t('grants.incomplete', { n: query.data.items.length })}</p>}
    </>
  );
}
