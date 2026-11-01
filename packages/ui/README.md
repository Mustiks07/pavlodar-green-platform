# @pg/ui — design system (WP-02)

Tokens (`src/tokens.css`), base and component styles (`src/components.css`) and React
components used by `apps/web`. Light and dark themes, `prefers-reduced-motion`,
WCAG AA contrast target (checked by `apps/web/scripts/check-contrast.mjs`).

Rules the components enforce:
- `null` is never rendered as `0`: `MetricValue`, `MoneyText`, `CostSummary` show
  «Нет данных» / «нет цены» with the server's `DataGap`.
- Provenance measured/estimated/synthetic/unavailable is icon + word + pattern, not color alone.
- Money is a decimal string regrouped as text; no floating point formatting.
- `CostSummary` shows a total only for `status=complete`; `known_subtotal` is labelled as not a budget.
- `JobStatus` shows a percent only when `progress` is non-null; phases otherwise.
- `SaveStatus` distinguishes editing / saving / saved / failed / conflict.
- `Skeleton` never renders digits.
- `DataTable` scrolls inside itself, supports keyboard row navigation and windowing.
- `SidePanel` is collapsible and resizable with pointer and keyboard.

Live catalogue of every component and state: run the web app in dev and open `/dev/ui`.
