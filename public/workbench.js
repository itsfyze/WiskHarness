import {highlightedLine} from "./markdown.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const number = value => Number.isFinite(value) ? value.toLocaleString() : "Unavailable";
const time = value => value ? new Date(value).toLocaleString() : "Unavailable";
const gib = value => Number.isFinite(value) ? (value / 1073741824).toFixed(2) + " GiB" : "Unavailable";
const row = (label, value) => '<div class="status-line"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
const button = (id, title, primary = false) => '<button type="button" class="btn '+(primary?"btn-primary":"")+'" id="'+id+'">'+title+'</button>';
const card = (heading, subhead, content) => '<section class="card workbench-card"><div class="card-header"><div><h2>'+heading+'</h2><p>'+subhead+'</p></div></div><div class="card-content">'+content+'</div></section>';

async function request(route, body) {
  const response = await fetch(route, body === undefined ? {cache:"no-store"} : {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
function message(container, value) {
  const line = container.querySelector("[data-status]");
  if (line) line.textContent = value;
}
function modal(title, content) {
  const dialog = document.createElement("dialog");
  dialog.className = "modal workbench-dialog";
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = '<header class="workbench-header"><h2>'+esc(title)+'</h2><form method="dialog"><button class="btn btn-small">Close</button></form></header>'+content;
  document.querySelector("#dialog-layer").append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), {once:true});
  dialog.showModal();
  return dialog;
}
function safeLink(url, label) {
  return '<a class="btn" href="'+esc(url)+'" target="_blank" rel="noreferrer">'+esc(label)+'</a>';
}

function organizeSettings(panel) {
  const sections = [...panel.querySelectorAll(":scope > .card")];
  const layout = document.createElement("div");
  layout.className = "settings-layout";
  const links = document.createElement("nav");
  links.className = "settings-links";
  links.setAttribute("aria-label","Settings sections");
  const stack = document.createElement("div");
  stack.className = "settings-stack";
  layout.append(links,stack);
  panel.append(layout);
  for (const section of sections) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "nav-item";
    link.textContent = section.querySelector("h2").textContent;
    link.onclick = () => {
      section.scrollIntoView({block:"start"});
      section.focus({preventScroll:true});
    };
    section.removeAttribute("style");
    section.tabIndex = -1;
    links.append(link);
    stack.append(section);
  }
}

const internetHelp = "Controls WiskHarness web tools. Shell commands can still use the network, including in Full access.";

export async function mountInternet(target, inSettings=false, running=false) {
  if(!target)return;
  try{
    let data=await request("/api/agent/internet");
    if(!target.isConnected)return;
    const output=document.createElement("span");
    output.className="inline-help";
    output.setAttribute("role","status");
    const toggle=document.createElement("button");
    toggle.type="button";
    toggle.className="btn btn-small internet-toggle";
    toggle.setAttribute("role","switch");
    toggle.setAttribute("aria-label","Internet access");
    toggle.title=internetHelp;
    function draw(){
      toggle.setAttribute("aria-checked",String(data.enabled));
      toggle.textContent="Internet access · "+(data.enabled?"On":"Off");
    }
    toggle.disabled=running;
    async function update(body, action) {
      toggle.disabled=true;
      if(action)action.disabled=true;
      output.textContent="";
      try{
        data=await request("/api/agent/internet",body);
        draw();
        output.textContent=action?"Search settings saved.":data.enabled?"Built-in web tools enabled.":"Built-in web tools disabled.";
      }catch(error){output.textContent=error.message}
      finally {toggle.disabled=running;if(action)action.disabled=false}
    }
    toggle.onclick=()=>void update({enabled:!data.enabled});
    draw();
    target.replaceChildren(toggle);
    if(inSettings){
      const section=document.createElement("div");
      section.innerHTML='<p class="inline-help">'+internetHelp+'</p>'+
        '<label class="field-label" for="agent-search-endpoint">SearXNG search URL (optional)</label>'+
        '<div class="field-row"><input class="field" type="url" id="agent-search-endpoint" maxlength="2048" placeholder="https://your-search-host/search">'+
        '<button class="btn" type="button">Save search URL</button></div>'+
        '<p class="inline-help">GitHub and Wikipedia search work without setup. SearXNG requires JSON output and accepts public HTTPS or explicitly configured loopback HTTP. Page retrieval works independently.</p>';
      section.insertAdjacentHTML("beforeend",'<label class="field-label" for="web-provider">General search service</label><select class="field" id="web-provider"><option value="searxng">SearXNG</option><option value="brave">Brave Search</option></select>'+
        '<label class="field-label" for="brave-key">Brave Search API key</label><input class="field" id="brave-key" type="password" autocomplete="off" placeholder="'+(data.braveConfigured?"Key saved":"Paste a key")+'">'+
        '<div class="workbench-actions"><button class="btn" id="web-save" type="button">Save service</button><button class="btn" id="web-test" type="button">Test search</button></div>');
      const service=section.querySelector("#web-provider"),key=section.querySelector("#brave-key"),search=section.querySelector("#web-test");
      service.value=data.provider;
      section.querySelector("#web-save").onclick=async event=>{
        await update({provider:service.value,key:key.value||undefined},event.currentTarget);
        key.value="";
      };
      search.onclick=async()=>{
        search.disabled=true;
        try{const result=await request("/api/agent/internet/test",{});output.textContent=result.result.split("\n").slice(0,2).join(" · ");}
        catch(error){output.textContent=error.message;}
        finally{search.disabled=false;}
      };
      const input=section.querySelector("input"),save=section.querySelector("button");
      input.value=data.searchEndpoint;
      save.onclick=()=>void update({searchEndpoint:input.value.trim()},save);
      target.append(section);
    }
    target.append(output);
  }catch(error){if(target.isConnected)target.textContent=error.message}
}

const gooseRuntimePanel = () => card("Goose runtime","Optional fallback for Agent mode.",
  '<div data-goose-runtime><p role="status">Looking for Goose…</p></div>');

export function gooseRuntimeLabel(runtime) {
  if (!runtime) return "Checking";
  if (runtime.error) return "Check failed";
  if (!runtime.detected) return "Missing";
  const source = {system:"Installed Goose",portable:"Portable Goose",custom:"Selected executable"}[runtime.source] || "Goose";
  return source + (runtime.version ? " " + runtime.version : " detected");
}

async function mountGooseRuntime(panel, onChanged) {
  const target = panel.querySelector("[data-goose-runtime]");
  try {
    let data = await request("/api/goose-runtime");
    if (!target.isConnected) return;
    const id = panel instanceof HTMLDialogElement ? "setup-goose" : "settings-goose";
    target.innerHTML =
      '<fieldset class="goose-controls"><legend class="sr-only">Goose runtime selection</legend>'+
      '<div class="status-list" data-goose-summary></div>'+
      '<label class="field-label" for="'+id+'-source">Preferred runtime</label>'+
      '<select class="field" id="'+id+'-source"><option value="auto">Automatic</option><option value="system">Installed Goose</option>'+
      '<option value="portable">Portable Goose</option><option value="custom">Choose an executable</option></select>'+
      '<p class="inline-help">Automatic checks installed Goose first, then portable Goose.</p>'+
      '<div data-goose-path hidden><label class="field-label" for="'+id+'-path">Goose executable path</label>'+
      '<input class="field" id="'+id+'-path" placeholder="C:\\Tools\\Goose\\goose.exe" maxlength="1024">'+
      '<p class="inline-help">Saving runs a version and compatibility check on this executable. Choose a file you trust.</p></div>'+
      '<div class="workbench-actions"><button class="btn" type="button" data-goose-save>Save runtime</button>'+
      '<button class="btn" type="button" data-goose-download>Download portable Goose</button></div>'+
      '<div data-goose-confirm hidden><p class="inline-help">Download Goose '+esc(data.release.version)+' from its official GitHub release ('+
      Math.round(data.release.bytes/1000000)+' MB) and store it in this WiskHarness profile.</p>'+
      '<div class="workbench-actions"><button class="btn btn-primary" type="button" data-goose-install>Download and install</button>'+
      '<button class="btn" type="button" data-goose-cancel>Cancel</button></div></div>'+
      '<p class="inline-help" role="status" data-status></p></fieldset>';
    const get = selector => target.querySelector(selector);
    const controls = get("fieldset"), source = get("select"), file = get("input"), confirm = get("[data-goose-confirm]");
    const download = get("[data-goose-download]"), install = get("[data-goose-install]");
    const showPath = () => {get("[data-goose-path]").hidden = source.value !== "custom"};
    function refresh() {
      get("[data-goose-summary]").innerHTML = row("Selected runtime",gooseRuntimeLabel(data))+
        row("Installed Goose",data.systemAvailable?"Detected":"Missing")+
        row("Portable Goose",data.installing?"Downloading…":data.portableAvailable?"Installed":"Available to download");
      source.value = data.preference;
      file.value = data.customPath;
      download.hidden = !data.installSupported;
      download.textContent = data.portableAvailable ? "Reinstall portable Goose" : "Download portable Goose";
      showPath();
    }
    async function act(route, body, pending, done) {
      controls.disabled = true;
      message(target,pending);
      try {
        data = await request(route,body);
        if (!target.isConnected) return;
        refresh();
        confirm.hidden = true;
        message(target,done);
        onChanged?.();
      } catch(error) {message(target,error.message)}
      finally {controls.disabled = false}
    }
    refresh();
    message(target,data.error||"");
    source.onchange = showPath;
    get("[data-goose-save]").onclick = () => act("/api/goose-runtime",{source:source.value,path:file.value.trim()},
      "Checking runtime…","Goose preference saved.");
    download.onclick = () => {confirm.hidden = false; install.focus()};
    get("[data-goose-cancel]").onclick = () => {confirm.hidden = true; download.focus()};
    install.onclick = () => act("/api/goose-runtime/install",{version:data.release.version},
      "Downloading and verifying portable Goose…","Portable Goose installed. To use it explicitly, select it and save.");
  } catch (error) {
    target.querySelector("[role=status]").textContent = error.message;
  }
}

export async function showSetup(onSaved, onGooseChanged) {
  const [setup, models] = await Promise.all([request("/api/setup"),request("/api/models").catch(()=>({models:[]}))]);
  const options = models.models.map(model => '<option value="'+esc(model.name)+'" '+(model.name===setup.model?"selected":"")+'>'+esc(model.name)+'</option>').join("");
  const dialog = modal("Set up WiskHarness", '<p>Choose a workspace and model for new chats. You can complete setup before adding a model.</p>'+
    card("Dependencies","Detected on this PC",'<div class="status-list" id="setup-results">'+row("Windows x64",setup.windows?"Supported":"Unsupported")+row("Ollama models",models.models.length)+'</div>'+
      '<div class="workbench-actions">'+button("setup-check","Run dependency checks")+safeLink("https://ollama.com/download/windows","Get Ollama")+safeLink("https://goose-docs.ai/docs/getting-started/installation/","Get optional Goose runtime")+'</div>')+
    gooseRuntimePanel()+
    '<form id="setup-form"><label class="field-label" for="setup-workspace">Workspace folder</label><input class="field" id="setup-workspace" required value="'+esc(setup.workspace)+'">'+
    '<label class="field-label" for="setup-model">Default model</label><select class="field" id="setup-model"><option value="">Choose later</option>'+options+'</select>'+
    '<label class="field-label" for="setup-vault">Obsidian vault folder (optional)</label><input class="field" id="setup-vault" value="'+esc(setup.vault)+'">'+
    '<p class="inline-help">Agent tools run with your Windows account. Review workspace and approval rules in Security &amp; permissions.</p><p role="status" data-status></p><button class="btn btn-primary">Save setup</button></form>');
  const form = dialog.querySelector("#setup-form");
  void mountGooseRuntime(dialog,onGooseChanged);
  dialog.querySelector("#setup-check").onclick = async event => {
    const control = event.currentTarget;
    control.disabled = true;
    message(dialog,"Checking local dependencies…");
    try {
      const d = await request("/api/diagnostics?probe=1");
      dialog.querySelector("#setup-results").innerHTML = row("Windows x64",d.windows?"Supported":"Unsupported")+
        row("Ollama installation",d.ollamaInstalled?"Found":"Executable unavailable")+
        row("Ollama server",d.ollamaError||("Running · "+d.modelsCount+" models"))+
        row("Goose CLI",gooseRuntimeLabel(d.gooseRuntime))+row("Goose ACP",d.acp?.ok?"Initialized":d.acp?.error||"Unavailable")+
        row("PowerShell",d.checks.terminal?"Verified":"Unavailable")+row("Command Prompt",d.checks.cmd?"Verified":"Unavailable")+
        row("Default workspace",d.checks.filesystem?"Writable":"Unavailable")+row("Storage",d.storageError||"Writable")+
        row("Disk space",gib(d.freeBytes))+row("Obsidian",d.vault);
      const refreshed = await request("/api/models?refresh=1").catch(()=>({models:[]}));
      const select = dialog.querySelector("#setup-model"), selected = select.value;
      select.replaceChildren(new Option("Choose later",""),...refreshed.models.map(model=>new Option(model.name,model.name)));
      select.value = refreshed.models.some(model=>model.name===selected)?selected:"";
      message(dialog,"Dependency checks finished.");
    } catch(error) {message(dialog,error.message)}
    finally {control.disabled=false}
  };
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      await request("/api/setup",{workspace:dialog.querySelector("#setup-workspace").value.trim(),
        model:dialog.querySelector("#setup-model").value,vault:dialog.querySelector("#setup-vault").value.trim()});
      dialog.close();
      await onSaved();
    } catch(error) {message(dialog,error.message)}
  };
}

async function mountOllamaEndpoint(panel,onSaved){
  panel.insertAdjacentHTML("beforeend",card("Ollama server","Model discovery and inference",'<form id="ollama-address-form"><label class="field-label" for="ollama-address">Server address</label><input class="field" id="ollama-address" type="url" required><p class="inline-help">A remote Ollama server receives your chat and tool results. Use a server you trust.</p><label class="terminal-confirm"><input type="checkbox" required> I trust this Ollama server</label><div class="workbench-actions"><button class="btn">Test and save</button></div><p role="status" data-status></p></form>'));
  const form=panel.querySelector("#ollama-address-form");
  const field=form.querySelector("#ollama-address");
  try{
    const info=await request("/api/ollama");
    field.value=info.endpoint;
    if(info.managed){for(const control of form.elements)control.disabled=true;message(form,"Managed by the launch configuration.");}
    form.onsubmit=async event=>{
      event.preventDefault();
      const save=event.submitter;save.disabled=true;
      try{await request("/api/ollama",{endpoint:field.value,confirmed:true});await onSaved();}
      catch(error){message(form,error.message);}
      finally{save.disabled=false;}
    };
  }catch(error){message(form,error.message);}
}

function updateDetails(data) {
  const download=data.download;
  if(data.installing)return "Installing and restarting…";
  if(data.checking)return "Checking for updates…";
  if(download?.state==="running"){
    const percent=Math.floor(100*download.bytes/download.total);
    const mb=value=>(value/1048576).toFixed(1);
    const remaining=mb(download.total-download.bytes)+" MB remaining";
    const speed=download.bytesPerSecond?" · "+mb(download.bytesPerSecond)+" MB/s":"";
    return "Downloading "+percent+"% · "+remaining+speed+
      '<br><progress aria-label="Update download" max="'+download.total+'" value="'+download.bytes+'"></progress>';
  }
  if(download?.state==="verifying")return "Verifying download…";
  if(download?.state==="error")return "Update failed. "+esc(download.error);
  if(data.installError)return (download?.state==="verified"?"Ready to install. ":"Update failed. ")+esc(data.installError);
  if(data.error)return "Update check failed. "+esc(data.error);
  if(download?.state==="verified")return "Ready to install.";
  if(data.available)return data.latest.asset?"Update available.":"A verified download is unavailable for this release.";
  return data.checkedAt?"Up to date.":"Check GitHub for updates.";
}

const toolLabels={read:"File reads",write:"File writes",delete:"File deletion",execute:"Command execution",other:"Other or unidentified tools"};

async function mountSecurity(panel) {
  const target=panel.querySelector("#security-policy");
  const checkbox=(id,label,description,checked)=>'<label class="setting-row" for="'+id+'"><span><strong>'+label+'</strong><small>'+description+'</small></span><input class="switch" type="checkbox" id="'+id+'" '+(checked?"checked":"")+'></label>';
  function draw(data,notice=""){
    if(!target.isConnected)return;
    target.innerHTML='<div class="status-list">'+row("Agent process sandbox","Unavailable")+row("Agent network isolation","Unavailable")+'</div>'+
      '<p class="inline-help">Approved commands run with your Windows account and can read files, launch apps, install packages, and use the network.</p>'+
      '<form id="security-form">'+checkbox("security-scope","Restrict explicit paths","Block structured file requests outside the workspace. Ollama Agent asks before running shell commands when this is on.",data.workspaceOnly)+
      checkbox("security-secrets","Secret protection","Block recognized credential paths in approval requests and redact recognizable values from supported logs.",data.secretProtection)+
      '<h3>Tool permissions</h3><p class="inline-help">Ollama Agent checks every tool request. Goose applies these rules to the approval requests it forwards.</p>'+
      Object.entries(toolLabels).map(([key,label])=>{
        const choices=[["ask","Ask every time"],["deny","Always deny"],...(key==="read"?[["allow","Allow eligible in-workspace reads"]]:[])];
        return '<div class="setting-row security-rule"><label for="tool-'+key+'">'+label+'</label><select class="field" id="tool-'+key+'">'+choices.map(([value,title])=>'<option value="'+value+'" '+(data.toolPolicies[key]===value?"selected":"")+'>'+title+'</option>').join("")+'</select></div>';
      }).join("")+
      '<div class="workbench-actions"><button class="btn btn-primary">Save permissions</button>'+button("security-reset","Reset permissions")+'</div></form>'+
      '<h3>Saved workspace rules</h3><div class="permission-rules">'+
      (data.permissionRules.map(rule=>'<div class="setting-row"><span><strong>'+esc(rule.effect==="allow"?"Always allow":"Always deny")+'</strong><small>'+esc(rule.label)+'</small><small>'+esc(rule.workspace)+'</small></span><div class="workbench-actions"><button class="btn btn-small" data-rule="'+esc(rule.id)+'" data-effect="'+(rule.effect==="deny"?"allow":"deny")+'" '+(rule.effect==="deny"&&!rule.canAllow?"disabled":"")+'>'+(rule.effect==="deny"?"Make allow":"Make deny")+'</button><button class="btn btn-small" data-rule="'+esc(rule.id)+'" data-effect="revoke">Revoke</button></div></div>').join("")||
       '<p class="inline-help">No saved rules.</p>')+'</div><p role="status" data-status>'+esc(notice)+'</p>';
    for(const control of target.querySelectorAll("[data-rule]"))control.onclick=async()=>{
      control.disabled=true;
      try{
        const response=await fetch("/api/security/rules/"+encodeURIComponent(control.dataset.rule),{method:"PATCH",
          headers:{"content-type":"application/json"},body:JSON.stringify({effect:control.dataset.effect})});
        const result=await response.json();
        if(!response.ok)throw new Error(result.error);
        draw(result,control.dataset.effect==="revoke"?"Rule revoked.":"Rule updated.");
      }catch(error){message(target,error.message);control.disabled=false}
    };
    const scope=target.querySelector("#security-scope"),secrets=target.querySelector("#security-secrets");
    target.querySelector("form").onsubmit=async event=>{
      event.preventDefault();
      const lessProtected=data.workspaceOnly&&!scope.checked||data.secretProtection&&!secrets.checked;
      if(lessProtected&&!window.confirm("Reduce these protections? Goose tools run with the current Windows account and may expose files or credentials."))return;
      try{
        draw(await request("/api/security",{workspaceOnly:scope.checked,secretProtection:secrets.checked,confirmed:lessProtected,
          toolPolicies:Object.fromEntries(Object.keys(toolLabels).map(key=>[key,target.querySelector("#tool-"+key).value]))}),"Permissions saved.");
      }catch(error){message(target,error.message)}
    };
    target.querySelector("#security-reset").onclick=async()=>{
      try{
        draw(await request("/api/security",{reset:true}),"Defaults restored. Saved and temporary rules cleared.");
        window.dispatchEvent(new Event("wisk-security-changed"));
      }
      catch(error){message(target,error.message)}
    };
  }
  try{draw(await request("/api/security"))}catch(error){target.textContent=error.message}
}

async function mountProviders(panel,onModelsChanged) {
  const target=panel.querySelector("#provider-settings");
  let data, ollama;
  try{[data,ollama]=await Promise.all([request("/api/providers"),request("/api/models").catch(()=>({models:[]}))])}
  catch(error){target.textContent=error.message;return}
  let selected=data.providers[0]?.id;
  function draw(notice=""){
    if(!target.isConnected)return;
    const provider=data.providers.find(item=>item.id===selected);
    const providerOptions=data.providers.map(item=>new Option(item.name+(item.cloud?" · Cloud":" · Local"),item.id));
    const models=ollama.models.map(model=>[model.name,model.name+" · Ollama"]);
    const planModels=models.concat(data.providers.filter(item=>item.enabled&&(!item.cloud||item.keySaved)).flatMap(item=>
      [...new Set([item.model,...item.models].filter(Boolean))].map(model=>["@provider/"+item.id+"/"+model,model+" · "+item.name])));
    const content='<label class="field-label" for="provider-choice">Provider</label><select class="field" id="provider-choice"></select>'+
      '<form id="provider-form"><div class="status-list">'+row("Connection",provider.connected?"Verified "+time(provider.testedAt):provider.enabled?"Unverified":"Disabled")+
      (provider.error?row("Last error",provider.error):"")+'</div>'+
      '<div class="setting-row"><label for="provider-enabled">Enable '+esc(provider.name)+'</label><input class="switch" type="checkbox" id="provider-enabled" '+(provider.enabled?"checked":"")+'></div>'+
      (provider.cloud?'<p class="inline-help">External inference endpoint · '+esc(provider.base)+'</p>':
        '<label class="field-label" for="provider-endpoint">Local endpoint</label><input class="field" id="provider-endpoint" value="'+esc(provider.base)+'">')+
      (data.credentialStorage?'<label class="field-label" for="provider-key">API key · '+(provider.keySaved?"Saved in Windows protected storage":"None saved")+'</label><input class="field" id="provider-key" type="password" spellcheck="false" autocomplete="new-password" maxlength="2048">':
        '<p class="inline-help">Open the desktop app to manage API keys.</p>')+
      '<label class="field-label" for="provider-model">Default model ID</label><input class="field" id="provider-model" list="provider-model-options" value="'+esc(provider.model)+'"><datalist id="provider-model-options"></datalist>'+
      '<div class="workbench-actions"><button class="btn btn-primary">Save provider</button>'+button("provider-test","Test connection")+
      (provider.keySaved&&data.credentialStorage?button("provider-remove","Remove key"):"")+'</div></form>'+
      '<p class="inline-help">Plan mode supports these providers. Agent mode uses Ollama through Goose.</p>'+
      '<p class="inline-help">For subscription sign-in, use the provider’s official coding client. WiskHarness uses API keys for cloud access.</p>'+
      '<div class="divider"></div><h3>Default models by chat mode</h3>'+
      '<div class="setting-row security-rule"><label for="plan-default">Plan model</label><select class="field" id="plan-default"></select></div>'+
      '<div class="setting-row security-rule"><label for="agent-default">Agent model</label><select class="field" id="agent-default"></select></div>'+
      '<p role="status" data-status>'+esc(notice)+'</p>';
    target.innerHTML=content;
    const choice=target.querySelector("#provider-choice");
    choice.replaceChildren(...providerOptions);choice.value=selected;
    choice.onchange=()=>{selected=choice.value;draw()};
    target.querySelector("datalist").replaceChildren(...provider.models.map(model=>new Option(model,model)));
    for(const [mode,available] of [["plan",planModels],["agent",models]]){
      const select=target.querySelector("#"+mode+"-default");
      const current=data.modeDefaults[mode]||"";
      select.replaceChildren(new Option("Use the Ollama default",""),...available.map(([value,label])=>new Option(label,value)));
      if(current&&!available.some(([value])=>value===current))select.append(new Option("Saved model · unavailable",current));
      select.value=current;
      select.onchange=async()=>{
        select.disabled=true;
        try{
          const updated=await request("/api/model-defaults",{mode,model:select.value||null});
          data.modeDefaults=updated.modeDefaults;
          await onModelsChanged();draw("Default model saved.");
        }catch(error){select.value=current;message(target,error.message)}
        finally{select.disabled=false}
      };
    }
    const submit=async (route,body,status)=>{
      const current=target.querySelector("#provider-form");
      const controls=[choice,...current.querySelectorAll("input,button")];
      controls.forEach(control=>control.disabled=true);
      message(target,status);
      try{
        data=await request(route,body);
        await onModelsChanged();
        draw(route.endsWith("/test")?"Connection check finished.":"Provider settings saved.");
      }catch(error){message(target,error.message)}
      finally{controls.forEach(control=>control.disabled=false)}
    };
    const route="/api/providers/"+provider.id;
    target.querySelector("form").onsubmit=event=>{
      event.preventDefault();
      const keyField=target.querySelector("#provider-key"),key=keyField?.value;
      if(keyField)keyField.value="";
      void submit(route,{enabled:target.querySelector("#provider-enabled").checked,model:target.querySelector("#provider-model").value,
        base:target.querySelector("#provider-endpoint")?.value,key},"Saving provider…");
    };
    target.querySelector("#provider-test").onclick=()=>void submit(route+"/test",{},"Checking connection…");
    const remove=target.querySelector("#provider-remove");
    if(remove)remove.onclick=()=>void submit(route,{enabled:provider.enabled,model:provider.model,base:provider.base,removeKey:true},"Removing API key…");
  }
  draw();
}

function downloadJSON(name, data){
  const link=document.createElement("a");
  link.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+"\n"],{type:"application/json"}));
  link.download=name;link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}

function mountProfile(panel,onSaved){
  const target=panel.querySelector("#profile-actions");
  target.querySelector("#report-preview").onclick=async()=>{
    try{
      const report=await request("/api/diagnostic-report");
      const dialog=modal("Diagnostic report preview",'<p>Review the exact report before saving. It contains runtime versions and status checks.</p><pre class="report-preview"></pre><div class="workbench-actions">'+button("report-save","Save diagnostic report",true)+'</div>');
      dialog.querySelector("pre").textContent=JSON.stringify(report,null,2);
      dialog.querySelector("#report-save").onclick=()=>downloadJSON("WiskHarness diagnostics.json",report);
    }catch(error){message(target,error.message)}
  };
  target.querySelector("#profile-export").onclick=async()=>{
    if(!window.confirm("Save a profile backup? It contains chat text and workspace paths. Store it privately."))return;
    try{
      downloadJSON("WiskHarness profile.json",await request("/api/profile-backup"));
      message(target,"Backup prepared for download.");
    }catch(error){message(target,error.message)}
  };
  const input=target.querySelector("#profile-file");
  input.onchange=async()=>{
    const file=input.files?.[0];input.value="";
    if(!file)return;
    try{
      if(file.size>24*1024*1024)throw new Error("Backup must be smaller than 24 MiB");
      const backup=JSON.parse(await file.text());
      const {preview}=await request("/api/profile-backup",{backup});
      const dialog=modal("Review profile restore",'<p>Restore replaces supported preferences and adds chats. Chats with the same ID stay intact. API keys stay in the local Windows account.</p><div class="status-list">'+
        row("Chats to add",preview.chats)+row("Existing chats to keep",preview.existing)+row("Workspace entries",preview.projects)+
        row("Missing folders",preview.unavailableWorkspaces)+row("Explicit path restrictions",preview.workspaceGuard?"On":"Off")+row("Secret protection",preview.secretProtection?"On":"Off")+
        '</div><div class="workbench-actions">'+button("profile-apply","Restore preferences and chats",true)+'</div><p role="status" data-status></p>');
      dialog.querySelector("#profile-apply").onclick=async event=>{
        const control=event.currentTarget;control.disabled=true;
        try{await request("/api/profile-backup",{backup,confirm:true});dialog.close();await onSaved()}
        catch(error){message(dialog,error.message);control.disabled=false}
      };
    }catch(error){message(target,error.message)}
  };
}

async function mountInstructions(panel){
  const target=panel.querySelector("#agent-instructions");
  try{
    const result=await request("/api/agent-instructions");
    if(!target.isConnected)return;
    target.innerHTML='<p class="inline-help">Project hints in the default workspace · '+esc(result.project.join(", ")||"None found")+'</p>'+
      '<p class="inline-help">Goose loads project hints. App security policy and explicit approvals govern tool use.</p>'+
      '<form><label class="field-label" for="global-instructions">Global Agent instructions</label><textarea rows="4" maxlength="12000" class="field" id="global-instructions"></textarea>'+
      '<div class="workbench-actions"><button class="btn btn-primary">Save instructions</button></div><p role="status" data-status></p></form>';
    target.querySelector("textarea").value=result.global;
    target.querySelector("form").onsubmit=async event=>{
      event.preventDefault();
      try{await request("/api/agent-instructions",{global:target.querySelector("textarea").value});message(target,"Instructions saved.")}
      catch(error){message(target,error.message)}
    };
  }catch(error){target.textContent=error.message}
}

async function mountVault(panel){
  const target=panel.querySelector("#vault-settings");
  try{
    const initial=await request("/api/obsidian");
    target.innerHTML='<form><label class="field-label" for="obsidian-vault">Vault folder</label><div class="field-row"><input class="field" id="obsidian-vault" placeholder="Enter an absolute folder path">'+button("vault-disable","Disable")+'<button class="btn btn-primary">Save</button></div><p role="status" data-status></p></form>';
    const input=target.querySelector("input");
    input.value=initial.vault||"";
    const controls=[...target.querySelectorAll("input,button")];
    if(initial.managed){
      controls.forEach(control=>control.disabled=true);
      return message(target,"This vault is managed by the launch environment.");
    }
    async function save(vault){
      controls.forEach(control=>control.disabled=true);
      try{
        const result=await request("/api/obsidian",{vault});
        input.value=result.vault||"";
        message(target,result.vault?"Vault saved.":"Obsidian checkpoints disabled.");
      }catch(error){message(target,error.message)}
      finally{controls.forEach(control=>control.disabled=false)}
    }
    target.querySelector("form").onsubmit=event=>{event.preventDefault();void save(input.value.trim())};
    target.querySelector("#vault-disable").onclick=()=>void save(null);
  }catch(error){target.textContent=error.message}
}

async function mountExecution(panel,onSaved) {
  const target=panel.querySelector("#agent-execution");
  try{
    const {budget,engine,vibe}=await request("/api/agent/execution");
    if(!target.isConnected)return;
    target.innerHTML='<form><label class="field-label" for="agent-engine">Engine</label><select class="field" id="agent-engine">'+
      '<option value="vibe" '+(vibe?.installed?"":"disabled")+'>Mistral Vibe'+(vibe?.installed?" "+esc(vibe.version):" (unavailable)")+'</option><option value="ollama">Ollama native tools</option><option value="goose">Goose ACP (legacy)</option></select>'+
      [["rounds","Model rounds",2,160],["calls","Tool calls",1,400],["minutes","Time limit in minutes",1,90],["recovery","Recovery attempts without progress",2,15],["context","Maximum context tokens",4096,131072]].map(([key,label,min,max])=>
        '<label class="field-label" for="agent-budget-'+key+'">'+label+'</label><input class="field" type="number" id="agent-budget-'+key+'" min="'+min+'" max="'+max+'" value="'+budget[key]+'" required>').join("")+
      '<p class="inline-help">Vibe and Ollama enforce these limits. Goose uses the time limit and manages its model and tool limits.</p><p role="status" data-status></p><button class="btn btn-primary">Save execution settings</button></form>';
    target.querySelector("#agent-engine").value=engine;
    const form=target.querySelector("form");
    form.onsubmit=async event=>{
      event.preventDefault();
      const button=form.querySelector("button");button.disabled=true;
      try{
        await request("/api/agent/execution",{engine:form.querySelector("#agent-engine").value,budget:
          Object.fromEntries(["rounds","calls","minutes","recovery","context"].map(key=>[key,form.querySelector("#agent-budget-"+key).valueAsNumber]))});
        await onSaved();
      }catch(error){message(target,error.message)}
      finally{button.disabled=false}
    };
  }catch(error){target.textContent=error.message}
}

export async function mountSettings(panel, onSaved, onModelsChanged, onGooseChanged) {
  if (!panel) return;
  panel.querySelector(".page-heading-row").insertAdjacentHTML("afterend",
    card("Agent execution","Engine and per-turn limits",'<div id="agent-execution">Loading execution settings…</div>')+
    gooseRuntimePanel()+
    card("Agent internet access","Public page retrieval and search",'<div data-internet-settings>Loading Internet access…</div>')+
    card("Security & permissions","Agent approvals and local data protection",'<div id="security-policy">Loading permissions…</div>')+
    card("Providers & models","Local endpoints and API access",'<div id="provider-settings">Loading providers…</div>')+
    card("Setup and diagnostics","Local dependencies, workspace and optional memory",button("open-setup","Open setup"))+
    card("Obsidian","Optional checkpoints for Agent work",'<div id="vault-settings">Loading Obsidian settings…</div>'));
  void mountVault(panel);
  void mountOllamaEndpoint(panel,onSaved);
  void mountExecution(panel,onSaved);
  panel.querySelector("#open-setup").onclick = () => void showSetup(onSaved,onGooseChanged);
  void mountGooseRuntime(panel,onGooseChanged);
  void mountInternet(panel.querySelector("[data-internet-settings]"),true);
  void mountSecurity(panel);
  void mountProviders(panel,onModelsChanged);
  panel.insertAdjacentHTML("beforeend",
    card("Agent instructions","Global preferences and workspace hints",'<div id="agent-instructions">Loading instructions…</div>')+
    card("Diagnostics and backup","Export a report or move your profile to another installation",'<div id="profile-actions"><div class="workbench-actions">'+
      button("report-preview","Preview diagnostic report")+button("profile-export","Export profile backup")+'</div>'+
      '<p class="inline-help">Backups include chat text and supported preferences. Windows API keys, terminal logs, file snapshots and Goose native state are excluded.</p>'+
      '<label class="field-label" for="profile-file">Restore from a WiskHarness profile backup</label><input class="field" type="file" id="profile-file" accept=".json,application/json"><p role="status" data-status></p></div>'));
  mountProfile(panel,onSaved);
  void mountInstructions(panel);
  panel.insertAdjacentHTML("beforeend",card("Updates","Official GitHub releases",'<div id="update-settings" class="status-list">Loading update settings…</div>')+
    card("Connections","Remote access is unavailable in v0.7.",button("connection-check","Check Tailscale")+'<p role="status" id="connections-result">Connection status has not been checked.</p>'));
  panel.querySelector("#connection-check").onclick = async () => {
    const output=panel.querySelector("#connections-result");
    output.textContent="Checking…";
    try {const d=await request("/api/diagnostics");output.textContent=d.tailscaleInstalled?"Tailscale · "+d.tailscale:"Tailscale was not found."}
    catch(error){output.textContent=error.message}
  };
  organizeSettings(panel);
  const target=panel.querySelector("#update-settings");
  async function draw(data) {
    if (!target.isConnected) return;
    const working=data.installing||["running","verifying"].includes(data.download?.state);
    const ready=data.available&&data.download?.state==="verified"&&data.download.version===data.latest?.version;
    const canUpdate=data.desktopUpdates&&data.available&&data.latest?.asset&&!working;
    target.innerHTML=row("Installed version",data.version)+row("Latest eligible release",data.latest?.version||"Unavailable")+
      row("Last successful check",time(data.lastSuccessfulCheck))+
      '<div class="setting-row"><label for="update-auto">Check automatically</label><input class="switch" type="checkbox" id="update-auto" '+(data.automatic?"checked":"")+'></div>'+
      '<div class="setting-row"><label for="update-channel">Release channel</label><select class="field" id="update-channel"><option value="stable">Stable</option><option value="beta" '+(data.channel==="beta"?"selected":"")+'>Beta</option></select></div>'+
      '<div class="workbench-actions">'+(working?"":button("update-check",data.error?"Retry check":"Check now"))+(data.available?safeLink(data.latest.notes,"View changelog"):"")+
      (canUpdate?(ready?button("update-install","Install and restart",true):button("update-download",data.download?.state==="error"||data.installError?"Retry update":"Update",true)):"")+
      '</div><p role="status" data-status>'+updateDetails(data)+'</p>'+
      (data.available&&data.latest.summary?'<details><summary>Release notes</summary><p style="white-space:pre-wrap">'+esc(data.latest.summary)+'</p></details>':"");
    for(const id of ["#update-auto","#update-channel"])target.querySelector(id).disabled=working;
    const settings = () => request("/api/updates/preferences",{automatic:target.querySelector("#update-auto").checked,channel:target.querySelector("#update-channel").value})
      .then(draw).catch(error=>message(target,error.message));
    target.querySelector("#update-auto").onchange=settings;
    target.querySelector("#update-channel").onchange=settings;
    const check=target.querySelector("#update-check");
    if(check)check.onclick=async event=>{
      event.currentTarget.disabled=true;
      message(target,"Checking GitHub…");
      try {await draw(await request("/api/updates/check",{}))}
      catch(error) {message(target,error.message)}
    };
    for(const action of ["download","install"]){
      const control=target.querySelector("#update-"+action);
      if(control)control.onclick=async()=>{
        control.disabled=true;
        try{await draw(await request("/api/updates/"+action,{}))}
        catch(error){message(target,error.message);control.disabled=false}
      };
    }
    if(working||data.checking){
      setTimeout(async()=>{if(target.isConnected)try{await draw(await request("/api/updates"))}catch(error){message(target,error.message)}},650);
    }
  }
  try {await draw(await request("/api/updates"))} catch(error){target.textContent=error.message}
}

export async function notifyUpdate(onSettings) {
  const setup = await request("/api/setup").catch(()=>null);
  if (!setup?.configured) return;
  for (let attempt=0;attempt<6;attempt++) {
    const data=await request("/api/updates").catch(()=>null);
    if (!data || !data.automatic) return;
    if (data.available && sessionStorage.getItem("wisk-remind")!==data.latest.version) {
      if (document.querySelector("dialog[open]")) return;
      const dialog=modal("WiskHarness update available",row("Installed",data.version)+row("Available",data.latest.version)+
        '<div class="workbench-actions">'+safeLink(data.latest.notes,"View changelog")+button("wisk-update-open","View update",true)+button("wisk-remind","Remind me later")+'</div>');
      dialog.querySelector("#wisk-update-open").onclick=()=>{dialog.close();onSettings()};
      dialog.querySelector("#wisk-remind").onclick=()=>{sessionStorage.setItem("wisk-remind",data.latest.version);dialog.close()};
      return;
    }
    if (data.checkedAt||data.error) return;
    await new Promise(resolve=>setTimeout(resolve,1800));
  }
}

export async function mountModelDiagnostics(panel) {
  if (!panel) return;
  panel.querySelector(".page-heading-row").insertAdjacentHTML("afterend",
    card("Model diagnostics","Latest measured turn",'<div id="model-diagnostics">Loading measurements…</div>'));
  const container=panel.querySelector("#model-diagnostics");
  try {
    const result=await request("/api/models/diagnostics");
    const stats=result.metrics;
    container.innerHTML='<div class="status-list">'+row("Selected model",result.selected||"Choose a model")+
      row("Last measured model",stats?.model||"Generate a Plan response")+
      row("Input tokens",number(stats?.prompt_eval_count))+row("Output tokens",number(stats?.eval_count))+
      row("Generation speed",stats?.tokensPerSecond?stats.tokensPerSecond.toFixed(2)+" tokens/s":"Unavailable")+
      row("Prompt duration",stats?.prompt_eval_duration?(stats.prompt_eval_duration/1e6).toFixed(1)+" ms":"Unavailable")+
      row("Generation duration",stats?.eval_duration?(stats.eval_duration/1e6).toFixed(1)+" ms":"Unavailable")+'</div>'+
      (result.loaded.length?'<div class="table-wrap"><table class="table"><thead><tr><th>Loaded model</th><th>Context</th><th>Model memory</th><th>VRAM</th></tr></thead><tbody>'+
      result.loaded.map(m=>'<tr><td>'+esc(m.name)+'</td><td>'+number(m.context)+'</td><td>'+gib(m.size)+'</td><td>'+gib(m.vram)+'</td></tr>').join("")+'</tbody></table></div>':'<p>'+esc(result.ollamaError||"No Ollama models currently loaded.")+'</p>')+
      '<div class="field-row"><label for="model-context">Requested context</label><select class="field" id="model-context">'+
      [[0,"Runtime default"],[16384,"16K"],[32768,"32K"],[65536,"64K"],[131072,"128K"]].map(([n,label])=>'<option value="'+n+'" '+((result.contextTokens||0)===n?"selected":"")+'>'+label+'</option>').join("")+
      '</select>'+button("context-save","Save context")+'</div><p class="inline-help">Your model and runtime may cap this setting.</p>'+
      '<div class="setting-row"><label for="usage-measurements">Keep latest usage measurements in memory</label><input class="switch" type="checkbox" id="usage-measurements" '+(result.usageMeasurements?"checked":"")+'></div>'+
      '<div class="status-list">'+row("System RAM in use",result.systemMemory?gib(result.systemMemory.used)+" / "+gib(result.systemMemory.total):"Unavailable")+'</div><p role="status" data-status></p>';
    container.querySelector("#usage-measurements").onchange=async event=>{
      const control=event.currentTarget;
      control.disabled=true;
      try{await request("/api/models/measurements",{enabled:control.checked});message(container,"Usage measurement preference saved.");
        window.dispatchEvent(new CustomEvent("wisk-measurements-changed",{detail:control.checked}));}
      catch(error){control.checked=!control.checked;message(container,error.message)}
      finally{control.disabled=false}
    };
    container.querySelector("#context-save").onclick=async()=>{
      try{await request("/api/models/context",{contextTokens:Number(container.querySelector("#model-context").value)||null});message(container,"Context preference saved.")}
      catch(error){message(container,error.message)}
    };
  } catch(error) {container.textContent=error.message}
}

export async function mountCompatibility(panel, available) {
  panel.insertAdjacentHTML("beforeend",card("Model compatibility","Synthetic Plan-mode prompts",'<form id="compatibility-form"><label class="field-label" for="compatibility-model">Model to test</label><select class="field" id="compatibility-model"></select>'+
    '<div class="workbench-actions"><button class="btn btn-primary">Test model compatibility</button></div><div class="status-list" data-results></div><p role="status" data-status></p></form>'));
  const form=panel.querySelector("#compatibility-form"), select=form.querySelector("select");
  select.replaceChildren(...available.map(({value,label})=>new Option(label,value)));
  form.querySelector("button").disabled=!available.length;
  const names={response:"Basic response",streaming:"Streaming",memory:"Multi-turn recall",toolFormat:"Tool call format",toolExecution:"Tool execution",structured:"Structured output",recovery:"Error recovery"};
  let results=[];
  function draw(){
    const result=results.find(item=>item.model===select.value);
    form.querySelector("[data-results]").innerHTML=result?row("Historical result",time(result.testedAt))+Object.entries(names).map(([id,label])=>row(label,result.checks[id])).join("")+(result.error?row("Error",result.error):""):
      '<p class="inline-help">'+(available.length?"No saved result for this model.":"Configure a provider or install an Ollama model.")+'</p>';
  }
  select.onchange=draw;
  form.onsubmit=async event=>{
    event.preventDefault();
    const model=select.value;
    if(!model)return;
    const cloud=available.find(item=>item.value===model)?.cloud;
    if(cloud&&!window.confirm("Send up to two synthetic prompts to the cloud provider? These requests may incur API charges."))return;
    const control=form.querySelector("button");control.disabled=true;select.disabled=true;
    message(form,"Running compatibility checks…");
    try{
      const {result}=await request("/api/model-compatibility",{model,confirmed:!!cloud});
      results=[result,...results.filter(item=>item.model!==model)];
      draw();message(form,"Compatibility check complete.");
    }catch(error){message(form,error.message)}
    finally{control.disabled=false;select.disabled=false}
  };
  try{results=(await request("/api/model-compatibility")).results;draw()}
  catch(error){message(form,error.message)}
}

export async function showGitWorkspace(workspace){
  const dialog=modal("Git workspace",'<p class="codepath"></p><div data-git-body></div><p role="status" data-status>Reading repository…</p>');
  dialog.querySelector(".codepath").textContent=workspace;
  const target=dialog.querySelector("[data-git-body]");
  const git=(action,input={})=>request("/api/projects/git",{workspace,action,...input});
  const conflicts=new Set(["DD","AU","UD","UA","DU","AA","UU"]);
  async function draw(){
    try{
      const state=await git("status");
      if(!state.repository){message(dialog,"This workspace is outside a Git repository.");return}
      target.innerHTML='<div class="status-list">'+row("Branch",state.branch)+row("Recent commits",state.commits.join(" · ")||"None")+
        row("Merge conflicts",state.files.filter(item=>conflicts.has(item.state)).length)+'</div>'+
        '<ul class="git-files">'+state.files.map((item,index)=>'<li><span><strong>'+esc(item.name)+'</strong><small>'+esc(item.state)+'</small></span><div class="workbench-actions">'+
          button("git-view-"+index,"Diff")+(item.state[0]!==" "&&item.state[0]!=="?"?button("git-unstage-"+index,"Unstage"):"")+
          (item.state[1]!==" "?button("git-stage-"+index,"Stage"):"")+'</div></li>').join("")+'</ul>'+
        (state.truncated?'<p>Showing the first 300 changes.</p>':"")+
        '<pre class="report-preview" hidden></pre><div class="workbench-actions">'+button("git-refresh","Refresh")+
        button("git-commit","Review staged changes")+'</div>';
      message(dialog,state.files.length?"":"No changes to show.");
      target.querySelector("#git-refresh").onclick=()=>void draw();
      for(const [index,item] of state.files.entries()){
        target.querySelector("#git-view-"+index).onclick=async()=>{
          try{
            const staged=item.state[0]!==" "&&item.state[0]!=="?";
            const results=await Promise.all([git("diff",{name:item.name}),...(staged?[git("diff",{name:item.name,staged:true})]:[])]);
            const output=target.querySelector("pre");output.hidden=false;
            output.textContent=results.map((result,i)=>(i?"Staged\n":"Working tree\n")+(result.patch||"No tracked diff available")+(result.truncated?"\nDiff truncated.":"")).join("\n\n");
            output.scrollIntoView({block:"nearest"});
          }catch(error){message(dialog,error.message)}
        };
        for(const action of ["stage","unstage"]){
          const control=target.querySelector("#git-"+action+"-"+index);
          if(control)control.onclick=async()=>{
            control.disabled=true;
            try{await git(action,{name:item.name,confirmed:true});await draw()}
            catch(error){message(dialog,error.message);control.disabled=false}
          };
        }
      }
      target.querySelector("#git-commit").onclick=async()=>{
        try{
          const preview=await git("commit-preview");
          const review=modal("Commit staged changes",'<p>This commits every file listed below using your Git identity. WiskHarness creates an unsigned commit without running repository hooks.</p><pre class="report-preview"></pre>'+
            '<form id="git-commit-form"><label class="field-label" for="git-message">Commit message</label><input class="field" id="git-message" required maxlength="500"><div class="workbench-actions"><button class="btn btn-primary">Create commit</button></div><p role="status" data-status></p></form>');
          review.querySelector("pre").textContent=preview.names.join("\n");
          review.querySelector("#git-commit-form").onsubmit=async event=>{
            event.preventDefault();
            const control=review.querySelector("#git-commit-form button");control.disabled=true;
            try{
              const result=await git("commit",{fingerprint:preview.fingerprint,confirmed:true,message:review.querySelector("input").value});
              review.close();await draw();message(dialog,"Created commit "+result.commit+".");
            }catch(error){message(review,error.message);control.disabled=false}
          };
        }catch(error){message(dialog,error.message)}
      };
    }catch(error){message(dialog,error.message)}
  }
  await draw();
}


function lineDiff(before, after) {
  const a = before === null ? [] : before.split(/\r?\n/);
  const b = after === null ? [] : after.split(/\r?\n/);
  if (a.length * b.length > 160000) return null;
  const cells = Array.from({length:a.length+1}, () => new Uint16Array(b.length+1));
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--){
    cells[i][j]=a[i]===b[j]?1+cells[i+1][j+1]:Math.max(cells[i+1][j],cells[i][j+1]);
  }
  const rows=[];
  let i=0,j=0;
  while(i<a.length||j<b.length){
    if(i<a.length&&j<b.length&&a[i]===b[j]){rows.push([" ",a[i]]);i++;j++}
    else if(j===b.length||i<a.length&&cells[i+1][j]>=cells[i][j+1])rows.push(["−",a[i++]]);
    else rows.push(["+",b[j++]]);
  }
  return rows;
}

function showTask(session, onResume) {
  const task = session.task;
  const actions = task?.actions || [], plan = task?.plan || [];
  const status = task?.status || session.status;
  const resumable = ["interrupted","cancelled","error"].includes(status) && task?.description;
  const dialog=modal("Task checklist", task ? '<p>'+esc(task.description)+'</p><div class="status-list">'+row("Task status",status)+
    row("Last checkpoint",time(task.checkpointAt))+row("Verification",task.verification)+
    row("Changed files",task.modified?.join(", ")||"None captured")+'</div>'+
    (plan.length?'<h3>Agent plan</h3><div class="status-list">'+plan.map(step=>row(step.title,step.status)).join("")+'</div>':'')+
    '<h3>Observed actions</h3>'+(actions.length?'<div class="status-list">'+actions.map(action=>row(action.title,action.status)).join("")+'</div>':'<p>No tool events have been captured.</p>')+
    (resumable?'<p>Review the checkpoint before sending a new prompt. No earlier commands will replay automatically.</p>'+button("resume-task","Prepare resume",true):""):'<p>Run an Agent task to start a checklist.</p>');
  if(resumable)dialog.querySelector("#resume-task").onclick=()=>{
    dialog.close();
    const summary=actions.slice(-12).map(action=>action.status+" · "+action.title).join("\n");
    onResume("Resume this interrupted task after inspecting the current workspace. Verify what already ran. Ask before repeating any write or command whose outcome is uncertain.\n\nOriginal task: "+task.description+"\n\nSaved tool events:\n"+(summary||"None captured."));
  };
}

function showReview(initial, onSaved, changeId) {
  const base="/api/sessions/"+encodeURIComponent(initial.id);
  let session=initial;
  const dialog=modal("File changes",'<p>These are observed workspace changes. Agent edits are already applied.</p><section id="review-body"></section><p role="status" data-status></p>');
  const body=dialog.querySelector("#review-body");
  function draw(selected=0) {
    const review=session.review,changes=review?.changes||[];
    if(!changes.length){body.textContent=review?.limited?"No changes captured within the snapshot limits.":"No file changes have been captured for this task.";return}
    const item=changes[selected];
    const before=item.before?.text??null,after=item.after?.text??null;
    const diff=lineDiff(before,after);
    const added=diff?.filter(([sign])=>sign==="+").length;
    const removed=diff?.filter(([sign])=>sign==="−").length;
    body.innerHTML='<label class="field-label" for="change-select">Changed file</label><select class="field" id="change-select">'+changes.map((file,index)=>
      '<option value="'+index+'" '+(index===selected?"selected":"")+'>'+esc(file.name+" · "+file.kind+" · "+file.disposition)+'</option>').join("")+'</select>'+
      (review.limited?'<p>Snapshot coverage is limited by file count, size, type, and excluded folders.</p>':'')+
      '<div class="review-switch"><span>'+esc(item.origin==="agent"?"Agent change":"Workspace change")+(item.binary?" · Binary":item.large?" · Large file":diff?" · +"+added+" / −"+removed:"")+'</span>'+
      '<div class="diff-actions"><button class="btn btn-small" type="button" data-prev>Previous change</button><button class="btn btn-small" type="button" data-next>Next change</button><button class="btn btn-small" type="button" data-layout>Side by side</button></div></div><div data-diff></div>'+
      '<div class="workbench-actions">'+button("change-copy","Copy path")+
      (item.after?button("change-open","Open in editor"):"")+(item.after?button("change-reveal","Reveal in Explorer"):"")+'</div>'+
      (item.disposition==="applied"?'<div class="workbench-actions">'+button("change-keep","Keep change")+
        (item.reversible!==false&&["modified","added"].includes(item.kind)?button("change-revert","Revert change"):"")+'</div>':'');
    body.querySelector("#change-select").onchange=event=>draw(Number(event.target.value));
    const code=body.querySelector("[data-diff]");
    const layout=body.querySelector("[data-layout]");
    let side=false,position=-1;
    const fileExt=item.name.split(".").pop().toLowerCase();
    const language=({py:"python",js:"javascript",mjs:"javascript",cjs:"javascript",ts:"typescript",tsx:"typescript",cs:"csharp",
      html:"xml",md:"markdown",rs:"rust",cpp:"cpp",ps1:"powershell",yml:"yaml"})[fileExt]||fileExt;
    function renderDiff(){
      layout.textContent=side?"Unified":"Side by side";
      if(!diff||item.binary||item.large){
        for(const button of body.querySelectorAll(".diff-actions button"))button.hidden=true;
        code.textContent=item.binary?"Binary file preview unavailable.":"Line diff unavailable for this file size.";
        return;
      }
      let left=0,right=0;
      code.className=side?"diff-grid split":"diff-grid";
      position=-1;
      const rows=diff.map(([sign,line])=>{
        const a=sign==="+"?"":++left,b=sign==="−"?"":++right;
        const kind=sign==="+"?"diff-add":sign==="−"?"diff-remove":"";
        const source=(diff.length<=1000?highlightedLine(line,language):null)??esc(line);
        if(side)return '<div class="diff-line '+(sign===" "?"":"diff-changed")+'"><span class="'+(a?kind:"")+'"><b>'+a+'</b><code>'+(a?source:"")+'</code></span><span class="'+(b?kind:"")+'"><b>'+b+'</b><code>'+(b?source:"")+'</code></span></div>';
        return '<div class="diff-line '+kind+(sign===" "?"":" diff-changed")+'"><b>'+a+'</b><b>'+b+'</b><strong>'+sign+'</strong><code>'+source+'</code></div>';
      });
      let html="";
      for(let i=0;i<rows.length;){
        if(diff[i][0]!==" "){html+=rows[i++];continue}
        const start=i;
        while(i<rows.length&&diff[i][0]===" ")i++;
        if(i-start>8)html+=rows.slice(start,start+2).join("")+'<details class="diff-fold"><summary>Show '+(i-start-4)+' unchanged lines</summary>'+rows.slice(start+2,i-2).join("")+'</details>'+rows.slice(i-2,i).join("");
        else html+=rows.slice(start,i).join("");
      }
      code.innerHTML=html;
    }
    function navigate(step){
      const changes=[...code.querySelectorAll(".diff-changed")];
      if(!changes.length)return;
      position=position===-1&&step===-1?changes.length-1:(position+step+changes.length)%changes.length;
      for(const line of changes)line.classList.remove("current-change");
      changes[position].classList.add("current-change");
      changes[position].scrollIntoView({block:"nearest"});
    }
    body.querySelector("[data-prev]").onclick=()=>navigate(-1);
    body.querySelector("[data-next]").onclick=()=>navigate(1);
    layout.onclick=()=>{side=!side;renderDiff()};
    renderDiff();
    body.querySelector("#change-copy").onclick=()=>void navigator.clipboard.writeText(session.workspace+"\\"+item.name).catch(error=>message(dialog,error.message));
    for(const [id,action] of [["change-open","editor"],["change-reveal","reveal"]]){
      const button=body.querySelector("#"+id);
      if(button)button.onclick=()=>void request(base+"/files/open",{path:item.name,action,confirmed:true}).catch(error=>message(dialog,error.message));
    }
    async function change(action) {
      const confirmed=action==="revert"&&window.confirm("Restore the captured before-state of "+item.name+"? WiskHarness will check for later edits first.");
      if(action==="revert"&&!confirmed)return;
      try{
        const result=await request(base+"/review/"+item.id,{action,confirmed});
        session.review.changes[selected]=result.change;
        draw(selected);
        message(dialog,action==="revert"?"Snapshot restored and verified.":"Change marked as kept.");
        await onSaved();
      }catch(error){message(dialog,error.message)}
    }
    const keep=body.querySelector("#change-keep"),revert=body.querySelector("#change-revert");
    if(keep)keep.onclick=()=>change("accept");
    if(revert)revert.onclick=()=>change("revert");
  }
  draw(Math.max(0,(session.review?.changes||[]).findIndex(item=>item.id===changeId)));
}

function showTerminal(session, target) {
  const base="/api/sessions/"+encodeURIComponent(session.id)+"/terminal";
  const content='<p class="codepath">'+esc(session.workspace)+'</p>'+
    '<form id="terminal-form"><label class="field-label" for="terminal-shell">Shell</label><select class="field" id="terminal-shell"><option value="powershell">PowerShell</option><option value="cmd">Command Prompt</option></select>'+
    '<label class="field-label" for="terminal-command">Command</label><textarea class="field" id="terminal-command" rows="2" maxlength="8000" required></textarea>'+
    '<label class="terminal-confirm"><input id="terminal-confirm" type="checkbox" required> I reviewed this command. It runs with my Windows permissions.</label>'+
    '<div class="workbench-actions"><button class="btn btn-primary" id="terminal-run">Run command</button>'+button("terminal-stop","Stop")+'</div></form>'+
    '<label class="field-label" for="terminal-history">Command history</label><select class="field" id="terminal-history"></select>'+
    '<details class="terminal-output" open><summary>User terminal</summary><pre id="terminal-output" tabindex="0"></pre>'+button("terminal-copy","Copy output")+'</details><p role="status" data-status></p>';
  const dialog=target||modal("Terminal",content);
  if(target)target.innerHTML=content;
  const visible=()=>target?target.isConnected&&form.isConnected:dialog.open;
  const form=dialog.querySelector("#terminal-form"),history=dialog.querySelector("#terminal-history"), output=dialog.querySelector("#terminal-output");
  const stop=dialog.querySelector("#terminal-stop"),runButton=dialog.querySelector("#terminal-run");
  let records=[],selected="",running=null,timer;
  function show() {
    const run=records.find(item=>item.id===selected);
    const follow=output.scrollHeight-output.clientHeight-output.scrollTop<40;
    output.textContent=run?.chunks?.map(chunk=>(chunk.stream==="stderr"?"[stderr] ":"")+chunk.text).join("")||"";
    if(follow)output.scrollTop=output.scrollHeight;
    message(dialog,run ? [run.state,run.code===null?"":"Exit "+run.code,run.error,run.persistenceError,run.truncated?"Output limit reached.":""].filter(Boolean).join(" · ") : "No commands yet.");
    stop.disabled=!running;
    runButton.disabled=!!running;
  }
  async function read() {
    if(!visible())return;
    clearTimeout(timer);
    try{
      const {history:saved,running:active}=await request(base);
      if(!visible())return;
      running=active;
      records=active?[...saved.filter(item=>item.id!==active.id),active]:saved;
      if(!records.some(item=>item.id===selected))selected=records.at(-1)?.id||"";
      const options=records.map(item=>new Option(item.shell+" · "+item.command.slice(0,115),item.id));
      history.replaceChildren(...options.reverse());history.value=selected;
      show();
    }catch(error){message(dialog,error.message)}
    if(visible()&&running)timer=setTimeout(read,450);
  }
  history.onchange=()=>{selected=history.value;show()};
  form.onsubmit=async event=>{
    event.preventDefault();
    runButton.disabled=true;
    try{
      const {run}=await request(base,{shell:dialog.querySelector("#terminal-shell").value,
        command:dialog.querySelector("#terminal-command").value,confirmed:dialog.querySelector("#terminal-confirm").checked});
      selected=run.id;
      dialog.querySelector("#terminal-confirm").checked=false;
      await read();
    }catch(error){message(dialog,error.message);runButton.disabled=false}
  };
  stop.onclick=async()=>{
    try{
      const result=await request(base+"/stop",{});
      if(!result.treeTerminationConfirmed)message(dialog,"Windows could not confirm termination.");
      await read();
    }catch(error){message(dialog,error.message)}
  };
  dialog.querySelector("#terminal-copy").onclick=async()=>{
    try{await navigator.clipboard.writeText(output.textContent);message(dialog,"Output copied.")}
    catch(error){message(dialog,error.message)}
  };
  dialog.addEventListener("close",()=>clearTimeout(timer),{once:true});
  void read();
}

export function mountAgentTools(panel, session, onResume, onSaved) {
  if(!panel||session?.mode!=="agent")return;
  panel.insertAdjacentHTML("afterbegin",'<section class="inspector-group"><h2 class="inspector-label">Task and tools</h2>'+
    '<div class="workbench-actions">'+button("agent-task","Checklist")+button("agent-terminal","Terminal")+button("agent-review","File changes")+'</div></section>');
  panel.querySelector("#agent-task").onclick=()=>showTask(session,onResume);
  panel.querySelector("#agent-terminal").onclick=()=>showTerminal(session);
  panel.querySelector("#agent-review").onclick=()=>showReview(session,onSaved);
}



export function mountDevelopment(panel, session, onSaved) {
  if(!panel||session?.mode!=="agent")return null;
  const base="/api/sessions/"+encodeURIComponent(session.id);
  const tabs=[["changes","Changes"],["files","Files"],["terminal","Terminal"],["progress","Progress"]];
  panel.innerHTML='<div class="development-tabs" role="tablist" aria-label="Development">'+tabs.map(([id,label])=>
    '<button type="button" role="tab" data-tab="'+id+'" aria-controls="development-content">'+label+'</button>').join("")+
    '</div><section id="development-content" class="development-content" role="tabpanel" tabindex="0"></section>';
  const root=panel.querySelector("#development-content");
  let selected=tabs.some(([id])=>id===localStorage.getItem("wisk-development-tab"))?localStorage.getItem("wisk-development-tab"):"changes";
  let version=0, folder="", command=null;
  async function select(tab,focus=false){
    selected=tab;
    localStorage.setItem("wisk-development-tab",tab);
    const requestId=++version;
    for(const button of panel.querySelectorAll("[data-tab]")){
      const active=button.dataset.tab===tab;
      button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;
      if(active){button.id="development-"+tab;if(focus)button.focus()}else button.removeAttribute("id");
    }
    root.setAttribute("aria-labelledby","development-"+tab);
    root.replaceChildren();
    try{
      if(tab==="changes"){
        const review=await request(base+"/review");
        if(requestId!==version||!root.isConnected)return;
        const changes=review.changes;
        if(!changes.length){root.textContent=review.active?"Waiting for work to change files.":"No changes captured for this task.";return}
        root.innerHTML='<div class="development-caption">'+changes.length+' changed '+(changes.length===1?"file":"files")+
          (review.active?" · Live":"")+'</div><input class="field" type="search" aria-label="Filter changes" placeholder="Filter changes"><div data-change-list></div>'+
          (review.limited?'<p class="inline-help">Some paths are outside snapshot coverage.</p>':"");
        function list(){
          const q=root.querySelector("input").value.toLowerCase();
          const entries=changes.filter(change=>change.name.toLowerCase().includes(q));
          const rows=entries.map(change=>{
            const button=document.createElement("button");
            button.className="development-entry";
            const status=document.createElement("small");
            status.textContent=change.kind;
            button.append(document.createTextNode(change.name),status);
            button.title=(change.origin==="agent"?"Agent change":"Observed workspace change")+" · "+change.name;
            button.onclick=()=>showReview({...session,review},onSaved,change.id);
            return button;
          });
          root.querySelector("[data-change-list]").replaceChildren(...rows);
        }
        root.querySelector("input").oninput=list;
        list();
      }else if(tab==="files"){
        const data=await request(base+"/files?path="+encodeURIComponent(folder));
        if(requestId!==version||!root.isConnected)return;
        root.innerHTML='<div class="development-caption"></div><div data-file-list></div>';
        const header=root.querySelector(".development-caption");
        if(folder){
          const back=document.createElement("button");
          back.className="btn btn-small";back.textContent="Up";
          back.onclick=()=>{folder=folder.split(/[\\/]/).slice(0,-1).join("/");void select(tab)};
          header.append(back);
        }
        const title=document.createElement("strong");title.textContent=folder||"Workspace files";header.append(title);
        const list=root.querySelector("[data-file-list]");
        if(data.entries){
          const filter=document.createElement("input");
          filter.className="field";filter.type="search";filter.placeholder="Filter this folder";filter.setAttribute("aria-label","Filter this folder");
          list.before(filter);
          const render=()=>{
            list.replaceChildren(...data.entries.filter(item=>item.name.toLowerCase().includes(filter.value.toLowerCase())).map(item=>{
              const button=document.createElement("button");
              button.className="development-entry";
              const kind=document.createElement("small");kind.textContent=item.directory?"Folder":"File";
              button.append(document.createTextNode(item.name),kind);
              button.onclick=()=>{folder=item.path;void select(tab)};
              return button;
            }));
          };
          filter.oninput=render;render();
        }else{
          const pre=document.createElement("pre");pre.textContent=data.preview??"Preview unavailable for binary or large files.";list.append(pre);
          const copy=document.createElement("button");copy.className="btn btn-small";copy.textContent="Copy path";
          copy.onclick=()=>void navigator.clipboard.writeText(session.workspace+"\\"+data.path).catch(error=>{title.textContent=error.message});list.append(copy);
          for(const [label,action] of [["Open in editor","editor"],["Reveal in Explorer","reveal"]]){
            const open=document.createElement("button");open.className="btn btn-small";open.textContent=label;
            open.onclick=()=>void request(base+"/files/open",{path:data.path,action,confirmed:true}).catch(error=>{title.textContent=error.message});
            list.append(open);
          }
        }
      }else if(tab==="terminal"){
        root.innerHTML='<div class="development-command" hidden><strong>Agent command</strong><pre></pre></div><div data-user-terminal></div>';
        showTerminal(session,root.querySelector("[data-user-terminal]"));
        updateCommand();
      }else{
        const task=session.task;
        root.innerHTML=task?'<p>'+esc(task.stopReason?.replaceAll("_"," ")||task.status||"Running")+'</p>'+
          (task.checkpoint?.checklist||[]).map(item=>row(item.label,item.evidence?"Verified":"Outstanding")).join("")+
          (task.actions||[]).slice(-12).map(item=>row(item.title,item.status)).join(""):"<p>No tool activity yet.</p>";
      }
    }catch(error){
      if(requestId===version&&root.isConnected)root.textContent=error.message;
    }
  }
  function updateCommand(){
    const target=root.querySelector(".development-command");
    if(!target||!command)return;
    target.hidden=false;
    target.querySelector("strong").textContent="Agent command · "+command.state+(command.code===null?"":" · Exit "+command.code);
    target.querySelector("pre").textContent=command.command+"\n"+(command.chunks||[]).map(part=>part.text).join("");
  }
  const bar=panel.querySelector(".development-tabs");
  bar.onclick=event=>{
    const tab=event.target.closest("[data-tab]")?.dataset.tab;
    if(tab)void select(tab);
  };
  bar.onkeydown=event=>{
    const at=tabs.findIndex(([id])=>id===selected);
    const next=event.key==="ArrowRight"?(at+1)%tabs.length:event.key==="ArrowLeft"?(at+tabs.length-1)%tabs.length:event.key==="Home"?0:event.key==="End"?tabs.length-1:null;
    if(next!==null){event.preventDefault();void select(tabs[next][0],true)}
  };
  void select(selected);
  return event=>{
    if(!root.isConnected)return;
    if(event.type==="review"&&selected==="changes"||event.type==="task"&&selected==="progress")void select(selected);
    if(event.type==="agent-terminal"){command=event.command;updateCommand()}
    if(event.type==="open-file"){folder=event.path;void select("files")}
  };
}

export async function mountMcpPage(root) {
  if(!root)return;
  const header='<header class="page-heading-row"><div><h1 class="page-heading">MCP servers</h1><p class="page-desc">Connect tools you trust to Mistral Vibe.</p></div></header>';
  root.innerHTML=header+'<p role="status">Loading servers…</p>';
  let state;
  try{state=await request("/api/mcp");}
  catch(error){root.querySelector("[role=status]").textContent=error.message;return}
  if(!root.isConnected)return;
  if(!state.available){root.querySelector("[role=status]").textContent="Open WiskHarness Desktop to manage MCP.";return}
  root.innerHTML=header+'<div data-mcp-list class="status-list"></div>'+
    '<form class="card mcp-form"><div class="card-content"><label class="field-label" for="mcp-id">Server name</label><input class="field" required id="mcp-id" pattern="[a-z][a-z0-9_-]{0,24}">'+
    '<label class="field-label" for="mcp-transport">Transport</label><select class="field" id="mcp-transport"><option value="http">Streamable HTTP</option><option value="stdio">Local executable</option></select>'+
    '<label class="field-label" for="mcp-address" data-address>Endpoint URL</label><input class="field" id="mcp-address" required>'+
    '<div data-mcp-arguments hidden><label class="field-label" for="mcp-args">Arguments, one per line</label><textarea class="field" rows="3" id="mcp-args"></textarea></div>'+
    '<label class="field-label" for="mcp-auth">Credentials as JSON</label><input class="field" type="password" autocomplete="off" id="mcp-auth" placeholder="Optional">'+
    '<p class="inline-help" data-mcp-tip></p><label class="terminal-confirm"><input type="checkbox" id="mcp-enabled"> Enable for Vibe Agent chats</label>'+
    '<label class="terminal-confirm"><input type="checkbox" id="mcp-trust" required> I trust this server and its configured program or endpoint</label>'+
    '<div class="workbench-actions"><button class="btn btn-primary">Save server</button><button type="button" class="btn" data-mcp-new>New server</button></div><p role="status" data-status></p></div></form>';
  const form=root.querySelector("form");
  const field=name=>form.querySelector("#mcp-"+name);
  const list=root.querySelector("[data-mcp-list]");
  const mode=()=>{
    const stdio=field("transport").value==="stdio";
    form.querySelector("[data-address]").textContent=stdio?"Executable path":"Endpoint URL";
    form.querySelector("[data-mcp-arguments]").hidden=!stdio;
    form.querySelector("[data-mcp-tip]").textContent=stdio?"Use a JSON object of environment variable names and values.":"For bearer authentication, use a JSON object with a bearer field.";
  };
  function draw(){
    list.innerHTML=state.servers.length?state.servers.map(server=>'<div class="mcp-server"><div><strong>'+esc(server.id)+'</strong><p>'+esc([server.enabled?"Enabled":"Disabled",server.transport,server.status?.state,server.credentialsSaved?"Credentials saved":null].filter(Boolean).join(" · "))+'</p>'+
      (server.status?.tools?.length?'<p>'+esc(server.status.tools.join(", "))+'</p>':'')+'</div><div class="workbench-actions">'+
      '<button class="btn btn-small" data-mcp="edit" data-id="'+esc(server.id)+'">Edit</button>'+
      '<button class="btn btn-small" data-mcp="test" data-id="'+esc(server.id)+'">Test connection</button>'+
      '<button class="btn btn-small" data-mcp="remove" data-id="'+esc(server.id)+'">Remove</button></div></div>').join(""):"<p>No MCP servers configured.</p>";
  }
  list.onclick=async event=>{
    const button=event.target.closest("[data-mcp]");
    if(!button)return;
    const server=state.servers.find(item=>item.id===button.dataset.id);
    const operation=button.dataset.mcp;
    if(operation==="edit"){
      form.reset();field("id").value=server.id;field("id").readOnly=true;
      field("transport").value=server.transport;field("address").value=server.command||server.url;
      field("args").value=(server.args||[]).join("\n");field("enabled").checked=server.enabled;
      field("auth").placeholder=server.credentialsSaved?"Saved. Enter {} to clear.":"Optional";
      mode();field("address").focus();return;
    }
    if(operation==="remove"&&!window.confirm("Remove "+server.id+" and its saved credentials?"))return;
    button.disabled=true;
    try{state=await request("/api/mcp",{id:server.id,operation,confirmed:true});draw();message(form,operation==="test"?"Connection tested.":"Server removed.");}
    catch(error){message(form,error.message);}
    finally{button.disabled=false;}
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    const transport=field("transport").value, address=field("address").value.trim();
    const save=form.querySelector("button");save.disabled=true;
    try{
      state=await request("/api/mcp",{operation:"save",confirmed:field("trust").checked,id:field("id").value,
        enabled:field("enabled").checked,transport,...(transport==="http"?{url:address}:{command:address,args:field("args").value.split(/\r?\n/).filter(Boolean)}),
        auth:field("auth").value?JSON.parse(field("auth").value):undefined});
      field("auth").value="";field("trust").checked=false;draw();message(form,"Server saved.");
    }catch(error){message(form,error.message);}
    finally{save.disabled=false;}
  };
  form.querySelector("[data-mcp-new]").onclick=()=>{form.reset();field("id").readOnly=false;mode();field("id").focus();};
  field("transport").onchange=mode;
  mode();draw();
}
