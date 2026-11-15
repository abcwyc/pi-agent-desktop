import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MarkdownBody } from "../components/MarkdownBody";
import { I18nProvider } from "../hooks/useI18n";

function Fixture() {
  const [{ text, streaming }, setMessage] = useState({ text: "", streaming: false });
  Object.assign(window, {
    previewFixture: { set(text: string, streaming = true) { flushSync(() => setMessage({ text, streaming })); } },
  });
  return (
    <I18nProvider>
      <main style={{ maxWidth: 850, margin: "32px auto", padding: 20 }}>
        <MarkdownBody isStreaming={streaming} artifacts>{text}</MarkdownBody>
      </main>
    </I18nProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
