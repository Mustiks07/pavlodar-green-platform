import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROPOSAL = '11111111-1111-4111-8111-111111111111';
const SCENARIO = '22222222-2222-4222-8222-222222222222';
const BASE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const PLACEMENT = '55555555-5555-4555-8555-555555555555';
const PLANT_BEFORE = '66666666-6666-4666-8666-666666666666';
const PLANT_AFTER = '77777777-7777-4777-8777-777777777777';

const placement = (quantity: number, plantId = PLANT_BEFORE) => ({ id: PLACEMENT, plant_id: plantId, quantity, locked: false });
const proposal = {
  id: PROPOSAL,
  scenario_id: SCENARIO,
  base_revision_id: BASE,
  status: 'pending',
  summary: 'SYNTHETIC TEST: увеличить количество',
  proposed_revision: { placements: [placement(5)] },
  expires_at: '2026-11-01T10:00:00Z',
};
let proposalValue = proposal;
let scenarioEtag = '"v1"';
let currentRevision = BASE;
let applyStatus = 201;
type CallInit = {
  params?: {
    header?: Record<string, string>;
    path?: { plant_id?: string };
  };
  body?: unknown;
};
const calls: { method: string; path: string; init: CallInit }[] = [];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
  data: status < 400 ? body : undefined,
  error: status >= 400 ? body : undefined,
  response: new Response(null, { status, headers }),
});

vi.mock('../../api', () => ({
  api: {
    GET: async (path: string, init: CallInit) => {
      calls.push({ method: 'GET', path, init });
      if (path === '/v1/proposals/{proposal_id}') return json(proposalValue);
      if (path === '/v1/scenarios/{scenario_id}') return json({ id: SCENARIO, current_revision_id: currentRevision, status: 'draft' }, 200, { ETag: scenarioEtag });
      if (path === '/v1/scenario-revisions/{revision_id}') return json({ id: BASE, placements: [placement(4)] });
      if (path === '/v1/plants/{plant_id}') {
        return json({
          id: init.params?.path?.plant_id,
          russian_name: init.params?.path?.plant_id === PLANT_AFTER ? 'Липа мелколистная' : 'Берёза повислая',
        });
      }
      throw new Error(`unexpected GET ${path}`);
    },
    POST: async (path: string, init: never) => {
      calls.push({ method: 'POST', path, init });
      if (path === '/v1/proposals/{proposal_id}/apply') {
        if (applyStatus === 412) {
          return json({ type: 'about:blank', title: 'conflict', status: 412, detail: 'changed', code: 'revision_conflict', request_id: null, current_revision_id: OTHER }, 412);
        }
        return json({ id: OTHER, placements: [placement(5)] }, 201);
      }
      throw new Error(`unexpected POST ${path}`);
    },
  },
  useOperationAvailable: () => true,
}));
vi.mock('../../shell/session', () => ({
  useSession: () => ({ user: { csrf_token: 'csrf' }, cityId: null, city: null, hasRole: () => true }),
}));

const { ProposalCard } = await import('./Assistant');

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProposalCard id={PROPOSAL} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  calls.length = 0;
  scenarioEtag = '"v1"';
  currentRevision = BASE;
  applyStatus = 201;
  proposalValue = proposal;
});

describe('ProposalCard', () => {
  it('shows server quantities and never applies without an explicit confirmation', async () => {
    renderCard();
    expect(await screen.findByText(/количество 4 → 5/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Применить…' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(screen.getByRole('button', { name: 'Подтвердить применение' })).toBeTruthy();
  });

  it('shows a plant replacement as a readable before and after decision', async () => {
    proposalValue = {
      ...proposal,
      summary: 'Заменить вид в выбранном размещении',
      proposed_revision: { placements: [placement(4, PLANT_AFTER)] },
    };
    renderCard();
    expect(await screen.findByText('Растение в размещении: «Берёза повислая» → «Липа мелколистная»')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('applies with a freshly read If-Match and the proposal base revision', async () => {
    renderCard();
    await screen.findByText(/количество 4 → 5/);
    scenarioEtag = '"v2"';
    fireEvent.click(screen.getByRole('button', { name: 'Применить…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить применение' }));
    expect(await screen.findByText('Создана новая ревизия')).toBeTruthy();
    const apply = calls.find((c) => c.path === '/v1/proposals/{proposal_id}/apply')!;
    expect(apply.init.params?.header?.['If-Match']).toBe('"v2"');
    expect(apply.init.body).toEqual({ base_revision_id: BASE });
    // The page first read "v1"; only a re-read right before applying can send "v2".
    expect(calls.slice(0, calls.indexOf(apply)).filter((c) => c.path === '/v1/scenarios/{scenario_id}').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the proposal on a 412 and offers to re-read the current revision', async () => {
    applyStatus = 412;
    renderCard();
    await screen.findByText(/количество 4 → 5/);
    fireEvent.click(screen.getByRole('button', { name: 'Применить…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить применение' }));
    expect(await screen.findByText('Сценарий изменился')).toBeTruthy();
    expect(screen.getByText('увеличить количество')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Открыть текущую версию проекта' })).toBeTruthy();
    const reads = calls.filter((c) => c.path === '/v1/proposals/{proposal_id}').length;
    fireEvent.click(screen.getByRole('button', { name: 'Перечитать текущую ревизию' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/v1/proposals/{proposal_id}').length).toBeGreaterThan(reads));
    expect(screen.queryByText('Создана новая ревизия')).toBeNull();
  });
});
