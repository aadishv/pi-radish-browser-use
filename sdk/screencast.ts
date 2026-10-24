import { registerMediabunnyServer } from "@mediabunny/server";
import { decode as decodePng } from "fast-png";
import {
  FilePathTarget,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  VideoSample,
  VideoSampleSource,
} from "mediabunny";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { Page } from "./index.ts";
import { ScreencastError, type ScreencastOptions, type ScreencastResult } from "./screencast-types.ts";

registerMediabunnyServer({ hardwareContext: null });

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 5_000;
const DEFAULT_FINAL_FRAME_HOLD_MS = 250;
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

interface CapturedFrame {
  data: Buffer;
  timestamp?: number;
  receivedAt: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function defaultPath(targetId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(tmpdir(), "browser-use", "screencasts", `${stamp}-${targetId.slice(0, 8)}-${randomUUID().slice(0, 8)}.mp4`);
}

function frameTimestamp(params: JsonObject): number | undefined {
  const metadata = params.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const timestamp = (metadata as JsonObject).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

function rgbaData(frame: CapturedFrame): { data: Uint8Array; width: number; height: number } {
  const decoded = decodePng(frame.data);
  if (decoded.depth !== 8) throw new Error(`Unsupported screencast PNG depth: ${decoded.depth}`);
  if (decoded.channels === 4) {
    return { data: decoded.data as Uint8Array, width: decoded.width, height: decoded.height };
  }
  if (decoded.channels === 3) {
    const rgb = decoded.data;
    const rgba = new Uint8Array(decoded.width * decoded.height * 4);
    for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
      rgba[target] = rgb[source]!;
      rgba[target + 1] = rgb[source + 1]!;
      rgba[target + 2] = rgb[source + 2]!;
      rgba[target + 3] = 255;
    }
    return { data: rgba, width: decoded.width, height: decoded.height };
  }
  throw new Error(`Unsupported screencast PNG channel count: ${decoded.channels}`);
}

async function encodeFrames(path: string, frames: CapturedFrame[], duration: number): Promise<number> {
  const firstProtocolTimestamp = frames.find((frame) => frame.timestamp !== undefined)?.timestamp;
  const firstReceivedAt = frames[0]!.receivedAt;
  const timestamps: number[] = [];
  let previous = -1;
  for (const frame of frames) {
    const candidate = firstProtocolTimestamp !== undefined && frame.timestamp !== undefined
      ? frame.timestamp - firstProtocolTimestamp
      : (frame.receivedAt - firstReceivedAt) / 1000;
    const timestamp = previous < 0 ? 0 : Math.max(candidate, previous + 0.000_001);
    timestamps.push(timestamp);
    previous = timestamp;
  }
  const videoDuration = Math.max(duration, timestamps.at(-1)! + 1 / 30);
  const source = new VideoSampleSource({
    codec: "avc",
    bitrate: QUALITY_MEDIUM,
    sizeChangeBehavior: "contain",
  });
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new FilePathTarget(path),
  });
  output.addVideoTrack(source);

  try {
    await output.start();
    for (let index = 0; index < frames.length; index++) {
      const decoded = rgbaData(frames[index]!);
      const timestamp = timestamps[index]!;
      const nextTimestamp = timestamps[index + 1] ?? videoDuration;
      const sample = new VideoSample(decoded.data, {
        format: "RGBA",
        codedWidth: decoded.width,
        codedHeight: decoded.height,
        timestamp,
        duration: Math.max(0.000_001, nextTimestamp - timestamp),
      });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    }
    source.close();
    await output.finalize();
    return videoDuration;
  } catch (error) {
    if (output.state === "pending" || output.state === "started") await output.cancel().catch(() => {});
    throw error;
  }
}

export async function recordScreencast<T>(
  page: Page,
  action: () => T | Promise<T>,
  options: ScreencastOptions = {},
): Promise<ScreencastResult<T>> {
  const path = options.path ? resolve(options.path) : defaultPath(page.targetId);
  const maxWidth = positiveInteger(options.maxWidth ?? 1280, "maxWidth");
  const maxHeight = positiveInteger(options.maxHeight ?? 720, "maxHeight");
  const everyNthFrame = positiveInteger(options.everyNthFrame ?? 1, "everyNthFrame");
  const finalFrameHoldMs = nonNegativeNumber(options.finalFrameHoldMs ?? DEFAULT_FINAL_FRAME_HOLD_MS, "finalFrameHoldMs");
  const maxQueuedBytes = positiveInteger(options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES, "maxQueuedBytes");
  const firstFrameTimeoutMs = positiveInteger(options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS, "firstFrameTimeoutMs");
  await mkdir(dirname(path), { recursive: true });

  const frames: CapturedFrame[] = [];
  let queuedBytes = 0;
  let droppedFrames = 0;
  let captureError: unknown;
  const pendingAcks = new Set<Promise<unknown>>();
  let resolveFirstFrame!: () => void;
  const firstFrame = new Promise<void>((resolvePromise) => {
    resolveFirstFrame = resolvePromise;
  });

  const off = page.on("Page.screencastFrame", (params) => {
    const sessionId = params.sessionId;
    if (typeof sessionId === "number") {
      const ack = page.send("Page.screencastFrameAck", { sessionId }).catch((error) => {
        captureError ??= error;
      });
      pendingAcks.add(ack);
      void ack.finally(() => pendingAcks.delete(ack));
    }
    if (typeof params.data !== "string") {
      captureError ??= new Error("Page.screencastFrame did not contain image data");
      return;
    }
    const data = Buffer.from(params.data, "base64");
    const frame: CapturedFrame = {
      data,
      timestamp: frameTimestamp(params),
      receivedAt: performance.now(),
    };
    frames.push(frame);
    queuedBytes += data.byteLength;

    // Keep the initial state and the newest state, dropping older intermediate
    // frames when a long recording exceeds the compressed-data budget.
    while (queuedBytes > maxQueuedBytes && frames.length > 2) {
      const [removed] = frames.splice(1, 1);
      queuedBytes -= removed!.data.byteLength;
      droppedFrames++;
    }
    resolveFirstFrame();
  });

  let started = false;
  let value!: T;
  let actionError: unknown;
  let startTime = 0;
  let duration = 0;
  try {
    await page.send("Page.enable");
    await page.send("Page.startScreencast", {
      format: "png",
      maxWidth,
      maxHeight,
      everyNthFrame,
    });
    started = true;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`Timed out waiting for the initial screencast frame after ${firstFrameTimeoutMs}ms`)),
        firstFrameTimeoutMs,
      );
      void firstFrame.then(() => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    startTime = performance.now();
    try {
      value = await action();
    } catch (error) {
      actionError = error;
    }
    if (finalFrameHoldMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, finalFrameHoldMs));
    duration = Math.max(1 / 30, (performance.now() - startTime) / 1000);
  } catch (error) {
    actionError ??= error;
  } finally {
    if (started) {
      try {
        await page.send("Page.stopScreencast");
      } catch (error) {
        captureError ??= error;
      }
    }
    off();
    await Promise.allSettled(pendingAcks);
  }

  if (frames.length === 0) {
    throw new ScreencastError("Screencast produced no frames", path, { cause: actionError ?? captureError });
  }

  try {
    duration = await encodeFrames(path, frames, duration);
  } catch (error) {
    throw new ScreencastError("Failed to encode screencast", path, { cause: error });
  }
  if (actionError) throw new ScreencastError("Screencast action failed", path, { cause: actionError });
  if (captureError) throw new ScreencastError("Screencast capture failed", path, { cause: captureError });

  return { value, path, duration, frameCount: frames.length, droppedFrames };
}
