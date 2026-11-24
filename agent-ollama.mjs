import {Readable} from "node:stream";
import {createInterface} from "node:readline";
import {redactSecrets} from "./security-policy.mjs";

export const defaultBudget = {rounds:64, calls:140, minutes:25, recovery:6, context:32768};
export function validateBudget(input = {}) {
  const limits = {rounds:[2,160], calls:[1,400], minutes:[1,90], recovery:[2,15], context:[4096,131072]};
  return Object.fromEntries(Object.entries(limits).map(([key,[min,max]]) => {
    const value = input[key] ?? defaultBudget[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(key + " must be between " + min + " and " + max);
    return [key,value];
  }));
}

export function cleanAgentText(value,{trim=true}={}) {
  const cleaned=redactSecrets(String(value))
    .replace(/<(turn-context|current-time|working-directory|turn-budget|think|tool_call|tool_result|tool_response|function_call)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,"")
    .replace(/<\/?(?:turn-context|current-time|working-directory|turn-budget|think|tool_call|tool_result|tool_response|function_call)\b[^>]*(?:>|$)/gi,"")
    .replace(/<\|(?:im_start|im_end|eot_id|start_header_id|end_header_id|python_tag)\|>/gi,"");
  return trim?cleaned.trim():cleaned;
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

    const stats = Object.fromEntries(["eval_count","eval_duration","prompt_eval_count","prompt_eval_duration","total_duration","load_duration"]
      .filter(key=>Number.isFinite(event[key]) && event[key]>=0).map(key=>[key,event[key]]));
    if (stats.eval_duration > 0 && Number.isFinite(stats.eval_count)) stats.tokensPerSecond = stats.eval_count * 1e9 / stats.eval_duration;
    onMetrics(stats);
    return {stop:event.done_reason||"unspecified",promptTokens:stats.prompt_eval_count,outputTokens:stats.eval_count,content:cleanAgentText(content), structured:format?content:undefined, thinking, calls:[...calls.values()].map(({name,args,object}) => {
      let input = object ?? {}, invalid = false;
      if (args) try { input = JSON.parse(args); } catch { invalid = true; }
      return {name, input, invalid};
    })};
  }
  throw new Error("Ollama closed the Agent stream before the completion frame");
}

const completion = {
  type:"function", function:{name:"finish_task", description:"End the turn with the result. Use incomplete only for a concrete blocker that cannot be resolved with available tools. For a text-only question, report the answer with status answered.",
    parameters:{type:"object", additionalProperties:false, required:["status","summary"], properties:{
      status:{type:"string",enum:["completed","incomplete","answered"]}, summary:{type:"string",minLength:1,maxLength:12000}
    }}
  }
};

const executionRequest=/^(?:please\s+)?(?:create|build|implement|fix|repair|edit|write|run|test|add|set up|make|develop|compile|refactor|inspect|verify)\b/i;
export const requestsExecution = prompt => executionRequest.test(prompt.trim());
export function taskChecklist(prompt,previous=[]) {
  const requirements=[
    ["source","Implement source files",/\b(?:implement|source code|source files|programming project|functional GUI)\b/i],
    ["build","Compile or build the project",/\b(?:compil\w*|py_compile)\b/i],
    ["test","Run automated tests",/\b(?:automated tests|unit tests|unittest|pytest|run tests)\b/i],
    ["package","Produce the requested package",/\b(?:packag(?:e|es|ing)|distribution artifact|zip archive)\b/i]
  ];
  return requirements.filter(([, ,pattern])=>pattern.test(prompt)).map(([id,label])=>({
    id,label,evidence:previous.find(item=>item.id===id)?.evidence||null
  }));
}

export function commandObjectives(command) {
  return {
    build:!/\b(?:--version|-version)\b|^(?:get-|where|test-path)/i.test(command)&&/py_compile|(?:^|\s)(?:g\+\+|clang\+\+)(?:\.exe)?(?:\s|$)|\b(?:compile|build|javac|csc|ninja|gcc|clang)\b/i.test(command),
    test:!/^(?:get-|where|test-path)/i.test(command)&&/\b(?:unittest|pytest|tests?|ctest)\b/i.test(command.replace(/\b(?:app|test|tests)[\\/]\S+/g,"")),
    package:/compress-archive|zipfile|\b(?:package|pack|tar|zip)\b|pyinstaller|electron-builder/i.test(command)
  };
}

export async function runOllamaAgent({endpoint, model, capabilities, contextTokens, budget, history, prompt, instructions, tools, signal, onMetrics, onText, onStatus, execute, checkpoint, onCheckpoint=()=>{}}) {
  const context = Math.min(contextTokens || capabilities.modelContext || defaultBudget.context, budget.context || defaultBudget.context, capabilities.trainedContext || Infinity);
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
  const needsExecution=requestsExecution(prompt);
  const groups = [];
  const structuredGroups = [];
  const format = {type:"object",additionalProperties:false,required:["name","arguments"],properties:{
    name:{type:"string",enum:catalog.map(tool=>tool.function.name)},arguments:{type:"object"}
  }};
  const compatibilityInstructions = instructions + "\n\nUse structured JSON mode. Return one JSON object containing the name of a registered tool and its arguments object. Read each tool result before selecting the next operation. Use finish_task to end. Available tools:\n"+
    catalog.map(({function: tool})=>tool.name+": "+tool.description+" "+JSON.stringify(tool.parameters)).join("\n");
  let compatible = !capabilities.tools || checkpoint?.protocol==="json";
  if (compatible) onStatus("Using Ollama structured JSON compatibility mode for this model.");
  const seen = new Map();
  const checklist=taskChecklist(prompt,checkpoint?.checklist);
  const outstanding=()=>checklist.filter(item=>!item.evidence);
  let lastProgress=checkpoint?.lastProgress||null, correction="", recovery=0, compacted=0;
  let lastFailure="", lastFailureSignature=null;
  const started=performance.now();
  const pendingReadbacks=new Set();
  const recoveryLimit=budget.recovery||defaultBudget.recovery;

  const actionKey=(name,input)=>JSON.stringify([name,Object.entries(input??{}).sort(([a],[b])=>a.localeCompare(b))]);
  let blockedReason=null;
  const publish=(round,calls,stop,tokens)=>onCheckpoint({checklist,lastProgress,rounds:round,calls,
    protocol:compatible?"json":"native",providerStop:stop,context,tokens,recovery,recoveryLimit,compacted,elapsedMs:Math.round(performance.now()-started),limits:budget});
  publish(0,0,null);
  let callCount=0, successCount=0, noCalls=0, lastActionFailed=false, needsVerification=false;
  let workspaceRevision=0;
  function recover(reason) {
    recovery++;
    correction="\nRecovery required: "+reason+
      " Read the latest diagnostics. Try a different authorized action. For a missing command, check Get-Command and locally installed tools, then resolve the path or choose an available build tool. For compile or test failures, inspect the failing file, fix it and rerun the check. Ask before dependency installation.";
  }
  let lastRound=0,lastStop=null,lastTokens;
  const finishIncomplete = (message,reason) => {publish(lastRound,callCount,lastStop,lastTokens);onText(message);return reason;};
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
    compacted=Math.max(compacted,(compatible?structuredGroups:groups).length-(compatible?included.length/2:included.filter(message=>message.role==="assistant").length));
    const retry = noCalls?"\nThe previous response did not contain a valid tool action. Continue the current objective with a registered call or finish_task. Printed commands never execute.":"";
    const pending=outstanding().map(item=>item.label).join("; ");
    const system={role:"system",content:(compatible?compatibilityInstructions:base[0].content)+retry+
      (pending?"\nOutstanding objectives: "+pending+". Continue with real tools while actionable work remains.": "")+
      (lastProgress?"\nLast observed progress: "+lastProgress:"")+
      (lastFailure?"\nLatest failure evidence: "+lastFailure:"")+
      (checklist.some(item=>item.evidence)?"\nVerified checklist evidence: "+JSON.stringify(checklist.filter(item=>item.evidence)):"")+
      (checkpoint?"\nThis task resumed from a saved checkpoint. Inspect the current workspace and reverify outputs before completing.":"")+correction};
    const step = await ollamaRound({endpoint,model,context,...(compatible?{format}:{tools:catalog}),signal,onMetrics,
      messages:[system,...clipHistory,base[1],...included]});
    lastRound=round+1;lastStop=step.stop;lastTokens={input:step.promptTokens,output:step.outputTokens};
    publish(lastRound,callCount,lastStop,lastTokens);
    if(step.stop==="length"){
      recover("Ollama truncated its last response. Issue a single small tool call, or write a large file in smaller edits.");
      if(recovery>=recoveryLimit)return finishIncomplete("Repeated model output limits prevented progress.","model_output_limit");
      continue;
    }
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
      if (!compatible && capabilities.completion && noCalls>=2) {
        compatible=true;
        noCalls=0;
        onStatus("The model returned prose instead of native tool calls. Trying structured JSON compatibility mode.");
        continue;
      }
      recover("The model returned no usable tool call.");
      if (noCalls>=recoveryLimit || recovery>=recoveryLimit) {
        return finishIncomplete("The model ended without a structured completion. Review the tool results above and continue the task with a tool-capable model if needed.","no_structured_action");
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
        else if (status==="completed" && (successCount===0 || lastActionFailed || needsVerification || outstanding().length)) result={ok:false,error:"Completion needs successful tool evidence. Read back the changed files or run checks for the outstanding objectives. Continue while a check can run."};
        else if (status==="answered" && (callCount>0 || needsExecution || checklist.length)) result={ok:false,error:"This task requires execution. Use tools and verify the work, or report incomplete."};
        else if(status==="incomplete"){
          if(blockedReason){onText(summary+"\n\nPermission boundary: "+blockedReason);return "permission_blocked";}
          result={ok:false,error:"Work remains. Continue with the next concrete tool action or find a different recovery strategy."};
        }
        else {onText(summary);return "end_turn";}
        if(!result.ok)recover(result.error);
      } else {
        if (callCount>=budget.calls) {
          return finishIncomplete("Tool call limit reached. Review the saved actions and continue from the current workspace state.","max_tool_calls");
        }
        callCount++;
        const command=typeof input?.command==="string"?input.command:"";
        const signature=actionKey(name,input);
        const previous=seen.get(signature);
        const duplicate=previous?.revision===workspaceRevision;
        result=invalid?{ok:false,error:"Invalid JSON arguments. Send a valid argument object."}:
          duplicate?{ok:false,error:"This action already ran with the same inputs and workspace state. Use the prior result or try a different operation.",previous:previous.result}:
          await execute(name,input);
        lastActionFailed=!result.ok;
        const permissionFailure=!result.ok&&/permission denied|permission policy/i.test(String(result.error));
        if(permissionFailure)blockedReason=result.error;
        if(!result.ok && name==="write_file" && /EEXIST/.test(String(result.error))) {
          result.error += " Read the existing file and use edit_file with exact before and after text.";
        }
        const mutation=["write_file","edit_file","create_directory"].includes(name);
        if(result.ok && (mutation || name==="run_command"&&(commandObjectives(command).build||commandObjectives(command).package)))workspaceRevision++;
        if(!duplicate)seen.set(signature,{revision:workspaceRevision,result:{ok:result.ok,exitCode:result.exitCode,error:result.error}});
        if (result.ok) {
          blockedReason=null;
          successCount++;
          correction="";
          lastProgress=(name+" "+String(input?.path||command)).slice(0,420);
          const matches={...commandObjectives(command),package:result.artifacts?.length>0,
            source:["write_file","edit_file"].includes(name)&&/\.(?:py|js|ts|jsx|tsx|java|cs|rs|go|c|cpp|html|css|ps1)$/i.test(String(input?.path)),
          };
          if(matches.source){
            const isTest=/(?:^|[\\/])tests?(?:[\\/]|$)|(?:^|[\\/])test_[^\\/]+$/i.test(input.path);
            for(const item of checklist)if(item.id==="test"||!isTest&&item.id!=="source")item.evidence=null;
          }
          if(lastFailureSignature===signature||matches.build||matches.test||matches.package){
            lastFailure="";
            lastFailureSignature=null;
          }
          for(const item of checklist)if(matches[item.id])item.evidence=lastProgress;
          if (mutation || name==="run_command" || checklist.some(item=>item.evidence===lastProgress))recovery=0;
          if (mutation) {
            needsVerification=true;
            if(name!=="create_directory")pendingReadbacks.add(input.path);
          }
          if(name==="read_file")pendingReadbacks.delete(input.path);
          const shellRead=name==="run_command"&&command.match(/^(?:Get-Content\s+(?:-LiteralPath\s+)?|type\s+)["']?([^"'\s]+)["']?$/i);
          if(shellRead)pendingReadbacks.delete(shellRead[1]);
          if(name==="run_command"&&(matches.build||matches.test||matches.package))pendingReadbacks.clear();
          if((name==="read_file"||shellRead||name==="run_command"&&(matches.build||matches.test||matches.package))&&!pendingReadbacks.size)needsVerification=false;
        } else {
          const headline=String(result.error||result.stderr||result.stdout||"Tool failed").slice(0,1600);
          lastFailure=name+" "+command.slice(0,220)+": "+headline;
          lastFailureSignature=signature;
          const failed=commandObjectives(command);
          if(!duplicate)for(const item of checklist)if(failed[item.id])item.evidence=null;
          recover(headline);
        }
        publish(round+1,callCount,step.stop,{input:step.promptTokens,output:step.outputTokens});
      }
      messages.push({role:"tool",tool_name:name,content:JSON.stringify(result)});
      if(recovery>=recoveryLimit){
        publish(round+1,callCount,step.stop,{input:step.promptTokens,output:step.outputTokens});
        if(blockedReason)return finishIncomplete("Permission boundary: "+blockedReason,"permission_blocked");
        return finishIncomplete("Recovery limit reached without progress. "+(lastFailure||result.error),"recovery_stalled");
      }
    }
    const structuredMessages=compatible?[
      {role:"assistant",content:JSON.stringify({name:step.calls[0].name,arguments:step.calls[0].input})},
      {role:"user",content:"Tool result from WiskHarness: "+messages[1].content}
    ]:messages;
    (compatible?structuredGroups:groups).push({messages:structuredMessages,size:JSON.stringify(structuredMessages).length});
  }
  return finishIncomplete("Model round limit reached. The completed actions are saved. Review them before continuing.","max_model_rounds");
}
