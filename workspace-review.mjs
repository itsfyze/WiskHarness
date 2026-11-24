import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {sensitivePath} from "./security-policy.mjs";

const excluded = new Set(["node_modules", "vendor", "release", "runtime-staging", "local-data", "backups", "dist", "build", "coverage"]);
const sourceExtension = /\.(c|h|cpp|hpp|cs|csproj|java|kt|go|rs|m?js|cjs|jsx|ts|tsx|vue|svelte|py|rb|ps1|sh|cmd|bat|html|css|scss|sql|txt|md|json|toml|ya?ml)$/i;
const hash = text => createHash("sha256").update(text).digest("hex");
const limit = 48 * 1024;

export function snapshotWorkspace(workspace, {redact} = {}) {
  const files = new Map();
  const root = fs.realpathSync(workspace);
  const folders = [root];
  let scanned = 0, skipped = 0, bytes = 0;
  while (folders.length && scanned < 3500 && files.size < 700 && bytes < 6 * 1024 * 1024) {
    const folder = folders.pop();
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { skipped++; continue; }
    for (const entry of entries) {
      if (scanned++ >= 3500 || files.size >= 700 || bytes >= 6 * 1024 * 1024) { skipped++; break; }
      if (entry.name.startsWith(".") || excluded.has(entry.name.toLowerCase()) || entry.name.toLowerCase()==="settings.json" || /(?:secret|credential|settings\.local)/i.test(entry.name)) continue;
      const absolute = path.join(folder, entry.name);
      if (redact && sensitivePath(absolute)) { skipped++; continue; }
      if (entry.isDirectory()) folders.push(absolute);
      if (!entry.isFile()) continue;
      try {
        const stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.nlink !== 1) { skipped++; continue; }
        const name=path.relative(root,absolute);
        if(stat.size>limit){
          files.set(name,{text:null,hash:"stat:"+stat.size+":"+stat.mtimeMs+":"+stat.ino,size:stat.size,large:true});
          continue;
        }
        const raw=fs.readFileSync(absolute);
        bytes+=raw.length;
        let text=null;
        if(sourceExtension.test(entry.name)&&!raw.includes(0)){
          try{text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(raw)}catch{}
        }
        if(redact&&text!==null&&redact(text)!==text){skipped++;continue}
        files.set(name,{text,hash:hash(raw),size:raw.length,...(text===null?{binary:true}:{})});
      } catch { skipped++; }
    }
  }
  return { root, files, limited: skipped > 0 || folders.length > 0 };
}

export function compareWorkspace(before, after, {previous, observed, owned} = {}) {
  const changes = [];
  for (const name of new Set([...before.files.keys(), ...after.files.keys()])) {
    const a = before.files.get(name), b = after.files.get(name);
    if (a?.hash === b?.hash) continue;
    if (changes.length >= 50) return { changes, limited: true, root: before.root };
    if (!a || !b) {
      let exists = false;
      try { fs.lstatSync(path.join(before.root, name)); exists = true; }
      catch (error) { if (error.code !== "ENOENT") continue; }
      if (!exists && b) continue;
      if (exists && !b) continue;
    }
    const old = previous?.changes.find(item => item.name === name && item.before?.hash === a?.hash && item.after?.hash === b?.hash);
    const attributable = observed?.has(name);
    const binary=!!(a?.binary||b?.binary), large=!!(a?.large||b?.large);
    changes.push({ id: old?.id || randomUUID(), name, before: a ?? null, after: b ?? null,
      kind: !a ? "added" : !b ? "removed" : "modified", disposition: old?.disposition || "applied",binary,large,
      ...(observed ? {origin: attributable ? "agent" : "workspace", reversible: !binary&&!large&&owned?.has(name) && owned.get(name) === b?.hash} : {}) });
  }
  const renamed=[];
  for(const removed of changes.filter(item=>item.kind==="removed"&&!item.large)){
    const candidates=changes.filter(item=>item.kind==="added"&&!item.large&&item.after.hash===removed.before.hash);
    if(candidates.length!==1||changes.filter(item=>item.kind==="removed"&&item.before.hash===removed.before.hash).length!==1)continue;
    const added=candidates[0];
    added.kind="renamed";added.oldName=removed.name;added.before=removed.before;added.reversible=false;
    renamed.push(removed.id);
  }
  return { changes:changes.filter(item=>!renamed.includes(item.id)), limited: before.limited || after.limited, root: before.root };
}

export function revertChange(workspace, review, change) {
  if (change.binary || change.large || change.reversible === false || !["added","modified"].includes(change.kind) || change.disposition !== "applied" ||
    !change.after || (change.kind === "modified" && !change.before)) throw new Error("This change cannot be reverted");
  const root = fs.realpathSync(workspace);
  const candidate = path.resolve(root, change.name);
  const relative = path.relative(root, candidate);
  if (root !== review.root || !relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) throw new Error("Path is outside the original workspace");
  function inspect() {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(candidate) !== candidate) throw new Error("The original path no longer refers to the captured file");
    if (hash(fs.readFileSync(candidate)) !== change.after.hash) throw new Error("The file changed after the checkpoint. Revert was blocked.");
    return stat;
  }
  const stat = inspect();
  if(change.kind === "added"){
    fs.unlinkSync(candidate);
    change.disposition = "reverted";
    return;
  }
  const temp = path.join(path.dirname(candidate), ".wisk-" + randomUUID());
  try {
    fs.writeFileSync(temp, change.before.text, { flag: "wx", mode: stat.mode });
    inspect();
    fs.renameSync(temp, candidate);
    if (hash(fs.readFileSync(candidate)) !== change.before.hash) throw new Error("Revert could not be verified");
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
  change.disposition = "reverted";
}

