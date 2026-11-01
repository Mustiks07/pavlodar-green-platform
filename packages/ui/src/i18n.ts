/**
 * Minimal typed i18n layer (TZ §22: strings go through i18n so Kazakh can be added
 * without rewriting components). Each package owns its dictionary; keys are checked
 * by TypeScript, parameters use {name} placeholders.
 */
export type Dictionary = Record<string, string>;

export function createTranslator<D extends Dictionary>(dict: D) {
  return function t(key: keyof D & string, params?: Record<string, string | number>): string {
    const template = dict[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, name: string) =>
      name in params ? String(params[name]) : `{${name}}`,
    );
  };
}

export const uiRu = {
  'state.loading': 'Загрузка…',
  'state.loading.slow': 'Ответ идёт дольше обычного. Запрос будет прерван через {seconds} с.',
  'state.loading.offline': 'Нет сети: загрузка начнётся сама, когда связь восстановится.',
  'state.empty': 'Нет записей',
  'state.partial': 'Данные неполные',
  'state.unavailable': 'Нет данных',
  'state.error': 'Не удалось загрузить',
  'state.stale': 'Результат устарел',
  'state.forbidden': 'Нет доступа',
  'state.conflict': 'Версия изменилась',
  'state.unauthenticated': 'Требуется вход',
  'state.timeout': 'Сервер не ответил вовремя',
  'state.network': 'Нет соединения с сервером',
  'state.notFound': 'Объект не найден или недоступен',
  'state.details': 'Подробности',
  'state.requestId': 'Код запроса',
  'action.retry': 'Повторить',
  'action.close': 'Закрыть',
  'action.cancel': 'Отменить',
  'action.collapse': 'Свернуть панель',
  'action.expand': 'Развернуть панель',
  'action.resize': 'Изменить ширину панели',
  'action.loadMore': 'Загрузить ещё',
  'prov.measured': 'Измерено',
  'prov.estimated': 'Оценка',
  'prov.synthetic': 'Оценочный профиль',
  'prov.unavailable': 'Нет данных',
  'prov.synthetic.banner': 'Оценочный профиль: значения показывают работу расчёта и не являются измерениями города',
  'metric.horizon': 'горизонт {years} лет',
  'metric.horizon.now': 'текущее состояние',
  'metric.interval': 'интервал {lower}–{upper}',
  'metric.confidence': 'уверенность: {level}',
  'metric.confidence.high': 'высокая',
  'metric.confidence.medium': 'средняя',
  'metric.confidence.low': 'низкая',
  'metric.confidence.unknown': 'не оценена',
  'metric.method': 'Метод',
  'metric.sources': 'Источники',
  'metric.noSources': 'источники не указаны',
  'metric.requiredInputs': 'Нужны входные данные',
  'metric.blocking': 'блокирует расчёт',
  'metric.unknownUnit': 'единица «{unit}» отсутствует в справочнике единиц контракта',
  'metric.unitMismatch': 'единица отличается от справочника показателей ({expected})',
  'cost.total': 'Итого',
  'cost.incomplete': 'Смета неполная',
  'cost.knownSubtotal': 'Известная часть: {amount}',
  'cost.knownSubtotal.note': 'не является полным бюджетом',
  'cost.missingPrice': 'нет цены',
  'save.idle': 'Сохранено на сервере',
  'save.editing': 'Есть несохранённые изменения',
  'save.saving': 'Сохранение…',
  'save.saved': 'Сохранено, ревизия {revision}',
  'save.failed': 'Не сохранено',
  'save.conflict': 'Конфликт версий',
  'job.queued': 'В очереди',
  'job.running': 'Выполняется',
  'job.succeeded': 'Готово',
  'job.failed': 'Ошибка',
  'job.cancel_requested': 'Отмена запрошена',
  'job.cancelled': 'Отменено',
  'job.phase': 'Этап: {phase}',
  'job.phaseUnknown': 'этап не сообщён',
  'job.progressUnknown': 'доля выполнения неизвестна',
  'job.attempt': 'попытка {n}',
  'legend.title': 'Легенда',
  'legend.unit': 'Единица',
  'legend.period': 'Период',
  'legend.source': 'Источник',
  'legend.unknown': 'нет данных',
  'legend.notProvided': 'Сервер не передал легенду для этого слоя',
  'legend.stale': 'Слой построен по устаревшей версии данных',
  'table.rows': '{count} строк',
  'table.selected': 'выбрано',
  'dialog.close': 'Закрыть диалог',
} as const satisfies Dictionary;

export const tUi = createTranslator(uiRu);
