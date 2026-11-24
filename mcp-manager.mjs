import fs from "node:fs";
import path from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const mcpId = /^[a-z][a-z0-9_-]{0,24}$/;
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;
const reservedEnv = /^(?:PATH|PATHEXT|ComSpec|NODE_OPTIONS|NODE_PATH|PSModulePath|PYTHONPATH|VIBE_.*|WISK.*|LOCAL_AGENT_.*)$/i;

export function validateMcpServer(input) {
  if (!mcpId.test(input?.id || "") || typeof input.enabled !== "boolean") throw new Error("Choose a valid server name and enabled state");
  const {id, enabled} = input;
  if (input.transport === "http") {
    const url = new URL(input.url);
    if (!(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1") ||
        url.username || url.password || url.search || url.hash) {
      throw new Error("Use HTTPS or an IPv4 loopback HTTP URL without credentials or query parameters");
    }
    return {id, enabled, transport: "http", url: url.href};
  }
  if (input.transport !== "stdio" || typeof input.command !== "string" || !path.isAbsolute(input.command) ||
      !/\.exe$/i.test(input.command) || !Array.isArray(input.args) || input.args.length > 30 ||
      !input.args.every(arg => typeof arg === "string" && arg.length <= 2048 && !arg.includes("\0"))) {
    throw new Error("Use an absolute Windows executable path and separate arguments");
  }
  const command = fs.realpathSync(input.command);
  if (!/\.exe$/i.test(command) || !fs.statSync(command).isFile()) throw new Error("MCP executable is unavailable");
  return {id, enabled, transport: "stdio", command, args: input.args};
}

export function validateMcpAuth(input, transport) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Enter an object with credential values");
  const entries = Object.entries(input);
  if (entries.length > 12 || entries.some(([key,value])=>!envName.test(key) || reservedEnv.test(key) ||
      typeof value !== "string" || value.length > 1900 || !/^[\x20-\x7e]*$/.test(value))) {
    throw new Error("Invalid credential names or values");
  }
  if (transport === "http" && entries.some(([key])=>key!=="bearer")) throw new Error("Use the bearer property for HTTP authentication");
  return input;
}

export async function connectMcp(config, {workspace, auth, signal, electron=false}) {
  signal.throwIfAborted();
  const client = new Client({name:"WiskHarness",version:"0.7.3"});
  const transport = config.transport === "http"
    ? new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit:{redirect:"error",headers:auth?.bearer ? {authorization:"Bearer "+auth.bearer}:{}}
    })
    : new StdioClientTransport({command:config.command,args:config.args,cwd:workspace,stderr:"pipe",
      env:{...auth,...(electron&&config.command.toLowerCase()===process.execPath.toLowerCase()?{ELECTRON_RUN_AS_NODE:"1"}:{})}});
  if (config.transport === "stdio") transport.stderr?.resume();
  const close = () => client.close().catch(()=>{});
  const onAbort = () => void close();
  signal.addEventListener("abort", onAbort, {once:true});
  const stop = async () => {
    signal.removeEventListener("abort", onAbort);
    await close();
  };
  try {
    await client.connect(transport,{signal,timeout:10000});
    const {tools} = await client.listTools(undefined,{signal,timeout:10000});
    return {client,tools:tools.slice(0,25),stop};
  } catch(error) {
    await stop();
    throw error;
  }
}
