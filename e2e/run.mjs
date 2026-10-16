import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Doc, SyncClient } from "../js/dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "trama-e2e-"));
const bin = join(tmp, "trama-server");
execFileSync("go", ["build", "-o", bin, "./cmd/trama-server"], { cwd: join(root, "server"), stdio: "inherit" });

const srv = spawn(bin, ["-addr", "127.0.0.1:0", "-db", join(tmp, "e2e.db")], { stdio: ["ignore", "ignore", "pipe"] });
const addr = await new Promise((res, rej) => {
  let buf = "";
  srv.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/listening addr=(\S+)/);
    if (m) res(m[1]);
  });
  srv.on("exit", (c) => rej(new Error(`server exited ${c}`)));
});
const url = `ws://${addr}/sync`;
const name = "notas-e2e";
const step = (s) => console.log(`· ${s}`);

async function synced(doc) {
  const c = new SyncClient(doc, { url, doc: name, minDelay: 50 });
  c.start();
  await Promise.race([c.whenSynced(), new Promise((_, rej) => setTimeout(() => rej(new Error("sync timeout")), 15000))]);
  await new Promise((r) => setTimeout(r, 200));
  return c;
}

function dart(out, mode) {
  execFileSync("dart", ["run", "tool/peer.dart", url, name, out, mode], { cwd: join(root, "dart"), stdio: "inherit" });
  return JSON.parse(readFileSync(out, "utf8"));
}

try {
  const a = new Doc();
  a.change((r) => {
    r.set("titulo", "Lista del súper");
    r.text("t").insert(0, "Hola desde Node");
    r.list("l").push(1);
  });
  let ca = await synced(a);
  ca.stop();
  step("Node escribió y sincronizó");

  a.change((r) => {
    const t = r.text("t");
    t.insert(t.length, "!");
    r.counter("c").increment(2);
  });
  step("Node editó sin conexión");

  const fromDart = dart(join(tmp, "b.json"), "edit");
  step("Dart editó sin conexión y sincronizó");

  ca = await synced(a);
  ca.stop();
  step("Node volvió a conectarse");

  const c = new Doc();
  (await synced(c)).stop();
  const fresh = dart(join(tmp, "d.json"), "read");
  step("réplicas nuevas en Node y Dart descargaron el documento");

  const want = a.toJSON();
  assert.deepEqual(c.toJSON(), want, "Node fresh replica differs");
  assert.deepEqual(fresh, want, "Dart fresh replica differs");
  assert.equal(want.c, 7);
  assert.equal(want.desde_dart, true);
  assert.equal(want.meta.autor, "dart 🎯");
  assert.match(want.t, /^(Dart: Hola desde Node!|Hola desde Node!Dart: )$/);
  assert.deepEqual([...want.l].sort(), [1, "b"].sort());
  assert.ok(fromDart.t.includes("Hola desde Node"), "Dart saw Node's first edit");
  console.log("e2e ok:", JSON.stringify(want));
} finally {
  srv.kill();
}
