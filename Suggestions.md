# Project Suggestions & UX Refinements

This document tracks identified opportunities for improving the codebase, user experience, and technical stability of the Forex AI Trading Platform.

## 1. Frontend & UX Improvements

### Backtest Result Panel (`BacktestResultPanel.tsx`)
- [x] **Code Cleanup**: Prune unused variables and types (e.g., `StrategyIrShape.metadata`, `ConditionCard`, `fmtPct`) to reduce bundle size and improve maintainability.
- [x] **"Go to Trade" Navigation**: Implement a feature where clicking a trade in the table scrolls and zooms the candlestick chart to the specific entry and exit bars of that trade.
- [x] **Metric Tooltips**: Add hover tooltips explaining the significance of specific metrics like Sharpe Ratio, Profit Factor, and R-Multiple for less experienced users. *(5.2.4)*
- [x] **Dual-Axis Equity Chart**: Combine the Equity Curve and Drawdown charts into a single dual-axis chart to better visualize the relationship between account growth and risk. *(5.2.7)*
- [ ] **Loading State Polish**: Enhance the skeleton loaders to more accurately reflect the final layout, preventing "layout shift" when data arrives. *(5.2.8)*
- [ ] **Indeterminate Checkbox Fix**: Ensure the "Select All" checkbox correctly shows an indeterminate state when only a partial set of trades is selected.

### General UI/UX
- [x] **Global Density Toggle**: Add a settings option to toggle between "Compact" (current) and "Spacious" UI modes. *(5.2.10)*
- [ ] **Dark Mode Refinement**: Review color contrast for slate/gray text against dark backgrounds to ensure WCAG accessibility compliance. *(5.2.11)*
- [x] **Notification System**: Replace standard `alert()` or console logs with a toast notification system (`sonner`) for background task completion. *(5.2.1)*

## 2. Technical Audit Findings (Critical & High Risk)

### Live Execution Safety
- [x] **ATR Fallback**: Signal engine passes real-time ATR in the signal payload; executor aborts if ATR is missing or zero. *(5.0.1)*
- [x] **Pip Size Detection**: `InstrumentRegistry` (`core/instruments.py`) centralises pip sizes; replaces `"JPY" in symbol` hacks. *(5.0.3)*
- [x] **Position Reconciliation**: `_reconcile_on_startup()` syncs stale `live_orders` against OANDA on every boot. *(5.0.2)*

### Security & Authentication
- [x] **MFA for Live Trading**: TOTP-based MFA (`pyotp`) implemented; `require_mfa` dependency guards kill-switch. *(5.0.4)*
- [x] **Process Isolation**: `trading-service` Docker container decouples feed + engine + executor from FastAPI. *(5.1)*

## 3. Technical & Architectural Stability

### SSE (Server-Sent Events)
- [x] **Heartbeat Hardening**: Feed raises after 30s of no OANDA heartbeat; client-side SSE exponential backoff (1s→30s cap) implemented. *(5.2.2, 5.2.5)*

### Backtesting Engine
- [ ] **Performance Profiling**: Profile `vectorbt` execution for multi-year backtests to identify bottlenecks in SIR parsing or indicator computation.

### Data Pipeline
- [x] **Automated Quality Checks**: `backfill.py` `--strict` flag aborts on gap detection; quality checks integrated. *(5.2.6)*

## 4. Documentation & Workflow
- [ ] **API Documentation**: Creating a simplified "Frontend Integration Guide" for the various `diagnosis` and `analytics` endpoints. *(5.2.14)*
- [x] **Test Coverage**: 24 vitest tests covering `strategyLabels.ts` — all indicators, MACD/BB edge cases. *(5.2.13)*
