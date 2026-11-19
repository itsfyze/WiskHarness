import assert from "node:assert/strict";
import { _electron,chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const [file,kind="installed",suite="qa",screenshot]=process.argv.slice(2);
if(!file)throw Error("Pass an executable path, installed or portable, and qa, live or runtime");
const runtimeQA=suite==="runtime";
const exe=await realpath(resolve(file));
const root=await mkdtemp(join(tmpdir(),"wisk-electron-"));
const workspace=join(root,"workspace"),config=join(root,"config");
await mkdir(workspace);await mkdir(config);
const models=["fixture:latest","fixture-small:latest","fixture-long-model-name-012345678901234567890:latest"];
const model=suite!=="live"?models[0]:"huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M";
await writeFile(join(config,"settings.json"),JSON.stringify({workspace,model,updateAutomatic:false}));
const chunks=[
  "# Fixture\n\n## Rendered answer\n\n**bo",
  "ld** and *italic* and ~~deleted~~ with "+String.fromCharCode(96)+"npm"+String.fromCharCode(96)+".\n\n",
  "### Depth three\n#### Depth four\n##### Depth five\n###### Depth six\n\n1. Ordered\n   - Nested\n\n> Quote\n\n---\n\n",
  "| Name | Value |\n| --- | --- |\n",
  "| CPU | 34% |\n\n"+String.fromCharCode(96).repeat(3)+"js\nconst x = 1;\n",
  String.fromCharCode(96).repeat(3)+"\n\n[Safe](https://example.com) [Unsafe](javascript:alert%281%29)\n\n",
  '<img src="https://example.com/blocked" onerror="window.wiskUnsafe=true"><script>window.wiskUnsafe=true</script>'
];
let tags=0,planPayload,streamCalls=0;
const webOperations={
  page:{tool:"open_page",args:{url:"https://nodejs.org/api/url.html"},result:/Source: https:\/\/nodejs\.org\/api\/url\.html/},
  search:{tool:"search_web",args:{query:"repo:nodejs/node URL canParse",source:"technical"},result:/https:\/\/github\.com\/nodejs\/node\/(?:issues|pull)\//},
  local:{tool:"open_page",args:{url:"http://127.0.0.1"},result:/private and reserved addresses are blocked/},
  missing:{tool:"open_page",args:{url:"https://nodejs.org/api/wiskharness-missing.html"},result:/returned HTTP 404/}
};
let webFixtureError;
const fake=createServer(async(req,res)=>{
  if(req.url==="/api/tags"){tags++;return res.end(JSON.stringify({models:models.map(name=>({name,size:4e9}))}))}
  if(req.url==="/api/ps")return res.end(JSON.stringify({models:[{name:model,context_length:16384,size_vram:3e9}]}));
  if(runtimeQA&&req.url==="/api/show")return res.end(JSON.stringify({model_info:{"fixture.context_length":16384},capabilities:["completion","tools"]}));
  if(runtimeQA&&req.url==="/api/version")return res.end('{"version":"0.12.0"}');
  if(runtimeQA&&req.url==="/v1/chat/completions"){
    const parts=[];
    for await(const part of req)parts.push(part);
    const data=JSON.parse(Buffer.concat(parts));
    const lastUser=data.messages.findLast(item=>item.role==="user")?.content;
    const marker=[...(typeof lastUser==="string"?lastUser:JSON.stringify(lastUser??"")).matchAll(/\[web:(\w+)\]/g)].at(-1)?.[1];
    let message={role:"assistant",content:"Portable Goose fixture response."};
    const operations=data.tools?.map(item=>item.function.name)||[];
    if(marker&&operations.length){
      try{
        const check=webOperations[marker];
        assert.equal(operations.some(name=>name.endsWith("__open_page")),!!check);
        assert.equal(operations.some(name=>name.endsWith("__search_web")),!!check);
        const last=data.messages.at(-1);
        if(check&&last.role!=="tool"){
          message={role:"assistant",tool_calls:[{index:0,id:"call_web_"+marker,type:"function",
            function:{name:operations.find(name=>name.endsWith("__"+check.tool)),arguments:JSON.stringify(check.args)}}]};
        }else if(check){
          const result=typeof last.content==="string"?last.content:JSON.stringify(last.content);
          assert.match(result,check.result);
          message={role:"assistant",content:"Verified web fixture "+marker+"."};
        }else{
          message={role:"assistant",content:"Verified web fixture off."};
        }
      }catch(error){
        webFixtureError=error;
        res.statusCode=500;
        return res.end(JSON.stringify({error:{message:error.message}}));
      }
    }
    res.setHeader("content-type","text/event-stream");
    const envelope={id:"wisk-packaged-fixture",object:"chat.completion.chunk",created:1,model};
    const frame=(delta,finish_reason)=>"data: "+JSON.stringify({...envelope,choices:[{index:0,delta,finish_reason}]})+"\n\n";
    return res.end(frame(message,null)+frame({},message.tool_calls?"tool_calls":"stop")+"data: [DONE]\n\n");
  }
  if(req.url!=="/api/chat"){res.statusCode=404;return res.end("{}")}
  const buffer=[];
  for await(const part of req)buffer.push(part);
  planPayload=JSON.parse(Buffer.concat(buffer));
  res.setHeader("content-type","application/x-ndjson");
  streamCalls++;
  for(const text of chunks){
    if(res.destroyed)return;
    res.write(JSON.stringify({message:{content:text},done:false})+"\n");
    await wait(210);
  }
  res.end(JSON.stringify({done:true,eval_count:24,eval_duration:1e9,prompt_eval_count:300,total_duration:2e9,
    load_duration:1e8,prompt_eval_duration:3e8,done_reason:"stop"})+"\n");
});
fake.listen(0,"127.0.0.1");await once(fake,"listening");
async function freePort(){
  const temp=createServer().listen(0,"127.0.0.1");
  await once(temp,"listening");
  const port=temp.address().port;
  await new Promise(resolve=>temp.close(resolve));
  return port;
}
const port=await freePort(),debugPort=await freePort(),base="http://127.0.0.1:"+port;
const env={...process.env,LOCAL_AGENT_SETTINGS_DIR:config,LOCAL_AGENT_WORKSPACE:workspace,LOCAL_AGENT_PORT:String(port),
  LOCAL_AGENT_OBSIDIAN_VAULT:"",LOCAL_AGENT_DISABLE_OBSIDIAN_CHECKPOINT:"1",
  LOCAL_AGENT_OLLAMA_URL:suite!=="live"?"http://127.0.0.1:"+fake.address().port:"http://127.0.0.1:11434"};
if(runtimeQA)env.LOCAL_AGENT_GOOSE_PATH=join(root,"missing-system-goose.exe");
let app,browser,proc;
async function start(){
  const args=["--user-data-dir="+join(root,"electron")];
  if(kind!=="portable"){
    app=await _electron.launch({executablePath:exe,args,env,timeout:60000});
    return app.firstWindow();
  }
  proc=spawn(exe,[...args,"--remote-debugging-port="+debugPort],{env,windowsHide:true,stdio:"ignore"});
  let launchError;
  proc.once("error",error=>{launchError=error});
  const debug="http://127.0.0.1:"+debugPort;
  let ready=false;
  for(let i=0;i<240;i++){
    if(launchError)throw launchError;
    if(proc.exitCode!==null||proc.signalCode!==null)throw new Error("Portable launcher exited before Electron started: "+(proc.exitCode??proc.signalCode));
    try{if((await fetch(debug+"/json/version")).ok){ready=true;break}}catch{}
    await wait(250);
  }
  if(!ready)throw new Error("Portable launcher did not expose its debug endpoint within 60 seconds");
  browser=await chromium.connectOverCDP(debug);
  const context=browser.contexts()[0];
  for(let i=0;i<50&&!context.pages().length;i++)await wait(170);
  return context.pages()[0];
}
async function stop(){
  if(app){await app.close();app=null}
  if(browser){
    const session=await browser.newBrowserCDPSession();
    await session.send("Browser.close").catch(()=>{});
    await browser.close().catch(()=>{});browser=null;
  }
  if(proc){
    for(let i=0;i<30&&proc.exitCode===null;i++)await wait(150);
    if(proc.exitCode===null)proc.kill();
    proc=null;
  }
  for(let i=0;i<60;i++){
    try{await fetch(base+"/api/health",{signal:AbortSignal.timeout(250)})}catch{return}
    await wait(150);
  }
  throw Error("Backend retained isolated port");
}
const errors=[];
function recordErrors(page){
  page.on("pageerror",error=>errors.push(error.message));
}
async function api(page,url){
  return page.evaluate(async url=>await(await fetch(url)).json(),url);
}
async function chat(page){
  await page.locator("#chat-input").fill(suite==="qa"?"Stream the Markdown fixture":"Reply with exactly WISK-BETA-CHECK.");
  await page.locator("#chat-send").click();
}
async function measurePanels(page,selector){
  await page.locator(selector).click();
  const popup=page.locator(".popover").last();
  await popup.waitFor();
  const bounds=await popup.boundingBox();
  const viewport=await page.evaluate(()=>({width:window.innerWidth,height:window.innerHeight,scroll:document.documentElement.scrollWidth}));
  assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y+bounds.height<=viewport.height+1,JSON.stringify({selector,bounds,viewport}));
  assert.equal(viewport.width,viewport.scroll);
  return popup;
}
async function nativeChecks(page){
  if(!app)return;
  const displays=await app.evaluate(({screen})=>screen.getAllDisplays().map(d=>({scale:d.scaleFactor,work:d.workArea,size:d.size})));
  for(const display of displays){
    await app.evaluate(({BrowserWindow},area)=>{
      const window=BrowserWindow.getAllWindows()[0];
      window.unmaximize();window.setBounds({x:area.x+40,y:area.y+40,width:1100,height:725});window.maximize();
    },display.work);
    await wait(250);
    const result=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth}));
    assert.equal(result.overflow,false);
    assert.equal(result.dpr,display.scale);
    console.log("PASS native display",JSON.stringify({display,result}));
  }
}
async function checkWorkspaceViews(page) {
  execFileSync("git",["init","-q"],{cwd:workspace,windowsHide:true,stdio:"ignore"});
  await writeFile(join(workspace,"review.txt"),"Disposable change for Git review.\n");
  const views=[["agents","Local runtime"],["projects","Projects"],["models","Models"],["settings","Settings"]];
  for(const [width,height] of [[1440,900],[768,840],[390,844]]){
    await page.setViewportSize({width,height});
    for(const [view,heading] of views){
      if(width<=720)await page.locator("#mobile-menu").click();
      await page.locator("#navigation [data-view="+view+"]").click();
      await page.getByRole("heading",{name:heading,exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
      if(view==="projects"){
        await page.getByRole("button",{name:/Git for workspace/}).click();
        const git=page.getByRole("dialog",{name:"Git workspace"});
        await git.getByText("review.txt",{exact:true}).waitFor();
        await git.getByRole("button",{name:"Stage",exact:true}).click();
        await git.getByRole("button",{name:"Unstage",exact:true}).click();
        await git.getByRole("button",{name:"Close",exact:true}).click();
      }
      if(view==="settings"){
        const menu=page.getByRole("navigation",{name:"Settings sections"});
        await menu.getByRole("button",{name:"Goose runtime",exact:true}).click();
        await page.locator("#settings-goose-source").waitFor();
        assert.equal(await page.locator("#settings-goose-source").inputValue(),"auto");
        await menu.getByRole("button",{name:"Runtime diagnostics",exact:true}).click();
        await page.locator("#settings-check").waitFor();
        if(width===1440&&screenshot) {
          await menu.getByRole("button",{name:"Goose runtime",exact:true}).click();
          await page.screenshot({path:screenshot.replace(/\.png$/,"-settings.png"),animations:"disabled"});
        }
      }
    }
    console.log("PASS navigation, Git controls and settings section jumps at "+width+"x"+height);
  }
}
async function checkPortableGoose(page, setup) {
  const runtime=setup.locator("[data-goose-runtime]");
  assert.equal((await api(page,"/api/goose-runtime")).systemAvailable,false);
  const preference=runtime.getByLabel("Preferred runtime");
  await preference.selectOption("custom");
  await runtime.getByLabel("Goose executable path").fill(join(root,"missing-custom.exe"));
  await runtime.getByRole("button",{name:"Save runtime"}).click();
  await runtime.getByRole("status").filter({hasText:"Goose executable unavailable."}).waitFor();
  assert.equal((await api(page,"/api/goose-runtime")).preference,"auto");
  const download=runtime.getByRole("button",{name:"Download portable Goose",exact:true});
  const confirm=runtime.getByRole("button",{name:"Download and install",exact:true});
  await download.click();
  await runtime.getByRole("button",{name:"Cancel",exact:true}).click();
  assert.equal(await confirm.isVisible(),false);
  assert.equal((await api(page,"/api/goose-runtime")).portableAvailable,false);
  await download.click();
  await confirm.click();
  await runtime.getByRole("status").filter({hasText:"Portable Goose installed."}).waitFor({timeout:180000});
  await preference.selectOption("portable");
  await runtime.getByRole("button",{name:"Save runtime"}).click();
  await runtime.getByRole("status").filter({hasText:"Goose preference saved."}).waitFor();
  await setup.getByRole("button",{name:"Run dependency checks"}).click();
  await setup.locator("#setup-results").getByText("Initialized",{exact:true}).waitFor();
  await setup.getByRole("button",{name:"Save setup"}).click();
  await setup.waitFor({state:"detached"});
  await page.locator("#mode-trigger").click();
  await page.getByRole("menuitemradio",{name:/Agent/}).click();
  await page.locator("#chat-input").fill("Reply with fixture text.");
  await page.locator("#chat-send").click();
  await page.locator(".assistant-text").getByText("Portable Goose fixture response.",{exact:true}).waitFor({timeout:45000});
  await page.locator("#chat-send").filter({hasText:"Send"}).waitFor();
  const initial=await api(page,"/api/goose-runtime");
  assert.equal(initial.source,"portable");
  assert.equal(initial.version,initial.release.version);
  const {sessions}=await api(page,"/api/sessions");
  const first=(await api(page,"/api/sessions/"+sessions[0].id)).session;
  assert(first.gooseSessionId);
  await stop();
  const reopened=await start();
  recordErrors(reopened);
  await reopened.locator(".assistant-text").getByText("Portable Goose fixture response.",{exact:true}).waitFor();
  const persisted=await api(reopened,"/api/goose-runtime");
  assert.equal(persisted.preference,"portable");
  assert.equal(persisted.systemAvailable,false);
  await reopened.locator("#chat-input").fill("Continue the same fixture session.");
  await reopened.locator("#chat-send").click();
  await reopened.locator(".assistant-text").getByText("Portable Goose fixture response.",{exact:true}).nth(1).waitFor({timeout:45000});
  await reopened.locator("#chat-send").filter({hasText:"Send"}).waitFor();
  const second=(await api(reopened,"/api/sessions/"+first.id)).session;
  assert.equal(second.gooseSessionId,first.gooseSessionId);
  const toggle=view=>view.getByRole("switch",{name:"Internet access"});
  const waitForToggle=(view,checked)=>view.getByRole("switch",{name:"Internet access",checked}).waitFor();
  async function webTurn(view,marker,approval=false){
    await view.locator("#chat-input").fill("[web:"+marker+"]");
    await view.locator("#chat-send").click();
    if(approval)await view.getByRole("button",{name:"Allow once",exact:true}).click({timeout:40000});
    await view.locator("#chat-send").filter({hasText:"Send"}).waitFor({timeout:45000});
    if(webFixtureError)throw webFixtureError;
    await view.locator(".assistant-text").getByText("Verified web fixture "+marker+".",{exact:true}).last().waitFor();
  }
  await waitForToggle(reopened,false);
  await toggle(reopened).click();
  await waitForToggle(reopened,true);
  for(const marker of Object.keys(webOperations))await webTurn(reopened,marker,true);
  await stop();
  const restored=await start();
  recordErrors(restored);
  await waitForToggle(restored,true);
  await restored.locator("#navigation [data-view=settings]").click();
  await restored.getByRole("navigation",{name:"Settings sections"}).getByRole("button",{name:"Agent internet access",exact:true}).click();
  await waitForToggle(restored,true);
  await toggle(restored).click();
  await waitForToggle(restored,false);
  await restored.locator("#navigation [data-view=chats]").click();
  await waitForToggle(restored,false);
  await webTurn(restored,"off");
  assert.deepEqual(errors,[]);
  console.log("PASS "+kind+" official portable Goose download, runtime persistence, ACP inference, and native session restoration with system Goose disabled");
  console.log("PASS "+kind+" Composer and Settings Internet access switches, preference restoration, real web tools, source URLs and useful failure results");
}

try{
  const page=await start();recordErrors(page);
  const setup=page.getByRole("dialog",{name:"Set up WiskHarness"});
  await setup.waitFor({timeout:25000});
  assert.equal(await page.title(),"WiskHarness");
  assert.equal((await fetch(base+"/api/health")).status,401);
  const currentVersion=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8")).version;
  assert.equal((await api(page,"/api/health")).version,currentVersion);
  if(runtimeQA){
    await checkPortableGoose(page,setup);
  }else{
  await setup.getByRole("button",{name:"Save setup"}).click();
  await setup.waitFor({state:"detached"});
  await nativeChecks(page);
  await chat(page);
  if(suite==="qa"){
    await page.locator(".assistant-text h2").getByText("Rendered answer").waitFor();
    assert.equal(await page.locator("#chat-send").innerText(),"Stop");
  }else{
    await page.locator(".assistant-text").filter({hasText:/WISK.BETA.CHECK/i}).waitFor({timeout:100000});
  }
  await page.locator("#chat-send").filter({hasText:"Send"}).waitFor({timeout:120000});
  const {sessions}=await api(page,"/api/sessions");
  async function checkMarkdown(view){
    const answer=view.locator(".assistant-text").first();
    await answer.locator("h2").waitFor();
    for(const selector of ["h1","h2","h3","h4","h5","h6","strong","em","del","ol li ul li","blockquote","hr","table",".markdown-code pre code .hljs-keyword"]){
      assert.equal(await answer.locator(selector).count(),1,selector);
    }
    assert.equal(await answer.locator("img,script,[href^=javascript]").count(),0);
    assert.equal(await view.evaluate(()=>window.wiskUnsafe),undefined);
    assert.equal(await answer.locator("a[href]").count(),1);
    await answer.getByRole("button",{name:/^(?:Copy code|Copied)$/}).click();
    await answer.getByRole("button",{name:"Copied",exact:true}).waitFor();
  }
  if(suite==="qa"){
    await checkMarkdown(page);
    assert.equal(planPayload.tools,undefined);
    assert.equal(planPayload.messages[0].role,"system");
    const session=(await api(page,"/api/sessions/"+sessions[0].id)).session;
    assert.equal(session.messages.at(-1).text,chunks.join(""));
    await page.locator(".performance-trigger").filter({hasText:/24 tokens\/sec.*context/}).waitFor();
    await page.setViewportSize({width:2560,height:1440});
    const metrics=await measurePanels(page,".performance-trigger");
    await metrics.getByText("Model performance").waitFor();
    await metrics.getByText("Selected model VRAM allocation", {exact:true}).waitFor();
    assert.match(await metrics.innerText(),/Unavailable/);
    if(screenshot)await page.screenshot({path:screenshot,animations:"disabled"});
    await page.keyboard.press("Escape");
    await page.locator("[data-view=models]").click();
    await page.locator("#models-search").fill("fixture");
    const switcher=page.locator(".model-visible");
    await switcher.first().waitFor();
    const key=await page.evaluate(()=>{window.__visibilityProbe={root:document.querySelector("#models-search"),start:performance.timeOrigin};return performance.timeOrigin});
    let visibilityRequests=0;
    page.on("request",req=>{if(req.method()==="POST"&&req.url().includes("/api/models/settings"))visibilityRequests++});
    const before=tags;
    for(const i of [0,1]){await switcher.nth(i).uncheck();await switcher.nth(i).isEnabled()}
    await page.waitForFunction(()=>[...document.querySelectorAll(".model-visible")].every(item=>!item.disabled));
    assert.equal(await page.locator("#models-search").inputValue(),"fixture");
    assert.equal(await page.evaluate(key=>performance.timeOrigin===key&&document.querySelector("#models-search")===window.__visibilityProbe.root,key),true);
    assert.equal(visibilityRequests,2);
    assert.equal(tags,before);
    await page.route("**/api/models/settings",route=>route.fulfill({status:503,json:{error:"Fixture save failure"}}),{times:1});
    await switcher.nth(2).uncheck();
    await page.getByText("Could not save visibility: Fixture save failure",{exact:true}).waitFor();
    assert.equal(await switcher.nth(2).isChecked(),true);
    await page.locator("[data-view=chats]").click();
    await page.locator("#mode-trigger").click();
    await page.getByRole("menuitemradio",{name:/Agent/}).click();
    await page.locator("#permission-trigger").getByText("Ask for approval").waitFor();
    await page.locator("#permission-trigger").click();
    await page.getByRole("menuitemradio",{name:/Full access/}).click();
    const confirm=page.getByRole("dialog",{name:"Enable Full access"});
    await confirm.getByRole("button",{name:"Enable Full access"}).click();
    await page.locator("#full-access-status").waitFor();
    await page.locator("#full-access-status").click();
    await page.getByRole("menuitemradio",{name:/Approve for me/}).click();
    await page.locator("#full-access-status").waitFor({state:"hidden"});
    await page.locator("#permission-trigger").getByText("Approve for me").waitFor();
    const sizes=[[2560,1440],[1920,1080],[1440,900],[1280,720],[1024,768]];
    const themes=["graphite","midnight","oled","forest","amethyst","ember","pearl"];
    for(const [width,height] of sizes){
      await page.setViewportSize({width,height});
      for(const theme of themes){
        await page.locator("#theme-trigger").click();
        await page.locator(".popover [data-theme="+theme+"]").click();
        assert.equal(await page.locator("body").getAttribute("data-theme"),theme);
        const contrast=await page.evaluate(async()=>{
          function luminance(color){
            const channels=color.match(/\d+(?:\.\d+)?/g).slice(0,3).map(Number).map(value=>{
              const s=value/255;
              return s<=0.04045?s/12.92:((s+0.055)/1.055)**2.4;
            });
            return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
          }
          const control=document.querySelector(".performance-trigger");
          const button=getComputedStyle(control);
          void button.color;
          await Promise.all(control.getAnimations().map(animation=>animation.finished.catch(()=>{})));
          const surface=getComputedStyle(document.querySelector(".composer"));
          const values=[luminance(button.color),luminance(surface.backgroundColor)].sort((a,b)=>b-a);
          return (values[0]+0.05)/(values[1]+0.05);
        });
        assert(contrast>=4.5,"Performance indicator contrast for "+theme+": "+contrast);
        for(const selector of ["#mode-trigger","#model-trigger","#permission-trigger",".performance-trigger"]){
          const panel=await measurePanels(page,selector);
          if(selector==="#permission-trigger"){
            const initial=await panel.locator(":focus").getAttribute("data-access");
            await page.keyboard.press("ArrowDown");
            assert.notEqual(await panel.locator(":focus").getAttribute("data-access"),initial);
          }
          if(selector==="#model-trigger")await page.locator("#chat-input").click();
          else await page.keyboard.press("Escape");
          await panel.waitFor({state:"detached"});
        }
      }
      console.log("PASS 7 themes, menu bounds and dismissal at "+width+"x"+height+" simulated CSS pixels");
    }
    await page.locator(".session-row").filter({hasText:"Stream the Markdown fixture"}).locator(".session-button").click();
    await checkMarkdown(page);
    await page.locator("#chat-input").fill("Second response for streaming cancellation");
    await page.locator("#chat-send").click();
    await page.locator("#chat-send").filter({hasText:"Stop"}).waitFor();
    await page.locator("#chat-send").click();
    await page.locator("#chat-send").filter({hasText:"Send"}).waitFor();
    await page.waitForFunction(async id=>(await(await fetch("/api/sessions/"+id)).json()).session.status==="cancelled",sessions[0].id);
    await page.getByRole("button",{name:"Continue in Agent Mode"}).click();
    await page.locator("#permission-trigger").waitFor();
    await checkMarkdown(page);
    await page.locator(".session-row[data-session='"+sessions[0].id+"'] .session-button").click();
    await page.locator(".session-row.active[data-session='"+sessions[0].id+"']").waitFor();
    await page.locator(".assistant-text h2").first().waitFor();
  }
  await stop();
  const reopened=await start();recordErrors(reopened);
  await reopened.locator(".assistant-text").filter({hasText:suite==="qa"?"Rendered answer":/WISK.BETA.CHECK/i}).first().waitFor({timeout:25000});
  await reopened.locator(".session-row.active[data-session='"+sessions[0].id+"']").waitFor();
  if(suite==="qa"){
    await checkMarkdown(reopened);
    await reopened.locator("[data-view=models]").click();
    await reopened.locator(".model-visible").first().waitFor();
    assert.deepEqual(await reopened.locator(".model-visible").evaluateAll(items=>items.map(item=>item.checked)),[false,false,true]);
    assert.deepEqual(JSON.parse(await readFile(join(config,"settings.json"),"utf8")).visible,[models[2]]);
    assert(streamCalls>0);
    await checkWorkspaceViews(reopened);
  }
  assert.deepEqual(errors,[]);
  console.log("PASS "+kind+" "+suite+" production renderer, authenticated API, conversation restoration"+(suite==="qa"?", model visibility, Markdown and keyboard controls":", and real Ollama Plan inference"));
  }
}finally{
  await stop().catch(error=>console.error(error.message));
  fake.close();
  console.log("Disposable evidence folder:",root);
}
