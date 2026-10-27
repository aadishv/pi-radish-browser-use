This is the browser use extension for pi that i (aadish) use most of the time. I like to think that, instead of this being some complex agent-optimized REPL extension thing, it's first and foremost a simple joyful browser use SDK and then a thin Pi layer on top that just gives the model an easy tool to use the SDK. The goal was to cleanly merge headless stuff like [rodney](https://github.com/simonw/rodney) and stuff that uses my real browser like [chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) while significantly improving on modularity and extensibility.

> [!WARNING]
> This is (obviously) entirely vibeslop so bewarned.

I'm pretty sure it works with a background daemon that talks to both 1) a Chrome extension with uses the regular chrome debugger APIs and 2) headless Chrome instances it manages itself. (Okay, well, Helium is what I use but not any real difference.) (I say "pretty sure" because I have barely read any of the code of this thing.) Each Pi session gets its own headless Chrome instance and can access the user's browser (extension), but only one Pi session can access the user browser at a time. One dumb thing is that the chrome.debugger API for the extension isn't the exact same as raw CDP, so the extension has to fake a couple responses for certain message types.

Then, there's a simple SDK frontend which talks to the daemon over websockets and exchanges raw CDP messages (in this sense the daemon is just a simple passthrough of CDP to the extension/the headless browsers it manages). The Pi extension gives the model an execute_browser_code tool which just takes a script and runs it as Node (with some messy stuff to get imports to work without changing cwd). The extension also exposes a skill with basic docs on how to use the SDK (reading the skill loads the deferred execute_browser_code, which is how we do progressive disclosure).

The very [original version of this](https://github.com/aadishv/skills/tree/ebbc55e4d38c10a130f02ae77fccef808f02b8ad/codex-browser-use) was based very closely on Codex's REPL-based browser use system but I'm pretty sure its drifted significantly since then. I'll probably eventually look into readding REPL functionality but last time I tried it just massively bloated the codebase.

Also note I bet there is a bunch of stuff here hardcoded to my laptop, esp. w/r/t using Helium, port #'s, etc.

"How do I set this up?" c'mon man its 2026, it's all vibes now, do i look like i know