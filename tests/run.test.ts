import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runScript } from "../run.ts";

const run = (code: string, timeoutMs = 10_000) => runScript(code, { cwd: tmpdir(), timeoutMs });

test("stdout and stderr are the result", async () => {
  assert.equal(await run(`console.log("out"); console.error("err")`), "out\nerr\n");
});

test("TypeScript, the SDK by package name, and bare imports resolve", async () => {
  const code = `import { connectBrowser } from "pi-browser-use"; import { WebSocket } from "ws"; const n: number = 1; console.log(typeof connectBrowser, typeof WebSocket, n)`;
  assert.equal(await run(code), "function function 1\n");
});

test("relative imports and paths resolve against the cwd", async () => {
  const cwd = mkdtempSync(`${tmpdir()}/run-cwd-`);
  writeFileSync(`${cwd}/helper.ts`, `export const value: string = "from cwd";`);
  const code = `import { value } from "./helper.ts"; import { readFileSync } from "node:fs"; console.log(value, readFileSync("helper.ts", "utf8").length)`;
  assert.equal(await runScript(code, { cwd, timeoutMs: 10_000 }), "from cwd 40\n");
});

test("errors carry the output and a location", async () => {
  await assert.rejects(run(`console.log("before"); throw new Error("boom")`), /before[\s\S]*Error: boom[\s\S]*Exited with code 1/);
  await assert.rejects(run(`const a = 1\nreturn a`), /\.ts:2[\s\S]*Return statement is not allowed/);
});

test("the process exits when the module is done, even with handles open", async () => {
  assert.equal(await run(`setInterval(() => {}, 1000); console.log("done")`), "done\n");
});

test("timeouts kill the script", async () => {
  await assert.rejects(run(`console.log("started"); await new Promise(() => setInterval(() => {}, 1000))`, 500), /started[\s\S]*Timed out after 0.5 seconds/);
});
