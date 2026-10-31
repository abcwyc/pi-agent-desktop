"use client";

import { useRef, useState, type CSSProperties } from "react";

interface Step { value: string; label: string; description: string }

/** Preview continuously while held; send one supported level on release. */
export function ThinkingLevelSlider({ steps, value, label, faster, deeper, onChange, defaultLevel, onSaveDefault, saveDefaultLabel, defaultLabel }: {
  steps: Step[]; value: string; label: string; faster: string; deeper: string;
  onChange: (value: string) => void;
  defaultLevel?: string | null;
  onSaveDefault?: (value: string) => void;
  saveDefaultLabel?: string;
  defaultLabel?: string;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const held = useRef(false);
  const selected = Math.max(0, steps.findIndex(step => step.value === value));
  const last = Math.max(0, steps.length - 1);
  const position = Math.min(last, Math.max(0, draft ?? selected));
  const nearest = Math.round(position);
  const step = steps[nearest];
  if (!step) return null;
  const commit = (index: number) => {
    const next = steps[Math.min(last, Math.max(0, Math.round(index)))];
    if (next && next.value !== value) onChange(next.value);
    setDraft(null);
  };
  return (
    <div className="thinking-level-slider" data-apex={last > 0 && nearest === last || undefined}
      data-dragging={draft !== null || undefined}>
      <div className="thinking-level-slider-head">
        <span>{label}</span><strong>{step.label}</strong>
        {onSaveDefault && step.value !== "auto" && (
          <button type="button" className={`app-default-star${defaultLevel === step.value ? " is-default" : ""}`}
            aria-label={defaultLevel === step.value ? defaultLabel : saveDefaultLabel}
            title={defaultLevel === step.value ? defaultLabel : saveDefaultLabel}
            aria-disabled={defaultLevel === step.value}
            onClick={() => { if (defaultLevel !== step.value) onSaveDefault(step.value); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill={defaultLevel === step.value ? "currentColor" : "none"}
              stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              <polygon points="12 2.5 14.9 8.6 21.5 9.4 16.6 13.9 17.9 20.5 12 17.2 6.1 20.5 7.4 13.9 2.5 9.4 9.1 8.6" />
            </svg>
          </button>
        )}
      </div>
      <div className="thinking-level-slider-description">{step.description}</div>
      <div className="thinking-level-slider-control" style={{ "--effort-progress": `${last ? position / last * 100 : 0}%` } as CSSProperties}>
        <input type="range" min={0} max={last || 1} step="any" value={position} disabled={last === 0}
          aria-label={label} aria-valuetext={`${step.label}: ${step.description}`}
          onPointerDown={event => {
            held.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onChange={event => {
            const next = Number(event.target.value);
            if (held.current) setDraft(next);
            else commit(next);
          }}
          onPointerUp={event => {
            if (!held.current) return;
            held.current = false;
            commit(Number(event.currentTarget.value));
          }}
          onPointerCancel={() => { held.current = false; setDraft(null); }}
          onLostPointerCapture={() => { held.current = false; setDraft(null); }}
          onKeyDown={event => {
            const index = event.key === "Home" ? 0 : event.key === "End" ? last
              : ["ArrowRight", "ArrowUp"].includes(event.key) ? selected + 1
              : ["ArrowLeft", "ArrowDown"].includes(event.key) ? selected - 1 : null;
            if (index !== null) { event.preventDefault(); event.stopPropagation(); commit(index); }
          }} />
        <div className="thinking-level-slider-ticks" aria-hidden="true">
          {steps.map((item, index) => <span key={item.value} data-passed={index <= nearest || undefined}
            style={{ left: `${last ? index / last * 100 : 0}%` }} />)}
        </div>
      </div>
      <div className="thinking-level-slider-ends"><span>{faster}</span><span>{deeper}</span></div>
    </div>
  );
}
