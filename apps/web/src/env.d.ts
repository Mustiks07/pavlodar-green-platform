/// <reference types="vite/client" />
declare const __CONTRACT_VERSION__: string;
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /** MapLibre style URL for the basemap; empty disables the external basemap. */
  readonly VITE_BASEMAP_STYLE_URL?: string;
}
