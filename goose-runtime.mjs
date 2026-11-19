import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import {once} from "node:events";
import {Readable, Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import {promisify} from "node:util";
import semver from "semver";

export const GOOSE_RELEASE = Object.freeze({
  version: "1.59.2",
  url: "https://github.com/aaif-goose/goose/releases/download/v1.59.2/goose-x86_64-pc-windows-msvc.zip",
  bytes: 53276044,
  sha256: "aef6462832e8cbdcb465b45605afafe8459052effd9b9cbf74817d3d22f46a2f",
  executableBytes: 172345856,
  executableHash: "fd79c8d9073323c074adac6853008f4c292c12941b3bf04068fbf452624b536b"
});

const execute = promisify(execFile);
const supported = process.platform === "win32" && process.arch === "x64";
const localPath = value => typeof value === "string" && /^[a-z]:[\\/]/i.test(value) &&
  !/[<>:"|?*\x00-\x1f]/.test(value.slice(2));
const samePath = (left, right) => left?.toLowerCase() === right?.toLowerCase();

function executablePath(value) {
  if (!localPath(value) || path.extname(value).toLowerCase() !== ".exe") return null;
  try {
    const file = fs.realpathSync.native(value);
    return localPath(file) && path.extname(file).toLowerCase() === ".exe" &&
      fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function detectedGoose() {
  const override = process.env.LOCAL_AGENT_GOOSE_PATH;
  if (override) return [override];
  const folders = (process.env.PATH || "").split(path.delimiter).map(folder => folder.replace(/^"(.*)"$/, "$1"));
  return [...folders, path.join(os.homedir(), ".local", "bin")]
    .filter(localPath).map(folder => path.join(folder, "goose.exe"));
}

async function digestFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function verifiedStream(bytes, sha256) {
  const digest = createHash("sha256");
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received > bytes) return done(new Error("Goose file exceeds the expected size."));
      digest.update(chunk);
      done(null, chunk);
    },
    flush(done) {
      if (received !== bytes || digest.digest("hex") !== sha256) {
        return done(new Error("Goose file failed the official release checksum."));
      }
      done();
    }
  });
}

async function fetchRelease(signal) {
  let url = new URL(GOOSE_RELEASE.url);
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetch(url, {signal, redirect:"manual"});
    if (response.ok && response.body) return Readable.fromWeb(response.body);
    await response.body?.cancel();
    if (![301,302,303,307,308].includes(response.status) || !response.headers.has("location")) break;
    url = new URL(response.headers.get("location"), url);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !["github.com","release-assets.githubusercontent.com","objects.githubusercontent.com"].includes(url.hostname)) {
      throw new Error("Goose download redirected outside GitHub.");
    }
  }
  throw new Error("GitHub did not return the Goose release. Try again in Settings.");
}

export function createGooseRuntime({directory, environment}) {
  const parent = path.join(directory, "goose-runtime");
  const portable = path.join(parent, "goose-" + GOOSE_RELEASE.version + ".exe");
  let installing = false;
  let lastCheck = null;

  function candidates(selection) {
    if (!supported) return [];
    const system = [...new Set(detectedGoose().map(executablePath).filter(Boolean))]
      .map(file => ({source:"system", file}));
    const managed = samePath(executablePath(portable),portable) ? [{source:"portable", file:portable}] : [];
    if (selection?.source === "system") return system;
    if (selection?.source === "portable") return managed;
    if (selection?.source === "custom") {
      const file = executablePath(selection.path);
      return file ? [{source:"custom", file}] : [];
    }
    return [...system, ...managed];
  }

  function status(selection) {
    const detected = candidates(selection);
    const candidate = detected[0];
    const checked = lastCheck?.selection === JSON.stringify(selection ?? null) &&
      (lastCheck.error || detected.some(item=>samePath(item.file,lastCheck.file))) ? lastCheck : null;
    return {
      preference:selection?.source || "auto", customPath:selection?.path || "",
      detected:!!candidate, source:checked?.source || candidate?.source || null,
      version:checked?.version || null, error:checked?.error || null,
      systemAvailable:candidates({source:"system"}).length > 0,
      portableAvailable:candidates({source:"portable"}).length > 0,
      installSupported:supported, installing,
      release:{version:GOOSE_RELEASE.version, bytes:GOOSE_RELEASE.bytes}
    };
  }

  async function verify(selection, signal) {
    const preference = JSON.stringify(selection ?? null);
    const detected = candidates(selection);
    let error = new Error(supported ?
      "Goose executable unavailable. Choose a runtime in Settings or install portable Goose." :
      "Goose integration requires Windows x64.");
    for (const runtime of detected) {
      try {
        if (runtime.source === "portable" && (await digestFile(runtime.file)) !== GOOSE_RELEASE.executableHash) {
          throw new Error("Portable Goose failed verification. Reinstall it in Settings.");
        }
        const options = {cwd:path.dirname(runtime.file), env:environment(), windowsHide:true, timeout:5000, maxBuffer:16384, signal};
        const {stdout, stderr} = await execute(runtime.file, ["--version"], options);
        const output = stdout.trim() || stderr.trim();
        const version = semver.valid(output.replace(/^goose(?:\.exe)?\s+/i, ""));
        if (!version || (runtime.source === "portable" && version !== GOOSE_RELEASE.version)) {
          throw new Error("Goose did not report a valid version. Choose a compatible executable.");
        }
        const {stdout: help} = await execute(runtime.file, ["acp","--help"], options);
        if (!help.includes("--with-builtin")) throw new Error("This Goose executable does not support the required ACP command.");
        lastCheck = {selection:preference, source:runtime.source, file:runtime.file, version};
        return {...runtime, version};
      } catch (failure) {
        signal?.throwIfAborted();
        error = failure.code || failure.killed ?
          new Error("Goose could not run its version or ACP check. Check the executable and its Windows runtime dependencies.") : failure;
      }
    }
    lastCheck = {selection:preference, error:error.message};
    throw error;
  }

  async function install() {
    if (!supported) throw new Error("Portable Goose requires Windows x64.");
    if (installing) throw new Error("Portable Goose is already downloading.");
    installing = true;
    let temporary;
    try {
      await fsp.mkdir(parent, {recursive:true});
      const resolved = await fsp.realpath(parent);
      if (!samePath(resolved,path.join(await fsp.realpath(directory), "goose-runtime"))) {
        throw new Error("The portable Goose directory must be inside the WiskHarness profile.");
      }
      temporary = await fsp.mkdtemp(path.join(parent, ".download-"));
      const archive = path.join(temporary, "goose.zip");
      const file = path.join(temporary, "goose.exe");
      const signal = AbortSignal.timeout(180000);
      await pipeline(await fetchRelease(signal), verifiedStream(GOOSE_RELEASE.bytes, GOOSE_RELEASE.sha256),
        fs.createWriteStream(archive, {flags:"wx"}), {signal});
      const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
      // Read one fixed member to stdout. Archive paths are never written to disk.
      const extractor = spawn(tar, ["-xOf", archive, "goose-package/goose.exe"],
        {cwd:temporary, env:environment(), windowsHide:true, stdio:["ignore","pipe","ignore"], signal});
      const [exit] = await Promise.all([
        once(extractor, "close"),
        pipeline(extractor.stdout, verifiedStream(GOOSE_RELEASE.executableBytes, GOOSE_RELEASE.executableHash),
          fs.createWriteStream(file, {flags:"wx"}), {signal}).catch(error => { extractor.kill(); throw error; })
      ]);
      if (exit[0] !== 0) throw new Error("Windows could not unpack the verified Goose executable.");
      await fsp.rename(file, portable);
      lastCheck = null;
    } finally {
      installing = false;
      if (temporary) {
        await fsp.unlink(path.join(temporary, "goose.exe")).catch(()=>{});
        await fsp.unlink(path.join(temporary, "goose.zip")).catch(()=>{});
        await fsp.rmdir(temporary).catch(()=>{});
      }
    }
  }

  return {status, verify, install};
}
