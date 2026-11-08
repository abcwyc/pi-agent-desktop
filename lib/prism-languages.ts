// react-syntax-highlighter's `Prism` build imports refractor/all, which
// registers every Prism language (about 300) when its module is evaluated:
// ~650 ms of the first render at 4x CPU throttling on every page load, code on
// screen or not. Components use the core-only `PrismLight` instead, and the
// languages load in a chunk of their own the first time a highlighter needs
// them. refractor/all registers into the same core instance PrismLight
// renders with, so every language and alias works as it did.

let loaded = false;
let loading: Promise<void> | null = null;

export function prismLanguagesLoaded(): boolean {
  return loaded;
}

/** Loads every Prism language once; a failed chunk load may be retried. */
export function loadPrismLanguages(): Promise<void> {
  loading ??= import("refractor/all").then(
    () => {
      loaded = true;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}
