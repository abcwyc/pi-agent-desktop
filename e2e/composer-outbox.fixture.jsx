import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInput } from '../components/ChatInput';
import { I18nProvider } from '../hooks/useI18n';

function Fixture() {
  const input = useRef(null);
  const [streaming, setStreaming] = useState(true);
  const [pending, setPending] = useState([]);
  const refresh = async () => {
    const state = await (await fetch('/state')).json();
    setStreaming(state.isStreaming); setPending(state.queuedMessages.pending);
  };
  const command = async body => {
    const response = await fetch('/command', { method: 'POST', body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    await refresh();
    return result.data;
  };
  useEffect(() => {
    const events = new EventSource('/events');
    events.onmessage = () => void refresh();
    void refresh();
    return () => events.close();
  }, []);
  window.__fixture = { command, refresh, finish: () => fetch('/finish', { method: 'POST' }).then(refresh) };
  return <I18nProvider><main style={{ maxWidth: 860, margin: 'auto', paddingTop: 120 }}>
    <div style={{ height: 160, padding: '0 32px', color: 'var(--text-dim)', fontSize: 14 }}>正在处理当前任务…</div>
    <ChatInput ref={input} draftKey="outbox-fixture" isStreaming={streaming} onAbort={() => void command({ type: 'abort' })}
      onSend={(message, images) => void command({ type: 'prompt', message, images })}
      onFollowUp={(message, images) => void command({ type: 'queue_composer', message, images: images?.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })) })}
      onSteer={(message) => { throw Error('Ordinary send must never steer: ' + message); }}
      queuedMessages={{ steering: [], followUp: [], pending }}
      onQueuedMessageAction={async (id, action) => {
        const { item } = await command({ type: action === 'send' ? 'send_composer_message' : 'take_composer_message', id });
        if (action === 'edit' && item) input.current.restoreSubmission(item.message, item.images, 'outbox-fixture');
      }}
      thinkingLevel="high" onThinkingLevelChange={() => {}} onToolPresetChange={() => {}} toolPreset="configured"
      model={{ provider: 'fixture', modelId: 'fixture-model' }} modelList={[{ id: 'fixture-model', name: 'Fixture model', provider: 'fixture' }]}
    />
  </main></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
