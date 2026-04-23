"use client";

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"];

// JPY pairs quote in 2 dp (1 pip = 0.01); all others 4 dp (1 pip = 0.0001)
const PIP: Record<string, number> = { USDJPY: 100, GBPJPY: 100 };

function pipValue(pair: string): number {
  return PIP[pair] ?? 10000;
}

function spreadPips(pair: string, bid: number, ask: number): string {
  return ((ask - bid) * pipValue(pair)).toFixed(1);
}

function priceDP(pair: string): number {
  return PIP[pair] ? 3 : 5;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PriceState {
  bid: number | null;
  ask: number | null;
  updatedAt: number | null;   // Date.now() of last tick
  flash: "up" | "down" | null;
}

const EMPTY_PRICE: PriceState = { bid: null, ask: null, updatedAt: null, flash: null };
const STALE_MS = 15_000;     // mark stale if no tick for 15 s

// ---------------------------------------------------------------------------
// WebSocket URL helper
// ---------------------------------------------------------------------------
function wsUrl(pair: string): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/prices/${pair}`;
}

// ---------------------------------------------------------------------------
// Single-pair hook
// ---------------------------------------------------------------------------
function usePriceFeed(pair: string): PriceState & { connected: boolean } {
  const [state, setState] = useState<PriceState>(EMPTY_PRICE);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const prevBidRef = useRef<number | null>(null);

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let staleTimer: ReturnType<typeof setTimeout>;
    let unmounted = false;

    function connect() {
      if (unmounted) return;
      ws = new WebSocket(wsUrl(pair));
      wsRef.current = ws;

      ws.onopen = () => {
        if (!unmounted) setConnected(true);
      };

      ws.onmessage = (ev) => {
        if (unmounted) return;
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type !== "tick") return;

          const { bid, ask } = msg as { bid: number; ask: number };
          const prev = prevBidRef.current;
          const flash: "up" | "down" | null =
            prev === null ? null : bid > prev ? "up" : bid < prev ? "down" : null;
          prevBidRef.current = bid;

          setState({ bid, ask, updatedAt: Date.now(), flash });

          // Clear flash after 400 ms
          clearTimeout(staleTimer);
          staleTimer = setTimeout(() => {
            setState((s) => ({ ...s, flash: null }));
          }, 400);
        } catch { /* ignore parse errors */ }
      };

      ws.onclose = () => {
        if (!unmounted) {
          setConnected(false);
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      clearTimeout(staleTimer);
      wsRef.current?.close();
    };
  }, [pair]);

  return { ...state, connected };
}

// ---------------------------------------------------------------------------
// Price card
// ---------------------------------------------------------------------------
function PriceCard({ pair }: { pair: string }) {
  const { bid, ask, updatedAt, flash, connected } = usePriceFeed(pair);
  const dp = priceDP(pair);
  const stale = updatedAt !== null && Date.now() - updatedAt > STALE_MS;
  const spread = bid !== null && ask !== null ? spreadPips(pair, bid, ask) : null;

  const flashCls =
    flash === "up"   ? "text-green-400" :
    flash === "down" ? "text-red-400"   : "text-zinc-100";

  return (
    <div className={[
      "flex flex-col gap-1 rounded border px-4 py-3 min-w-[140px]",
      stale ? "border-zinc-700 opacity-50" : "border-zinc-700 bg-zinc-900",
    ].join(" ")}>
      {/* Pair name + status dot */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-zinc-400 tracking-wider">{pair}</span>
        <span className={[
          "h-1.5 w-1.5 rounded-full",
          !connected ? "bg-zinc-600" : stale ? "bg-yellow-500" : "bg-green-500",
        ].join(" ")} />
      </div>

      {bid !== null && ask !== null ? (
        <>
          {/* Bid / Ask */}
          <div className={`text-xl font-mono font-semibold tabular-nums transition-colors duration-200 ${flashCls}`}>
            {bid.toFixed(dp)}
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-zinc-500">Ask <span className="text-zinc-300">{ask.toFixed(dp)}</span></span>
            {spread !== null && (
              <span className="text-zinc-500">{spread} pip</span>
            )}
          </div>
        </>
      ) : (
        <div className="text-sm text-zinc-600 animate-pulse">
          {connected ? "Waiting…" : "Connecting…"}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signal log types + hook
// ---------------------------------------------------------------------------
interface SignalEntry {
  timestamp:     string;
  pair:          string;
  timeframe:     string;
  direction:     string;
  strategy_id:   string;
  strategy_name: string;
  shadow:        boolean;
}

function useSignalLog(maxEntries = 50): { signals: SignalEntry[]; connected: boolean } {
  const [signals,   setSignals]   = useState<SignalEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let unmounted = false;

    function connect() {
      if (unmounted) return;
      if (typeof window === "undefined") return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws/signals`);
      wsRef.current = ws;

      ws.onopen  = () => { if (!unmounted) setConnected(true); };
      ws.onclose = () => {
        if (!unmounted) {
          setConnected(false);
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        if (unmounted) return;
        try {
          const msg = JSON.parse(ev.data as string);
          if (!msg.pair) return;  // keepalive or non-signal message
          setSignals(prev => [msg, ...prev].slice(0, maxEntries));
        } catch { /* ignore parse errors */ }
      };
    }

    connect();
    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [maxEntries]);

  return { signals, connected };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function LiveTradingPage() {
  const { signals, connected: sigConnected } = useSignalLog();

  function formatTime(ts: string): string {
    try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
    catch { return ts; }
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-200 p-4 gap-4 overflow-auto">

      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-zinc-100">Live Trading</h1>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Real-time OANDA prices · Shadow mode — signal logging only
          </p>
        </div>
        <span className="rounded border border-yellow-700 px-2 py-0.5 text-[10px] text-yellow-500 font-medium">
          SHADOW MODE
        </span>
      </div>

      {/* Price ticker strip */}
      <div className="shrink-0">
        <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-2">Live Prices</p>
        <div className="flex flex-wrap gap-3">
          {PAIRS.map((pair) => (
            <PriceCard key={pair} pair={pair} />
          ))}
        </div>
      </div>

      {/* Main area */}
      <div className="flex gap-4 flex-1 min-h-0">

        {/* Signal log */}
        <div className="flex-1 flex flex-col rounded border border-zinc-800 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              Signal Log
            </span>
            <div className="flex items-center gap-1.5">
              <span className={["h-1.5 w-1.5 rounded-full", sigConnected ? "bg-green-500" : "bg-zinc-600"].join(" ")} />
              <span className="text-[10px] text-zinc-600">{signals.length} signals</span>
            </div>
          </div>

          {signals.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[11px] text-zinc-600">
                {sigConnected
                  ? "Waiting for signals — engine checks strategies on each completed bar"
                  : "Connecting to signal feed…"}
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="border-b border-zinc-800 sticky top-0 bg-zinc-950">
                  <tr>
                    {["Time","Pair","TF","Direction","Strategy","Mode"].map(h => (
                      <th key={h} className="text-left px-3 py-1.5 text-[10px] text-zinc-500 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {signals.map((s, i) => (
                    <tr key={i} className="hover:bg-zinc-900/40">
                      <td className="px-3 py-1.5 text-zinc-500 tabular-nums">{formatTime(s.timestamp)}</td>
                      <td className="px-3 py-1.5 font-semibold text-zinc-200">{s.pair}</td>
                      <td className="px-3 py-1.5 text-zinc-400">{s.timeframe}</td>
                      <td className="px-3 py-1.5">
                        <span className={s.direction === "long" ? "text-green-400" : "text-red-400"}>
                          {s.direction === "long" ? "▲ Long" : "▼ Short"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-zinc-400 truncate max-w-[160px]" title={s.strategy_name}>
                        {s.strategy_name}
                      </td>
                      <td className="px-3 py-1.5">
                        {s.shadow ? (
                          <span className="rounded border border-yellow-800 px-1.5 py-0.5 text-[9px] text-yellow-500">SHADOW</span>
                        ) : (
                          <span className="rounded border border-green-800 px-1.5 py-0.5 text-[9px] text-green-400">LIVE</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Open positions placeholder — PR 3 */}
        <div className="w-64 shrink-0 rounded border border-zinc-800 flex items-center justify-center">
          <p className="text-[11px] text-zinc-600 text-center px-4">Open positions<br/>— Phase 4 PR 3</p>
        </div>

      </div>
    </div>
  );
}
