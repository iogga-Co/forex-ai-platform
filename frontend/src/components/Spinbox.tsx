"use client";

import { useRef } from "react";

interface SpinboxProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  float?: boolean;
  onChange: (v: number) => void;
  onFocus?: () => void;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  width?: string;
}

export default function Spinbox({
  value,
  min = 1,
  max = 9999,
  step = 1,
  float = false,
  onChange,
  onFocus,
  onClick,
  active = false,
  width = "w-11",
}: SpinboxProps) {
  const timerRef  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const repeatRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // Decimal places implied by step (e.g. 0.1 → 1, 0.01 → 2, 1 → 0)
  const decimals = float
    ? (step.toString().split(".")[1]?.length ?? 0)
    : 0;
  const round = (n: number) => float ? parseFloat(n.toFixed(decimals)) : Math.round(n);
  const displayValue = round(value);

  function increment() {
    const next = round(Math.min(max, value + step));
    if (next !== value) onChange(next);
  }

  function decrement() {
    const next = round(Math.max(min, value - step));
    if (next !== value) onChange(next);
  }

  function startRepeat(fn: () => void) {
    fn();
    timerRef.current = setTimeout(() => {
      repeatRef.current = setInterval(fn, 80);
    }, 400);
  }

  function stopRepeat() {
    clearTimeout(timerRef.current);
    clearInterval(repeatRef.current);
  }

  const borderCls = active ? "border-blue-500" : "border-zinc-600";

  return (
    <div className={`flex border rounded overflow-hidden shrink-0 ${borderCls} ${width}`}>
      <input
        type="number"
        value={displayValue}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = round(parseFloat(e.target.value));
          if (!isNaN(v) && v >= min && v <= max) onChange(v);
        }}
        onFocus={onFocus}
        onClick={onClick}
        className="flex-1 min-w-0 bg-zinc-900 text-[10px] text-zinc-200 text-center focus:outline-none px-1"
      />
      <div className={`flex flex-col shrink-0 border-l ${borderCls}`}>
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); startRepeat(increment); }}
          onMouseUp={stopRepeat}
          onMouseLeave={stopRepeat}
          className="flex-1 flex items-center justify-center w-4 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
          aria-label="Increase"
        >
          <svg width="8" height="5" viewBox="0 0 8 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 4L4 1L7 4" />
          </svg>
        </button>
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); startRepeat(decrement); }}
          onMouseUp={stopRepeat}
          onMouseLeave={stopRepeat}
          className={`flex-1 flex items-center justify-center w-4 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors border-t ${borderCls}`}
          aria-label="Decrease"
        >
          <svg width="8" height="5" viewBox="0 0 8 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 1L4 4L7 1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
