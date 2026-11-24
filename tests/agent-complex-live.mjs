import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {once} from "node:events";
import {createServer} from "node:net";
import {spawn} from "node:child_process";
import {setTimeout as sleep} from "node:timers/promises";

const workspaceBase=await fs.mkdtemp(path.join(os.tmpdir(),"Wisk live agent "));
const config=path.join(workspaceBase,"profile");
await fs.mkdir(config);
await fs.writeFile(path.join(config,"settings.json"),JSON.stringify({permissionMode:"full",agentBudget:{rounds:50},updateAutomatic:false}));
const listener=createServer().listen(0,"127.0.0.1");
await once(listener,"listening");
const port=listener.address().port;
await new Promise(resolve=>listener.close(resolve));
const headers={"content-type":"application/json","x-wiskharness-session":"isolated-agent-live-fixture"};
const child=spawn(process.execPath,[process.env.WISK_VALIDATION_SERVER||"server.mjs"],{windowsHide:true,stdio:["ignore","pipe","pipe","ipc"],env:{
  ...process.env, LOCAL_AGENT_WORKSPACE:workspaceBase,LOCAL_AGENT_SETTINGS_DIR:config,
  LOCAL_AGENT_PORT:String(port),LOCAL_AGENT_DISABLE_OBSIDIAN_CHECKPOINT:"1",WISKHARNESS_API_TOKEN:headers["x-wiskharness-session"]}});
let stderr="";
child.stderr.on("data",chunk=>stderr+=chunk);
const api=async(route,body)=>{
  const response=await fetch("http://127.0.0.1:"+port+route,{method:body===undefined?"GET":"POST",headers,body:JSON.stringify(body),signal:AbortSignal.timeout(240_000)});
  if (!response.ok) throw new Error(route+" "+response.status+" "+await response.text());
  return response;
};
const cases=[["GUI","huihui_ai/qwen2.5-coder-abliterate:14b",
  "Implement a benign offline task tracker with Python tkinter. First create six folders: app, tests, config, docs, assets, and dist. Write app/model.py with add_task(tasks, title) and toggle_task(tasks, index), app/gui.py with a main() function that opens a functional tkinter window, entry, add button and toggling, config/settings.json with a title, and tests/test_model.py covering adding and toggling. Keep the GUI code simple. Avoid f-strings and nested quote expressions. If compilation fails, read the file and use edit_file to correct the syntax. Include a README with usage using python -m app.gui. Compile both application modules using python -m py_compile app/model.py app/gui.py, run automated tests with python -m unittest discover -s tests -v, and package the application into dist/task-tracker.zip using python -m zipfile -c dist/task-tracker.zip app config README.md. Verify the archive using python -m zipfile -t dist/task-tracker.zip. Use only the current folder, the standard library, and no network or installs. Finish only after source, compilation, tests, and archive are verified.",
  async(folder,tools)=>{
    for(const file of ["app/model.py","app/gui.py","config/settings.json","tests/test_model.py","dist/task-tracker.zip"])
      assert((await fs.stat(path.join(folder,file))).size>0,file);
    for(const command of [/py_compile/,/unittest/,/zipfile.*-c/,/zipfile.*-t/])
      assert(tools.some(tool=>tool.status==="completed"&&tool.title==="run_command"&&command.test(tool.input)),String(command));
    const test=spawn("python",["-m","unittest","discover","-s","tests","-v"],{cwd:folder,windowsHide:true});
    assert.equal((await once(test,"close"))[0],0);
    const gui=spawn("python",["-c","import tkinter as tk; from app import gui; original=tk.Tk; tk.Tk=lambda: make_root(); exec(\"def make_root():\\n r=original(); r.after(400, r.destroy); return r\"); gui.main()"],{cwd:folder,windowsHide:true});
    assert.equal((await once(gui,"close"))[0],0,"Tkinter startup failed");
  }]];
let failures=0;
try{
  for(let i=0;i<100;i++){
    try{await api("/api/health");break}catch(error){if(i===99)throw error;await sleep(100)}
  }
  for(const [name,model,prompt,verify] of cases){
    if(process.env.WISK_CASES&&!process.env.WISK_CASES.includes(name))continue;
    try{
      const folder=path.join(workspaceBase,"Case "+name);
      await fs.mkdir(folder);
      const modelInfo=await (await api("/api/agent/model?name="+encodeURIComponent(model))).json();
      assert(modelInfo.tools);
      const {session}=await (await api("/api/sessions",{workspace:folder,mode:"agent",model})).json();
      const stream=await api("/api/sessions/"+session.id+"/run",{prompt});
      const decoder=new TextDecoder();
      let buffer="",done;
      for await(const bytes of stream.body){
        buffer+=decoder.decode(bytes,{stream:true});
        let end;
        while((end=buffer.indexOf("\n\n"))!==-1){
          const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
          if(!frame.startsWith("data: "))continue;
          const event=JSON.parse(frame.slice(6));
          if(event.type==="permission"){
            const allowed=event.title==="run_command";
            const command=JSON.parse(event.details).command;
            assert(!allowed||/^(?:Set-Location|cd|Push-Location|python|py|dir|Get-(?:ChildItem|Location|Command|Content)|Test-Path|cmd)/i.test(command.trim()),command);
            assert(!allowed||!/(?:https?:|Remove-Item|Invoke-Expression|Start-Process|\\\\|[A-Z]:\\)/i.test(command),command);
            await api("/api/agent/permission",{requestId:event.requestId,optionId:allowed?"allow":"reject"});
          }
          if(event.type==="tool"&&["completed","failed"].includes(event.update.status))console.log(name,event.update.title,event.update.status,event.update.input.slice(0,350),event.update.status==="failed"?event.update.output:"");
          if(event.type==="status")console.log(name,"status",event.update);
          if(event.type==="error")console.log(name,"error",event.message);
          if(event.type==="done")done=event;
        }
      }
      const saved=(await (await api("/api/sessions/"+session.id)).json()).session;
      const reply=saved.messages.at(-1);
      assert.doesNotMatch(reply.text,/<(?:turn-context|turn-budget|tool_call|think)\b/i);
      assert.equal(done?.session.status,"completed",reply.text+" "+done?.stopReason+" "+reply.error);
      await verify(folder,reply.tools);
      console.log("PASS",name,model,reply.tools.length+" observed tool events",JSON.stringify(reply.text.slice(0,800)));
    }catch(error){failures++;console.error("FAIL",name,model,error.stack)}
  }
}finally{
  if(child.connected){const exit=once(child,"exit");child.disconnect();await exit;}
  if(stderr)console.error(stderr.slice(-1500));
  if(!failures)await fs.rm(workspaceBase,{recursive:true,force:true});
  else console.error("Kept disposable evidence at "+workspaceBase);
}
process.exitCode=failures?1:0;
