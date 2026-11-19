import assert from "node:assert/strict";
import {mkdtemp, readdir, rmdir} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {createGooseRuntime, GOOSE_RELEASE} from "../goose-runtime.mjs";

test("managed Goose refuses an incomplete download and cleans staging", {
  skip: process.platform !== "win32" || process.arch !== "x64"
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisk-managed-"));
  const managed = path.join(directory, "goose-runtime");
  t.after(async () => {
    await rmdir(managed);
    await rmdir(directory);
  });
  const fetch = t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.href, GOOSE_RELEASE.url);
    return new Response("Incomplete test archive");
  });
  const runtime = createGooseRuntime({directory, environment:() => process.env});
  assert.equal(runtime.status({source:"portable"}).detected, false);
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(runtime.install(), /official release checksum/);
  assert.deepEqual(await readdir(managed), []);
  assert.equal(runtime.status({source:"portable"}).detected, false);
  assert.equal(runtime.status({source:"portable"}).installing, false);
});
