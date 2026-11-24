import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const providers = Object.freeze({
  lmstudio: { name: "LM Studio", base: "http://127.0.0.1:1234/v1" },
  compatible: { name: "Compatible local API", base: "http://127.0.0.1:8080/v1" },
  openai: { name: "OpenAI", base: "https://api.openai.com/v1", cloud: true },
  anthropic: { name: "Anthropic", base: "https://api.anthropic.com/v1", cloud: true },
  gemini: { name: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", cloud: true },
  openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", cloud: true }
});

const planInstruction = "You are in Plan mode. Help the user reason and plan. You have no tools. Describe actions as proposed steps unless the user supplies evidence.";
const modelPattern = /^[a-z0-9][a-z0-9._:/+@-]{0,199}$/i;
const providerFor = id => Object.hasOwn(providers, id) ? providers[id] : null;
export const modelRef = (provider, model) => "@provider/" + provider + "/" + model;
export function parseModelRef(value) {
  const match = typeof value === "string" && /^@provider\/([^/]+)\/(.+)$/.exec(value);
  if (!match || !providerFor(match[1]) || !modelPattern.test(match[2])) return null;
  return { id: match[1], model: match[2], provider: providers[match[1]] };
}

const dpapiScript = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  "$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser"
];
function dpapi(method, bytes) {
  if (process.platform !== "win32") throw new Error("Windows protected credential storage is unavailable");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const exe = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [...dpapiScript,
    `[Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}($data, $null, $scope)))`].join("\n");
  const result = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { input: bytes.toString("base64"), encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 32 * 1024 });
  if (result.status !== 0 || !/^[a-z0-9+/]+=*$/i.test(result.stdout)) throw new Error("Windows protected credential storage failed");
  return Buffer.from(result.stdout, "base64");
}

export function credentialStore(folder, allowed = id => !!providerFor(id)) {
  function filename(id) {
    if (!allowed(id)) throw new Error("Unknown credential service");
    return path.join(folder, id + ".dpapi");
  }
  return {
    has(id) { return fs.existsSync(filename(id)); },
    get(id) { return dpapi("Unprotect", fs.readFileSync(filename(id))).toString("utf8"); },
    set(id, key) {
      if (typeof key !== "string" || !/^[\x21-\x7e]{8,2048}$/.test(key)) throw new Error("Enter a valid API key");
      fs.mkdirSync(folder, { recursive: true });
      const target = filename(id), temp = target + "." + randomUUID();
      const encrypted = dpapi("Protect", Buffer.from(key, "utf8"));
      try {
        fs.writeFileSync(temp, encrypted, { flag: "wx" });
        fs.renameSync(temp, target);
      } finally {
        try { fs.unlinkSync(temp); } catch {}
      }
    },
    remove(id) {
      try { fs.unlinkSync(filename(id)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
}

export function providerConfig(id, input) {
  const provider = providerFor(id);
  if (!provider || typeof input?.enabled !== "boolean") throw new Error("Invalid provider configuration");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (model && !modelPattern.test(model)) throw new Error("Invalid model ID");
  if (provider.cloud) return { enabled: input.enabled, model };
  const url = new URL(input.base || provider.base);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname.replace(/\/$/, "") !== "/v1" ||
      url.username || url.password || url.search || url.hash) throw new Error("Use an IPv4 loopback HTTP endpoint ending in /v1");
  return { enabled: input.enabled, model, base: url.origin + "/v1" };
}

export function providerClient({ credentials, config, fetcher = fetch }) {
  const statuses = new Map();
  function endpoint(id) {
    const provider = providerFor(id), settings = config()[id];
    if (!provider || !settings?.enabled) throw new Error("Enable this provider in Settings first");
    const base = providerConfig(id, settings).base || provider.base;
    const headers = {};
    if (provider.cloud || credentials.has(id)) {
      if (!credentials.has(id)) throw new Error("Save an API key for this provider first");
      const key = credentials.get(id);
      if (id === "anthropic") {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
      } else headers.authorization = "Bearer " + key;
    }
    return { base, headers };
  }
  async function request(id, suffix, { body, signal } = {}) {
    const { base, headers } = endpoint(id);
    let response;
    try {
      response = await fetcher(base + suffix, {
        method: body ? "POST" : "GET",
        headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(12000)
      });
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      throw new Error("Could not reach " + providers[id].name);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(providers[id].name + " returned HTTP " + response.status +
        (response.status === 429 ? " (rate limit or quota)" : ""));
    }
    return response;
  }

  return {
    list() {
      return Object.entries(providers).map(([id, provider]) => {
        const settings = config()[id];
        const status = statuses.get(id);
        return {
          id, name: provider.name, base: provider.cloud ? provider.base : settings?.base || provider.base,
          cloud: !!provider.cloud, enabled: !!settings?.enabled, model: settings?.model || "",
          keySaved: credentials.has(id), connected: status?.connected === true, testedAt: status?.testedAt || null,
          models: status?.models || [], error: status?.error || null
        };
      });
    },
    invalidate(id) { statuses.delete(id); },
    async discover(id) {
      const status = { connected: false, testedAt: new Date().toISOString(), models: [], error: null };
      try {
        const models = new Set();
        let next;
        for (let page = 0; page < 8; page++) {
          const response = await request(id, "/models" + (next ? "?after_id=" + encodeURIComponent(next) : ""));
          const data = await response.json();
          if (!Array.isArray(data.data)) throw new Error("Provider did not return a model list");
          for (const item of data.data) if (typeof item?.id === "string" && modelPattern.test(item.id)) models.add(item.id);
          if (id !== "anthropic" || !data.has_more || typeof data.last_id !== "string" || data.last_id === next) break;
          next = data.last_id;
        }
        status.connected = true;
        status.models = [...models].sort().slice(0, 2000);
      } catch (error) { status.error = error.message; }
      statuses.set(id, status);
      return status;
    },
    async stream({ selection, messages, onText, onMetrics, signal }) {
      const { id, model } = selection;
      const history = messages.filter(message => ["user", "assistant"].includes(message.role) && message.text)
        .map(message => ({ role: message.role, content: message.text }));
      const anthropic = id === "anthropic";
      const body = anthropic
        ? { model, stream: true, system: planInstruction, messages: history, max_tokens: 4096 }
        : { model, stream: true, messages: [{ role: "system", content: planInstruction }, ...history],
            ...(["openai", "openrouter"].includes(id) ? { stream_options: { include_usage: true } } : {}) };
      const response = await request(id, anthropic ? "/messages" : "/chat/completions", { body, signal });
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Provider did not return an event stream");
      }
      const lines = createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });
      let ended = false, reason = "end_turn";
      const usage = {};
      for await (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { ended = true; break; }
        const event = JSON.parse(data);
        if (event.error || event.type === "error") throw new Error("Provider returned a streaming error");
        const choice = event.choices?.[0];
        if (event.type === "message_stop" || choice?.finish_reason) ended = true;
        reason = choice?.finish_reason || event.delta?.stop_reason || reason;
        const text = anthropic && event.delta?.type === "text_delta" ? event.delta.text : choice?.delta?.content;
        if (typeof text === "string") onText(text);
        const totals = event.usage || event.message?.usage;
        const input = totals?.prompt_tokens ?? totals?.input_tokens;
        const output = totals?.completion_tokens ?? totals?.output_tokens;
        if (Number.isFinite(input)) usage.prompt_eval_count = input;
        if (Number.isFinite(output)) usage.eval_count = output;
      }
      if (!ended) throw new Error("Provider closed the stream before completing the turn");
      onMetrics?.(usage);
      return reason;
    }
  };
}
