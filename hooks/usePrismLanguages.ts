"use client";

import { useEffect, useState } from "react";
import { loadPrismLanguages, prismLanguagesLoaded } from "@/lib/prism-languages";

/**
 * True once every Prism language is registered (lib/prism-languages.ts). While
 * `enabled`, a highlighter mounting before that starts the load and renders
 * again when it is done; until then it should render its code as plain text.
 */
export function usePrismLanguages(enabled = true): boolean {
  const [ready, setReady] = useState(prismLanguagesLoaded);
  useEffect(() => {
    if (ready || !enabled) return;
    let active = true;
    loadPrismLanguages().then(
      () => { if (active) setReady(true); },
      () => { /* Stays plain text; the next highlighter to mount retries. */ },
    );
    return () => { active = false; };
  }, [enabled, ready]);
  return ready;
}
