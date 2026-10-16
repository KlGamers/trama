import { describe, expect, test } from "vitest";
import { CodecError, type Msg, MsgType, decodeMsg, encodeMsg } from "../src/index.js";

describe("sync protocol", () => {
  test("round trips every message", () => {
    const vv = new Map([["0123456789abcdef0123456789abcdef", 7]]);
    for (const m of [
      { t: MsgType.Hello, doc: "notas", token: "a.b", vv },
      { t: MsgType.Changes, blobs: [new Uint8Array([1, 2]), new Uint8Array(0)] },
      { t: MsgType.Welcome, write: true, vv },
      { t: MsgType.Error, code: 4, text: "falta un cambio" },
    ] as Msg[]) {
      expect(decodeMsg(encodeMsg(m))).toEqual(m);
    }
  });

  test("rejects garbage", () => {
    for (const b of [[], [9], [1, 2], [2, 5], [4, 1]]) expect(() => decodeMsg(new Uint8Array(b))).toThrow(CodecError);
  });
});
