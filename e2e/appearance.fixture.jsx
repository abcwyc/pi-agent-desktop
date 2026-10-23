import React from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from '../hooks/useI18n';
import {SettingsPanel} from '../components/SettingsPanel';
import {THEME_INIT_SCRIPT} from '../lib/theme';
import {FONT_INIT_SCRIPT} from '../lib/font-preferences';

// The actual Settings dialog, with no access to user files or model services.
window.eval(THEME_INIT_SCRIPT);
window.eval(FONT_INIT_SCRIPT);
createRoot(document.getElementById('root')).render(<I18nProvider>
  <div className="app-shell" style={{height:'100dvh'}}>
    <SettingsPanel cwd={null} sessionId={null} initialSection="appearance" onClose={()=>{}}
      onSessionReloaded={()=>{}} quoteSelectionEnabled onQuoteSelectionChange={()=>{}}
      soundEnabled={false} onSoundToggle={()=>{}}/>
  </div>
</I18nProvider>);
