import assert from "node:assert/strict";
import {test} from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {createServer} from "node:http";
import {once} from "node:events";
import {spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";

const tool=(name,args,index=0)=>({function:{index,name,arguments:args}});
const finish=summary=>tool("finish_task",{status:"completed",summary});
const finalText=(status,summary)=>tool("finish_task",{status,summary});

test("Agent transport, turn lifecycle, workspace and permission regressions", {timeout:100_000,skip:process.platform!=="win32"},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"Wisk agent regression "));
  const workspace=path.join(root,"Current Project"),config=path.join(root,"Profile"),vault=path.join(root,"Vault");
  const outside=path.join(root,"denied.txt"),model="fixture:latest",compat="json:latest",unsupported="unavailable:latest";
  for(const name of [workspace,config,path.join(vault,"Projects")])await fs.mkdir(name,{recursive:true});
  await fs.writeFile(path.join(vault,"Now.md"),"Global memory should never reach inference: LINEAR_HISTORY_CANARY");
  await fs.writeFile(path.join(vault,"Projects","Current Project.md"),
    "# Project\n\n## Agent context\n\nWorkspace: "+workspace+"\n\nBOUND_WORKSPACE_CANARY\n\n## Previous project activity\n\nLINEAR_HISTORY_CANARY\n");
  await fs.writeFile(path.join(workspace,".env"),"SYNTHETIC_SECRET_CANARY");
  await fs.writeFile(path.join(config,"settings.json"),JSON.stringify({permissionMode:"full",updateAutomatic:false}));
  const hashes=await Promise.all(["server.mjs","agent-ollama.mjs","agent-tools.mjs","public/app.js"].map(file=>fs.readFile(file)));
  const hits=new Map();
  let failure;
  const provider=createServer(async(req,res)=>{
    try{
      if(req.url==="/api/tags")return res.end(JSON.stringify({models:[model,compat,unsupported].map(name=>({name}))}));
      if(req.url==="/api/ps")return res.end('{"models":[]}');
      const body=[];
      for await(const chunk of req)body.push(chunk);
      const input=JSON.parse(Buffer.concat(body));
      if(req.url==="/api/show"){
        const capabilities=input.model===model?["completion","tools","thinking"]:input.model===compat?["completion"]:[];
        return res.end(JSON.stringify({capabilities,parameters:"num_ctx 16384"}));
      }
      assert.equal(req.url,"/api/chat");
      assert.equal(input.options.num_ctx,16384);
      assert.equal(input.messages[0].role,"system");
      const objective=input.messages.find(message=>message.role==="user" && /\[case:/.test(message.content))?.content;
      const name=objective.match(/\[case:(\w+)\]/)[1];
      const count=(hits.get(name)||0)+1;hits.set(name,count);
      const options=(input.tools||[]).map(tool=>tool.function);
      const roles=input.messages.map(message=>message.role);
      const toolResults=input.messages.filter(message=>message.role==="tool").map(message=>JSON.parse(message.content));
      const all=JSON.stringify(input.messages);
      assert.doesNotMatch(all,/SYNTHETIC_SECRET_CANARY|turn-budget|turn-context/);
      if(name!=="linear")assert.doesNotMatch(all,/LINEAR_HISTORY_CANARY/);
      if(name==="fresh"){
        assert.match(input.messages[0].content,/BOUND_WORKSPACE_CANARY/);
        assert.equal(objective,"Create marker.txt [case:fresh]");
        assert.equal(roles.filter(role=>role==="user").length,1);
      }
      if(input.model===model){
        assert(options.some(tool=>tool.name==="write_file"&&tool.parameters.required.includes("content")));
        assert(!options.some(tool=>tool.name==="analyze"));
      }
      let message;
      switch(name){
        case "linear":
          message={tool_calls:[finalText("answered","LINEAR_HISTORY_CANARY")]};break;
        case "fresh":
          if(count===1)message={content:"Task plan\n\n~~~powershell\nanalyze .\n~~~"};
          if(count===2){
            res.write(JSON.stringify({message:{thinking:"HIDDEN_REASONING_CANARY",tool_calls:[tool("write_",'{\"path\":\"marker.txt\",')]} })+"\n");
            message={tool_calls:[tool("file",'\"content\":\"The harness created this.\"}')],content:"<turn-context>INTERNAL_CANARY</turn-context>"};
          }
          if(count===3){assert.equal(toolResults.at(-1).ok,true);message={tool_calls:[finalText("incomplete","Wrote the file; readback is next.")]};}
          if(count===4){assert.match(toolResults.at(-1).error,/Continue/);message={tool_calls:[finalText("incomplete","Another premature summary.")]};}
          if(count===5)message={tool_calls:[tool("read_file",{path:"marker.txt"})]};
          if(count===6){
            assert.equal(toolResults.at(-1).text,"The harness created this.");
            message={tool_calls:[finish("Verified marker.txt.<turn-context>INTERNAL_CANARY</turn-context>")]};
          }
          break;
        case "recover":
          if(count===1)message={tool_calls:[tool("analyze",{path:"."})]};
          if(count===2){assert.match(toolResults.at(-1).error,/Unknown tool/);message={tool_calls:[tool("run_command",{shell:"cmd",command:"exit /b 7"})]};}
          if(count===3){assert.equal(toolResults.at(-1).exitCode,7);message={tool_calls:[tool("run_command",{shell:"cmd",command:"echo RECOVERED"})]};}
          if(count===4){assert.match(toolResults.at(-1).stdout,/RECOVERED/);message={tool_calls:[tool("read_file",{path:"marker.txt"})]};}
          if(count===5){assert.equal(toolResults.at(-1).ok,true);message={tool_calls:[finish("The unregistered request was rejected. The corrected CMD command succeeded.")]};}
          break;
        case "denied":
          if(count===1)message={tool_calls:[tool("write_file",{path:outside,content:"must not write"})]};
          if(count===2){assert.match(toolResults.at(-1).error,/Blocked/);message={tool_calls:[tool("run_command",{shell:"powershell",command:"'NO' | Set-Content -LiteralPath denied-marker.txt"})]};}
          if(count===3){assert.match(toolResults.at(-1).error,/Permission denied/);message={tool_calls:[finalText("incomplete","Policy blocked the write and the command was declined.")]};}
          break;
        case "restricted":
          if(count===1)message={tool_calls:[tool("run_command",{shell:"cmd",command:"echo RESTRICTED"})]};
          if(count===2){assert.match(toolResults.at(-1).stdout,/RESTRICTED/);message={tool_calls:[finish("Verified approved output.")]};}
          break;
        case "stall":
          if(count===1)message={tool_calls:[tool("run_command",{shell:"cmd",command:"cmake --invalid"})]};
          if(count===2)message={tool_calls:[tool("run_command",{shell:"cmd",command:"cmake --invalid"})]};
          if(count===3){assert.match(toolResults.at(-1).error,/already ran/);message={tool_calls:[finalText("incomplete","No meaningful progress.") ]};}
          break;
        case "cancel":
          message={tool_calls:[tool("run_command",{shell:"powershell",command:"Start-Sleep 60"})]};break;
        case "budget":
          if(count===3)assert.match(input.messages[0].content,/resumed from a saved checkpoint/);
          message={tool_calls:[count===4?finish("Workspace inspected after continuing."):tool("list_directory",{path:"."})]};break;
        case "compat":
          assert(input.format?.properties.name.enum.includes("write_file"));
          assert.equal(input.tools,undefined);
          if(count===2)assert.match(input.messages.at(-1).content,/"ok":true/);
          message={content:JSON.stringify(count===1?{name:"write_file",arguments:{path:"compat.txt",content:"Structured compatibility"}}:
            count===2?{name:"read_file",arguments:{path:"compat.txt"}}:
            {name:"finish_task",arguments:{status:"completed",summary:"Wrote and verified compat.txt."}})};
          break;
        default:assert.fail("Unexpected inference case "+name);
      }
      assert(message,"Unexpected inference round "+count);
      res.end(JSON.stringify({message,done:true})+"\n");
    }catch(error){failure=error;res.statusCode=555;res.end("{}");}
  }).listen(0,"127.0.0.1");
  await once(provider,"listening");
  const tempPort=createServer().listen(0,"127.0.0.1");
  await once(tempPort,"listening");
  const port=tempPort.address().port;
  await new Promise(resolve=>tempPort.close(resolve));
  const nonce="wisk-test-only",headers={"x-wiskharness-session":nonce,"content-type":"application/json"};
  const child=spawn(process.execPath,["server.mjs"],{windowsHide:true,stdio:["ignore","ignore","pipe","ipc"],env:{
    ...process.env,LOCAL_AGENT_SETTINGS_DIR:config,LOCAL_AGENT_WORKSPACE:root,LOCAL_AGENT_OBSIDIAN_VAULT:vault,
    LOCAL_AGENT_DISABLE_OBSIDIAN_CHECKPOINT:"",LOCAL_AGENT_OLLAMA_URL:"http://127.0.0.1:"+provider.address().port,
    LOCAL_AGENT_PORT:String(port),WISKHARNESS_API_TOKEN:nonce
  }});
  let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);
  t.after(async()=>{
    if(child.connected){const exit=once(child,"exit");child.disconnect();await exit;}
    provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
    await fs.rm(root,{recursive:true,force:true});
  });
  async function api(route,body,status=200) {
    const response=await fetch("http://127.0.0.1:"+port+route,{method:body===undefined?"GET":"POST",headers,body:JSON.stringify(body),
      signal:AbortSignal.timeout(30_000)});
    assert.equal(response.status,status,route+": "+await (response.status!==status?response.text():""));
    return response;
  }
  for(let i=0;i<100;i++){
    try{await api("/api/setup");break}catch(error){if(i===99)throw Error(stderr,{cause:error});await delay(70);}
  }
  async function run(prompt,{choose=model,permission,resumeId}={}) {
    const {session}=resumeId?{session:{id:resumeId}}:await (await api("/api/sessions",{workspace,model:choose},201)).json();
    const response=await api("/api/sessions/"+session.id+"/run",resumeId?{resume:true}:{prompt});
    const decoder=new TextDecoder();
    const events=[];
    let buffer="";
    for await(const chunk of response.body){
      buffer+=decoder.decode(chunk,{stream:true});
      let end;
      while((end=buffer.indexOf("\n\n"))!==-1){
        const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(!frame.startsWith("data: "))continue;
        const event=JSON.parse(frame.slice(6));
        events.push(event);
        if(event.type==="permission"){assert(permission);await permission(event,session.id);}
      }
    }
    if(failure)throw failure;
    assert(!events.some(event=>event.type==="error"),JSON.stringify(events.filter(event=>event.type==="error")));
    const saved=(await (await api("/api/sessions/"+session.id)).json()).session;
    assert.equal(saved.messages[0].text,prompt);
    assert.doesNotMatch(JSON.stringify(events.filter(event=>event.type==="text")),/INTERNAL_CANARY|HIDDEN_REASONING_CANARY|turn-context|turn-budget/);
    assert.doesNotMatch(saved.messages.at(-1).text,/INTERNAL_CANARY|HIDDEN_REASONING_CANARY|turn-context|turn-budget/);
    return {saved,events,done:events.findLast(event=>event.type==="done")};
  }
  assert.equal((await run("Discuss Linear design history [case:linear]")).done.stopReason,"end_turn");
  const fresh=await run("Create marker.txt [case:fresh]");
  assert.equal(fresh.done.stopReason,"end_turn");
  assert.equal(fresh.saved.messages.length,2);
  assert.equal(await fs.readFile(path.join(workspace,"marker.txt"),"utf8"),"The harness created this.");
  assert.match(await fs.readFile(path.join(vault,"Projects","Current Project.md"),"utf8"),/Agent checkpoint saved|Verified marker\.txt/);
  let approvals=0;
  const approve=async event=>{approvals++;await api("/api/agent/permission",{requestId:event.requestId,optionId:"allow"});};
  assert.equal((await run("Diagnose failed tool requests [case:recover]",{permission:approve})).done.stopReason,"end_turn");
  assert.equal(approvals,1);
  const deny=async event=>{approvals++;await api("/api/agent/permission",{requestId:event.requestId,optionId:"reject"});};
  assert.equal((await run("Write outside and run a declined command [case:denied]",{permission:deny})).done.stopReason,"permission_blocked");
  assert.equal(approvals,2);
  for(const file of [outside,path.join(workspace,"denied-marker.txt")])await assert.rejects(fs.stat(file),{code:"ENOENT"});
  const cancel=async(_event,id)=>{await api("/api/agent/cancel",{sessionId:id});};
  assert.equal((await run("Run a lengthy operation [case:cancel]",{permission:cancel})).done.stopReason,"cancelled");
  assert.equal((await run("Create compat.txt [case:compat]",{choose:compat})).done.stopReason,"end_turn");
  assert.equal(await fs.readFile(path.join(workspace,"compat.txt"),"utf8"),"Structured compatibility");
  assert.equal((await run("Create a file [case:unsupported]",{choose:unsupported})).done.stopReason,"tools_unsupported");
  assert.equal(hits.has("unsupported"),false);
  await api("/api/agent/execution",{budget:{rounds:3,calls:1,minutes:2}});
  const limited=await run("Inspect the folder [case:budget]");
  assert.equal(limited.done.stopReason,"max_tool_calls");
  assert.equal(limited.saved.task.stopReason,"max_tool_calls");
  assert.match(limited.saved.task.checkpoint.lastProgress,/list_directory/);
  const resumed=await run("Inspect the folder [case:budget]",{resumeId:limited.saved.id});
  assert.equal(resumed.done.stopReason,"end_turn");
  assert.equal(resumed.saved.messages.length,4);
  await api("/api/agent/execution",{budget:{rounds:15,calls:20,minutes:2,recovery:3}});
  const stalled=await run("Build a project [case:stall]");
  assert.equal(stalled.done.stopReason,"recovery_stalled");
  assert.equal(stalled.saved.messages.at(-1).tools.length,1);
  await api("/api/security/mode",{mode:"ask"});
  const beforeRestricted=approvals;
  assert.equal((await run("Run a routine command [case:restricted]",{permission:approve})).done.stopReason,"end_turn");
  assert.equal(approvals,beforeRestricted+1);
  const newFolder=path.join(root,"New Project With Spaces");
  await api("/api/projects",{path:newFolder,create:true},201);
  assert((await fs.stat(newFolder)).isDirectory());
  const after=await Promise.all(["server.mjs","agent-ollama.mjs","agent-tools.mjs","public/app.js"].map(file=>fs.readFile(file)));
  assert.deepEqual(after,hashes);
});
