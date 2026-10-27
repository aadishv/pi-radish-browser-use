import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { DAEMON_URL, ensureDaemon } from "../daemon.ts";

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_NAVIGATION_TIMEOUT = 30_000;
const ACTION_TIMEOUT = 5_000;

type JsonObject = Record<string, unknown>;
type MessageListener = (params: JsonObject, message: CdpEvent) => void;

interface CdpResponse {
  id: number;
  result?: JsonObject;
  error?: { code?: number; message?: string };
}

interface CdpEvent {
  method: string;
  params?: JsonObject;
  sessionId?: string;
}

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

export interface ConnectBrowserOptions {
  /**
   * isolated (default): a private headless browser, shared by every script with the same BROWSER_USE_SESSION
   * (pi sets it to the session id), or this script's own if unset. user: the user's browser, through the extension.
   */
  browser?: "isolated" | "user";
  /** Per CDP command. */
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpConnection {
  readonly #ws: WebSocket;
  readonly #timeoutMs: number;
  #nextId = 0;
  readonly #pending = new Map<number, {
    method: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (result: JsonObject) => void;
    reject: (error: Error) => void;
  }>();
  readonly #listeners = new Map<string, Set<MessageListener>>();

  constructor(ws: WebSocket, timeoutMs: number) {
    this.#ws = ws;
    this.#timeoutMs = timeoutMs;
    ws.addEventListener("message", (event) => this.#handleMessage(JSON.parse(String(event.data))));
    ws.addEventListener("close", () => this.#rejectAll(new Error("The browser connection closed")));
  }

  get closed(): boolean {
    return this.#ws.readyState !== WebSocket.OPEN;
  }

  send<T extends JsonObject = JsonObject>(method: string, params: JsonObject = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The browser connection is closed"));
    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { method, timer, resolve: (result) => resolve(result as T), reject });
      this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
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

  close(): void {
    this.#ws.close();
    this.#rejectAll(new Error("The browser connection closed"));
  }

  #handleMessage(message: CdpResponse | CdpEvent): void {
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
    for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? {}, message);
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
  readonly #connection: CdpConnection;
  readonly #sessions = new Map<string, string>();

  constructor(connection: CdpConnection) {
    this.#connection = connection;
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
      (target) => target.type === "page" && !target.url.startsWith("chrome://") && !target.url.startsWith("chrome-extension://"),
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
    const { targetId } = matches[0]!;
    let sessionId = this.#sessions.get(targetId);
    if (!sessionId) {
      ({ sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
      this.#sessions.set(targetId, sessionId);
    }
    return new Page(this.#connection, targetId, sessionId);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#sessions.values()].map((sessionId) => this.send("Target.detachFromTarget", { sessionId })));
    this.#sessions.clear();
    this.#connection.close();
  }
}

export class Page {
  readonly targetId: string;
  readonly sessionId: string;
  readonly #connection: CdpConnection;

  constructor(connection: CdpConnection, targetId: string, sessionId: string) {
    this.#connection = connection;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  /** Sends a CDP command to this tab. */
  send<T extends JsonObject = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    return this.#connection.send<T>(method, params, this.sessionId);
  }

  on(method: string, listener: (params: JsonObject) => void): () => void {
    return this.#connection.on(method, (params, message) => {
      if (message.sessionId === this.sessionId) listener(params);
    });
  }

  /** Records `action` to an MP4 under the system temp dir. */
  async screencast<T>(action: () => T | Promise<T>, options: { everyNthFrame?: number } = {}): Promise<{ value: T; path: string }> {
    // Imported lazily so scripts that never record don't load the video encoder.
    const { recordScreencast } = await import("./screencast.ts");
    return recordScreencast(this, action, options.everyNthFrame);
  }

  async goto(url: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const { errorText } = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (errorText) throw new Error(`${url}: ${errorText}`);
    await poll(() => this.evaluate<boolean>(`document.readyState === "complete"`), options.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT, `${url} to finish loading`);
  }

  async evaluate<T = unknown>(expression: string | ((...args: any[]) => unknown), ...args: unknown[]): Promise<T> {
    const source = typeof expression === "function"
      // tsx and esbuild may insert __name(...) calls into a function's source.
      ? `(() => { const __name = (target) => target; return (${expression.toString()})(...${JSON.stringify(args)}); })()`
      : expression;
    const response = await this.send<{
      result: { value?: T; unserializableValue?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Browser evaluation failed");
    }
    return (response.result.unserializableValue ?? response.result.value) as T;
  }

  title(): Promise<string> {
    return this.evaluate<string>("document.title");
  }

  url(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  content(selector?: string): Promise<string> {
    return this.evaluate<string>(
      selector ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? ""` : "document.documentElement.outerHTML",
    );
  }

  async screenshot(path?: string): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(data, "base64");
    if (path) await writeFile(path, buffer);
    return buffer;
  }

  locator(selector: string): Locator {
    return this.#root().locator(selector);
  }

  getByRole(role: string, options: RoleLocatorOptions = {}): Locator {
    return this.#root().getByRole(role, options);
  }

  getByText(text: string | RegExp, options: TextLocatorOptions = {}): Locator {
    return this.#root().getByText(text, options);
  }

  /** The document, which page-level locators search from. */
  #root(): Locator {
    return new Locator(this, "", (group) => evaluateHandle(this, "[document]", group));
  }

  async accessibilitySnapshot(options: SnapshotOptions = {}): Promise<string> {
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
    const visit = (node: (typeof nodes)[number], depth: number) => {
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
    const ids = new Set(nodes.map((node) => node.nodeId));
    for (const node of nodes) if (!node.parentId || !ids.has(node.parentId)) visit(node, 0);
    return lines.join("\n");
  }

  async close(): Promise<void> {
    await this.#connection.send("Target.closeTarget", { targetId: this.targetId });
  }
}

/** Retries `check` until it returns true. Errors count as false, since navigations briefly destroy the page's context. */
async function poll(check: () => Promise<boolean>, timeoutMs: number, waitingFor: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (true) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${waitingFor}${reason}`);
    }
    await sleep(100);
  }
}

/** A reference to an object in the page, which stays alive until its object group is released. */
type Handle = string;

type RemoteResult = {
  result: { objectId?: string; value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

function unwrap({ result, exceptionDetails }: RemoteResult): RemoteResult["result"] {
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "Browser evaluation failed");
  return result;
}

async function evaluateHandle(page: Page, expression: string, group: string): Promise<Handle> {
  return unwrap(await page.send<RemoteResult>("Runtime.evaluate", { expression, objectGroup: group })).objectId!;
}

/** Calls the function `fn` in the page, with `this` bound to `target` and JSON `args`. */
async function callFunction(page: Page, target: Handle, fn: string, args: unknown[], options: { objectGroup: string } | { returnByValue: true }) {
  return unwrap(await page.send<RemoteResult>("Runtime.callFunctionOn", {
    objectId: target,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    ...options,
  }));
}

/**
 * Finds elements with `role` under the roots through Chrome's accessibility tree, so roles and names are the ones Chrome
 * computes. It reads the whole tree because Accessibility.queryAXTree never answers in background tabs.
 */
async function resolveRole(page: Page, roots: Handle, role: string, options: RoleLocatorOptions, group: string): Promise<Handle> {
  const { nodes } = await page.send<{
    nodes: Array<{ ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; backendDOMNodeId?: number }>;
  }>("Accessibility.getFullAXTree");

  const backendNodeIds = new Set<number>();
  for (const node of nodes) {
    // Ignored nodes are hidden from assistive technology, for example with aria-hidden.
    if (node.ignored || node.role?.value !== role || node.backendDOMNodeId === undefined) continue;
    if (options.name === undefined || nameMatches(String(node.name?.value ?? ""), options.name, options.exact ?? false)) {
      backendNodeIds.add(node.backendDOMNodeId);
    }
  }

  const elements = await Promise.all([...backendNodeIds].map(async (backendNodeId) => {
    const { object } = await page.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId, objectGroup: group });
    return object.objectId;
  }));
  return unwrap(await page.send<RemoteResult>("Runtime.callFunctionOn", {
    objectId: roots,
    // The accessibility tree's order can differ from the document's, for example for an open <dialog>.
    functionDeclaration: `function (...elements) {
      return elements
        .filter((el) => this.some((root) => root.contains(el)))
        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    }`,
    arguments: elements.map((objectId) => ({ objectId })),
    objectGroup: group,
  })).objectId!;
}

/** Chrome has already collapsed whitespace in accessible names. */
function nameMatches(name: string, expected: string | RegExp, exact: boolean): boolean {
  if (expected instanceof RegExp) return new RegExp(expected.source, expected.flags.replace(/[gy]/g, "")).test(name);
  return exact ? name === expected : name.includes(expected);
}

// In-page helpers, spliced into the functions that locators call.
const IS_VISIBLE = `const isVisible = (el) => { const rect = el.getBoundingClientRect(); return el.checkVisibility({ visibilityProperty: true }) && rect.width > 0 && rect.height > 0; };`;
const MATCHES = `const matches = (el, spec) => {
  const value = (el.innerText ?? el.textContent ?? "").replace(/\\s+/g, " ").trim();
  return spec.source !== undefined ? new RegExp(spec.source, spec.flags).test(value) : spec.exact ? value === spec.text : value.includes(spec.text);
};`;

/** The innermost elements whose text matches, so a match is the text itself rather than every ancestor of it. */
const GET_BY_TEXT = `function (spec) {
  ${MATCHES}
  const skip = new Set(["HEAD", "TITLE", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const hits = new Set(this.flatMap((root) => Array.from(root.querySelectorAll("*"))).filter((el) => !skip.has(el.tagName) && matches(el, spec)));
  return [...hits].filter((el) => !Array.from(el.children).some((child) => hits.has(child)));
}`;

const FILTER = `function (spec, visible) {
  ${MATCHES}
  ${IS_VISIBLE}
  return this.filter((el) => (spec === null || matches(el, spec)) && (visible === null || isVisible(el) === visible));
}`;

type TextSpec = { text: string; exact: boolean } | { source: string; flags: string };

function textSpec(expected: string | RegExp, exact: boolean): TextSpec {
  return expected instanceof RegExp ? { source: expected.source, flags: expected.flags.replace(/[gy]/g, "") } : { text: expected, exact };
}

/** Resolves, in the given object group, to a handle on an in-page array of the matching elements. */
type Resolve = (group: string) => Promise<Handle>;

export class Locator {
  /** Describes the locator in error messages. */
  readonly selector: string;
  readonly #page: Page;
  readonly #resolve: Resolve;

  constructor(page: Page, selector: string, resolve: Resolve) {
    this.#page = page;
    this.selector = selector;
    this.#resolve = resolve;
  }

  locator(selector: string): Locator {
    return this.#then(selector, `function (selector) { return this.flatMap((root) => Array.from(root.querySelectorAll(selector))); }`, [selector]);
  }

  getByText(text: string | RegExp, options: TextLocatorOptions = {}): Locator {
    return this.#then(`text=${text}`, GET_BY_TEXT, [textSpec(text, options.exact ?? false)]);
  }

  getByRole(role: string, options: RoleLocatorOptions = {}): Locator {
    return new Locator(this.#page, this.#describe(`role=${role}`), async (group) => resolveRole(this.#page, await this.#resolve(group), role, options, group));
  }

  filter(options: LocatorFilterOptions): Locator {
    const spec = options.hasText === undefined ? null : textSpec(options.hasText, false);
    return this.#then("", FILTER, [spec, options.visible ?? null]);
  }

  first(): Locator {
    return this.nth(0);
  }

  last(): Locator {
    return this.nth(-1);
  }

  /** Negative indexes count from the end. */
  nth(index: number): Locator {
    if (!Number.isInteger(index)) throw new Error("Locator index must be an integer");
    return this.#then(`nth=${index}`, `function (index) { const el = this.at(index); return el ? [el] : []; }`, [index]);
  }

  count(): Promise<number> {
    return this.#evaluate("function () { return this.length; }");
  }

  allTextContents(): Promise<string[]> {
    return this.#evaluate(`function () { return this.map((el) => el.textContent ?? ""); }`);
  }

  text(): Promise<string> {
    return this.#evaluateFirst(`return el.textContent ?? "";`);
  }

  getAttribute(name: string): Promise<string | null> {
    return this.#evaluateFirst("return el.getAttribute(arg);", name);
  }

  isVisible(): Promise<boolean> {
    return this.#evaluate(`function () { ${IS_VISIBLE} return !!this[0] && isVisible(this[0]); }`);
  }

  async waitFor({ state = "visible", timeoutMs = DEFAULT_TIMEOUT }: WaitForLocatorOptions = {}): Promise<void> {
    const check = `function (state) {
      ${IS_VISIBLE}
      const el = this[0];
      const visible = !!el && isVisible(el);
      return { attached: !!el, detached: !el, visible, hidden: !visible }[state];
    }`;
    await poll(() => this.#evaluate<boolean>(check, [state]), timeoutMs, `${this.selector} to be ${state}`);
  }

  /** Waits for the first match to be visible, scrolls it into view, and clicks its center with real mouse events. */
  async click(): Promise<void> {
    await this.waitFor({ timeoutMs: ACTION_TIMEOUT });
    const { x, y } = await this.#evaluateFirst<{ x: number; y: number }>(
      `el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`,
    );
    const base = { x, y, button: "left", clickCount: 1 };
    await this.#page.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
    await this.#page.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await this.#page.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  }

  /** Waits for the first match to be visible, clears it, and types `value`. */
  async fill(value: string): Promise<void> {
    await this.waitFor({ timeoutMs: ACTION_TIMEOUT });
    await this.#evaluateFirst(
      `el.focus(); if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } else if (el.isContentEditable) { el.textContent = ""; } else { throw new Error("Element is not editable"); }`,
    );
    await this.#page.send("Input.insertText", { text: value });
  }

  #describe(step: string): string {
    return [this.selector, step].filter(Boolean).join(" >> ");
  }

  /** A locator for the elements that the in-page function `fn` returns, called on this locator's matches. */
  #then(step: string, fn: string, args: unknown[]): Locator {
    return new Locator(this.#page, this.#describe(step), async (group) => {
      return (await callFunction(this.#page, await this.#resolve(group), fn, args, { objectGroup: group })).objectId!;
    });
  }

  /** Resolves the matches in a fresh object group, returns what `fn` returns for them, and releases the group. */
  async #evaluate<T>(fn: string, args: unknown[] = []): Promise<T> {
    const group = randomUUID();
    try {
      return (await callFunction(this.#page, await this.#resolve(group), fn, args, { returnByValue: true })).value as T;
    } finally {
      this.#page.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    }
  }

  /** Runs `body` with `el` bound to the first match, and `arg` to `arg`. */
  #evaluateFirst<T>(body: string, arg?: unknown): Promise<T> {
    const notFound = JSON.stringify(`Element not found: ${this.selector}`);
    return this.#evaluate(`function (arg) { const el = this[0]; if (!el) throw new Error(${notFound}); ${body} }`, [arg]);
  }
}

/** Connects through the local daemon, starting it if needed. Call `close()` when done, or the process stays alive. */
export async function connectBrowser(options: ConnectBrowserOptions = {}): Promise<Browser> {
  const token = await ensureDaemon();
  const ws = new WebSocket(DAEMON_URL);
  await new Promise<void>((resolve, reject) => {
    const hello = { type: "hello", role: "sdk", token, browser: options.browser ?? "isolated", session: process.env.BROWSER_USE_SESSION || undefined };
    ws.addEventListener("open", () => ws.send(JSON.stringify(hello)), { once: true });
    ws.addEventListener("message", (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.ok) resolve();
      else reject(new Error(reply.error ?? "The browser daemon rejected the connection"));
    }, { once: true });
    ws.addEventListener("close", () => reject(new Error("Could not connect to the browser daemon")), { once: true });
  });
  return new Browser(new CdpConnection(ws, options.timeoutMs ?? DEFAULT_TIMEOUT));
}
