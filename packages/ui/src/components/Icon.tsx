import type { SVGProps } from 'react';

/** 24x24 stroke icons. Decorative by default; pass `label` when the icon is the only content. */
const PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.7 2.7L16.5 9.5',
  alert: 'M12 3.5L2.5 20h19L12 3.5zM12 10v4.5M12 17.2v.3',
  error: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.8v.3',
  lock: 'M6.5 10.5h11v9.5h-11zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
  refresh: 'M19.5 8A8 8 0 0 0 5 7.2M4.5 4v3.5H8M4.5 16A8 8 0 0 0 19 16.8M19.5 20v-3.5H16',
  conflict: 'M6 3.5v17M6 8.5c6 0 6 7 12 7M18 3.5v17',
  slash: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
  ruler: 'M3.5 15.5l12-12 5 5-12 12zM7.5 11.5l2 2M10.5 8.5l2 2M13.5 5.5l2 2',
  approx: 'M4.5 9.5c2-2 4-2 7.5 0s5.5 2 7.5 0M4.5 15c2-2 4-2 7.5 0s5.5 2 7.5 0',
  flask: 'M9.5 3.5h5M10.5 3.5v6L5 19.5h14l-5.5-10v-6M7.5 15h9',
  inbox: 'M3.5 13.5l2.5-8h12l2.5 8v6h-17zM3.5 13.5h5l1.5 2.5h4l1.5-2.5h5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c1-4 4-5.5 7.5-5.5s6.5 1.5 7.5 5.5',
  login: 'M14 4.5h5v15h-5M10 8l4 4-4 4M14 12H3.5',
  logout: 'M10 4.5H5v15h5M15 8l4 4-4 4M19 12H8.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  x: 'M6 6l12 12M18 6L6 18',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  map: 'M3.5 6l5.5-2 6 2 5.5-2v14l-5.5 2-6-2-5.5 2zM9 4v14M15 6v14',
  layers: 'M12 3.5l9 4.5-9 4.5-9-4.5zM3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5',
  alertMap: 'M12 21s-7-6-7-11.5a7 7 0 0 1 14 0C19 15 12 21 12 21zM12 7v4M12 13.5v.3',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  sprout: 'M12 21v-9M12 12c0-4.5 3-7 8-7 0 4.5-3 7-8 7zM12 14.5c0-3.5-2.5-5.5-7-5.5 0 3.5 2.5 5.5 7 5.5z',
  compare: 'M4 4.5h7v15H4zM13 4.5h7v15h-7z',
  book: 'M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3zM5 16.5a3 3 0 0 1 3-3h11',
  calendar: 'M4 6h16v14H4zM4 10h16M8.5 3.5v4M15.5 3.5v4',
  upload: 'M12 15.5V4M7.5 8.5L12 4l4.5 4.5M4.5 15v4.5h15V15',
  table: 'M4 5h16v14H4zM4 10h16M4 14.5h16M10 5v14',
  database: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  shield: 'M12 3l7.5 3v6c0 4.5-3.2 7.7-7.5 9-4.3-1.3-7.5-4.5-7.5-9V6z',
  chat: 'M4.5 5h15v10.5H10L5.5 19.5v-4h-1z',
  palette: 'M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-1.5 3.3c.6.8 0 2.7-2.5 2.7zM7.5 11.5h.01M10 7.5h.01M15 7.5h.01',
  external: 'M14 4.5h5.5V10M19.5 4.5L11 13M17 14v5.5H4.5V7H10',
  plus: 'M12 5v14M5 12h14',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  dot: 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  label?: string;
}

export function Icon({ name, size = 16, label, className, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `pg-icon ${className}` : 'pg-icon'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
