import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { unwrap, type Scenario, type Zone } from '@pg/api-client';
import { Button, Dialog, Icon, type IconName } from '@pg/ui';
import { api } from '../api';
import { useSession } from './session';
import { useUi } from './ui-store';

const STEPS: { icon: IconName; title: string; note: string; path: string }[] = [
  { icon: 'map', title: 'Увидеть город и AI-слои', note: 'Карта, проблемные зоны, приоритеты и будущие посадки', path: '/' },
  { icon: 'alertMap', title: 'Понять, где начинать', note: 'Причины проблем и действия для каждой территории', path: '/problems' },
  { icon: 'sprout', title: 'Открыть готовый проект', note: 'Подбор растений, смета, приживаемость, уход и эффект', path: '/projects' },
  { icon: 'compare', title: 'Сравнить варианты', note: 'Стоимость и результат разных стратегий на одном экране', path: '/compare' },
  { icon: 'target', title: 'Собрать программу города', note: 'Приоритеты, бюджет и оптимальная дорожная карта', path: '/program' },
  { icon: 'calendar', title: 'Передать решение в работу', note: 'Бригады, план-факт, осмотры и замены', path: '/execution' },
];

export function DemoTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { city } = useSession();
  const setAssistantOpen = useUi((state) => state.setAssistantOpen);
  const projects = useQuery({
    queryKey: ['demo-tour-projects', city?.id],
    enabled: open && Boolean(city),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/scenarios', { params: { query: { city_id: city!.id, limit: 100 } }, signal }))
    ).data.items as Scenario[],
  });
  const zones = useQuery({
    queryKey: ['demo-tour-zones', city?.id],
    enabled: open && Boolean(city),
    queryFn: async ({ signal }) => (
      await unwrap(api.GET('/v1/zones', { params: { query: { city_id: city!.id, limit: 200 } }, signal }))
    ).data.items as Zone[],
  });
  const heroZone = zones.data?.find((item) => item.name === 'Двор жилого квартала');
  const hero = projects.data?.find((item) => item.name === 'Вариант B · экономия воды' && item.zone_id === heroZone?.id);
  return (
    <Dialog open={open} title="Маршрут показа · 3 минуты" onClose={onClose} footer={<Button onClick={onClose}>Закрыть</Button>}>
      <div className="demo-tour__lead">
        <span><Icon name="sprout" size={22} /></span>
        <div><strong>От городской проблемы до контролируемого результата</strong><p>Идите по шагам — каждый открывает уже связанный рабочий контур платформы.</p></div>
      </div>
      <ol className="demo-tour__steps">
        {STEPS.map((step, index) => {
          const path = step.path === '/projects' && hero ? `/projects/${hero.id}` : step.path;
          const hrefParams = new URLSearchParams(city ? { city: city.id } : {});
          if (step.path === '/compare' && heroZone) {
            const revisions = (projects.data ?? []).filter((item) => item.zone_id === heroZone.id).map((item) => item.current_revision_id).slice(0, 3);
            if (revisions.length >= 2) hrefParams.set('revisions', revisions.join(','));
          }
          const href = `${path}${hrefParams.size ? `?${hrefParams}` : ''}`;
          return (
            <li key={step.path}>
              <span className="demo-tour__number">{index + 1}</span>
              <Icon name={step.icon} size={19} />
              <div><strong>{step.title}</strong><small>{step.note}</small></div>
              <Link className="pg-btn pg-btn--secondary pg-btn--sm" to={href} onClick={onClose}>Открыть</Link>
            </li>
          );
        })}
      </ol>
      <div className="demo-tour__assistant">
        <Icon name="chat" size={20} />
        <span><strong>Финальный акцент: спросите ассистента</strong><small>Он объяснит текущий проект цифрами из сервера и подготовит изменение только на подтверждение.</small></span>
        <Button variant="primary" size="sm" icon="chat" onClick={() => { setAssistantOpen(true); onClose(); }}>Спросить ИИ</Button>
      </div>
    </Dialog>
  );
}
