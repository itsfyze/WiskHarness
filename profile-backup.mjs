import fs from "node:fs";
import path from "node:path";
import { providerConfig,parseModelRef } from "./providers.mjs";
import { redactSecrets,securitySettings } from "./security-policy.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const localPath = value => typeof value === "string" && value.length <= 1024 && !value.includes("\0") &&
  path.isAbsolute(value) && (process.platform !== "win32" || /^[a-z]:[\\/]/i.test(value));
const model = value => value == null || typeof value === "string" && (/^[a-z0-9][a-z0-9._:/+-]{0,199}$/i.test(value) || parseModelRef(value));
const available = value => { try { return fs.statSync(value).isDirectory(); } catch { return false; } };
const clean = value => redactSecrets(value);
const cloudSettings = value => Object.fromEntries(Object.entries(value || {}).map(([id, config]) => [id, providerConfig(id, config)]));

function record(item) {
  if (!item || !uuid.test(item.id) || !localPath(item.workspace) || !["agent", "plan"].includes(item.mode) ||
      !Array.isArray(item.messages) || item.messages.length > 4000 || !model(item.model) ||
      item.mode === "agent" && parseModelRef(item.model)) throw new Error("Invalid backup conversation");
  const messages = item.messages.map(message => {
    if (!message || !uuid.test(message.id) || !["user", "assistant"].includes(message.role) ||
        typeof message.text !== "string" || message.text.length > 500000) throw new Error("Invalid backup message");
    return { id: message.id, role: message.role, text: clean(message.text), createdAt: date(message.createdAt) };
  });
  return { id: item.id, workspace: item.workspace, mode: item.mode,
    title: clean(typeof item.title === "string" ? item.title.slice(0, 90) : "Imported chat"),
    model: item.model || null, status: "completed", createdAt: date(item.createdAt), updatedAt: date(item.updatedAt),
    gooseSessionId: null, messages };
}

function date(value) {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return new Date().toISOString();
  return new Date(value).toISOString();
}

function preferences(input) {
  if (!input || !localPath(input.workspace) || !Array.isArray(input.projects) || input.projects.length > 600 ||
      !input.projects.every(localPath) || !model(input.model) || parseModelRef(input.model) ||
      !model(input.modeDefaults?.plan) || !model(input.modeDefaults?.agent) || parseModelRef(input.modeDefaults?.agent)) {
    throw new Error("Invalid backup preferences");
  }
  const toolOptions = securitySettings({ workspaceOnly:input.workspaceOnly, secretProtection:input.secretProtection,
    toolPolicies:input.toolPolicies, confirmed:true }, {});
  return {
    ...toolOptions, workspace:path.resolve(input.workspace), projects:[...new Set(input.projects.map(value=>path.resolve(value)))],
    model:input.model||null, modeDefaults:{ plan:input.modeDefaults?.plan||null, agent:input.modeDefaults?.agent||null },
    providers:cloudSettings(input.providers), agentInstructions:clean(typeof input.agentInstructions==="string"?input.agentInstructions.slice(0,12000):""),
    updateAutomatic:input.updateAutomatic===true, updateChannel:input.updateChannel==="beta"?"beta":"stable",
    contextTokens:Number.isSafeInteger(input.contextTokens)&&input.contextTokens>=1024&&input.contextTokens<=262144?input.contextTokens:null,
    autoDiscover:input.autoDiscover!==false, unloadPrevious:input.unloadPrevious!==false, usageMeasurements:input.usageMeasurements!==false,
    visible:Array.isArray(input.visible)?input.visible.filter(value=>typeof value==="string"&&model(value)&&!parseModelRef(value)).slice(0,1000):null
  };
}

export function exportProfile(settings, store) {
  const files = fs.readdirSync(store.directory).filter(name=>name.endsWith(".json")&&uuid.test(name.slice(0,-5)));
  if (files.length > 1200) throw new Error("This profile has too many chats for a single backup");
  const backup = { format:"wiskharness-profile", schema:1, exportedAt:new Date().toISOString(),
    preferences:preferences(settings), conversations:files.map(file=>record(store.get(file.slice(0,-5)))) };
  if (Buffer.byteLength(JSON.stringify(backup))>22*1024*1024) throw new Error("This profile exceeds the 22 MiB backup limit");
  return backup;
}

export function validateProfile(backup, current, store) {
  if (backup?.format !== "wiskharness-profile" || backup.schema !== 1 || !Array.isArray(backup.conversations) ||
      backup.conversations.length > 1200) throw new Error("Unsupported WiskHarness backup format");
  const restored = preferences(backup.preferences);
  const savedSettings = { ...current, ...restored, workspace:available(restored.workspace)?restored.workspace:current.workspace,
    projects:[...new Set([current.workspace,...current.projects,...restored.projects,restored.workspace])] };
  const conversations = backup.conversations.map(record);
  if (new Set(conversations.map(item=>item.id.toLowerCase())).size!==conversations.length) throw new Error("Backup contains duplicate chat IDs");
  const additions = conversations.filter(item=>!fs.existsSync(store.filepath(item.id)));
  const missingWorkspaces = [...new Set([restored.workspace,...restored.projects,...conversations.map(item=>item.workspace)])].filter(value=>!available(value));
  return { savedSettings, additions, preview:{ chats:additions.length, existing:conversations.length-additions.length,
    projects:restored.projects.length, unavailableWorkspaces:missingWorkspaces.length,
    restoresSettings:true, workspaceGuard:restored.workspaceOnly, secretProtection:restored.secretProtection } };
}
