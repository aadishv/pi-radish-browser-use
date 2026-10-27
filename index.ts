import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, highlightCode, keyHint, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PACKAGE_DIR } from "./daemon.ts";
import { runScript } from "./run.ts";

const SKILL_PATH = join(PACKAGE_DIR, "skills", "browser-use", "SKILL.md");
const SKILL_COMMANDS = ["/skill:browser-use", "$browser-use"];
const CALL_PREVIEW_LINES = 10;
const TOOL_NAME = "execute_browser_code";

function formatResult(output: string): string {
  const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncation.truncated) return truncation.content;
  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
}

function realpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Pi lists the skill under whatever path it loaded the package from, so compare files, not path strings. */
function isSkillRead(input: unknown, cwd: string): boolean {
  const path = (input as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string") return false;
  const expanded = path.replace(/^@/, "").replace(/^~(?=$|\/)/, homedir());
  return realpath(resolve(cwd, expanded)) === realpath(SKILL_PATH);
}

export default function browserUseExtension(pi: ExtensionAPI) {
  // Deferred tools stay undeclared until activated. Pi records the active set in the session, so
  // resumed sessions get the tool back on their own.
  pi.registerTool({
    name: TOOL_NAME,
    exposure: "deferred",
    label: "Execute Browser Code",
    description: "Run a TypeScript module in Node, in the project's cwd, that drives a browser through the browser-use SDK",
    promptSnippet: "Drive a browser with TypeScript through the browser-use SDK",
    promptGuidelines: [
      "Every execute_browser_code call needs a concise intent and an explicit timeout in seconds (10 unless the action needs more).",
      "In execute_browser_code, connectBrowser() gets this session's private headless browser; use connectBrowser({ browser: \"user\" }) only when the task needs the user's own tabs, logins, or cookies.",
    ],
    parameters: Type.Object({
      intent: Type.String({ minLength: 1, description: "Concise summary of the action, shown to the user (for example, 'Screenshot the landing page')." }),
      timeout: Type.Number({ minimum: 0.1, maximum: 300, default: 10, description: "End-to-end timeout in seconds. Use 10 unless the action needs a different limit." }),
      code: Type.String({ description: "TypeScript module run with Node in the project's cwd, after `import { connectBrowser } from \"pi-browser-use\"`. Its stdout and stderr are the result." }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const output = await runScript(params.code, {
        cwd: ctx.cwd,
        env: { BROWSER_USE_SESSION: ctx.sessionManager.getSessionId() },
        timeoutMs: (params.timeout ?? 10) * 1_000,
        signal,
      }).catch((error: Error) => {
        throw new Error(formatResult(error.message));
      });
      return { content: [{ type: "text", text: formatResult(output) || "(no output)" }], details: {} };
    },
    renderCall(args, theme, { expanded }) {
      let text = theme.fg("toolTitle", theme.bold(TOOL_NAME));
      if (args.intent) text += theme.fg("muted", ` ${args.intent}`);

      const code = typeof args.code === "string" ? args.code.replace(/\s+$/, "") : "";
      if (code) {
        const lines = highlightCode(code, "typescript");
        const shown = expanded ? lines : lines.slice(0, CALL_PREVIEW_LINES);
        text += `\n\n${shown.join("\n")}`;
        const remaining = lines.length - shown.length;
        if (remaining > 0) {
          const hint = keyHint("app.tools.expand", "to expand");
          text += theme.fg("muted", `\n… ${remaining} more line${remaining === 1 ? "" : "s"} (${lines.length} total, `) + hint + theme.fg("muted", ")");
        }
      }
      return new Text(text, 0, 0);
    },
  });

  const isActive = () => pi.getActiveTools().includes(TOOL_NAME);

  const activate = (ctx: ExtensionContext) => {
    if (isActive()) return;
    pi.setActiveTools([...pi.getActiveTools(), TOOL_NAME]);
    ctx.ui.setStatus("browser-use", "browser use enabled");
  };

  pi.on("session_start", async (_event, ctx) => {
    // Scripts run through bash share this session's headless browser too.
    process.env.BROWSER_USE_SESSION = ctx.sessionManager.getSessionId();
    if (isActive()) ctx.ui.setStatus("browser-use", "browser use enabled");
  });

  pi.on("input", async (event, ctx) => {
    if (SKILL_COMMANDS.some((command) => event.text.includes(command))) activate(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "read" && !event.isError && isSkillRead(event.input, ctx.cwd)) activate(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("browser-use", undefined);
  });
}
