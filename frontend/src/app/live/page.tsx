export default function LiveTradingPage() {
  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-100 mb-1">Live Trading</h1>
      <p className="text-sm text-gray-500">
        Real-time position monitor, signal feed, and kill switch. Only available after
        the 30-day paper trading gate is passed and LIVE_TRADING_ENABLED is set in Doppler.
        Implemented in Phase 4.
      </p>
    </div>
  );
}
