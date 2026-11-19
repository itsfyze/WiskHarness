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

export async function showSetup(onSaved) {
  const [setup, models] = await Promise.all([request("/api/setup"),request("/api/models").catch(()=>({models:[]}))]);
  const options = models.models.map(model => '<option value="'+esc(model.name)+'" '+(model.name===setup.model?"selected":"")+'>'+esc(model.name)+'</option>').join("");
  const dialog = modal("Set up WiskHarness", '<p>Choose a workspace and model for new chats. You can complete setup before adding a model.</p>'+
    card("Dependencies","Detected on this PC",'<div class="status-list" id="setup-results">'+row("Windows x64",setup.windows?"Supported":"Unsupported")+row("Ollama models",models.models.length)+'</div>'+
      '<div class="workbench-actions">'+button("setup-check","Run dependency checks")+safeLink("https://ollama.com/download/windows","Get Ollama")+safeLink("https://goose-docs.ai/docs/getting-started/installation/","Get Goose")+'</div>')+
    '<form id="setup-form"><label class="field-label" for="setup-workspace">Workspace folder</label><input class="field" id="setup-workspace" required value="'+esc(setup.workspace)+'">'+
    '<label class="field-label" for="setup-model">Default model</label><select class="field" id="setup-model"><option value="">Choose later</option>'+options+'</select>'+
    '<label class="field-label" for="setup-vault">Obsidian vault folder (optional)</label><input class="field" id="setup-vault" value="'+esc(setup.vault)+'">'+
    '<p class="inline-help">Agent tools run with your Windows account. Review workspace and approval rules in Security &amp; permissions.</p><p role="status" data-status></p><button class="btn btn-primary">Save setup</button></form>');
  const form = dialog.querySelector("#setup-form");
  dialog.querySelector("#setup-check").onclick = async event => {
    const control = event.currentTarget;
    control.disabled = true;
    message(dialog,"Checking local dependencies…");
    try {
      const d = await request("/api/diagnostics?probe=1");
      dialog.querySelector("#setup-results").innerHTML = row("Windows x64",d.windows?"Supported":"Unsupported")+
        row("Ollama installation",d.ollamaInstalled?"Found":"Executable unavailable")+
        row("Ollama server",d.ollamaError||("Running · "+d.modelsCount+" models"))+
        row("Goose CLI",d.gooseInstalled?"Installed":"Missing")+row("Goose ACP",d.acp?.ok?"Initialized":d.acp?.error||"Unavailable")+
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

function updateDetails(data) {
  const download = data.download;
  if (download?.state === "running") return 'Downloading <progress max="'+download.total+'" value="'+download.bytes+'"></progress>';
  if (download?.state === "error") return esc(download.error);
  if (download?.state === "verified") return 'Checksum verified. Close WiskHarness before manually opening the installer or replacing the portable executable.<code class="codepath">'+esc(download.path)+'</code>';
  return esc(data.error || (data.available && !data.latest?.asset ? "A verified download is unavailable for this release." : ""));
}

const toolLabels={read:"File reads",write:"File writes",delete:"File deletion",execute:"Command execution",other:"Other or unidentified tools"};

async function mountSecurity(panel) {
  const target=panel.querySelector("#security-policy");
  const checkbox=(id,label,description,checked)=>'<label class="setting-row" for="'+id+'"><span><strong>'+label+'</strong><small>'+description+'</small></span><input class="switch" type="checkbox" id="'+id+'" '+(checked?"checked":"")+'></label>';
  function draw(data,notice=""){
    if(!target.isConnected)return;
    target.innerHTML='<div class="status-list">'+row("Agent process sandbox","Unavailable")+row("Agent network isolation","Unavailable")+'</div>'+
      '<p class="inline-help">Approved commands run with your Windows account and can read files, launch apps, install packages, and use the network.</p>'+
      '<form id="security-form">'+checkbox("security-scope","Restrict explicit paths","Check paths that Goose supplies in its approval requests.",data.workspaceOnly)+
      checkbox("security-secrets","Secret protection","Block recognized credential paths in approval requests and redact recognizable values from supported logs.",data.secretProtection)+
      '<h3>Goose approval requests</h3><p class="inline-help">These rules apply when Goose asks for approval. Shell activity and direct Goose file reads can fall outside this policy.</p>'+
      Object.entries(toolLabels).map(([key,label])=>{
        const choices=[["ask","Ask every time"],["deny","Always deny"],...(key==="read"?[["allow","Allow eligible in-workspace reads"]]:[])];
        return '<div class="setting-row security-rule"><label for="tool-'+key+'">'+label+'</label><select class="field" id="tool-'+key+'">'+choices.map(([value,title])=>'<option value="'+value+'" '+(data.toolPolicies[key]===value?"selected":"")+'>'+title+'</option>').join("")+'</select></div>';
      }).join("")+
      '<div class="workbench-actions"><button class="btn btn-primary">Save permissions</button>'+button("security-reset","Reset permissions")+'</div><p role="status" data-status>'+esc(notice)+'</p></form>';
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
      try{draw(await request("/api/security",{reset:true}),"Defaults restored. Temporary approvals cleared.")}
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

export async function mountSettings(panel, onSaved, onModelsChanged) {
  if (!panel) return;
  panel.querySelector(".page-heading-row").insertAdjacentHTML("afterend",
    card("Security & permissions","Agent approvals and local data protection",'<div id="security-policy">Loading permissions…</div>')+
    card("Providers & models","Local endpoints and API access",'<div id="provider-settings">Loading providers…</div>')+
    card("Setup and diagnostics","Local dependencies, workspace and optional memory",button("open-setup","Open setup")));
  panel.querySelector("#open-setup").onclick = () => void showSetup(onSaved);
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
  const target=panel.querySelector("#update-settings");
  async function draw(data) {
    if (!target.isConnected) return;
    target.innerHTML=row("Installed version",data.version)+row("Latest eligible release",data.latest?.version||"Unavailable")+
      row("Last successful check",time(data.lastSuccessfulCheck))+
      '<div class="setting-row"><label for="update-auto">Check automatically</label><input class="switch" type="checkbox" id="update-auto" '+(data.automatic?"checked":"")+'></div>'+
      '<div class="setting-row"><label for="update-channel">Release channel</label><select class="field" id="update-channel"><option value="stable">Stable</option><option value="beta" '+(data.channel==="beta"?"selected":"")+'>Beta</option></select></div>'+
      '<div class="workbench-actions">'+button("update-check","Check now")+(data.available?safeLink(data.latest.notes,"View changelog"):"")+
      (data.available&&data.latest.asset&&data.download?.state!=="running"?button("update-download","Download update",true):"")+'</div><p role="status" data-status>'+updateDetails(data)+'</p>';
    const settings = () => request("/api/updates/preferences",{automatic:target.querySelector("#update-auto").checked,channel:target.querySelector("#update-channel").value})
      .then(draw).catch(error=>message(target,error.message));
    target.querySelector("#update-auto").onchange=settings;
    target.querySelector("#update-channel").onchange=settings;
    target.querySelector("#update-check").onclick=async event=>{
      event.currentTarget.disabled=true;
      message(target,"Checking GitHub…");
      try {await draw(await request("/api/updates/check",{}))}
      catch(error) {message(target,error.message)}
    };
    const download=target.querySelector("#update-download");
    if(download)download.onclick=()=>request("/api/updates/download",{}).then(draw).catch(error=>message(target,error.message));
    if(data.download?.state==="running"){
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
        '<div class="workbench-actions">'+safeLink(data.latest.notes,"View changelog")+button("wisk-update-open","Open download settings",true)+button("wisk-remind","Remind me later")+'</div>');
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
    card("Model diagnostics","Latest measured Plan turn",'<div id="model-diagnostics">Loading measurements…</div>'));
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
      try{await request("/api/models/measurements",{enabled:control.checked});message(container,"Usage measurement preference saved. Refresh the view for updated readings.")}
      catch(error){control.checked=!control.checked;message(container,error.message)}
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
    (plan.length?'<h3>Goose plan</h3><div class="status-list">'+plan.map(step=>row(step.title,step.status)).join("")+'</div>':'')+
    '<h3>Observed actions</h3>'+(actions.length?'<div class="status-list">'+actions.map(action=>row(action.title,action.status)).join("")+'</div>':'<p>No tool events have been captured.</p>')+
    (resumable?'<p>Review the checkpoint before sending a new prompt. No earlier commands will replay automatically.</p>'+button("resume-task","Prepare resume",true):""):'<p>Run an Agent task to start a checklist.</p>');
  if(resumable)dialog.querySelector("#resume-task").onclick=()=>{
    dialog.close();
    const summary=actions.slice(-12).map(action=>action.status+" · "+action.title).join("\n");
    onResume("Resume this interrupted task after inspecting the current workspace. Verify what already ran. Ask before repeating any write or command whose outcome is uncertain.\n\nOriginal task: "+task.description+"\n\nSaved tool events:\n"+(summary||"None captured."));
  };
}

function showReview(initial, onSaved) {
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
    body.innerHTML='<label class="field-label" for="change-select">Changed file</label><select class="field" id="change-select">'+changes.map((file,index)=>
      '<option value="'+index+'" '+(index===selected?"selected":"")+'>'+esc(file.name+" · "+file.kind+" · "+file.disposition)+'</option>').join("")+'</select>'+
      (review.limited?'<p>Snapshot coverage is limited by file count, size, type, and excluded folders.</p>':'')+
      '<div class="diff-panes"><section aria-label="Before"><h3>Before</h3><pre>'+esc(before??"File absent")+'</pre></section>'+
      '<section aria-label="After"><h3>After</h3><pre>'+esc(after??"File absent")+'</pre></section></div>'+
      (diff?'<details class="diff-unified" open><summary>Line differences</summary><pre>'+diff.map(([sign,line])=>
        '<span class="'+(sign==="+"?"diff-add":sign==="−"?"diff-remove":"")+'">'+esc(sign+" "+line)+'</span>').join("\n")+'</pre></details>':'')+
      (item.disposition==="applied"?'<div class="workbench-actions">'+button("change-keep","Keep change")+
        (item.kind==="modified"?button("change-revert","Revert snapshot"):"")+'</div>':'');
    body.querySelector("#change-select").onchange=event=>draw(Number(event.target.value));
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
  draw();
}

function showTerminal(session) {
  const base="/api/sessions/"+encodeURIComponent(session.id)+"/terminal";
  const dialog=modal("Terminal",'<p class="codepath">'+esc(session.workspace)+'</p>'+
    '<form id="terminal-form"><label class="field-label" for="terminal-shell">Shell</label><select class="field" id="terminal-shell"><option value="powershell">PowerShell</option><option value="cmd">Command Prompt</option></select>'+
    '<label class="field-label" for="terminal-command">Command</label><textarea class="field" id="terminal-command" rows="2" maxlength="8000" required></textarea>'+
    '<label class="terminal-confirm"><input id="terminal-confirm" type="checkbox" required> I reviewed this command. It runs with my Windows permissions.</label>'+
    '<div class="workbench-actions"><button class="btn btn-primary" id="terminal-run">Run command</button>'+button("terminal-stop","Stop")+'</div></form>'+
    '<label class="field-label" for="terminal-history">Command history</label><select class="field" id="terminal-history"></select>'+
    '<details class="terminal-output" open><summary>Output</summary><pre id="terminal-output" tabindex="0"></pre>'+button("terminal-copy","Copy output")+'</details><p role="status" data-status></p>');
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
    if(!dialog.open)return;
    clearTimeout(timer);
    try{
      const {history:saved,running:active}=await request(base);
      if(!dialog.open)return;
      running=active;
      records=active?[...saved.filter(item=>item.id!==active.id),active]:saved;
      if(!records.some(item=>item.id===selected))selected=records.at(-1)?.id||"";
      const options=records.map(item=>new Option(item.shell+" · "+item.command.slice(0,115),item.id));
      history.replaceChildren(...options.reverse());history.value=selected;
      show();
    }catch(error){message(dialog,error.message)}
    if(dialog.open&&running)timer=setTimeout(read,450);
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


