import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Doc, decodeChange, encodeChange } from "../src/index.js";

const file = new URL("../../conformance/dart.json", import.meta.url);
const data = JSON.parse(readFileSync(file, "utf8")) as { scenarios: { seed: number; blobs: string[]; save: string; expect: unknown }[] };

describe("changes produced by the Dart implementation", () => {
  test.each(data.scenarios.map((s) => [s.seed, s] as const))("scenario %i", (_, s) => {
    const blobs = s.blobs.map((h) => new Uint8Array(Buffer.from(h, "hex")));
    for (const b of blobs) expect(Buffer.from(encodeChange(decodeChange(b))).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    const d = new Doc({ actor: "e".repeat(32) });
    d.apply(blobs);
    expect(d.missing).toBe(0);
    expect(d.toJSON()).toEqual(s.expect);
    const loaded = Doc.load(new Uint8Array(Buffer.from(s.save, "hex")));
    expect(loaded.toJSON()).toEqual(s.expect);
    expect(new Set(loaded.changes().map((b) => Buffer.from(b).toString("hex")))).toEqual(new Set(s.blobs));
  });
});
