# browser-use reference

## Classes

`connectBrowser({ browser?, cdpUrl?, timeoutMs? })`
- `browser: "isolated"` (default): the headless browser of the session in `BROWSER_USE_SESSION`, which pi sets for the tool and for bash; without it, a throwaway one that closes with the connection
- `browser: "user"`: the user's browser through the extension
- `cdpUrl`: any other DevTools endpoint, directly
- `timeoutMs`: per CDP command, default 15 s

`Browser`
- `tabs()`: page targets, excluding `chrome://` and extension pages
- `newPage(url?)`: open a background tab and attach to it
- `page(targetIdOrPrefix)`: attach to one exact or uniquely prefixed target
- `send(method, params?)`: browser-level CDP
- `connected`; `close()` detaches and disconnects (the browser keeps running)

`Page`
- `targetId`, `sessionId`
- `goto(url, { timeoutMs? })`: http, https, or file; default timeout 30 s
- `title()`, `url()`, `content(selector?)`
- `evaluate(expressionOrFunction, ...jsonArgs)`: awaits promises, returns by value, runs with a user gesture
- `accessibilitySnapshot({ compact? })`: indented `[role] name = value` lines; `compact` drops generic and ignored nodes
- `screenshot(path?)`: viewport PNG `Buffer`, also written to `path` if given
- `screencast(action, options?)`
- `locator(css)`, `getByRole(role, options?)`, `getByText(text, options?)`
- `send(method, params?)`, `on(event, listener)` → unsubscribe function: CDP on this tab's session
- `close()`: closes the tab

`Locator`
- `filter({ hasText?, visible? })`, `first()`, `last()`, `nth(i)` (negative counts from the end)
- `getByRole(role, { name?, exact? })`, `getByText(text, { exact? })`: scoped to the matches
- `count()`, `text()`, `allTextContents()`, `getAttribute(name)`, `isVisible()`
- `waitFor({ state?, timeoutMs? })`: `visible` (default), `attached`, `detached`, `hidden`; default 15 s
- `click()`, `fill(value)`: act on the first match and throw if there is none

Text and accessible-name matchers take a string (substring, or whole trimmed text with `exact: true`) or a regex. Roles come from explicit `role` attributes plus common implicit HTML roles (button, link, textbox, checkbox, radio, combobox, listbox, heading, img, list, listitem, table, row, cell, navigation, main). Accessible names come from `aria-labelledby`, `aria-label`, `<label>`, `alt`, `title`, an input's value, then text.

## Full-page screenshots

```ts
const [width, height] = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight])
const { data } = await p.send("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width, height, scale: 0.5 },   // scale down tall pages before reading the image
})
writeFileSync("full.png", Buffer.from(data as string, "base64"))
```

## Screencasts

```ts
const rec = await p.screencast(async () => {
  await p.getByRole("button", { name: "Submit" }).click()
  await p.getByText("Complete").waitFor()
})
rec.path            // unique .mp4 under the system temp dir
rec.value           // the callback's return value
rec.duration        // seconds
rec.frameCount; rec.droppedFrames
```

Defaults give H.264 MP4 up to 1280×720. Override only when needed: `{ path, maxWidth, maxHeight, everyNthFrame, finalFrameHoldMs, maxQueuedBytes, firstFrameTimeoutMs }`. Frames arrive when the page paints, so the frame rate varies. Viewport only, no audio, one screencast per page at a time. If the callback throws, the MP4 is still finalized and a `ScreencastError` carrying `path` is thrown.

## Raw CDP

`p.send` and `browser.send` take any CDP method. In the isolated browser and with `connectBrowser({ cdpUrl })`, the whole protocol is available. The user browser goes through `chrome.debugger`, which supports any method on an attached tab, but only these browser-level methods: `Target.getTargets`, `Target.getTargetInfo`, `Target.createTarget`, `Target.attachToTarget`, `Target.detachFromTarget`, `Target.closeTarget`, `Target.activateTarget`, `Browser.getVersion`. While a script is attached to a user tab, the browser shows a "started debugging this browser" bar.

`connectBrowser({ cdpUrl })` takes a browser WebSocket URL or an HTTP base such as `http://127.0.0.1:9222`.

## How it runs

The package has two halves. A local daemon (`daemon.ts`, in the package next to this skill) owns the browsers: per session it keeps one headless browser, launched from the same binary as the user's browser with a throwaway profile, and it relays the user browser through the extension in `chrome/`. The SDK (`sdk/`) is all a script uses: `connectBrowser()` starts the daemon if needed and connects to it. `execute_browser_code` just runs your code with `node` in the project's cwd. Pi holds its session open in the daemon, which closes the headless browser when the session ends, or a minute after the last connection to it goes away.

Troubleshooting, from the package directory (`~/.pi/agent/extensions/browser-use`):

```bash
node daemon.ts status   # pid, version, extension connection, sessions
node daemon.ts stop     # the next connectBrowser() restarts it, as it does after any change to daemon.ts
node daemon.ts setup    # pairing values for the extension's options page
tail .runtime/daemon.log
```

The headless browser binary is, in order: `BROWSER_EXECUTABLE` in the daemon's environment, the browser the extension last connected from, then the first installed of Helium, Chrome, Chromium, Brave, and Edge.
