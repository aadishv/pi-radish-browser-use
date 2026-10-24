import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

export const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
export const DAEMON_PATH = fileURLToPath(import.meta.url);
export const RUNTIME_DIR = join(PACKAGE_DIR, ".runtime");
export const LOG_PATH = join(RUNTIME_DIR, "daemon.log");
const CONFIG_PATH = join(PACKAGE_DIR, ".bridge.json");
const EXECUTABLE_PATH = join(RUNTIME_DIR, "browser-executable");
const PROFILE_PREFIX = "browser-use-profile-";
const SESSION_GRACE_MS = 60_000;
const HOST = "127.0.0.1";
const DEFAULT_PORT = 32123;
const MAX_PAYLOAD = 64 * 1024 * 1024;
const KNOWN_BROWSERS = process.platform === "darwin"
  ? ["Helium", "Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge"].map((name) => `/Applications/${name}.app/Contents/MacOS/${name}`)
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/brave-browser", "/usr/bin/microsoft-edge"];

export interface Config {
  token: string;
  port: number;
}

export function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, `${JSON.stringify({ token: randomBytes(32).toString("base64url"), port: DEFAULT_PORT }, null, 2)}\n`, { mode: 0o600 });
  }
  const { token, port = DEFAULT_PORT } = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (typeof token !== "string" || token.length < 32) throw new Error(`${CONFIG_PATH} must contain a token of at least 32 characters`);
  return { token, port };
}

/** Changes whenever the daemon's code does, so a stale daemon gets restarted. */
function daemonVersion(): string {
  return createHash("sha256").update(readFileSync(DAEMON_PATH)).digest("hex").slice(0, 12);
}

export async function daemonStatus(port: number): Promise<{ pid: number; version: string; extensionConnected: boolean } | null> {
  try {
    const response = await fetch(`http://${HOST}:${port}/status`, { signal: AbortSignal.timeout(1_000) });
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

/** Starts the daemon, replacing one that runs older code, and returns how to reach it. */
export async function ensureDaemon(): Promise<Config> {
  const config = readConfig();
  const version = daemonVersion();
  const status = await daemonStatus(config.port);
  if (status?.version === version) return config;
  if (status) {
    try {
      process.kill(status.pid, "SIGTERM");
    } catch {}
    await waitUntil(async () => !(await daemonStatus(config.port)), `Old browser daemon (pid ${status.pid}) did not stop`);
  }
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  let size = 0;
  try {
    size = statSync(LOG_PATH).size;
  } catch {}
  const log = openSync(LOG_PATH, size > 1_000_000 ? "w" : "a", 0o600);
  spawn(process.execPath, [DAEMON_PATH, "serve"], { detached: true, stdio: ["ignore", log, log] }).unref();
  closeSync(log);
  await waitUntil(async () => (await daemonStatus(config.port))?.version === version, `Browser daemon did not start. See ${LOG_PATH}`);
  return config;
}

function safeTokenEquals(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
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
  const detected = existsSync(EXECUTABLE_PATH) ? readFileSync(EXECUTABLE_PATH, "utf8").trim() : undefined;
  const found = [process.env.BROWSER_EXECUTABLE, detected, ...KNOWN_BROWSERS].find((path) => path && existsSync(path));
  if (!found) throw new Error("No Chromium-based browser found. Set BROWSER_EXECUTABLE in the daemon's environment.");
  return found;
}

/** Records the binary of the browser the extension runs in, so headless sessions use the same one. */
function detectExtensionBrowser(peerPort: number | undefined): void {
  if (!peerPort || process.platform === "win32") return;
  try {
    const ps = (pid: number, field: string) => execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim();
    const peer = execFileSync("lsof", ["-nP", `-iTCP:${peerPort}`, "-sTCP:ESTABLISHED", "-Fp"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.startsWith("p"))
      .map((line) => Number(line.slice(1)))
      .find((pid) => pid !== process.pid);
    // The socket usually belongs to a helper process (`--type=utility`); walk up to the browser itself.
    for (let pid = peer ?? 0; pid > 1; pid = Number(ps(pid, "ppid"))) {
      if (ps(pid, "args").includes("--type=")) continue;
      const executable = process.platform === "linux" ? readlinkSync(`/proc/${pid}/exe`) : ps(pid, "comm");
      writeFileSync(EXECUTABLE_PATH, executable);
      log(`extension browser: ${executable}`);
      return;
    }
  } catch (error) {
    log(`could not detect the extension's browser: ${errorText(error)}`);
  }
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
// Sessions: each owns one headless browser, shared by a pi session and the scripts it runs

interface Session {
  id: string;
  clients: Set<WebSocket>;
  /** How long the browser outlives its last client, so named sessions survive between scripts and pi reloads. */
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
  const upstream = new WebSocket((await session.headless).wsUrl, { maxPayload: MAX_PAYLOAD });
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
  const config = readConfig();
  const version = daemonVersion();
  // Headless browsers die with the daemon that launched them, so any profile left behind is stale.
  for (const entry of readdirSync(tmpdir())) {
    if (entry.startsWith(PROFILE_PREFIX)) rmSync(join(tmpdir(), entry), { recursive: true, force: true });
  }

  // The Chrome extension is shared by every script connected to the user's browser. Request IDs are
  // rewritten so responses find their script, and each attached tab belongs to the script that attached it.
  let extension: WebSocket | null = null;
  const sdkClients = new Set<WebSocket>();
  const inflight = new Map<number, { client: WebSocket; id: number; method: string }>();
  const tabOwners = new Map<string, WebSocket>();
  let nextId = 0;

  const releaseTabs = (client: WebSocket) => {
    for (const [sessionId, owner] of tabOwners) {
      if (owner !== client) continue;
      tabOwners.delete(sessionId);
      send(extension, { id: ++nextId, method: "Target.detachFromTarget", params: { sessionId } });
    }
    for (const [id, entry] of inflight) if (entry.client === client) inflight.delete(id);
  };

  const fromExtension = (raw: string, message: any) => {
    if (message?.type === "keepalive") return send(extension, { type: "keepalive", ok: true });
    if (Number.isInteger(message?.id)) {
      const request = inflight.get(message.id);
      if (!request) return;
      inflight.delete(message.id);
      const tab = message.result?.sessionId;
      if (request.method === "Target.attachToTarget" && typeof tab === "string") {
        const owner = tabOwners.get(tab);
        if (owner && owner !== request.client && owner.readyState === WebSocket.OPEN) {
          return send(request.client, { id: request.id, error: { message: "That tab is controlled by another script" } });
        }
        tabOwners.set(tab, request.client);
      }
      return send(request.client, { ...message, id: request.id });
    }
    const tab = message?.sessionId ?? message?.params?.sessionId;
    const owner = typeof tab === "string" ? tabOwners.get(tab) : undefined;
    if (message?.method === "Target.detachedFromTarget") tabOwners.delete(tab);
    send(owner, raw);
  };

  const fromSdk = (client: WebSocket, message: any) => {
    if (!Number.isInteger(message?.id) || typeof message?.method !== "string") return;
    if (extension?.readyState !== WebSocket.OPEN) {
      return send(client, { id: message.id, error: { message: "The browser-use Chrome extension is not connected" } });
    }
    const owner = message.sessionId ? tabOwners.get(message.sessionId) : undefined;
    if (owner && owner !== client) return send(client, { id: message.id, error: { message: "That tab is controlled by another script" } });
    const id = ++nextId;
    inflight.set(id, { client, id: message.id, method: message.method });
    send(extension, { ...message, id });
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  httpServer.on("upgrade", (request, socket, head) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) return void socket.destroy();
    wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit("connection", webSocket, request));
  });

  wss.on("connection", (socket: WebSocket, request) => {
    const origin = request.headers.origin;
    // "user" and "isolated" are SDK connections; "pi" only holds a session open between scripts.
    let role: "extension" | "user" | "isolated" | "pi" | undefined;
    let session: Session | undefined;
    let upstream: WebSocket | undefined;
    const helloTimer = setTimeout(() => socket.close(1008, "hello timeout"), 3_000);
    const reject = (error: string) => {
      send(socket, { type: "hello", ok: false, error });
      socket.close(1008, error);
    };

    socket.on("message", async (data, isBinary) => {
      if (isBinary) return void socket.close(1003, "text messages only");
      let message: any;
      try {
        message = JSON.parse(String(data));
      } catch {
        return void socket.close(1007, "invalid JSON");
      }

      if (role === "extension") return fromExtension(String(data), message);
      if (role === "user") return fromSdk(socket, message);
      if (role === "isolated") return send(upstream, String(data));
      if (role === "pi") return message?.type === "end" ? closeSession(session!) : undefined;

      if (message?.type !== "hello" || !safeTokenEquals(message.token, config.token)) return reject("Invalid hello");
      // Only the Chrome extension may connect from a browser, so web pages can never reach the daemon.
      if (message.role === "extension" ? !origin?.startsWith("chrome-extension://") : origin !== undefined) {
        return reject("Unexpected origin");
      }
      clearTimeout(helloTimer);
      if (message.role === "extension") {
        role = "extension";
        extension?.close(1012, "replaced by a new extension connection");
        extension = socket;
        send(socket, { type: "hello", ok: true, protocolVersion: 1 });
        for (const client of sdkClients) send(client, { type: "status", extensionConnected: true });
        detectExtensionBrowser(request.socket.remotePort);
      } else if (message.role === "sdk" && message.browser === "user") {
        role = "user";
        sdkClients.add(socket);
        send(socket, { type: "hello", ok: true, protocolVersion: 1, extensionConnected: extension?.readyState === WebSocket.OPEN });
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
        send(socket, { type: "hello", ok: true, protocolVersion: 1 });
      } else if (message.role === "pi" && typeof message.session === "string") {
        role = "pi";
        session = joinSession(message.session, socket);
        send(socket, { type: "hello", ok: true });
      } else {
        reject("Invalid hello");
      }
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (socket === extension) {
        extension = null;
        tabOwners.clear();
        for (const [id, entry] of inflight) send(entry.client, { id: entry.id, error: { message: "The Chrome extension disconnected" } });
        inflight.clear();
        for (const client of sdkClients) send(client, { type: "status", extensionConnected: false });
      }
      if (role === "user") {
        sdkClients.delete(socket);
        releaseTabs(socket);
      }
      upstream?.close();
      if (session) leaveSession(session, socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, HOST, resolve);
  });
  log(`daemon pid=${process.pid} version=${version} listening on ws://${HOST}:${config.port}`);

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
  process.umask(0o077);
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  if (command === "serve") return serve();
  const config = readConfig();
  const status = await daemonStatus(config.port);
  if (command === "setup") {
    console.log(`Load ${join(PACKAGE_DIR, "chrome")} as an unpacked extension, open its options, and paste:`);
    console.log(`  Bridge URL:    ws://${HOST}:${config.port}`);
    console.log(`  Pairing token: ${config.token}`);
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
