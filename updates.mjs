import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import semver from "semver";

export const repository = "itsfyze/WiskHarness";
const api = "https://api.github.com/repos/" + repository + "/releases?per_page=50";
const releaseRoot = "https://github.com/" + repository + "/releases";
const maxSize = 512 * 1024 * 1024;

export function selectRelease(releases, channel, kind = "setup") {
  if (!Array.isArray(releases)) throw new Error("Invalid release response");
  const eligible = releases.flatMap(release => {
    const version = typeof release?.tag_name === "string" && semver.valid(release.tag_name);
    if (!version || release.tag_name !== "v" + version || release.draft !== false || typeof release.prerelease !== "boolean") return [];
    if (channel !== "beta" && (release.prerelease || semver.prerelease(version))) return [];
    if (!Array.isArray(release.assets)) return [];
    const name = "WiskHarness " + (kind === "portable" ? "Portable" : "Setup") + " " + version + ".exe";
    const publishedName = name.replaceAll(" ", ".");
    const downloadRoot = releaseRoot + "/download/" + release.tag_name + "/";
    const asset = release.assets.find(item => (item?.name === name || item?.name === publishedName) && item.state === "uploaded" &&
      item.browser_download_url === downloadRoot + encodeURIComponent(item.name) && Number.isSafeInteger(item.size) && item.size > 0 &&
      item.size <= maxSize && /^sha256:[a-f0-9]{64}$/i.test(item.digest || ""));
    return [{ version, notes: releaseRoot + "/tag/" + release.tag_name,
      summary: typeof release.body === "string" ? release.body.slice(0, 6000) : "",
      asset: asset ? { name, url: asset.browser_download_url, size: asset.size, sha256: asset.digest.slice(7).toLowerCase() } : null }];
  });
  return eligible.sort((a, b) => semver.rcompare(a.version, b.version))[0] ?? null;
}

export function createUpdater({ version, directory, kind, fetcher = fetch }) {
  let state = { version, latest: null, checkedAt: null, error: null, download: null };
  let checking;
  const downloading = () => ["running", "verifying"].includes(state.download?.state);
  let attemptedAt = 0;
  async function check(channel, force = false) {
    if (checking) return checking;
    if (downloading()) return state;
    if (state.channel === channel && Date.now() - attemptedAt < (force ? 8000 : 6 * 3600 * 1000)) return state;
    attemptedAt = Date.now();
    state = { ...state, channel, latest: null, available: false, checking: true };
    checking = (async () => {
      try {
        const response = await fetcher(api, { redirect: "error", headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) });
        if (response.status === 403 || response.status === 429) throw new Error("GitHub rate limit. Check again later.");
        if (response.status === 404) throw new Error("The official release repository is unavailable.");
        if (!response.ok) throw new Error("GitHub returned HTTP " + response.status);
        const latest = selectRelease(await response.json(), channel, kind);
        state = { ...state, latest, available: !!latest && semver.gt(latest.version, version), checkedAt: new Date().toISOString(), error: null };
      } catch (error) {
        state = { ...state, error: error.message || "Update check failed" };
      }
      return state;
    })();
    try { return await checking; }
    finally { checking = null; state.checking = false; }
  }

  async function download() {
    if (downloading()) throw new Error("An update is downloading already");
    const latest = state.latest;
    const asset = !checking && state.available && latest?.asset;
    if (!asset) throw new Error("A verified asset is unavailable");
    state = { ...state, download: { state: "running", bytes: 0, total: asset.size } };
    let temporary, file;
    try {
      const signal = AbortSignal.timeout(5 * 60 * 1000);
      let location = asset.url;
      let response;
      for (let hop = 0; hop < 4; hop++) {
        response = await fetcher(location, { redirect: "manual", signal });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const next = new URL(response.headers.get("location"), location);
        if (next.origin !== "https://release-assets.githubusercontent.com" || next.username || next.password) throw new Error("Unexpected download redirect");
        location = next.href;
      }
      if (!response?.ok || !response.body) throw new Error("Update download could not start");
      fs.mkdirSync(directory, { recursive: true });
      temporary = path.join(directory, "." + randomUUID() + ".partial");
      file = await fs.promises.open(temporary, "wx");
      const hash = createHash("sha256");
      let bytes = 0;
      const started = performance.now();
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > asset.size) throw new Error("Download exceeded the expected size");
        hash.update(chunk);
        await file.writeFile(chunk);
        state.download.bytes = bytes;
        state.download.bytesPerSecond = Math.round(bytes * 1000 / Math.max(1, performance.now() - started));
      }
      state.download.state = "verifying";
      await file.sync();
      if (bytes !== asset.size || hash.digest("hex") !== asset.sha256) throw new Error("Download size or checksum did not match");
      await file.close();
      file = null;
      const destination = path.join(directory, asset.name);
      await fs.promises.rename(temporary, destination);
      state = { ...state, download: { state: "verified", bytes, total: asset.size, path: destination, version: latest.version, sha256: asset.sha256 } };
    } catch (error) {
      state = { ...state, download: { state: "error", error: error.message || "Download interrupted" } };
    } finally {
      if (file) await file.close().catch(() => {});
      if (temporary) await fs.promises.unlink(temporary).catch(() => {});
    }
    return state;
  }
  return { status: () => state, check, download, downloading };
}

