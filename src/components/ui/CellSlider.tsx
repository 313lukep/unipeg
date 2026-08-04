"use client";

/**
 * CellSlider — cell-tick track, 2-cell square thumb, Space Mono 700 readout
 * in the artwork's units. A visually-hidden native range input drives it, so
 * pointer, touch and keyboard all behave natively and values always snap to
 * `step`. Optional `detents` act as extra magnets for pointer drags: any raw
 * value landing within half a step of a detent snaps onto it. Keyboard input
 * is exempt from the magnet, so arrow keys step the native lattice
 * predictably and no lattice value is ever unreachable.
 */

import { useId, useRef } from "react";
import { resolveSliderValue } from "./cellSliderMath";

export type CellSliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  detents?: number[];
};

const MAX_TICKS = 49;

export default function CellSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  detents,
}: CellSliderProps) {
  const id = useId();
  const range = max - min;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const toPct = (v: number) => (range === 0 ? 0 : ((v - min) / range) * 100);

  // Whether the change about to fire came from the keyboard. Pointer and key
  // events always precede the change event they cause, so the flag is fresh.
  const keyboardOrigin = useRef(false);

  const handleRaw = (raw: number) => {
    onChange(
      resolveSliderValue(
        raw,
        { min, max, step, detents },
        keyboardOrigin.current ? "keyboard" : "pointer",
      ),
    );
  };

  // Cell ticks at step increments; thin out when the range is dense.
  const stepCount = range === 0 ? 0 : Math.floor(range / step);
  const every = Math.max(1, Math.ceil((stepCount + 1) / MAX_TICKS));
  const ticks: number[] = [];
  for (let i = 0; i <= stepCount; i += every) ticks.push(min + i * step);

  const fraction = range === 0 ? 0 : (clamp(value) - min) / range;

  return (
    <div className="w-full">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-semibold text-ink">
          {label}
        </label>
        <output
          htmlFor={id}
          aria-hidden="true"
          className="font-mono text-[13px] font-bold leading-none text-ink"
        >
          {format(value)}
        </output>
      </div>

      <div className="relative h-[var(--control-h)] min-h-[44px] w-full">
        {/* track hairline */}
        <span
          aria-hidden="true"
          className="absolute left-0 right-0 top-1/2 h-[2px] -translate-y-1/2 bg-line"
        />

        {/* cell ticks */}
        {ticks.map((t) => (
          <span
            key={`t-${t}`}
            aria-hidden="true"
            className="absolute top-1/2 h-[8px] w-[1px] -translate-y-1/2 bg-line"
            style={{ left: `${toPct(t)}%` }}
          />
        ))}

        {/* detent magnets in accent */}
        {detents
          ?.filter((d) => d >= min && d <= max)
          .map((d) => (
            <span
              key={`d-${d}`}
              aria-hidden="true"
              className="absolute top-1/2 h-[12px] w-[2px] -translate-y-1/2 bg-accent"
              style={{ left: `${toPct(d)}%` }}
            />
          ))}

        {/* native input first so the thumb can style on its focus */}
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={clamp(value)}
          onKeyDown={() => {
            keyboardOrigin.current = true;
          }}
          onPointerDown={() => {
            keyboardOrigin.current = false;
          }}
          onChange={(e) => handleRaw(e.currentTarget.valueAsNumber)}
          aria-label={label}
          aria-valuetext={format(value)}
          className="u-slider-input absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />

        {/* 2-cell square thumb; travels 0 → (100% − its own width) */}
        <span
          aria-hidden="true"
          className="u-slider-thumb pointer-events-none absolute top-1/2 -translate-y-1/2 bg-accent"
          style={{
            width: "calc(var(--cell) * 2)",
            height: "calc(var(--cell) * 2)",
            left: `calc(${fraction} * (100% - var(--cell) * 2))`,
          }}
        />
      </div>
    </div>
  );
}
