import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const fixture=await mkdtemp(join(tmpdir(),"wisk-goose-"));
const workspace=join(fixture,"workspace"),config=join(fixture,"settings"),vault=join(fixture,"vault");
for(const directory of [workspace,config,vault])await mkdir(directory);
const now=join(vault,"Now.md");
await writeFile(now,"# Now\n\nPreserve this entry.\n");
await writeFile(join(workspace,"read.js"),"const fixture = 1;\n");
await writeFile(join(workspace,".env"),"synthetic value\n");
const model="fixture:latest",nonce="goose-fixture-session";
const goose=process.env.LOCAL_AGENT_GOOSE_PATH||join(homedir(),".local","bin","goose.exe");
await stat(goose);
const exists=async name=>stat(join(workspace,name)).then(()=>true,()=>false);
const headers={"X-WiskHarness-Session":nonce,"Content-Type":"application/json"};
const tasks=new Map();
let child,logs="",mockProblem=null;
const ollama=createServer(async(req,res)=>{
  try{
    if(req.url==="/api/tags")return res.end(JSON.stringify({models:[{name:model}]}));
    if(req.url==="/api/ps")return res.end(JSON.stringify({models:[{name:model,context_length:16384}]}));
    if(req.url==="/api/show")return res.end(JSON.stringify({model_info:{"fixture.context_length":16384},capabilities:["completion","tools"],details:{family:"fixture"}}));
    if(req.url==="/api/version")return res.end('{"version":"0.12.0"}');
    const compat=req.url==="/v1/chat/completions";
    if(!compat&&req.url!=="/api/chat"){res.statusCode=404;return res.end("{}")}
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    const data=JSON.parse(Buffer.concat(chunks));
    const recent=data.messages.filter(message=>message.role==="user").at(-1)?.content;
    const prompt=typeof recent==="string"?recent:recent?.map(part=>part.text||"").join(" ")||"";
    const marker=/\[fixture:([\w-]+)\]/.exec(prompt)?.[1];
    const task=tasks.get(marker);
    const tools=data.tools?.map(tool=>tool.function.name)||[];
    const previousTool=data.messages.some(message=>message.role==="tool");
    let message={role:"assistant",content:"Fixture response complete."};
    if(process.argv.includes("--trace"))console.log("provider fixture",req.url,marker,tools,previousTool,data.messages.map(m=>m.role));
    if(task&&!previousTool&&tools.length){
      const toolName=tools.find(name=>name===task.name||name.endsWith("__"+task.name));
      assert(toolName,"Tool "+task.name+" not offered; got "+tools.join(", "));
      message={role:"assistant",content:"",tool_calls:[{function:{name:toolName,arguments:task.args}}]};
    }
    if(!compat&&!data.tools){
      assert(/^You are in Plan mode/.test(data.messages[0].content));
      message={role:"assistant",content:"Plan text only."};
    }
    if(compat){
      const tool=message.tool_calls?.[0];
      if(tool)message.tool_calls=[{id:"call_"+marker,type:"function",function:{
        ...tool.function,arguments:JSON.stringify(tool.function.arguments)}}];
      const envelope={id:"chatcmpl-fixture",object:"chat.completion",created:Math.floor(Date.now()/1000),model};
      const finish_reason=tool?"tool_calls":"stop";
      if(!data.stream){
        res.setHeader("content-type","application/json");
        return res.end(JSON.stringify({...envelope,choices:[{index:0,message,finish_reason}],usage:{prompt_tokens:15,completion_tokens:5,total_tokens:20}}));
      }
      res.setHeader("content-type","text/event-stream");
      const frame=(delta,finish_reason)=>"data: "+JSON.stringify({...envelope,object:"chat.completion.chunk",choices:[{index:0,delta,finish_reason}]})+"\n\n";
      if(tool)message.tool_calls[0].index=0;
      return res.end(frame(message,null)+frame({},finish_reason)+"data: [DONE]\n\n");
    }
    const reply={model,created_at:new Date().toISOString(),message,done:true,done_reason:"stop",
      prompt_eval_count:15,eval_count:5,eval_duration:2e8,total_duration:3e8,load_duration:6e7,prompt_eval_duration:4e7};
    res.setHeader("content-type",data.stream?"application/x-ndjson":"application/json");
    res.end(JSON.stringify(reply)+(data.stream?"\n":""));
  }catch(error){mockProblem=error;res.statusCode=500;res.end(JSON.stringify({error:error.message}))}
});
ollama.listen(0,"127.0.0.1");
await once(ollama,"listening");
const bind=createServer().listen(0,"127.0.0.1");
await once(bind,"listening");
const port=bind.address().port;
await new Promise(resolve=>bind.close(resolve));
const base="http://127.0.0.1:"+port;
async function api(route,body,status=200,method=body===undefined?"GET":"POST",customHeaders=headers){
  const response=await fetch(base+route,{method,headers:customHeaders,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  const content=await response.json();
  assert.equal(response.status,status,route+": "+JSON.stringify(content));
  return content;
}
async function start(){
  child=spawn(process.execPath,["server.mjs"],{windowsHide:true,env:{...process.env,LOCAL_AGENT_PORT:String(port),
    LOCAL_AGENT_WORKSPACE:workspace,LOCAL_AGENT_SETTINGS_DIR:config,LOCAL_AGENT_OBSIDIAN_VAULT:vault,
    LOCAL_AGENT_DISABLE_OBSIDIAN_CHECKPOINT:"",WISKHARNESS_API_TOKEN:nonce,LOCAL_AGENT_OLLAMA_URL:"http://127.0.0.1:"+ollama.address().port,
    LOCAL_AGENT_GOOSE_PATH:goose},stdio:["ignore","ignore","pipe","ipc"]});
  child.stderr.setEncoding("utf8").on("data",value=>logs+=value);
  for(let i=0;i<100;i++){
    try{await api("/api/sessions");return}catch{}
    await delay(120);
  }
  throw Error("Backend startup failed: "+logs);
}
async function stop(){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exited=once(child,"exit");child.disconnect();
  await exited;
}
let sessionId;
async function run(name,operation,decide,{mode="agent",text="Perform the fixture operation"}={}){
  if(operation)tasks.set(name,operation);
  const {session}=await api("/api/sessions",{mode,model,workspace},201);
  sessionId=session.id;
  const response=await fetch(base+"/api/sessions/"+session.id+"/run",{method:"POST",headers,
    body:JSON.stringify({prompt:text+" [fixture:"+name+"]"}),signal:AbortSignal.timeout(170000)});
  assert.equal(response.status,200,await (response.ok?Promise.resolve(""):response.text()));
  const events=[];
  const decoder=new TextDecoder();
  let remaining="";
  for await(const bytes of response.body){
    remaining+=decoder.decode(bytes,{stream:true});
    let end;
    while((end=remaining.indexOf("\n\n"))>=0){
      const msg=remaining.slice(0,end);remaining=remaining.slice(end+2);
      if(!msg.startsWith("data: "))continue;
      const event=JSON.parse(msg.slice(6));
      events.push(event);
      if(event.type==="permission"){assert(decide,"Unexpected approval for "+name+": "+JSON.stringify(event));await decide(event)}
      if(event.type==="error")throw new Error(name+": "+event.message+" "+logs);
    }
  }
  if(mockProblem)throw mockProblem;
  assert(events.some(event=>event.type==="done"),name+" should finish");
  return events;
}
const view={name:"analyze",args:{path:join(workspace,"read.js")}};
const turn=async(event,effect,persistent,expected=200)=>api("/api/agent/permission",{requestId:event.requestId,
  optionId:event.options.find(option=>option.kind===(effect==="allow"?"allow_once":"reject_once"))?.optionId??null,persistent},expected);
try{
  await start();
  await api("/api/setup",{workspace,vault,model});
  const initial=await api("/api/security");
  assert.equal(initial.permissionMode,"ask");
  const denyShell={name:"shell",args:{command:"New-Item -ItemType File -Path deny.txt"}};
  const denied=await run("denied-shell",denyShell,async event=>{
    await api("/api/models/settings",{visibility:{model,visible:false}});
    assert.equal((await api("/api/health")).activeSessionId,sessionId);
    await turn(event,"deny");
  });
  assert(denied.some(event=>event.type==="permission"));
  assert.equal(await exists("deny.txt"),false);
  console.log("PASS Goose asks before a shell operation, model hiding leaves the run active, and Deny prevents execution");

  const shell={name:"shell",args:{command:"New-Item -ItemType File -Path once.txt"}};
  await run("allow-once",shell,event=>turn(event,"allow"));
  assert(await exists("once.txt"));
  assert.equal((await api("/api/security")).permissionRules.length,0);
  console.log("PASS Goose Allow once executes locally without creating a rule");

  const ask=await run("always-allow",view,async event=>{
    assert.equal(event.canAlwaysAllow,true,JSON.stringify(event));
    await turn(event,"allow","allow");
  });
  assert(ask.some(event=>event.type==="permission"),"Goose should ask for the configured view");
  const [{id:allowId}]=(await api("/api/security")).permissionRules;
  await stop();await start();
  const resumed=await run("persist-allow",view);
  assert(resumed.some(event=>event.type==="tool"&&event.update.status==="completed"));
  await api("/api/security/rules/"+allowId,{effect:"revoke"},200,"PATCH");
  await run("revoked",view,event=>turn(event,"deny","deny"));
  await stop();await start();
  const deniedView=await run("persist-deny",view);
  assert(!deniedView.some(event=>event.type==="tool"&&event.update.status==="completed"));
  const [{id:denyId}]=(await api("/api/security")).permissionRules;
  await api("/api/security/rules/"+denyId,{effect:"revoke"},200,"PATCH");
  console.log("PASS exact Goose file rules persist across restart and can be revoked");

  await api("/api/security/mode",{mode:"auto"});
  const auto=await run("safe-read",view);
  assert(auto.some(event=>event.type==="tool"&&event.update.status==="completed"));
  await run("auto-ask",denyShell,event=>turn(event,"deny"));
  assert.equal(await exists("deny.txt"),false);
  console.log("PASS Approve for me permits only recognized safe reads");

  await api("/api/security/mode",{mode:"full"},400);
  await api("/api/security/mode",{mode:"full",confirmed:true},401,"POST",{"Content-Type":"application/json"});
  await api("/api/security/mode",{mode:"full",confirmed:true});
  const full=await run("full-create",{name:"write",args:{path:join(workspace,"full.txt"),content:"fixture create"}},
    undefined,{text:"Create full.txt in the current test workspace"});
  assert(await exists("full.txt"),JSON.stringify(full.filter(event=>event.type==="tool"||event.type==="status")));
  assert(full.some(event=>event.type==="memory"&&event.saved));
  assert.match(await readFile(now,"utf8"),/Preserve this entry/);
  assert.match(await readFile(join(vault,"Projects","workspace.md"),"utf8"),/Verified progress:\*\* full.txt/);
  const fullShell=await run("full-shell", {name:"shell",args:{command:"Write-Output 'FULL_ACCESS_SHELL_OK' | Set-Content -LiteralPath full-shell.txt"}});
  assert(await exists("full-shell.txt"),"Full access must execute a real Goose shell command without prompting");
  assert(!fullShell.some(event=>event.type==="permission"),"Full access must not prompt for shell operations");
  const secret=await run("protected-file",{...view,args:{...view.args,path:join(workspace,".env")}});
  assert(secret.some(event=>event.type==="status"&&event.update.includes("Blocked an agent tool")));
  assert.equal(await exists("deny.txt"),false);
  console.log("PASS Full access automatically executes real Goose shell and structured edits, while inspectable protected paths remain blocked");

  await chmod(now,0o444);
  const failed=await run("write-with-failed-checkpoint",{name:"write",args:{path:join(workspace,"recovery.txt"),content:"restore"}},
    undefined,{text:"Create recovery.txt in the current test workspace"});
  assert.equal(failed.find(event=>event.type==="memory").saved,false);
  assert.equal(failed.find(event=>event.type==="memory").note,now);
  assert.equal(failed.find(event=>event.type==="done").session.status,"completed");
  const retryId=sessionId;
  await chmod(now,0o666);
  assert.equal((await api("/api/sessions/"+retryId+"/checkpoint/retry",{})).checkpoint.saved,true);
  assert.match(await readFile(now,"utf8"),/Create recovery.txt/);
  console.log("PASS a failed Obsidian write is reported independently and retry recovers");
  await api("/api/security/mode",{mode:"ask"});
  const plan=await run("plan",null,undefined,{mode:"plan",text:"Create a project plan"});
  assert(!plan.some(event=>["tool","permission","memory"].includes(event.type)));
  assert.equal(plan.filter(event=>event.type==="metrics").at(-1).metrics.tokensPerSecond,25);
  const beforeOrdinary=await readFile(now,"utf8");
  const ordinary=await run("ordinary-agent",null,undefined,{text:"Good morning"});
  assert(!ordinary.some(event=>["permission","tool","memory"].includes(event.type)));
  assert.equal(await readFile(now,"utf8"),beforeOrdinary);
  console.log("PASS Plan tool/vault isolation, ordinary Agent conversation and Ollama statistics");
  await run("cancel",denyShell,async event=>{
    await api("/api/agent/cancel",{sessionId});
    await turn(event,"allow",undefined,404);
  });
  assert.equal(await exists("deny.txt"),false);
  console.log("PASS cancellation rejects the stale ID and prevents execution");

  if(process.argv.includes("--expiry")){
    await run("expiry",denyShell,async event=>{
      await delay(Math.max(0,event.expiresAt-Date.now())+100);
      await turn(event,"allow",undefined,404);
    });
    assert.equal(await exists("deny.txt"),false);
    console.log("PASS a real Goose request expires and cannot execute");
  }
  console.log("Disposable evidence folder:",fixture);
}catch(error){
  console.error("Disposable evidence folder:",fixture,logs);
  throw error;
}finally{
  await chmod(now,0o666).catch(()=>{});
  await stop();
  ollama.close();
}
