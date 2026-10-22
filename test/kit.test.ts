import assert from "node:assert/strict";
import { test } from "node:test";
import { rotation } from "../src/kit/models.ts";
import { filesRead, makeShards, unread } from "../src/kit/coverage.ts";

test("rotation starts at the index and moves avoided models last", () => {
  const list = ["a/x:high", "b/y:high", "c/z"];
  assert.deepEqual(rotation(list, 0), ["a/x:high", "b/y:high", "c/z"]);
  assert.deepEqual(rotation(list, 4), ["b/y:high", "c/z", "a/x:high"]);
  assert.deepEqual(rotation(list, 0, ["a/x:low"]), ["b/y:high", "c/z", "a/x:high"]);
  assert.deepEqual(rotation(["a/x"], 3, ["a/x"]), ["a/x"]);
});

test("makeShards puts changed files first without counting them, then fills shards in path order", () => {
  const inv = new Map([["a.go", 10], ["b.go", 10], ["c/d.go", 10], ["c/e.go", 5]]);
  const shards = makeShards(inv, ["b.go", "c/d.go", "c/e.go"], ["a.go", "gone.go"], 2, 12);
  assert.deepEqual(shards, [["a.go", "b.go"], ["c/d.go"]]);
  // A file larger than the budget still gets a shard of its own.
  assert.deepEqual(makeShards(new Map([["big.go", 100]]), ["big.go"], [], 1, 12), [["big.go"]]);
});

test("unread leaves out visited files and files missed too often", () => {
  const inv = new Map([["a", 1], ["b", 1], ["c", 1]]);
  assert.deepEqual(unread(inv, new Set(["a"]), { b: 3 }), ["c"]);
});

test("filesRead counts read calls and file-printing commands, not searches", () => {
  const inv = new Map([["a.go", 1], ["pkg/b.go", 1], ["c.go", 1], ["d.go", 1]]);
  const got = filesRead("/w", ["/w/a.go", "/elsewhere/c.go"], ["sed -n 1,80p pkg/b.go | head", "rg foo c.go", "cd x && cat ./d.go"], inv);
  assert.deepEqual(got.sort(), ["a.go", "d.go", "pkg/b.go"]);
});
