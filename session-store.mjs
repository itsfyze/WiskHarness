import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const now=()=>new Date().toISOString();
const cleanTitle=text=>String(text||"New chat").replace(/\s+/g," ").trim().slice(0,90)||"New chat";

export class SessionStore {
  constructor(directory){
    this.directory=path.resolve(directory);
    fs.mkdirSync(this.directory,{recursive:true});
    this.recover();
  }
  filepath(id){
    if(!ID.test(id))throw new Error("Invalid session ID");
    return path.join(this.directory,id+".json");
  }
  get(id){
    try{
      const item=JSON.parse(fs.readFileSync(this.filepath(id),"utf8"));
      if(item.id!==id||!Array.isArray(item.messages))return null;
      if(!["plan","ask","agent"].includes(item.mode))item.mode="agent";
      return item;
    }catch(e){
      if(e.code==="ENOENT")return null;
      throw e;
    }
  }
  save(item){
    if(!item||!ID.test(item.id))throw new Error("Invalid session record");
    item.updatedAt=now();
    const file=this.filepath(item.id);
    const tmp=file+".tmp-"+process.pid+"-"+randomUUID().slice(0,8);
    try{fs.writeFileSync(tmp,JSON.stringify(item,null,2),"utf8");fs.renameSync(tmp,file)}
    finally{try{fs.unlinkSync(tmp)}catch{}}
    return item;
  }
  create({workspace,model,mode="agent",title="New chat",messages=[],handoffFrom=null}){
    const time=now(),id=randomUUID();
    const item={id,title:cleanTitle(title),workspace:path.resolve(workspace),model,mode,handoffFrom,createdAt:time,updatedAt:time,status:"ready",gooseSessionId:null,messages};
    return this.save(item);
  }
  list(query=""){
    const arr=[];
    for(const f of fs.readdirSync(this.directory)){
      if(!f.endsWith(".json"))continue;
      const id=f.slice(0,-5);if(!ID.test(id))continue;
      try{
        const item=this.get(id);
        if(!item)continue;
        if(query&&!item.title.toLowerCase().includes(query)&&!item.messages.some(m=>String(m.text||"").toLowerCase().includes(query)))continue;
        arr.push({id:item.id,title:item.title,workspace:item.workspace,model:item.model,mode:item.mode,pinned:item.pinned===true,archived:item.archived===true,createdAt:item.createdAt,updatedAt:item.updatedAt,status:item.status,messageCount:item.messages.length,
          preview:(item.messages.findLast?.(m=>m.role==="user")?.text||"").slice(0,135)});
      }catch(e){console.warn("Skipped invalid session "+id+": "+String(e).slice(0,140))}
    }
    return arr.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,600);
  }
  remove(id){
    if(!this.get(id))return false;
    fs.unlinkSync(this.filepath(id));return true;
  }
  rename(id,title){
    const item=this.get(id);if(!item)return null;
    item.title=cleanTitle(title);return this.save(item);
  }
  recover(){
    for(const entry of fs.readdirSync(this.directory)){
      if(!entry.endsWith(".json"))continue;
      const id=entry.slice(0,-5);if(!ID.test(id))continue;
      try{
        const item=this.get(id);
        if(!item)continue;
        let dirty=false;
        if(item.status==="running"){
          item.status="interrupted";
          const last=item.messages[item.messages.length-1];
          if(last?.role==="assistant"&&last.status==="streaming")last.status="interrupted";
          if(item.task){
            item.task.status="interrupted";
            item.task.stopReason="backend_restarted";
            item.task.verification="Interrupted. Inspect persisted results before continuing.";
          }
          dirty=true;
        }
        for(const command of item.terminalHistory||[]){
          if(command.state==="running"){command.state="interrupted";dirty=true}
        }
        if(dirty)this.save(item);
      }catch(e){console.warn("Session recovery skipped "+id+": "+String(e).slice(0,140))}
    }
  }
  importLegacy(pairs,{workspace,model}){
    if(!Array.isArray(pairs)||pairs.length===0)throw new Error("No legacy messages to import");
    const messages=[],arr=pairs.slice(-24);
    for(const p of arr){
      if(typeof p?.user!=="string")continue;
      const time=now();
      messages.push({id:randomUUID(),role:"user",text:p.user.slice(0,16000),createdAt:time});
      if(typeof p.assistant==="string")messages.push({id:randomUUID(),role:"assistant",text:p.assistant.slice(0,120000),createdAt:time,status:"completed",tools:[]});
    }
    if(!messages.length)throw new Error("No valid legacy messages");
    const item=this.create({workspace,model,title:messages[0].text.slice(0,75),messages});
    item.status="completed";
    return this.save(item);
  }
}
