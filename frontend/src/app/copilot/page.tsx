"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import { fetchWithAuth } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface SirProposal {
  entry_conditions: unknown[];
  exit_conditions: unknown;
  filters?: unknown;
  position_sizing?: unknown;
  metadata?: { description?: string; version?: number };
}

interface Strategy {
  id: string;
  description: string;
  pair: string;
  timeframe: string;
  version: number;
  ir_json: SirProposal;
}

type SaveState = "idle" | "saving" | "saved" | "error";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return crypto.randomUUID();
  const key = "copilot_session_id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

function newSessionId(): string {
  const id = crypto.randomUUID();
  if (typeof window !== "undefined") {
    sessionStorage.setItem("copilot_session_id", id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function TurnBubble({ turn }: { turn: Turn }) {
  const isUser = turn.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={[
          "max-w-[80%] rounded-lg px-4 py-2 text-sm whitespace-pre-wrap",
          isUser
            ? "bg-accent text-white"
            : "bg-surface-raised text-gray-200 border border-surface-border",
        ].join(" ")}
      >
        {turn.content}
      </div>
    </div>
  );
}

function SirInspector({
  sir,
  onSaved,
  onDiscard,
}: {
  sir: SirProposal;
  onSaved: (id: string) => void;
  onDiscard: () => void;
}) {
  const [pair, setPair] = useState("EURUSD");
  const [timeframe, setTimeframe] = useState("1H");
  const [description, setDescription] = useState(sir.metadata?.description ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");

  async function handleSave() {
    if (!description.trim()) return;
    setSaveState("saving");
    setSaveError("");

    try {
      const res = await fetchWithAuth(`${API_BASE}/api/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ir_json: sir,
          description: description.trim(),
          pair: pair.toUpperCase().replace("/", ""),
          timeframe,
        }),
      });

      if (!res.ok) {
        const body = (await res.json()) as { detail?: string };
        throw new Error(body.detail ?? `HTTP ${res.status}`);
      }

      const saved = (await res.json()) as { id: string };
      setSaveState("saved");
      onSaved(saved.id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaveState("error");
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-surface-border">
        <h2 className="text-sm font-semibold text-gray-100">Strategy IR Proposal</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Review, then save to your strategy library.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono">
          {JSON.stringify(sir, null, 2)}
        </pre>
      </div>

      <div className="px-4 py-3 border-t border-surface-border space-y-2">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Strategy name / description (required to save)…"
          className="w-full rounded-md bg-surface border border-surface-border px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <div className="flex gap-2">
          <input
            value={pair}
            onChange={(e) => setPair(e.target.value)}
            placeholder="Pair"
            className="w-24 rounded-md bg-surface border border-surface-border px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            className="flex-1 rounded-md bg-surface border border-surface-border px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {["1m", "5m", "15m", "30m", "1H", "4H", "1D"].map((tf) => (
              <option key={tf} value={tf}>{tf}</option>
            ))}
          </select>
        </div>

        {saveState === "error" && (
          <p className="text-xs text-red-400">{saveError}</p>
        )}

        {saveState === "saved" ? (
          <div className="flex gap-2">
            <Link
              href="/strategies"
              className="flex-1 rounded-md bg-surface border border-surface-border py-2 text-center text-sm text-gray-300 hover:text-gray-100 transition-colors"
            >
              View in Strategies
            </Link>
            <button
              onClick={onDiscard}
              className="flex-1 rounded-md bg-accent py-2 text-sm text-white hover:bg-accent/80 transition-colors"
            >
              New proposal
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saveState === "saving" || !description.trim()}
              className="flex-1 rounded-md bg-accent py-2 text-sm text-white hover:bg-accent/80 disabled:opacity-40 transition-colors"
            >
              {saveState === "saving" ? "Saving…" : "Save Strategy"}
            </button>
            <button
              onClick={onDiscard}
              className="flex-1 rounded-md bg-surface border border-surface-border py-2 text-sm text-gray-400 hover:text-gray-100 transition-colors"
            >
              Discard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function CopilotPage() {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string>(() => getOrCreateSessionId());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pendingAssistant, setPendingAssistant] = useState("");
  const [sirProposal, setSirProposal] = useState<SirProposal | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loadingStrategy, setLoadingStrategy] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const refineLoadedRef = useRef(false);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!localStorage.getItem("access_token")) {
      router.push("/login");
      return;
    }
    // Load strategy list for the selector
    fetchWithAuth(`${API_BASE}/api/strategies`)
      .then((r) => r.ok ? r.json() : [])
      .then((data: Strategy[]) => setStrategies(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [router]);

  // If opened via Refine button (?strategy_id=...), pre-load context
  useEffect(() => {
    if (refineLoadedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const strategyId = params.get("strategy_id");
    if (!strategyId) return;
    refineLoadedRef.current = true;
    loadStrategy(strategyId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function loadStrategy(strategyId: string) {
    setLoadingStrategy(true);
    const backtestId = new URLSearchParams(window.location.search).get("backtest_id");

    const strategyReq = fetchWithAuth(`${API_BASE}/api/strategies/${strategyId}`)
      .then((r) => r.ok ? r.json() : null);
    const backtestReq = backtestId
      ? fetchWithAuth(`${API_BASE}/api/backtest/results/${backtestId}`).then((r) => r.ok ? r.json() : null)
      : Promise.resolve(null);

    Promise.all([strategyReq, backtestReq])
      .then(([strategy, backtest]) => {
        if (!strategy) return;
        setSirProposal(strategy.ir_json as SirProposal);
        const pct = (v: number | null) =>
          v !== null && v !== undefined ? (v * 100).toFixed(1) + "%" : "—";
        if (backtest) {
          const m = backtest.metrics;
          setInput(
            `I want to refine this strategy: "${strategy.description}" (${strategy.pair} ${strategy.timeframe}).\n\n` +
            `Last backtest (${backtest.period_start.slice(0, 10)} → ${backtest.period_end.slice(0, 10)}):\n` +
            `- Sharpe: ${m.sharpe?.toFixed(2) ?? "—"}\n` +
            `- Max Drawdown: ${pct(m.max_dd)}\n` +
            `- Win Rate: ${pct(m.win_rate)}\n` +
            `- Trades: ${m.trade_count}\n` +
            `- Total P&L: $${m.total_pnl?.toFixed(0) ?? "—"}\n\n` +
            `Please analyse these results and suggest specific improvements to the strategy rules.`
          );
        } else {
          setInput(
            `I want to refine this strategy: "${strategy.description}" (${strategy.pair} ${strategy.timeframe}).\n\n` +
            `Please analyse the current rules and suggest improvements.`
          );
        }
      })
      .finally(() => setLoadingStrategy(false));
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, pendingAssistant]);

  function startNewSession() {
    setSessionId(newSessionId());
    setTurns([]);
    setSirProposal(null);
    setPendingAssistant("");
    setInput("");
  }

  async function sendMessage(e: FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || streaming) return;

    setInput("");
    setTurns((prev) => [...prev, { role: "user", content: message }]);
    setStreaming(true);
    setPendingAssistant("");

    try {
      const res = await fetchWithAuth(`${API_BASE}/api/copilot/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message, system_prompt: systemPrompt }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let event = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            event = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const raw = line.slice(6);
            if (event === "text") {
              const chunk = JSON.parse(raw) as string;
              fullText += chunk;
              setPendingAssistant(fullText);
            } else if (event === "sir") {
              setSirProposal(JSON.parse(raw) as SirProposal);
            } else if (event === "done") {
              setTurns((prev) => [
                ...prev,
                { role: "assistant", content: fullText },
              ]);
              setPendingAssistant("");
            } else if (event === "error") {
              const msg = JSON.parse(raw) as string;
              setTurns((prev) => [
                ...prev,
                { role: "assistant", content: `Error: ${msg}` },
              ]);
              setPendingAssistant("");
            }
            event = "";
          }
        }
      }
    } catch (err) {
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
      setPendingAssistant("");
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="flex h-full gap-4 -m-6 p-0 overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Left — Chat panel                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-col flex-1 min-w-0 border-r border-surface-border">
        {/* Header */}
        <div className="px-5 py-4 border-b border-surface-border shrink-0">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-base font-semibold text-gray-100">AI Co-Pilot</h1>
              <p className="text-xs text-gray-500 mt-0.5">
                Describe your strategy in plain English. I will propose a Strategy IR.
              </p>
            </div>
            <button
              onClick={startNewSession}
              disabled={streaming}
              className="rounded-md border border-surface-border px-3 py-1.5 text-xs text-gray-400 hover:text-gray-100 disabled:opacity-40 transition-colors"
            >
              New session
            </button>
          </div>
          {/* Load existing strategy */}
          {strategies.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                defaultValue=""
                disabled={streaming || loadingStrategy}
                onChange={(e) => {
                  if (e.target.value) loadStrategy(e.target.value);
                  e.target.value = "";
                }}
                className="flex-1 rounded-md bg-surface border border-surface-border px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              >
                <option value="" disabled>Load existing strategy to refine…</option>
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.description || s.id.slice(0, 8)} ({s.pair} {s.timeframe} v{s.version})
                  </option>
                ))}
              </select>
              {loadingStrategy && (
                <span className="text-xs text-gray-500">Loading…</span>
              )}
            </div>
          )}
        </div>

        {/* System prompt — collapsible */}
        <div className="border-b border-surface-border shrink-0">
          <button
            onClick={() => setSystemPromptOpen((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            <span className="font-medium uppercase tracking-wide">System Prompt</span>
            <span>{systemPromptOpen ? "▲" : "▼"}</span>
          </button>
          {systemPromptOpen && (
            <div className="px-5 pb-3">
              <textarea
                rows={4}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Add custom instructions for the AI Co-Pilot (e.g. 'Focus on low-drawdown strategies', 'Always explain your reasoning step by step')…"
                className="w-full rounded-md bg-surface border border-surface-border px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-accent resize-none"
              />
            </div>
          )}
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {turns.length === 0 && !pendingAssistant && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-600 text-center max-w-xs">
                Start by describing the trading strategy you want to test. For example:
                &ldquo;Create a mean-reversion strategy on EURUSD using RSI and Bollinger Bands.&rdquo;
              </p>
            </div>
          )}

          {turns.map((turn, i) => (
            <TurnBubble key={i} turn={turn} />
          ))}

          {pendingAssistant && (
            <TurnBubble
              turn={{ role: "assistant", content: pendingAssistant + "▋" }}
            />
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <form
          onSubmit={sendMessage}
          className="px-5 py-4 border-t border-surface-border shrink-0 flex gap-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe your strategy…"
            disabled={streaming}
            className="flex-1 rounded-md bg-surface border border-surface-border px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={streaming || !input.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent/80 disabled:opacity-40 transition-colors"
          >
            {streaming ? "…" : "Send"}
          </button>
        </form>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Right — Strategy IR inspector                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="w-80 shrink-0">
        {sirProposal ? (
          <SirInspector
            sir={sirProposal}
            onSaved={() => {/* toast could go here */}}
            onDiscard={() => setSirProposal(null)}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-gray-600 text-center px-4">
              Strategy IR proposals from the Co-Pilot will appear here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
