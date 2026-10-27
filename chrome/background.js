// Also hardcoded in daemon.ts.
const BRIDGE_URL = "ws://127.0.0.1:32123";
const CDP_VERSION = "1.3";
const RECONNECT_ALARM = "browser-use-reconnect";
const KEEPALIVE_MS = 20_000;

let socket = null;
let reconnectTimer = null;
let keepaliveTimer = null;
let connecting = false;
const sessions = new Map(); // sessionId -> targetId
const sessionByTarget = new Map();

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function setBadge(state) {
  const connected = state === "connected";
  chrome.action.setBadgeText({ text: connected ? "ON" : state === "error" ? "!" : "" });
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#188038" : "#b3261e" });
  chrome.action.setTitle({
    title: connected
      ? "Browser Use Bridge: connected"
      : state === "error"
        ? "Browser Use Bridge: configuration or connection error"
        : "Browser Use Bridge: disconnected",
  });
}

function clearTimers() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
  reconnectTimer = null;
  keepaliveTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer !== null || connecting || socket?.readyState === WebSocket.OPEN) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => {});
  }, 1_000);
}

async function connect() {
  if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  connecting = true;
  const { bridgeToken } = await chrome.storage.local.get("bridgeToken");
  if (!bridgeToken) {
    connecting = false;
    setBadge("error");
    return;
  }

  try {
    const nextSocket = new WebSocket(BRIDGE_URL);
    socket = nextSocket;
    nextSocket.addEventListener("open", () => {
      connecting = false;
      send({ type: "hello", role: "extension", token: bridgeToken });
    });
    nextSocket.addEventListener("message", (event) => {
      handleMessage(String(event.data)).catch((error) => {
        console.error("Browser bridge message failed", error);
      });
    });
    nextSocket.addEventListener("close", () => {
      if (socket !== nextSocket) return;
      socket = null;
      connecting = false;
      clearTimers();
      setBadge("disconnected");
      detachAll().catch(() => {});
      scheduleReconnect();
    });
    nextSocket.addEventListener("error", () => {
      if (socket === nextSocket) setBadge("disconnected");
    });
  } catch {
    connecting = false;
    scheduleReconnect();
  }
}

async function reconnect() {
  clearTimers();
  if (socket) {
    const old = socket;
    socket = null;
    old.close();
  }
  connecting = false;
  await detachAll();
  await connect();
}

async function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message?.type === "hello") {
    if (message.ok !== true) {
      setBadge("error");
      socket?.close(1008, "bridge rejected extension");
      return;
    }
    setBadge("connected");
    if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => send({ type: "keepalive" }), KEEPALIVE_MS);
    return;
  }
  if (message?.type === "keepalive") return;
  if (message?.type === "release") return detachAll();
  if (!Number.isInteger(message?.id) || typeof message?.method !== "string") return;

  try {
    const result = await dispatchCdp(message.method, message.params ?? {}, message.sessionId);
    send({ id: message.id, result: result ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
  } catch (error) {
    send({
      id: message.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    });
  }
}

async function dispatchCdp(method, params, sessionId) {
  if (sessionId) {
    const targetId = sessions.get(sessionId);
    if (!targetId) throw new Error(`Unknown CDP session ${sessionId}`);
    return chrome.debugger.sendCommand({ targetId }, method, params);
  }

  switch (method) {
    case "Target.getTargets":
      return { targetInfos: (await chrome.debugger.getTargets()).map(targetInfo) };
    case "Target.createTarget": {
      const tab = await chrome.tabs.create({ active: false, url: typeof params.url === "string" ? params.url : "about:blank" });
      if (tab.id === undefined) throw new Error("Chrome created a tab without an id");
      const target = await targetForTab(tab.id);
      return { targetId: target.id };
    }
    case "Target.attachToTarget":
      return attachTarget(params.targetId);
    case "Target.detachFromTarget":
      await detachSession(params.sessionId);
      return {};
    case "Target.closeTarget": {
      const target = (await chrome.debugger.getTargets()).find((candidate) => candidate.id === params.targetId);
      if (!target?.tabId) return { success: false };
      await chrome.tabs.remove(target.tabId);
      return { success: true };
    }
    default:
      throw new Error(`${method} requires a target sessionId or is not supported by the extension bridge`);
  }
}

function targetInfo(target) {
  return {
    targetId: target.id,
    type: target.type,
    title: target.title,
    url: target.url,
    attached: target.attached,
  };
}

async function targetForTab(tabId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const target = (await chrome.debugger.getTargets()).find((candidate) => candidate.tabId === tabId);
    if (target) return target;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Could not find a debugger target for tab ${tabId}`);
}

async function attachTarget(targetId) {
  if (typeof targetId !== "string") throw new Error("Target.attachToTarget requires targetId");
  const existing = sessionByTarget.get(targetId);
  if (existing) return { sessionId: existing };
  if (!(await chrome.debugger.getTargets()).some((candidate) => candidate.id === targetId)) throw new Error(`Unknown target ${targetId}`);
  await chrome.debugger.attach({ targetId }, CDP_VERSION);
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, targetId);
  sessionByTarget.set(targetId, sessionId);
  return { sessionId };
}

async function detachSession(sessionId) {
  if (typeof sessionId !== "string") throw new Error("Target.detachFromTarget requires sessionId");
  const targetId = sessions.get(sessionId);
  if (!targetId) return;
  sessions.delete(sessionId);
  sessionByTarget.delete(targetId);
  try {
    await chrome.debugger.detach({ targetId });
  } catch {
    // Already detached or target closed.
  }
}

async function detachAll() {
  const targetIds = [...sessions.values()];
  sessions.clear();
  sessionByTarget.clear();
  await Promise.allSettled(targetIds.map((targetId) => chrome.debugger.detach({ targetId })));
}

// Events come back with the debuggee passed to attach, which is always { targetId }.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const sessionId = sessionByTarget.get(source.targetId);
  if (sessionId) send({ method, params: params ?? {}, sessionId });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const sessionId = sessionByTarget.get(source.targetId);
  if (!sessionId) return;
  sessions.delete(sessionId);
  sessionByTarget.delete(source.targetId);
  send({ method: "Target.detachedFromTarget", params: { sessionId, targetId: source.targetId, reason } });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "reconnect") {
    reconnect().then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "status") {
    sendResponse({ connected: socket?.readyState === WebSocket.OPEN });
  }
  return false;
});

chrome.action.onClicked.addListener(() => {
  if (socket?.readyState === WebSocket.OPEN) chrome.runtime.openOptionsPage();
  else connect().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && socket?.readyState !== WebSocket.OPEN) connect().catch(() => {});
});

// Only here to wake the worker when Chrome starts; the top-level code below does the work.
chrome.runtime.onStartup.addListener(() => {});

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
connect().catch(() => {});
