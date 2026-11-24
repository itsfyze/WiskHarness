import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assessTool,classifyShellCommand,shellAssessmentForCall,ordinaryDevelopmentCommand,permissionScope,permissionDecision,redactSecrets,securityDefaults,securitySettings } from "../security-policy.mjs";
import { credentialStore,parseModelRef,providerClient,providerConfig } from "../providers.mjs";
import { workspaceGit } from "../git-workspace.mjs";

function temporary(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"wisk-beta-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}

test("policy checks deny explicit external, linked and credential paths before approval", t=>{
  const root=temporary(t);
  const work=path.join(root,"work"),outside=path.join(root,"outside");
  fs.mkdirSync(work);fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(work,"linked"),"junction");
  const evaluate=(kind,input,policy=securityDefaults)=>assessTool({call:{kind,rawInput:input},workspace:work,policy});
  assert.equal(evaluate("edit",{path:"linked/new.txt"}).denied,true);
  assert.equal(evaluate("edit",{path:"../outside/new.txt"}).denied,true);
  assert.equal(evaluate("read",{path:".aws/credentials"}).denied,true);
  assert.equal(evaluate("read",{path:".env.local"}).denied,true);
  assert.equal(evaluate("read",{path:"readme.md"}).denied,false);
  assert.equal(evaluate("read",{path:"readme.md"}).readScope,path.join(work,"readme.md"));
  assert.equal(evaluate("execute",{command:"Write-Output test"},{...securityDefaults,toolPolicies:{execute:"deny"}}).denied,true);
  const gooseWrite=assessTool({call:{title:"write · proof.txt",rawInput:{path:"proof.txt",content:"fixture"}},workspace:work,
    policy:{...securityDefaults,toolPolicies:{write:"deny"}}});
  assert.equal(gooseWrite.category,"write");
  assert.equal(gooseWrite.denied,true);
  assert.throws(()=>securitySettings({...securityDefaults,workspaceOnly:false},securityDefaults),/Confirm/);
  assert.throws(()=>securitySettings({...securityDefaults,toolPolicies:{...securityDefaults.toolPolicies,execute:"allow"}},securityDefaults),/Invalid policy/);
  assert.deepEqual(securitySettings({reset:true},{}),securityDefaults);
});

test("recognizable test values are redacted", ()=>{
  const fake="sk-"+"fake".repeat(9);
  const text="Token "+fake+"\npassword = 'disposable value'\nBearer fixture-only\n"+
    "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nplaceholder\n-----END OPENSSH PRIVATE KEY-----";
  const output=redactSecrets(text);
  for(const privateValue of [fake,"disposable value","fixture-only","placeholder"])assert(!output.includes(privateValue));
  assert.equal(redactSecrets("function hello() { return 42; }"),"function hello() { return 42; }");
});

test("Windows DPAPI round trip, replacement and deletion use encrypted bytes", {skip:process.platform!=="win32"}, t=>{
  const root=temporary(t),store=credentialStore(root);
  const key="fixture-"+"disposable".repeat(6);
  store.set("openai",key);
  assert.equal(store.has("openai"),true);
  assert(!fs.readFileSync(path.join(root,"openai.dpapi")).includes(Buffer.from(key)));
  assert.equal(store.get("openai"),key);
  store.set("openai",key+"-new");
  assert.equal(store.get("openai"),key+"-new");
  store.remove("openai");
  assert.equal(store.has("openai"),false);
  assert.throws(()=>store.get("openai"),/ENOENT/);
});

test("official and local Plan provider adapters discover and stream without tool or file payloads (mock)", async()=>{
  const configured={};
  assert.throws(()=>providerConfig("compatible",{enabled:true,base:"http://192.168.0.1:1234/v1"}),/loopback/);
  assert.throws(()=>providerConfig("lmstudio",{enabled:true,base:"http://user:secret@127.0.0.1:1234/v1"}),/loopback/);
  for(const id of ["lmstudio","compatible","openai","anthropic","gemini","openrouter"]){
    configured[id]=providerConfig(id,{enabled:true,model:"fixture/model",base:"http://127.0.0.1:5678/v1"});
    const selection=parseModelRef("@provider/"+id+"/fixture/model");
    const fakeKey="fixture-only-"+"x".repeat(16);
    const requests=[];
    const api=providerClient({credentials:{has:()=>!!selection.provider.cloud,get:()=>fakeKey},config:()=>configured,
      fetcher:async(url,options)=>{
        requests.push({url,options});
        assert.equal(options.redirect,"error");
        if(url.endsWith("/models"))return Response.json({data:[{id:"fixture/model"}]});
        const body=JSON.parse(options.body);
        assert.equal(body.stream,true);
        assert.equal(body.model,"fixture/model");
        assert(!JSON.stringify(body).includes("private-file-snapshot"));
        assert.equal(body.tools,undefined);
        const events=id==="anthropic"?[
          {type:"message_start",message:{usage:{input_tokens:6}}},
          {type:"content_block_delta",delta:{type:"text_delta",text:"TEST"}},
          {type:"message_delta",usage:{output_tokens:1}},{type:"message_stop"}
        ]:[{choices:[{delta:{content:"TEST"}}]},{choices:[{finish_reason:"stop"}],usage:{prompt_tokens:6,completion_tokens:1}}];
        return new Response(events.map(event=>"data: "+JSON.stringify(event)+"\n\n").join(""),{headers:{"Content-Type":"text/event-stream"}});
      }});
    const check=await api.discover(id);
    assert.equal(check.connected,true);
    assert.deepEqual(check.models,["fixture/model"]);
    let text="",usage;
    await api.stream({selection,messages:[{role:"user",text:"Check",tools:[{output:"private-file-snapshot"}]}],
      onText:part=>text+=part,onMetrics:stats=>usage=stats});
    assert.equal(text,"TEST");
    assert.deepEqual(usage,{prompt_eval_count:6,eval_count:1});
    if(selection.provider.cloud)assert(requests.every(request=>request.url.startsWith(selection.provider.base)));
    if(id==="anthropic")assert.equal(requests[1].options.headers["x-api-key"],fakeKey);
    if(id==="openai")assert.equal(requests[1].options.headers.authorization,"Bearer "+fakeKey);
    api.invalidate(id);
    assert.equal(api.list().find(item=>item.id===id).connected,false);
  }
});

const gitAvailable=(()=>{try{return /^git version/.test(execFileSync("git",["--version"],{encoding:"utf8"}))}catch{return false}})();
test("Git review safely stages, unstages and commits an explicitly reviewed fixture", {skip:!gitAvailable},async t=>{
  const root=temporary(t);
  const git=(...args)=>execFileSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true});
  git("init","-q");
  git("config","user.name","WiskHarness fixture");
  git("config","user.email","fixture@example.invalid");
  fs.writeFileSync(path.join(root,"tracked.txt"),"before\n");
  git("add","tracked.txt");git("commit","-qm","Baseline");
  fs.writeFileSync(path.join(root,"tracked.txt"),"after\n");
  fs.writeFileSync(path.join(root,"other.txt"),"pre-existing staged change\n");
  git("add","other.txt");
  fs.writeFileSync(path.join(root,".env"),"TEST_PASSWORD=fixture-only\n");
  const call=(action,body)=>workspaceGit("git",root,action,body);
  const status=await call("status");
  assert(status.repository&&status.branch&&status.files.some(item=>item.name==="tracked.txt"));
  assert(!status.files.some(item=>item.name===".env"));
  assert.match((await call("diff",{name:"tracked.txt"})).patch,/\+after/);
  await assert.rejects(call("stage",{name:".env",confirmed:true}),/eligible/);
  await call("stage",{name:"tracked.txt",confirmed:true});
  let review=await call("commit-preview");
  assert.deepEqual(review.names,["other.txt","tracked.txt"]);
  await call("unstage",{name:"tracked.txt",confirmed:true});
  await assert.rejects(call("commit",{fingerprint:review.fingerprint,confirmed:true,message:"Stale"}),/Review/);
  review=await call("commit-preview");
  const result=await call("commit",{fingerprint:review.fingerprint,confirmed:true,message:"Verified fixture"});
  assert.equal(git("rev-parse","--short","HEAD").trim(),result.commit);
  assert.equal(fs.readFileSync(path.join(root,"tracked.txt"),"utf8"),"after\n");
  assert.match(git("status","--porcelain"),/ M tracked.txt/);
});


test("Full access automatically approves Goose shell and opaque tools while retaining explicit denials", t=>{
  const work=temporary(t);
  const shellCall={title:"shell",kind:"execute",rawInput:{command:"Write-Output FULL_ACCESS_TEST"}};
  const policy={...securityDefaults,permissionMode:"full",permissionRules:[]};
  const decision=assessTool({call:shellCall,workspace:work,policy});
  const scope=permissionScope(shellCall,decision,work);
  assert.equal(decision.category,"execute");
  assert.equal(decision.denied,false);
  assert.equal(scope.shell,true);
  assert.equal(permissionDecision(decision,scope,policy),"allow");
  assert.equal(permissionDecision(decision,scope,{...policy,permissionMode:"ask"}),"ask");
  assert.equal(permissionDecision(decision,scope,{...policy,permissionMode:"auto"}),"ask");
  assert.equal(permissionDecision(decision,scope,{...policy,permissionRules:[{
    workspace:scope.workspace,fingerprint:scope.fingerprint,effect:"deny"
  }]}),"deny");
  const unknown={title:"developer operation",kind:"other",rawInput:{value:"sample"}};
  const unstructured=assessTool({call:unknown,workspace:work,policy});
  assert.equal(permissionScope(unknown,unstructured,work),null);
  assert.equal(permissionDecision(unstructured,null,policy),"allow");
  const protectedCall={title:"view",kind:"read",rawInput:{command:"view",path:".env"}};
  const protectedDecision=assessTool({call:protectedCall,workspace:work,policy});
  assert.equal(protectedDecision.denied,true);
  assert.equal(permissionDecision(protectedDecision,null,policy),"deny");
  const restricted=assessTool({call:shellCall,workspace:work,policy:{
    ...policy,toolPolicies:{...policy.toolPolicies,execute:"deny"}
  }});
  assert.equal(permissionDecision(restricted,scope,policy),"deny");
});

test("Full Access recognizes routine development commands without approving shell composition or installs", t=>{
  const root=temporary(t);
  const check=command=>ordinaryDevelopmentCommand({command},root);
  for(const command of ["Get-Command cmake", "Get-Content app/main.py", "where.exe python",
    "python -m py_compile app/main.py","python -m unittest discover -s tests -v",
    "python -m zipfile -c dist/release.zip app README.md","cmake --build build","npm run build","git status","dir"])assert(check(command),command);
  for(const command of ["npm install","cmake -P local.cmake","python -c code","node --eval expression",
    "Get-Content ../outside.txt","Get-Content .env","git push","dir & del *","tar --checkpoint-action=exec",
    "Start-Process powershell","del project.txt","Get-Content C:/outside.txt"])assert(!check(command),command);
});

test("Full Access classifier allows routine work and escalates protected operations with a reason", t=>{
  const root=temporary(t);
  fs.writeFileSync(path.join(root,"app.py"),"print('fixture')\n");
  fs.writeFileSync(path.join(root,"localmod.py"),"VALUE = 1\n");
  const policy={...securityDefaults,permissionMode:"full",permissionRules:[]};
  const decide=(command,{shell="powershell",mode="full"}={})=>{
    const call={title:"run_command",kind:"execute",rawInput:{shell,command}};
    const active={...policy,permissionMode:mode};
    const decision=assessTool({call,workspace:root,policy:active});
    const classified=classifyShellCommand({command,shell,workspace:root});
    const scope=permissionScope(call,decision,root);
    return {classified,outcome:permissionDecision(decision,scope,active,{shell:classified})};
  };
  for(const command of ["Get-ChildItem .","Write-Output READY","python -m py_compile app.py",
    "python -m unittest discover -s tests -v","python -m localmod","npm run build","cmake --build build",
    "git status","dir; Get-ChildItem .",".\\gradlew.bat build","tar -xf fixture.zip -C build","deno run script.js"]){
    const result=decide(command);
    assert.equal(result.classified.risk,"routine",command);
    assert.equal(result.outcome,"allow",command);
    assert.match(result.classified.reason,/Recognized development/);
  }
  for(const command of ["npm install","npm audit fix","npm audit --fix","pnpm audit fix","yarn audit fix",
    "python -m pip install requests","python -m pip --user install requests",
    "python -m ensurepip","git push","git config --global user.name Fixture","Start-Process notepad",
    "perl -e print(1)","node --eval 1","node --loader=data:text/javascript,console.log(1) app.js",
    "cmake -P script.cmake","frobnicate --help","echo %PATH%",
    'Get-Content "x$env:VAR/../outside.txt"']){
    assert.notEqual(decide(command).classified.risk,"routine",command);
    assert.equal(decide(command).outcome,"ask",command);
  }
  for(const command of ["Get-ChildItem HKLM:\\SOFTWARE","Get-Content Cert:\\CurrentUser\\My"]){
    const result=decide(command);
    assert.equal(result.classified.risk,"system",command);
    assert.equal(result.outcome,"ask",command);
  }
  assert.equal(decide("Get-Content Env:PATH").outcome,"deny");
  for(const command of ["del app.py","Remove-Item -LiteralPath app.py -Force"]){
    const result=decide(command);
    assert.equal(result.classified.risk,"destructive",command);
    assert.equal(result.outcome,"ask",command);
    assert.match(result.classified.reason,/Destructive/);
  }
  for(const command of ["Get-Content ../outside.txt","Get-Content .env"]){
    const result=decide(command);
    assert.equal(result.outcome,"deny",command);
    assert.match(result.classified.reason,/outside the workspace|credential/i);
  }
  const mixed=decide("dir; del app.py");
  assert.equal(mixed.classified.splitRequired,true);
  assert.equal(mixed.outcome,"deny");
  assert.match(mixed.classified.reason,/Run the routine steps separately/);
  assert.equal(decide("Get-ChildItem .",{mode:"ask"}).outcome,"ask");
  const nested=assessTool({call:{title:"mcp_server_tool",kind:"other",
    rawInput:{server:"fixture",arguments:{path:"../outside.txt"}}},workspace:root,policy});
  assert.equal(nested.denied,true);
  assert.deepEqual(nested.outside,["../outside.txt"]);
  const nestedAllowed=assessTool({call:{title:"mcp_server_tool",kind:"other",
    rawInput:{server:"fixture",arguments:{path:"app.py"}}},workspace:root,policy});
  assert.equal(nestedAllowed.denied,false);
  assert.equal(permissionDecision(nestedAllowed,null,policy),"allow");
  assert.equal(classifyShellCommand({command:"",workspace:root}).risk,"unknown");
  const withoutKind=shellAssessmentForCall({call:{title:"custom tool",
    rawInput:{command:"Remove-Item -LiteralPath app.py -Force"}},workspace:root});
  assert.equal(withoutKind.risk,"destructive");
  assert.equal(shellAssessmentForCall({call:{title:"text_editor",rawInput:{command:"view",path:"app.py"}},workspace:root}),null);
  assert.equal(shellAssessmentForCall({call:{title:"run_command",kind:"execute",rawInput:{}},workspace:root}).risk,"unknown");
});
