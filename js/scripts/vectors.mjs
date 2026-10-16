import { writeFileSync } from "node:fs";
import { Doc } from "../dist/index.js";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const pool = ["a", "b", "ñ", "é", "👋", "数", " ", "\u{1F1F2}\u{1F1FD}", "z", "\n"];
const vals = (r) => [null, true, false, Math.floor(r() * 2000) - 1000, (r() - 0.5) * 1e6, "v" + Math.floor(r() * 9), "", 3.0, -0.25][Math.floor(r() * 9)];

function scenario(seed) {
  const r = rng(seed);
  const pick = (n) => Math.floor(r() * n);
  const n = 2 + pick(3);
  const docs = Array.from({ length: n }, (_, i) => new Doc({ actor: (i + 1).toString(16).repeat(32) }));
  for (let s = 0; s < 80; s++) {
    const d = docs[pick(n)];
    if (pick(5) === 0) {
      const to = docs[pick(n)];
      if (to !== d) to.apply(d.changes(to.version()));
      continue;
    }
    d.change((root) => {
      switch (pick(9)) {
        case 0:
          root.set("k" + pick(3), vals(r));
          break;
        case 1:
          root.delete("k" + pick(3));
          break;
        case 2: {
          const t = root.text("t");
          let s2 = "";
          for (let i = 0; i <= pick(6); i++) s2 += pool[pick(pool.length)];
          t.insert(pick(t.length + 1), s2);
          break;
        }
        case 3: {
          const t = root.text("t");
          if (t.length) {
            const at = pick(t.length);
            t.delete(at, Math.min(1 + pick(4), t.length - at));
          }
          break;
        }
        case 4: {
          const l = root.list("l");
          l.insert(pick(l.length + 1), vals(r));
          break;
        }
        case 5: {
          const l = root.list("l");
          if (l.length) l.delete(pick(l.length));
          break;
        }
        case 6:
          root.counter("c").increment(pick(21) - 10);
          break;
        case 7:
          root.map("m").map("deep").set("x" + pick(2), vals(r));
          break;
        case 8: {
          const l = root.list("objs");
          l.insertMap(pick(l.length + 1)).set("id", pick(100));
          break;
        }
      }
    });
  }
  for (let round = 0; round < 2; round++) for (const x of docs) for (const y of docs) if (x !== y) y.apply(x.changes(y.version()));
  const blobs = docs[0].changes().map((b) => Buffer.from(b).toString("hex"));
  for (let i = blobs.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [blobs[i], blobs[j]] = [blobs[j], blobs[i]];
  }
  return { seed, blobs, save: Buffer.from(docs[0].save()).toString("hex"), expect: docs[0].toJSON() };
}

const out = { generator: "typescript", scenarios: Array.from({ length: 60 }, (_, i) => scenario(i + 1)) };
writeFileSync(new URL("../../conformance/typescript.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(`wrote ${out.scenarios.length} scenarios, ${out.scenarios.reduce((n, s) => n + s.blobs.length, 0)} changes`);
