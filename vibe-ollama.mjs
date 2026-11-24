import {randomUUID} from "node:crypto";
import {once} from "node:events";


const toolNames = name => ["wisk_" + name, "mcp_wisk." + name, "mcp_wisk_" + name, "mcp__wisk__" + name];
export function isVibeTool(name, tools) {
  return tools.some(tool => toolNames(tool.function.name).includes(name));
}

const bridgeProgram = /^async function main\(\) \{ return await tools\.mcp_wisk\.([A-Za-z0-9_]+)\(([\s\S]+)\); \}$/;

function messageForOllama(message, calls, tools) {
  const {role, content} = message;
  if (!["system", "developer", "user", "assistant", "tool"].includes(role)) throw new Error("Unsupported model message role");
  const output = {
    role: role === "developer" ? "system" : role,
    content: typeof content === "string" ? content : Array.isArray(content) ?
      content.map(part => {
        if (part.type !== "text") throw new Error("This Vibe Ollama bridge accepts text messages only");
        return part.text;
      }).join("\n") : ""
  };
  if (message.reasoning_content) output.thinking = message.reasoning_content;
  if (role === "tool") output.tool_name = calls.get(message.tool_call_id) || message.name;
  if (Array.isArray(message.tool_calls)) {
    output.tool_calls = message.tool_calls.map(({id, function: fn}) => {
      const input = JSON.parse(fn.arguments || "{}");
      const bridge = fn.name === "run_typescript" && bridgeProgram.exec(input.code);
      const known = bridge && tools.find(tool => tool.function.name === bridge[1]);
      const name = known ? bridge[1] : fn.name;
      calls.set(id, name);
      return {function: {name, arguments: known ? JSON.parse(bridge[2]) : input}};
    });
  }
  return output;
}

async function* ndjsonLines(stream) {
  let buffer = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      if (end > 512000) throw new Error("Ollama returned an oversized frame");
      yield buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
    }
    if (buffer.length > 512000) throw new Error("Ollama returned an oversized frame");
  }
  if (buffer.trim()) yield buffer;
}

export async function streamVibeOllama({body, response, endpoint, model, tools, context, outputs, options: overrides, signal, onMetrics}) {
  if (body?.model !== model || !Array.isArray(body.messages) || body.stream !== true) {
    throw new Error("Vibe requested an unsupported inference operation");
  }
  const canCall = body.tools?.some(tool => tool.type === "function" && tool.function?.name === "run_typescript");
  const offered = canCall ? tools : [];
  const messages = [];
  const calls = new Map();
  for (const message of body.messages) messages.push(messageForOllama(message, calls, tools));
  const options = {
    num_ctx: context,
    num_predict: Math.min(outputs, Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : outputs),
    temperature: overrides?.temperature ?? (Number.isFinite(body.temperature) ? body.temperature : .2),
    ...(overrides?.topP===undefined?{}:{top_p:overrides.topP}),
    ...(overrides?.topK===undefined?{}:{top_k:overrides.topK})
  };
  const upstream = await fetch(endpoint + "/api/chat", {
    method: "POST", headers: {"content-type": "application/json"}, signal, redirect: "error",
    body: JSON.stringify({model, messages, tools: offered, options, stream: true,
      ...(overrides?.reasoning?{think:overrides.reasoning==="on"?true:overrides.reasoning==="off"?false:overrides.reasoning}:{})})
  });
  if (!upstream.ok || !upstream.body) {
    const error = await upstream.json().catch(() => null);
    throw new Error("Ollama inference HTTP " + upstream.status + (error?.error ? ": " + String(error.error).slice(0, 500) : ""));
  }
  response.set({"content-type": "text/event-stream", "cache-control": "no-store"});
  const envelope = {id: "chatcmpl-" + randomUUID(), object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model};
  async function write(data) {
    if (!response.write("data: " + data + "\n\n")) await once(response, "drain", {signal});
  }
  async function frame(delta, finish = null, usage) {
    await write(JSON.stringify({...envelope, choices: usage ? [] : [{index: 0, delta, finish_reason: finish}], ...(usage ? {usage} : {})}));
  }
  await frame({role: "assistant", content: ""});
  const lines = ndjsonLines(upstream.body);
  let first = 0, last = 0, chars = 0, emittedCalls = 0, frames = 0;
  const names = new Set(offered.map(tool => tool.function.name));
  for await (const line of lines) {
    signal.throwIfAborted();
    if (!line.trim()) continue;
    if (line.length > 512000 || ++frames > 100000) throw new Error("Ollama stream exceeded its response limit");
    const event = JSON.parse(line);
    if (event.error) throw new Error(String(event.error).slice(0, 500));
    const delta = {};
    if (event.message?.content) delta.content = event.message.content;
    if (event.message?.thinking) delta.reasoning_content = event.message.thinking;
    if (event.message?.tool_calls?.length) {
      delta.tool_calls = event.message.tool_calls.filter(({function: fn}) => names.has(fn?.name)).map(({function: fn}) => ({
        index: emittedCalls++, id: "call_" + randomUUID().replaceAll("-", ""), type: "function",
        function: {name: "run_typescript", arguments: JSON.stringify({
          code: "async function main() { return await tools.mcp_wisk." + fn.name + "(" + JSON.stringify(fn.arguments || {}) + "); }"
        })}
      }));
      if (delta.tool_calls.length !== event.message.tool_calls.length) {
        throw new Error("Model requested a function outside the registered WiskHarness tool set");
      }
    }
    const produced = (delta.content?.length || 0) + (delta.reasoning_content?.length || 0);
    if (produced) {
      const now = performance.now();
      if (!first) first = now;
      chars += produced;
      const elapsed = now - first;
      if (elapsed >= 1000 && now - last >= 450) {
        onMetrics({liveTokensPerSecond: chars / 4 / (elapsed / 1000), liveEstimated: true});
        last = now;
      }
    }
    if (Object.keys(delta).length) await frame(delta);
    if (event.done) {
      const prompt = event.prompt_eval_count, completion = event.eval_count;
      const speed = completion > 0 && event.eval_duration > 0 ? completion / (event.eval_duration / 1e9) : null;
      onMetrics({prompt_eval_count: prompt, eval_count: completion, eval_duration: event.eval_duration,
        tokensPerSecond: speed, liveTokensPerSecond: null, liveEstimated: false, contextUsed: prompt + completion, contextSize: context});
      await frame({}, event.done_reason === "length" ? "length" : emittedCalls ? "tool_calls" : "stop");
      if (Number.isInteger(prompt) && Number.isInteger(completion)) {
        await frame({}, null, {prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion});
      }
      await write("[DONE]");
      response.end();
      return;
    }
  }
  throw new Error("Ollama closed the stream without final usage or stop information");
}
