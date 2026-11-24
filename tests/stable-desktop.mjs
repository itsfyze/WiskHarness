import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {_electron} from "playwright-core";

const [file,output]=process.argv.slice(2);
if(!file||!output)throw new Error("Pass the packaged WiskHarness executable and screenshot directory.");
const root=await mkdtemp(path.join(tmpdir(),"Wisk stable desktop "));
const workspace=path.join(root,"Demo workspace"),config=path.join(root,"profile");
await Promise.all([mkdir(workspace),mkdir(config),mkdir(output,{recursive:true})]);
const model="fixture:desktop";
await writeFile(path.join(config,"settings.json"),JSON.stringify({workspace,model,setupComplete:true,updateAutomatic:false,agentEngine:"vibe",permissionMode:"ask"}));
await writeFile(path.join(workspace,"overview.txt"),"Source fixture that pre-dates the agent.\n");
const provider=createServer(async(req,res)=>{
  if(req.url==="/api/tags")return res.end(JSON.stringify({models:[{name:model,size:8000000000,details:{family:"fixture",parameter_size:"14B",quantization_level:"Q4"}}]}));
  if(req.url==="/api/show")return res.end(JSON.stringify({capabilities:["completion","tools","thinking"],model_info:{"fixture.context_length":32768}}));
  if(req.url==="/api/ps")return res.end(JSON.stringify({models:[{name:model,context_length:16384}]}));
  if(req.url!=="/api/chat"){res.statusCode=404;return res.end();}
  const data=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
  const messages=data.messages.filter(item=>item.role==="tool");
  let call=null;
  if(data.tools?.length){
    if(!messages.length)call={name:"write_file",arguments:{path:"review.py",content:"def status():\n    return 'Ready for review'\n"}};
    else if(messages.length===1)call={name:"read_file",arguments:{path:"review.py"}};
  }
  res.setHeader("content-type","application/x-ndjson");
  const chunk=message=>res.write(JSON.stringify({message:{role:"assistant",...message},done:false})+"\n");
  if(call)chunk({tool_calls:[{function:call}]});
  else for(const text of [
    "I created and read back the fixture source file. The saved tool results show the exact file contents.\n\n",
    "## Review\n\nThe workspace file is ready for inspection. Open the Changes tab to see the diff.\n\n",
    "| Check | Result |\n| --- | --- |\n| Source read-back | Passed |\n\n",
    String.fromCharCode(96).repeat(3)+"python\ndef status():\n    return 'Ready for review'\n"+String.fromCharCode(96).repeat(3)
  ]){
    if(res.destroyed)return;
    chunk({content:text});await delay(650);
  }
  if(!res.destroyed)res.end(JSON.stringify({done:true,done_reason:"stop",prompt_eval_count:1280,eval_count:42,eval_duration:3000000000})+"\n");
}).listen(0,"127.0.0.1");
await once(provider,"listening");
const placeholder=createServer().listen(0,"127.0.0.1");
await once(placeholder,"listening");
const port=placeholder.address().port;
await new Promise(resolve=>placeholder.close(resolve));
const errors=[];
let app;
try{
  app=await _electron.launch({executablePath:path.resolve(file),args:["--user-data-dir="+path.join(root,"electron")],
    env:{...process.env,LOCAL_AGENT_SETTINGS_DIR:config,LOCAL_AGENT_WORKSPACE:workspace,
      LOCAL_AGENT_PORT:String(port),LOCAL_AGENT_DISABLE_OBSIDIAN_CHECKPOINT:"1",
      LOCAL_AGENT_OLLAMA_URL:"http://127.0.0.1:"+provider.address().port},timeout:60000});
  const page=await app.firstWindow();
  page.on("pageerror",error=>errors.push(error.message));
  const inspect=async(name)=>{
    const v=page.viewportSize();
    const width=await page.evaluate(()=>document.documentElement.scrollWidth);
    assert.equal(width,v.width,name+" has document overflow");
    await page.screenshot({path:path.join(output,v.width+"-"+name+".png"),animations:"disabled"});
  };
  await page.setViewportSize({width:1920,height:1080});
  await page.locator("#chat-input").waitFor();
  await page.waitForFunction(()=>document.querySelector(".performance-trigger")?.textContent.includes("fixture:desktop"));
  for(const id of ["chat-input","chat-attach","composer-model","home-mode-trigger","permission-trigger","save-status","chat-send","composer-performance"])await page.locator("#"+id).waitFor();
  await page.getByRole("switch",{name:"Internet access"}).waitFor();
  await inspect("home");
  await page.locator("#composer-model").click();
  await inspect("models-picker");
  await page.keyboard.press("Escape");
  await page.locator("#chat-input").fill("Create review.py, then read it back and verify the contents.");
  await page.locator("#chat-send").click();
  const approval=page.getByRole("dialog",{name:"Tool approval required"});
  await approval.waitFor();
  await inspect("permission");
  await approval.getByRole("button",{name:"Allow once",exact:true}).click();
  await page.locator("#development-panel").getByRole("button",{name:/review.py/}).waitFor();
  await approval.waitFor();
  await approval.getByRole("button",{name:"Allow once",exact:true}).click();
  await page.waitForFunction(()=>/Generating.*≈/.test(document.querySelector(".performance-trigger")?.textContent||""));
  await inspect("streaming");
  await page.waitForFunction(()=>document.querySelector(".performance-trigger")?.textContent.includes("Last 14 t/s"));
  assert.match(await readFile(path.join(workspace,"review.py"),"utf8"),/Ready for review/);
  await inspect("conversation");
  await page.locator("#development-panel").getByRole("button",{name:/review.py/}).click();
  await page.getByRole("dialog",{name:"File changes"}).waitFor();
  await inspect("unified-diff");
  await page.getByRole("button",{name:"Side by side"}).click();
  await inspect("side-by-side-diff");
  await page.keyboard.press("Escape");
  await page.getByRole("tab",{name:"Files"}).click();
  await page.getByRole("button",{name:/overview.txt/}).click();
  await inspect("files");
  await page.getByRole("tab",{name:"Terminal"}).click();
  await page.locator("#terminal-shell").selectOption("cmd");
  await page.getByLabel("Command",{exact:true}).fill("echo Wisk terminal verification");
  await page.getByLabel(/I reviewed this command/).check();
  await page.getByRole("button",{name:"Run command"}).click();
  await page.locator("#terminal-output").filter({hasText:/Wisk terminal verification/}).waitFor();
  await inspect("terminal");
  await page.locator('[data-view="settings"]').click();
  await page.locator("#agent-engine").waitFor();
  await inspect("settings-ink");
  await page.locator('.theme-tile[data-theme="paper"]').click();
  await inspect("settings-paper");
  await page.locator("#settings-search").fill("Updates");
  await page.locator("#update-settings").waitFor();
  await inspect("updates");
  await page.locator("#settings-search").fill("");
  await page.locator('.theme-tile[data-theme="amethyst"]').click();
  await page.setViewportSize({width:2560,height:1440});
  await inspect("settings-amethyst");
  await page.locator('[data-view="mcp"]').click();
  await page.getByRole("heading",{name:"MCP servers"}).waitFor();
  await inspect("mcp-manager");
  await page.locator('[data-view="models"]').click();
  await page.getByRole("button",{name:model,exact:true}).click();
  await page.getByRole("dialog",{name:"Model configuration"}).waitFor();
  await inspect("model-configuration");
  await page.keyboard.press("Escape");
  await page.locator('[data-view="chats"]').click();
  await inspect("conversation-amethyst");
  assert.deepEqual(errors,[]);
  await page.reload();
  await page.locator("#chat-input").waitFor();
  assert.equal(await page.locator("body").getAttribute("data-theme"),"amethyst");
  console.log("PASS packaged Vibe desktop, permission, live metrics, review, file preview, terminal, model settings and theme persistence · "+root);
} finally {
  await app?.close();
  provider.closeAllConnections();
  await new Promise(resolve=>provider.close(resolve));
}
