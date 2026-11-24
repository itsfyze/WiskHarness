import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assessTool,permissionScope,permissionDecision,redactSecrets,securityDefaults,securitySettings } from "../security-policy.mjs";
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
