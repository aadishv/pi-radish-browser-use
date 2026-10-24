export interface ScreencastOptions {
  /** Output path. Defaults to a unique MP4 under the system temporary directory. */
  path?: string;
  /** Maximum captured width. Defaults to 1280. */
  maxWidth?: number;
  /** Maximum captured height. Defaults to 720. */
  maxHeight?: number;
  /** Capture every n-th compositor frame. Defaults to 1. */
  everyNthFrame?: number;
  /** Time to preserve the final visual state before stopping, in milliseconds. Defaults to 250. */
  finalFrameHoldMs?: number;
  /** Maximum compressed frame data retained before intermediate frames are dropped. Defaults to 256 MiB. */
  maxQueuedBytes?: number;
  /** Time to wait for Chrome's initial frame, in milliseconds. Defaults to 5000. */
  firstFrameTimeoutMs?: number;
}

export interface ScreencastResult<T> {
  value: T;
  path: string;
  duration: number;
  frameCount: number;
  droppedFrames: number;
}

export class ScreencastError extends Error {
  readonly path: string;

  constructor(message: string, path: string, options: ErrorOptions = {}) {
    super(`${message}; screencast path: ${path}`, options);
    this.name = "ScreencastError";
    this.path = path;
  }
}
