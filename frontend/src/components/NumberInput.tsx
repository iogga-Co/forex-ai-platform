"use client";

import React from "react";

interface NumberInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  className?: string;
}

export function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange,
  className = "",
}: NumberInputProps) {
  const inc = () => onChange(Math.min(max, value + step));
  const dec = () => onChange(Math.max(min, value - step));

  return (
    <div className={`flex items-center gap-0.5 ${className}`}>
      <button
        type="button"
        onClick={dec}
        className="h-5 w-5 flex items-center justify-center rounded bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200 transition-colors"
      >
        -
      </button>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(v);
        }}
        className="w-12 bg-zinc-800 text-center text-zinc-200 text-xs py-0.5 focus:outline-none border-y border-zinc-700 no-spinner"
      />
      <button
        type="button"
        onClick={inc}
        className="h-5 w-5 flex items-center justify-center rounded bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200 transition-colors"
      >
        +
      </button>
    </div>
  );
}
