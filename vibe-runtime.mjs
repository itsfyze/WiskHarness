import {createHash, randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {spawn} from "node:child_process";
import {Readable, Writable} from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {stopTree} from "./terminal.mjs";

export const vibeVersion = "3.1.5";
export const vibeExecutable = path.join("vibe", "vibe-acp.exe");
const archiveName = "vibe-acp-windows-x86_64-3.1.5.zip";
const archiveDigest = "da5a3804fc8c728fda620ea3c9f363324f844a3d9234551699db1081dd4ce7e1";
const executableDigest = "74bf0c61ec130141e601350ceaf23fa141c78170bb158ede989652177c03b5d4";
const exec = promisify(execFile);
export const vibeToolsName = "wisk";

export async function vibeStatus(resources) {
  if (!resources) return {installed: false, version: vibeVersion};
  const file = path.join(resources, vibeExecutable);
  const stat = await fs.stat(file).catch(() => null);
  if(stat?.isFile())return {installed:true,version:vibeVersion,file};
  const archive=path.join(resources,archiveName);
  const packed=await fs.lstat(archive).catch(()=>null);
  return {installed:packed?.isFile()===true&&packed.size===96175192,version:vibeVersion,archive};
}

async function digest(file,signal){
  const hash=createHash("sha256");
  for await(const chunk of createReadStream(file,{signal}))hash.update(chunk);
  return hash.digest("hex");
}

export async function prepareVibe(runtime,root,signal){
  signal.throwIfAborted();
  if(runtime.file)return runtime.file;
  if(!runtime.installed||!runtime.archive)throw new Error("The bundled Vibe archive is unavailable");
  await fs.mkdir(root,{recursive:true});
  const canonical=await fs.realpath(root);
  if(path.relative(root,canonical))throw new Error("Vibe runtime storage is linked outside its configured location");
  const target=path.join(canonical,"vibe-"+vibeVersion);
  const file=path.join(target,"vibe-acp.exe");
  const existing=await fs.lstat(target).catch(()=>null);
  if(existing){
    if(!existing.isDirectory()||existing.isSymbolicLink()||path.relative(target,await fs.realpath(target))||
      await digest(file,signal)!==executableDigest)throw new Error("The installed Vibe runtime failed verification. Choose Ollama native tools and repair the runtime folder.");
    return file;
  }
  if(await digest(runtime.archive,signal)!==archiveDigest)throw new Error("The bundled Vibe archive failed SHA-256 verification");
  const staging=await fs.mkdtemp(path.join(canonical,"vibe-staging-"));
  try{
    const tar=path.join(process.env.WINDIR||"C:/Windows","System32","tar.exe");
    await exec(tar,["-xf",runtime.archive,"-C",staging],{signal,timeout:45000,windowsHide:true,maxBuffer:65536});
    const executable=path.join(staging,"vibe-acp.exe");
    if(await digest(executable,signal)!==executableDigest)throw new Error("The extracted Vibe executable failed SHA-256 verification");
    await fs.rename(staging,target);
    return file;
  }finally{
    if(path.dirname(staging)===canonical&&path.basename(staging).startsWith("vibe-staging-")){
      await fs.rm(staging,{recursive:true,force:true}).catch(()=>{});
    }
  }
}

export function vibeConfig({model, endpoint, context, outputs, temperature}) {
  const quote = value => JSON.stringify(value);
  return [
    'active_model = "wisk-ollama"',
    'default_agent = "ask"',
    'enable_telemetry = false',
    'default_approval_policy = "ask"',
    'enable_model_catalog = false',
    'enable_connectors = false',
    'experimental_enable_mistral_mcp_connector = false',
    'enable_mcp = true',
    'outside_workdir = "deny"',
    'enabled_tools = ["wisk_*"]',
    'auto_compact_threshold = ' + Math.floor(context * .82),
    '[[providers]]',
    'name = "wisk-ollama"',
    'api_base = ' + quote(endpoint + "/v1"),
    'api_style = "openai"',
    'api_key_env_var = "WISK_VIBE_TOKEN"',
    'backend = "generic"',
    '[[models]]',
    'name = ' + quote(model),
    'provider = "wisk-ollama"',
    'alias = "wisk-ollama"',
    'max_context_length = ' + context,
    'max_output_tokens = ' + outputs,
    'temperature = ' + temperature,
    ''
  ].join("\n");
}

export function vibeSessionKey(workspace, configuration, toolsKey) {
  return createHash("sha256").update(JSON.stringify([workspace, configuration, toolsKey])).digest("hex");
}

export async function launchVibe({
  file, home, configuration, workspace, environment, mcpServers, savedSession,
  signal, onUpdate, onDiagnostic, approveTool
}) {
  signal.throwIfAborted();
  await fs.mkdir(home, {recursive: true});
  const temp = path.join(home, "config-" + randomUUID() + ".tmp");
  try {
    await fs.writeFile(temp, configuration, {flag: "wx"});
    await fs.rename(temp, path.join(home, "config.toml"));
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
  signal.throwIfAborted();
  // Start outside the workspace so dotenv and project startup configuration cannot execute before ACP initialization.
  const proc = spawn(file, [], {
    cwd: home, env: {...environment, VIBE_HOME: home, DO_NOT_TRACK: "1", PYTHONUTF8: "1"},
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true
  });
  let diagnostic = "";
  let sessionId;
  let ready = false;
  let closed = false;
  let finishExit;
  const exit = new Promise(resolve => {finishExit = resolve;});
  const toolNames = new Map();
  proc.stderr.on("data", data => { diagnostic = (diagnostic + String(data)).slice(-3500); });
  proc.on("error", error => { diagnostic = error.message; finishExit(error.message); });
  const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
  const connection = acp.client({name: "WiskHarness"})
    .onNotification(acp.methods.client.session.update, ({params}) => {
      if (!ready || params.sessionId !== sessionId) return;
      const {toolCallId, _meta, status} = params.update;
      if (toolCallId && typeof _meta?.tool_name === "string") toolNames.set(toolCallId, _meta.tool_name);
      if (["completed","failed"].includes(status)) toolNames.delete(toolCallId);
      onUpdate(params.update);
    })
    .onRequest(acp.methods.client.session.requestPermission, ({params}) => {
      const tool = toolNames.get(params.toolCall?.toolCallId);
      const option = params.options?.find(item => item.kind === "allow_once");
      if (ready && params.sessionId === sessionId && !signal.aborted && option && approveTool?.(tool)) {
        return {outcome: {outcome: "selected", optionId: option.optionId}};
      }
      return {outcome: {outcome: "cancelled"}};
    })
    .connect(stream);

  const stop = async () => {
    if (closed) return;
    closed = true;
    connection.close();
    finishExit("connection closed");
    if (proc.pid && proc.exitCode === null) await stopTree(proc);
  };
  const cancel = () => {
    if (sessionId && ready) {
      void connection.agent.notify(acp.methods.agent.session.cancel, {sessionId}).catch(() => {});
      const timer = setTimeout(() => void stop(), 1800);
      proc.once("exit", () => clearTimeout(timer));
    } else {
      void stop();
    }
  };
  signal.addEventListener("abort", cancel, {once: true});
  proc.once("exit", (code) => {
    finishExit("process exited (" + code + ")" + (diagnostic ? " · " + diagnostic.slice(-550) : ""));
    signal.removeEventListener("abort", cancel);
    if (diagnostic) onDiagnostic?.(diagnostic);
  });
  function request(method, params) {
    return Promise.race([connection.agent.request(method, params), exit.then(reason => {throw new Error("Vibe " + reason);})]);
  }
  try {
    if (signal.aborted) cancel();
    const startTimeout = setTimeout(() => void stop(), 25_000);
    let restored = false;
    try {
      const info = await request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        clientInfo: {name: "WiskHarness", version: "0.7.3"}
      });
      if (savedSession && info.agentCapabilities?.loadSession) {
        try {
          await request(acp.methods.agent.session.load, {cwd: workspace, sessionId: savedSession, mcpServers});
          sessionId = savedSession;
          restored = true;
        } catch (error) {
          signal.throwIfAborted();
          onDiagnostic?.("Vibe session restoration failed: " + error.message);
        }
      }
      if (!sessionId) {
        const result = await request(acp.methods.agent.session.new, {cwd: workspace, mcpServers});
        sessionId = result.sessionId;
      }
      signal.throwIfAborted();
      ready = true;
    } finally {
      clearTimeout(startTimeout);
    }
    return {
      sessionId, restored,
      prompt: text => request(acp.methods.agent.session.prompt, {
        sessionId, prompt: [{type: "text", text}]
      }),
      stop: async () => {
        signal.removeEventListener("abort", cancel);
        await stop();
      }
    };
  } catch (error) {
    await stop();
    throw new Error("Vibe ACP startup failed: " + error.message + (diagnostic ? " · " + diagnostic.slice(-550) : ""), {cause: error});
  }
}
