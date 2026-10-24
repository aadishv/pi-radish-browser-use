import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUN_PATH = fileURLToPath(import.meta.url);
// Scripts live inside this package, so `import ... from "pi-browser-use"` and its dependencies resolve.
const SCRIPT_DIR = join(dirname(RUN_PATH), ".runtime", "scripts");

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs `code` as a TypeScript module in a fresh Node process. Resolves to its stdout and stderr, interleaved. */
export async function runScript(code: string, { cwd, env, timeoutMs, signal }: RunOptions): Promise<string> {
  if (signal?.aborted) throw new Error("Cancelled");
  mkdirSync(SCRIPT_DIR, { recursive: true });
  const file = join(SCRIPT_DIR, `${randomUUID()}.ts`);
  writeFileSync(file, code);

  const child = spawn(process.execPath, [RUN_PATH, file], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let stopped: string | undefined;
  const stop = (reason: string) => {
    stopped ??= reason;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => stop(`Timed out after ${timeoutMs / 1_000} seconds`), timeoutMs);
  const abort = () => stop("Cancelled");
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    // Node prints uncaught errors, with their location, to stderr.
    if (stopped || exitCode !== 0) throw new Error(`${output.replace(/\s+$/, "")}\n\n${stopped ?? `Exited with code ${exitCode}`}`.trim());
    return output;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    rmSync(file, { force: true });
  }
}

if (process.argv[1] === RUN_PATH) {
  const scriptUrlPrefix = pathToFileURL(SCRIPT_DIR + "/").href;
  // The script runs in the project's cwd, so relative imports, and bare imports this package lacks, resolve there too.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.parentURL?.startsWith(scriptUrlPrefix)) return nextResolve(specifier, context);
      const fromCwd = { ...context, parentURL: pathToFileURL(join(process.cwd(), "/")).href };
      if (/^\.\.?\//.test(specifier)) return nextResolve(specifier, fromCwd);
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        try {
          return nextResolve(specifier, fromCwd);
        } catch {
          throw error;
        }
      }
    },
  });
  await import(pathToFileURL(process.argv[2]!).href);
  // Snippets often leave a browser connected; once the module has run, flush output and exit anyway.
  process.stdout.write("", () => process.stderr.write("", () => process.exit()));
}
