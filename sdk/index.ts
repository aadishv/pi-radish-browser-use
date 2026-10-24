import { writeFile } from "node:fs/promises";
import { ensureDaemon } from "../daemon.ts";
import type { ScreencastOptions, ScreencastResult } from "./screencast-types.ts";

export { ScreencastError, type ScreencastOptions, type ScreencastResult } from "./screencast-types.ts";

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_NAVIGATION_TIMEOUT = 30_000;

type CdpId = number;
type JsonObject = Record<string, unknown>;
type MessageListener = (params: JsonObject, message: CdpEvent) => void;

interface CdpResponse {
  id: CdpId;
  result?: JsonObject;
  error?: { code?: number; message?: string; data?: unknown };
  sessionId?: string;
}

interface CdpEvent {
  method: string;
  params?: JsonObject;
  sessionId?: string;
}

interface BridgeHello {
  type: "hello";
  role: "sdk";
  token: string;
  protocolVersion: 1;
  browser: "isolated" | "user";
  session?: string;
}

interface BridgeControl {
  type: "hello" | "status" | "keepalive";
  ok?: boolean;
  error?: string;
  extensionConnected?: boolean;
}

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
  browserContextId?: string;
}

export interface ConnectBrowserOptions {
  /**
   * isolated (default): a private headless browser, shared by every script with the same BROWSER_USE_SESSION
   * (pi sets it to the session id), or this script's own if unset. user: the user's browser, through the extension.
   */
  browser?: "isolated" | "user";
  /** Some other DevTools endpoint instead: a browser WebSocket URL, or an HTTP base URL exposing /json/version. */
  cdpUrl?: string;
  timeoutMs?: number;
}

export interface SnapshotOptions {
  compact?: boolean;
}

export interface LocatorFilterOptions {
  hasText?: string | RegExp;
  visible?: boolean;
}

export interface RoleLocatorOptions {
  name?: string | RegExp;
  exact?: boolean;
}

export interface TextLocatorOptions {
  exact?: boolean;
}

export interface WaitForLocatorOptions {
  state?: "attached" | "detached" | "visible" | "hidden";
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function resolveCdpWebSocketUrl(url: string): Promise<string> {
  if (url.startsWith("ws://") || url.startsWith("wss://")) return url;
  const base = new URL(url);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`Unsupported CDP URL protocol: ${base.protocol}`);
  }
  const endpoint = new URL("/json/version", base);
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`CDP discovery failed: ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string") {
    throw new Error(`CDP discovery response from ${endpoint} did not include webSocketDebuggerUrl`);
  }
  return body.webSocketDebuggerUrl;
}

class CdpConnection {
  readonly backend: "extension" | "cdp";
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #hello?: BridgeHello;
  #ws?: WebSocket;
  #nextId = 0;
  #pending = new Map<number, {
    method: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (result: JsonObject) => void;
    reject: (error: Error) => void;
  }>();
  #listeners = new Map<string, Set<MessageListener>>();
  #openPromise?: Promise<void>;
  #helloResolve?: () => void;
  #helloReject?: (error: Error) => void;
  #extensionResolve?: () => void;
  #extensionReady = false;
  #closed = false;

  constructor(url: string, backend: "extension" | "cdp", timeoutMs: number, hello?: BridgeHello) {
    this.#url = url;
    this.backend = backend;
    this.#timeoutMs = timeoutMs;
    this.#hello = hello;
  }

  async connect(): Promise<void> {
    if (this.#openPromise) return this.#openPromise;
    this.#openPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(this.#url);
      this.#ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) {
          ws.close();
          rejectPromise(new Error(`Timed out connecting to ${this.#url}`));
        }
      }, this.#timeoutMs);

      ws.addEventListener("open", () => {
        opened = true;
        clearTimeout(timer);
        if (!this.#hello) {
          this.#extensionReady = true;
          resolvePromise();
          return;
        }
        const helloPromise = new Promise<void>((helloResolve, helloReject) => {
          this.#helloResolve = helloResolve;
          this.#helloReject = helloReject;
        });
        ws.send(JSON.stringify(this.#hello));
        helloPromise.then(resolvePromise, rejectPromise);
      });

      ws.addEventListener("message", (event) => this.#handleMessage(String(event.data)));
      ws.addEventListener("error", () => {
        if (!opened) {
          clearTimeout(timer);
          rejectPromise(new Error(`Could not connect to ${this.#url}`));
        }
      });
      ws.addEventListener("close", () => {
        this.#closed = true;
        this.#rejectAll(new Error(`CDP connection to ${this.#url} closed`));
      });
    });
    return this.#openPromise;
  }

  async waitForExtension(timeoutMs = this.#timeoutMs): Promise<void> {
    if (this.backend !== "extension" || this.#extensionReady) return;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.#extensionResolve = resolvePromise;
      const timer = setTimeout(() => {
        if (this.#extensionResolve === resolvePromise) this.#extensionResolve = undefined;
        rejectPromise(
          new Error(
            "The user's browser is unreachable: the browser-use Chrome extension is not connected. Ask the user to click its toolbar icon, or to pair it if it was never set up.",
          ),
        );
      }, timeoutMs);
      const wrappedResolve = () => {
        clearTimeout(timer);
        resolvePromise();
      };
      this.#extensionResolve = wrappedResolve;
    });
  }

  async send<T extends JsonObject = JsonObject>(method: string, params: JsonObject = {}, sessionId?: string): Promise<T> {
    await this.connect();
    await this.waitForExtension();
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN || this.#closed) {
      throw new Error("CDP connection is not open");
    }
    const id = ++this.#nextId;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for CDP method ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, {
        method,
        timer,
        resolve: (result) => resolvePromise(result as T),
        reject: rejectPromise,
      });
      this.#ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, listener: MessageListener): () => void {
    const listeners = this.#listeners.get(method) ?? new Set<MessageListener>();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(method);
    };
  }

  waitForEvent(method: string, options: { sessionId?: string; timeoutMs?: number } = {}): Promise<JsonObject> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    return new Promise((resolvePromise, rejectPromise) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        rejectPromise(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      off = this.on(method, (params, message) => {
        if (options.sessionId && message.sessionId !== options.sessionId) return;
        clearTimeout(timer);
        off();
        resolvePromise(params);
      });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    this.#closed = true;
    this.#ws?.close();
    this.#rejectAll(new Error("CDP connection closed"));
  }

  #handleMessage(raw: string): void {
    let message: CdpResponse | CdpEvent | BridgeControl;
    try {
      message = JSON.parse(raw) as CdpResponse | CdpEvent | BridgeControl;
    } catch {
      return;
    }

    if ("type" in message) {
      if (message.type === "hello") {
        if (message.ok === false) {
          this.#helloReject?.(new Error(message.error ?? "Browser bridge rejected the SDK connection"));
        } else {
          this.#extensionReady = message.extensionConnected === true;
          this.#helloResolve?.();
          if (this.#extensionReady) this.#extensionResolve?.();
        }
        this.#helloResolve = undefined;
        this.#helloReject = undefined;
      } else if (message.type === "status") {
        this.#extensionReady = message.extensionConnected === true;
        if (this.#extensionReady) {
          this.#extensionResolve?.();
          this.#extensionResolve = undefined;
        } else {
          this.#rejectAll(new Error("Chrome extension disconnected from the browser bridge"));
        }
      }
      return;
    }

    if ("id" in message) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) {
        const suffix = message.error.code === undefined ? "" : ` (${message.error.code})`;
        pending.reject(new Error(`${pending.method}: ${message.error.message ?? "CDP error"}${suffix}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if ("method" in message) {
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params ?? {}, message);
      }
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export class Browser {
  readonly backend: "extension" | "cdp";
  readonly #connection: CdpConnection;
  readonly #sessions = new Map<string, string>();

  constructor(connection: CdpConnection) {
    this.#connection = connection;
    this.backend = connection.backend;
  }

  get connected(): boolean {
    return !this.#connection.closed;
  }

  /** Sends a browser-level CDP command. */
  send<T extends JsonObject = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    return this.#connection.send<T>(method, params);
  }

  async tabs(): Promise<TargetInfo[]> {
    const { targetInfos } = await this.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    return targetInfos.filter(
      (target) =>
        typeof target.targetId === "string" &&
        target.type === "page" &&
        !target.url.startsWith("chrome://") &&
        !target.url.startsWith("chrome-extension://"),
    );
  }

  async newPage(url = "about:blank"): Promise<Page> {
    const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url });
    return this.page(targetId);
  }

  async page(targetIdOrPrefix: string): Promise<Page> {
    const tabs = await this.tabs();
    const exact = tabs.find((tab) => tab.targetId === targetIdOrPrefix);
    const matches = exact ? [exact] : tabs.filter((tab) => tab.targetId.startsWith(targetIdOrPrefix));
    if (matches.length === 0) throw new Error(`No page target matches ${targetIdOrPrefix}`);
    if (matches.length > 1) throw new Error(`Page target prefix ${targetIdOrPrefix} is ambiguous`);
    const target = matches[0]!;
    let sessionId = this.#sessions.get(target.targetId);
    if (!sessionId) {
      const attached = await this.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      sessionId = attached.sessionId;
      this.#sessions.set(target.targetId, sessionId);
    }
    return new Page(this.#connection, target.targetId, sessionId);
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.#sessions.values()].map((sessionId) =>
        this.send("Target.detachFromTarget", { sessionId }),
      ),
    );
    this.#sessions.clear();
    this.#connection.close();
  }
}

export class Page {
  readonly targetId: string;
  readonly sessionId: string;
  readonly #connection: CdpConnection;
  #screencasting = false;

  constructor(connection: CdpConnection, targetId: string, sessionId: string) {
    this.#connection = connection;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  /** Sends an exact target-session CDP command. */
  send<T extends JsonObject = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    return this.#connection.send<T>(method, params, this.sessionId);
  }

  on(method: string, listener: (params: JsonObject) => void): () => void {
    return this.#connection.on(method, (params, message) => {
      if (message.sessionId === this.sessionId) listener(params);
    });
  }

  async screencast<T>(
    action: () => T | Promise<T>,
    options: ScreencastOptions = {},
  ): Promise<ScreencastResult<T>> {
    if (this.#screencasting) throw new Error("A screencast is already running on this page");
    this.#screencasting = true;
    try {
      const { recordScreencast } = await import("./screencast.ts");
      return await recordScreencast(this, action, options);
    } finally {
      this.#screencasting = false;
    }
  }

  async goto(url: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const parsed = new URL(url);
    if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
      throw new Error(`Unsupported navigation protocol: ${parsed.protocol}`);
    }
    await this.send("Page.enable");
    const result = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (result.errorText) throw new Error(result.errorText);
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT);
    while (Date.now() < deadline) {
      try {
        if ((await this.evaluate<string>("document.readyState")) === "complete") return;
      } catch {
        // Execution contexts are briefly unavailable during navigation.
      }
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${url} to finish loading`);
  }

  async evaluate<T = unknown>(expression: string | ((...args: any[]) => unknown), ...args: unknown[]): Promise<T> {
    const source =
      typeof expression === "function"
        // Transpilers such as esbuild/tsx may insert __name(...) calls into a
        // function's source. Provide a harmless local shim when serializing it
        // for execution in the page.
        ? `(() => { const __name = (target) => target; return (${expression.toString()})(...${JSON.stringify(args)}); })()`
        : expression;
    await this.send("Runtime.enable");
    const response = await this.send<{
      result: { value?: T; unserializableValue?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Browser evaluation failed",
      );
    }
    if (response.result.unserializableValue !== undefined) {
      return response.result.unserializableValue as T;
    }
    return response.result.value as T;
  }

  title(): Promise<string> {
    return this.evaluate<string>("document.title");
  }

  url(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  async content(selector?: string): Promise<string> {
    return this.evaluate<string>(
      selector
        ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? ""`
        : "document.documentElement.outerHTML",
    );
  }

  async screenshot(path?: string): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(data, "base64");
    if (path) await writeFile(path, buffer);
    return buffer;
  }

  locator(selector: string): Locator {
    return new Locator(this, selector);
  }

  getByRole(role: string, options: RoleLocatorOptions = {}): Locator {
    return Locator.byRole(this, role, options);
  }

  getByText(text: string | RegExp, options: TextLocatorOptions = {}): Locator {
    return Locator.byText(this, text, options);
  }

  async accessibilitySnapshot(options: SnapshotOptions = {}): Promise<string> {
    await this.send("Accessibility.enable");
    const { nodes } = await this.send<{ nodes: Array<{
      nodeId: string;
      parentId?: string;
      ignored?: boolean;
      role?: { value?: string };
      name?: { value?: string };
      value?: { value?: unknown };
    }> }>("Accessibility.getFullAXTree");
    const byParent = new Map<string | undefined, typeof nodes>();
    for (const node of nodes) {
      const siblings = byParent.get(node.parentId) ?? [];
      siblings.push(node);
      byParent.set(node.parentId, siblings);
    }
    const lines: string[] = [];
    const visited = new Set<string>();
    const visit = (node: (typeof nodes)[number], depth: number) => {
      if (visited.has(node.nodeId)) return;
      visited.add(node.nodeId);
      const role = node.role?.value ?? "";
      const name = node.name?.value ?? "";
      const value = node.value?.value;
      const hidden = node.ignored || (options.compact && ["none", "generic", "InlineTextBox"].includes(role));
      if (!hidden && (role || name || value !== undefined)) {
        const renderedValue = value === undefined || value === "" ? "" : ` = ${JSON.stringify(value)}`;
        lines.push(`${"  ".repeat(Math.min(depth, 12))}[${role || "node"}]${name ? ` ${name}` : ""}${renderedValue}`);
      }
      for (const child of byParent.get(node.nodeId) ?? []) visit(child, depth + 1);
    };
    for (const root of nodes.filter((node) => !node.parentId || !nodes.some((candidate) => candidate.nodeId === node.parentId))) {
      visit(root, 0);
    }
    for (const node of nodes) visit(node, 0);
    return lines.join("\n");
  }

  async close(): Promise<void> {
    await this.#connection.send("Target.closeTarget", { targetId: this.targetId });
  }
}

export class Locator {
  readonly #page: Page;
  readonly #query: string;
  readonly selector: string;

  constructor(page: Page, selector: string, query?: string) {
    this.#page = page;
    this.selector = selector;
    this.#query = query ?? `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`;
  }

  static byRole(page: Page, role: string, options: RoleLocatorOptions = {}, roots?: string): Locator {
    const query = Locator.#roleQuery(role, options, roots ?? "[document]");
    return new Locator(page, `role=${role}`, query);
  }

  static byText(page: Page, text: string | RegExp, options: TextLocatorOptions = {}, roots?: string): Locator {
    const match = Locator.#textMatch("value", text, options.exact ?? false);
    const query = `(() => {
      const roots = ${roots ?? "[document]"};
      const candidates = roots.flatMap((root) => Array.from(root.querySelectorAll("*")));
      return candidates.filter((el) => { const value = (el.innerText ?? el.textContent ?? "").trim(); return ${match}; });
    })()`;
    return new Locator(page, `text=${String(text)}`, query);
  }

  filter(options: LocatorFilterOptions): Locator {
    const checks: string[] = [];
    if (options.hasText !== undefined) {
      checks.push(Locator.#textMatch("(el.innerText ?? el.textContent ?? \"\")", options.hasText, false));
    }
    if (options.visible !== undefined) checks.push(`isVisible(el) === ${options.visible}`);
    if (checks.length === 0) return new Locator(this.#page, this.selector, this.#query);
    const query = `(() => {
      const isVisible = (el) => { const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0; };
      return (${this.#query}).filter((el) => ${checks.join(" && ")});
    })()`;
    return new Locator(this.#page, this.selector, query);
  }

  first(): Locator {
    return this.nth(0);
  }

  last(): Locator {
    return new Locator(this.#page, this.selector, `(${this.#query}).slice(-1)`);
  }

  nth(index: number): Locator {
    if (!Number.isInteger(index)) throw new Error("Locator index must be an integer");
    const query = index >= 0
      ? `(${this.#query}).slice(${index}, ${index + 1})`
      : `(${this.#query}).slice(${index}).slice(0, 1)`;
    return new Locator(this.#page, this.selector, query);
  }

  getByRole(role: string, options: RoleLocatorOptions = {}): Locator {
    return Locator.byRole(this.#page, role, options, this.#query);
  }

  getByText(text: string | RegExp, options: TextLocatorOptions = {}): Locator {
    return Locator.byText(this.#page, text, options, this.#query);
  }

  count(): Promise<number> {
    return this.#page.evaluate<number>(`(${this.#query}).length`);
  }

  allTextContents(): Promise<string[]> {
    return this.#page.evaluate<string[]>(`(${this.#query}).map((el) => el.textContent ?? "")`);
  }

  text(): Promise<string> {
    return this.#page.evaluate<string>(this.#withElement("return el.textContent ?? \"\";"));
  }

  getAttribute(name: string): Promise<string | null> {
    return this.#page.evaluate<string | null>(this.#withElement(`return el.getAttribute(${JSON.stringify(name)});`));
  }

  isVisible(): Promise<boolean> {
    return this.#page.evaluate<boolean>(this.#withElement(
      `const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;`,
    ));
  }

  async waitFor(options: WaitForLocatorOptions = {}): Promise<void> {
    const state = options.state ?? "visible";
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    await this.#page.evaluate(
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + ${timeoutMs};
        const check = () => {
          const el = (${this.#query})[0];
          const visible = !!el && (() => { const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0; })();
          if ((${JSON.stringify(state)} === "attached" && el) || (${JSON.stringify(state)} === "detached" && !el) || (${JSON.stringify(state)} === "visible" && visible) || (${JSON.stringify(state)} === "hidden" && !visible)) return resolve();
          if (Date.now() >= deadline) return reject(new Error("Timed out waiting for locator to be ${state}"));
          setTimeout(check, 50);
        };
        check();
      })`,
    );
  }

  async click(): Promise<void> {
    const rect = await this.#page.evaluate<{ x: number; y: number }>(this.#withElement(
      `el.scrollIntoView({block:"center", inline:"center"}); const r = el.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};`,
    ));
    const base = { x: rect.x, y: rect.y, button: "left", clickCount: 1 };
    await this.#page.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
    await this.#page.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await this.#page.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  }

  async fill(value: string): Promise<void> {
    await this.#page.evaluate(this.#withElement(
      `el.focus(); if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.value = ""; el.dispatchEvent(new Event("input", {bubbles:true})); } else if (el instanceof HTMLElement && el.isContentEditable) { el.textContent = ""; } else { throw new Error("Element is not editable"); }`,
    ));
    await this.#page.send("Input.insertText", { text: value });
  }

  #withElement(body: string): string {
    return `(() => { const el = (${this.#query})[0]; if (!el) throw new Error(${JSON.stringify(`Element not found: ${this.selector}`)}); ${body} })()`;
  }

  static #textMatch(valueExpression: string, expected: string | RegExp, exact: boolean): string {
    if (expected instanceof RegExp) {
      const flags = expected.flags.replace(/[gy]/g, "");
      return `new RegExp(${JSON.stringify(expected.source)}, ${JSON.stringify(flags)}).test(${valueExpression})`;
    }
    return exact
      ? `${valueExpression}.trim() === ${JSON.stringify(expected)}`
      : `${valueExpression}.includes(${JSON.stringify(expected)})`;
  }

  static #roleQuery(role: string, options: RoleLocatorOptions, roots: string): string {
    const nameMatch = options.name === undefined
      ? "true"
      : Locator.#textMatch("accessibleName(el)", options.name, options.exact ?? false);
    return `(() => {
      const roots = ${roots};
      const implicitRole = (el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a" && el.hasAttribute("href")) return "link";
        if (tag === "textarea") return "textbox";
        if (tag === "select") return el.multiple ? "listbox" : "combobox";
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "img") return "img";
        if (tag === "nav") return "navigation";
        if (tag === "main") return "main";
        if (tag === "ul" || tag === "ol") return "list";
        if (tag === "li") return "listitem";
        if (tag === "table") return "table";
        if (tag === "tr") return "row";
        if (tag === "td") return "cell";
        if (tag === "th") return "columnheader";
        if (tag === "input") {
          const type = (el.getAttribute("type") ?? "text").toLowerCase();
          if (["button", "submit", "reset", "image"].includes(type)) return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (["text", "email", "search", "tel", "url", "password"].includes(type)) return "textbox";
        }
        return "";
      };
      const accessibleName = (el) => {
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) return labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
        const explicitLabel = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
        const wrappingLabel = el.closest("label");
        return (el.getAttribute("aria-label") ?? explicitLabel?.textContent ?? wrappingLabel?.textContent ?? el.getAttribute("alt") ?? el.getAttribute("title") ?? (el instanceof HTMLInputElement ? el.value : undefined) ?? el.innerText ?? el.textContent ?? "").trim();
      };
      const candidates = roots.flatMap((root) => Array.from(root.querySelectorAll("*")));
      return candidates.filter((el) => (el.getAttribute("role") ?? implicitRole(el)) === ${JSON.stringify(role)} && ${nameMatch});
    })()`;
  }
}

/** Connects through the local daemon, starting it if needed. Call `close()` when done, or the process stays alive. */
export async function connectBrowser(options: ConnectBrowserOptions = {}): Promise<Browser> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  if (options.cdpUrl) {
    const connection = new CdpConnection(await resolveCdpWebSocketUrl(options.cdpUrl), "cdp", timeoutMs);
    await connection.connect();
    return new Browser(connection);
  }
  const browser = options.browser ?? "isolated";
  const { port, token } = await ensureDaemon();
  const connection = new CdpConnection(`ws://127.0.0.1:${port}`, browser === "user" ? "extension" : "cdp", timeoutMs, {
    type: "hello",
    role: "sdk",
    token,
    protocolVersion: 1,
    browser,
    session: process.env.BROWSER_USE_SESSION || undefined,
  });
  await connection.connect();
  await connection.waitForExtension(Math.min(timeoutMs, 5_000));
  return new Browser(connection);
}
