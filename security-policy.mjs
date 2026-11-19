import fs from "node:fs";
import path from "node:path";

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
  const label = typeof call?.title === "string" ? call.title.split(/\s+·\s+/,1)[0].trim().toLowerCase() : "";
  const fileActions = ["view", "read", "write", "create", "replace", "str_replace", "insert"];
  const category = kind === "execute" || label === "shell" || (operation && !fileActions.includes(operation)) ? "execute"
    : kind === "delete" || label === "delete" ? "delete"
    : ["edit", "move"].includes(kind) || ["write", "edit", "move"].includes(label) ||
      ["write", "create", "replace", "str_replace", "insert"].includes(operation) ? "write"
    : ["view", "read"].includes(operation) || kind === "read" || label === "read" ? "read"
    : "other";
  const outside = [];
  const sensitive = [];
  const resolved = [];
  let unknownPath = false;
  for (const name of declared) {
    try {
      if (name.includes("\0") || (process.platform === "win32" && /(^[\\/]{2}|:)/.test(name.replace(/^[a-z]:[\\/]/i, "")))) {
        throw new Error("Unsupported Windows path");
      }
      const root = fs.realpathSync(workspace);
      const candidate = resolveExistingParent(path.resolve(root, name));
      const relative = path.relative(root, candidate);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) outside.push(name);
      if (sensitivePath(name) || sensitivePath(candidate)) sensitive.push(name);
      resolved.push(candidate);
    } catch {
      unknownPath = true;
    }
  }
  const preference = policy.toolPolicies?.[category] ?? "ask";
  const denied = preference === "deny" || (policy.workspaceOnly && (outside.length > 0 || unknownPath)) ||
    (policy.secretProtection && sensitive.length > 0);
  const readScope = category === "read" && resolved.length === 1 && !outside.length && !sensitive.length && !unknownPath
    ? resolved[0] : null;
  return { category, outside, sensitive, denied, preference, readScope };
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
