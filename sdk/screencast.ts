import { registerMediabunnyServer } from "@mediabunny/server";
import { decode as decodePng } from "fast-png";
import { FilePathTarget, Mp4OutputFormat, Output, QUALITY_MEDIUM, VideoSample, VideoSampleSource } from "mediabunny";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "./index.ts";

registerMediabunnyServer({ hardwareContext: null });

const SCREENCAST_DIR = join(tmpdir(), "browser-use", "screencasts");

interface Frame {
  png: Buffer;
  /** Seconds since the epoch. */
  timestamp: number;
}

/** Chrome sends RGB PNGs of any size; the encoder wants RGBA with even dimensions, so an odd last row or column is dropped. */
function rgba(png: Buffer): { data: Uint8Array; width: number; height: number } {
  const { data, width, height, channels } = decodePng(png);
  const evenWidth = width & ~1;
  const evenHeight = height & ~1;
  const out = new Uint8Array(evenWidth * evenHeight * 4).fill(255);
  for (let y = 0; y < evenHeight; y++) {
    for (let x = 0; x < evenWidth; x++) {
      const from = (y * width + x) * channels;
      out.set(data.subarray(from, from + 3), (y * evenWidth + x) * 4);
    }
  }
  return { data: out, width: evenWidth, height: evenHeight };
}

export async function recordScreencast<T>(page: Page, action: () => T | Promise<T>, everyNthFrame = 1): Promise<{ value: T; path: string }> {
  const frames: Frame[] = [];
  let firstFrame!: () => void;
  const gotFirstFrame = new Promise<void>((resolve) => (firstFrame = resolve));
  const off = page.on("Page.screencastFrame", (params) => {
    page.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    frames.push({ png: Buffer.from(params.data as string, "base64"), timestamp: (params.metadata as { timestamp: number }).timestamp });
    firstFrame();
  });

  let value: T | undefined;
  let actionError: unknown;
  let end: number;
  try {
    await page.send("Page.enable");
    await page.send("Page.startScreencast", { format: "png", maxWidth: 1280, maxHeight: 720, everyNthFrame });
    // Start the action only once the video has its initial state.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No screencast frame arrived within 5 seconds")), 5_000);
      void gotFirstFrame.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      value = await action();
    } catch (error) {
      actionError = error;
    }
    // Give the final state time to paint.
    await new Promise((resolve) => setTimeout(resolve, 250));
    end = Date.now() / 1000;
  } finally {
    await page.send("Page.stopScreencast").catch(() => {});
    off();
  }

  mkdirSync(SCREENCAST_DIR, { recursive: true });
  const path = join(SCREENCAST_DIR, `${randomUUID()}.mp4`);
  const source = new VideoSampleSource({ codec: "avc", bitrate: QUALITY_MEDIUM, sizeChangeBehavior: "contain" });
  const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget(path) });
  output.addVideoTrack(source);
  await output.start();
  const start = frames[0]!.timestamp;
  for (const [index, frame] of frames.entries()) {
    const { data, width, height } = rgba(frame.png);
    const next = frames[index + 1]?.timestamp ?? end;
    const sample = new VideoSample(data, {
      format: "RGBA",
      codedWidth: width,
      codedHeight: height,
      timestamp: frame.timestamp - start,
      duration: Math.max(next - frame.timestamp, 0.001),
    });
    await source.add(sample);
    sample.close();
  }
  await output.finalize();

  if (actionError) throw new Error(`The screencast action failed; the recording is at ${path}`, { cause: actionError });
  return { value: value as T, path };
}
