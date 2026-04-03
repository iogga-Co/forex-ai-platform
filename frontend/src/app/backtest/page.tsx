export default function BacktestPage() {
  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-100 mb-1">Backtest</h1>
      <p className="text-sm text-gray-500">
        Configure and run strategy backtests on historical OHLCV data.
        Results stream in real-time via WebSocket. Analytics suite renders on completion.
        Implemented in Phase 1 (engine) and Phase 3 (analytics).
      </p>
    </div>
  );
}
