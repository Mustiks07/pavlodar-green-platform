import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unwrap, type RuleVersion } from '@pg/api-client';
import { Badge, Button, Field, formatDate, Input, Notice, Select, Skeleton, StateView, type Tone } from '@pg/ui';
import { api, useOperationAvailable } from '../../api';
import { t, type AppKey } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';
import { useSession } from '../../shell/session';
import { isUuid } from '../map/publishedLayers';

/** Mirrors the server gate: an explicit synthetic estimate may drive a draft, never approval. */
export const ruleUsable = (r: RuleVersion) => (
  r.superseded_by === null
  && (
    r.review_status === 'expert_confirmed'
    || (r.review_status === 'verified_text_requires_expert' && r.source_status.startsWith('SYNTHETIC TEST'))
  )
);

const STATUS_TONE: Record<RuleVersion['review_status'], Tone> = {
  expert_confirmed: 'positive',
  verified_text_requires_expert: 'warning',
  superseded: 'neutral',
  conflict_requires_review: 'negative',
};

function statusOf(r: RuleVersion): { tone: Tone; label: string } {
  if (r.review_status === 'expert_confirmed' && r.superseded_by !== null) return { tone: 'neutral', label: t('rule.status.superseded') };
  return { tone: STATUS_TONE[r.review_status], label: t(`rule.status.${r.review_status}` as AppKey) };
}

const revisionText = (r: RuleVersion) => t('rule.revision', { date: formatDate(r.revision_date) ?? r.revision_date });
const optionLabel = (r: RuleVersion) => `${r.parameter} · ${r.act_number}, п. ${r.clause} · ${revisionText(r)}`;

/** Rule versions of the city the user may read (listRuleVersions, all statuses), bounded paging. */
function useRuleVersions(cityId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['rule-versions', cityId],
    enabled: Boolean(cityId) && enabled,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const items: RuleVersion[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = (await unwrap(api.GET('/v1/rule-versions', { params: { query: { city_id: cityId!, usable: false, cursor, limit: 200 } }, signal })))
          .data;
        items.push(...page.items);
        if (!page.next_cursor) return { items, complete: true };
        cursor = page.next_cursor;
      }
      return { items, complete: false };
    },
  });
}

function RuleDetails({ rule }: { rule: RuleVersion }) {
  const s = statusOf(rule);
  return (
    <div className="pl-rule__info" role="status">
      <Badge tone={s.tone} icon={ruleUsable(rule) ? 'checkCircle' : 'alert'}>
        {s.label}
      </Badge>
      <dl className="pg-dl">
        <dt>{t('rule.parameter')}</dt>
        <dd>
          {rule.parameter}
          {rule.value !== null ? ` = ${String(rule.value)}${rule.unit ? ` ${rule.unit}` : ''}` : ''}
        </dd>
        <dt>{t('rule.act')}</dt>
        <dd>
          {rule.act_number}, п. {rule.clause} · {revisionText(rule)}
        </dd>
        <dt>{t('rule.applicability')}</dt>
        <dd>
          {rule.applicability}
          {rule.condition ? ` · ${rule.condition}` : ''}
        </dd>
      </dl>
      {ruleUsable(rule) ? null : (
        <Notice tone="warning" title={t('rule.unusable')}>
          {rule.superseded_by ? t('rule.supersededBy', { id: rule.superseded_by.slice(0, 8) }) : null}
        </Notice>
      )}
    </div>
  );
}

/**
 * Rule version of the revision, picked from listRuleVersions. Unusable versions are listed with
 * their status but cannot be chosen, and nothing is preselected (not even a single usable one).
 * The verified id field stays as a fallback (getRuleVersion) when the list is unavailable or the
 * rule is not among the listed ones.
 */
export function RuleVersionField({
  value,
  required,
  onChange,
  onUsable,
}: {
  value: string | null;
  required: boolean;
  onChange: (id: string | null) => void;
  onUsable: (usable: boolean | null) => void;
}) {
  const { city } = useSession();
  const listOk = useOperationAvailable('listRuleVersions');
  const getOk = useOperationAvailable('getRuleVersion');
  const list = useRuleVersions(city?.id ?? null, listOk !== false);
  const [manual, setManual] = useState(false);
  const listed = value ? (list.data?.items.find((r) => r.id === value) ?? null) : null;
  // A value outside the list (typed id, record of a dataset no longer readable) is checked by id.
  const byId = useQuery({
    queryKey: ['rule-version', value],
    enabled: Boolean(value && isUuid(value)) && !listed && !list.isPending && getOk !== false,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) =>
      (await unwrap<RuleVersion>(api.GET('/v1/rule-versions/{rule_version_id}', { params: { path: { rule_version_id: value! } }, signal }))).data,
  });
  const rule = listed ?? byId.data ?? null;
  const usable = rule ? ruleUsable(rule) : value && byId.isError ? false : null;
  useEffect(() => onUsable(value ? usable : null), [value, usable, onUsable]);

  const usableRules = list.data?.items.filter(ruleUsable) ?? [];
  const otherRules = list.data?.items.filter((r) => !ruleUsable(r)) ?? [];
  const pickerShown = listOk !== false && Boolean(list.data);
  const showManual = manual || listOk === false || list.isError;
  const error = required && !value ? t('rule.field.required') : rule && !ruleUsable(rule) ? t('rule.unusable') : null;

  return (
    <div className="pl-rule">
      {listOk === false ? (
        <OperationUnavailable compact operationId="listRuleVersions" />
      ) : list.isPending && city ? (
        <Skeleton lines={2} />
      ) : list.isError ? (
        <ApiErrorView compact error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {pickerShown ? (
        <Field label={t('rule.field')} hint={t('rule.pick.hint')} required={required} error={showManual ? null : error}>
          {({ id, describedBy, invalid }) => (
            <Select id={id} aria-describedby={describedBy} aria-invalid={invalid} value={listed ? listed.id : ''} onChange={(e) => onChange(e.target.value || null)}>
              <option value="">{value && !listed ? t('rule.pick.notListed') : usableRules.length ? t('rule.pick.choose') : t('rule.pick.noneUsable')}</option>
              {usableRules.length ? (
                <optgroup label={t('rule.pick.usable')}>
                  {usableRules.map((r) => (
                    <option key={r.id} value={r.id}>
                      {optionLabel(r)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {otherRules.length ? (
                <optgroup label={t('rule.pick.unusable')}>
                  {otherRules.map((r) => (
                    // Listed for transparency; the server would refuse them, so they cannot be chosen
                    // (the current value stays selectable only to show what the revision holds).
                    <option key={r.id} value={r.id} disabled={r.id !== value}>
                      {optionLabel(r)} — {statusOf(r).label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>
          )}
        </Field>
      ) : null}
      {list.data && list.data.items.length === 0 ? (
        <StateView compact state="empty" title={t('rule.pick.empty')} description={t('rule.pick.empty.desc')} />
      ) : null}
      {list.data && !list.data.complete ? <p className="pg-muted">{t('rule.pick.incomplete', { n: list.data.items.length })}</p> : null}
      {showManual ? (
        <ManualRuleId value={value} required={required} onChange={onChange} error={error} />
      ) : pickerShown ? (
        <span>
          <Button size="sm" variant="ghost" onClick={() => setManual(true)}>
            {t('rule.manual.open')}
          </Button>
        </span>
      ) : null}
      {value && !rule ? (
        byId.isError ? (
          <ApiErrorView compact error={byId.error} onRetry={() => void byId.refetch()} />
        ) : getOk === false ? (
          <OperationUnavailable compact operationId="getRuleVersion" />
        ) : byId.fetchStatus === 'fetching' ? (
          <p className="pg-muted" role="status">
            {t('rule.loading')}
          </p>
        ) : null
      ) : null}
      {rule ? <RuleDetails rule={rule} /> : null}
    </div>
  );
}

function ManualRuleId({ value, required, onChange, error }: { value: string | null; required: boolean; onChange: (id: string | null) => void; error: string | null }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const invalid = text.trim() && !isUuid(text.trim()) ? t('rule.field.invalid') : null;
  return (
    <Field label={t('rule.manual')} hint={t('rule.field.hint')} required={required} error={invalid ?? error}>
      {({ id, describedBy, invalid: inv }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={inv}
          spellCheck={false}
          value={text}
          placeholder="00000000-0000-0000-0000-000000000000"
          onChange={(e) => {
            setText(e.target.value);
            const v = e.target.value.trim();
            onChange(v === '' ? null : isUuid(v) ? v.toLowerCase() : v);
          }}
        />
      )}
    </Field>
  );
}
