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
// Page
// ---------------------------------------------------------------------------
export default function LiveTradingPage() {
  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-200 p-4 gap-6 overflow-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
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
      <div>
        <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-2">Live Prices</p>
        <div className="flex flex-wrap gap-3">
          {PAIRS.map((pair) => (
            <PriceCard key={pair} pair={pair} />
          ))}
        </div>
      </div>

      {/* Placeholder panels — filled in PR 2 */}
      <div className="flex gap-4 flex-1 min-h-0">
        <div className="flex-1 rounded border border-zinc-800 flex items-center justify-center">
          <p className="text-[11px] text-zinc-600">Signal log — coming in Phase 4 PR 2</p>
        </div>
        <div className="w-64 rounded border border-zinc-800 flex items-center justify-center">
          <p className="text-[11px] text-zinc-600">Open positions — coming in Phase 4 PR 3</p>
        </div>
      </div>

    </div>
  );
}
