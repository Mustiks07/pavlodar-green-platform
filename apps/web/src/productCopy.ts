/** Keep technical provenance exact in storage while presenting it in clear Russian. */
export function productLabel(value: string): string {
  const clean = value
    .replace(/^SYNTHETIC TEST\s*[·:]\s*(?=Оценочный профиль)/iu, '')
    .replace(/^SYNTHETIC TEST\s*[·:]\s*/iu, '')
    .replace(/\bSYNTHETIC TEST\b/giu, '')
    .replace(/Оценочный профиль\s*MVP\s*[·:]?\s*/giu, '')
    .replace(/Оценочный профиль\s*[·:]?\s*/giu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const known: Array<[RegExp, string]> = [
    [/проектн(?:ые|ая) правил/iu, 'Проектные правила'],
    [/survival|приживаем/iu, 'Прогноз приживаемости'],
    [/эколог|environment/iu, 'Экологические показатели'],
    [/населен|population/iu, 'Расчётное население'],
    [/расцен|rate/iu, 'Плановые расценки'],
    [/пригодност|suitability/iu, 'Пригодность растений'],
    [/остат|stock/iu, 'Доступность посадочного материала'],
    [/озелен|green.inventory/iu, 'Существующее озеленение'],
    [/почв|soil/iu, 'Почвенные условия'],
  ];
  return known.find(([pattern]) => pattern.test(clean))?.[1] ?? (clean || 'Городской слой');
}

/** Technical model and catalogue inputs are useful to calculations but not as map overlays. */
export function isProductMapLayer(layer: { name: string; category: string }): boolean {
  const name = layer.name.toLocaleLowerCase('ru');
  if (/synthetic test|оценочный профиль|\bmvp\b/iu.test(name)) return false;
  return !['catalog', 'rate', 'stock', 'model', 'rule'].includes(layer.category);
}
