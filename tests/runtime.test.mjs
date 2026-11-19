import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function freePort(){
  const sock=createServer().listen(0,"127.0.0.1");
  await once(sock,"listening");
  const {port}=sock.address();
  await new Promise(resolve=>sock.close(resolve));
  return port;
}

test("disposable Windows profile enforces desktop nonce and Plan isolation, and streams real terminal output", {skip:process.platform!=="win32"}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"wisk-runtime-"));
  const workspace=path.join(root,"workspace"), config=path.join(root,"config");
  fs.mkdirSync(workspace);fs.mkdirSync(config);
  const port=await freePort(), unavailable=await freePort(), nonce="fixture-only-session";
  const base="http://127.0.0.1:"+port;
  let child, details="";
  const launch=async()=>{
    child=spawn(process.execPath,["server.mjs"],{env:{...process.env,LOCAL_AGENT_PORT:String(port),
      LOCAL_AGENT_WORKSPACE:workspace,LOCAL_AGENT_SETTINGS_DIR:config,LOCAL_AGENT_OLLAMA_URL:"http://127.0.0.1:"+unavailable,
      LOCAL_AGENT_GOOSE_PATH:path.join(root,"missing-goose.exe"),WISKHARNESS_API_TOKEN:nonce},windowsHide:true});
    child.stderr.setEncoding("utf8").on("data",data=>details+=data);
    for(let i=0;i<80;i++){
      try {if((await fetch(base+"/api/health",{headers:{"X-WiskHarness-Session":nonce}})).ok)return}catch{}
      await wait(100);
    }
    throw new Error("Server was unavailable "+details);
  };
  const stop=async()=>{
    if(child?.exitCode===null&&child.signalCode===null){const done=once(child,"exit");child.kill();await done}
  };
  t.after(async()=>{await stop();fs.rmSync(root,{recursive:true,force:true})});
  const call=async(route,{body,status=200,headers={}}={})=>{
    const r=await fetch(base+route,{method:body===undefined?"GET":"POST",
      headers:{"X-WiskHarness-Session":nonce,"Content-Type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal(r.status,status,route);
    return r.json();
  };
  await launch();
  assert.equal((await fetch(base+"/api/sessions")).status,401);
  await call("/api/sessions",{body:{mode:"agent"},headers:{origin:"https://example.org"},status:403});
  const setup=await call("/api/setup");
  assert.equal(setup.configured,false);
  const diagnostics=await call("/api/diagnostics?probe=1");
  assert.equal(diagnostics.acp.ok,false);
  assert(diagnostics.ollamaError);
  assert.equal(diagnostics.modelsCount,null);
  assert.equal(diagnostics.checks.terminal,true);
  await call("/api/setup",{body:{workspace,vault:"",model:""}});
  const {session:plan}=await call("/api/sessions",{body:{mode:"plan"},status:201});
  const {session:agent}=await call("/api/sessions",{body:{mode:"agent"},status:201});
  const command={shell:"powershell",command:"Write-Output 'WISK-STDOUT'; [Console]::Error.WriteLine('WISK-STDERR'); exit 7",confirmed:true};
  await call("/api/sessions/"+plan.id+"/terminal",{body:command,status:403});
  const route="/api/sessions/"+agent.id+"/terminal";
  await call(route,{body:{...command,confirmed:false},status:400});
  const run=await call(route,{body:command,status:201});
  async function finished(id){
    for(let i=0;i<80;i++){
      const data=await call(route);
      const entry=data.history.find(item=>item.id===id);
      if(entry&&entry.state!=="running")return entry;
      await wait(125);
    }
    throw new Error("Command did not finish");
  }
  const end=await finished(run.run.id);
  assert.equal(end.code,7);
  assert(end.chunks.some(chunk=>chunk.stream==="stdout"&&chunk.text.includes("WISK-STDOUT")));
  assert(end.chunks.some(chunk=>chunk.stream==="stderr"&&chunk.text.includes("WISK-STDERR")));
  const cmd=await call(route,{body:{shell:"cmd",command:"echo WISK-CMD",confirmed:true},status:201});
  const cmdEnd=await finished(cmd.run.id);
  assert.equal(cmdEnd.code,0);assert(cmdEnd.chunks.some(chunk=>chunk.text.includes("WISK-CMD")));
  const processTest=await call(route,{body:{shell:"powershell",command:"$p = Start-Process powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep 120' -WindowStyle Hidden -PassThru; Write-Output ('child:' + $p.Id); Wait-Process -Id $p.Id",confirmed:true},status:201});
  let pid;
  for(let i=0;i<80&&!pid;i++){
    const data=await call(route);
    pid=Number(data.running?.chunks.map(chunk=>chunk.text).join("").match(/child:(\d+)/)?.[1]);
    if(!pid)await wait(125);
  }
  assert(pid);
  await call("/api/updates/download",{body:{},status:409});
  const cancelled=await call(route+"/stop",{body:{}});
  assert.equal(cancelled.treeTerminationConfirmed,true);
  assert.equal((await finished(processTest.run.id)).state,"cancelled");
  await wait(200);
  assert.throws(()=>process.kill(pid,0));
  await stop();await launch();
  assert.equal((await call("/api/setup")).configured,true);
  assert.equal((await call(route)).history.length,3);
  assert.equal((await call("/api/sessions")).sessions.length,2);
});

test("disposable profiles validate model permissions, redaction, diagnostics and backup restore", {skip:process.platform!=="win32"},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"wisk-restore-"));
  const workspace=path.join(root,"project"),settings=path.join(root,"source"), destination=path.join(root,"restored");
  fs.mkdirSync(workspace);
  const children=[],nonce="fixture-profile-token", marker="sk-"+"wiskfixture".repeat(4);
  const requests=[];
  const fake=createHttpServer((req,res)=>{
    if(req.url==="/v1/models"){res.setHeader("content-type","application/json");res.end(JSON.stringify({data:[{id:"fixture/model"}]}));return;}
    let raw="";
    req.on("data",chunk=>raw+=chunk);
    req.on("end",()=>{
      const data=JSON.parse(raw);
      requests.push(data);
      const response=JSON.stringify({choices:[{delta:{content:"reply "+marker},finish_reason:"stop"}],usage:{prompt_tokens:7,completion_tokens:2}});
      res.writeHead(200,{"content-type":"text/event-stream"}).end("data: "+response+"\n\ndata: [DONE]\n\n");
    });
  }).listen(0,"127.0.0.1");
  await once(fake,"listening");
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,"exit");child.kill();await exited;}
    await new Promise(resolve=>fake.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const unavailable=await freePort();
  async function launch(profile){
    const port=await freePort(),url="http://127.0.0.1:"+port;
    const child=spawn(process.execPath,["server.mjs"],{env:{...process.env,LOCAL_AGENT_PORT:String(port),
      LOCAL_AGENT_SETTINGS_DIR:profile,LOCAL_AGENT_WORKSPACE:workspace,WISKHARNESS_API_TOKEN:nonce,
      LOCAL_AGENT_DISABLE_OBSIDIAN_CHECKPOINT:"1",LOCAL_AGENT_OLLAMA_URL:"http://127.0.0.1:"+unavailable},windowsHide:true});
    children.push(child);
    let errors="";
    child.stderr.on("data",chunk=>errors+=chunk);
    const call=(route,body,header={})=>fetch(url+route,{method:body===undefined?"GET":"POST",headers:{
      "content-type":"application/json","x-wiskharness-session":nonce,...header
    },body:body===undefined?undefined:JSON.stringify(body)});
    for(let i=0;i<60;i++){
      try{if((await call("/api/health")).ok)return call}catch{}
      await wait(100);
    }
    throw new Error("Isolated app failed to launch: "+errors);
  }
  const call=await launch(settings);
  const api=async(route,body,status=200)=>{
    const response=await call(route,body);
    assert.equal(response.status,status,route);
    return response.json();
  };
  const policy=await api("/api/security");
  assert.equal(policy.agentSandbox,false);
  assert.equal(policy.workspaceOnly,true);
  await api("/api/security",{...policy,workspaceOnly:false},400);
  await api("/api/security",{reset:true});
  const model="@provider/compatible/fixture/model";
  await api("/api/providers/compatible",{enabled:true,base:"http://127.0.0.1:"+fake.address().port+"/v1",model:"fixture/model"});
  const discovered=await api("/api/providers/compatible/test",{});
  assert(discovered.providers.find(item=>item.id==="compatible").connected);
  const fakeKey="fixture-"+"password".repeat(5);
  const apiKeyResult=await api("/api/providers/openai",{enabled:true,model:"fixture/model",key:fakeKey});
  assert(apiKeyResult.providers.find(item=>item.id==="openai").keySaved);
  assert(!JSON.stringify(apiKeyResult).includes(fakeKey));
  assert(!fs.readFileSync(path.join(settings,"settings.json"),"utf8").includes(fakeKey));
  const cloud="@provider/openai/fixture/model";
  const cloudChat=(await api("/api/sessions",{mode:"plan",model:cloud},201)).session;
  await api("/api/sessions/"+cloudChat.id+"/run",{prompt:"No cloud consent"},403);
  await api("/api/sessions/"+cloudChat.id+"/run",{prompt:"Do not send "+marker,cloudConsent:cloud},400);
  await api("/api/model-defaults",{mode:"plan",model});
  await api("/api/model-defaults",{mode:"agent",model},400);
  const plan=(await api("/api/sessions",{mode:"plan"},201)).session;
  assert.equal(plan.model,model);
  const run=await call("/api/sessions/"+plan.id+"/run",{prompt:"Fixture Plan chat"});
  assert.equal(run.status,200);
  assert((await run.text()).includes('"type":"done"'));
  const saved=(await api("/api/sessions/"+plan.id)).session;
  assert.equal(saved.messages[1].text,"reply [redacted credential]");
  assert.equal(requests[0].tools,undefined);
  const diag=await api("/api/diagnostic-report");
  for(const fragment of [root,plan.id,"Fixture Plan chat",marker,fakeKey])assert(!JSON.stringify(diag).includes(fragment));
  const backup=await api("/api/profile-backup");
  assert.equal(backup.conversations.length,2);
  assert(!JSON.stringify(backup).includes(fakeKey));
  assert(!JSON.stringify(backup).includes(marker));
  const restore=await launch(destination);
  const malformed=await restore("/api/profile-backup",{backup:{...backup,schema:999},confirm:true});
  assert.equal(malformed.status,400);
  const preview=await (await restore("/api/profile-backup",{backup})).json();
  assert.equal(preview.preview.chats,2);
  assert.equal((await (await restore("/api/sessions")).json()).sessions.length,0);
  const imported=await (await restore("/api/profile-backup",{backup,confirm:true})).json();
  assert.equal(imported.restored,true);
  assert.equal((await (await restore("/api/sessions/"+plan.id)).json()).session.messages[1].text,saved.messages[1].text);
  assert.equal((await (await restore("/api/providers")).json()).providers.find(item=>item.id==="openai").keySaved,false);
  const duplicate=await (await restore("/api/profile-backup",{backup})).json();
  assert.equal(duplicate.preview.chats,0);
  await api("/api/providers/openai",{enabled:false,model:"fixture/model",removeKey:true});
  assert(!fs.existsSync(path.join(settings,"local-data","provider-credentials","openai.dpapi")));
});

