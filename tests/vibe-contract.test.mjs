import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {once} from "node:events";
import {mkdtemp, mkdir, readFile, writeFile, stat} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {createAgentWeb} from "../agent-web.mjs";
import {connectMcp,validateMcpAuth,validateMcpServer} from "../mcp-manager.mjs";
import {vibeConfig,vibeSessionKey} from "../vibe-runtime.mjs";

const model="fixture:vibe";
const toolCall=(name,args)=>({tool_calls:[{function:{name,arguments:args}}]});

async function listen(handler){
  const server=createServer(handler).listen(0,"127.0.0.1");
  await once(server,"listening");
  return {server,port:server.address().port};
}
async function stop(peer){
  peer.server.closeAllConnections();
  await new Promise(resolve=>peer.server.close(resolve));
}

test("Vibe config preserves custom identifiers and stores no transport credential",()=>{
  const config=vibeConfig({model:"local-devstral:v1",endpoint:"http://127.0.0.1:4317/_vibe",context:16384,outputs:2048,temperature:.2});
  assert.match(config,/name = "local-devstral:v1"/);
  assert.match(config,/enable_telemetry = false/);
  assert.match(config,/api_key_env_var = "WISK_VIBE_TOKEN"/);
  assert.notEqual(vibeSessionKey("C:/first",config,["read"]),vibeSessionKey("C:/second",config,["read"]));
});

test("Brave Search uses a fixed endpoint and refuses sensitive queries before transmitting",async()=>{
  let sent=0;
  const web=createAgentWeb({braveKey:()=>"fixture-key",fetcher:async(url,options)=>{
    sent++;
    assert.equal(url.origin,"https://api.search.brave.com");
    assert.equal(url.searchParams.get("q"),"Fixture query");
    assert.equal(options.headers["x-subscription-token"],"fixture-key");
    assert.equal(options.redirect,"error");
    return Response.json({web:{results:[{title:"Public fixture",url:"https://example.com/result",description:"Fixture snippet"}]}});
  }});
  assert.match(await web.searchWeb("Fixture query","web"),/Public fixture\nhttps:\/\/example\.com\/result/);
  await assert.rejects(web.searchWeb("C:/Users/private","web"),/public search terms/);
  assert.equal(sent,1);
});

test("explicitly configured local MCP negotiates and lists real tools",async()=>{
  if(process.platform!=="win32")return;
  const config=validateMcpServer({id:"fixture",enabled:true,transport:"stdio",command:process.execPath,
    args:[path.resolve("agent-web-mcp.mjs")]});
  assert.throws(()=>validateMcpAuth({PATH:"unexpected"},"stdio"),/Invalid/);
  const live=await connectMcp(config,{workspace:process.cwd(),auth:{},signal:AbortSignal.timeout(12000)});
  try{assert.deepEqual(live.tools.map(item=>item.name).sort(),["open_page","search_web"]);}
  finally{await live.stop();}
});

test("pinned Vibe ACP streams and enforces tool scope, permissions, review and read-only modes",{
  skip:!process.env.LOCAL_AGENT_VIBE_RESOURCES,timeout:95000
},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"Wisk Vibe contract "));
  const workspace=path.join(root,"workspace"),profile=path.join(root,"profile");
  await Promise.all([mkdir(workspace),mkdir(profile)]);
  await writeFile(path.join(workspace,"existing.txt"),"pre-existing user content");
  await writeFile(path.join(profile,"settings.json"),JSON.stringify({agentEngine:"vibe",permissionMode:"ask",updateAutomatic:false}));
  const echoName="mcp_"+createHash("sha256").update("echo").digest("hex").slice(0,8)+"_repeat";
  const observed=[];
  let fixtureError;
  const upstream=await listen(async(req,res)=>{
    if(req.url==="/api/tags")return res.end(JSON.stringify({models:[{name:model}]}));
    if(req.url==="/api/show")return res.end(JSON.stringify({capabilities:["completion","tools"],model_info:{"fixture.context_length":32768}}));
    if(req.url==="/api/ps")return res.end(JSON.stringify({models:[]}));
    if(req.url!=="/api/chat"){res.statusCode=404;return res.end();}
    try{
      const data=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
      const user=data.messages.findLast(item=>item.role==="user")?.content||"";
      const last=data.messages.at(-1);
      const names=(data.tools||[]).map(item=>item.function.name);
      observed.push({user,names});
      let message={content:"Verified fixture with real ACP tool results."};
      if(user.includes("PLAN_MARKER")&&names.length){
        assert(names.includes("read_file"));
        assert(!names.includes("write_file")&&!names.includes("run_command"));
        if(last.role!=="tool")message=toolCall("read_file",{path:"existing.txt"});
      }else if(user.includes("MCP_MARKER")&&names.includes(echoName)){
        if(last.role!=="tool")message=toolCall(echoName,{text:"MCP fixture handshake"});
        else assert.match(last.content,/MCP fixture handshake/);
      }else if(user.includes("ASK_MARKER")){
        assert.equal(names.length,0);
      }else if(user.includes("OUTSIDE_MARKER")&&names.length&&last.role!=="tool"){
        message=toolCall("write_file",{path:"../blocked.txt",content:"blocked"});
      }else if(user.includes("CREATE_MARKER")&&names.length){
        assert(names.includes("write_file")&&!names.includes("bash")&&!names.includes("run_typescript"));
        const toolMessages=data.messages.filter(item=>item.role==="tool");
        if(!toolMessages.length)message=toolCall("write_file",{path:"generated.txt",content:"verified content"});
        else if(toolMessages.length===1)message=toolCall("read_file",{path:"generated.txt"});
        else message={content:"Verified generated.txt. <turn-context>DO_NOT_RENDER</turn-context>"};
      }
      res.setHeader("content-type","application/x-ndjson");
      res.write(JSON.stringify({message:{role:"assistant",...message},done:false})+"\n");
      res.end(JSON.stringify({done:true,done_reason:"stop",eval_count:30,prompt_eval_count:300,eval_duration:1000000000})+"\n");
    }catch(error){fixtureError=error;res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
  });
  const placeholder=await listen((_req,res)=>res.end());
  const port=placeholder.port;
  await stop(placeholder);
  const token="vibe-disposable-contract";
  const child=spawn(process.execPath,["server.mjs"],{env:{...process.env,LOCAL_AGENT_OLLAMA_URL:"http://127.0.0.1:"+upstream.port,
    LOCAL_AGENT_SETTINGS_DIR:profile,LOCAL_AGENT_WORKSPACE:workspace,LOCAL_AGENT_PORT:String(port),LOCAL_AGENT_DISABLE_OBSIDIAN_CHECKPOINT:"1",
    WISKHARNESS_API_TOKEN:token},windowsHide:true,stdio:["ignore","pipe","pipe","ipc"]});
  let stderr="";
  child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-3500)});
  async function api(route,body){
    const response=await fetch("http://127.0.0.1:"+port+route,{method:body===undefined?"GET":"POST",
      headers:{"content-type":"application/json","x-wiskharness-session":token},body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
    if(!response.ok)throw new Error(route+" "+response.status+" "+await response.text());
    return response;
  }
  async function run(mode,prompt){
    const {session}=await (await api("/api/sessions",{model,workspace,mode})).json();
    const stream=await api("/api/sessions/"+session.id+"/run",{prompt});
    let buffer="",final,approvals=0,live=false;
    for await(const bytes of stream.body.pipeThrough(new TextDecoderStream())){
      buffer+=bytes;
      let end;
      while((end=buffer.indexOf("\n\n"))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(!line.startsWith("data: "))continue;
        const event=JSON.parse(line.slice(6));
        if(event.type==="permission"){
          approvals++;
          await api("/api/agent/permission",{requestId:event.requestId,optionId:"allow"});
        }
        if(event.type==="review"&&event.count===1){
          const review=await(await api("/api/sessions/"+session.id+"/review")).json();
          live=review.active&&review.changes[0].origin==="agent";
        }
        if(event.type==="error")throw new Error(event.message);
        if(event.type==="done")final=event;
      }
    }
    assert(final);
    return {session:(await(await api("/api/sessions/"+session.id)).json()).session,approvals,live,final};
  }
  try{
    for(let i=0;;i++){
      try{await api("/api/health");break;}
      catch(error){if(i>=60)throw error;await delay(100);}
    }
    assert.equal((await fetch("http://127.0.0.1:"+port+"/_vibe/tools")).status,403);
    const created=await run("agent","Create generated.txt, then read and verify its contents. CREATE_MARKER");
    assert.equal(created.final.stopReason,"end_turn");
    assert.equal(created.approvals,2);
    assert(created.live,"live change event missing");
    assert.equal(await readFile(path.join(workspace,"generated.txt"),"utf8"),"verified content");
    assert.equal(await readFile(path.join(workspace,"existing.txt"),"utf8"),"pre-existing user content");
    assert.doesNotMatch(created.session.messages.at(-1).text,/turn-context|DO_NOT_RENDER/);
    const change=created.session.review.changes[0];
    assert.equal(change.reversible,true);
    await writeFile(path.join(workspace,"generated.txt"),"later user edit");
    await assert.rejects(api("/api/sessions/"+created.session.id+"/review/"+change.id,{action:"revert",confirmed:true}),/changed after/);
    assert.equal(await readFile(path.join(workspace,"generated.txt"),"utf8"),"later user edit");
    await writeFile(path.join(workspace,"generated.txt"),"verified content");
    await api("/api/sessions/"+created.session.id+"/review/"+change.id,{action:"revert",confirmed:true});
    await assert.rejects(stat(path.join(workspace,"generated.txt")),/ENOENT/);
    assert.equal(await readFile(path.join(workspace,"existing.txt"),"utf8"),"pre-existing user content");
    const outside=await run("agent","Write a test file. OUTSIDE_MARKER");
    assert.equal(outside.approvals,0);
    assert.equal(outside.final.session.status,"incomplete");
    await assert.rejects(stat(path.join(root,"blocked.txt")),/ENOENT/);
    const plan=await run("plan","Inspect existing.txt, then describe a plan only. PLAN_MARKER");
    assert.equal(plan.final.stopReason,"end_turn");
    assert(observed.some(item=>item.user.includes("PLAN_MARKER")&&item.names.includes("read_file")));
    const ask=await run("ask","Answer without tools. ASK_MARKER");
    assert.equal(ask.approvals,0);
    assert.equal(ask.session.messages.at(-1).tools.length,0);
    const echoFile=path.join(root,"echo.mjs");
    const sdk=relative=>JSON.stringify(pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server",relative)).href);
    await writeFile(echoFile,[
      'import {McpServer} from '+sdk("mcp.js")+';',
      'import {StdioServerTransport} from '+sdk("stdio.js")+';',
      'import {z} from '+JSON.stringify(pathToFileURL(path.resolve("node_modules/zod/index.js")).href)+';',
      'const server=new McpServer({name:"echo",version:"1.0.0"});',
      'server.registerTool("repeat",{inputSchema:{text:z.string()}},({text})=>({content:[{type:"text",text}]}));',
      'await server.connect(new StdioServerTransport());'
    ].join("\n"));
    await api("/api/mcp",{operation:"save",confirmed:true,id:"echo",enabled:true,transport:"stdio",command:process.execPath,args:[echoFile]});
    const check=(await(await api("/api/mcp",{operation:"test",confirmed:true,id:"echo"})).json()).servers[0];
    assert.deepEqual(check.status.tools,["repeat"]);
    const external=await run("agent","Use the configured MCP echo tool. MCP_MARKER");
    assert.equal(external.approvals,1);
    assert(external.session.messages.at(-1).tools.some(tool=>tool.title===echoName&&tool.output.includes("MCP fixture handshake")));
    assert.ifError(fixtureError);
  }catch(error){
    error.message+="\nFixture: "+root+"\n"+stderr;
    throw error;
  }finally{
    if(child.connected){const exit=once(child,"exit");child.disconnect();await Promise.race([exit,delay(3000,null,{ref:false}).then(()=>child.kill())]);}
    await stop(upstream);
  }
});
