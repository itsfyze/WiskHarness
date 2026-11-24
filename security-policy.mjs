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

export function toolLabel(title) {
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

function declaredPaths(input) {
  const values = [];
  const add = value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of ["path", "file_path", "directory", "cwd", "working_directory", "notebook_path", "target"]) {
      if (typeof value[key] === "string") values.push(value[key]);
    }
  };
  add(input);
  // MCP tools carry their real arguments one level down.
  add(input?.arguments);
  return values;
}

export function assessTool({ call, locations = [], workspace, policy }) {
  const input = call?.rawInput;
  const rawPaths = [...declaredPaths(input),
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

export function shellAssessmentForCall({ call, workspace, protectedPath, kind } = {}) {
  const input = call?.rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const command = typeof input.command === "string" ? input.command : null;
  const label = toolLabel(call.title);
  const fileActions = ["view", "read", "write", "create", "replace", "str_replace", "insert"];
  const shellLike = kind === "execute" || label === "shell" || command !== null && !fileActions.includes(command);
  if (!shellLike) return null;
  return classifyShellCommand({
    command: command ?? "",
    shell: input.shell === "cmd" ? "cmd" : "powershell",
    workspace,
    protectedPath
  });
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

// Full Access allows routine in-workspace development commands. Destructive,
// system, install, credential and outside operations keep their own checks.
export function permissionDecision(decision, scope, policy, { shell } = {}) {
  if (decision.denied) return "deny";
  const rules = Array.isArray(policy.permissionRules) ? policy.permissionRules : [];
  const matches = rule => scope && rule?.workspace === scope.workspace && rule.fingerprint === scope.fingerprint;
  if (rules.some(rule => matches(rule) && rule.effect === "deny")) return "deny";
  if (scope?.structured && rules.some(rule => matches(rule) && rule.effect === "allow")) return "allow";
  if (scope?.safeRead && (policy.permissionMode === "auto" || decision.preference === "allow")) return "allow";
  if (shell?.risk === "outside" && policy.workspaceOnly) return "deny";
  if (shell?.risk === "sensitive" && policy.secretProtection) return "deny";
  if (policy.permissionMode === "full") {
    if (shell?.splitRequired) return "deny";
    if (shell && shell.risk !== "routine") return "ask";
    return "allow";
  }
  return "ask";
}

const routineExecutables = new Set([
  "get-command","get-location","get-childitem","get-content","get-item","get-filehash","get-acl","get-help",
  "get-member","get-module","get-date","get-host","get-variable","get-alias","get-process","get-service",
  "test-path","test-connection","resolve-path","select-string","select-object","where-object","foreach-object",
  "measure-object","sort-object","group-object","compare-object","format-table","format-list","format-wide",
  "out-string","convertto-json","convertfrom-json","join-path","split-path","tee-object","write-output",
  "write-host","write-verbose","write-warning","start-sleep","clear-host","help",
  "where","dir","ls","cat","type","echo","pwd","cd","chdir","pushd","popd","exit",
  "set-location","push-location","pop-location","mkdir","md","copy","copy-item","cp","move","move-item","mv",
  "ren","rename-item","new-item","ni","set-content","add-content","out-file","compress-archive","expand-archive",
  "python","python3","py","node","npm","pnpm","yarn","bun","tsc","eslint","prettier","jest","vitest","mocha",
  "playwright","pytest","tox","nox","ruff","black","mypy","coverage",
  "cmake","ctest","ninja","make","mingw32-make","gcc","g++","clang","clang++","cl","link","lib","rc","nmake",
  "msbuild","dotnet","javac","java","jar","gradle","gradlew","gradlew.bat","mvn","mvnw","ant",
  "cargo","rustc","go","gofmt","rustfmt","swift","swiftc","flutter","dart","kotlinc","scala","sbt",
  "ghc","stack","cabal","perl","ruby","rake","php","julia","rscript","lua","luac","pandoc","latexmk","pdflatex",
  "deno","mvnw.cmd","gradlew.cmd",
  "7z","tar","zip","unzip","gzip","git","cmd","cmd.exe","powershell","pwsh"
]);

const destructiveExecutables = new Set([
  "remove-item","rm","rmdir","rd","del","erase","clear-content","shutdown","restart-computer","stop-computer",
  "stop-process","taskkill","format","diskpart","mkfs","clear-disk","initialize-disk","remove-partition",
  "bcdedit","bootrec","manage-bde","robocopy","mklink","defrag","optimize-volume"
]);

const systemExecutables = new Set([
  "reg","sc","net","netsh","schtasks","wmic","attrib","icacls","takeown","cipher","chkdsk","sfc","dism",
  "set-executionpolicy","set-itemproperty","new-itemproperty","remove-itemproperty","set-acl","start-process",
  "start","invoke-expression","iex","subst","mountvol","powercfg","wsl","docker","gpedit","secedit",
  "set-mppreference","add-mppreference","new-service","set-service","remove-service","install-module",
  "set-variable","new-variable"
]);

const installExecutables = new Set([
  "pip","pip3","uv","poetry","winget","choco","scoop","gem","composer","npx","bundle","rustup"
]);

const archiveUnsafeFlags = /(?:^|\s)(?:-e|-jar|--eval|--print|--require|--execute|--script|-P|--checkpoint-action|--use-compress-program|--to-command|--init-script|--settings-file|--project-dir|--include-build|--output|--config-env)\b/i;

function shellSegments(command, shell) {
  const segments = [];
  let current = "";
  let quote = null;
  const push = () => { if (current.trim()) segments.push(current.trim()); current = ""; };
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === "`" || (character === "$" && command[index + 1] === "(")) {
      return { error: "PowerShell escapes, subexpressions and variables cannot be auto-approved" };
    }
    if (character === "#" && shell !== "cmd") break;
    if (character === ";" || character === "\n" || character === "\r") { push(); continue; }
    if (character === "&" && command[index + 1] === "&") { push(); index++; continue; }
    if (character === "|" && command[index + 1] === "|") { push(); index++; continue; }
    if (character === "|") { push(); continue; }
    if (character === "&") return { error: "The call operator cannot be auto-approved" };
    if (character === ">" || character === "<") return { error: "Shell redirection cannot be auto-approved" };
    if (character === "%" || character === "!" || character === "^") {
      return { error: "CMD expansion syntax cannot be auto-approved" };
    }
    current += character;
  }
  if (quote) return { error: "Unterminated quote in command" };
  push();
  return { segments };
}

function shellTokens(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [])
    .map(token => token.length > 1 && /^["']/.test(token) && token.at(-1) === token[0] ? token.slice(1, -1) : token);
}

function insideWorkspace(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function localPythonModule(moduleName, workspace, protectedPath) {
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){0,6}$/.test(moduleName)) return false;
  try {
    const root = fs.realpathSync(workspace);
    const parts = moduleName.split(".");
    for (const file of [path.join(root, ...parts) + ".py", path.join(root, ...parts, "__init__.py")]) {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && stat.nlink === 1 && !path.relative(file, fs.realpathSync(file)) &&
          !protectedPath(file) && !sensitivePath(file)) return true;
    }
  } catch {}
  return false;
}

function inspectCommandToken(token, { workspace, protectedPath, cmdStyle }) {
  if (!token) return null;
  // Joined output/directory switches such as 7z -o..\outside or tar -C..\outside.
  const joined = /^-(?:o|C)(.+)$/.exec(token);
  if (joined) token = joined[1];
  if (token.startsWith("-")) {
    const equals = token.indexOf("=");
    if (equals < 0) return null;
    token = token.slice(equals + 1);
    if (!token) return null;
  }
  if (cmdStyle && /^\/[a-z?][a-z0-9]*$/i.test(token)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return { risk: "unknown", reason: "Network or URL arguments cannot be auto-approved" };
  if (/^(?:data|javascript):/i.test(token)) return { risk: "unknown", reason: "Inline data or script URLs cannot be auto-approved" };
  if (/^(?:env|variable|function|alias):/i.test(token)) {
    return { risk: "sensitive", reason: "PowerShell state provider access cannot be auto-approved: " + token };
  }
  if (/^(?:hklm|hkcu|hkcr|hku|hkcc|cert|wsman|filesystem|registry)::?/i.test(token)) {
    return { risk: "system", reason: "Protected PowerShell provider path: " + token };
  }
  if (token.includes("$") || token.includes("`") || /%[^%]+%/.test(token) || token.startsWith("@") ||
      token.startsWith("{") || token.startsWith("[")) {
    return { risk: "unknown", reason: "Shell variables and expressions cannot be auto-approved" };
  }
  const looksPath = /^[a-z]:[\\/]/i.test(token) || /^\\\\/.test(token) || /[\\/]/.test(token) ||
    token === ".." || token.startsWith(".." + path.sep) || token.startsWith("../") ||
    sensitivePath(token) || /^\.env(?:\.|$)/i.test(token) || /\.(?:pem|key|pfx|p12|json|ini|toml|ya?ml|zip|exe|msi)$/i.test(token);
  if (!looksPath) return null;
  try {
    const root = fs.realpathSync(workspace);
    const candidate = resolveExistingParent(path.resolve(root, token));
    if (!insideWorkspace(candidate, root)) return {risk: "outside", path: token, reason: "Path is outside the workspace: " + token};
    if (sensitivePath(token) || sensitivePath(candidate)) return {risk: "sensitive", path: token, reason: "Protected credential path: " + token};
    if (protectedPath(candidate)) return { risk: "system", reason: "Protected application or vault path: " + token };
    if (/\.(?:pem|key|pfx|p12)$/i.test(token)) return {risk: "sensitive", path: token, reason: "Protected credential file: " + token};
    return null;
  } catch {
    return { risk: "unknown", reason: "Path could not be resolved safely: " + token };
  }
}

function commandRisk(executable, args, { workspace, protectedPath, cmdStyle, segment }) {
  const first = (args[0] || "").toLowerCase();
  const second = (args[1] || "").toLowerCase();
  const has = value => args.some(arg => arg.toLowerCase() === value);
  if (destructiveExecutables.has(executable)) {
    return { risk: "destructive", reason: "Destructive operation: " + executable +
      (args.length ? " " + args.slice(0, 4).join(" ") : "") };
  }
  if (systemExecutables.has(executable)) {
    return { risk: "system", reason: "System-level operation: " + segment.slice(0, 160) };
  }
  if (installExecutables.has(executable)) {
    return { risk: "install", reason: "Dependency or tool installation: " + segment.slice(0, 160) };
  }
  if (!routineExecutables.has(executable)) {
    return { risk: "unknown", reason: "Unrecognized command " + executable + " is not in the Full Access allowlist" };
  }
  if (executable === "git") {
    const readOnly = ["status","diff","log","show","rev-parse","ls-files","grep","describe","show-ref"];
    if (readOnly.includes(first)) return null;
    if (first === "config") return { risk: "system", reason: "Git config can change global or repository settings" };
    if (["clean","reset","restore"].includes(first) || first === "checkout" && has("--")) {
      return { risk: "destructive", reason: "Git operation rewrites or removes working-tree files: git " + first };
    }
    return { risk: "unknown", reason: "Git write operations use WiskHarness Git review, not unapproved shell commands" };
  }
  if (executable === "npm" || executable === "pnpm" || executable === "yarn") {
    if (["run","test","start","ls","list","--version","-v","outdated","audit","view","info"].includes(first)) {
      if (args.slice(1).some(value => /^(?:fix|--fix|install|i|ci|add|update|upgrade|publish|exec|x|dlx)$/i.test(value))) {
        return { risk: "install", reason: "Package dependency changes cannot be auto-approved: " + executable + " " + args.join(" ") };
      }
      return args.some(value => /^--(?:prefix|dir|cwd)(?:=|$)/i.test(value) || /^-C(?:=|$)/.test(value))
        ? { risk: "unknown", reason: "Package-manager directory overrides cannot be auto-approved" } : null;
    }
    if (["install","i","ci","add","update","upgrade","publish","link","exec","x","dlx"].includes(first)) {
      return { risk: "install", reason: "Package installation or publishing: " + executable + " " + first };
    }
    return { risk: "unknown", reason: "Unrecognized " + executable + " subcommand: " + (first || "(none)") };
  }
  if (executable === "python" || executable === "python3" || executable === "py") {
    const moduleIndex = args.findIndex(value => value === "-m");
    if (moduleIndex >= 0) {
      const moduleName = (args[moduleIndex + 1] || "").toLowerCase();
      if (["py_compile","compileall","unittest","pytest","zipfile","tkinter","venv"].includes(moduleName)) return null;
      if (moduleName === "pip") {
        const action = args.slice(moduleIndex + 2).map(value => value.toLowerCase())
          .find(value => ["install","uninstall","download","wheel"].includes(value));
        return action ? { risk: "install", reason: "Python package installation: python -m pip " + action } : null;
      }
      if (moduleName === "ensurepip") return { risk: "install", reason: "Python package installation: python -m ensurepip" };
      if (localPythonModule(moduleName, workspace, protectedPath)) return null;
      return { risk: "unknown", reason: "Unrecognized Python module: " + (moduleName || "(none)") };
    }
    if (args.some(value => /^-(?:c|E)$|^-(?:c|E).+/i.test(value))) {
      return { risk: "unknown", reason: "Inline code cannot be auto-approved" };
    }
    return null;
  }
  if (executable === "node") {
    if (args.some(value => /^-(?:e|p|r)$|^-(?:e|p|r).+|^--(?:eval|print|require|import)(?:=|$)/i.test(value))) {
      return { risk: "unknown", reason: "Inline Node code cannot be auto-approved" };
    }
    return null;
  }
  if (["perl","ruby","lua","luac","julia","rscript"].includes(executable)) {
    if (args.some(value => /^-(?:e|E)$|^-(?:e|E).+|^--eval(?:=|$)/i.test(value))) {
      return { risk: "unknown", reason: "Inline interpreter code cannot be auto-approved" };
    }
    return null;
  }
  if (executable === "php") {
    if (args.some(value => /^-(?:r|R)$|^-(?:r|R).+|^--run(?:=|$)/i.test(value))) {
      return { risk: "unknown", reason: "Inline PHP code cannot be auto-approved" };
    }
    return null;
  }
  if (executable === "bun" || executable === "deno") {
    if (args.some(value => /^(?:eval|-e|--eval)$/i.test(value))) {
      return { risk: "unknown", reason: "Inline JavaScript cannot be auto-approved" };
    }
    return null;
  }
  if (executable === "cmake") {
    if (["-p","--project"].includes(first)) return { risk: "unknown", reason: "CMake script mode cannot be auto-approved" };
    if (first === "-e" && /^(?:rm|remove|remove_directory|remove_directory)/i.test(second)) {
      return { risk: "destructive", reason: "CMake remove operation: " + args.slice(0, 3).join(" ") };
    }
    return null;
  }
  if (executable === "dotnet") {
    if (["restore","add","tool"].includes(first)) return { risk: "install", reason: "Dependency installation: dotnet " + first };
    if (["build","test","run","clean","format","publish","--info","--version"].includes(first)) return null;
    return { risk: "unknown", reason: "Unrecognized dotnet subcommand: " + (first || "(none)") };
  }
  if (executable === "go") {
    if (["build","test","run","vet","fmt","doc","version"].includes(first)) return null;
    if (["install","get","mod","work"].includes(first)) return { risk: "install", reason: "Go dependency or tool installation: go " + first };
    return { risk: "unknown", reason: "Unrecognized go subcommand: " + (first || "(none)") };
  }
  if (executable === "cargo") {
    if (["build","test","run","check","clippy","fmt","doc","bench","clean","--version","-V"].includes(first)) return null;
    if (["install","add","update","fetch"].includes(first)) return { risk: "install", reason: "Cargo dependency or tool installation: cargo " + first };
    return { risk: "unknown", reason: "Unrecognized cargo subcommand: " + (first || "(none)") };
  }
  if (["msbuild","make","ninja","ctest","gradle","gradlew","gradlew.bat","mvn","mvnw"].includes(executable)) {
    if (args.some(value => /^(?:-f|-file|--file|-i|--init-script|--settings|-s)$/i.test(value))) {
      return { risk: "unknown", reason: "Build-tool script overrides cannot be auto-approved" };
    }
    return null;
  }
  if (executable === "cmd" || executable === "cmd.exe" || executable === "powershell" || executable === "pwsh") {
    return { risk: "unknown", reason: "Nested shells are not auto-approved; use the run_command shell parameter" };
  }
  if (archiveUnsafeFlags.test(segment) && ["tar","7z","zip","unzip"].includes(executable)) {
    return { risk: "unknown", reason: "Archive tool options that run external commands cannot be auto-approved" };
  }
  if (executable === "new-item" && args.some(value => /^-(?:itemtype|type)$/i.test(value))) {
    if (args.some(value => /^(?:symboliclink|junction|hardlink)$/i.test(value))) {
      return { risk: "system", reason: "File links can reach outside the workspace" };
    }
  }
  return null;
}

export function classifyShellCommand({ command, shell = "powershell", workspace, protectedPath = () => false }) {
  if (typeof command !== "string" || !command.trim()) {
    return { risk: "unknown", reason: "The command is empty", segments: [] };
  }
  const parsed = shellSegments(command, shell);
  if (parsed.error) return { risk: "unknown", reason: parsed.error, segments: [] };
  let root;
  try { root = fs.realpathSync(workspace); } catch { return { risk: "unknown", reason: "The workspace is unavailable", segments: [] }; }
  const segments = [];
  for (const text of parsed.segments) {
    const tokens = shellTokens(text);
    if (!tokens.length) continue;
    let executable = tokens[0].toLowerCase().replace(/^["']|["']$/g,"").replace(/^\.\//,"").replace(/^\.\\/,"")
      .replace(/^.*[\\/]/,"").replace(/\.exe$/,"").replace(/^@/,"");
    // Windows paths can start with a drive; the token is still the executable.
    const args = tokens.slice(1).map(value => {
      if (executable === "cmake" && /^-d/i.test(value)) return value;
      return value;
    });
    const cmdStyle = shell === "cmd" || executable === "cmd" || executable === "cmd.exe";
    let risk = commandRisk(executable, args, { workspace: root, protectedPath, cmdStyle, segment: text });
    if (risk) {
      risk.segment = text;
      risk.executable = executable;
      segments.push(risk);
      continue;
    }
    let tokenRisk = null;
    for (const token of tokens) {
      const inspected = inspectCommandToken(token, { workspace: root, protectedPath, cmdStyle });
      if (inspected) { tokenRisk = inspected; break; }
    }
    if (tokenRisk) {
      segments.push({ ...tokenRisk, segment: text, executable });
    } else {
      segments.push({ risk: "routine", segment: text, executable });
    }
  }
  const risks = new Set(segments.map(item => item.risk));
  const priority = ["sensitive", "outside", "destructive", "system", "install", "unknown", "routine"];
  const risk = priority.find(value => risks.has(value)) || "routine";
  const hasRoutine = risks.has("routine");
  const mixed = segments.length > 1 && hasRoutine && segments.some(item => item.risk !== "routine");
  const risky = segments.find(item => item.risk === risk);
  const splitRequired = mixed && ["destructive", "system"].includes(risk);
  const detail = segments.filter(item => item.risk !== "routine").map(item => item.reason || item.risk).join(" · ");
  let reason;
  if (risk === "routine") reason = "Recognized development command inside the workspace";
  else if (splitRequired) {
    reason = "This command mixes routine work with a " + risk + " operation (" + detail +
      "). Run the routine steps separately; the protected step needs its own approval.";
  } else if (mixed) {
    reason = "Command includes a protected " + risk + " operation: " + detail;
  } else {
    reason = risky?.reason || "This command requires approval";
  }
  return { risk, reason, segments, mixed, splitRequired, executable: risky?.executable || null };
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
  if(["python","py"].includes(executable)&&args[0]==="-m"&&!["py_compile","compileall","unittest","pytest","zipfile","tkinter"].includes(args[1])){
    if(!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){1,6}$/.test(args[1]||""))return false;
    try{
      const root=fs.realpathSync(workspace);
      const file=path.join(root,...args[1].split("."))+".py";
      const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.nlink!==1||path.relative(file,fs.realpathSync(file))||protectedPath(file)||sensitivePath(file))return false;
    }catch{return false}
  }
  return args.every(value=>{
    if(/[:=@]/.test(value)||path.isAbsolute(value)||value.split(/[\\/]/).includes("..")||sensitivePath(value))return false;
    if(value.startsWith("-"))return !/[\\/]/.test(value);
    try {
      const target=resolveExistingParent(path.resolve(workspace,value));
      const relative=path.relative(fs.realpathSync(workspace),target);
      return relative!==".."&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative)&&!protectedPath(target)&&!sensitivePath(target);
    }catch{return false;}
  });
}
