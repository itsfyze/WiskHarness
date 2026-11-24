import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";

export const securityDefaults = Object.freeze({
  workspaceOnly: true,
  secretProtection: true,
  toolPolicies: Object.freeze({ read: "ask", write: "ask", delete: "ask", execute: "ask", other: "ask" })
});

export function sensitivePath(filename) {
  return /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.env(?:\.[^\\/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?!\.pub\b)|[^\\/]*(?:credential|secret)[^\\/]*\.(?:json|ini|toml|ya?ml)|[^\\/]*\.(?:pem|key|pfx|p12))(?:[\\/]|$)/i.test(filename);
}

export function redactSecrets(value) {
  return value
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, "[redacted private key]")
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35})\b/g, "[redacted credential]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/((?:\b\w*(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|client[_-]?secret)\b)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}]+)/gi, "$1[redacted]");
}

function toolLabel(title) {
  return typeof title==="string"?title.split(/\s+·\s+/,1)[0].trim().toLowerCase().replace(/^developer__/,"").replace(/^(run_command|read_file|write_file|edit_file)$/,(name)=>({run_command:"shell",read_file:"analyze",write_file:"write",edit_file:"edit"})[name]):"";
}
function resolveExistingParent(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isFile() && stat.nlink > 1) throw new Error("Hard-linked file");
    return fs.realpathSync(candidate);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(candidate);
    if (candidate === parent) throw error;
    return path.join(resolveExistingParent(parent), path.basename(candidate));
  }
}

export function assessTool({ call, locations = [], workspace, policy }) {
  const input = call?.rawInput;
  const rawPaths = [input?.path, input?.file_path, input?.directory, input?.cwd, input?.working_directory,
    ...(call?.locations || []).map(location => location.path), ...locations];
  const declared = [...new Set(rawPaths.filter(value => typeof value === "string" && value.trim()))];
  const kind = call?.kind;
  const operation = typeof input?.command === "string" ? input.command : "";
  const label = toolLabel(call?.title);
  const fileActions = ["view", "read", "write", "create", "replace", "str_replace", "insert"];
  const category = kind === "execute" || label === "shell" || (operation && !fileActions.includes(operation)) ? "execute"
    : kind === "delete" || label === "delete" ? "delete"
    : ["edit", "move"].includes(kind) || ["write", "edit", "move"].includes(label) ||
      ["write", "create", "replace", "str_replace", "insert"].includes(operation) ? "write"
    : ["view", "read"].includes(operation) || kind === "read" || ["read","analyze","tree","read_image"].includes(label) ? "read"
    : "other";
  const outside = [];
  const sensitive = [];
  const resolved = [];
  let unknownPath = false;
  for (const name of declared) {
    try {
      const windowsName=name.replace(/^[a-z]:[\\/]/i,"");
      if (name.includes("\0") || (process.platform === "win32" &&
        (/(^[\\/]{2}|:)/.test(windowsName)||windowsName.split(/[\\/]/).some(part=>
          part!=="."&&part!==".."&&(/[. ]$/.test(part)||/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))))) {
        throw new Error("Unsupported Windows path");
      }
      const root = fs.realpathSync(workspace);
      const candidate = resolveExistingParent(path.resolve(root, name));
      const relative = path.relative(root, candidate);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) outside.push(name);
      if (sensitivePath(name) || sensitivePath(candidate)) sensitive.push(name);
      if(!resolved.includes(candidate))resolved.push(candidate);
    } catch {
      unknownPath = true;
    }
  }
  const preference = policy.toolPolicies?.[category] ?? "ask";
  const denied = preference === "deny" || (policy.workspaceOnly && (outside.length > 0 || unknownPath)) ||
    (policy.secretProtection && sensitive.length > 0);
  const readScope = category === "read" && resolved.length === 1 && !outside.length && !sensitive.length && !unknownPath
    ? resolved[0] : null;
  return { category, outside, sensitive, resolved, unknownPath, denied, preference, readScope };
}

export function securitySettings(input, current) {
  if (input?.reset === true) return { ...securityDefaults };
  const { workspaceOnly, secretProtection, toolPolicies } = input ?? {};
  if (typeof workspaceOnly !== "boolean" || typeof secretProtection !== "boolean" ||
      !toolPolicies || typeof toolPolicies !== "object") throw new Error("Invalid security policy");
  if (((current.workspaceOnly && !workspaceOnly) || (current.secretProtection && !secretProtection)) && input.confirmed !== true) {
    throw new Error("Confirm before reducing protection");
  }
  const validated = {};
  for (const category of Object.keys(securityDefaults.toolPolicies)) {
    const allowed = category === "read" ? ["ask", "deny", "allow"] : ["ask", "deny"];
    if (!allowed.includes(toolPolicies[category])) throw new Error("Invalid policy for " + category);
    validated[category] = toolPolicies[category];
  }
  return { workspaceOnly, secretProtection, toolPolicies: validated };
}


export const permissionModes = ["ask", "auto", "full"];

export function permissionScope(call, decision, workspace) {
  const input = call.rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const operation = typeof input.command === "string" ? input.command : "";
  const keys = Object.keys(input).sort();
  const onePath = typeof input.path === "string" && decision.resolved.length === 1 &&
    !decision.outside.length && !decision.sensitive.length && !decision.unknownPath;
  const signatures = {
    view: ["command", "path", "view_range"],
    analyze: ["path"],
    edit: ["after", "before", "path"],
    write: ["content", "path"],
    create: ["command", "file_text", "path"],
    str_replace: ["command", "new_str", "old_str", "path"],
    insert: ["command", "insert_line", "new_str", "path"]
  };
  const title = toolLabel(call.title);
  const fileTool = ["text_editor", "developer__text_editor", "view", "read", "write", "create", "replace", "str_replace", "insert", "edit", "analyze"].includes(title);
  const action = operation || title;
  const read = action === "view" || action === "analyze";
  const fields = Object.hasOwn(signatures, action) ? signatures[action] : null;
  const validRange = input.view_range === undefined ||
    Array.isArray(input.view_range) && input.view_range.length === 2 && input.view_range.every(Number.isInteger);
  const valid = read ? validRange : action === "write" ? typeof input.content === "string" :
    action === "edit" ? typeof input.before === "string" && typeof input.after === "string" :
    action === "create" ? typeof input.file_text === "string" :
    action === "str_replace" ? typeof input.old_str === "string" && typeof input.new_str === "string" :
    action === "insert" && Number.isInteger(input.insert_line) && typeof input.new_str === "string";
  const structured = fileTool && onePath && !!fields && valid && keys.every(key => fields.includes(key)) &&
    (read ? decision.category === "read" && fs.existsSync(decision.resolved[0]) &&
      fs.statSync(decision.resolved[0], {throwIfNoEntry:false})?.isFile() : decision.category === "write");
  const shell = decision.category === "execute" && title==="shell" &&
    ["command","command,shell"].includes(keys.join(",")) && operation.trim() !== "";
  if (!structured && !shell) return null;
  const root = fs.realpathSync(workspace);
  const identity = structured
    ? ["file", action, decision.resolved[0], keys.filter(key=>key!=="path").map(key=>[key,input[key]])]
    : ["shell", operation, ...(input.shell ? [input.shell] : [])];
  return {
    workspace: root,
    fingerprint: createHash("sha256").update(JSON.stringify([root,...identity])).digest("hex"),
    label: structured ? action + " " + decision.resolved[0] + " (exact inputs)" : "Exact shell command (command text omitted from saved rules)",
    safeRead: structured && read,
    structured,
    shell
  };
}

export function permissionDecision(decision, scope, policy) {
  if (decision.denied) return "deny";
  const rules = Array.isArray(policy.permissionRules) ? policy.permissionRules : [];
  const matches = rule => scope && rule?.workspace === scope.workspace && rule.fingerprint === scope.fingerprint;
  if (rules.some(rule => matches(rule) && rule.effect === "deny")) return "deny";
  if (scope?.structured && rules.some(rule => matches(rule) && rule.effect === "allow")) return "allow";
  if (scope?.safeRead && (policy.permissionMode === "auto" || decision.preference === "allow")) return "allow";
  // Full access is the user's explicit opt-in to automatic Goose tool approval.
  // This includes shell commands and tools whose inputs cannot be structurally
  // classified. Hard path/secret restrictions and explicit deny rules above
  // still take precedence when the request declares inspectable paths.
  if (policy.permissionMode === "full") return "allow";
  return "ask";
}

export function ordinaryDevelopmentCommand(input, workspace, protectedPath=()=>false) {
  const command=input?.command;
  if(typeof command!=="string"||/[\r\n;&|><\x60$%!(){}[\]#^]/.test(command))return false;
  if(/--(?:use-compress-program|checkpoint-action|to-command|init-script|settings-file|project-dir|include-build|output|config-env|execute|script)\b|^cmake(?:\.exe)?\s+-P\b/i.test(command))return false;
  const args=command.trim().match(/"[^"]*"|'[^']*'|[^\s"']+/g)?.map(value=>value.replace(/^["']|["']$/g,""))||[];
  const executable=args.shift()?.toLowerCase().replace(/\.exe$/,"");
  if(!/^(?:get-command|get-location|get-childitem|get-content|test-path|write-output|where|dir|type|echo|python|py|cmake|ctest|ninja|gcc|g\+\+|clang|clang\+\+|cl|javac|java|node|npm|gradle|gradlew(?:\.bat)?|git|tar|compress-archive)$/.test(executable||""))return false;
  if(["node","python","py"].includes(executable)&&args.some(value=>/^-(?:e|c|p).+|^--(?:eval|print|require|import)\b/i.test(value)))return false;
  if(executable==="git"&&!["status","diff","log","show","rev-parse"].includes(args[0]))return false;
  if(executable==="npm"&&!["run","test","--version","ls"].includes(args[0]))return false;
  if(args.some(value=>/^(?:install|ci|add|download|publish|deploy|--install|--prefix|-enc(?:odedcommand)?|-e|-c|-r|-jar)$/i.test(value))&&
      !(["python","py"].includes(executable)&&args[0]==="-m"&&args[1]==="zipfile")&&
      !(["gcc","g++","clang","clang++"].includes(executable)&&args.includes("-c")))return false;
  if(["python","py"].includes(executable)&&args[0]==="-m"&&!["py_compile","compileall","unittest","pytest","zipfile","tkinter"].includes(args[1]))return false;
  return args.every(value=>{
    if(/[:=@]/.test(value)||path.isAbsolute(value)||value.split(/[\\/]/).includes("..")||sensitivePath(value))return false;
    if(!/[\\/\.]/.test(value)||value.startsWith("-"))return true;
    try {
      const target=resolveExistingParent(path.resolve(workspace,value));
      const relative=path.relative(fs.realpathSync(workspace),target);
      return relative!==".."&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative)&&!protectedPath(target)&&!sensitivePath(target);
    }catch{return false;}
  });
}
