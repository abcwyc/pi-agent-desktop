import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationNavigator } from "../components/ConversationNavigator";
import { I18nProvider } from "../hooks/useI18n";

const turns = Array.from({ length: 12 }, (_, index) => ({ index, question: `Question ${index + 1}`, answer: "Example answer" }));

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [rightOpen, setRightOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [textWidth, setTextWidth] = useState(820);
  const [fontSize, setFontSize] = useState(14);
  Object.assign(window, { navigatorFixture: { setRightOpen, setSidebarWidth, setTextWidth, setFontSize } });
  return <div className="app-shell" style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
    <header style={{ display: "flex", alignItems: "center", gap: 16, height: 48, paddingInline: 20 }}>
      <button onClick={() => setRightOpen((open) => !open)}>Toggle workspace</button>
      <span>Conversation navigator layout</span>
    </header>
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <aside style={{ width: sidebarWidth, flexShrink: 0, background: "var(--bg-panel)" }}>Projects</aside>
      <main className="chat-window" style={{ display: "flex", flex: 1, minWidth: 0, position: "relative", overflow: "hidden" }}>
        <div ref={scrollRef} className="chat-scroll-container" style={{ flex: 1, minWidth: 0, overflowY: "scroll", paddingTop: 16 }}>
          <div style={{ minWidth: 0, padding: "0 16px" }}>
            <div ref={contentRef} style={{ width: "100%", maxWidth: textWidth, margin: "0 auto", fontSize }}>
              {turns.map((turn) => <article key={turn.index} data-conversation-turn={turn.index} style={{ marginBottom: 40 }}>
                <h3>{turn.question} · 查询只读</h3>
                <p>一套代码，两处运行。正文始终拥有完整的阅读空间，导航标记只能出现在左边留白处。</p>
                <p>宽屏时显示对话锚点；右侧面板打开、侧栏变宽或正文宽度增大后，应自动让出空间。</p>
                <pre>const result = await query();</pre>
              </article>)}
            </div>
          </div>
        </div>
        <ConversationNavigator turns={turns} scrollContainerRef={scrollRef} contentRef={contentRef} enabled={!rightOpen}
          onSelect={(index) => {
            document.documentElement.dataset.selectedTurn = String(index);
            const anchor = contentRef.current?.querySelector<HTMLElement>(`[data-conversation-turn="${index}"]`);
            if (anchor && scrollRef.current) scrollRef.current.scrollTop += anchor.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top - 16;
          }} />
      </main>
      {rightOpen && <aside style={{ width: 360, flexShrink: 0, background: "var(--bg-panel)" }}>Files / Preview / Terminal</aside>}
    </div>
  </div>;
}

createRoot(document.getElementById("root")!).render(<I18nProvider><Fixture /></I18nProvider>);
