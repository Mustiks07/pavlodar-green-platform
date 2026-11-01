/** Product-facing city label. Operational qualifiers remain in the city record and data screens. */
export function cityDisplayName(name: string): string {
  return name
    .replace(/\s+[—-]\s+(?:рабочий контур(?:\s+OSM)?|СИНТЕТИЧЕСКИЙ ТЕСТОВЫЙ КОНТУР)$/iu, '')
    .trim() || name;
}
