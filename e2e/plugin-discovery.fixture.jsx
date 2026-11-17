import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../hooks/useI18n';
import { SettingsPanel } from '../components/SettingsPanel';
createRoot(document.getElementById('root')).render(<I18nProvider><SettingsPanel cwd="/fixture" sessionId="fixture-session" initialSection="plugins" onClose={() => {}} onSessionReloaded={() => {}} quoteSelectionEnabled onQuoteSelectionChange={() => {}} soundEnabled={false} onSoundToggle={() => {}} /></I18nProvider>);
