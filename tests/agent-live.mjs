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
await fs.writeFile(path.join(config,"settings.json"),JSON.stringify({permissionMode:"full",updateAutomatic:false}));
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
const cases=[
  ["A",process.env.WISK_BASIC_MODEL||"huihui_ai/qwen2.5-coder-abliterate:14b",
    "Create marker.txt containing exactly this sentence, with no extra text: The fixture ran through a real tool. Read the file back to verify it.",
    async folder=>assert.equal(await fs.readFile(path.join(folder,"marker.txt"),"utf8"),"The fixture ran through a real tool.")],
  ["B",process.env.WISK_CALCULATOR_MODEL||"qwen3.5:9b-16k",
    "Create a new Python calculator under a subfolder named Calculator Project. Implement calculate(a, operator, b) for +, -, *, and / in calculator.py and create test_calculator.py with unittest coverage. Run python -m unittest in that directory and report the result. Only use the disposable workspace.",
    async(folder,tools)=>{
      for(const name of ["calculator.py","test_calculator.py"])assert((await fs.stat(path.join(folder,"Calculator Project",name))).size>0);
      assert(tools.some(tool=>tool.status==="completed"&&tool.title==="run_command"&&/unittest/i.test(tool.input)&&/Ran \d+ test/.test(tool.output)));
      const verify=spawn("python",["-c","from calculator import calculate; assert [calculate(8,op,2) for op in '+-*/']==[10,6,16,4]; print('Arithmetic verified')"],
        {cwd:path.join(folder,"Calculator Project"),windowsHide:true,stdio:["ignore","ignore","pipe"]});
      let output="";verify.stderr.on("data",part=>output+=part);
      assert.equal((await once(verify,"close"))[0],0,output);
    }],
  ["D",process.env.WISK_MULTISTEP_MODEL||"mimo-v2.6:9b-16k",
    "Build a small project in this empty workspace. Inspect the installed Python version and check for an existing dependency file without installing anything. Create converter.py with celsius_to_fahrenheit(c) and test_converter.py using unittest. Compile both files with python -m py_compile and run python -m unittest. Verify the actual outputs before finishing.",
    async(folder,tools)=>{
      for(const name of ["converter.py","test_converter.py"])assert((await fs.stat(path.join(folder,name))).size>0);
      for(const pattern of [/python.+(?:--version|version_info)/i,/py_compile/i,/unittest/i]){
        assert(tools.some(tool=>tool.status==="completed"&&tool.title==="run_command"&&pattern.test(tool.input)),String(pattern));
      }
    }]
];
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
