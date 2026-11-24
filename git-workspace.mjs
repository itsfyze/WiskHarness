import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets, sensitivePath } from "./security-policy.mjs";

const execute = promisify(execFile);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
Object.assign(environment, { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });

export async function workspaceGit(exe, workspace, action = "status", input = {}, protect = true) {
  if (!exe) throw new Error("Git is unavailable");
  const options = { cwd: workspace, env: environment, windowsHide: true, timeout: 12000, maxBuffer: 2 * 1024 * 1024 };
  const base = ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
  const git = async args => (await execute(exe, [...base, ...args], options)).stdout;
  let root;
  try { root = (await git(["rev-parse", "--show-toplevel"])).trim(); }
  catch { return { repository: false }; }
  const [gitRoot, workspaceRoot] = await Promise.all([fs.realpath(root), fs.realpath(workspace)]);
  if (path.relative(gitRoot, workspaceRoot)) throw new Error("Register the Git repository root to review its changes");
  let filterConfig = "";
  try { filterConfig = await git(["config", "--name-only", "--get-regexp", "^filter\\."]); }
  catch (error) { if (error.code !== 1) throw new Error("Could not verify Git filter configuration"); }
  for (const key of filterConfig.split(/\r?\n/).filter(Boolean)) {
    if (!/^filter\.[a-z0-9_.-]+\.[a-z]+$/i.test(key)) throw new Error("Git filter configuration requires your Git client");
    const name=key.slice(0,key.lastIndexOf("."));
    for (const [property,value] of [["clean",""],["smudge",""],["process",""],["required","false"]]) {
      base.push("-c",name+"."+property+"="+value);
    }
  }
  if (action === "commit-preview" || action === "commit") {
    const diff = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none"];
    const names = (await git([...diff, "--name-only", "-z"])).split("\0").filter(Boolean);
    if (!names.length) throw new Error("Stage at least one change before committing");
    if (names.length > 300) throw new Error("Use your Git client to review this large staged set");
    const patch = await git(diff);
    if (protect && (names.some(sensitivePath) || redactSecrets(patch) !== patch || /^Binary files /m.test(patch))) {
      throw new Error("Review sensitive or binary staged changes in your Git client before committing");
    }
    const index = await git(["ls-files", "--stage", "-z"]);
    if (index.split("\0").some(line=>/^\d+ [0-9a-f]+ [123]\t/.test(line))) throw new Error("Resolve unmerged files before committing");
    const head=await git(["rev-parse","--verify","HEAD"]).catch(()=>"unborn");
    const fingerprint=createHash("sha256").update(head+"\0"+index).digest("hex");
    if(action==="commit-preview")return { names,fingerprint };
    if(input.confirmed!==true||input.fingerprint!==fingerprint)throw new Error("Review the current staged changes before committing");
    if(typeof input.message!=="string"||!input.message.trim()||input.message.length>500||input.message.includes("\0"))throw new Error("Enter a commit message under 500 characters");
    if(protect&&redactSecrets(input.message)!==input.message)throw new Error("Remove the recognizable credential from the commit message");
    const hooks=await fs.mkdtemp(path.join(os.tmpdir(),"wisk-git-hooks-"));
    try{await git(["-c","core.hooksPath="+hooks,"commit","--no-gpg-sign","-m",input.message.trim()]);}
    finally{await fs.rmdir(hooks);}
    return {commit:(await git(["rev-parse","--short","HEAD"])).trim()};
  }

  if (action === "branch") {
    const branch=(await git(["rev-parse","--abbrev-ref","HEAD"]).catch(()=>git(["symbolic-ref","--short","HEAD"]))).trim();
    return {repository:true,branch};
  }
  if (action === "status") {
    const output = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all"])).split("\0");
    const files = output.filter(Boolean).map(entry => ({ state: entry.slice(0, 2), name: entry.slice(3) }))
      .filter(entry => !protect || !sensitivePath(entry.name));
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => git(["symbolic-ref", "--short", "HEAD"]))).trim();
    const commits = (await git(["log", "-8", "--format=%h", "HEAD"]).catch(() => "")).split(/\r?\n/).filter(Boolean);
    return { repository: true, branch, files: files.slice(0, 300), truncated: files.length > 300, commits };
  }

  const name = input.name;
  if (typeof name !== "string" || !name || path.isAbsolute(name) || /[\0:\\]/.test(name) ||
      name.split(/[\\/]/).some(part => ["", ".", "..", ".git"].includes(part.toLowerCase())) ||
      (protect && sensitivePath(name))) throw new Error("Select an eligible repository file");
  if (action === "diff") {
    const patch = await git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all",
      ...(input.staged ? ["--cached"] : []), "--", name]);
    const text = protect ? redactSecrets(patch) : patch;
    return { patch: text.slice(0, 120000), truncated: text.length > 120000 };
  }
  if (input.confirmed !== true) throw new Error("Confirm the index change");
  const target = path.join(workspace, name);
  const stat = await fs.lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || path.relative(workspaceRoot, await fs.realpath(target)) !== name.split("/").join(path.sep))) {
    throw new Error("Select a regular file inside this repository");
  }
  if (!stat && !(await git(["ls-files", "-z", "--", name])).split("\0").filter(Boolean).every(entry => entry === name)) {
    throw new Error("Select a single tracked file");
  }
  if (action === "stage") {
    const attribute=(await git(["check-attr","-z","filter","--",name])).split("\0")[2];
    if (attribute!=="unspecified"&&attribute!=="unset") throw new Error("Use your Git client to stage files with Git filters");
    if (protect && stat) {
      if (stat.size > 2 * 1024 * 1024) throw new Error("File is too large for the credential check");
      const bytes = await fs.readFile(target);
      let source;
      try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
      if (source === undefined || source.includes("\0")) throw new Error("Use your Git client to review and stage binary files");
      if (redactSecrets(source) !== source) throw new Error("A recognizable credential blocked staging");
    }
    await git(["add", "--", name]);
  }
  else if (action === "unstage") {
    const hasHead = await git(["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
    if (hasHead) await git(["restore", "--staged", "--", name]);
    else await git(["rm", "--cached", "--", name]);
  } else throw new Error("Invalid Git operation");
  return { ok: true };
}
