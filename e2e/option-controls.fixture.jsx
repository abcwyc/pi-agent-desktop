import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppSelect} from '../components/AppSelect';
import {AppCombobox} from '../components/AppCombobox';
import {McpConfigView} from '../components/McpConfig';
import {ChatInput} from '../components/ChatInput';
import {ProjectContextMenuPanel} from '../components/ProjectContextMenu';
import {ProjectViewMenu} from '../components/ProjectViewMenu';
import {SettingsEntryMenu,useSettingsEntryMenu} from '../components/SettingsEntryMenu';
import {I18nProvider,useI18n} from '../hooks/useI18n';
function ProjectMenuFixture({kind}){
 const ref=useRef(null),{t}=useI18n(),[branch,setBranch]=useState(''),[mode,setMode]=useState('grouped'),[open,setOpen]=useState(true);
 const settings=useSettingsEntryMenu(section=>{window.__section=section;});
 const noop=()=>{};if(!open)return <p>Menu closed</p>;
 if(kind==='settings')return <><button ref={settings.settingsMenuButtonRef} onClick={event=>settings.toggleSettingsMenu(event,true)}>Open settings menu</button><SettingsEntryMenu menu={settings} hasProject onSelectSection={section=>{window.__section=section;}}/></>;
 if(kind==='view')return <ProjectViewMenu menuRef={ref} pos={{top:120,left:8}} mode={mode} canCollapseAll canExpandAll controlsDisabled={false} onModeChange={setMode} onCollapseAll={noop} onExpandAll={noop} onClose={()=>setOpen(false)}/>;
 return <ProjectContextMenuPanel menuRef={ref} projectRoot="D:/fixture" pos={{top:120,left:8}} view={kind}
  branchMenu={{root:'D:/fixture',isGit:true,branches:['main','feature','dev'],remoteBranches:[],worktrees:[{path:'D:/fixture',branch:'main',isMain:true},{path:'D:/feature',branch:'feature',isMain:false}],loaded:true}}
  branchLoading={false} selectedCwd="D:/fixture" switchingBranch={null} fetching={false} worktreeBusy={false} worktreeError={null} confirmRemove={null} newBranch={branch}
  canReveal={false} revealLabel="Reveal" projectRevealError={null} t={t} onShowBranches={noop} onShowWorktrees={noop} onShowNewWorktree={noop} onBackToActions={noop}
  onSwitchBranch={noop} onFetch={noop} onSelectWorktree={noop} onRequestRemove={noop} onConfirmRemove={noop} onCancelRemove={noop} onNewBranchChange={setBranch}
  onCreateWorktree={()=>{window.__createdBranch=branch;}} onClose={()=>setOpen(false)}/>;
}
function Gallery(){
 const [value,setValue]=useState('medium'),[path,setPath]=useState('D:/project-a'),[panel,setPanel]=useState('form'),[exposure,setExposure]=useState('codemode');
 window.__values=()=>({value,path,exposure});
 const server={name:'github',scope:'global',sourcePath:'D:/test/.pi/agent/mcp.json',configKey:'key',enabled:true,validated:true,envNames:[],headerNames:[],usesOAuth:false,commandFields:[],variableReferences:[],masked:false,transport:'http',exposure,url:'https://example.com/mcp'};
 const overview={mcp:{available:true},codemode:{sandbox:{state:'available'},builtinDisabled:false,preference:'automatic'},files:[{scope:'global',path:server.sourcePath,exists:true,problems:[]}],servers:[server]};
 return <I18nProvider><div style={{padding:20,maxWidth:1000,margin:'auto'}}>
 <nav style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:20}}><button onClick={()=>setPanel('form')}>Form controls</button><button onClick={()=>setPanel('mcp')}>MCP controls</button><button onClick={()=>setPanel('menus')}>Menus</button>{['view','worktrees','new-worktree','settings'].map(kind=><button key={kind} onClick={()=>setPanel('project-'+kind)}>{'Project '+kind}</button>)}</nav>
 {panel.startsWith('project-')?<ProjectMenuFixture key={panel} kind={panel.slice(8)}/>:panel==='menus'?<>
  <div style={{height:380}} />
  <ChatInput isStreaming={false} onSend={()=>{}} onAbort={()=>{}} onToolPresetChange={()=>{}}
   thinkingLevel="high" onThinkingLevelChange={()=>{}} savedDefaultThinkingLevel="high" onSetDefaultThinkingLevel={()=>{}}
   model={{provider:'fixture',modelId:'first'}} modelList={[{id:'first',name:'First model',provider:'fixture'},{id:'second',name:'Second model',provider:'fixture'}]}
   onModelChange={()=>{}} onSetDefaultModel={()=>{}} inputHistory={['First prompt','Second prompt']}
   slashCommands={[{name:'help',source:'builtin',description:'First command'},{name:'status',source:'builtin',description:'Second command'},{name:'clear',source:'builtin',description:'Third command'}]}/>
  <div id="action-samples" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:16,marginTop:20}}>
   {['settings-entry-menu','app-topbar-more-menu','dom-context-menu'].map(kind=><div key={kind} data-menu-sample={kind} className={'native-popover app-menu '+kind+(kind==='settings-entry-menu'?' sidebar-project-context-menu':'')} role="menu" style={{position:'static',width:'auto'}}>
    {['First action','Second action'].map(label=><button key={label} type="button" role="menuitem" className={kind==='app-topbar-more-menu'?'app-topbar-more-item':undefined}>{kind==='app-topbar-more-menu'?<><span aria-hidden="true">·</span><span className="app-topbar-more-copy"><span>{label}</span></span></>:label}</button>)}
   </div>)}
   <div data-menu-sample="project" className="native-popover app-menu"><div>{['Current project','Other project'].map((label,index)=><button key={label} type="button" className="project-picker-option" aria-current={index===0?'true':undefined} style={{display:'flex',width:'100%',border:0,background:'none',padding:'8px 10px',textAlign:'left'}}>{label}</button>)}</div></div>
   <div data-menu-sample="worktrees" className="native-popover app-menu">{['Current worktree','Other worktree'].map(label=><div key={label} className="wt-row" style={{display:'flex',borderBottom:'1px solid var(--border)'}}><button className="app-menu-option" style={{flex:1}}>{label}</button><button className="worktree-remove-button" aria-label={'Remove '+label}>×</button></div>)}</div>
   <div data-menu-sample="branches" className="native-popover app-menu"><div className="app-menu-items" style={{display:'flex',flexDirection:'column',gap:2}}><button className="app-menu-option">Branch A</button><button className="app-menu-option">Branch B</button></div></div>
  </div>
 </>:panel==='form'?<form id="fixture-form" style={{maxWidth:400,display:'grid',gap:16}} onSubmit={e=>e.preventDefault()}>
  <label htmlFor="thinking">推理级别</label>
  <AppSelect id="thinking" name="thinking" aria-label="Thinking fixture" value={value} onValueChange={setValue} options={[
   {value:'',label:'继承当前配置'},{value:'disabled',label:'不可用选项',disabled:true},{value:'low',label:'low'},{value:'medium',label:'medium'},{value:'max',label:'max'},
  ]}/>
  <AppSelect aria-label="Disabled fixture" value="locked" onValueChange={()=>{throw Error('Disabled callback')}} disabled options={[{value:'locked',label:'只读配置'}]}/>
  <AppSelect aria-label="Long fixture" value="model-0" onValueChange={next=>window.__model=next} options={Array.from({length:100},(_,i)=>({value:'model-'+i,label:'Model '+String(i).padStart(3,'0')+' · '+(i===50?'非常长的模型名称，需要在窄窗口中换行而不被裁切。'.repeat(3):'Provider')}))}/>
  <label htmlFor="folder">项目目录</label>
  <AppCombobox id="folder" aria-label="Folder fixture" className="scheduled-input" value={path} onValueChange={setPath} options={['D:/project-a','D:/project-b','D:/另一个项目']}/>
  <button type="button" id="outside">Outside</button>
 </form>:<McpConfigView cwd={null} embedded load={{state:'loaded',data:overview}} selected={'global\0github'} refreshing={false} onSelect={()=>{}} onRefresh={()=>{}} onClose={()=>{}} onCodemodeChange={()=>{}} onExposureChange={(_,next)=>setExposure(next)}/>}
 </div></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<Gallery/>);
