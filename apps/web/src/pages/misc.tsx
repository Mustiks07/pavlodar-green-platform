import { Link, useLocation, useSearchParams } from 'react-router';
import { Icon, PageHeader } from '@pg/ui';
import { t } from '../i18n';
import { ComparePanel } from '../features/calculations/ComparePanel';
import { CityGate } from '../shell/gates';

function useCityQuery() {
  const [params] = useSearchParams();
  const city = params.get('city');
  return city ? `?city=${encodeURIComponent(city)}` : '';
}

export function ComparePage() {
  return (
    <div className="app-page">
      <PageHeader title={t('page.compare')} description={t('page.compare.desc')} eyebrow={t('page.compare.eyebrow')} />
      <section className="cmp-guide" aria-label="Как сравнить проекты">
        <article><span>1</span><div><strong>Выберите варианты</strong><small>От двух до трёх проектов участков</small></div></article>
        <Icon name="chevronRight" size={18} />
        <article><span>2</span><div><strong>Сопоставьте результаты</strong><small>Стоимость, уход и экологические эффекты</small></div></article>
        <Icon name="chevronRight" size={18} />
        <article><span>3</span><div><strong>Примите решение</strong><small>Откройте подходящий проект и продолжите работу</small></div></article>
      </section>
      <CityGate>{(city) => <ComparePanel city={city} />}</CityGate>
    </div>
  );
}

export function NotFoundPage() {
  const q = useCityQuery();
  const location = useLocation();
  return (
    <div className="app-page app-page--centered">
      <section className="app-notfound" aria-labelledby="not-found-title">
        <span className="app-notfound__icon" aria-hidden><Icon name="alertMap" size={27} /></span>
        <p className="app-eyebrow">{t('page.notFound.eyebrow')}</p>
        <h1 id="not-found-title">{t('page.notFound')}</h1>
        <p>{t('page.notFound.desc')}</p>
        <p>{t('page.notFound.next')}</p>
        <Link className="pg-btn pg-btn--primary pg-btn--md" to={`/${q}`}>
          <Icon name="chevronLeft" size={16} /> {t('page.toMap')}
        </Link>
        <details className="app-notfound__details">
          <summary>{t('page.notFound.details')}</summary>
          <code className="pg-code">{location.pathname}</code>
        </details>
      </section>
    </div>
  );
}
