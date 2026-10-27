# browser-use reference

## Classes

`connectBrowser({ browser?, timeoutMs? })`
- `browser: "isolated"` (default): the headless browser of the session in `BROWSER_USE_SESSION`, which pi sets for the tool and for bash; without it, a throwaway one that closes with the connection
- `browser: "user"`: the user's browser through the extension
- `timeoutMs`: per CDP command, default 15 s

`Browser`
- `tabs()`: page targets, excluding `chrome://` and extension pages
- `newPage(url?)`: open a background tab and attach to it
- `page(targetIdOrPrefix)`: attach to one exact or uniquely prefixed target
- `send(method, params?)`: browser-level CDP
- `connected`; `close()` detaches and disconnects (the browser keeps running)

`Page`
- `targetId`, `sessionId`
- `goto(url, { timeoutMs? })`: default timeout 30 s
- `title()`, `url()`, `content(selector?)`
- `evaluate(expressionOrFunction, ...jsonArgs)`: awaits promises, returns by value, runs with a user gesture
- `accessibilitySnapshot({ compact? })`: indented `[role] name = value` lines; `compact` drops generic and ignored nodes
- `screenshot(path?)`: viewport PNG `Buffer`, also written to `path` if given
- `screencast(action, { everyNthFrame? })`
- `locator(css)`, `getByRole(role, options?)`, `getByText(text, options?)`
- `send(method, params?)`, `on(event, listener)` → unsubscribe function: CDP on this tab's session
- `close()`: closes the tab

`Locator`
- `filter({ hasText?, visible? })`, `first()`, `last()`, `nth(i)` (negative counts from the end)
- `locator(css)`, `getByRole(role, { name?, exact? })`, `getByText(text, { exact? })`: scoped to the matches
- `count()`, `text()`, `allTextContents()`, `getAttribute(name)`, `isVisible()`
- `waitFor({ state?, timeoutMs? })`: `visible` (default), `attached`, `detached`, `hidden`; default 15 s
- `click()`, `fill(value)`: wait up to 5 s for the first match to be visible, then act on it

Text and accessible-name matchers take a string (substring, or whole text with `exact: true`, whitespace collapsed) or a regex. `getByText` returns the innermost matching elements, skipping scripts and styles. `getByRole` reads Chrome's accessibility tree, so roles and accessible names are exactly the ones `accessibilitySnapshot` prints, and elements hidden from assistive technology (`aria-hidden`, `display: none`) never match. Locators return matches in document order.

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
```

H.264 MP4, scaled down to fit 1280×720. Frames arrive when the page paints, so the frame rate varies; `everyNthFrame` keeps only every nth one. Viewport only, no audio, one screencast per page at a time. If the callback throws, the MP4 is still written and the error, with the original as its `cause`, names its path.

## Raw CDP

`p.send` and `browser.send` take any CDP method. In the isolated browser, the whole protocol is available. The user browser goes through `chrome.debugger`, which supports any method on an attached tab, but only these browser-level methods: `Target.getTargets`, `Target.createTarget`, `Target.attachToTarget`, `Target.detachFromTarget`, `Target.closeTarget`. While a script is attached to a user tab, the browser shows a "started debugging this browser" bar.

## How it runs

The package has two halves. A local daemon (`daemon.ts`, in the package next to this skill) owns the browsers: per session it keeps one headless browser, launched from Helium with a throwaway profile, and it relays the user browser through the extension in `chrome/`. The SDK (`sdk/`) is all a script uses: `connectBrowser()` starts the daemon if needed and connects to it. `execute_browser_code` just runs your code with `node` in the project's cwd. The daemon closes a session's headless browser 30 minutes after the last connection to it goes away.

Troubleshooting, from the package directory (`~/.pi/agent/extensions/browser-use`):

```bash
node daemon.ts status   # pid, version, extension connection, sessions
node daemon.ts stop     # the next connectBrowser() restarts it, as it does after any change to daemon.ts
node daemon.ts setup    # pairing token for the extension's options page
tail .runtime/daemon.log
```

The headless browser binary is `BROWSER_EXECUTABLE` in the daemon's environment if set, otherwise Helium on macOS or the first installed of Chrome, Chromium, Brave, and Edge on Linux.
