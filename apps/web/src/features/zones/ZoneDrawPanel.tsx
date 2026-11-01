import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, newIdempotencyKey, unwrap, type City, type Zone, type ZoneCreate } from '@pg/api-client';
import { Badge, Button, Field, formatNumber, Input, Notice, Select, UnitText } from '@pg/ui';
import { api } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { useSession } from '../../shell/session';
import { closeRing, cycleVertex, editableRing, previewIssues, redo, removeLast, startDraw, toPolygon, undo, type DrawState } from './draw';
import { useZone, zk } from './queries';

const PURPOSES: Zone['purpose'][] = ['park', 'square', 'courtyard', 'street', 'school', 'hospital', 'protective_belt', 'other'];

export interface ZoneDrawPanelProps {
  city: City;
  draw: DrawState;
  setDraw: (d: DrawState) => void;
  onAddCenter: () => void;
  restored: boolean;
  onDone: (zoneId: string | null) => void;
}

/**
 * Controls for drawing a new zone or editing an existing boundary. The map handles
 * pointer input; everything here also works from the keyboard. The server validates
 * geometry, computes area and creates the new immutable ZoneVersion.
 */
export function ZoneDrawPanel({ city, draw, setDraw, onAddCenter, restored, onDone }: ZoneDrawPanelProps) {
  const { user } = useSession();
  const qc = useQueryClient();
  const zone = useZone(draw.mode === 'edit' ? draw.zoneId : null);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState<Zone['purpose']>('square');
  const [key, setKey] = useState(newIdempotencyKey);
  const [usedEtag, setUsedEtag] = useState<string | null>(null);
  // Fields the user changed; untouched ones follow the server on re-base (no lost update).
  const [touched, setTouched] = useState({ name: false, purpose: false });

  // Edit mode: name/purpose start from the server's current zone.
  useEffect(() => {
    if (draw.mode !== 'edit' || !zone.data) return;
    setName((n) => n || zone.data.data.name);
    setPurpose(zone.data.data.purpose);
  }, [draw.mode, zone.data]);

  const issues = previewIssues(draw);
  const blocking = issues.filter((i) => i !== 'duplicate_vertex');

  const save = useMutation({
    mutationFn: async () => {
      const body: ZoneCreate = { city_id: city.id, name: name.trim(), purpose, geometry: toPolygon(draw.vertices) };
      const csrf = user?.csrf_token ?? '';
      if (draw.mode === 'create') {
        return unwrap<Zone>(api.POST('/v1/zones', { params: { header: { 'X-CSRF-Token': csrf, 'Idempotency-Key': key } }, body }));
      }
      const etag = zone.data?.etag;
      if (!etag || !draw.zoneId) throw new ApiError('invalid', null, null, 'ETag missing');
      setUsedEtag(etag);
      return unwrap<Zone>(
        api.PUT('/v1/zones/{zone_id}', {
          params: { path: { zone_id: draw.zoneId }, header: { 'X-CSRF-Token': csrf, 'Idempotency-Key': key, 'If-Match': etag } },
          body,
        }),
      );
    },
    onSuccess: ({ data }) => {
      void qc.invalidateQueries({ queryKey: zk.zones(city.id) });
      void qc.invalidateQueries({ queryKey: zk.zone(data.id) });
      void qc.invalidateQueries({ queryKey: zk.zoneContext(data.id) });
      onDone(data.id);
    },
  });

  const conflict = save.error instanceof ApiError && save.error.category === 'revision_conflict';
  const serverMovedOn = conflict && zone.data?.etag && zone.data.etag !== usedEtag;

  const fetchFresh = () =>
    qc.fetchQuery({
      queryKey: zk.zone(draw.zoneId ?? ''),
      queryFn: () => unwrap<Zone>(api.GET('/v1/zones/{zone_id}', { params: { path: { zone_id: draw.zoneId! } } })),
      staleTime: 0,
    });

  /** Keep my geometry (and any field I edited) on top of the server's newest version. */
  const reloadCurrent = async () => {
    const fresh = await fetchFresh();
    if (!touched.name) setName(fresh.data.name);
    if (!touched.purpose) setPurpose(fresh.data.purpose);
    setKey(newIdempotencyKey());
    save.reset();
  };

  const discardMine = async () => {
    const fresh = await fetchFresh();
    const ring = editableRing(fresh.data.geometry);
    if (ring) setDraw(startDraw('edit', fresh.data.id, ring));
    setName(fresh.data.name);
    setPurpose(fresh.data.purpose);
    setTouched({ name: false, purpose: false });
    setKey(newIdempotencyKey());
    save.reset();
  };

  return (
    <div className="draw-panel">
      <p className="pg-muted">{draw.mode === 'create' ? t('draw.create.desc') : t('draw.edit.desc')}</p>
      {restored ? <Notice tone="info" icon="refresh" title={t('draw.restored')} /> : null}

      <div className="draw-status" role="status" aria-live="polite">
        <Badge tone={draw.closed ? 'positive' : 'info'} icon={draw.closed ? 'checkCircle' : 'dot'}>
          {draw.closed ? t('draw.closed') : t('draw.open')}
        </Badge>
        <span>{t('draw.vertices', { n: draw.vertices.length })}</span>
        <span className="pg-muted">
          {draw.selected != null ? t('draw.vertex.selected', { n: draw.selected + 1, total: draw.vertices.length }) : t('draw.vertex.none')}
        </span>
      </div>

      <div className="draw-tools" role="toolbar" aria-label={t('draw.toolbar')}>
        <Button size="sm" icon="plus" onClick={onAddCenter} disabled={draw.closed} title={t('draw.addCenter.key')}>
          {t('draw.addCenter')}
        </Button>
        <Button size="sm" icon="check" onClick={() => setDraw(closeRing(draw))} disabled={draw.closed || draw.vertices.length < 3}>
          {t('draw.close')}
        </Button>
        <Button size="sm" icon="x" onClick={() => setDraw(removeLast(draw))} disabled={draw.vertices.length === 0}>
          {draw.closed ? t('draw.reopen') : t('draw.removeLast')}
        </Button>
        <Button size="sm" icon="chevronLeft" onClick={() => setDraw(undo(draw))} disabled={draw.past.length === 0} title="Ctrl+Z">
          {t('draw.undo')}
        </Button>
        <Button size="sm" icon="chevronRight" onClick={() => setDraw(redo(draw))} disabled={draw.future.length === 0} title="Ctrl+Y">
          {t('draw.redo')}
        </Button>
        <Button size="sm" onClick={() => setDraw(cycleVertex(draw, -1))} disabled={draw.vertices.length === 0} title="[">
          {t('draw.vertex.prev')}
        </Button>
        <Button size="sm" onClick={() => setDraw(cycleVertex(draw, 1))} disabled={draw.vertices.length === 0} title="]">
          {t('draw.vertex.next')}
        </Button>
      </div>
      <details className="pg-disclosure">
        <summary>{t('draw.help')}</summary>
        <ul className="draw-help">
          <li>{t('draw.help.click')}</li>
          <li>{t('draw.help.close')}</li>
          <li>{t('draw.help.drag')}</li>
          <li>{t('draw.help.touch')}</li>
          <li>{t('draw.help.vertexKeys')}</li>
          <li>{t('draw.help.keys')}</li>
        </ul>
      </details>

      {issues.length ? (
        <ul className="draw-issues">
          {issues.map((i) => (
            <li key={i} className={i === 'duplicate_vertex' ? 'is-warning' : undefined}>
              {t(`draw.issue.${i}` as AppKey)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="pg-muted">{t('draw.preview.ok')}</p>
      )}

      <Field label={t('draw.name')} required>
        {({ id }) => (
          <Input
            id={id}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setTouched((x) => ({ ...x, name: true }));
            }}
          />
        )}
      </Field>
      <Field label={t('draw.purpose')}>
        {({ id }) => (
          <Select
            id={id}
            value={purpose}
            onChange={(e) => {
              setPurpose(e.target.value as Zone['purpose']);
              setTouched((x) => ({ ...x, purpose: true }));
            }}
          >
            {PURPOSES.map((p) => (
              <option key={p} value={p}>
                {t(`purpose.${p}` as AppKey)}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {draw.mode === 'edit' && zone.data ? (
        <p className="pg-muted">
          {t('draw.edit.current', { version: zone.data.data.version_id.slice(0, 8) })} · {formatNumber(zone.data.data.area_m2, 0)} <UnitText unit="m2" />
        </p>
      ) : null}

      {conflict ? (
        <Notice
          tone="warning"
          icon="conflict"
          title={t('draw.conflict.title')}
          actions={
            <>
              <Button size="sm" variant="primary" icon="refresh" onClick={() => void reloadCurrent()}>
                {t('draw.conflict.keep')}
              </Button>
              <Button size="sm" onClick={() => void discardMine()}>
                {t('draw.conflict.discard')}
              </Button>
            </>
          }
        >
          {t('draw.conflict.desc')}
          {serverMovedOn ? <> {t('draw.conflict.loaded')}</> : null}
        </Notice>
      ) : save.isError ? (
        <ApiErrorView compact error={save.error} />
      ) : null}

      <div className="scn-actions">
        <Button
          variant="primary"
          icon="check"
          busy={save.isPending}
          disabled={blocking.length > 0 || name.trim() === '' || conflict || (draw.mode === 'edit' && !zone.data)}
          onClick={() => {
            if (save.isError) setKey(newIdempotencyKey());
            save.mutate();
          }}
        >
          {draw.mode === 'create' ? t('draw.save.create') : t('draw.save.edit')}
        </Button>
        <Button onClick={() => onDone(draw.mode === 'edit' ? draw.zoneId : null)} disabled={save.isPending}>
          {t('draw.cancel')}
        </Button>
      </div>
      <p className="pg-muted">{draw.mode === 'create' ? t('draw.save.create.hint') : t('draw.save.edit.hint')}</p>
    </div>
  );
}
