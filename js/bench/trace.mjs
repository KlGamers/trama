import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as Y from "yjs";
import * as A from "@automerge/automerge";
import { Doc } from "../dist/index.js";

const require = createRequire(import.meta.url);
const data = new URL("./data/editing-trace.cjs", import.meta.url);
if (!existsSync(data)) {
  mkdirSync(new URL("./data/", import.meta.url), { recursive: true });
  const res = await fetch("https://raw.githubusercontent.com/automerge/automerge-perf/master/edit-by-index/editing-trace.js");
  writeFileSync(data, await res.text());
}
const { edits, finalText } = require("./data/editing-trace.cjs");

const gc = () => globalThis.gc?.();
const mb = () => {
  gc();
  return process.memoryUsage().heapUsed / 1e6;
};

function time(fn) {
  const t0 = performance.now();
  const out = fn();
  return [performance.now() - t0, out];
}

const rows = [];
function report(name, applyMs, size, loadMs, heap, ok) {
  rows.push({ name, applyMs, size, loadMs, heap, ok });
  console.log(`${name.padEnd(34)} apply ${applyMs.toFixed(0).padStart(7)} ms  save ${(size / 1e3).toFixed(0).padStart(7)} kB  load ${loadMs.toFixed(0).padStart(6)} ms  heap ${heap.toFixed(0).padStart(5)} MB  ${ok ? "ok" : "WRONG TEXT"}`);
}

function tramaPerKey() {
  const base = mb();
  const d = new Doc({ actor: "a".repeat(32) });
  const [ms] = time(() => {
    for (const [pos, del, ...ins] of edits) {
      d.change((r) => {
        const t = r.text("t");
        if (del) t.delete(pos, del);
        if (ins.length) t.insert(pos, ins.join(""));
      });
    }
  });
  const heap = mb() - base;
  const ok = d.root.text("t").toString() === finalText;
  const bytes = d.save();
  const [lms, back] = time(() => Doc.load(bytes));
  report("trama, un cambio por pulsación", ms, bytes.length, lms, heap, ok && back.toJSON().t === finalText);
  const [rms, rep] = time(() => {
    const r = new Doc({ actor: "b".repeat(32) });
    r.apply(d.changes());
    return r;
  });
  console.log(`  aplicar los ${d.changes().length} cambios en otra réplica: ${rms.toFixed(0)} ms`);
  return { remote: rms, ok: rep.toJSON().t === finalText };
}

function tramaBatch() {
  const base = mb();
  const d = new Doc({ actor: "a".repeat(32) });
  const [ms] = time(() => {
    d.change((r) => {
      const t = r.text("t");
      for (const [pos, del, ...ins] of edits) {
        if (del) t.delete(pos, del);
        if (ins.length) t.insert(pos, ins.join(""));
      }
    });
  });
  const heap = mb() - base;
  const bytes = d.save();
  const [lms, back] = time(() => Doc.load(bytes));
  report("trama, un solo cambio", ms, bytes.length, lms, heap, back.toJSON().t === finalText);
}

function yjs() {
  const base = mb();
  const d = new Y.Doc();
  const t = d.getText("t");
  const [ms] = time(() => {
    for (const [pos, del, ...ins] of edits) {
      d.transact(() => {
        if (del) t.delete(pos, del);
        if (ins.length) t.insert(pos, ins.join(""));
      });
    }
  });
  const heap = mb() - base;
  const bytes = Y.encodeStateAsUpdate(d);
  const [lms, back] = time(() => {
    const n = new Y.Doc();
    Y.applyUpdate(n, bytes);
    return n;
  });
  report("Yjs 13, una transacción por pulsación", ms, bytes.length, lms, heap, t.toString() === finalText && back.getText("t").toString() === finalText);
}

function automerge() {
  const base = mb();
  let d = A.from({ t: "" });
  const [ms] = time(() => {
    for (const [pos, del, ...ins] of edits) {
      d = A.change(d, (x) => A.splice(x, ["t"], pos, del, ins.join("")));
    }
  });
  const heap = mb() - base;
  const bytes = A.save(d);
  const [lms, back] = time(() => A.load(bytes));
  report("Automerge 3, un cambio por pulsación", ms, bytes.length, lms, heap, d.t === finalText && back.t === finalText);
}

console.log(`${edits.length} ediciones, texto final de ${finalText.length} caracteres\n`);
const remote = tramaPerKey();
tramaBatch();
yjs();
automerge();
writeFileSync(new URL("./RESULTS.json", import.meta.url), JSON.stringify({ edits: edits.length, rows, remote, node: process.version, arch: process.arch }, null, 1));
