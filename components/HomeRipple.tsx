"use client";

import { useEffect, useRef } from "react";
import { createGlyphField, type GlyphField, type Rgb } from "@/lib/home-ripple/ripple-field";
import { createWaveField } from "@/lib/home-ripple/ripple-wave";
import { RIPPLE } from "@/lib/home-ripple/ripple-params";

/** Owns the reference glyph renderer for one empty home; never intercepts input. */
export function HomeRipple() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = canvas?.parentElement;
    if (!canvas || !root) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let field: GlyphField | null = null;
    let waves = createWaveField(0, 0);
    let frame = 0;
    let timer = 0;
    let previous = performance.now();
    let width = 0, height = 0, density = 0;
    let failed = false;
    const rgb = (value: string): Rgb => {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [128, 128, 128];
      return [channels[0], channels[1], channels[2]];
    };
    function stop() { cancelAnimationFrame(frame); clearTimeout(timer); frame = 0; timer = 0; }
    function draw(now: number) {
      frame = 0;
      if (!canvas || document.hidden || failed || !field) return;
      const still = reduced.matches;
      waves.advance(still ? 0 : (now - previous) / 1000);
      previous = now;
      if (field.needsDraw(now, still)) {
        const style = getComputedStyle(canvas);
        field.draw(now, { ink: rgb(style.color), wave: rgb(style.borderTopColor),
          dark: document.documentElement.classList.contains("dark"), fontFamily: style.fontFamily }, still);
      }
      if (still) return;
      if (field.busy()) frame = requestAnimationFrame(draw);
      else timer = window.setTimeout(wake, 1000 / RIPPLE.changeRate);
    }
    function wake() {
      stop();
      if (!document.hidden && !failed) { previous = performance.now(); frame = requestAnimationFrame(draw); }
    }
    function layout() {
      if (!canvas || !root || failed) return;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      if (width === root.clientWidth && height === root.clientHeight && density === dpr) return;
      width = root.clientWidth; height = root.clientHeight; density = dpr;
      if (!width || !height) return;
      const columns = Math.ceil(width / RIPPLE.cellWidth), rows = Math.ceil(height / RIPPLE.cellHeight);
      field?.dispose();
      canvas.width = Math.round(columns * RIPPLE.cellWidth * dpr);
      canvas.height = Math.round(rows * RIPPLE.cellHeight * dpr);
      canvas.style.width = `${columns * RIPPLE.cellWidth}px`;
      canvas.style.height = `${rows * RIPPLE.cellHeight}px`;
      waves = createWaveField(columns, rows);
      try { field = createGlyphField(canvas, columns, rows, waves); }
      catch { failed = true; canvas.hidden = true; return; }
      wake();
    }
    function press(event: PointerEvent) {
      if (!canvas || reduced.matches || event.button !== 0 || !field) return;
      if ((event.target as HTMLElement).closest("button, input, textarea, a, [contenteditable=true]")) return;
      const box = canvas.getBoundingClientRect();
      waves.disturb(Math.floor((event.clientX - box.left) / RIPPLE.cellWidth), Math.floor((event.clientY - box.top) / RIPPLE.cellHeight));
      wake();
    }
    function refresh() { field?.invalidate(); wake(); }
    const size = new ResizeObserver(layout);
    const theme = new MutationObserver(refresh);
    size.observe(root);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    root.addEventListener("pointerdown", press, { passive: true });
    document.addEventListener("visibilitychange", wake);
    reduced.addEventListener("change", refresh);
    layout();
    return () => {
      stop(); size.disconnect(); theme.disconnect(); field?.dispose();
      root.removeEventListener("pointerdown", press);
      document.removeEventListener("visibilitychange", wake);
      reduced.removeEventListener("change", refresh);
    };
  }, []);
  return <canvas ref={canvasRef} className="home-ripple-canvas" aria-hidden="true" />;
}
