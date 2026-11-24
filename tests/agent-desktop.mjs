import assert from "node:assert/strict";
import { _electron, chromium } from "playwright-core";
import {spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import fs from "node:fs/promises";
import {createServer} from "node:http";
import {once} from "node:events";
import os from "node:os";
import path from "node:path";

const root=await fs.mkdtemp(path.join(os.tmpdir(),"Wisk desktop agent "));
const workspace=path.join(root,"Default Workspace"),project=path.join(root,"New Desktop Project"),config=path.join(root,"Profile");
await Promise.all([workspace,config].map(directory=>fs.mkdir(directory)));
const model="desktop-fixture:latest";
await fs.writeFile(path.join(config,"settings.json"),JSON.stringify({workspace,model,setupComplete:true,permissionMode:"full",updateAutomatic:false,projects:[workspace]}));
let rounds=0, problem;
const provider=createServer(async(req,res)=>{
  try{
    if(req.url==="/api/tags")return res.end(JSON.stringify({models:[{name:model}]}));
    if(req.url==="/api/ps")return res.end('{"models":[]}');
    if(req.url==="/api/show")return res.end('{"capabilities":["completion","tools"],"parameters":"num_ctx 16384"}');
    assert.equal(req.url,"/api/chat");
    const parts=[];
    for await(const part of req)parts.push(part);
    const {messages,tools}=JSON.parse(Buffer.concat(parts));
    assert(tools.some(tool=>tool.function.name==="run_command"));
    assert.match(messages[0].content,/New Desktop Project/);
    assert.deepEqual(messages.find(message=>message.role==="user"),{role:"user",content:"Create and verify the desktop fixture."});
    const previous=messages.findLast(message=>message.role==="tool");
    const round=++rounds;
    let name,args;
    if(round===1){name="write_file";args={path:"desktop.txt",content:"Wisk desktop fixture"};}
    if(round===2){
      assert.equal(JSON.parse(previous.content).ok,true);
      name="run_command";args={shell:"powershell",command:"Get-Content -LiteralPath desktop.txt"};
    }
    if(round===3){
      assert.match(JSON.parse(previous.content).stdout,/Wisk desktop fixture/);
      name="finish_task";args={status:"completed",summary:"Desktop tool output verified."};
    }
    assert(name);
    res.end(JSON.stringify({done:true,message:{tool_calls:[{function:{index:0,name,arguments:args}}]}})+"\n");
  }catch(error){problem=error;res.statusCode=555;res.end("{}");}
}).listen(0,"127.0.0.1");
await once(provider,"listening");
const temporary=createServer().listen(0,"127.0.0.1");
await once(temporary,"listening");
const port=temporary.address().port;
await new Promise(resolve=>temporary.close(resolve));

let app,browser,portable;
try{
  const executablePath=path.resolve(process.argv[2]||"release/v0.7.3-beta.4/win-unpacked/WiskHarness.exe");
  const args=["--user-data-dir="+path.join(root,"Electron")];
  const env={...process.env,LOCAL_AGENT_WORKSPACE:workspace,LOCAL_AGENT_SETTINGS_DIR:config,
    LOCAL_AGENT_DISABLE_OBSIDIAN_CHECKPOINT:"1",LOCAL_AGENT_PORT:String(port),LOCAL_AGENT_OLLAMA_URL:"http://127.0.0.1:"+provider.address().port};
  let page;
  if(process.argv.includes("--portable")){
    const debug=createServer().listen(0,"127.0.0.1");
    await once(debug,"listening");
    const debugPort=debug.address().port;
    await new Promise(resolve=>debug.close(resolve));
    portable=spawn(executablePath,[...args,"--remote-debugging-port="+debugPort],{env,windowsHide:true,stdio:"ignore"});
    const endpoint="http://127.0.0.1:"+debugPort;
    for(let i=0;i<600;i++){
      try{if((await fetch(endpoint+"/json/version")).ok)break;}catch{}
      if(i===599||portable.exitCode!==null)throw new Error("Portable desktop did not start");
      await delay(200);
    }
    browser=await chromium.connectOverCDP(endpoint);
    const context=browser.contexts()[0];
    page=context.pages()[0]||await context.waitForEvent("page");
  }else{
    app=await _electron.launch({executablePath,args,timeout:60000,env});
    page=await app.firstWindow();
  }
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.locator('#chat-input').waitFor();
  await page.locator('[data-view="projects"]').click();
  await page.locator('#project-path').fill(project);
  await page.locator('#project-create').click();
  await page.getByText("Folder created and selected",{exact:true}).waitFor();
  assert((await fs.stat(project)).isDirectory());
  await page.locator('[data-view="chats"]').click();
  await page.locator('#home-mode-trigger').click();
  await page.locator('[data-mode="agent"]').click();
  await page.locator('#home-workspace').click();
  await page.getByRole("menuitem",{name:"New Desktop Project",exact:true}).click();
  assert.equal(await page.locator('#home-workspace').getAttribute("title"),project);
  await page.locator('#chat-input').fill("Create and verify the desktop fixture.");
  await page.locator('#chat-send').click();
  await page.getByText("Desktop tool output verified.",{exact:true}).first().waitFor();
  assert.equal(await fs.readFile(path.join(project,"desktop.txt"),"utf8"),"Wisk desktop fixture");
  await assert.rejects(fs.stat(path.join(workspace,"desktop.txt")),{code:"ENOENT"});
  await page.locator('[data-view="settings"]').click();
  await page.locator('#agent-budget-rounds').fill("14");
  await page.getByRole("button",{name:"Save execution settings"}).click();
  await page.waitForFunction(async()=>{
    const response=await fetch("/api/agent/execution");
    return (await response.json()).budget?.rounds===14;
  });
  if(problem)throw problem;
  assert.equal(rounds,3);
  assert.deepEqual(errors,[]);
  console.log("Packaged desktop passed: project creation, per-chat workspace picker, real tool execution and prompt-free Full Access shell, saved budget.");
}finally{
  if(app)await app.close();
  if(browser){
    const session=await browser.newBrowserCDPSession();
    await session.send("Browser.close").catch(()=>{});
    await browser.close().catch(()=>{});
  }
  if(portable){
    for(let i=0;i<40&&portable.exitCode===null;i++)await delay(150);
    if(portable.exitCode===null)portable.kill();
  }
  provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
