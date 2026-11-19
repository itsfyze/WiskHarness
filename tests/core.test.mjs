import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createUpdater, selectRelease } from "../updates.mjs";
import { snapshotWorkspace, compareWorkspace, revertChange } from "../workspace-review.mjs";
import { checkpointObsidian } from "../obsidian-checkpoint.mjs";

const fixture = Buffer.from("verified fixture bytes");
const digest = createHash("sha256").update(fixture).digest("hex");
function release(version, options = {}) {
  const name = "WiskHarness Setup "+version+".exe";
  return { tag_name:"v"+version, draft:false, prerelease:version.includes("-"), assets:[{
    name,state:"uploaded",size:fixture.length,digest:"sha256:"+digest,
    browser_download_url:"https://github.com/itsfyze/WiskHarness/releases/download/v"+version+"/"+encodeURIComponent(name)
  }], ...options };
}
const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"wisk-test-"));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
};
test("release selection handles stable, beta, numeric versions, drafts and untrusted assets", () => {
  const data = [release("0.7.1"),release("0.7.10"),release("0.8.0-beta.1"),release("2.0.0",{draft:true})];
  assert.equal(selectRelease(data,"stable").version,"0.7.10");
  assert.equal(selectRelease(data,"beta").version,"0.8.0-beta.1");
  const wrong=release("0.7.11");wrong.assets[0].browser_download_url="https://example.org/file.exe";
  assert.equal(selectRelease([wrong],"stable").asset,null);
  assert.equal(selectRelease([release("0.7.11",{assets:[]})],"stable").asset,null);
});
test("update checker handles current version, offline, malformed JSON and rate limits", async t => {
  const directory=tmp(t);
  for(const [fetcher,expected] of [
    [async()=>Response.json([release("0.7.0")]),undefined],
    [async()=>{throw new Error("offline")},/offline/],
    [async()=>Response.json({broken:true}),/Invalid release response/],
    [async()=>new Response(null,{status:403}),/rate limit/],
  ]){
    const updater=createUpdater({version:"0.7.0",directory,kind:"setup",fetcher});
    const result=await updater.check("stable");
    assert.equal(result.available,false);
    if(expected)assert.match(result.error,expected);
    else assert.equal(result.error,null);
  }
});
test("verified updates require exact bytes and clean up bad or interrupted downloads", async t => {
  const directory=tmp(t);
  for(const [response,expect] of [
    [()=>new Response(fixture),"verified"],
    [()=>new Response(Buffer.alloc(fixture.length)),"error"],
    [()=>new Response(fixture.subarray(0,-1)),"error"],
    [()=>new Response(null,{status:302,headers:{location:"https://example.org/payload"}}),"error"],
    [()=>new Response(new ReadableStream({start(controller){controller.error(new Error("interrupted"))}})),"error"]
  ]){
    const target=fs.mkdtempSync(path.join(directory,"assets-"));
    const updater=createUpdater({version:"0.7.0",directory:target,kind:"setup",
      fetcher:async url=>url.includes("api.github.com")?Response.json([release("0.7.1")]):response()});
    const result=await updater.check("stable");
    assert.equal(result.available,true);
    const {download}=await updater.download();
    assert.equal(download.state,expect);
    if(expect==="verified")assert.deepEqual(fs.readFileSync(download.path),fixture);
    else assert.deepEqual(fs.readdirSync(target),[]);
  }
});
test("workspace review captures before/after and refuses rollback over later changes", t => {
  const directory=tmp(t),file=path.join(directory,"demo.js");
  fs.writeFileSync(file,"console.log(1);\n");
  const before=snapshotWorkspace(directory);
  fs.writeFileSync(file,"console.log(2);\n");
  fs.writeFileSync(path.join(directory,"added.ts"),"export const x = 1;\n");
  const review=compareWorkspace(before,snapshotWorkspace(directory));
  assert.equal(review.changes.length,2);
  const change=review.changes.find(row=>row.name==="demo.js");
  assert.equal(change.before.text,"console.log(1);\n");
  assert.equal(change.after.text,"console.log(2);\n");
  fs.writeFileSync(file,"console.log(3);\n");
  assert.throws(()=>revertChange(directory,review,change),/changed after/);
  fs.writeFileSync(file,"console.log(2);\n");
  revertChange(directory,review,change);
  assert.equal(fs.readFileSync(file,"utf8"),"console.log(1);\n");
  assert.equal(change.disposition,"reverted");
});
test("Obsidian updates managed current fields and keeps historical notes on retry", t => {
  const vault=tmp(t),workspace=path.join(vault,"demo");
  const now=path.join(vault,"Now.md"),project=path.join(vault,"Projects","demo.md");
  fs.mkdirSync(path.dirname(project),{recursive:true});
  fs.writeFileSync(now,"# Current work\n\nOther project notes\n");
  fs.writeFileSync(project,"---\ntags: demo\n---\n\n# demo\n\n## Prior history\nNothing removed.\n");
  const options={vault,workspace,version:"0.7.0",sessionId:"demo",messageId:"first",prompt:"Fix the fixture",
    modified:["demo.js"],tools:[{title:"Edit demo.js",status:"completed"}]};
  const result=checkpointObsidian(options);
  assert.equal(result.saved,true);
  const before=fs.readFileSync(project,"utf8");
  assert.match(before,/^---\ntags: demo\n---\n\n# demo\n\n<!-- wiskharness-status:project -->/);
  assert.match(before,/Runtime version:\*\* 0.7.0/);
  assert.match(before,/## Prior history\nNothing removed\./);
  assert.match(fs.readFileSync(now,"utf8"),/Other project notes/);
  checkpointObsidian(options);
  assert.equal(fs.readFileSync(project,"utf8"),before);
});
