import { useEffect, type ReactNode } from 'react';
import { Button, DataTable, Skeleton, StateView, tUi, type Column } from '@pg/ui';
import { useCursorList, useOperationAvailable, type Page } from '../../api';
import { t } from '../../i18n';
import { ApiErrorView } from '../../shell/ApiErrorView';
import { OperationUnavailable } from '../../shell/OperationUnavailable';

export interface ResourceListProps<T> {
  resource: string;
  /** Canonical operationId; checked against the server's implemented subset. */
  operationId: string;
  caption: string;
  params: Record<string, string | number | undefined>;
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>;
  columns: Column<T>[];
  getRowId: (row: T) => string;
  /** Empty state; `actions` points to the nearest step the user can take instead. */
  empty: { title: string; description?: string; actions?: ReactNode };
  selectedId?: string | null;
  onSelect?: (row: T) => void;
  toolbar?: ReactNode;
  /** Receives all loaded rows (e.g. to resolve the selected item for a detail card). */
  onRows?: (rows: T[]) => void;
}

/**
 * Server-paginated list with every state: loading skeleton, typed errors with retry,
 * empty, refreshing (filter change keeps previous rows but marks them), and a real
 * "load more" bound to next_cursor.
 */
export function ResourceList<T>({
  resource,
  operationId,
  caption,
  params,
  fetchPage,
  columns,
  getRowId,
  empty,
  selectedId,
  onSelect,
  toolbar,
  onRows,
}: ResourceListProps<T>) {
  const available = useOperationAvailable(operationId);
  const q = useCursorList(resource, params, fetchPage, available !== false);

  const loaded = q.data?.pages;
  useEffect(() => {
    onRows?.(loaded?.flatMap((p) => p.items) ?? []);
    // onRows is a setter from the parent; reacting to loaded pages is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  let body: ReactNode;
  if (available === false) {
    body = <OperationUnavailable operationId={operationId} />;
  } else if (q.isPending) {
    body = (
      <div className="app-list__loading" role="status" aria-label={tUi('state.loading')}>
        <Skeleton lines={6} />
      </div>
    );
  } else if (q.isError && !q.data) {
    body = <ApiErrorView error={q.error} onRetry={() => void q.refetch()} />;
  } else {
    const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
    if (rows.length === 0 && !q.isPlaceholderData) {
      body = <StateView state="empty" title={empty.title} description={empty.description} actions={empty.actions} />;
    } else {
      body = (
        <div className={q.isPlaceholderData ? 'app-list__table is-refreshing' : 'app-list__table'} aria-busy={q.isFetching}>
          <DataTable
            caption={caption}
            columns={columns}
            rows={rows}
            getRowId={getRowId}
            selectedId={selectedId}
            onSelect={onSelect}
            footer={
              <>
                <span>
                  {t('list.loaded', { count: rows.length })}
                  {q.isPlaceholderData ? ` · ${t('list.refreshing')}` : null}
                </span>
                {q.isFetchNextPageError ? <ApiErrorView compact error={q.error} onRetry={() => void q.fetchNextPage()} /> : null}
                {q.hasNextPage ? (
                  <Button size="sm" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                    {t('list.loadMore')}
                  </Button>
                ) : (
                  <span>{t('list.end')}</span>
                )}
              </>
            }
          />
        </div>
      );
    }
  }

  return (
    <div className="app-list">
      {toolbar && available !== false ? <div className="app-list__toolbar">{toolbar}</div> : null}
      {body}
    </div>
  );
}
