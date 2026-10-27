import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

export const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = fileURLToPath(import.meta.url);
const RUNTIME_DIR = join(PACKAGE_DIR, ".runtime");
const LOG_PATH = join(RUNTIME_DIR, "daemon.log");
const CONFIG_PATH = join(PACKAGE_DIR, ".bridge.json");
const PROFILE_PREFIX = "browser-use-profile-";
const SESSION_GRACE_MS = 30 * 60_000;
const HOST = "127.0.0.1";
// Also hardcoded in chrome/background.js.
const PORT = 32123;
export const DAEMON_URL = `ws://${HOST}:${PORT}`;
const KNOWN_BROWSERS = process.platform === "darwin"
  ? ["/Applications/Helium.app/Contents/MacOS/Helium"]
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/brave-browser", "/usr/bin/microsoft-edge"];

function readToken(): string {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, `${JSON.stringify({ token: randomBytes(32).toString("base64url") }, null, 2)}\n`, { mode: 0o600 });
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")).token;
}

/** Changes whenever the daemon's code does, so a stale daemon gets restarted. */
function daemonVersion(): string {
  return createHash("sha256").update(readFileSync(DAEMON_PATH)).digest("hex").slice(0, 12);
}

async function daemonStatus(): Promise<{ pid: number; version: string; extensionConnected: boolean } | null> {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/status`, { signal: AbortSignal.timeout(1_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function waitUntil(check: () => Promise<boolean>, error: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(error);
}

/** Starts the daemon, replacing one that runs older code, and returns the token to connect with. */
export async function ensureDaemon(): Promise<string> {
  const token = readToken();
  const version = daemonVersion();
  const status = await daemonStatus();
  if (status?.version === version) return token;
  if (status) {
    try {
      process.kill(status.pid, "SIGTERM");
    } catch {}
    await waitUntil(async () => !(await daemonStatus()), `Old browser daemon (pid ${status.pid}) did not stop`);
  }
  mkdirSync(RUNTIME_DIR, { recursive: true });
  let size = 0;
  try {
    size = statSync(LOG_PATH).size;
  } catch {}
  const log = openSync(LOG_PATH, size > 1_000_000 ? "w" : "a");
  spawn(process.execPath, [DAEMON_PATH, "serve"], { detached: true, stdio: ["ignore", log, log] }).unref();
  closeSync(log);
  await waitUntil(async () => (await daemonStatus())?.version === version, `Browser daemon did not start. See ${LOG_PATH}`);
  return token;
}

function send(socket: WebSocket | null | undefined, message: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(typeof message === "string" ? message : JSON.stringify(message));
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// Headless browsers

interface Headless {
  process: ChildProcess;
  wsUrl: string;
}

function browserExecutable(): string {
  const found = [process.env.BROWSER_EXECUTABLE, ...KNOWN_BROWSERS].find((path) => path && existsSync(path));
  if (!found) throw new Error("No Chromium-based browser found. Set BROWSER_EXECUTABLE in the daemon's environment.");
  return found;
}

async function launchHeadless(onExit: () => void): Promise<Headless> {
  const executable = browserExecutable();
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  const child = spawn(executable, [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    // Unused, except that Chrome exits when it closes, so a browser never outlives the daemon.
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  let spawnError: Error | undefined;
  child.once("error", (error) => (spawnError = error));
  child.once("exit", () => {
    rmSync(profile, { recursive: true, force: true });
    onExit();
  });

  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Could not start ${executable}: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${executable} exited during startup`);
    const [port, path] = existsSync(portFile) ? readFileSync(portFile, "utf8").trim().split("\n") : [];
    if (port && path) {
      log(`headless pid=${child.pid} ${executable}`);
      return { process: child, wsUrl: `ws://${HOST}:${port}${path}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGKILL");
  throw new Error(`${executable} did not start a DevTools endpoint within 15 seconds`);
}

function stopProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
}

// ---------------------------------------------------------------------------------------------
// Sessions: each owns one headless browser, shared by the scripts of one pi session

interface Session {
  id: string;
  clients: Set<WebSocket>;
  /** How long the browser outlives its last client, so a pi session's browser survives between scripts. */
  graceMs: number;
  headless?: Promise<Headless>;
  graceTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();

/** Scripts without a session id get a throwaway one that closes with them. */
function joinSession(id: string | undefined, client: WebSocket): Session {
  let session = id ? sessions.get(id) : undefined;
  if (!session) {
    session = { id: id ?? randomUUID(), clients: new Set(), graceMs: id ? SESSION_GRACE_MS : 0 };
    sessions.set(session.id, session);
    log(`session ${session.id} opened`);
  }
  clearTimeout(session.graceTimer);
  session.clients.add(client);
  return session;
}

function leaveSession(session: Session, client: WebSocket): void {
  session.clients.delete(client);
  if (session.clients.size === 0 && sessions.get(session.id) === session) {
    session.graceTimer = setTimeout(() => closeSession(session), session.graceMs);
  }
}

async function connectHeadless(session: Session): Promise<WebSocket> {
  if (!session.headless) {
    const launch = launchHeadless(() => {
      if (session.headless === launch) session.headless = undefined;
    });
    session.headless = launch;
    launch.catch(() => {
      if (session.headless === launch) session.headless = undefined;
    });
  }
  const upstream = new WebSocket((await session.headless).wsUrl);
  await new Promise((resolve, reject) => {
    upstream.once("open", resolve);
    upstream.once("error", reject);
  });
  return upstream;
}

function closeSession(session: Session): void {
  clearTimeout(session.graceTimer);
  sessions.delete(session.id);
  session.headless?.then((headless) => stopProcess(headless.process), () => {});
  log(`session ${session.id} closed`);
}

// ---------------------------------------------------------------------------------------------
// Server

async function serve(): Promise<void> {
  const token = readToken();
  const version = daemonVersion();
  // Headless browsers die with the daemon that launched them, so any profile left behind is stale.
  for (const entry of readdirSync(tmpdir())) {
    if (entry.startsWith(PROFILE_PREFIX)) rmSync(join(tmpdir(), entry), { recursive: true, force: true });
  }

  // The extension serves one script at a time. Request IDs are offset by that script's generation, so a
  // late response to a script that already exited is dropped instead of reaching its successor.
  let extension: WebSocket | null = null;
  let user: WebSocket | null = null;
  let generation = 0;
  const ID_SPACE = 2 ** 32;

  const fromExtension = (message: any) => {
    if (message?.type === "keepalive") return send(extension, { type: "keepalive", ok: true });
    if (!Number.isInteger(message?.id)) return send(user, message);
    if (Math.floor(message.id / ID_SPACE) === generation) send(user, { ...message, id: message.id % ID_SPACE });
  };

  const httpServer = createServer((request, response) => {
    if (request.url !== "/status") return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      pid: process.pid,
      version,
      extensionConnected: extension?.readyState === WebSocket.OPEN,
      sessions: [...sessions.values()].map((session) => ({ id: session.id, clients: session.clients.size, headless: !!session.headless })),
      uptimeSeconds: Math.round(process.uptime()),
    }));
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket: WebSocket, request) => {
    const origin = request.headers.origin;
    let role: "extension" | "user" | "isolated" | undefined;
    let session: Session | undefined;
    let upstream: WebSocket | undefined;
    const reject = (error: string) => {
      send(socket, { type: "hello", ok: false, error });
      socket.close(1008, error);
    };

    socket.on("message", async (data) => {
      let message: any;
      try {
        message = JSON.parse(String(data));
      } catch {
        return void socket.close(1007, "invalid JSON");
      }

      if (role === "extension") return fromExtension(message);
      if (role === "user") return send(extension, { ...message, id: generation * ID_SPACE + message.id });
      if (role === "isolated") return send(upstream, String(data));

      if (message?.type !== "hello" || message.token !== token) return reject("Invalid hello");
      // Only the Chrome extension may connect from a browser, so web pages can never reach the daemon.
      if (message.role === "extension" ? !origin?.startsWith("chrome-extension://") : origin !== undefined) {
        return reject("Unexpected origin");
      }
      if (message.role === "extension") {
        role = "extension";
        extension?.close(1012, "replaced by a new extension connection");
        extension = socket;
        send(socket, { type: "hello", ok: true });
      } else if (message.role === "sdk" && message.browser === "user") {
        // A freshly restarted daemon needs a moment for the extension to reconnect.
        try {
          await waitUntil(async () => extension?.readyState === WebSocket.OPEN, "");
        } catch {
          return reject("The user's browser is unreachable: the browser-use Chrome extension is not connected. Ask the user to click its toolbar icon, or to pair it if it was never set up.");
        }
        if (user) return reject("Another script is using the user's browser. Try again once it exits.");
        role = "user";
        user = socket;
        generation += 1;
        send(socket, { type: "hello", ok: true });
      } else if (message.role === "sdk" && message.browser === "isolated") {
        // Relay the script's CDP traffic to its session's headless browser.
        role = "isolated";
        session = joinSession(typeof message.session === "string" ? message.session : undefined, socket);
        try {
          upstream = await connectHeadless(session);
        } catch (error) {
          return reject(errorText(error));
        }
        if (socket.readyState !== WebSocket.OPEN) return void upstream.close();
        upstream.on("message", (upstreamData) => send(socket, String(upstreamData)));
        upstream.on("close", () => socket.close(1011, "The headless browser closed"));
        send(socket, { type: "hello", ok: true });
      } else {
        reject("Invalid hello");
      }
    });

    socket.on("close", () => {
      if (socket === extension) {
        extension = null;
        user?.close(1011, "The Chrome extension disconnected");
      }
      if (socket === user) {
        user = null;
        // Detaches the script's tabs, which also removes Chrome's "started debugging" bar.
        send(extension, { type: "release" });
      }
      upstream?.close();
      if (session) leaveSession(session, socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(PORT, HOST, resolve);
  });
  log(`daemon pid=${process.pid} version=${version} listening on ${DAEMON_URL}`);

  const shutdown = () => {
    for (const session of sessions.values()) closeSession(session);
    for (const client of wss.clients) client.close(1001, "daemon stopping");
    httpServer.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function main(command: string): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (command === "serve") return serve();
  const status = await daemonStatus();
  if (command === "setup") {
    console.log(`Load ${join(PACKAGE_DIR, "chrome")} as an unpacked extension, open its options, and paste this pairing token:`);
    console.log(`  ${readToken()}`);
  } else if (command === "status") {
    console.log(status ? JSON.stringify(status, null, 2) : "Daemon is not running");
  } else if (command === "stop") {
    if (status) process.kill(status.pid, "SIGTERM");
    console.log(status ? `Stopped daemon pid ${status.pid}` : "Daemon is not running");
  } else {
    throw new Error("Usage: node daemon.ts setup|status|stop|serve");
  }
}

if (process.argv[1] === DAEMON_PATH) {
  main(process.argv[2] ?? "status").catch((error) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}
