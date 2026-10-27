import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import test from "node:test";
import { encode } from "fast-png";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";
import { recordScreencast } from "../sdk/screencast.ts";

/** Emits RGB frames like Chrome does: one when the screencast starts, then whenever `emitFrame` is called. */
class FakePage {
  readonly commands: string[] = [];
  #listeners = new Set<(params: Record<string, unknown>) => void>();
  #sessionId = 0;
  #png = Buffer.from(encode({ width: 16, height: 16, data: new Uint8Array(16 * 16 * 3).fill(128), channels: 3, depth: 8 })).toString("base64");

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
    const params = { sessionId: ++this.#sessionId, data: this.#png, metadata: { timestamp: Date.now() / 1000 } };
    for (const listener of this.#listeners) listener(params);
  }
}

test("records an action to a playable MP4", async () => {
  const page = new FakePage();
  const { value, path } = await recordScreencast(page as never, async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    page.emitFrame();
    return "action-result";
  });
  try {
    assert.equal(value, "action-result");
    assert.deepEqual(page.commands.filter((command) => command !== "Page.screencastFrameAck"), ["Page.enable", "Page.startScreencast", "Page.stopScreencast"]);
    const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      assert.equal(track?.codec, "avc");
      assert.equal(await track?.getDisplayWidth(), 16);
      assert.ok((await input.computeDuration()) > 0.25);
    } finally {
      input.dispose();
    }
  } finally {
    await rm(path, { force: true });
  }
});

test("keeps the recording when the action fails", async () => {
  const error = await recordScreencast(new FakePage() as never, () => {
    throw new Error("action exploded");
  }).catch((error: Error) => error);
  assert.ok(error instanceof Error);
  assert.equal((error.cause as Error).message, "action exploded");
  const path = error.message.match(/recording is at (\S+\.mp4)/)![1]!;
  assert.ok((await stat(path)).size > 0);
  await rm(path, { force: true });
});
