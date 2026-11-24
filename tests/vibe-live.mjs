import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";

const [model] = process.argv.slice(2);
if (!model || !process.env.LOCAL_AGENT_VIBE_RESOURCES) throw new Error("Supply an installed model and LOCAL_AGENT_VIBE_RESOURCES.");
const root = await mkdtemp(path.join(tmpdir(), "Wisk Vibe live "));
const workspace = path.join(root, "workspace with spaces");
const profile = path.join(root, "profile");
await mkdir(workspace);
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({agentEngine: "vibe", permissionMode: "full", updateAutomatic: false}));
const listener = createServer().listen(0, "127.0.0.1");
await once(listener, "listening");
const {port} = listener.address();
await new Promise(resolve => listener.close(resolve));
const token = "wisk-vibe-test-profile";
const child = spawn(process.execPath, ["server.mjs"], {
  env: {...process.env, LOCAL_AGENT_WORKSPACE: workspace, LOCAL_AGENT_SETTINGS_DIR: profile,
    LOCAL_AGENT_PORT: String(port), LOCAL_AGENT_DISABLE_OBSIDIAN_CHECKPOINT: "1", WISKHARNESS_API_TOKEN: token},
  stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true
});
async function api(route, body) {
  const response = await fetch("http://127.0.0.1:" + port + route, {
    headers: {"content-type": "application/json", "x-wiskharness-session": token},
    method: body ? "POST" : "GET", body: JSON.stringify(body), signal: AbortSignal.timeout(360_000)
  });
  if (!response.ok) throw new Error(route + ": " + await response.text());
  return response;
}
async function turn(session, prompt) {
  const stream = await api("/api/sessions/" + session + "/run", {prompt});
  let tail = "", final;
  for await (const bytes of stream.body.pipeThrough(new TextDecoderStream())) {
    tail += bytes;
    let boundary;
    while ((boundary = tail.indexOf("\n\n")) !== -1) {
      const frame = tail.slice(0, boundary);
      tail = tail.slice(boundary + 2);
      if (!frame.startsWith("data: ")) continue;
      const event = JSON.parse(frame.slice(6));
      if (event.type === "permission") throw new Error("Unexpected Full Access prompt: " + event.title);
      if (event.type === "tool" && event.update.status !== "in_progress") console.log(event.update);
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") final = event;
    }
  }
  assert.equal(final?.session.status, "completed", JSON.stringify(final));
}
try {
  for(let attempt=0;;attempt++){
    try{await api("/api/health");break}
    catch(error){if(attempt===70)throw error;await delay(100)}
  }
  assert.equal(await fetch("http://127.0.0.1:" + port + "/_vibe/tools").then(result => result.status), 403);
  const {session} = await (await api("/api/sessions", {workspace, model, mode: "agent"})).json();
  if(process.argv.includes("--project")){
    await turn(session.id,"Build a small offline notes desktop application with Python Tkinter and the standard library. These paths are relative to the current Windows workspace. Start by listing path \".\". Then create app, tests and dist. Implement app/store.py for adding distinct nonempty notes, app/gui.py for a functioning window with a list and Add button, tests/test_store.py for the store and README.md. The GUI should honor --smoke by opening and automatically closing after 250 ms. Keep files concise. Verify using these single CMD commands one at a time: python -m py_compile app/store.py app/gui.py, python -m unittest discover -s tests -v, python -m app.gui --smoke, python -m zipfile -c dist/notes.zip app README.md, python -m zipfile -t dist/notes.zip. Use no network, installs, redirection or command chains. After checks pass, report file paths and finish.");
    for(const name of ["app/store.py","app/gui.py","tests/test_store.py","dist/notes.zip"])assert((await readFile(path.join(workspace,name))).length>0);
    for(const args of [["-m","py_compile","app/store.py","app/gui.py"],["-m","unittest","discover","-s","tests","-v"],["-m","app.gui","--smoke"],["-m","zipfile","-t","dist/notes.zip"]]){
      const check=spawn("python",args,{cwd:workspace,stdio:"inherit",windowsHide:true,signal:AbortSignal.timeout(15000)});
      assert.equal((await once(check,"exit"))[0],0,args.join(" "));
    }
    console.log("PASS packaged Vibe multi-file notes project, compilation, tests, GUI and ZIP · "+model+" · "+root);
  }else{
  await turn(session.id, "Use your registered tool to create note.txt in this workspace with the exact contents between the quotes: \"Vibe reached WiskHarness\". Do not include punctuation or quotes. Then use a real read tool to verify it.");
  assert.equal((await readFile(path.join(workspace, "note.txt"), "utf8")).trim(), "Vibe reached WiskHarness");
  const first = (await (await api("/api/sessions/" + session.id)).json()).session;
  assert(first.messages.at(-1).tools.some(item => item.title === "read_file" && item.status === "completed"));
  await turn(session.id, "Use the registered read tool to check note.txt again and report the contents.");
  const second = (await (await api("/api/sessions/" + session.id)).json()).session;
  assert(second.messages.at(-1).tools.some(item => item.title === "read_file" && item.status === "completed"));
  console.log("PASS " + model + " · create, verify, follow-up · " + root);
  }
} finally {
  if (child.connected) {
    const exited = once(child, "exit");
    child.disconnect();
    await Promise.race([exited, delay(3000, null, {ref: false}).then(() => child.kill())]);
  }
}
