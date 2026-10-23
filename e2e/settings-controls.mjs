import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright';

const out = 'test-results/settings-controls';
await mkdir(out, {recursive:true});
await build({entryPoints:['e2e/settings-controls.fixture.jsx'], bundle:true, platform:'browser', format:'iife',
  outfile:out+'/fixture.js', define:{'process.env':'{"NODE_ENV":"production"}'}, jsx:'automatic', logLevel:'warning'});
const js = await readFile(out+'/fixture.js');
const css = (await Promise.all(['app/globals.css','app/settings.css','app/native-theme.css'].map(p=>readFile(p,'utf8'))))
  .map(s=>s.replace(/^@import[^;]*;/gm,'')).join('\n');
const names = ['Explore','General purpose','Plan'];
const profiles = names.map((displayName,i)=>({name:['explore','general-purpose','plan'][i], displayName,
  scope:'builtin', enabled:true, description:'Built-in assistant', systemPrompt:'Help with the task.', tools:['read'],
  loadSkills:false, loadExtensions:false, inheritContext:false, runInBackground:false, promptMode:'append'}));
const mcpServers = ['docs','search','issues'].map(name=>({name, scope:'global', sourcePath:'D:/fixture/mcp.json',
  configKey:name, enabled:true, validated:true, envNames:[], headerNames:[], usesOAuth:false, commandFields:[],
  variableReferences:[], masked:false, transport:'http', exposure:'codemode', url:'https://example.invalid/'+name}));
const counts = {extensions:0, skills:0, prompts:0, themes:0};
const data = {
  '/api/appearance':{background:'rex'},
  '/api/chat-settings':{model:null,thinkingLevel:null,instructions:'',allowedTools:[],confirmSave:false,instructionsMaxChars:8000},
  '/api/updates':{components:[],updates:[]},
  '/api/subagents/profiles':{profiles}, '/api/subagents/settings':{enabled:true,maxConcurrent:4},
  '/api/models':{models:{}, modelList:[], defaultModel:null, thinkingLevels:{}, thinkingLevelMaps:{}, thinkingLevelPins:{}},
  '/api/auth/providers':{oauthProviders:[],apiKeyProviders:[]},
  '/api/models-config':{providers:{Example:{api:'openai-completions',baseUrl:'https://example.invalid',models:[{id:'first-model'},{id:'second-model'}]}}},
  '/api/models/enabled':{error:'No model calls in UI tests'},
  '/api/skills':{skills:['Review','Design','Test'].map(name=>({name,description:'Test skill',filePath:'D:/fixture/'+name+'/SKILL.md',
    baseDir:'D:/fixture/'+name,disableModelInvocation:false,sourceInfo:{source:'user',scope:'user'}})),diagnostics:[],projectResourcesLoaded:true},
  '/api/plugins':{packages:[],standaloneExtensions:['First extension','Second extension','Third extension'].map(name=>({
    name,kind:'extension',scope:'global',path:'D:/fixture/'+name+'.ts',relativePath:name+'.ts',enabled:true})),
    totals:counts,diagnostics:[],projectResourcesLoaded:true},
  '/api/mcp':{mcp:{available:true},codemode:{sandbox:{state:'available'},builtinDisabled:false,preference:'automatic'},
    files:[{scope:'global',path:'D:/fixture/mcp.json',exists:true,problems:[]}],servers:mcpServers},
};
const server = createServer((req,res)=>{
  const path = new URL(req.url,'http://localhost').pathname;
  if(path.startsWith('/api/')) {
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(path.startsWith('/api/files/')
      ? {content:'# Preview\n\nTest document.',language:'markdown',size:26,nextOffset:26,truncated:false}
      : data[path] ?? {})); return;
  }
  res.setHeader('Content-Type',path==='/fixture.js'?'text/javascript':path==='/style.css'?'text/css':'text/html; charset=utf-8');
  res.end(path==='/fixture.js'?js:path==='/style.css'?css:
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}*,*::before,*::after{transition:none!important}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base = 'http://127.0.0.1:'+server.address().port;
const browser = await chromium.launch();
const results = [];
const near = (actual,expected,label)=>assert.ok(Math.abs(actual-expected)<0.6,`${label}: ${actual}, expected ${expected}`);
async function segments(page, group) {
  await group.scrollIntoViewIfNeeded();
  const metrics = await group.evaluate(el=>{
    const outer=el.getBoundingClientRect(), style=getComputedStyle(el);
    return {radius:parseFloat(style.borderRadius),inset:parseFloat(style.paddingTop),
      rows:[...el.children].map(child=>{const box=child.getBoundingClientRect(),s=getComputedStyle(child);return {
        x:box.x,y:box.y,right:box.right,bottom:box.bottom,topInset:box.top-outer.top,bottomInset:outer.bottom-box.bottom,
        leftInset:box.left-outer.left,rightInset:outer.right-box.right,radius:parseFloat(s.borderRadius),border:parseFloat(s.borderRightWidth)};})};
  });
  near(metrics.rows[0].leftInset,4,'segment leading inset'); near(metrics.rows.at(-1).rightInset,4,'segment trailing inset');
  for(const row of metrics.rows){near(row.topInset,4,'segment top inset');near(row.bottomInset,4,'segment bottom inset');near(metrics.radius-row.radius,4,'concentric segment radius');near(row.border,0,'no inner divider');}
  for(let i=1;i<metrics.rows.length;i++)near(metrics.rows[i].x-metrics.rows[i-1].right,4,'segment gap matches the outer inset and settings row gap');
  const selected = group.locator(':scope > [aria-checked="true"], :scope > [aria-pressed="true"], :scope > label:has(input:checked)');
  assert.equal(await selected.count(),1,'one selected segment');
  const fill = await selected.evaluate(el=>getComputedStyle(el).backgroundColor);
  await selected.hover(); assert.equal(await selected.evaluate(el=>getComputedStyle(el).backgroundColor),fill,'selected fill must survive hover');
  const next = group.locator(':scope > button:not([aria-checked="true"]):not([aria-pressed="true"]):not(:disabled), :scope > label:not(:has(input:checked))').first();
  if(await next.count()){
    await next.hover(); assert.equal(await selected.evaluate(el=>getComputedStyle(el).backgroundColor),fill,'neighbor hover must preserve selection');
    const target = await next.evaluate(el=>el.tagName==='LABEL');
    const focus = target ? next.locator('input') : next;
    await focus.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    assert.ok(await next.evaluate(el=>parseFloat(getComputedStyle(el).outlineWidth)>=2),'segment keyboard focus must be visible');
  }
  return metrics;
}
try {
  for(const theme of ['light','dark']) for(const width of [1280,390,320]) {
    const page = await browser.newPage({viewport:{width,height:900},colorScheme:theme});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await page.addInitScript(theme=>{localStorage.setItem('pi-theme',theme);localStorage.setItem('pi-locale','en');},theme);
    for(const section of ['general','appearance','agents','models','skills','plugins','mcp']) {
      await page.goto(base+'/?section='+section);
      const host = page.locator('.settings-section-host:not([hidden])');
      await host.waitFor().catch(async error=>{await page.screenshot({path:out+'/failure.png'});throw new Error(`${theme}/${width}/${section}: ${errors.join('; ')}; ${error.message}`);});
      const surfaces=await host.evaluate(el=>{
        const main=el.closest('.settings-dialog-main');
        const effective=(node)=>{
          while(node){const color=getComputedStyle(node).backgroundColor;if(color!=='rgba(0, 0, 0, 0)')return color;node=node.parentElement;}
        };
        return {expected:getComputedStyle(main).backgroundColor,actual:[...el.querySelectorAll('.settings-general,.config-panel-surface,.config-sidebar,.config-detail,.config-footer')].map(effective)};
      });
      assert.ok(surfaces.actual.length>0);
      for(const color of surfaces.actual)assert.equal(color,surfaces.expected,`${section} content, sidebar and footer must share General/Appearance's surface`);
      if(theme==='light')assert.equal(surfaces.expected,'rgb(255, 255, 255)');
      if(section==='general'||section==='appearance') {
        const groups = host.locator('.settings-language-options,.settings-theme-options,.settings-send-mode-options,.settings-choice-group');
        assert.ok(await groups.count()>0);
        for(const group of await groups.all()) await segments(page,group);
        // Language choice must keep geometry after label lengths change.
        if(section==='general'){
          await host.getByRole('radio',{name:'简体中文',exact:true}).click();
          for(const group of await groups.all())await segments(page,group);
          await page.screenshot({path:`${out}/${theme}-${width}-general.png`});
        } else await page.screenshot({path:`${out}/${theme}-${width}-appearance.png`});
      } else {
        const list = host.locator('.config-sidebar-list'); const rows=list.locator('.config-sidebar-item');
        await rows.nth(2).waitFor();await rows.nth(1).click();
        await page.mouse.move(0,0);
        const selectedFill=await rows.nth(1).evaluate(el=>getComputedStyle(el).backgroundColor);
        await rows.nth(1).hover();
        assert.equal(await rows.nth(1).evaluate(el=>getComputedStyle(el).backgroundColor),selectedFill,'list selection must survive hover');
        await rows.nth(2).hover();
        const geometry=await rows.evaluateAll(rows=>rows.map(el=>{const b=el.getBoundingClientRect(),p=el.closest('.config-sidebar-list').getBoundingClientRect(),s=getComputedStyle(el);return {
          x:b.x,y:b.y,bottom:b.bottom,leftInset:b.left-p.left,rightInset:p.right-b.right,fill:s.backgroundColor,
          adjacent:el.previousElementSibling?.matches('.config-sidebar-item'),
          selected:el.getAttribute('aria-current')==='page',hovered:el.matches(':hover'),pill:getComputedStyle(el,'::before').width};}));
        for(const row of geometry){near(row.leftInset,8,section+' leading inset');near(row.rightInset,8,section+' trailing inset');}
        for(let i=1;i<geometry.length;i++)if(geometry[i].adjacent)near(geometry[i].y-geometry[i-1].bottom,4,section+' adjacent rows');
        assert.ok(geometry[1].selected&&geometry[2].hovered);
        assert.ok(geometry.slice(1,3).every(row=>row.fill!=='rgba(0, 0, 0, 0)'));
        near(parseFloat(geometry[1].pill),3,'selected row pill');
        if(width===1280||section==='agents')await page.screenshot({path:`${out}/${theme}-${width}-${section}.png`});
        await rows.nth(2).focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
        assert.ok(await rows.nth(2).evaluate(el=>parseFloat(getComputedStyle(el).outlineWidth)>=2));
        if(section==='agents'){
          await host.locator('.config-list-action-button').click();
          await segments(page,host.locator('.config-scope-switch'));
        }
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'document must not overflow');
      results.push({theme,width,section});
    }
    await page.goto(base+'/?panel=file');
    const modes=page.locator('.file-viewer-mode-switch');await modes.waitFor();
    await segments(page,modes);
    await modes.locator('button[aria-pressed="false"]').first().click();await segments(page,modes);
    await page.goto(base+'/?panel=tools');
    const toolRows=page.locator('.tool-definitions-item');await toolRows.nth(2).waitFor();
    await toolRows.nth(1).click();await toolRows.nth(2).hover();
    const toolGeometry=await toolRows.evaluateAll(rows=>rows.map(el=>{
      const b=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();
      return {top:b.top,bottom:b.bottom,left:b.left-p.left,right:p.right-b.right};
    }));
    for(const row of toolGeometry){near(row.left,8,'tool list leading inset');near(row.right,8,'tool list trailing inset');}
    for(let i=1;i<toolGeometry.length;i++)near(toolGeometry[i].top-toolGeometry[i-1].bottom,4,'tool rows');
    const toolFill=await toolRows.nth(1).evaluate(el=>getComputedStyle(el).backgroundColor);
    await toolRows.nth(1).hover();assert.equal(await toolRows.nth(1).evaluate(el=>getComputedStyle(el).backgroundColor),toolFill);
    assert.deepEqual(errors,[]);await page.close();
  }
  const touch = await browser.newPage({viewport:{width:390,height:900},hasTouch:true,isMobile:true});
  await touch.goto(base+'/?section=general');
  await touch.locator('.settings-language-option').first().waitFor();
  await touch.locator('.settings-dialog-surface').evaluate(el=>Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished)));
  const heights=await touch.locator('.settings-language-option,.settings-send-mode-option,.settings-choice-option').evaluateAll(rows=>rows.map(el=>el.getBoundingClientRect().height));
  assert.ok(heights.length>0&&heights.every(h=>h>=44),'touch segments must retain 44px targets: '+heights.join(','));await touch.close();
  await writeFile(out+'/results.json',JSON.stringify(results,null,2));
  console.log('PASS: seven Settings sections, file preview/source and tool definitions, light/dark × 1280/390/320; list gaps, segment insets/radii, hover, focus and touch targets');
} finally {await browser.close();await new Promise(r=>server.close(r));}
