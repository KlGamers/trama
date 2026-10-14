import { describe, expect, test } from "vitest";
import { CodecError, Doc, decodeChange, encodeChange } from "../src/index.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

function sync(...docs: Doc[]): void {
  for (const x of docs) for (const y of docs) if (x !== y) y.apply(x.changes(y.version()));
}

describe("maps", () => {
  test("set, get, delete and nested objects", () => {
    const d = new Doc({ actor: A });
    d.change((r) => {
      r.set("title", "Hola");
      r.set("n", 3);
      r.set("pi", 3.25);
      r.set("ok", true);
      r.set("none", null);
      r.map("meta").set("lang", "es");
      r.delete("none");
    });
    expect(d.toJSON()).toEqual({ meta: { lang: "es" }, n: 3, ok: true, pi: 3.25, title: "Hola" });
    expect(d.root.keys()).toEqual(["meta", "n", "ok", "pi", "title"]);
    expect(d.root.has("none")).toBe(false);
    expect(d.root.get("missing")).toBeUndefined();
  });

  test("concurrent writes: highest op id wins on every replica", () => {
    const x = new Doc({ actor: A });
    const y = new Doc({ actor: B });
    x.change((r) => r.set("k", "x"));
    y.change((r) => r.set("k", "y"));
    sync(x, y);
    expect(x.toJSON()).toEqual({ k: "y" });
    expect(y.toJSON()).toEqual({ k: "y" });
    x.change((r) => r.set("k", "x2"));
    sync(x, y);
    expect(y.toJSON()).toEqual({ k: "x2" });
  });

  test("delete races with a later write", () => {
    const x = new Doc({ actor: A });
    const y = new Doc({ actor: B });
    x.change((r) => r.set("k", 1));
    sync(x, y);
    x.change((r) => r.delete("k"));
    y.change((r) => {
      r.set("other", 1);
      r.set("k", 2);
    });
    sync(x, y);
    expect(x.toJSON()).toEqual(y.toJSON());
    expect(x.toJSON()).toEqual({ k: 2, other: 1 });
  });

  test("rejects unsupported values", () => {
    const d = new Doc({ actor: A });
    expect(() => d.change((r) => r.set("x", NaN))).toThrow(TypeError);
    expect(() => d.change((r) => r.set("x", {} as never))).toThrow(TypeError);
    expect(() => d.root.set("x", 1)).toThrow(/inside doc.change/);
  });
});

describe("lists and text", () => {
  test("list operations", () => {
    const d = new Doc({ actor: A });
    d.change((r) => {
      const l = r.list("items");
      l.push("b");
      l.insert(0, "a");
      l.push("c");
      l.insertMap(3).set("done", false);
      l.delete(1);
    });
    expect(d.toJSON()).toEqual({ items: ["a", "c", { done: false }] });
    expect(d.root.list("items").length).toBe(3);
  });

  test("text with emoji counts code points", () => {
    const d = new Doc({ actor: A });
    d.change((r) => r.text("t").insert(0, "hola 👋 mundo"));
    const t = d.root.get("t") as ReturnType<typeof d.root.text>;
    expect(t.length).toBe(12);
    d.change((r) => r.text("t").delete(5, 2));
    expect(d.toJSON()).toEqual({ t: "hola mundo" });
  });

  test("concurrent inserts at the same position keep both, same order everywhere", () => {
    const x = new Doc({ actor: A });
    const y = new Doc({ actor: B });
    x.change((r) => r.text("t").insert(0, "ac"));
    sync(x, y);
    x.change((r) => r.text("t").insert(1, "XX"));
    y.change((r) => r.text("t").insert(1, "yy"));
    sync(x, y);
    expect(x.toJSON()).toEqual(y.toJSON());
    expect((x.toJSON() as { t: string }).t).toMatch(/^a(XXyy|yyXX)c$/);
  });

  test("deleting text another replica is typing into", () => {
    const x = new Doc({ actor: A });
    const y = new Doc({ actor: B });
    x.change((r) => r.text("t").insert(0, "hola mundo"));
    sync(x, y);
    x.change((r) => r.text("t").delete(0, 5));
    y.change((r) => r.text("t").insert(5, "gran "));
    sync(x, y);
    expect(x.toJSON()).toEqual(y.toJSON());
    expect(x.toJSON()).toEqual({ t: "gran mundo" });
  });

  test("range errors", () => {
    const d = new Doc({ actor: A });
    expect(() => d.change((r) => r.list("l").insert(2, 1))).toThrow(RangeError);
    expect(() => d.change((r) => r.text("t").delete(0, 1))).toThrow(RangeError);
  });

  test("long documents split into blocks", () => {
    const d = new Doc({ actor: A });
    const words: string[] = [];
    d.change((r) => {
      const t = r.text("t");
      for (let i = 0; i < 3000; i++) {
        const w = `w${i} `;
        t.insert(i % 7 === 0 ? 0 : t.length, w);
        if (i % 7 === 0) words.unshift(w);
        else words.push(w);
      }
    });
    expect(d.toJSON()).toEqual({ t: words.join("") });
    expect(Doc.load(d.save()).toJSON()).toEqual(d.toJSON());
  });
});

describe("counters", () => {
  test("concurrent increments add up", () => {
    const docs = [A, B, C].map((a) => new Doc({ actor: a }));
    docs[0]!.change((r) => r.counter("likes").increment(0));
    sync(...docs);
    docs.forEach((d, i) => d.change((r) => r.counter("likes").increment(i + 1)));
    docs[1]!.change((r) => r.counter("likes").increment(-1));
    sync(...docs);
    for (const d of docs) expect(d.toJSON()).toEqual({ likes: 5 });
    expect(() => docs[0]!.change((r) => r.counter("likes").increment(0.5))).toThrow(TypeError);
  });
});

describe("history and causality", () => {
  test("out of order changes wait for their dependencies", () => {
    const x = new Doc({ actor: A });
    const c1 = x.change((r) => r.text("t").insert(0, "uno "))!;
    const c2 = x.change((r) => r.text("t").insert(4, "dos "))!;
    const c3 = x.change((r) => r.set("fin", true))!;
    const y = new Doc({ actor: B });
    y.apply([c3, c2]);
    expect(y.toJSON()).toEqual({});
    expect(y.missing).toBe(2);
    y.apply([c1, c1, c2]);
    expect(y.missing).toBe(0);
    expect(y.toJSON()).toEqual(x.toJSON());
  });

  test("save and load", () => {
    const x = new Doc({ actor: A });
    x.change((r) => {
      r.text("t").insert(0, "hola");
      r.list("l").push(1);
    });
    const y = new Doc({ actor: B });
    y.apply(x.changes());
    y.change((r) => r.counter("c").increment(2));
    const z = Doc.load(y.save(), { actor: C });
    expect(z.toJSON()).toEqual(y.toJSON());
    expect(z.version()).toEqual(y.version());
    expect(() => Doc.load(new Uint8Array([1, 2, 3]))).toThrow(CodecError);
  });

  test("subscribers hear local and remote changes", () => {
    const x = new Doc({ actor: A });
    const y = new Doc({ actor: B });
    const seen: string[] = [];
    y.subscribe((chs, local) => seen.push(`${local ? "local" : "remote"}:${chs.length}`));
    x.change((r) => r.set("a", 1));
    sync(x, y);
    y.change((r) => r.set("b", 2));
    expect(seen).toEqual(["remote:1", "local:1"]);
  });

  test("changes since a version vector", () => {
    const x = new Doc({ actor: A });
    x.change((r) => r.set("a", 1));
    const v = x.version();
    x.change((r) => r.set("b", 2));
    expect(x.changes(v)).toHaveLength(1);
    expect(x.changes()).toHaveLength(2);
  });
});

describe("binary format", () => {
  test("round trips every op type", () => {
    const x = new Doc({ actor: A });
    const y = new Doc({ actor: B });
    y.change((r) => r.list("l").push("from b"));
    x.apply(y.changes());
    const blob = x.change((r) => {
      r.set("s", "é");
      r.set("i", -42);
      r.set("f", 1.5);
      r.map("m");
      r.delete("s");
      const l = r.list("l");
      l.insert(0, true);
      l.insertText(1).insert(0, "ñ👍");
      l.delete(0);
      r.counter("c").increment(-3);
    })!;
    const ch = decodeChange(blob);
    expect(ch.actor).toBe(A);
    expect(ch.deps.get(B)).toBe(1);
    expect(encodeChange(ch)).toEqual(blob);
  });

  test("rejects malformed input", () => {
    const blob = new Doc({ actor: A }).change((r) => r.set("k", "v"))!;
    expect(() => decodeChange(blob.slice(0, blob.length - 1))).toThrow(CodecError);
    expect(() => decodeChange(new Uint8Array([...blob, 0]))).toThrow(CodecError);
    const bad = blob.slice();
    bad[0] = 0;
    expect(() => decodeChange(bad)).toThrow(CodecError);
    expect(() => new Doc({ actor: "nope" })).toThrow(TypeError);
  });
});
