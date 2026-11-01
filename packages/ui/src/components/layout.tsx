import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './controls';
import { tUi } from '../i18n';

function readStored(key: string, fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* storage may be blocked; width is a per-viewer convenience only */
  }
}

export interface SidePanelProps {
  id: string;
  title: string;
  side?: 'left' | 'right';
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Collapsible, resizable panel over the map. The resize handle is a focusable
 * separator: arrows change width by 16 px, Home/End jump to limits.
 */
export function SidePanel({
  id,
  title,
  side = 'right',
  collapsed,
  onCollapsedChange,
  defaultWidth = 380,
  minWidth = 300,
  maxWidth = 640,
  actions,
  children,
}: SidePanelProps) {
  const storeKey = `pg.panel.${id}.width`;
  const [width, setWidth] = useState(() => readStored(storeKey, defaultWidth));
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = useCallback((w: number) => Math.min(maxWidth, Math.max(minWidth, w)), [minWidth, maxWidth]);

  useEffect(() => writeStored(storeKey, width), [storeKey, width]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
    const shrink = side === 'right' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === grow) setWidth((w) => clamp(w + 16));
    else if (e.key === shrink) setWidth((w) => clamp(w - 16));
    else if (e.key === 'Home') setWidth(minWidth);
    else if (e.key === 'End') setWidth(maxWidth);
    else return;
    e.preventDefault();
  };

  const headingId = `${id}-title`;

  if (collapsed) {
    return (
      <aside className={`pg-panel pg-panel--${side} is-collapsed`} aria-labelledby={headingId}>
        <Button
          variant="secondary"
          icon={side === 'right' ? 'chevronLeft' : 'chevronRight'}
          onClick={() => onCollapsedChange(false)}
          aria-expanded={false}
          aria-controls={`${id}-body`}
          className="pg-panel__reopen"
        >
          <span id={headingId}>{title}</span>
        </Button>
      </aside>
    );
  }

  return (
    <aside
      className={`pg-panel pg-panel--${side}`}
      style={{ ['--pg-panel-w' as string]: `${width}px` }}
      aria-labelledby={headingId}
    >
      <div
        className="pg-panel__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={tUi('action.resize')}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x;
          setWidth(clamp(drag.current.w + (side === 'right' ? -dx : dx)));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      />
      <header className="pg-panel__head">
        <h2 id={headingId}>{title}</h2>
        <div className="pg-panel__actions">
          {actions}
          <Button
            variant="ghost"
            iconOnly
            icon={side === 'right' ? 'chevronRight' : 'chevronLeft'}
            aria-label={tUi('action.collapse')}
            aria-expanded
            aria-controls={`${id}-body`}
            onClick={() => onCollapsedChange(true)}
          />
        </div>
      </header>
      <div className="pg-panel__body" id={`${id}-body`}>
        {children}
      </div>
    </aside>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="pg-page-head">
      <div>
        {eyebrow ? <p className="pg-page-head__eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="pg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="pg-page-head__actions">{actions}</div> : null}
    </header>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="pg-card">
      {title || actions ? (
        <header className="pg-card__head">
          {title ? <h3>{title}</h3> : <span />}
          {actions}
        </header>
      ) : null}
      <div className="pg-card__body">{children}</div>
    </section>
  );
}
