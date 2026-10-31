"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useHomeExperience } from "@/hooks/useHomeExperience";
import { COMPANION_SHEETS, type CompanionAnimation } from "@/lib/companion-sheets";

export type CompanionState = "idle" | "thinking" | "working" | "attention" | "error" | "typing" | "compacting" | "conducting";

/** Reference sprite sheets with Pi lifecycle signals; no host DOM mutation. */
export function ComposerCompanion({ state }: { state: CompanionState }) {
  const { t } = useI18n();
  const { mascot } = useHomeExperience();
  const previous = useRef(state);
  const strip = useRef<HTMLSpanElement>(null);
  const seat = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);
  const drag = useRef<{ start: number; offset: number; moved: boolean } | null>(null);
  const [offset, setOffset] = useState(0);
  const [extra, setExtra] = useState<CompanionAnimation | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  useEffect(() => {
    const finished = state === "idle" && ["working", "thinking", "typing", "compacting", "conducting"].includes(previous.current);
    previous.current = state;
    setCelebrating(finished);
    setExtra(null);
    if (!finished) return;
    const timer = window.setTimeout(() => setCelebrating(false), 2560);
    return () => window.clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    if (!mascot || state !== "idle" || celebrating) return;
    const started = Date.now();
    let step = 0;
    const timer = window.setInterval(() => {
      if (document.hidden || drag.current) return;
      const choices = [null, "idle-look", "idle-wave", "idle-laptop", "music"] as const;
      setExtra(Date.now() - started > 120000 ? "sleeping" : choices[++step % choices.length]);
    }, 6000);
    return () => window.clearInterval(timer);
  }, [mascot, state, celebrating]);
  useEffect(() => {
    if (!extra || ["sleeping", "idle-look", "idle-wave", "idle-laptop", "music", "drag"].includes(extra)) return;
    const timer = window.setTimeout(() => setExtra(null), COMPANION_SHEETS[extra][0] * 80);
    return () => window.clearTimeout(timer);
  }, [extra]);
  const displayState = celebrating && state === "idle" ? "done" : state;
  const animation: CompanionAnimation = extra ?? (celebrating && state === "idle" ? "happy"
    : state === "working" ? "building" : state === "attention" ? "notification" : state);
  const [frames, x, y, width, height, still] = COMPANION_SHEETS[animation];
  useEffect(() => {
    if (!mascot) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let timer: number | undefined;
    const paint = (index: number) => {
      strip.current?.style.setProperty("--sprite-x", `${-(index % 8) * width * 2}px`);
      strip.current?.style.setProperty("--sprite-y", `${-Math.floor(index / 8) * height * 2}px`);
    };
    const start = () => {
      window.clearInterval(timer);
      paint(motion.matches ? still : 0);
      if (!document.hidden && !motion.matches) timer = window.setInterval(() => paint(++frame % frames), 80);
    };
    start();
    document.addEventListener("visibilitychange", start);
    motion.addEventListener("change", start);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", start); motion.removeEventListener("change", start); };
  }, [animation, mascot, frames, width, height, still]);
  useEffect(() => {
    if (!mascot || !seat.current) return;
    const observer = new ResizeObserver(() => {
      const min = Math.min(0, -(seat.current?.clientWidth ?? 320) + 112);
      setOffset((value) => Math.max(min, Math.min(0, value)));
    });
    observer.observe(seat.current);
    return () => observer.disconnect();
  }, [mascot]);
  if (!mascot) return null;
  const labelKey = ["typing", "compacting", "conducting"].includes(displayState) ? "working" : displayState;
  return <div ref={seat} className="composer-companion-seat">
    <button type="button" className="composer-companion" data-state={displayState} data-animation={animation}
      aria-label={t("home.companion." + labelKey)} title={t("home.companion." + labelKey)}
      style={{ "--companion-offset": `${offset}px` } as CSSProperties}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragged.current = false;
        drag.current = { start: event.clientX, offset, moved: false };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const delta = event.clientX - drag.current.start;
        if (Math.abs(delta) > 4) { drag.current.moved = true; setExtra("drag"); }
        const seatWidth = event.currentTarget.parentElement?.clientWidth ?? 320;
        setOffset(Math.max(-seatWidth + 112, Math.min(0, drag.current.offset + delta)));
      }}
      onPointerUp={() => { dragged.current = drag.current?.moved ?? false; if (dragged.current) setExtra("waking"); drag.current = null; }}
      onPointerCancel={() => { drag.current = null; setExtra(null); }}
      onClick={() => { if (!dragged.current) setExtra(extra === "sleeping" ? "waking" : "tickle"); dragged.current = false; }}>
      <span className="companion-sprite-window" style={{ left: x * 2, top: y * 2, width: width * 2, height: height * 2 } as CSSProperties} aria-hidden="true">
        <span ref={strip} className="companion-sprite" style={{
          width: width * 16, height: Math.ceil(frames / 8) * height * 2,
          backgroundImage: `url(/claude-companion/${animation}.png)`,
          "--sprite-ink": `url(/claude-companion/${animation}-ink.png)`,
        } as CSSProperties} />
      </span>
    </button>
  </div>;
}
