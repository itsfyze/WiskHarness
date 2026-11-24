import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";

const {WISK_VIBE_BRIDGE, WISK_VIBE_TOKEN} = process.env;
if (!WISK_VIBE_BRIDGE || !WISK_VIBE_TOKEN) throw new Error("Missing WiskHarness tool bridge");
const bridge = new URL(WISK_VIBE_BRIDGE);
if (bridge.protocol !== "http:" || bridge.hostname !== "127.0.0.1" ||
    bridge.pathname !== "/_vibe/tools" || bridge.username || bridge.password) {
  throw new Error("Invalid WiskHarness tool bridge");
}
const headers = {"authorization": "Bearer " + WISK_VIBE_TOKEN, "content-type": "application/json"};
const server = new Server({name: "wiskharness", version: "1.0.0"}, {capabilities: {tools: {}}});
server.setRequestHandler(ListToolsRequestSchema, async (_request, {signal}) => {
  const reply = await fetch(bridge, {headers, signal, redirect: "error"});
  if (!reply.ok) throw new Error("WiskHarness tool discovery failed (" + reply.status + ")");
  return {tools: await reply.json()};
});
server.setRequestHandler(CallToolRequestSchema, async ({params}, {signal}) => {
  const reply = await fetch(bridge, {
    method: "POST", headers, signal, redirect: "error",
    body: JSON.stringify({name: params.name, input: params.arguments || {}})
  });
  const result = await reply.json();
  return {isError: !reply.ok || result.ok !== true, content: [{type: "text", text: JSON.stringify(result)}]};
});
process.stdin.once("end", () => process.exit(0));
await server.connect(new StdioServerTransport());
