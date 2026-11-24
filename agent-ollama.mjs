import {Readable} from "node:stream";
import {createInterface} from "node:readline";
import {redactSecrets} from "./security-policy.mjs";

export const defaultBudget = {rounds:32, calls:80, minutes:15};
export function validateBudget(input = {}) {
  const limits = {rounds:[2,100], calls:[1,240], minutes:[1,60]};
  return Object.fromEntries(Object.entries(limits).map(([key,[min,max]]) => {
    const value = input[key] ?? defaultBudget[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(key + " must be between " + min + " and " + max);
    return [key,value];
  }));
}

export function cleanAgentText(value) {
  return redactSecrets(String(value))
    .replace(/<(turn-context|current-time|working-directory|turn-budget|think|tool_call|tool_result|tool_response|function_call)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,"")
    .replace(/<\/?(?:turn-context|current-time|working-directory|turn-budget|think|tool_call|tool_result|tool_response|function_call)\b[^>]*(?:>|$)/gi,"")
    .replace(/<\|(?:im_start|im_end|eot_id|start_header_id|end_header_id|python_tag)\|>/gi,"")
    .trim();
}

export function modelCapabilities(info) {
  const caps = new Set(info?.capabilities || []);
  const trainedContext = Object.entries(info?.model_info || {}).find(([key,value]) => key.endsWith(".context_length") && Number.isInteger(value))?.[1];
  const modelContext = Number(String(info?.parameters || "").match(/^num_ctx\s+(\d+)/m)?.[1]) || undefined;
  return {tools:caps.has("tools"), completion:caps.has("completion"), thinking:caps.has("thinking"), trainedContext, modelContext};
}

export async function ollamaRound({endpoint, model, messages, tools, format, context, signal, onMetrics}) {
  const response = await fetch(endpoint + "/api/chat", {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({model, messages, tools, format, stream:true, options:{num_ctx:context, num_predict:8192}}), signal
  });
  if (!response.ok || !response.body) {
    const error = await response.json().catch(() => ({}));
    throw new Error("Ollama chat HTTP " + response.status + (error.error ? ": " + cleanAgentText(error.error).slice(0,350) : ""));
  }
  const lines = createInterface({input:Readable.fromWeb(response.body), crlfDelay:Infinity});
  const calls = new Map();
  let content = "", thinking = "", frames = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (line.length > 512_000 || ++frames > 100_000) throw new Error("Ollama stream exceeded its response limit");
    const event = JSON.parse(line);
    if (event.error) throw new Error(cleanAgentText(event.error));
    const part = event.message || {};
    content += typeof part.content === "string" ? part.content : "";
    thinking += typeof part.thinking === "string" ? part.thinking : "";
    if (content.length + thinking.length > 160_000) throw new Error("Ollama response exceeded its text limit");
    for (const [position,call] of (part.tool_calls || []).entries()) {
      const fn = call?.function;
      if (!fn || typeof fn !== "object") throw new Error("Invalid Ollama tool call");
      const index = fn.index ?? call.index ?? call.id ?? (calls.size + ":" + position);
      const current = calls.get(index) || {name:"", args:"", object:null};
      if (typeof fn.name === "string" && current.name !== fn.name) current.name += fn.name;
      if (typeof fn.arguments === "string") current.args += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === "object") current.object = {...current.object,...fn.arguments};
      calls.set(index,current);
      if (calls.size > 24 || current.args.length > 96_000) throw new Error("Ollama tool response exceeded its limit");
    }
    if (event.done !== true) continue;
    if (event.done_reason === "length") throw new Error("Ollama reached its output limit before completing the response");
    const stats = Object.fromEntries(["eval_count","eval_duration","prompt_eval_count","prompt_eval_duration","total_duration","load_duration"]
      .filter(key=>Number.isFinite(event[key]) && event[key]>=0).map(key=>[key,event[key]]));
    if (stats.eval_duration > 0 && Number.isFinite(stats.eval_count)) stats.tokensPerSecond = stats.eval_count * 1e9 / stats.eval_duration;
    onMetrics(stats);
    return {content:cleanAgentText(content), structured:format?content:undefined, thinking, calls:[...calls.values()].map(({name,args,object}) => {
      let input = object ?? {}, invalid = false;
      if (args) try { input = JSON.parse(args); } catch { invalid = true; }
      return {name, input, invalid};
    })};
  }
  throw new Error("Ollama closed the Agent stream before the completion frame");
}

const completion = {
  type:"function", function:{name:"finish_task", description:"End the turn with the result. Use incomplete if work, permissions or verification remain outstanding. For a text-only question, report the answer with status answered.",
    parameters:{type:"object", additionalProperties:false, required:["status","summary"], properties:{
      status:{type:"string",enum:["completed","incomplete","answered"]}, summary:{type:"string",minLength:1,maxLength:12000}
    }}
  }
};

export async function runOllamaAgent({endpoint, model, capabilities, contextTokens, budget, history, prompt, instructions, tools, signal, onMetrics, onText, onStatus, execute}) {
  const context = Math.min(contextTokens || capabilities.modelContext || 32768, capabilities.trainedContext || Infinity);
  const allowance = Math.max(3500,(context - Math.min(8192, Math.floor(context/3))) * 2);
  const base = [
    {role:"system",content:instructions},
    {role:"user",content:prompt}
  ];
  const clipHistory = [];
  let size = base.reduce((total,m)=>total+m.content.length,0);
  for (let end=history.length; end>0;) {
    const assistant=history[end-1], user=history[end-2];
    if (assistant?.role!=="assistant" || user?.role!=="user") { end--; continue; }
    end-=2;
    const pair=[{role:"user",content:user.text.slice(0,5000)},{role:"assistant",content:cleanAgentText(assistant.text).slice(0,5000)}];
    const next=size+pair[0].content.length+pair[1].content.length;
    if (next>allowance/2) break;
    clipHistory.unshift(...pair);
    size=next;
  }
  if (!capabilities.tools && !capabilities.completion) {
    onText("This model does not advertise native Ollama tools. Select a tool-capable model to run this task, or switch to Plan for a text response.");
    return "tools_unsupported";
  }
  const catalog = [...tools, completion];
  const needsExecution=/^(?:please\s+)?(?:create|build|implement|fix|repair|edit|write|run|test|add|set up|make|develop|compile|refactor|inspect|verify)\b/i.test(prompt.trim());
  const groups = [];
  const structuredGroups = [];
  const format = {type:"object",additionalProperties:false,required:["name","arguments"],properties:{
    name:{type:"string",enum:catalog.map(tool=>tool.function.name)},arguments:{type:"object"}
  }};
  const compatibilityInstructions = instructions + "\n\nUse structured JSON mode. Return one JSON object containing the name of a registered tool and its arguments object. Read each tool result before selecting the next operation. Use finish_task to end. Available tools:\n"+
    catalog.map(({function: tool})=>tool.name+": "+tool.description+" "+JSON.stringify(tool.parameters)).join("\n");
  let compatible = !capabilities.tools;
  if (compatible) onStatus("Using Ollama structured JSON compatibility mode for this model.");
  const seen = new Map();
  let callCount=0, successCount=0, noCalls=0, lastActionFailed=false, needsVerification=false;
  const finishIncomplete = (message,reason) => {onText(message);return reason;};
  for (let round=0; round<budget.rounds; round++) {
    signal.throwIfAborted();
    const included=[];
    let used=size+(compatible?compatibilityInstructions.length:JSON.stringify(catalog).length);
    for (const group of (compatible?structuredGroups:groups).toReversed()) {
      const next=used+group.size;
      if (included.length && next>allowance) break;
      included.unshift(...group.messages);
      used=next;
    }
    const retry = noCalls?"\nThe previous response did not contain a valid tool action. Continue the current objective with a registered call or finish_task. Printed commands never execute.":"";
    const system={role:"system",content:(compatible?compatibilityInstructions:base[0].content)+retry};
    const step = await ollamaRound({endpoint,model,context,...(compatible?{format}:{tools:catalog}),signal,onMetrics,
      messages:[system,...clipHistory,base[1],...included]});
    if (compatible) {
      step.calls=[];
      try {
        const value=JSON.parse(step.structured);
        if (Object.keys(value).length===2 && typeof value.name==="string" &&
            value.arguments && typeof value.arguments==="object" && !Array.isArray(value.arguments)) {
          step.calls=[{name:value.name,input:value.arguments,invalid:false}];
        }
      } catch {}
    }
    if (!step.calls.length) {
      noCalls++;
      if (!compatible && capabilities.completion && callCount===0 && noCalls>=2) {
        compatible=true;
        noCalls=0;
        onStatus("The model returned prose instead of native tool calls. Trying structured JSON compatibility mode.");
        continue;
      }
      if (noCalls>=3) {
        return finishIncomplete("The model ended without a structured completion. Review the tool results above and continue the task with a tool-capable model if needed.","incomplete");
      }
      continue;
    }
    noCalls=0;
    const calls=step.calls.map(({name,invalid,input},index)=>({function:{index,name,arguments:invalid?{}:input}}));
    const messages=[{role:"assistant",content:step.content.slice(0,3000),
      ...(capabilities.thinking&&step.thinking?{thinking:step.thinking.slice(-5000)}:{}),tool_calls:calls}];
    for (const call of step.calls) {
      signal.throwIfAborted();
      const {name,input,invalid}=call;
      let result;
      if (name==="finish_task") {
        const summary = typeof input?.summary==="string" ? cleanAgentText(input.summary) : "";
        const status = input?.status;
        const valid = !invalid && step.calls.length===1 && ["completed","incomplete","answered"].includes(status) && summary &&
          summary.length<=12000 && Object.keys(input).length===2;
        if (!valid) result={ok:false,error:"Call finish_task by itself with a valid status and summary."};
        else if (status==="completed" && (successCount===0 || lastActionFailed || needsVerification)) result={ok:false,error:"Completion needs successful tool evidence. Read back changed files or run checks after the last mutation. Report outstanding failures as incomplete."};
        else if (status==="answered" && (callCount>0 || needsExecution)) result={ok:false,error:"This task requires execution. Use tools and verify the work, or report incomplete."};
        else {onText(summary);return status==="incomplete"?"incomplete":"end_turn";}
      } else {
        if (callCount++>=budget.calls) {
          return finishIncomplete("Tool call limit reached. Review the saved actions and continue from the current workspace state.","max_tool_calls");
        }
        const signature=JSON.stringify([name,Object.entries(input ?? {}).sort(([a],[b])=>a.localeCompare(b))]);
        const attempts=seen.get(signature) || 0;
        seen.set(signature,attempts+1);
        result=invalid?{ok:false,error:"Invalid JSON arguments. Send a valid argument object."}:
          attempts>=2?{ok:false,error:"Repeated identical request blocked. Use the prior result or change the input."}:await execute(name,input);
        lastActionFailed=!result.ok;
        if (result.ok) {
          successCount++;
          if (["write_file","edit_file","create_directory"].includes(name)) needsVerification=true;
          if (["read_file","run_command"].includes(name)) needsVerification=false;
        }
      }
      messages.push({role:"tool",tool_name:name,content:JSON.stringify(result)});
    }
    const structuredMessages=compatible?[
      {role:"assistant",content:JSON.stringify({name:step.calls[0].name,arguments:step.calls[0].input})},
      {role:"user",content:"Tool result from WiskHarness: "+messages[1].content}
    ]:messages;
    (compatible?structuredGroups:groups).push({messages:structuredMessages,size:JSON.stringify(structuredMessages).length});
  }
  return finishIncomplete("Model round limit reached. The completed actions are saved. Review them before continuing.","max_model_rounds");
}
