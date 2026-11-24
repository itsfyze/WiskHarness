import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {startTerminal} from "./terminal.mjs";
import {createAgentWeb} from "./agent-web.mjs";
import {sensitivePath} from "./security-policy.mjs";

const filePath=z.string().min(1).max(1000).refine(value=>!value.includes("\0"));
const fileText=z.string().max(48_000);
const shellCommand=z.string().min(1).max(8000).refine(value=>value.trim()&&!value.includes("\0"));

async function readText(file,limit,signal) {
  const handle=await fs.open(file,"r");
  try {
    signal.throwIfAborted();
    const stat=await handle.stat();
    if (!stat.isFile()) throw new Error("Expected a regular file");
    const buffer=Buffer.alloc(Math.min(stat.size,limit+1));
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    if (buffer.subarray(0,bytesRead).includes(0)) throw new Error("Binary files are unsupported");
    return {text:buffer.subarray(0,Math.min(bytesRead,limit)).toString("utf8"),truncated:stat.size>limit};
  } finally {await handle.close();}
}

async function searchSource(directory,query,{signal,secretProtection,protectedPath}) {
  const pending=[directory], matches=[];
  let inspected=0, entries=0, skipped=0;
  while (pending.length && inspected<600 && entries<2500 && matches.length<60) {
    signal.throwIfAborted();
    const root=pending.shift();
    for await (const item of await fs.opendir(root)) {
      if (++entries>2500 || inspected>=600 || matches.length>=60) break;
      const file=path.join(root,item.name);
      if (item.isSymbolicLink() || protectedPath(file) || secretProtection && sensitivePath(file) || [".git","node_modules",".venv","local-data"].includes(item.name)) continue;
      if (item.isDirectory()) {pending.push(file);continue;}
      if (!item.isFile()) continue;
      inspected++;
      try {
        const stat=await fs.lstat(file);
        if (!stat.isFile() || stat.nlink>1 || stat.size>128_000) {skipped++;continue;}
        const {text}=await readText(file,128_000,signal);
        let line=0;
        for (const content of text.split(/\r?\n/)) {
          line++;
          if (content.includes(query)) matches.push({file:path.relative(directory,file),line,text:content.slice(0,400)});
          if (matches.length>=60) break;
        }
      } catch {signal.throwIfAborted();skipped++;}
    }
  }
  return {matches,inspected,skipped,truncated:matches.length>=60||inspected>=600||entries>=2500};
}

function commandResult({shell,command,workspace,signal,redact,env}) {
  signal.throwIfAborted();
  return new Promise(resolve=>{
    const stop=()=>void operation.stop().then(terminated=>{
      if (!terminated) resolve({ok:false,error:"Windows could not confirm termination of the command process tree.",state:"termination unconfirmed"});
    });
    const script=shell==="powershell"?"$ErrorActionPreference = 'Stop'\n"+command+"\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }":command;
    const operation=startTerminal({shell,command:script,workspace,redact,env,timeoutMs:120_000,update(run) {
      if (run.state==="running"&&!run.error?.includes("did not confirm")) return;
      signal.removeEventListener("abort",stop);
      const output=stream=>run.chunks.filter(chunk=>chunk.stream===stream).map(chunk=>chunk.text).join("");
      resolve({ok:run.state==="completed",exitCode:run.code,state:run.state,stdout:output("stdout"),stderr:output("stderr"),
        ...(run.error?{error:run.error}:{}),truncated:run.truncated});
    }});
    signal.addEventListener("abort",stop,{once:true});
  });
}

export function createAgentTools({workspace,signal,secretProtection,redact,env,internet,protectedPath,authorize,report}) {
  const registry = new Map();
  function add(name,kind,description,shape,handler) {
    registry.set(name,{kind,description,schema:z.strictObject(shape),handler});
  }
  add("list_directory","read","List entries under an authorized path. Use . for workspace root.",{path:filePath},async({path:file})=>{
    const entries=[];
    for await (const entry of await fs.opendir(file)) {
      signal.throwIfAborted();
      if (entries.length>=300) return {entries,truncated:true};
      const candidate=path.join(file,entry.name);
      if (protectedPath(candidate) || secretProtection && sensitivePath(candidate)) continue;
      entries.push({name:entry.name,type:entry.isSymbolicLink()?"link":entry.isDirectory()?"directory":"file"});
    }
    return {entries};
  });
  add("read_file","read","Read UTF-8 text, reporting truncation. Use relative or absolute paths.",{path:filePath},({path:file})=>readText(file,48_000,signal));
  add("search_source","read","Find literal text in regular source files below a directory.",{path:filePath,query:z.string().min(1).max(400)},
    ({path:file,query})=>searchSource(file,query,{signal,secretProtection,protectedPath}));
  add("create_directory","edit","Create a directory including missing parent directories.",{path:filePath},async({path:file})=>{
    await fs.mkdir(file,{recursive:true}); return {path:file,type:"directory"};
  });
  add("write_file","edit","Create a new UTF-8 file. Fails if it exists. Create parent directories first.",{path:filePath,content:fileText},async({path:file,content})=>{
    await fs.writeFile(file,content,{encoding:"utf8",flag:"wx",signal});
    return {path:file,bytes:Buffer.byteLength(content)};
  });
  add("edit_file","edit","Replace exactly one occurrence of before with after in an existing UTF-8 file.",{path:filePath,before:fileText.min(1),after:fileText},
    async({path:file,before,after})=>{
      const {text,truncated}=await readText(file,128_000,signal);
      if (truncated) throw new Error("File exceeds the edit limit");
      const index=text.indexOf(before);
      if (index<0 || text.indexOf(before,index+1)>=0) throw new Error("Edit needs one exact match. Read the file and try a unique substring.");
      const next=text.slice(0,index)+after+text.slice(index+before.length);
      const temporary=path.join(path.dirname(file),".wisk-edit-"+randomUUID());
      try {
        await fs.writeFile(temporary,next,{encoding:"utf8",flag:"wx",signal});
        const stat=await fs.lstat(file);
        if (!stat.isFile() || stat.nlink!==1 || (await readText(file,128_000,signal)).text!==text) {
          throw new Error("File changed during the edit. Reread and retry.");
        }
        signal.throwIfAborted();
        await fs.rename(temporary,file);
      } finally {await fs.unlink(temporary).catch(()=>{});}
      return {path:file,replacements:1};
    });
  add("run_command","execute","Execute a foreground PowerShell or CMD command in the workspace. Use for tests, builds, git status/diff or process inspection. Returns exit code, stdout and stderr.",{
    shell:z.enum(["powershell","cmd"]),command:shellCommand
  },async args=>{
    const result=await commandResult({...args,workspace,signal,redact,env});
    if(!result.ok||!/compress-archive|zipfile|\b(?:package|pack|tar|zip)\b|pyinstaller|electron-builder/i.test(args.command))return result;
    const candidates=(args.command+" "+result.stdout).match(/"[^"]+\.(?:zip|tar\.gz|tgz|exe|msi|whl|jar)"|'[^']+\.(?:zip|tar\.gz|tgz|exe|msi|whl|jar)'|[^\s"'=:]+\.(?:zip|tar\.gz|tgz|exe|msi|whl|jar)\b/gi)||[];
    const root=await fs.realpath(workspace);
    const artifacts=[];
    for(const candidate of new Set(candidates.slice(0,30))){
      const file=await fs.realpath(path.resolve(root,candidate.replace(/^["']|["']$/g,""))).catch(()=>null);
      if(!file||protectedPath(file)||secretProtection&&sensitivePath(file))continue;
      const relative=path.relative(root,file);
      if(relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative))continue;
      const stat=await fs.stat(file).catch(()=>null);
      if(stat?.isFile()&&stat.size>0)artifacts.push({path:relative,bytes:stat.size});
    }
    return {...result,artifacts};
  });
  if (internet) {
    const web=createAgentWeb({endpoint:internet.endpoint});
    add("search_web","other","Search public sources. Use only public keywords and cite returned source URLs.",{
      query:z.string().min(1).max(300),source:z.enum(["auto","technical","encyclopedia","web"]).optional()
    },async({query,source="auto"})=>({text:await web.searchWeb(query,source,signal)}));
    add("open_page","other","Read text from a public web page as reference data.",{url:z.string().max(2048)},
      async({url})=>({text:await web.openPage(url,signal)}));
  }
  const tools=[...registry].map(([name,{description,schema}])=>({
    type:"function",function:{name,description,parameters:z.toJSONSchema(schema)}
  }));
  async function execute(name,input) {
    const definition=registry.get(name);
    if (!definition) return {ok:false,error:"Unknown tool. Choose a registered tool name."};
    const parsed=definition.schema.safeParse(input);
    if (!parsed.success) return {ok:false,error:"Invalid arguments: "+parsed.error.issues.map(issue=>issue.path.join(".")+": "+issue.message).join("; ").slice(0,1000)};
    const args=parsed.data;
    const finish=report(name,definition.kind,args);
    let result;
    try {
      const resolved=await authorize(name,definition.kind,args);
      signal.throwIfAborted();
      const details=await definition.handler(resolved);
      result={ok:true,...details};
    } catch (error) {
      result={ok:false,error:(redact?redact(error.message):error.message).slice(0,1200)};
    }
    const serialized=JSON.stringify(result);
    if (redact) result=JSON.parse(JSON.stringify(result,(_key,value)=>typeof value==="string"?redact(value):value));
    if(name==="run_command"&&serialized.length>52_000){
      const excerpt=text=>text&&text.length>16000?text.slice(0,4000)+"\n[output truncated]\n"+text.slice(-12000):text;
      result={...result,stdout:excerpt(result.stdout),stderr:excerpt(result.stderr),truncated:true};
    }else if(serialized.length>52_000)result={ok:result.ok,output:serialized.slice(0,24_000),truncated:true};
    finish(result);
    return result;
  }
  return {tools,execute};
}
