import { showSetup, mountSettings, notifyUpdate, mountModelDiagnostics, mountAgentTools, mountCompatibility, showGitWorkspace, gooseRuntimeLabel, mountInternet } from "./workbench.js";
import {bindPopovers, closePopover, openPopover, refreshPopover} from "./popover.js";
import {renderMarkdown} from "./markdown.js";
import {mountPerformance} from "./performance.js";
import {mountPermissions,showCheckpoint} from "./chat-controls.js";

const $=s=>document.querySelector(s),$$=s=>Array.from(document.querySelectorAll(s));
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const TKEY="local-agent-ui-theme-v4",MKEY="local-agent-motion-v4",SKEY="local-agent-selected-session";
const THEMES=[
["graphite","Graphite","Cool charcoal","#111217","#17181f","#242630","#a9bcff"],
["midnight","Midnight","Deep navy","#09101c","#101a2a","#21304a","#99baff"],
["oled","OLED Black","High contrast","#050507","#0c0c10","#1d1d24","#c3b5ff"],
["forest","Forest","Muted green","#0b1412","#111e19","#22372c","#a5dfbc"],
["amethyst","Amethyst","Soft violet","#140f1d","#1c1628","#332845","#d4b5ff"],
["ember","Ember","Warm graphite","#18120f","#211913","#3f3027","#f2bc8d"],
["pearl","Pearl","Light","#f4f6f9","#ffffff","#e9edf4","#476bd4"]
];
const state={view:"chats",sessions:[],session:null,modelData:null,health:null,projects:[],busy:false,activeRun:null};
const MODE_KEY="local-agent-mode";
const chevron='<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const pendingVisibility=new Set();
const modeNames={plan:"Plan",agent:"Agent"};
const modeDescriptions={plan:"Chat, brainstorm, and plan",agent:"Code, execute, and build"};
const modeIcon=mode=>'<svg class="mode-icon" viewBox="0 0 24 24" aria-hidden="true">'+(mode==="plan"?'<path d="M5 4h14v13H9l-4 4zM9 8h6m-6 4h6"/>':'<path d="m5 7 5 5-5 5m8 0h6"/>')+'</svg>';
const currentMode=()=>state.session?.mode||(localStorage.getItem(MODE_KEY)==="agent"?"agent":"plan");
const selectedModel=()=>state.view==="chats"?(state.session?.model||state.draftModel||state.providerData?.modeDefaults?.[currentMode()]||state.modelData?.selected):state.modelData?.selected;
function modelIdentity(value){
  const match=/^@provider\/([^/]+)\/(.+)$/.exec(value||"");
  if(!match)return {label:value,provider:"Ollama",cloud:false};
  const info=state.providerData?.providers.find(provider=>provider.id===match[1]);
  return {label:match[2],provider:info?.name||match[1],cloud:!["lmstudio","compatible"].includes(match[1])};
}
const hasModelSource=()=>!!state.modelData||currentMode()==="plan"&&!!state.providerData;
const runInView=()=>!!state.session&&state.session.id===(state.activeRun?.sessionId||state.health?.activeSessionId);
const drafts=new Map();
const draftKey=()=>state.session?.id||currentMode();
function rememberDraft(){
  const input=$("#chat-input");
  if(input)drafts.set(draftKey(),input.value);
}
function showModePicker(anchor){
  const node=document.createElement("div");
  node.style.width="236px";
  node.setAttribute("role","menu");
  node.setAttribute("aria-label","Chat mode");
  node.innerHTML='<div class="popover-list">'+Object.keys(modeNames).map(mode=>
    '<button role="menuitemradio" aria-checked="'+(currentMode()===mode)+'" class="popover-item mode-row '+(currentMode()===mode?"active":"")+'" data-mode="'+mode+'">'+modeIcon(mode)+'<span><span class="option-name">'+modeNames[mode]+'</span><small>'+modeDescriptions[mode]+'</small></span><span class="option-check">'+(currentMode()===mode?"✓":"")+'</span></button>').join("")+'</div>';
  node.onclick=event=>{
    const mode=event.target.closest("[data-mode]")?.dataset.mode;
    if(!mode)return;
    closePopover(true);
    if(mode!==currentMode()){
      rememberDraft();navigationRequest++;
      state.session=null;state.draftModel=null;
      localStorage.removeItem(SKEY);localStorage.setItem(MODE_KEY,mode);
      $("#chat-input")?.remove();
      changeView("chats");renderSidebar();
      if(anchor.id==="home-mode-trigger")$("#chat-input")?.focus();
    }
  };
  openPopover(node,anchor);
}
const sid=id=>encodeURIComponent(id);
function toast(message,type=""){const el=document.createElement("div");el.className="toast "+type;el.textContent=message;$("#toast-layer").append(el);setTimeout(()=>el.remove(),4300)}
async function api(endpoint,options={}){
  let r;try{r=await fetch(endpoint,{cache:"no-store",...options})}catch{throw new Error("Local backend is unavailable")}
  let data={};try{data=await r.json()}catch{}
  if(!r.ok)throw new Error(data.error||"HTTP "+r.status);return data;
}
const post=(url,data)=>api(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data)});
const patch=(url,data)=>api(url,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(data)});
const shortPath=p=>String(p||"").replace(/[\\/]$/,"").split(/[\\/]/).pop()||String(p||"");
function applyTheme(){
  const theme=THEMES.find(x=>x[0]===localStorage.getItem(TKEY))||THEMES[0];
  document.body.dataset.theme=theme[0];document.body.dataset.motion=localStorage.getItem(MKEY)==="off"?"off":"on";
  $("#theme-label").textContent=theme[1];
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content",theme[3]);
  $$(".theme-tile").forEach(b=>{b.classList.toggle("selected",b.dataset.theme===theme[0]);b.setAttribute("aria-pressed",String(b.dataset.theme===theme[0]))});
  const sw=$("#motion-checkbox");if(sw)sw.checked=document.body.dataset.motion==="on";
}
function setTheme(id){if(THEMES.some(t=>t[0]===id)){localStorage.setItem(TKEY,id);applyTheme()}}
function renderTop(){
  const home=state.view==="chats"&&!state.session?.messages?.length;
  $(".main").classList.toggle("show-home",home);
  $("#view-title").textContent=home?"New chat":state.view[0].toUpperCase()+state.view.slice(1);
  $("#view-context").textContent=state.view==="chats"
    ? home?shortPath(state.session?.workspace||state.draftWorkspace||state.health?.preflight?.workspace||"Workspace"):shortPath(state.session.workspace)
    : shortPath(state.health?.preflight?.workspace||"Local workspace");
  const mode=currentMode();
  $("#mode-trigger").innerHTML=modeIcon(mode)+'<strong>'+modeNames[mode]+'</strong>'+chevron;
  const model=modelIdentity(selectedModel());
  $("#model-label").textContent=model.label||"Choose model";
  $("#model-trigger").title=$("#model-label").textContent;
  $("#model-trigger").setAttribute("aria-label",model.label?"Choose model, current model "+model.label:"Choose model");
  const legacy=state.health?.agentEngine==="goose";
  const ok=!!(state.health?.ollama&&(mode==="plan"||!legacy||state.health?.goose));
  $("#connection-dot").classList.toggle("online",ok);$("#connection-text").textContent=ok?"Local runtime online":"Runtime unavailable";
  $("#top-connection").textContent=state.busy?"Running":model.cloud?"Cloud · "+model.provider:model.provider!=="Ollama"?"Local · "+model.provider:state.health?.ollama?"Ollama connected":"Ollama offline";
  $("#runtime-label").textContent=mode==="plan"?model.provider:legacy?"Goose ACP · Ollama":"Ollama Agent";
  $("#top-connection").classList.toggle("online",ok);
  $("#model-trigger").disabled=!hasModelSource()||state.busy;
}
function changeView(view){
  if(!["chats","agents","projects","models","settings"].includes(view))return;
  closePopover();state.view=view;
  $$(".nav-item").forEach(b=>{b.classList.toggle("active",b.dataset.view===view);b.setAttribute("aria-current",b.dataset.view===view?"page":"false")});
  $(".sidebar").classList.remove("open");
  renderTop();render();
}
function render(){
  if(state.view==="chats")renderChats();
  else if(state.view==="agents")renderAgents();
  else if(state.view==="projects")renderProjects();
  else if(state.view==="models")renderModels();
  else if(state.view==="settings")renderSettings();
}
function renderSidebar(){
  const query=$("#session-search").value.toLowerCase().trim();
  $("#session-count").textContent=state.sessions.length;
  const data=query?(state.searchQuery===query?state.searchResults:state.sessions.filter(s=>(s.title+" "+(s.preview||"")).toLowerCase().includes(query))):state.sessions;
  $("#session-list").innerHTML=data.length?data.map(s=>'<div class="session-row '+(state.session?.id===s.id?"active":"")+'" data-session="'+esc(s.id)+'"><button class="session-button" data-action="open" title="'+esc(s.title)+'"><span class="session-title">'+esc(s.title)+'</span><span class="session-meta">'+modeNames[s.mode||"agent"]+' · '+(s.messageCount||0)+' messages</span></button><div class="session-actions"><button class="session-action" data-action="menu" aria-haspopup="menu" aria-expanded="false" title="Chat actions" aria-label="Chat actions">⋯</button></div></div>').join(""):'<p class="empty-sessions">'+(query?"No matching chats.":"Your chats will appear here after the first session.")+'</p>';
}
async function loadSessions(){state.sessions=(await api("/api/sessions")).sessions||[];$("#session-search").oninput?.()}
async function loadModels(force=false){
  [state.modelData,state.providerData]=await Promise.all([
    api("/api/models"+(force?"?refresh=1":"")).catch(()=>null),
    api("/api/providers").catch(()=>null)
  ]);
  renderTop();
}
async function loadProjects(){try{state.projects=(await api("/api/projects")).projects||[]}catch{state.projects=[]}}
async function loadHealth(){try{state.health=await api("/api/health");state.busy=!!state.health.busy}catch{state.health={goose:false,ollama:false,preflight:{}};state.busy=false}renderTop()}
let navigationRequest=0;
async function openSession(id,change=true){
  const request=++navigationRequest;
  try{
    const data=await api("/api/sessions/"+sid(id));
    if(request!==navigationRequest)return;
    rememberDraft();
    const live=state.activeRun;
    state.session=live?.sessionId===id?live.record:data.session;
    localStorage.setItem(SKEY,id);
    localStorage.setItem(MODE_KEY,state.session.mode);
    if(change){
      state.view="chats";
      $$(".nav-item").forEach(button=>{
        button.classList.toggle("active",button.dataset.view==="chats");
        button.setAttribute("aria-current",button.dataset.view==="chats"?"page":"false");
      });
      $(".sidebar").classList.remove("open");
    }
    closePopover();renderTop();renderSidebar();if(state.view==="chats")renderChats();
    return state.session;
  }catch(e){toast("Open chat failed: "+e.message,"error")}
}
async function newSession(workspace,mode=currentMode(),model=state.draftModel){
  try{
    const data=await post("/api/sessions",{workspace:workspace||state.draftWorkspace,mode,model});
    await loadSessions();
    return await openSession(data.session.id);
  }catch(e){toast(e.message,"error")}
}
async function handoff(id){
  try{
    const result=await post("/api/sessions/"+sid(id)+"/handoff",{});
    await loadSessions();await openSession(result.session.id);$("#chat-input")?.focus();
  }catch(e){toast(e.message,"error")}
}
function sessionMenu(anchor,id){
  const node=document.createElement("div");
  node.style.width="176px";node.setAttribute("role","menu");node.setAttribute("aria-label","Chat actions");
  node.innerHTML='<div class="popover-list"><button class="popover-item" role="menuitem">Rename chat</button><button class="popover-item" role="menuitem">Delete chat</button></div>';
  const [rename,remove]=node.querySelectorAll("button");
  rename.onclick=()=>{closePopover(true);void renameSession(id)};
  remove.onclick=()=>{closePopover(true);void deleteSession(id)};
  openPopover(node,anchor);
}
function modal(title,description,options={}){
  return new Promise(resolve=>{
    const dialog=document.createElement("dialog");
    dialog.className="modal";
    dialog.setAttribute("aria-labelledby","modal-title");
    dialog.innerHTML='<form method="dialog"><h2 id="modal-title">'+esc(title)+'</h2><p>'+esc(description)+'</p>'+(options.confirmOnly?"":'<input class="field" id="modal-value" aria-label="Chat name" maxlength="90" value="'+esc(options.value||"")+'" autofocus>')+'<div class="modal-actions"><button type="button" class="btn" id="modal-no" '+(options.confirmOnly?"autofocus":"")+'>Cancel</button><button class="btn '+(options.danger?"btn-danger":"btn-primary")+'" type="submit">'+esc(options.action||"Save")+'</button></div></form>';
    let result=null;
    dialog.querySelector("#modal-no").onclick=()=>dialog.close();
    dialog.querySelector("form").onsubmit=event=>{
      event.preventDefault();result=options.confirmOnly?true:dialog.querySelector("input").value;dialog.close();
    };
    dialog.addEventListener("close",()=>{dialog.remove();resolve(result)},{once:true});
    $("#dialog-layer").append(dialog);dialog.showModal();
  });
}
async function renameSession(id){
  const item=state.sessions.find(s=>s.id===id);if(!item)return;
  const title=await modal("Rename chat","Choose a short name for this conversation.",{value:item.title,action:"Rename"});
  if(!title?.trim())return;
  try{
    await patch("/api/sessions/"+sid(id),{title:title.trim()});
    if(state.session?.id===id)state.session.title=title.trim();
    await loadSessions();renderTop();if(state.view==="chats")renderChats();
    toast("Chat renamed","good");
  }catch(e){toast(e.message,"error")}
}
async function deleteSession(id){
  const item=state.sessions.find(s=>s.id===id);if(!item)return;
  const confirmed=await modal("Delete chat?","This removes the locally saved conversation from the app. This action cannot be undone.",{confirmOnly:true,action:"Delete",danger:true});
  if(!confirmed)return;
  try{
    await api("/api/sessions/"+sid(id),{method:"DELETE"});
    if(state.session?.id===id){state.session=null;localStorage.removeItem(SKEY)}
    await loadSessions();
    if(!state.session&&state.sessions.length)await openSession(state.sessions[0].id,false);
    renderTop();render();toast("Chat deleted","good");
  }catch(e){toast(e.message,"error")}
}
function showModelPicker(anchor){
  if(!hasModelSource()||state.busy)return;
  const node=document.createElement("div");
  node.setAttribute("role","dialog");node.setAttribute("aria-label","Select model");
  node.innerHTML='<div class="popover-title">Select model</div><input class="field popover-search" type="search" aria-label="Search models" placeholder="Search installed models…"><div class="popover-list" role="listbox"></div><div class="popover-footer"><button id="refresh-pick-models">Refresh models</button><button id="manage-pick-models">Manage visibility</button></div>';
  const input=node.querySelector("input"),list=node.querySelector(".popover-list");
  function draw(){
    const term=input.value.toLowerCase().trim(),selected=selectedModel(),visible=new Set(state.modelData?.visible||[]);
    const groups=[{label:"Ollama · Local",models:(state.modelData?.models||[]).filter(model=>visible.has(model.name)||model.name===selected)}];
    if(state.view==="chats"&&currentMode()==="plan"){
      for(const provider of state.providerData?.providers||[]){
        if(!provider.enabled||provider.cloud&&!provider.keySaved)continue;
        groups.push({label:provider.name+(provider.cloud?" · Cloud":" · Local"),
          models:[...new Set([provider.model,...provider.models].filter(Boolean))].map(model=>({name:"@provider/"+provider.id+"/"+model}))});
      }
    }
    function option(m){
      const label=modelIdentity(m.name).label;
      return '<button class="popover-item '+(m.name===selected?"active":"")+'" data-model="'+esc(m.name)+'" role="option" aria-selected="'+(m.name===selected)+'"><span style="flex:1;min-width:0"><span class="option-name">'+esc(label)+'</span>'+
        (Number.isFinite(m.size)?'<small>'+((m.size)/1073741824).toFixed(1)+' GB · '+esc(m.family||"Local model")+'</small>':"")+
        '</span><span class="option-check">'+(m.name===selected?"✓":"")+'</span></button>';
    }
    list.innerHTML=groups.map(group=>{
      const rows=group.models.filter(item=>(modelIdentity(item.name).label+" "+group.label).toLowerCase().includes(term));
    rows.sort((a,b)=>Number(b.name===selected)-Number(a.name===selected)||a.name.localeCompare(b.name));
      return rows.length?'<div class="popover-title" role="presentation">'+esc(group.label)+'</div>'+rows.map(option).join(""):"";
    }).join("")||'<p class="empty-panel">No models matched.</p>';
  }
  draw();
  if(!openPopover(node,anchor))return;
  input.oninput=()=>{draw();refreshPopover(node)};
  list.onclick=e=>{const el=e.target.closest("[data-model]");if(el){closePopover(true);selectModel(el.dataset.model)}};
  node.querySelector("#refresh-pick-models").onclick=async()=>{
    await loadModels(true);
    if(!hasModelSource()){closePopover(true);toast("Model lists are unavailable","error");return}
    if(node.isConnected){draw();refreshPopover(node)}
  };
  node.querySelector("#manage-pick-models").onclick=()=>changeView("models");
}
async function selectModel(name){
  if(state.busy)return toast("Finish or stop the run before switching models","error");
  const session=state.view==="chats"?state.session:null;
  try{
    if(session){
      const {session:updated}=await patch("/api/sessions/"+sid(session.id),{model:name});
      if(state.session?.id===session.id)state.session.model=updated.model;
      await loadSessions();
    }else if(state.view==="chats")state.draftModel=name;
    else{await post("/api/models/settings",{model:name});await loadModels()}
    rememberDraft();renderTop();render();toast("Selected "+modelIdentity(name).label,"good");
    if(state.view==="chats")$("#composer-model")?.focus();
  }catch(e){toast("Model selection: "+e.message,"error")}
}
function showThemes(anchor){
  const node=document.createElement("div");node.style.width="260px";
  node.innerHTML='<div class="popover-title">APPEARANCE</div><div class="popover-list">'+THEMES.map(t=>'<button class="popover-item" data-theme="'+t[0]+'"><span style="width:15px;height:15px;border-radius:4px;background:'+t[6]+'"></span><span>'+t[1]+'</span><span class="option-check">'+(document.body.dataset.theme===t[0]?"✓":"")+'</span></button>').join("")+'</div><div class="popover-footer"><button id="theme-options">Appearance settings</button></div>';
  if(!openPopover(node,anchor))return;
  node.querySelector(".popover-list").onclick=e=>{const t=e.target.closest("[data-theme]");if(t){setTheme(t.dataset.theme);closePopover()}};
  node.querySelector("#theme-options").onclick=()=>changeView("settings");
}
function heading(label,title,desc,right=""){
  return '<div class="page-heading-row"><div><h1 class="page-heading">'+esc(title)+'</h1><p class="page-desc">'+esc(desc)+'</p></div>'+right+'</div>';
}

const homePrompts={
  plan:[
    ["Plan a feature","Help me plan a feature. Ask what I want to build, then outline the approach and tests."],
    ["Review code","Review the code I share. Flag correctness issues and suggest tests.\n\n"],
    ["Debug an error","Help me diagnose this error. Ask for any missing context before proposing a fix.\n\n"]
  ],
  agent:[
    ["Inspect project","Inspect the current project and summarize its structure, entry points, and how to run its tests."],
    ["Review code","Review the current project changes for bugs and missing tests. Leave files as they are and report findings."],
    ["Debug an error","Help me debug this error in the current project. Start by identifying how to reproduce it.\n\n"]
  ]
};

function chatComposer(mode,running,home){
  const agent=mode==="agent";
  const model=modelIdentity(selectedModel()).label||"Choose model";
  const placeholder=agent?"Describe a task in this workspace…":"Ask a question or outline a plan…";
  return '<div class="composer-wrap"><div class="composer"><textarea id="chat-input" rows="'+(home?1:2)+
    '" maxlength="16000" placeholder="'+placeholder+'" aria-label="Message"></textarea><div class="composer-buttons">'+
    (home?'<button type="button" class="btn btn-small home-mode" id="home-mode-trigger" aria-label="Chat mode, '+modeNames[mode]+
      '" aria-haspopup="menu" aria-expanded="false">'+modeIcon(mode)+modeNames[mode]+chevron+'</button>':"")+
    (agent?'<button type="button" class="btn btn-small" id="chat-attach" title="Attach text file" aria-label="Attach text file">＋</button>':"")+
    '<button type="button" class="btn btn-small composer-model" id="composer-model" aria-label="Choose chat model" aria-haspopup="dialog" aria-expanded="false" title="'+esc(model)+'"><span>'+esc(model)+'</span>'+chevron+'</button>'+
    (agent?'<button type="button" class="btn btn-small permission-trigger" id="permission-trigger" aria-haspopup="menu" aria-expanded="false"></button>':"")+
    '<span class="badge" id="save-status" '+(home?"hidden":"")+'>'+(running?"Running":"Saved on PC")+'</span>'+
    (home?'<div id="composer-performance"></div>':"")+
    '<button type="button" class="btn btn-primary compose-send" id="chat-send">'+(running?"Stop":"Send")+
    '</button></div>'+(home?"":'<div id="composer-performance"></div>')+'</div></div>';
}

function chatHome(mode,session,composer){
  const agent=mode==="agent";
  const legacy=state.health?.agentEngine==="goose";
  const missing=agent&&legacy&&!state.health.goose;
  const setup=agent&&legacy&&!state.health.gooseRuntime?.portableAvailable;
  const folder=session?.workspace||state.draftWorkspace||state.health?.preflight?.workspace;
  const workspace=agent?'<button class="btn btn-small" type="button" id="home-workspace" aria-haspopup="menu" aria-label="'+esc("Workspace: "+(folder||"Choose workspace"))+'" title="'+esc(folder)+'" '+(session?"disabled":"")+'>'+esc(folder?shortPath(folder):"Choose workspace")+'</button>':"";
  return '<section class="home-stage" aria-labelledby="home-title"><div class="home-intro">'+
    '<img src="/wiskharness.png" width="36" height="36" alt=""><h1 id="home-title">'+
    (agent?"What should WiskHarness work on?":"What would you like to plan?")+'</h1></div>'+composer+
    '<div class="home-shortcuts" role="group" aria-label="Workspace and prompt suggestions">'+workspace+homePrompts[mode].map(([label],index)=>
      '<button class="btn btn-plain" type="button" data-home-prompt="'+index+'">'+label+'</button>').join("")+
    (setup?'<button class="btn btn-plain" type="button" id="configure-goose">'+(missing?"Set up Goose":"Set up portable Goose")+'</button>':"")+
    '</div>'+
    (missing?'<p class="home-notice" role="status">'+esc(state.health.gooseRuntime?.error||"Agent Mode needs a Goose runtime.")+'</p>':"")+
    (!selectedModel()&&state.health?'<p class="home-notice">Choose a model before sending. <button type="button" class="btn btn-plain btn-small" id="home-models">Manage models</button></p>':"")+
    (agent&&session?'<details class="home-session-tools"><summary>Session tools</summary><div id="chat-inspector" class="inspector-inner"></div></details>':"")+
    '</section>';
}

function renderChats(){
  renderTop();
  const s=state.session,mode=currentMode(),plan=mode==="plan",running=runInView(),home=!s?.messages?.length;
  const composer=chatComposer(mode,running,home);
  const transcript='<div class="chat-scroll" id="chat-scroll"><div class="chat-scroll-inner" id="chat-body"></div></div>';
  const inspector='<aside class="chat-inspector"><div class="inspector-header">Session inspector</div><div id="chat-inspector" class="inspector-inner"></div></aside>';
  $("#content").innerHTML='<div class="chat-view '+mode+(home?' chat-home':'')+'"><div class="chat-main">'+
    (home?chatHome(mode,s,composer):transcript+composer)+'</div>'+(!home&&!plan?inspector:"")+'</div>';
  if(!home){
    const body=$("#chat-body");
    const statuses={running:"Running",completed:"Saved",ready:"Saved",interrupted:"Interrupted",cancelled:"Stopped",incomplete:"Incomplete",error:"Error"};
    body.innerHTML='<div class="chat-heading"><strong>'+esc(s.title)+'</strong><span class="badge '+(running?"warn":"")+'">'+(statuses[s.status]||"Saved")+'</span></div><div id="messages"></div>';
    for(const m of s.messages)appendMessage(m);
    if(!plan&&!running&&s.task){
      const details=document.createElement("section");
      if(s.task.stopReason){const reason=document.createElement("p");reason.textContent="Stop reason: "+s.task.stopReason.replaceAll("_"," ");details.append(reason)}
      const progress=s.task.checkpoint;
      if(progress){
        const line=document.createElement("p");
        const used=(amount,limit)=>limit?amount+"/"+limit:amount;
        const limits=progress.limits;
        const parts=[used(progress.rounds,limits?.rounds)+" model rounds",used(progress.calls,limits?.calls)+" tool calls"];
        if(progress.recoveryLimit)parts.push(used(progress.recovery,progress.recoveryLimit)+" recovery attempts",
          Math.round(progress.elapsedMs/1000)+" s elapsed",used(progress.tokens?.input??0,progress.context)+" input context tokens");
        if(progress.providerStop)parts.push("Ollama stop: "+progress.providerStop);
        line.textContent=parts.join(" · ");
        details.append(line);
      }
      const goals=document.createElement("ul");
      for(const item of s.task.checkpoint?.checklist||[]){
        const entry=document.createElement("li");entry.textContent=item.label+" · "+(item.evidence?"Observed: "+item.evidence:"Outstanding");goals.append(entry);
      }
      if(goals.children.length)details.append(goals);
      if(["incomplete","cancelled","interrupted","error"].includes(s.status)){
        const button=document.createElement("button");button.type="button";button.className="btn btn-small";button.textContent="Continue task";button.disabled=state.busy;
        button.onclick=()=>runPrompt(true);details.append(button);
      }
      if(details.children.length)body.append(details);
    }
    if(plan&&!running){
      const action=document.createElement("button");action.className="btn btn-small";
      action.textContent="Continue in Agent Mode";action.onclick=()=>handoff(s.id);body.append(action);
    }
    scrollChat();
  }
  updateInspector();
  if(!plan){
    const webControl=document.createElement("span");
    webControl.className="composer-internet";
    $("#save-status").before(webControl);
    void mountInternet(webControl,false,state.busy);
  }
  if(s?.mode==="agent"&&(s.memoryCheckpoint?.error||s.memoryCheckpoint?.contextError))notifyCheckpoint(s.id,s.memoryCheckpoint);
  void mountPermissions($("#permission-trigger"),api,post,toast);
  updatePerformance();
  const mobile = matchMedia("(max-width: 960px)").matches;
  if(!plan&&s){
    let tools=$("#chat-inspector");
    if(mobile&&!home){
      tools=document.createElement("div");
      tools.className="compact-workbench";
      $(".composer-wrap").prepend(tools);
    }
    mountAgentTools(tools,s,prompt=>{
      const input=$("#chat-input");if(!input)return;
      input.value=prompt.slice(0,16000);input.dispatchEvent(new Event("input"));input.focus();
    },()=>openSession(s.id,false));
  }
  const picker=$("#composer-model");
  picker.disabled=!hasModelSource()||state.busy;
  picker.onclick=e=>showModelPicker(e.currentTarget);
  if($("#chat-attach"))$("#chat-attach").onclick=attachFile;
  const send=$("#chat-send");
  send.onclick=()=>running?cancelRun():runPrompt();
  const input=$("#chat-input");
  input.value=drafts.get(draftKey())||"";
  const updateSend=()=>{send.disabled=!running&&(state.busy||!selectedModel()||!input.value.trim())};
  updateSend();
  input.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!send.disabled&&!runInView())runPrompt()}};
  input.oninput=e=>{e.target.style.height="auto";e.target.style.height=Math.min(190,e.target.scrollHeight)+"px";drafts.set(draftKey(),e.target.value);updateSend()};
  if(input.value)input.dispatchEvent(new Event("input"));
  if(home){
    $("#home-mode-trigger").onclick=event=>showModePicker(event.currentTarget);
    const folder=$("#home-workspace");
    if(folder&&!folder.disabled)folder.onclick=()=>{
      const list=document.createElement("div");
      list.className="popover-list";list.setAttribute("role","menu");list.setAttribute("aria-label","Workspace");
      for(const project of state.projects.filter(project=>project.exists)){
        const option=document.createElement("button");
        option.className="popover-item";option.setAttribute("role","menuitem");option.textContent=project.name;option.title=project.path;
        option.onclick=()=>{rememberDraft();state.draftWorkspace=project.path;closePopover();renderChats();$("#chat-input")?.focus()};
        list.append(option);
      }
      const manage=document.createElement("button");
      manage.className="popover-item";manage.setAttribute("role","menuitem");manage.textContent="Manage project folders";
      manage.onclick=()=>{rememberDraft();changeView("projects")};list.append(manage);
      openPopover(list,folder);
    };
    const configure=$("#configure-goose");
    if(configure)configure.onclick=()=>{
      changeView("settings");
      const section=$("#content [data-goose-runtime]")?.closest(".card");
      section?.scrollIntoView({block:"start"});
      section?.focus({preventScroll:true});
    };
    const models=$("#home-models");
    if(models)models.onclick=()=>changeView("models");
    $$("[data-home-prompt]").forEach(button=>button.onclick=()=>{
      const prompt=homePrompts[mode][Number(button.dataset.homePrompt)][1];
      if(input.value.trim()&&input.value!==prompt)input.value=input.value.trimEnd()+"\n\n"+prompt;
      else input.value=prompt;
      input.value=input.value.slice(0,input.maxLength);
      input.dispatchEvent(new Event("input"));
      input.focus();
      input.setSelectionRange(input.value.length,input.value.length);
    });
  }
}
function updatePerformance(){
  const root=$("#composer-performance");
  if(!root)return;
  const model=selectedModel(),identity=modelIdentity(model);
  mountPerformance(root,{
    model,identity,sessionId:state.session?.id,
    metrics:state.performance,running:runInView()&&state.busy,compact:!!root.closest(".chat-home"),
    connected:identity.provider==="Ollama"?state.health?.ollama&&(currentMode()==="plan"||state.health?.agentEngine!=="goose"||state.health?.goose):
      state.providerData?.providers.find(item=>item.name===identity.provider||item.id===identity.provider)?.connected,
    onOpen:()=>api("/api/models/diagnostics")
  });
}
function notifyCheckpoint(id,checkpoint){
  if(state.session?.id!==id||!$("#chat-body"))return;
  showCheckpoint($("#chat-body"),checkpoint,async()=>{
    const updated=(await post("/api/sessions/"+sid(id)+"/checkpoint/retry",{})).checkpoint;
    if(state.session?.id===id)state.session.memoryCheckpoint=updated;
    return updated;
  },()=>{rememberDraft();changeView("settings");$("#report-preview")?.click()},toast);
}
function toolRow(tool){
  const row=document.createElement("details");
  row.className="tool-entry";row.dataset.tool=tool.id;
  const label=document.createElement("summary");
  label.textContent=tool.title+" · "+tool.status;
  row.append(label);
  for(const [name,value] of [["Input",tool.input],["Output",tool.output]]){
    if(!value)continue;
    const block=document.createElement("pre");block.textContent=value;block.setAttribute("aria-label",name);row.append(block);
  }
  return row;
}
function appendMessage(m){
  let target=$("#messages");
  if(!target){
    const root=$("#chat-body");if(!root)return;
    root.innerHTML='<div class="chat-heading"><strong>'+esc(state.session?.title||"Saved chat")+'</strong><span class="badge">SAVED ON PC</span></div><div id="messages"></div>';
    target=$("#messages");
  }
  const block=document.createElement("article");block.className="message message-"+m.role;block.dataset.message=m.id;
  if(m.role==="user"){
    const bubble=document.createElement("div");bubble.className="user-bubble";bubble.textContent=m.text||"";block.append(bubble);
  }else{
    const row=document.createElement("div");row.className="assistant-row";
    const icon=document.createElement("div");icon.className="assistant-icon";icon.innerHTML=modeIcon(currentMode());
    const content=document.createElement("div");content.className="assistant-body";
    const byline=document.createElement("div");byline.className="assistant-byline";byline.textContent="WiskHarness";
    const answer=document.createElement("div");answer.className="assistant-text";renderMarkdown(answer,m.text,{streaming:m.status==="streaming"});
    const activity=document.createElement("details");activity.className="message-tools";activity.hidden=currentMode()==="plan"||!(m.tools?.length);
    activity.innerHTML='<summary>Tool activity (<span class="tool-count">'+(m.tools?.length||0)+'</span>)</summary><div class="tool-list"></div>';
    for(const t of m.tools||[])activity.querySelector(".tool-list").append(toolRow(t));
    const status=document.createElement("div");status.className="message-status";status.textContent=m.status==="streaming"?"Working…":m.status==="error"?(m.error||"Error"):m.status==="interrupted"?"Interrupted":m.status==="cancelled"?"Stopped":m.status==="incomplete"?"Incomplete":"";
    if(m.status==="error")status.classList.add("error");
    content.append(byline,answer,activity,status);row.append(icon,content);block.append(row);
  }
  target.append(block);return block;
}
function scrollChat(){const root=$("#chat-scroll");if(root)root.scrollTop=root.scrollHeight}
function updateInspector(){
  const panel=$("#chat-inspector");if(!panel)return;
  const p=state.health?.preflight||{},s=state.session;
  panel.innerHTML='<div class="inspector-group"><div class="inspector-label">AGENT</div><div class="inspector-info"><strong>'+(state.health?.agentEngine==="goose"?"Goose ACP + Ollama":"Ollama Agent")+'</strong><p>'+esc(s?.model||state.modelData?.selected||"No model")+'</p>'+(s?.task?.engineNotice?'<p>'+esc(s.task.engineNotice)+'</p>':"")+'<p class="'+((state.health?.agentEngine!=="goose"||state.health?.goose)&&state.health?.ollama?"green":"")+'">'+((state.health?.agentEngine!=="goose"||state.health?.goose)&&state.health?.ollama?"Connected":"Setup needed")+'</p></div></div>'+
    '<div class="inspector-group"><div class="inspector-label">SAVED SESSION</div><div class="inspector-list"><div class="inspector-item"><span>Storage</span><span>Local files</span></div><div class="inspector-item"><span>Messages</span><span>'+(s?.messages?.length||0)+'</span></div><div class="inspector-item"><span>Status</span><span>'+esc(s?.status||"Not started")+'</span></div></div></div>'+
    '<div class="inspector-group"><div class="inspector-label">WORKING DIRECTORY</div><div class="inspector-info"><strong>'+esc(shortPath(s?.workspace||p.workspace||"Workspace"))+'</strong><p class="codepath">'+esc(s?.workspace||p.workspace||"Not configured")+'</p></div></div>'+
    '<div class="inspector-group"><div class="inspector-label">TOOLS</div><div class="inspector-list"><div class="inspector-item"><span>File operations</span><span>'+(p.workspace===s?.workspace&&p.filesystem?"Verified":"Not checked")+'</span></div><div class="inspector-item"><span>PowerShell</span><span>'+(p.workspace===s?.workspace&&p.terminal?"Verified":"Not checked")+'</span></div></div></div>'+
    '<p class="inline-help">The agent requests approval for tool operations that need permission.</p>';
}
async function attachFile(){
  const picker=document.createElement("input");picker.type="file";picker.accept=".txt,.md,.java,.js,.json,.ts,.tsx,.css,.html,.xml,.yml,.yaml,.py,.log,.properties,.gradle";picker.hidden=true;document.body.append(picker);
  picker.onchange=async()=>{
    try{
      const file=picker.files?.[0];if(!file)return;
      if(file.size>12000)throw new Error("Choose a text file under 12 KB");
      const text=await file.text(),addition="\n\nAttached "+file.name+":\n"+text+"\n",input=$("#chat-input");
      if(!input)return;
      if((input.value+addition).length>16000)throw new Error("Message exceeds the 16,000 character limit");
      input.value+=addition;input.dispatchEvent(new Event("input"));input.focus();toast("Text file attached","good");
    }catch(e){toast(e.message,"error")}finally{picker.remove()}
  };
  picker.oncancel=()=>picker.remove();
  picker.click();
}
async function runPrompt(resume=false){
  if(state.activeRun||state.starting)return;
  if(state.busy)return toast("The agent is already running another task","error");
  const prompt=resume?"Continue task":$("#chat-input")?.value.trim();if(!prompt)return;
  if(!state.session){
    state.starting=true;
    try{
      if(!await newSession())return;
      const input=$("#chat-input");
      if(input&&!input.value){input.value=prompt;input.dispatchEvent(new Event("input"))}
    }
    finally{state.starting=false}
  }
  const record=state.session,recordId=record.id;
  const model=modelIdentity(record.model);
  if(model.cloud){
    state.starting=true;
    try{
      const agreed=await modal("Send chat to "+model.provider+"?","Your message and the text in this conversation will leave this PC. Review any pasted project content before sending. Your provider may charge for this request.",{confirmOnly:true,action:"Send to "+model.provider});
      if(!agreed||state.session?.id!==recordId)return;
    }finally{state.starting=false}
  }
  drafts.delete(draftKey());drafts.delete(currentMode());
  state.activeRun={sessionId:recordId,record};state.performance=null;state.busy=true;
  record.status="running";
  const stamp=Date.now();
  const user={id:"optimistic-user-"+stamp,role:"user",text:prompt,createdAt:new Date().toISOString()};
  const reply={id:"optimistic-assistant-"+stamp,role:"assistant",text:"",status:"streaming",tools:[],createdAt:new Date().toISOString()};
  state.session.messages.push(user,reply);
  if(state.session.title==="New chat")state.session.title=prompt.replace(/\s+/g," ").slice(0,75);
  renderTop();renderChats();scrollChat();
  let remainder="",completed=false,markdownTimer=null;
  function renderStream(){
    markdownTimer=null;
    const element=document.querySelector('[data-message="'+reply.id+'"] .assistant-text');
    const scroll=$("#chat-scroll");
    if(!element||!scroll)return;
    const atEnd=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<90;
    renderMarkdown(element,reply.text,{streaming:!completed});
    if(atEnd)scrollChat();
  }
  function onEvent(event){
    if(event.type==="text"){
      reply.text+=event.text||"";
      if(markdownTimer===null&&state.session?.id===recordId)markdownTimer=setTimeout(renderStream,100);
    }else if(event.type==="tool"){
      const t=event.update||{},idx=reply.tools.findIndex(x=>x.id===t.id);
      if(idx>=0)reply.tools[idx]=t;else reply.tools.push(t);
      const details=document.querySelector('[data-message="'+reply.id+'"] .message-tools');
      if(details){
        details.hidden=false;details.querySelector(".tool-count").textContent=reply.tools.length;
        const list=details.querySelector(".tool-list");
        const previous=[...list.children].find(row=>row.dataset.tool===t.id), next=toolRow(t);
        if(previous){next.open=previous.open;previous.replaceWith(next)}else list.append(next);
      }
    }else if(event.type==="task"){record.task=event.task;}
    else if(event.type==="status"&&event.update.includes("compatibility mode")){toast(event.update);}
    else if(event.type==="permission")showPermission(event);
    else if(event.type==="permission-resolved")dismissPermission(event.requestId);
    else if(event.type==="metrics"){state.performance=event.metrics;updatePerformance()}
    else if(event.type==="memory"){
      record.memoryCheckpoint=event;
      if(event.error||event.contextError)notifyCheckpoint(recordId,event);
    }
    else if(event.type==="error"){reply.status="error";reply.error=event.message;toast(event.message,"error")}
    else if(event.type==="done"){reply.status=event.session.status;completed=true}
    else if(event.type==="start"){if(runInView())$("#save-status")?.replaceChildren(document.createTextNode("Running"));record.status="running"}
    const marker=document.querySelector('[data-message="'+reply.id+'"] .message-status');
    if(marker)marker.textContent=reply.status==="error"?reply.error:completed?(reply.status==="incomplete"?"Incomplete":"Saved"):"Working…";
  }
  try{
    const response=await fetch("/api/sessions/"+sid(recordId)+"/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt,resume,cloudConsent:model.cloud?record.model:undefined})});
    if(!response.ok){let err={};try{err=await response.json()}catch{}throw new Error(err.error||"HTTP "+response.status)}
    const reader=response.body.getReader(),decoder=new TextDecoder();
    while(true){
      const data=await reader.read();if(data.done)break;
      remainder+=decoder.decode(data.value,{stream:true});
      let p;while((p=remainder.indexOf("\n\n"))>=0){
        const block=remainder.slice(0,p);remainder=remainder.slice(p+2);
        for(const line of block.split("\n"))if(line.startsWith("data: ")){
          try{onEvent(JSON.parse(line.slice(6)))}catch(e){console.warn("SSE event ignored: "+e.message)}
        }
      }
    }
  }catch(e){reply.status="error";reply.error=e.message;toast(e.message,"error")}
  finally{
    if(markdownTimer!==null)clearTimeout(markdownTimer);
    renderStream();
    const scroll=$("#chat-scroll"),knownScroll=scroll?.scrollTop;
    const following=scroll&&scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<90;
    state.activeRun=null;state.busy=false;
    try{
      const record=(await api("/api/sessions/"+sid(recordId))).session;
      rememberDraft();
      if(state.session?.id===recordId)state.session=record;
      await Promise.all([loadSessions(),loadHealth()]);
      if(state.view==="chats"&&state.session?.id===recordId){
        renderChats();
        if(!following&&knownScroll!==undefined)$("#chat-scroll").scrollTop=knownScroll;
        else scrollChat();
      }
    }catch(e){toast("Could not verify the saved session: "+e.message,"error")}
    if(state.view==="chats"&&state.session?.id===recordId&&!document.activeElement?.closest("dialog,.popover"))$("#chat-input")?.focus({preventScroll:true});
  }
}
async function cancelRun(){
  const button=$("#chat-send");
  if(button){button.disabled=true;button.textContent="Stopping…"}
  try{await post("/api/agent/cancel",{sessionId:state.session?.id})}
  catch(e){if(button){button.disabled=false;button.textContent="Stop"}toast(e.message,"error")}
}
const permissions=new Map();
function dismissPermission(id){
  const item=permissions.get(id);
  if(!item)return;
  clearTimeout(item.timer);item.dialog.close();item.dialog.remove();permissions.delete(id);
}
function showPermission(event){
  if(permissions.has(event.requestId))return;
  const dialog=document.createElement("dialog");dialog.className="modal permission-modal";
  const title=document.createElement("h2");title.textContent="Tool approval required";
  dialog.setAttribute("aria-label",title.textContent);
  const description=document.createElement("p");description.textContent=event.title||"The agent requested permission to run a tool.";
  dialog.append(title,description);
  if(event.workspace){
    const scope=document.createElement("p");scope.textContent="Workspace · "+event.workspace+(event.outside?.length?". Explicit paths outside workspace · "+event.outside.join(", "):". Review any paths outside this folder.")+" Tools use your Windows permissions.";
    dialog.append(scope);
  }
  if(event.details){const details=document.createElement("pre");details.textContent=event.details;dialog.append(details)}
  const actions=document.createElement("div");actions.className="modal-actions";
  const policy=document.createElement("p");
  policy.textContent="Operation · "+event.category+" · "+(event.policy==="allow"?"Allow eligible reads":"Ask every time");
  dialog.append(policy);
  async function answer(optionId,{remember=false,persistent}={}){
    for(const button of actions.children)button.disabled=true;
    try{await post("/api/agent/permission",{requestId:event.requestId,optionId,remember,persistent});dismissPermission(event.requestId)}
    catch(e){toast(e.message,"error");for(const button of actions.children)button.disabled=false}
  }
  const deny=document.createElement("button");deny.className="btn btn-danger";deny.textContent="Deny";deny.autofocus=true;
  const reject=event.options?.find(choice=>choice.kind==="reject_once");
  deny.onclick=()=>answer(reject?.optionId??null);actions.append(deny);
  if(event.ruleScope){
    const scope=document.createElement("p");
    scope.textContent="Permanent rule scope · "+event.ruleScope+" · "+event.workspace;
    dialog.append(scope);
    const alwaysDeny=document.createElement("button");
    alwaysDeny.className="btn";
    alwaysDeny.textContent="Always deny";
    alwaysDeny.onclick=()=>answer(reject?.optionId??null,{persistent:"deny"});
    actions.append(alwaysDeny);
  }
  for(const choice of event.options||[]){
    if(choice.kind!=="allow_once")continue;
    const button=document.createElement("button");button.className="btn btn-primary";button.textContent="Allow once";
    button.onclick=()=>answer(choice.optionId);actions.append(button);
    if(event.canAlwaysAllow){
      const alwaysAllow=document.createElement("button");
      alwaysAllow.className="btn";
      alwaysAllow.textContent="Always allow";
      alwaysAllow.onclick=()=>answer(choice.optionId,{persistent:"allow"});
      actions.append(alwaysAllow);
    }
    if(event.canRemember){
      const sessionButton=document.createElement("button");sessionButton.className="btn";sessionButton.textContent="Allow this file for the session";
      sessionButton.onclick=()=>answer(choice.optionId,{remember:true});actions.append(sessionButton);
    }
  }
  dialog.addEventListener("cancel",e=>{e.preventDefault();deny.click()});
  dialog.append(actions);$("#dialog-layer").append(dialog);
  permissions.set(event.requestId,{dialog,timer:setTimeout(()=>dismissPermission(event.requestId),Math.max(0,(event.expiresAt||Date.now()+120000)-Date.now()))});
  dialog.showModal();
}

function statusRows(rows){
  return '<div class="status-list">'+rows.map(([label,value])=>'<div class="status-line"><span>'+esc(label)+'</span><span>'+esc(value)+'</span></div>').join("")+'</div>';
}
function card(title,description,content,action=""){
  return '<section class="card"><div class="card-header"><div><h2>'+esc(title)+'</h2><p>'+esc(description)+'</p></div>'+action+'</div><div class="card-content">'+content+'</div></section>';
}
function renderAgents(){
  const h=state.health||{},p=h.preflight||{};
  const result=value=>value===true?"Verified":value===false?"Failed":"Not checked";
  const model=state.session?.mode==="agent"?state.session.model:h.model;
  const connection=card("Backend connections","Connection diagnostics",statusRows([
    ["Goose ACP",h.gooseInitialized?"Session initialized":gooseRuntimeLabel(h.gooseRuntime)],
    ["Ollama",h.ollama?"Connected":"Offline"],["Current model",model||"Unavailable"]]));
  const capabilities=card("Local capabilities","Workspace preflight",statusRows([
    ["File read and write",result(p.filesystem)],["PowerShell",result(p.terminal)],
    ["Command Prompt",result(p.cmd)],["Tool approval","Ask for permission"]]),
    '<button class="btn btn-small" id="run-agent-checks">Recheck</button>');
  const folder=card("Active project folder","Default for new chats",'<div class="codepath">'+esc(p.workspace||"Choose a directory")+'</div>',
    '<button class="btn btn-small" id="agents-folder">Change folder</button>');
  const errors=p.errors?.length?card("Diagnostic errors","Latest workspace preflight","<ul>"+p.errors.map(error=>"<li>"+esc(error)+"</li>").join("")+"</ul>"):"";
  $("#content").innerHTML='<div class="content-scroll"><div class="page-width">'+heading("","Local runtime","Inspect backend connections and check local capabilities.",'<button class="btn btn-primary" id="agent-new">New Agent chat</button>')+
    '<div class="cards cols-2">'+connection+capabilities+folder+errors+'</div></div></div>';
  $("#agent-new").onclick=()=>newSession(undefined,"agent",null);
  $("#agents-folder").onclick=()=>changeView("settings");
  $("#run-agent-checks").onclick=async event=>{
    event.currentTarget.disabled=true;
    try{const diagnostics=await api("/api/diagnostics?probe=1");await loadHealth();if(state.view==="agents")renderAgents();if(!diagnostics.acp?.ok)toast(diagnostics.acp?.error||"Goose ACP check failed","error")}
    catch(e){toast(e.message,"error");if(state.view==="agents")renderAgents()}
  };
}
function renderProjects(){
  $("#content").innerHTML='<div class="content-scroll"><div class="page-width">'+heading("LOCAL FOLDERS","Projects","Manage the folders available to new chats.",'<button class="btn" id="projects-refresh">Refresh</button>')+
    '<section class="card" style="margin-bottom:20px"><div class="card-header"><div><h2>Add a project</h2><p>Enter an absolute Windows folder path</p></div></div><div class="card-content"><div class="field-row"><input id="project-path" class="field" aria-label="Project folder" placeholder="C:\\Users\\…\\Documents\\My Project"><button class="btn btn-primary" id="project-add">Add existing</button><button class="btn" id="project-create">Create folder</button></div><p class="inline-help">New chats use the active folder. Already saved chats retain their own original workspace.</p></div></section>'+
    '<section class="card"><div class="card-header"><div><h2>Registered folders</h2><p>Workspace and saved chat count</p></div></div><div id="project-list">'+(state.projects.length?state.projects.map(p=>
      '<div class="project-row"><span class="project-icon">▣</span><span class="project-desc"><strong>'+esc(p.name)+'</strong><small>'+esc(p.path)+'</small></span><span class="badge '+(p.active?"ok":p.exists?"":"warn")+'">'+(p.active?"Active":p.exists?"Saved":"Missing")+'</span><span class="badge">'+p.sessions+' chats</span>'+(p.active?"":'<button class="btn btn-small" data-activate="'+esc(p.path)+'">Use folder</button><button class="btn btn-small btn-danger" data-remove="'+esc(p.path)+'" title="Remove folder from list">Remove</button>')+'</div>').join(""):'<div class="empty-panel">No folders added yet.</div>')+'</div></section></div></div>';
  const addProject=async create=>{
    const folder=$("#project-path").value.trim();if(!folder)return toast("Enter a directory path","error");
    try{
      await post("/api/projects",{path:folder,create});
      if(create){
        await post("/api/workspace",{workspace:folder});
        state.draftWorkspace=folder;
      }
      await Promise.all([loadHealth(),loadProjects()]);
      renderProjects();toast(create?"Folder created and selected":"Folder added","good");
    }
    catch(e){toast(e.message,"error")}
  };
  $("#project-add").onclick=()=>addProject(false);
  $("#project-create").onclick=()=>addProject(true);
  $("#project-path").onkeydown=e=>{if(e.key==="Enter")$("#project-add").click()};
  $("#projects-refresh").onclick=async()=>{await loadProjects();renderProjects();toast("Projects refreshed")};
  $$("[data-activate]").forEach(b=>b.onclick=async()=>{
    try{await post("/api/workspace",{workspace:b.dataset.activate});state.draftWorkspace=undefined;await Promise.all([loadHealth(),loadProjects()]);renderProjects();toast("Active folder updated","good")}
    catch(e){toast(e.message,"error")}
  });
  $$("[data-remove]").forEach(b=>b.onclick=async()=>{
    try{await api("/api/projects",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({path:b.dataset.remove})});await loadProjects();renderProjects();toast("Removed from project list")}
    catch(e){toast(e.message,"error")}
  });
  $("#project-list").querySelectorAll(".project-row").forEach((row,index)=>{
    const project=state.projects[index];
    if(!project?.exists)return;
    const button=document.createElement("button");button.className="btn btn-small";button.textContent="Git";
    button.setAttribute("aria-label","Git for "+project.name);
    button.onclick=()=>void showGitWorkspace(project.path);
    row.append(button);
  });
}
function renderModels(){
  const d=state.modelData,installed=d?.models||[];
  $("#content").innerHTML='<div class="content-scroll"><div class="page-width">'+heading("OLLAMA","Models","Choose which installed Ollama models appear in the picker.",'<button class="btn" id="models-refresh">Refresh models</button>')+
    '<div class="row-between" style="margin-bottom:14px"><input class="field" id="models-search" style="max-width:380px" placeholder="Search installed models…" aria-label="Search installed models"></div>'+
    '<div class="table-wrap">'+(installed.length?'<table class="table"><thead><tr><th>Model</th><th>Disk size</th><th>Family</th><th>Visible</th><th>Default</th></tr></thead><tbody id="models-body"></tbody></table>':'<div class="empty-panel"><h3>No Ollama models loaded</h3>Start Ollama and refresh the model list.</div>')+'</div>'+
    '<section class="card" style="margin-top:20px"><div class="card-header"><div><h2>Model loading</h2><p>Stored locally in app settings</p></div></div><div class="card-content"><div class="setting-row"><div><strong>Unload previous model</strong><small>Release model memory when switching</small></div><input type="checkbox" class="switch" id="unload-switch" aria-label="Unload previous model" '+(d?.unloadPrevious?"checked":"")+'></div><div class="setting-row"><div><strong>Auto-discover models</strong><small>Refresh installed models as needed</small></div><input type="checkbox" class="switch" id="discover-switch" aria-label="Auto-discover models" '+(d?.autoDiscover?"checked":"")+'></div></div></section></div></div>';
  const body=$("#models-body");
  const draw=()=>{
    if(!body)return;
    const term=$("#models-search").value.toLowerCase();
    body.innerHTML=installed.filter(m=>m.name.toLowerCase().includes(term)).map(m=>
      '<tr><td><strong>'+esc(m.name)+'</strong>'+'</td><td>'+((m.size||0)/1073741824).toFixed(1)+' GB</td><td>'+esc(m.family||"Unknown")+'</td><td><input type="checkbox" class="switch model-visible" data-model="'+esc(m.name)+'" aria-label="Show '+esc(m.name)+'" '+((d.visible||[]).includes(m.name)?"checked":"")+(pendingVisibility.has(m.name)?" disabled":"")+'></td><td><button class="btn btn-small '+(m.name===d.selected?"btn-primary":"")+'" data-choose="'+esc(m.name)+'" '+(m.name===d.selected?"disabled":"")+'>'+(m.name===d.selected?"Selected":"Set default")+'</button></td></tr>').join("");
    $$(".model-visible").forEach(sw=>sw.onchange=async()=>{
      const model=sw.dataset.model;
      if(pendingVisibility.has(model))return;
      const before=d.visible.includes(model),visible=sw.checked;
      const set=value=>{
        const values=new Set(d.visible);
        if(value)values.add(model);else values.delete(model);
        d.visible=[...values];
      };
      set(visible);pendingVisibility.add(model);sw.disabled=true;
      try{await post("/api/models/settings",{visibility:{model,visible}})}
      catch(error){set(before);toast("Could not save visibility: "+error.message,"error")}
      finally{
        pendingVisibility.delete(model);
        const current=[...body.querySelectorAll(".model-visible")].find(item=>item.dataset.model===model);
        if(current){current.checked=d.visible.includes(model);current.disabled=false}
      }
    });
    $$("[data-choose]").forEach(b=>b.onclick=()=>selectModel(b.dataset.choose));
  };
  if(body){draw();$("#models-search").oninput=draw}
  $("#models-refresh").onclick=async()=>{await loadModels(true);if(state.view==="models")renderModels()};
  void mountModelDiagnostics($("#content .page-width"));
  const compatible=installed.map(model=>({value:model.name,label:model.name+" · Ollama"}));
  for(const provider of state.providerData?.providers||[]){
    if(!provider.enabled||provider.cloud&&!provider.keySaved)continue;
    for(const model of new Set([provider.model,...provider.models].filter(Boolean))){
      compatible.push({value:"@provider/"+provider.id+"/"+model,label:model+" · "+provider.name,cloud:provider.cloud});
    }
  }
  void mountCompatibility($("#content .page-width"),compatible);
  for(const [id,key] of [["unload-switch","unloadPrevious"],["discover-switch","autoDiscover"]]){
    const control=$("#"+id);
    control.disabled=!d;
    control.onchange=async()=>{
      const value=control.checked;
      control.disabled=true;
      try{await post("/api/models/settings",{[key]:value});d[key]=value;toast("Settings saved")}
      catch(error){control.checked=!!d?.[key];toast(error.message,"error")}
      finally{control.disabled=false}
    };
  }
}
function renderSettings(){
  const directory=state.health?.preflight?.workspace||"";
  $("#content").innerHTML='<div class="content-scroll"><div class="page-width settings-page">'+heading("","Settings","Manage your local runtime, workspace, and preferences.")+
    '<section class="card" style="margin-bottom:20px"><div class="card-header"><div><h2>Appearance</h2><p>Choose a theme and motion preference</p></div></div><div class="card-content"><div class="tile-grid">'+THEMES.map(t=>
      '<button class="theme-tile '+(document.body.dataset.theme===t[0]?"selected":"")+'" data-theme="'+t[0]+'" aria-pressed="'+(document.body.dataset.theme===t[0])+'"><span class="theme-swatch" style="background:'+t[3]+'"><i style="background:'+t[4]+'"></i><i style="background:'+t[5]+'"><b style="background:'+t[6]+'"></b></i></span><strong>'+t[1]+'</strong><small>'+t[2]+'</small></button>').join("")+'</div><div class="divider"></div><div class="setting-row"><div><strong>Interface animations</strong></div><input class="switch" type="checkbox" id="motion-checkbox" aria-label="Interface animations" '+(document.body.dataset.motion==="on"?"checked":"")+'></div></div></section>'+
    '<section class="card" style="margin-bottom:20px"><div class="card-header"><div><h2>Default project directory</h2><p>Used for newly created chats</p></div></div><div class="card-content"><label class="field-label" for="workspace-path">Windows folder</label><div class="field-row"><input class="field" id="workspace-path" value="'+esc(directory)+'"><button class="btn btn-primary" id="workspace-change">Use folder</button></div><p class="inline-help">Changing this does not move existing chats. Each chat stores its own workspace.</p></div></section>'+
    '<section class="card"><div class="card-header"><div><h2>Runtime diagnostics</h2><p>Local backend and session storage</p></div><button class="btn btn-small" id="settings-check">Run checks</button></div><div class="card-content status-list"><div class="status-line"><span>Goose CLI</span><span class="'+(state.health?.goose?"green":"")+'">'+(state.health?.goose?"Installed":"Missing")+'</span></div><div class="status-line"><span>Ollama endpoint</span><span>'+esc(state.health?.ollamaEndpoint||"Unavailable")+'</span></div><div class="status-line"><span>Filesystem</span><span>'+(state.health?.preflight?.filesystem?"Verified":"Unavailable")+'</span></div><div class="status-line"><span>PowerShell</span><span>'+(state.health?.preflight?.terminal?"Verified":"Unavailable")+'</span></div><div class="status-line"><span>Session storage</span><span>Local files</span></div></div></section></div></div>';
  $$(".theme-tile").forEach(b=>b.onclick=()=>{setTheme(b.dataset.theme);toast("Theme changed","good")});
  $("#motion-checkbox").onchange=e=>{localStorage.setItem(MKEY,e.target.checked?"on":"off");applyTheme()};
  $("#workspace-change").onclick=async()=>{
    try{await post("/api/workspace",{workspace:$("#workspace-path").value.trim()});state.draftWorkspace=undefined;await Promise.all([loadHealth(),loadProjects()]);renderSettings();toast("Default directory saved","good")}
    catch(e){toast(e.message,"error")}
  };
  $("#workspace-path").onkeydown=e=>{if(e.key==="Enter")$("#workspace-change").click()};
  $("#settings-check").onclick=async event=>{
    event.currentTarget.disabled=true;
    try{
      const diagnostics=await api("/api/diagnostics?probe=1");
      await loadHealth();
      if(state.view==="settings")renderSettings();
      toast(diagnostics.acp?.ok?"Goose ACP initialized":diagnostics.acp?.error||"Goose ACP check failed",diagnostics.acp?.ok?"good":"error");
    }catch(e){toast(e.message,"error")}
    finally{if(event.target.isConnected)event.target.disabled=false}
  };
  void mountSettings($("#content .page-width"),async()=>{
    await Promise.all([loadHealth(),loadModels(),loadProjects(),loadSessions()]);
    render();
  },loadModels,loadHealth);
}
function bindEvents(){
  $("#navigation").onclick=e=>{const view=e.target.closest("[data-view]")?.dataset.view;if(view)changeView(view)};
  bindPopovers();
  matchMedia("(max-width: 960px)").addEventListener("change",()=>{if(state.view==="chats"){rememberDraft();renderChats()}});
  $("#mode-trigger").onclick=e=>showModePicker(e.currentTarget);
  $("#new-session").onclick=async()=>{if(await newSession())$("#chat-input")?.focus()};
  let searchTimer;
  $("#session-search").oninput=()=>{
    renderSidebar();clearTimeout(searchTimer);
    const query=$("#session-search").value.toLowerCase().trim();
    if(!query)return;
    searchTimer=setTimeout(async()=>{
      const result=await api("/api/sessions?q="+encodeURIComponent(query)).catch(()=>null);
      if(result&&$("#session-search").value.toLowerCase().trim()===query){
        state.searchQuery=query;state.searchResults=result.sessions;renderSidebar();
      }
    },180);
  };
  $("#session-list").onclick=e=>{
    const action=e.target.closest("[data-action]"),item=e.target.closest("[data-session]");
    if(!action||!item)return;
    if(action.dataset.action==="open")openSession(item.dataset.session);
    if(action.dataset.action==="menu")sessionMenu(action,item.dataset.session);
  };
  $("#model-trigger").onclick=e=>showModelPicker(e.currentTarget);
  $("#theme-trigger").onclick=e=>showThemes(e.currentTarget);
  function toggleSidebar(){
    if(innerWidth<=720)$(".sidebar").classList.toggle("open");
    else $(".shell").classList.toggle("sidebar-collapsed");
  }
  $("#mobile-menu").onclick=toggleSidebar;
  $("#collapse-sidebar").onclick=toggleSidebar;
  document.addEventListener("keydown",e=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();$("#new-session").click()}
  });
  window.addEventListener("storage",e=>{if(e.key===TKEY||e.key===MKEY)applyTheme()});
}
async function importLegacy(){
  const raw=localStorage.getItem("local-agent-history");if(!raw)return;
  try{
    const pairs=JSON.parse(raw);
    if(Array.isArray(pairs)&&pairs.length){
      const result=await post("/api/sessions/import",{pairs});
      if(result.session&&!localStorage.getItem(SKEY))localStorage.setItem(SKEY,result.session.id);
      toast("Older chat messages imported","good");
    }
    localStorage.removeItem("local-agent-history");
  }catch(e){console.warn("Legacy chat will be kept until import succeeds: "+e.message)}
}
async function start(){
  applyTheme();bindEvents();
  void mountPermissions(null,api,post,toast);
  window.addEventListener("wisk-measurements-changed",event=>{if(!event.detail){state.performance=null;updatePerformance()}});
  window.addEventListener("wisk-security-changed",()=>void mountPermissions(null,api,post,toast));
  try{
    await importLegacy();
    await Promise.all([loadHealth(),loadModels(),loadProjects(),loadSessions()]);
    const remembered=localStorage.getItem(SKEY),item=state.sessions.find(s=>s.id===remembered)||(!localStorage.getItem(MODE_KEY)?state.sessions[0]:null);
    if(item)await openSession(item.id,false);
    else{renderTop();renderSidebar()}
    render();
    try{const data=await api("/api/agent/pending");for(const p of data.pending||[])showPermission(p)}catch{}
    const setup=await api("/api/setup");
    if(!setup.configured&&!document.querySelector("dialog[open]")){
      void showSetup(async()=>{await Promise.all([loadHealth(),loadModels(),loadProjects()]);render();},loadHealth).catch(error=>toast(error.message,"error"));
    }else void notifyUpdate(()=>changeView("settings"));
  }catch(e){
    $("#content").innerHTML='<div class="empty-panel" style="padding:110px 20px"><h3>Backend unavailable</h3><p>'+esc(e.message)+'</p><button class="btn btn-primary" id="retry">Retry</button></div>';
    $("#retry").onclick=()=>location.reload();toast("Connection failed: "+e.message,"error");
  }
  let polling=false;
  setInterval(async()=>{
    if(document.visibilityState!=="visible"||state.activeRun||polling)return;
    polling=true;
    try{
      const wasBusy=state.busy;
      await loadHealth();
      if(!wasBusy&&state.busy&&state.view==="chats"){rememberDraft();renderChats()}
      if(wasBusy&&!state.busy){
        if(state.session)await openSession(state.session.id,false);
        else if(state.view==="chats")renderChats();
        await loadSessions();
      }
      if(state.busy){
        const data=await api("/api/agent/pending").catch(()=>null);
        if(data){
          for(const id of permissions.keys())if(!data.pending.some(p=>p.requestId===id))dismissPermission(id);
          for(const p of data.pending)showPermission(p);
        }
      }
    }finally{polling=false}
  },4000);
}
start();
