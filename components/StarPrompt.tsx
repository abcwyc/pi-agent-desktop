"use client";

import { APP_REPOSITORY_URL, PRODUCT_NAME } from "@/lib/branding";
import { handleExternalLinkClick } from "@/lib/desktop-native";
import { resolveStarPrompt } from "@/lib/star-prompt";
import { useI18n } from "@/hooks/useI18n";

/**
 * One-time "star us on GitHub" card. AppShell decides when to show it
 * (lib/star-prompt.ts); any answer, including the close button, retires it.
 */
export function StarPrompt({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();

  const dismiss = () => {
    resolveStarPrompt("dismissed");
    onClose();
  };

  return (
    <aside className="native-star-prompt" aria-label={t("starPrompt.title", { product: PRODUCT_NAME })} aria-live="polite">
      <button
        type="button"
        className="native-star-prompt-close"
        aria-label={t("starPrompt.close")}
        title={t("starPrompt.close")}
        onClick={dismiss}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      <div className="native-star-prompt-title">
        <svg className="native-star-prompt-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6L12 17l-5.38 2.85 1.03-6L3.3 9.6l6-.9z" />
        </svg>
        {t("starPrompt.title", { product: PRODUCT_NAME })}
      </div>
      <div className="native-star-prompt-body">{t("starPrompt.body")}</div>
      <div className="native-star-prompt-actions">
        <button type="button" className="native-button" onClick={dismiss}>
          {t("starPrompt.dismiss")}
        </button>
        <a
          className="native-button native-button-primary"
          href={APP_REPOSITORY_URL}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            resolveStarPrompt("starred");
            handleExternalLinkClick(event, APP_REPOSITORY_URL);
            onClose();
          }}
        >
          {t("starPrompt.star")}
        </a>
      </div>
    </aside>
  );
}
