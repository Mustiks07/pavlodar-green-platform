const PLANT_IMAGES: Record<string, string> = {
  'populus alba': '/plants/populus-alba.webp',
  'pinus sylvestris': '/plants/pinus-sylvestris.webp',
  'tilia cordata': '/plants/tilia-cordata.webp',
  'picea obovata': '/plants/picea-obovata.webp',
  'syringa vulgaris': '/plants/syringa-vulgaris.webp',
  'ricinus communis': '/plants/ricinus-communis.webp',
  'salix sp.': '/plants/salix-sp.webp',
  'acer sp.': '/plants/acer-sp.webp',
  'fraxinus sp.': '/plants/fraxinus-sp.webp',
};

/** Curated botanical artwork for catalogue species. Unknown species keep a neutral leaf mark. */
export function plantImage(latinName: string): string | null {
  return PLANT_IMAGES[latinName.trim().toLowerCase()] ?? null;
}
