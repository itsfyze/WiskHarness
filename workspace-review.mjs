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
      if (!entry.isFile() || !sourceExtension.test(entry.name)) continue;
      try {
        const stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.size > limit || stat.nlink !== 1) { skipped++; continue; }
        const raw = fs.readFileSync(absolute);
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
        if (raw.length > limit || text.includes("\0")) { skipped++; continue; }
        if (redact && redact(text) !== text) { skipped++; continue; }
        bytes += raw.length;
        files.set(path.relative(root, absolute), { text, hash: hash(text) });
      } catch { skipped++; }
    }
  }
  return { root, files, limited: skipped > 0 || folders.length > 0 };
}

export function compareWorkspace(before, after) {
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
    changes.push({ id: randomUUID(), name, before: a ?? null, after: b ?? null,
      kind: !a ? "added" : !b ? "removed" : "modified", disposition: "applied" });
  }
  return { changes, limited: before.limited || after.limited, root: before.root };
}

export function revertChange(workspace, review, change) {
  if (change.kind !== "modified" || change.disposition !== "applied" || !change.before || !change.after) throw new Error("This change cannot be reverted");
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

