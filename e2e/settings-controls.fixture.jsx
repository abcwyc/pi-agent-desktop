import React from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from '../hooks/useI18n';
import {SettingsPanel} from '../components/SettingsPanel';
import {THEME_INIT_SCRIPT} from '../lib/theme';
import {FileViewer} from '../components/FileViewer';
import {ToolDefinitionsPanel} from '../components/ToolDefinitionsPanel';

window.eval(THEME_INIT_SCRIPT);
document.documentElement.dataset.platform = 'windows';
const params = new URLSearchParams(location.search);
const tools = ['read','edit','write'].map(name=>({name,active:true,description:'Test tool',parameters:{type:'object',properties:{}}}));
createRoot(document.getElementById('root')).render(<I18nProvider>
  <div className="app-shell" style={{height:'100dvh'}}>
    {params.get('panel') === 'file' ? <FileViewer filePath="D:/fixture/notes.md" watchEnabled={false}/> :
      params.get('panel') === 'tools' ? <ToolDefinitionsPanel loading={false} tools={tools} translate={key=>key}/> :
      <SettingsPanel cwd="D:/fixture" sessionId={null}
      initialSection={params.get('section') || 'general'}
      onClose={()=>{}} onSessionReloaded={()=>{}} quoteSelectionEnabled
      onQuoteSelectionChange={()=>{}} soundEnabled={false} onSoundToggle={()=>{}}/>}
  </div>
</I18nProvider>);
