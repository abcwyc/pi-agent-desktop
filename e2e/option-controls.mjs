import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {checkComposerGeometry} from './composer-geometry.mjs';
await mkdir('test-results/ui-send',{recursive:true});
await build({entryPoints:['e2e/option-controls.fixture.jsx'],bundle:true,platform:'browser',format:'iife',outfile:'test-results/ui-send/consistency-preview.js',define:{'process.env':'{"NODE_ENV":"production"}'},jsx:'automatic',logLevel:'warning'});
const css=(await Promise.all(['app/globals.css','app/settings.css','app/native-theme.css'].map(p=>readFile(p,'utf8')))).map(x=>x.replace(/^@import[^;]*;/gm,'')).join('\n');
const js=await readFile('test-results/ui-send/consistency-preview.js');
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/preview.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');res.end(req.url==='/preview.js'?js:req.url==='/style.css'?css:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/preview.js"></script></body></html>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:process.env.E2E_BROWSER_CHANNEL || (process.platform==='win32'?'msedge':undefined),headless:true}),results=[];
const rgb=(color)=>color.match(/[\d.]+/g).slice(0,3).map(Number);
const luminance=(color)=>rgb(color).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
const composite=(front,back)=>{const channels=front.match(/[\d.]+/g).map(Number),alpha=channels[3]??1;return 'rgb('+channels.slice(0,3).map((v,i)=>v*alpha+rgb(back)[i]*(1-alpha)).join(',')+')';};
async function assertRowGaps(rows,label){
 const bounds=await rows.evaluateAll(items=>items.map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));
 assert.ok(bounds.length>=2,label+' must exercise adjacent rows');
 const gaps=bounds.slice(1).map((rect,i)=>rect.top-bounds[i].bottom);
 assert.ok(gaps.every(gap=>Math.abs(gap-4)<0.5),JSON.stringify({label,gaps}));
 return gaps;
}
async function assertSelectionPill(row){
 const pill=await row.evaluate(el=>{const s=getComputedStyle(el,'::before');return {content:s.content,width:s.width,height:s.height,color:s.backgroundColor};});
 assert.equal(pill.content,'""');assert.equal(pill.width,'3px');assert.equal(pill.height,'16px');
 assert.notEqual(pill.color,'rgba(0, 0, 0, 0)');
}
async function assertChoiceGeometry(surface,rows,label){
 const box=await surface.evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {left:r.left+parseFloat(s.borderLeftWidth),right:r.right-parseFloat(s.borderRightWidth)};});
 const geometry=await rows.evaluateAll(items=>items.map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,radius:parseFloat(getComputedStyle(el).borderTopLeftRadius)};}));
 assert.ok(geometry.length,label+' has rows');
 for(const row of geometry){
  assert.ok(Math.abs(row.left-box.left-8)<0.5,JSON.stringify({label,edge:'left',row,box}));
  assert.ok(Math.abs(box.right-row.right-8)<0.5,JSON.stringify({label,edge:'right',row,box}));
  assert.equal(row.radius,5,label+' row radius');
 }
 return {inset:8,gap:4,radius:5};
}
try{
 for(const theme of ['dark','light'])for(const width of [1280,390,320]){
  const page=await browser.newPage({viewport:{width,height:720},hasTouch:width===320,isMobile:width===320,deviceScaleFactor:2,reducedMotion:'reduce'});await page.addInitScript(()=>Object.defineProperty(navigator,'platform',{get:()=>'Linux x86_64'}));/* the vertical Settings navigation is the Windows/Linux layout; macOS draws it as tabs */const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(theme=>{localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('pi-theme',theme);},theme);
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());await page.goto(base);
  await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
  const trigger=page.getByRole('combobox',{name:'Thinking fixture',exact:true});await trigger.click();
  const list=page.getByRole('listbox');await list.waitFor();assert.equal(await list.getByRole('option').count(),5);
  await assertRowGaps(list.locator('.app-select-option'),'form select');
  await assertChoiceGeometry(list,list.locator('.app-select-option'),'form select');
  await page.waitForFunction(()=>document.activeElement?.textContent==='medium');
  await page.keyboard.press('ArrowUp');await page.waitForFunction(()=>{
    const el=document.activeElement;return el?.textContent==='low'&&el.matches(':focus-visible')&&getComputedStyle(el).outlineStyle!=='none';
  });
  const colors=await page.locator(':focus').evaluate(el=>{const s=getComputedStyle(el),p=getComputedStyle(el.closest('.app-menu'));return {text:s.color,background:s.backgroundColor,panel:p.backgroundColor,ring:s.outlineColor,outline:s.outlineStyle,width:parseFloat(s.outlineWidth)};});
  colors.background=composite(colors.background,colors.panel);assert.ok(colors.outline!=='none'&&colors.width>=2,JSON.stringify({theme,width,colors}));
  const ratios={text:contrast(colors.text,colors.background),focus:contrast(colors.ring,colors.background)};
  assert.ok(ratios.text>=4.5&&ratios.focus>=3,JSON.stringify({theme,width,colors,ratios}));
  await page.keyboard.press('Home');await page.waitForFunction(()=>document.activeElement?.textContent==='继承当前配置');
  await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>document.activeElement?.textContent==='low');await page.keyboard.press('Enter');
  await list.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.__values().value),'low');
  await trigger.click();await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='option');await page.keyboard.press('Home');await page.waitForFunction(()=>document.activeElement?.textContent==='继承当前配置');await page.keyboard.press('Enter');await list.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>window.__values().value),'');assert.equal(await page.evaluate(()=>new FormData(document.querySelector('#fixture-form')).get('thinking')),'');
  await trigger.click();await page.keyboard.press('Escape');await list.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Thinking fixture');
  await trigger.click();await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='option');await page.keyboard.type('max',{delay:30});
  await page.waitForFunction(()=>document.activeElement?.textContent==='max');
  await page.locator(':focus').evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:229,isComposing:true,bubbles:true,cancelable:true})));
  assert.equal(await list.isVisible(),true,'IME Escape must not dismiss the select');await page.keyboard.press('Escape');await list.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('combobox',{name:'Disabled fixture'}).isDisabled(),true);
  await page.getByRole('combobox',{name:'Long fixture'}).click();await list.waitFor();await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='option');await page.keyboard.press('End');
  await page.waitForFunction(()=>document.activeElement?.textContent?.includes('Model 099'));
  assert.match(await page.locator(':focus').textContent(),/Model 099/);
  const geometry=await list.boundingBox();assert.ok(geometry.x>=0&&geometry.y>=0&&geometry.x+geometry.width<=width+1&&geometry.y+geometry.height<=721,JSON.stringify({theme,width,geometry}));
  if(width!==390)await list.screenshot({path:'test-results/ui-send/consistent-select-'+theme+'-'+width+'.png'});
  await page.keyboard.press('Escape');
  const folder=page.getByRole('combobox',{name:'Folder fixture'});await folder.fill('project-b');await page.getByRole('option',{name:'D:/project-b',exact:true}).waitFor();
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await folder.inputValue(),'D:/project-b');
  await folder.fill('D:/new-project');assert.equal(await folder.inputValue(),'D:/new-project');assert.equal(await page.getByRole('listbox').count(),0);
  await folder.fill('project');await page.getByRole('option',{name:'D:/project-a',exact:true}).click();assert.equal(await folder.inputValue(),'D:/project-a');
  await folder.fill('project');await assertRowGaps(page.locator('.app-combobox-menu .app-menu-option'),'editable suggestions');await folder.press('Escape');
  await page.getByRole('button',{name:'MCP controls',exact:true}).click();
  const exposure=page.getByRole('combobox');await exposure.waitFor();await exposure.click();await list.waitFor();
  assert.equal(await list.getByRole('option').count(),4);const labels=await list.getByRole('option').allTextContents();
  await assertRowGaps(list.locator('.app-select-option'),'MCP select');
  const direct=list.getByRole('option').nth(2);await direct.click();assert.equal(await page.evaluate(()=>window.__values().exposure),'direct');
  await exposure.click();await list.waitFor();await list.screenshot({path:'test-results/ui-send/consistent-mcp-'+theme+'-'+width+'.png'});await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Menus',exact:true}).click();
  await checkComposerGeometry(page);
  const tool=page.getByRole('button',{name:'更改工具预设',exact:true});
  if(!await tool.isVisible())await page.getByRole('button',{name:'更多控件',exact:true}).click();
  await tool.click();const tools=page.locator('.composer-tool-menu');await tools.waitFor();
  const toolRows=tools.locator('.app-option-row');const toolGaps=await assertRowGaps(toolRows,'actual Config');
  await assertChoiceGeometry(tools,toolRows,'actual Config');
  await assertSelectionPill(tools.locator('.app-option-row[data-selected]'));
  await toolRows.nth(1).hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelectorAll('.composer-tool-menu .app-option-row')[1]).backgroundColor!=='rgba(0, 0, 0, 0)');
  const states=await toolRows.evaluateAll(rows=>rows.slice(0,2).map(row=>({selected:row.hasAttribute('data-selected'),color:getComputedStyle(row).backgroundColor,hovered:row.matches(':hover')})));
  assert.equal(states[0].selected,true);assert.equal(states[1].hovered,true);assert.ok(states.every(state=>state.color!=='rgba(0, 0, 0, 0)'));
  await tools.screenshot({path:`test-results/ui-send/menu-gap-config-${theme}-${width}.png`});
  await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-selected')==='false'&&document.activeElement.matches(':focus-visible'));
  assert.ok(await page.locator(':focus').evaluate(el=>parseFloat(getComputedStyle(el).outlineWidth)>=2),'keyboard focus must remain visible');
  await page.keyboard.press('Escape');await tools.waitFor({state:'hidden'});
  const reasoning=page.getByRole('button',{name:'更改推理级别',exact:true});await reasoning.click();
  const reasoningPanel=page.locator('.composer-run-menu');
  const slider=reasoningPanel.getByRole('slider');await slider.waitFor();
  assert.equal(await reasoningPanel.getByRole('option').count(),0,'reasoning uses only a slider');
  assert.ok(await slider.evaluate(el=>el===document.activeElement),'slider receives focus on open');
  await slider.press('Home');await slider.press('ArrowRight');await slider.press('ArrowUp');await slider.press('ArrowRight');
  assert.match(await slider.getAttribute('aria-valuetext'),/^low:/,'arrows select supported levels inside the popup');
  const star=reasoningPanel.locator('button.app-default-star');await star.hover();
  const starStyle=await star.evaluate(el=>{const s=getComputedStyle(el);return {border:s.borderTopWidth,bg:s.backgroundColor,shadow:s.boxShadow};});
  assert.equal(starStyle.border,'0px');assert.equal(starStyle.bg,'rgba(0, 0, 0, 0)');assert.equal(starStyle.shadow,'none');
  await star.click();await reasoningPanel.locator('.app-default-star.is-default').waitFor();
  await slider.focus();await slider.press('ArrowRight');
  assert.match(await slider.getAttribute('aria-valuetext'),/^medium:/);
  await slider.press('Shift+Tab');await page.keyboard.press('Enter');
  await reasoningPanel.locator('.app-default-star.is-default').waitFor();
  assert.ok(await star.evaluate(el=>el===document.activeElement),'saving keeps keyboard focus');
  await reasoningPanel.screenshot({path:`test-results/ui-send/selection-reasoning-${theme}-${width}.png`});
  await page.keyboard.press('Escape');
  await page.locator('textarea').click();
  await page.getByRole('button',{name:'Change model',exact:true}).click();await assertRowGaps(page.getByRole('listbox').locator('.app-option-row'),'actual model choices');
  await assertChoiceGeometry(page.getByRole('listbox'),page.getByRole('listbox').locator('.app-option-row'),'actual models');await page.keyboard.press('Escape');
  const input=page.locator('textarea');await input.fill('');await input.press('ArrowUp');
  const history=page.locator('.app-suggestion-menu');await history.waitFor();await assertRowGaps(history.locator('button'),'actual input history');await input.press('Escape');
  await input.fill('/');const commands=page.locator('.app-suggestion-menu .app-menu-items');await commands.waitFor();
  const grid=await commands.evaluate(el=>{const s=getComputedStyle(el);return {row:s.rowGap,column:s.columnGap,rows:[...el.children].map(row=>{const r=row.getBoundingClientRect();return {top:r.top,bottom:r.bottom,margin:getComputedStyle(row).marginTop};})};});
  assert.equal(grid.row,'4px');assert.equal(grid.column,'4px');assert.ok(grid.rows.every(row=>row.margin==='0px'));
  if(width===1280)assert.equal(grid.rows[0].top,grid.rows[1].top,'grid columns must stay aligned');
  else await assertRowGaps(commands.locator('button'),'single-column commands');
  await input.press('Escape');await input.fill('');
  for(const sample of await page.locator('[data-menu-sample]').all()){
   const kind=await sample.getAttribute('data-menu-sample');
   await assertRowGaps(sample.locator(kind==='worktrees'?'.wt-row > .app-menu-option':'button'),kind);
  }
  await page.locator('#action-samples').screenshot({path:`test-results/ui-send/menu-gap-actions-${theme}-${width}.png`});
  await page.getByRole('button',{name:'Project view',exact:true}).click();
  const viewMenu=page.locator('.project-view-menu');await viewMenu.waitFor();
  await assertRowGaps(viewMenu.getByRole('menuitemradio'),'actual project view choices');
  await page.keyboard.press('ArrowDown');assert.equal(await page.locator(':focus').getAttribute('aria-checked'),'false');
  await page.keyboard.press('Escape');await viewMenu.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Project worktrees',exact:true}).click();
  await assertRowGaps(page.locator('.sidebar-project-context-menu-row > [role="menuitem"]'),'extracted worktree rows');
  await page.keyboard.press('Escape');await page.locator('.sidebar-project-context-menu').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Project new-worktree',exact:true}).click();
  const branch=page.getByRole('combobox');await branch.waitFor();await branch.fill('');await branch.click();
  await assertRowGaps(page.locator('.app-combobox-menu [role="option"]'),'extracted worktree suggestions');
  await branch.fill('fea');await branch.press('ArrowDown');await branch.press('Enter');assert.equal(await branch.inputValue(),'feature');
  await branch.press('Enter');assert.equal(await page.evaluate(()=>window.__createdBranch),'feature');
  await page.getByRole('button',{name:'Settings geometry',exact:true}).click();
  const surface=page.locator('.settings-dialog-surface');await surface.waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('dark')),theme==='dark','Settings must use the tested palette');
  if(width===1280){
   const tabs=page.locator('.settings-section-tabs'),rows=tabs.locator('.settings-section-tab');
   await assertRowGaps(rows,'actual Settings navigation');
   await assertChoiceGeometry(tabs,rows,'actual Settings navigation');
   await rows.nth(1).hover();
   await tabs.screenshot({path:`test-results/ui-send/settings-choice-geometry-${theme}-${width}.png`});
  }else{
   await page.locator('.settings-mobile-section-picker').click();
   await assertChoiceGeometry(page.getByRole('listbox'),page.getByRole('listbox').locator('.app-select-option'),'mobile Settings categories');
   await page.keyboard.press('Escape');
  }
  await surface.locator('.settings-dialog-close').click();await surface.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);results.push({theme,width,options:5,mcpOptions:labels.length,geometry,colors,ratios,toolGaps,states});await page.close();
 }
 await writeFile('test-results/ui-send/consistency-controls.json',JSON.stringify(results,null,2));
 console.log('PASS: both themes at 1280/390/320; select interaction, MCP, actual Config/reasoning/model/history and action menus; 4px row separation, checked + hovered states and keyboard focus.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
