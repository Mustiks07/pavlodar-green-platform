import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { tUi } from '../i18n';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  width?: string;
  align?: 'start' | 'end';
}

export interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  selectedId?: string | null;
  onSelect?: (row: T) => void;
  density?: 'compact' | 'regular';
  /** Server pagination: rendered as a real button only when the server returned a cursor. */
  footer?: ReactNode;
  maxHeight?: string;
}

const OVERSCAN = 8;
const VIRTUALIZE_FROM = 120;

/**
 * Table with its own scroll container (the page never scrolls horizontally), sticky
 * header, keyboard row navigation (arrows, Home/End, Enter/Space) and row windowing
 * once the loaded page set grows beyond VIRTUALIZE_FROM rows.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  getRowId,
  selectedId,
  onSelect,
  density = 'compact',
  footer,
  maxHeight = '100%',
}: DataTableProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, Math.min(rows.length, 60)]);
  // Must stay aligned with --pg-row-compact/--pg-row-regular: virtualization
  // uses this value to position rows and keyboard focus in long registries.
  const rowH = density === 'compact' ? 40 : 44;
  const virtual = rows.length > VIRTUALIZE_FROM;

  useEffect(() => {
    if (!virtual) return;
    const el = scroller.current;
    if (!el) return;
    const update = () => {
      const start = Math.max(0, Math.floor(el.scrollTop / rowH) - OVERSCAN);
      const end = Math.min(rows.length, Math.ceil((el.scrollTop + el.clientHeight) / rowH) + OVERSCAN);
      setRange([start, end]);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    return () => el.removeEventListener('scroll', update);
  }, [virtual, rows.length, rowH]);

  useEffect(() => {
    if (activeIndex >= rows.length) setActiveIndex(Math.max(0, rows.length - 1));
  }, [rows.length, activeIndex]);

  // Selection from outside (map click) scrolls the row into view: map -> table sync.
  useEffect(() => {
    if (!selectedId) return;
    const idx = rows.findIndex((r) => getRowId(r) === selectedId);
    if (idx < 0) return;
    setActiveIndex(idx);
    const el = scroller.current;
    if (el && virtual) el.scrollTop = Math.max(0, idx * rowH - el.clientHeight / 2);
    else el?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, rows, getRowId, virtual, rowH]);

  // Focus is applied after the render that brings the target row into the window.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const target = scroller.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (target) {
      pendingFocus.current = null;
      target.focus({ preventScroll: virtual });
    }
  });

  const focusRow = (idx: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, idx));
    setActiveIndex(clamped);
    const el = scroller.current;
    if (el && virtual) {
      const top = clamped * rowH;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
      const start = Math.max(0, Math.floor(el.scrollTop / rowH) - OVERSCAN);
      const end = Math.min(rows.length, Math.ceil((el.scrollTop + el.clientHeight) / rowH) + OVERSCAN);
      setRange([Math.min(start, clamped), Math.max(end, clamped + 1)]);
    }
    pendingFocus.current = rows[clamped] ? getRowId(rows[clamped]!) : null;
  };

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, idx: number, row: T) => {
    switch (e.key) {
      case 'ArrowDown':
        focusRow(idx + 1);
        break;
      case 'ArrowUp':
        focusRow(idx - 1);
        break;
      case 'Home':
        focusRow(0);
        break;
      case 'End':
        focusRow(rows.length - 1);
        break;
      case 'PageDown':
        focusRow(idx + 10);
        break;
      case 'PageUp':
        focusRow(idx - 10);
        break;
      case 'Enter':
      case ' ':
        onSelect?.(row);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const [start, end] = virtual ? range : [0, rows.length];
  const visible = rows.slice(start, end);

  return (
    <div className="pg-table-wrap">
      <div className="pg-table-scroll" ref={scroller} style={{ maxHeight }}>
        <table className={`pg-table pg-table--${density}`} aria-rowcount={rows.length + 1}>
          <caption className="pg-sr-only">
            {caption}, {tUi('table.rows', { count: rows.length })}
          </caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" style={{ width: c.width, textAlign: c.align === 'end' ? 'right' : undefined }}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {virtual && start > 0 ? (
              <tr aria-hidden style={{ height: start * rowH }}>
                <td colSpan={columns.length} />
              </tr>
            ) : null}
            {visible.map((row, i) => {
              const idx = start + i;
              const id = getRowId(row);
              const selected = id === selectedId;
              return (
                <tr
                  key={id}
                  data-row-id={id}
                  aria-rowindex={idx + 2}
                  aria-selected={onSelect ? selected : undefined}
                  className={selected ? 'is-selected' : undefined}
                  tabIndex={onSelect ? (idx === activeIndex ? 0 : -1) : undefined}
                  onClick={onSelect ? () => { setActiveIndex(idx); onSelect(row); } : undefined}
                  onKeyDown={onSelect ? (e) => onKey(e, idx, row) : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} style={{ textAlign: c.align === 'end' ? 'right' : undefined }}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {virtual && end < rows.length ? (
              <tr aria-hidden style={{ height: (rows.length - end) * rowH }}>
                <td colSpan={columns.length} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {footer ? <div className="pg-table-foot">{footer}</div> : null}
    </div>
  );
}
