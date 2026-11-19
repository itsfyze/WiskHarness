import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return Promise.resolve(false);
  return new Promise(resolve => {
    const kill = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    kill.once("error", () => resolve(false));
    kill.once("close", code => resolve(code === 0));
  });
}

export function startTerminal({ shell, command, workspace, redact, update }) {
  const ps = shell === "powershell";
  const args = ps
    ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]
    : ["/d", "/s", "/c", '"' + command + '"'];
  const child = spawn(ps ? "powershell.exe" : "cmd.exe", args, {
    cwd: workspace, windowsHide: true, windowsVerbatimArguments: !ps, stdio: ["ignore", "pipe", "pipe"]
  });
  const run = { id: randomUUID(), shell, command: redact ? redact(command) : command, workspace, state: "running", startedAt: new Date().toISOString(),
    code: null, chunks: [], truncated: false };
  let size = 0, timer, stopping;
  function output(stream, text) {
    if (size + text.length > 160000 || run.chunks.length >= 2000) { run.truncated = true; return; }
    size += text.length;
    run.chunks.push({ stream, text });
    update(run);
  }
  const flushers = [];
  for (const stream of ["stdout", "stderr"]) {
    child[stream].setEncoding("utf8");
    if (!redact) {
      child[stream].on("data", text => output(stream, text));
      continue;
    }
    let pending = "", privateKey = false, longLine = false;
    function line(text) {
      if (longLine) { longLine = false; return; }
      if (privateKey) {
        if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) privateKey = false;
        return;
      }
      if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) {
        privateKey = !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(text);
        output(stream, "[redacted private key]\n");
        return;
      }
      if (text.length <= 16384) output(stream, redact(text));
      else run.truncated = true;
    }
    child[stream].on("data", text => {
      const lines = (pending + text).split(/(?<=\n)/);
      pending = lines.pop() || "";
      for (const complete of lines) line(complete);
      if (pending.endsWith("\n")) { line(pending); pending = ""; }
      if (pending.length > 16384) { run.truncated = true; longLine = true; pending = ""; }
    });
    flushers.push(() => { if (pending) line(pending); });
  }
  child.once("error", error => { run.error = error.message; });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    for (const flush of flushers) flush();
    run.code = code;
    run.signal = signal;
    run.finishedAt = new Date().toISOString();
    run.state = stopping || (code === 0 ? "completed" : "failed");
    update(run);
  });
  async function stop(reason = "cancelled") {
    if (run.state !== "running") return false;
    stopping = reason;
    if (await stopTree(child)) return true;
    if (run.state !== "running") return true;
    stopping = null;
    run.error = "Windows did not confirm process tree termination.";
    update(run);
    return false;
  }
  timer = setTimeout(() => void stop("timed out"), 5 * 60 * 1000);
  timer.unref();
  return { run, stop };
}

