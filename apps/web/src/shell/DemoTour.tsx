import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  unwrap,
  type CalculationSnapshot,
  type CalculationSnapshotPage,
  type DetectedProblem,
  type Program,
  type Scenario,
  type Zone,
} from '@pg/api-client';
import { Button, Dialog, Icon, type IconName } from '@pg/ui';
import { api } from '../api';
import { useSession } from './session';
import { useUi } from './ui-store';

type TourStep = { icon: IconName; title: string; note: string; href: string | null };
const TOUR_STEP_KEY = 'pavlodar-demo-tour-step';

const withCity = (path: string, cityId?: string, extra?: Record<string, string | undefined>) => {
  const params = new URLSearchParams(cityId ? { city: cityId } : {});
  for (const [key, value] of Object.entries(extra ?? {})) if (value) params.set(key, value);
  return `${path}${params.size ? `?${params}` : ''}`;
};

export function DemoTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { city } = useSession();
  const setAssistantOpen = useUi((state) => state.setAssistantOpen);
  const [activeStep, setActiveStep] = useState<number | null>(() => {
    try {
      const stored = window.sessionStorage.getItem(TOUR_STEP_KEY);
      if (stored === null) return null;
      const value = Number(stored);
      return Number.isInteger(value) && value >= 0 && value < 7 ? value : null;
    } catch {
      return null;
    }
  });
  const enabled = open || activeStep !== null;
  const projects = useQuery({
    queryKey: ['demo-tour-projects', city?.id],
    enabled: enabled && Boolean(city),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/scenarios', { params: { query: { city_id: city!.id, limit: 100 } }, signal }))
    ).data.items as Scenario[],
  });
  const zones = useQuery({
    queryKey: ['demo-tour-zones', city?.id],
    enabled: enabled && Boolean(city),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/zones', { params: { query: { city_id: city!.id, limit: 200 } }, signal }))
    ).data.items as Zone[],
  });
  const programs = useQuery({
    queryKey: ['demo-tour-programs', city?.id],
    enabled: enabled && Boolean(city),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/programs', { params: { query: { city_id: city!.id, limit: 100 } }, signal }))
    ).data.items as Program[],
  });
  const heroZone = zones.data?.find((item) => item.name === 'Двор жилого квартала');
  const hero = projects.data?.find((item) => item.name === 'Вариант B · экономия воды' && item.zone_id === heroZone?.id);
  const problems = useQuery({
    queryKey: ['demo-tour-problems', city?.id, heroZone?.id],
    enabled: enabled && Boolean(city && heroZone),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/problems', {
        params: { query: { city_id: city!.id, limit: 100 } }, signal,
      }))
    ).data.items as DetectedProblem[],
  });
  const heroProblem = problems.data?.find((item) => item.zone_id === heroZone?.id && item.status !== 'dismissed')
    ?? problems.data?.find((item) => item.zone_id === heroZone?.id);
  const calculation = useQuery({
    queryKey: ['demo-tour-calculations', hero?.current_revision_id],
    enabled: enabled && Boolean(hero?.current_revision_id),
    queryFn: async ({ signal }) => (
      await unwrap<CalculationSnapshotPage>(api.GET('/v1/calculations', {
        params: { query: { scenario_revision_id: hero!.current_revision_id, limit: 50 } }, signal,
      }))
    ).data.items,
    select: (items): CalculationSnapshot | null => (
      [...items].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
    ),
  });
  const program = programs.data?.find((item) => item.name === 'Программа озеленения Павлодара · 2027')
    ?? programs.data?.find((item) => item.current_revision_id);
  const revisions = (projects.data ?? [])
    .filter((item) => item.zone_id === heroZone?.id)
    .map((item) => item.current_revision_id)
    .slice(0, 3);
  const heroParams = { revision: hero?.current_revision_id, calc: calculation.data?.id };
  const steps: TourStep[] = [
    {
      icon: 'map',
      title: 'Увидеть город и AI-слои',
      note: 'Карта сразу откроет выбранный двор, проблемы, приоритет и посадки проекта',
      href: heroZone ? withCity('/', city?.id, { zone: heroZone.id }) : null,
    },
    {
      icon: 'alertMap',
      title: 'Понять, почему начинаем здесь',
      note: 'Серверные причины проблем и решение специалиста по каждой территории',
      href: city && heroProblem ? withCity('/problems', city.id, { problem: heroProblem.id }) : null,
    },
    {
      icon: 'sprout',
      title: 'Открыть готовый проект',
      note: 'Точный вариант двора: растения, 3D, смета, приживаемость и уход',
      href: hero ? withCity(`/projects/${hero.id}`, city?.id, heroParams) : null,
    },
    {
      icon: 'compare',
      title: 'Сравнить три стратегии',
      note: 'Стоимость, вода и результат вариантов одной территории на одном экране',
      href: revisions.length >= 2 ? withCity('/compare', city?.id, { revisions: revisions.join(',') }) : null,
    },
    {
      icon: 'target',
      title: 'Собрать программу города',
      note: 'Приоритеты, бюджет, what-if и выбранный портфель участков',
      href: program ? withCity('/program', city?.id, { selected: program.id, revision: program.current_revision_id ?? undefined }) : null,
    },
    {
      icon: 'calendar',
      title: 'Передать план в исполнение',
      note: 'Календарь воды, трудозатрат и визитов по выбранной программе',
      href: city ? withCity('/execution', city.id) : null,
    },
    {
      icon: 'book',
      title: 'Проверить расчёт и отчёт',
      note: 'Неизменяемый результат, источники цифр и серверный PDF/XLSX',
      href: hero ? withCity(`/projects/${hero.id}`, city?.id, heroParams) : null,
    },
  ];
  const go = (index: number) => {
    const step = steps[index];
    if (!step?.href) return;
    setActiveStep(index);
    try { window.sessionStorage.setItem(TOUR_STEP_KEY, String(index)); } catch { /* session storage may be blocked */ }
    navigate(step.href);
    onClose();
    requestAnimationFrame(() => document.getElementById('main')?.scrollTo({ top: 0, behavior: 'smooth' }));
  };
  const finish = () => {
    setActiveStep(null);
    try { window.sessionStorage.removeItem(TOUR_STEP_KEY); } catch { /* session storage may be blocked */ }
  };
  const ready = steps.every((step) => step.href);
  const current = activeStep === null ? null : steps[activeStep];
  return (
    <>
      <Dialog
        open={open}
        title="Маршрут показа · 3 минуты"
        onClose={onClose}
        footer={(
          <>
            <Button variant="secondary" onClick={onClose}>Закрыть</Button>
            <Button variant="primary" icon="sprout" disabled={!ready} onClick={() => go(0)}>
              {ready ? 'Начать показ' : 'Готовим маршрут…'}
            </Button>
          </>
        )}
      >
        <div className="demo-tour__lead">
          <span><Icon name="sprout" size={22} /></span>
          <div><strong>От городской проблемы до проверяемого плана</strong><p>Маршрут использует готовый двор, его точный расчёт и текущую программу — без пустых экранов и ручного поиска.</p></div>
        </div>
        <ol className="demo-tour__steps">
          {steps.map((step, index) => (
            <li key={step.title} className={step.href ? '' : 'is-pending'}>
              <span className="demo-tour__number">{index + 1}</span>
              <Icon name={step.icon} size={19} />
              <div><strong>{step.title}</strong><small>{step.note}</small></div>
              <Button variant="secondary" size="sm" disabled={!step.href} onClick={() => go(index)}>Открыть</Button>
            </li>
          ))}
        </ol>
        <div className="demo-tour__assistant">
          <Icon name="chat" size={20} />
          <span><strong>Финальный акцент: спросите ассистента</strong><small>Он объяснит именно этот проект числами из серверных фактов и подготовит изменение только на подтверждение.</small></span>
          <Button variant="primary" size="sm" icon="chat" disabled={!hero} onClick={() => {
            if (hero) navigate(withCity(`/projects/${hero.id}`, city?.id, heroParams));
            setAssistantOpen(true);
            onClose();
          }}>Спросить ИИ</Button>
        </div>
      </Dialog>
      {current && activeStep !== null ? (
        <aside className="demo-tour-dock" aria-label="Маршрут демонстрации">
          <span className="demo-tour-dock__progress">Шаг {activeStep + 1} из {steps.length}</span>
          <Icon name={current.icon} size={20} />
          <span className="demo-tour-dock__copy"><strong>{current.title}</strong><small>{current.note}</small></span>
          <Button icon="chevronLeft" iconOnly variant="ghost" disabled={activeStep === 0} onClick={() => go(activeStep - 1)} aria-label="Предыдущий шаг" />
          {activeStep < steps.length - 1 ? (
            <Button icon="chevronRight" variant="primary" onClick={() => go(activeStep + 1)}>Дальше</Button>
          ) : (
            <Button icon="check" variant="primary" onClick={finish}>Завершить</Button>
          )}
          <Button icon="x" iconOnly variant="ghost" onClick={finish} aria-label="Закрыть маршрут" />
        </aside>
      ) : null}
    </>
  );
}
