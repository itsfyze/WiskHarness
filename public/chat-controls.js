import {openPopover,closePopover} from "./popover.js";

const chevron='<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const shield='<svg class="mode-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-3 7-10V5l-7-3-7 3v7c0 7 7 10 7 10Z"/><path d="m9 12 2 2 4-4"/></svg>';
const options={
  ask:["Ask for approval","Review restricted tool requests."],
  auto:["Approve for me","Approve eligible workspace file reads automatically."],
  full:["Full access","Allow routine project commands. Ask before operations outside that scope."]
};

function attachDialog(dialog){
  document.querySelector("#dialog-layer").append(dialog);
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});
  dialog.showModal();
}
function confirmFullAccess(){
  const dialog=document.createElement("dialog");
  dialog.className="modal";
  dialog.setAttribute("aria-label","Enable Full access");
  dialog.innerHTML='<form method="dialog"><h2>Enable Full access?</h2><p>Routine PowerShell and CMD commands can run without a prompt. Other shell commands, including dependency installs and destructive actions, require separate approval. Build and test tools run with your Windows account permissions and can execute project code.</p><div class="modal-actions"><button class="btn" value="cancel" autofocus>Cancel</button><button class="btn btn-danger" value="enable">Enable Full access</button></div></form>';
  return new Promise(resolve=>{
    dialog.addEventListener("close",()=>resolve(dialog.returnValue==="enable"),{once:true});
    attachDialog(dialog);
  });
}
let policy,loading,changing=false;
function drawPermissions(){
  const control=document.querySelector("#permission-trigger");
  const indicator=document.querySelector("#full-access-status");
  const mode=policy?.permissionMode||"ask";
  if(control){
    control.innerHTML=shield+"<span>"+options[mode][0]+"</span>"+chevron;
    control.classList.toggle("full-access",mode==="full");
  }
  indicator.hidden=mode!=="full";
}
export async function mountPermissions(control,api,post,toast){
  function open(anchor){
    const selected=policy?.permissionMode||"ask";
    const node=document.createElement("div");
    node.style.width="295px";
    node.setAttribute("role","menu");
    node.setAttribute("aria-label","Agent permission mode");
    node.innerHTML='<div class="popover-list">'+Object.entries(options).map(([mode,[label,description]])=>
      '<button class="popover-item mode-row '+(mode===selected?"active":"")+'" role="menuitemradio" aria-checked="'+(mode===selected)+'" data-access="'+mode+'">'+shield+'<span><span class="option-name">'+label+'</span><small>'+description+'</small></span><span class="option-check">'+(mode===selected?"✓":"")+'</span></button>').join("")+'</div>';
    node.onclick=async event=>{
      const mode=event.target.closest("[data-access]")?.dataset.access;
      if(!mode)return;
      closePopover(true);
      if(mode===selected||changing)return;
      changing=true;
      try{
        const confirmed=mode!=="full"||await confirmFullAccess();
        if(!confirmed)return;
        policy=await post("/api/security/mode",{mode,confirmed});
        drawPermissions();
      }catch(error){toast(error.message,"error")}
      finally{changing=false}
    };
    openPopover(node,anchor);
  }
  const indicator=document.querySelector("#full-access-status");
  for(const button of [indicator,control].filter(Boolean))button.onclick=()=>open(button);
  drawPermissions();
  try{
    const request=loading||(loading=api("/api/security"));
    const next=await request;
    if(!changing&&loading===request)policy=next;
    drawPermissions();
  }catch(error){if(control)toast(error.message,"error")}
  finally{loading=null}
}
export function showCheckpoint(container,checkpoint,retry,diagnostics,toast){
  container.querySelector(".checkpoint-notice")?.remove();
  const notice=document.createElement("div");
  notice.className="checkpoint-notice";
  notice.setAttribute("role","status");
  const control=document.createElement("button");
  control.className="btn btn-small";
  const title=checkpoint.error?"Obsidian checkpoint failed":"Could not read Obsidian context";
  control.textContent=title+" — View details";
  control.onclick=()=>{
    const dialog=document.createElement("dialog");
    dialog.className="modal";
    dialog.setAttribute("aria-label",title);
    dialog.innerHTML='<h2>'+title+'</h2><p data-error></p><dl class="performance-grid"><dt>Affected note</dt><dd data-note></dd><dt>Last successful checkpoint</dt><dd data-success></dd><dt>Last attempted checkpoint</dt><dd data-attempt></dd></dl><div class="modal-actions"><form method="dialog"><button class="btn">Close</button></form><button class="btn" data-diagnostics>Open diagnostics</button><button class="btn btn-primary" data-retry>Retry checkpoint</button></div><p role="status"></p>';
    function details(data){
      for(const [name,value] of Object.entries({error:data.error||data.contextError,note:data.note||data.contextNote,success:data.lastSuccessful,attempt:data.lastAttempted})){
        dialog.querySelector("[data-"+name+"]").textContent=value||"Unavailable";
      }
      dialog.querySelector("[data-retry]").hidden=!data.vault;
    }
    const button=dialog.querySelector("[data-retry]");
    dialog.querySelector("[data-diagnostics]").onclick=()=>{dialog.close();diagnostics()};
    button.onclick=async()=>{
      button.disabled=true;
      try{
        const result=await retry();
        if(result.saved){notice.remove();dialog.close();toast("Obsidian checkpoint saved","good")}
        else {checkpoint=result;details(result)}
      }catch(error){dialog.querySelector("[role=status]").textContent=error.message}
      finally{button.disabled=false}
    };
    details(checkpoint);
    attachDialog(dialog);
  };
  notice.append(control);
  container.prepend(notice);
}
