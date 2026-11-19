import {openPopover,refreshPopover} from "./popover.js";

const display=(value,suffix="")=>Number.isFinite(value)?value.toLocaleString(undefined,{maximumFractionDigits:1})+suffix:"Unavailable";
const ms=value=>Number.isFinite(value)?display(value," ms"):"Unavailable";
const ns=value=>Number.isFinite(value)?ms(value/1e6):"Unavailable";
const gib=value=>Number.isFinite(value)?display(value/1073741824," GiB"):"Unavailable";
const states=new WeakMap();
function rows(title,items){
  const group=document.createElement("section");
  const heading=document.createElement("h3");
  heading.textContent=title;
  const list=document.createElement("dl");
  list.className="performance-grid";
  for(const [name,value] of items){
    const label=document.createElement("dt"),data=document.createElement("dd");
    label.textContent=name;data.textContent=value;
    list.append(label,data);
  }
  group.append(heading,list);
  return group;
}
function draw(state){
  const {button,panel,hardware,data}=state;
  const {model,identity,sessionId,metrics,running,connected}=data;
  const current=metrics?.model===model&&metrics?.sessionId===sessionId?metrics:null;
  const sample=running?null:current;
  const loaded=identity.provider==="Ollama"&&hardware?.loaded?.find(item=>item.name===model||item.name===model+":latest");
  const capacity=current?.contextSize??current?.ollamaContext??(loaded?.context>0?loaded.context:null);
  const measured=Number.isFinite(current?.contextUsed);
  const used=measured?current.contextUsed:sample?.source==="ollama"&&Number.isFinite(sample.totalTokens)?sample.totalTokens:null;
  const ratio=capacity&&used!==null?used/capacity:null;
  const speed=Number.isFinite(current?.tokensPerSecond)?display(current.tokensPerSecond," tokens/sec"):null;
  button.textContent=data.compact?"Performance":
    [identity.label||"Choose a model",identity.provider,running?"Running":"Idle",speed,
      ratio===null?null:(measured?"":"~")+display(ratio*100,"% context")].filter(Boolean).join(" · ");
  button.title=button.textContent;
  if(!panel?.isConnected)return;
  const inference=rows("Inference",[
    ["Model",identity.label||"Unavailable"],["Provider",identity.provider],
    ["Connection",connected===true?"Available":connected===false?"Unavailable":"Unverified"],
    ["Generation speed",speed||"Unavailable"],["Prompt tokens",display(current?.prompt_eval_count)],
    ["Generated tokens",display(current?.eval_count)],["Measured turn tokens",display(current?.totalTokens)],
    ["ACP session tokens",display(current?.acpSessionTokens)],["Time to first text",ms(current?.firstTextMs)],
    ["Response duration",current?.status==="running"?"Running":ms(current?.elapsedMs)],
    ["Provider total",ns(current?.total_duration)],["Prompt evaluation",ns(current?.prompt_eval_duration)],
    ["Generation duration",ns(current?.eval_duration)],["Model load",ns(current?.load_duration)],
    ["Rate limit",current?.rateLimited?"Reported":"Unavailable"],["Estimated API cost","Unavailable"]
  ]);
  const context=rows("Context",[
    ["Requested context",display(current?.configuredContext??(identity.provider==="Ollama"?hardware?.contextTokens:null))],
    ["Context window",display(capacity)],[measured?"Measured context usage":"Last turn usage estimate",used===null?"Unavailable":display(used," tokens")],
    [measured?"Measured share":"Estimated share",ratio===null?"Unavailable":(measured?"":"~")+display(ratio*100,"%")]
  ]);
  if(ratio!==null){
    const meter=document.createElement("meter");
    meter.max=1;meter.value=Math.min(1,ratio);meter.low=0.75;meter.high=0.9;meter.optimum=0;
    meter.setAttribute("aria-label","Share of context window");context.append(meter);
    if(ratio>=0.9){
      const warning=document.createElement("p");
      warning.className="performance-warning";warning.textContent=measured?"Context is near its reported limit.":"The last turn approached the loaded context limit.";
      context.append(warning);
    }
  }
  const memory=hardware?.systemMemory;
  const host=rows("Hardware",[
    ["CPU utilization",display(hardware?.cpuPercent,"%")],["Host RAM",memory?gib(memory.used)+" / "+gib(memory.total):"Unavailable"],
    ["GPU utilization","Unavailable"],["Total VRAM used / capacity","Unavailable"],
    ["Loaded Ollama models",hardware?.ollamaError?"Unavailable":hardware?.loaded?.map(item=>item.name).join(", ")||
      (hardware?"None":"Unavailable")],["Selected model VRAM allocation",gib(loaded?.vram)]
  ]);
  panel.querySelector(".performance-content").replaceChildren(inference,context,host);
  refreshPopover(panel);
}
export function mountPerformance(root,data){
  if(!states.has(root)){
    const button=document.createElement("button");
    button.type="button";
    button.className="performance-trigger";
    button.setAttribute("aria-haspopup","dialog");
    button.setAttribute("aria-expanded","false");
    const state={button};
    states.set(root,state);root.replaceChildren(button);
    button.onclick=async()=>{
      const panel=document.createElement("div");
      panel.className="performance-popover";
      panel.setAttribute("role","dialog");
      panel.setAttribute("aria-label","Model performance");
      panel.innerHTML='<div class="popover-title">Model performance</div><div class="performance-content" tabindex="0" aria-label="Performance measurements"></div>';
      if(!openPopover(panel,button))return;
      state.panel=panel;
      panel.querySelector(".performance-content").focus({preventScroll:true});
      draw(state);
      async function refresh(){
        if(!panel.isConnected)return;
        try{state.hardware=await state.data.onOpen()}catch{state.hardware=null}
        if(!panel.isConnected)return;
        draw(state);
        setTimeout(refresh,8000);
      }
      await refresh();
    };
  }
  const state=states.get(root);
  state.data=data;
  draw(state);
}
