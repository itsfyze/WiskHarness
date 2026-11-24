import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const [kind, older, newer] = process.argv.slice(2);
assert(process.platform === "win32" && ["portable", "setup"].includes(kind) && older && newer,
  "Usage: node tests/updater-desktop.mjs <portable|setup> <older fixture EXE or unpacked dir> <newer test package>");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "Wisk updater lifecycle "));
const profile = path.join(root, "Electron Profile");
const config = path.join(root, "Agent Data");
const workspace = path.join(root, "Test Workspace");
const setupDir = path.join(root, "Installation With Spaces");
const target = path.join(kind === "setup" ? setupDir : root, "WiskHarness.exe");
const status = path.join(profile, "update-result.txt");
const log = path.join(profile, "desktop-runtime.log");
const publicFeed=process.argv.includes("--public-feed");
const version=publicFeed?"0.7.3-beta.7":"0.7.3-beta.6";
const previousVersion=publicFeed?"0.7.3-beta.6":"0.7.3-beta.5";
assert(!publicFeed||kind==="portable","The public-feed test uses the production Portable packages.");
const filename = "WiskHarness." + (kind === "setup" ? "Setup" : "Portable") + "." + version + ".exe";
const candidate = path.resolve(newer);
const size = (await fs.stat(candidate)).size;
const digest = await sha256(candidate);
let downloads = 0;
let feed;
let launcher;
let browser;

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function startServer(handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
async function freePort() {
  const server = await startServer();
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitFor(check, label, limit = 120000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(250);
  }
  throw new Error("Timed out waiting for " + label);
}
async function run(exe, args) {
  const proc = spawn(exe, args, { windowsHide:true, stdio:"ignore" });
  const [code] = await once(proc, "exit");
  assert.equal(code, 0, exe + " exited with an unexpected code");
}
async function serve(req, res) {
  if (req.url === "/feed") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify([{
      tag_name:"v" + version, draft:false, prerelease:true, body:"Updater QA release notes.",
      assets:[{name:filename, state:"uploaded", size, digest:"sha256:" + digest,
        browser_download_url:"https://github.com/itsfyze/WiskHarness/releases/download/v" + version + "/" + filename}]
    }]));
  }
  if (req.url !== "/package") { res.statusCode = 404; return res.end(); }
  if (++downloads === 1) return res.end("deliberately incomplete update");
  const prefix = 2 * 1024 * 1024;
  res.setHeader("Content-Length", size);
  for await (const piece of createReadStream(candidate, {start:0,end:prefix-1,highWaterMark:256*1024})) {
    if (res.destroyed) return;
    res.write(piece);
    await delay(270);
  }
  await pipeline(createReadStream(candidate, {start:prefix}), res);
}
function isolatedAppPids() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name = 'WiskHarness.exe'\" | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:WISK_TEST_PROFILE) } | Select-Object -ExpandProperty ProcessId";
  return execFileSync("powershell.exe", ["-NoProfile","-Command",ps], {
    encoding:"utf8",env:{...process.env,WISK_TEST_PROFILE:profile},windowsHide:true
  }).trim().split(/\s+/).filter(Boolean).map(Number);
}

try {
  await Promise.all([profile,config,workspace].map(directory => fs.mkdir(directory)));
  await fs.writeFile(path.join(config,"settings.json"), JSON.stringify({
    workspace, setupComplete:true, updateAutomatic:false, updateChannel:"beta",
    model:"updater-fixture:latest", permissionMode:"ask"
  }));
  if (kind === "setup") {
    assert(process.argv.includes("--isolated-nsis"), "Use an NSIS test package with a disposable GUID and shortcuts disabled.");
    await run(candidate, ["/S", "/D=" + setupDir]);
    assert((await fs.stat(path.join(setupDir,"Uninstall WiskHarness.exe"))).isFile());
    for (const name of ["app.asar", "runtime/package.json", "runtime/updates.mjs"])
      await fs.copyFile(path.join(older,"resources",name), path.join(setupDir,"resources",name));
  } else {
    await fs.copyFile(older,target);
  }
  const previousHash = await sha256(target);
  feed = await startServer((req,res) => { void serve(req,res).catch(error => res.destroy(error)); });
  const debugPort = await freePort();
  const servicePort = await freePort();
  const env = {...process.env,WISK_UPDATE_TEST_FEED:"http://127.0.0.1:"+feed.address().port,
    LOCAL_AGENT_SETTINGS_DIR:config,LOCAL_AGENT_WORKSPACE:workspace,LOCAL_AGENT_DISABLE_OBSIDIAN_CHECKPOINT:"1",
    LOCAL_AGENT_PORT:String(servicePort)};
  launcher = spawn(target, ["--user-data-dir="+profile,"--remote-debugging-port="+debugPort],
    {env,windowsHide:true,stdio:"ignore"});
  const endpoint = "http://127.0.0.1:" + debugPort;
  await waitFor(async() => {
    assert.equal(launcher.exitCode,null,"Baseline app exited");
    try { return (await fetch(endpoint+"/json/version")).ok; } catch { return false; }
  },"baseline desktop debugger");
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent("page");
  await page.locator("#chat-input").waitFor();
  const imported = await page.evaluate(async() => {
    const result = await fetch("/api/sessions/import", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({pairs:[{user:"Saved updater conversation",assistant:"Saved updater answer"}]})});
    if (result.status !== 201) throw new Error(await result.text());
    return (await result.json()).session.id;
  });
  const session = path.join(config,"local-data","sessions",imported+".json");
  const conversation = await fs.readFile(session,"utf8");
  assert.match(conversation,/Saved updater conversation/);
  await page.locator('[data-view="settings"]').click();
  const card = page.locator("#update-settings");
  await card.getByText(previousVersion,{exact:true}).waitFor();
  await card.getByRole("button",{name:"Check now"}).click();
  await card.getByText(version,{exact:true}).waitFor();
  await card.getByText("Release notes",{exact:true}).click();
  if(!publicFeed)await card.getByText("Updater QA release notes.").waitFor();
  const settings = await fs.readFile(path.join(config,"settings.json"),"utf8");
  if(!publicFeed){
  await card.getByRole("button",{name:"Update",exact:true}).click();
  await card.getByText(/Update failed.*size or checksum/).waitFor();
  assert.equal(launcher.exitCode,null);
  assert.equal(await sha256(target),previousHash);
  assert.equal((await fs.readdir(path.join(config,"updates"))).length,0);
  console.log(kind + ": detected beta.6 and rejected a bad download without closing or changing the app.");

  await card.getByRole("button",{name:"Retry update"}).click();
  await card.locator('progress[value]:not([value="0"])').waitFor();
  await card.getByText(/MB remaining.*MB\/s/).waitFor();
  }else await card.getByRole("button",{name:"Update",exact:true}).click();
  await waitFor(() => launcher.exitCode !== null,"baseline shutdown");
  await waitFor(async() => {
    const outcome = await fs.readFile(status,"utf8").catch(()=>null);
    if (outcome && outcome !== "success") throw new Error(outcome);
    return outcome === "success";
  },"updated app window and version confirmation",240000);
  assert.equal(downloads,publicFeed?0:2);
  assert.equal(await fs.readFile(session,"utf8"),conversation);
  assert.equal(await fs.readFile(path.join(config,"settings.json"),"utf8"),settings);
  assert(isolatedAppPids().some(pid => pid !== launcher.pid),"The new process should be running");
  if (kind === "portable") assert.equal(await sha256(target),digest);
  assert.match(await fs.readFile(log,"utf8"),new RegExp("Installing verified "+kind+" update"));
  console.log(kind + ": observed progress, original process exit, in-place update, automatic restart to " + version + ", and unchanged settings and conversation.");
} catch (error) {
  console.error("Disposable test profile: "+root);
  console.error(await fs.readFile(log,"utf8").catch(()=>"No desktop log"));
  throw error;
} finally {
  if (browser) await browser.close().catch(()=>{});
  if (feed) { feed.closeAllConnections(); await new Promise(resolve=>feed.close(resolve)); }
  for (const pid of isolatedAppPids()) { try { process.kill(pid); } catch {} }
  if (launcher && launcher.exitCode === null) launcher.kill();
  if (kind === "setup") {
    const uninstaller = path.join(setupDir,"Uninstall WiskHarness.exe");
    if (await fs.stat(uninstaller).catch(()=>null)) await run(uninstaller,["/S"]);
  }
}
