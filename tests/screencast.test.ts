import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encode } from "fast-png";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";
import { recordScreencast } from "../sdk/screencast.ts";
import { ScreencastError } from "../sdk/screencast-types.ts";

class FakePage {
  readonly targetId = "fake-target";
  readonly commands: string[] = [];
  #listeners = new Set<(params: Record<string, unknown>) => void>();
  #sessionId = 0;
  #timestamp = 10;
  #png: Buffer;

  constructor() {
    const data = new Uint8Array(16 * 16 * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 40;
      data[index + 1] = 120;
      data[index + 2] = 220;
      data[index + 3] = 255;
    }
    this.#png = Buffer.from(encode({ width: 16, height: 16, data, channels: 4, depth: 8 }));
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    assert.equal(method, "Page.screencastFrame");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async send(method: string): Promise<Record<string, unknown>> {
    this.commands.push(method);
    if (method === "Page.startScreencast") queueMicrotask(() => this.emitFrame());
    return {};
  }

  emitFrame(): void {
    this.#timestamp += 0.05;
    const params = {
      sessionId: ++this.#sessionId,
      data: this.#png.toString("base64"),
      metadata: { timestamp: this.#timestamp },
    };
    for (const listener of this.#listeners) listener(params);
  }
}

test("records an action to a playable MP4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-screencast-test-"));
  try {
    const path = join(directory, "action.mp4");
    const page = new FakePage();
    const result = await recordScreencast(page as never, async () => {
      page.emitFrame();
      return "action-result";
    }, { path, finalFrameHoldMs: 0 });

    assert.equal(result.value, "action-result");
    assert.equal(result.path, path);
    assert.equal(result.frameCount, 2);
    assert.ok((await stat(path)).size > 0);
    assert.deepEqual(page.commands.slice(0, 2), ["Page.enable", "Page.startScreencast"]);
    assert.equal(page.commands.at(-1), "Page.stopScreencast");

    const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      assert.ok(track);
      assert.equal(track.codec, "avc");
      assert.equal(await track.getDisplayWidth(), 16);
      assert.equal(await track.getDisplayHeight(), 16);
      assert.ok(await input.computeDuration() > 0);
    } finally {
      input.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("chooses a temporary output path by default", async () => {
  const page = new FakePage();
  const result = await recordScreencast(page as never, () => undefined, { finalFrameHoldMs: 0 });
  try {
    assert.equal(result.path.startsWith(join(tmpdir(), "browser-use", "screencasts")), true);
    assert.equal(result.path.endsWith(".mp4"), true);
    assert.ok((await stat(result.path)).size > 0);
  } finally {
    await rm(result.path, { force: true });
  }
});

test("finalizes the recording and reports its path when the action fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-screencast-test-"));
  try {
    const path = join(directory, "failure.mp4");
    const page = new FakePage();
    await assert.rejects(
      recordScreencast(page as never, () => {
        throw new Error("action exploded");
      }, { path, finalFrameHoldMs: 0 }),
      (error) => {
        assert.ok(error instanceof ScreencastError);
        assert.equal(error.path, path);
        assert.match(error.message, /Screencast action failed/);
        assert.equal((error.cause as Error).message, "action exploded");
        return true;
      },
    );
    assert.ok((await stat(path)).size > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
