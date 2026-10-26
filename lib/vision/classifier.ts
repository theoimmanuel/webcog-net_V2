// Feature: webcog-net-site
//
// Browser-side cognitive-load Classifier (Req 3.4, 4.2, 4.3, 4.6).
//
// Wraps the pre-trained, quantized TensorFlow.js LayersModel shipped at
// `/models/cogload/model.json` (+ weight shard[s]). The model is a hybrid
// 1D CNN-GRU: input tensor `[1, 5, 3]` — 5 timesteps (one aggregated feature
// vector per second over the trailing 5-second window) and 3 channels
// [EAR, BlinkRate, SaccadeVelocity] — producing a 3-way softmax over the
// classes [LOW, MODERATE, HIGH].
//
// Responsibilities:
//   - load(): fetch the artifact (measuring its total byte size by summing the
//     fetched file lengths, Req 4.3), load the LayersModel, and run a one-time
//     warmup inference (the cold-start outlier excluded from latency stats).
//   - predict(window): build the [1, 5, 3] input from the trailing 5 aggregated
//     windows, run inference wrapped in a `performance.now()` delta, and return
//     the argmax class as a defined Cognitive_Load_State plus the measured
//     latency in ms (Property 8 — output is always a defined state).
//   - modelSizeBytes(): the measured total artifact size (Req 4.3).
//   - modelSizeExceeds: true when the artifact is >= 51,200 bytes (Req 4.6,
//     Property 12), using MODEL_SIZE_LIMIT_BYTES from the session module.
//
// This module runs in the browser (client context). It guards against
// server-side rendering so importing it on the server does not throw.

import * as tf from "@tensorflow/tfjs";

import type { AggregatedWindow } from "@/lib/vision/aggregator";
import { MODEL_SIZE_LIMIT_BYTES } from "@/lib/harness/session";

/**
 * The discrete cognitive-load states the classifier can emit (Req 3.4).
 *
 * Defined and exported here to avoid a cross-dependency on `lib/load/source.ts`
 * (which does not exist yet); the load-source abstraction can re-use/align with
 * this union when it is implemented.
 */
export type CognitiveLoadState = "LOW" | "MODERATE" | "HIGH";

/** The three output classes in softmax-index order (index 0..2). */
export const CLASS_ORDER: readonly CognitiveLoadState[] = ["LOW", "MODERATE", "HIGH"];

/** Number of timesteps the model expects (trailing 5-second window). */
export const MODEL_TIMESTEPS = 5;
/** Number of input channels per timestep: [EAR, BlinkRate, SaccadeVelocity]. */
export const MODEL_CHANNELS = 3;

/** Default location of the shipped TF.js artifact (served from `public/`). */
export const DEFAULT_MODEL_URL = "/models/cogload/model.json";

/** Result of a single inference: the inferred state and its measured latency (ms). */
export interface PredictResult {
  state: CognitiveLoadState;
  latencyMs: number;
}

/**
 * The cognitive-load Classifier contract (design.md §Classifier).
 */
export interface Classifier {
  /** Load the artifact (< 50 KB), measure its size, and run a warmup inference. */
  load(): Promise<void>;
  /** Infer the cognitive-load state for the trailing 5-second window. */
  predict(window: AggregatedWindow[]): PredictResult;
  /** The measured total artifact size in bytes (Req 4.3, 4.6). */
  modelSizeBytes(): number;
}

/** Options for {@link CnnGruClassifier}. */
export interface ClassifierOptions {
  /** Override the artifact URL (defaults to {@link DEFAULT_MODEL_URL}). */
  modelUrl?: string;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof performance !== "undefined";
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Resolve a weight-shard path (relative to the model.json URL) into an absolute
 * URL so we can fetch each shard to measure its byte length. The manifest paths
 * in `model.json` are relative to the model file's directory.
 */
function resolveShardUrl(modelUrl: string, shardPath: string): string {
  // If the shard path is already absolute, use it as-is.
  if (/^https?:\/\//i.test(shardPath) || shardPath.startsWith("/")) {
    return shardPath;
  }
  const lastSlash = modelUrl.lastIndexOf("/");
  const dir = lastSlash >= 0 ? modelUrl.slice(0, lastSlash + 1) : "";
  return `${dir}${shardPath}`;
}

/**
 * Fetch the model.json and every referenced weight shard, summing the fetched
 * byte lengths to measure the on-disk artifact size (Req 4.3). The sum is a
 * direct measurement of the bytes transferred, independent of any headers.
 */
async function measureArtifactBytes(modelUrl: string): Promise<number> {
  const modelResponse = await fetch(modelUrl);
  if (!modelResponse.ok) {
    throw new Error(
      `Failed to fetch model manifest ${modelUrl}: ${modelResponse.status}`,
    );
  }
  const modelText = await modelResponse.text();
  let total = byteLengthOf(modelText);

  const manifest = JSON.parse(modelText) as {
    weightsManifest?: { paths?: string[] }[];
  };
  const shardPaths: string[] = [];
  for (const group of manifest.weightsManifest ?? []) {
    for (const p of group.paths ?? []) {
      shardPaths.push(p);
    }
  }

  const shardSizes = await Promise.all(
    shardPaths.map(async (shardPath) => {
      const url = resolveShardUrl(modelUrl, shardPath);
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch weight shard ${url}: ${res.status}`);
      }
      const buf = await res.arrayBuffer();
      return buf.byteLength;
    }),
  );

  for (const size of shardSizes) total += size;
  return total;
}

/** Byte length of a string's UTF-8 encoding (the bytes actually transferred). */
function byteLengthOf(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  // Fallback: approximate via Blob when TextEncoder is unavailable.
  return text.length;
}

/**
 * Build the `[1, 5, 3]` input values from the trailing aggregated windows.
 *
 * Defensive against a short input: when fewer than 5 windows are available the
 * series is left-padded by repeating the earliest available window (or zeros
 * when the input is empty), so the model always receives a well-formed input
 * and `predict` can always return a defined state (Property 8).
 */
export function buildInputMatrix(
  windows: readonly AggregatedWindow[],
): number[][] {
  const trailing = windows.slice(-MODEL_TIMESTEPS);
  const rows: number[][] = trailing.map((w) => [
    isFiniteNumber(w.ear) ? w.ear : 0,
    isFiniteNumber(w.blinkRate) ? w.blinkRate : 0,
    isFiniteNumber(w.saccadeVelocity) ? w.saccadeVelocity : 0,
  ]);

  if (rows.length === MODEL_TIMESTEPS) {
    return rows;
  }

  // Left-pad to MODEL_TIMESTEPS by repeating the earliest row (zeros if empty).
  const pad = rows.length > 0 ? rows[0] : [0, 0, 0];
  const padded: number[][] = [];
  for (let i = rows.length; i < MODEL_TIMESTEPS; i++) {
    padded.push([...pad]);
  }
  return [...padded, ...rows];
}

/** Map a probability vector to the argmax class, defaulting to LOW on ties/empties. */
export function argmaxState(probabilities: readonly number[]): CognitiveLoadState {
  let bestIndex = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < CLASS_ORDER.length; i++) {
    const value = probabilities[i];
    if (isFiniteNumber(value) && value > bestValue) {
      bestValue = value;
      bestIndex = i;
    }
  }
  return CLASS_ORDER[bestIndex] ?? "LOW";
}

/**
 * The TensorFlow.js hybrid 1D CNN-GRU cognitive-load classifier.
 */
export class CnnGruClassifier implements Classifier {
  private readonly modelUrl: string;
  private model: tf.LayersModel | null = null;
  private measuredBytes = 0;
  /** The excluded cold-start warmup latency (ms), for reference. */
  private warmupLatencyMs: number | null = null;

  constructor(options: ClassifierOptions = {}) {
    this.modelUrl = options.modelUrl ?? DEFAULT_MODEL_URL;
  }

  /**
   * Load the artifact, measure its total byte size (Req 4.3), and run a one-time
   * warmup inference. The warmup is a cold-start outlier and its latency is kept
   * only for reference (see {@link getWarmupLatencyMs}); it is excluded from the
   * session latency statistics by never being fed to the accumulator.
   */
  async load(): Promise<void> {
    if (!isBrowser()) {
      throw new Error(
        "Classifier.load() must run in a browser context (no window/fetch).",
      );
    }
    if (this.model) return;

    // Measure the artifact size by summing the fetched byte lengths (Req 4.3).
    this.measuredBytes = await measureArtifactBytes(this.modelUrl);

    // Load the LayersModel from the same artifact.
    this.model = await tf.loadLayersModel(this.modelUrl);

    // One-time warmup inference (cold-start). Timed for reference but excluded
    // from reported latency statistics (design: warmup excluded).
    const warmupWindow: AggregatedWindow[] = Array.from(
      { length: MODEL_TIMESTEPS },
      (_, i) => ({
        ear: 0,
        blinkRate: 0,
        saccadeVelocity: 0,
        frames: 0,
        startT: i * 1000,
        endT: i * 1000 + 5000,
        degraded: true,
      }),
    );
    const warmup = this.predict(warmupWindow);
    this.warmupLatencyMs = warmup.latencyMs;
  }

  /**
   * Infer the cognitive-load state for the trailing 5-second window.
   *
   * Builds the `[1, 5, 3]` input, times the inference with `performance.now()`,
   * and returns the argmax class and the measured latency (ms). All tensors are
   * disposed to avoid leaks. The returned state is always one of
   * {LOW, MODERATE, HIGH} (Property 8).
   */
  predict(window: AggregatedWindow[]): PredictResult {
    if (!this.model) {
      throw new Error("Classifier.predict() called before load().");
    }

    const matrix = buildInputMatrix(window);

    const t0 = performance.now();
    const probabilities = tf.tidy(() => {
      const input = tf.tensor3d([matrix], [1, MODEL_TIMESTEPS, MODEL_CHANNELS]);
      const output = this.model!.predict(input) as tf.Tensor;
      // dataSync keeps the timing synchronous so latencyMs reflects the full
      // inference cost (Req 4.2); tf.tidy disposes `input` and `output`.
      return Array.from(output.dataSync());
    });
    const latencyMs = performance.now() - t0;

    return { state: argmaxState(probabilities), latencyMs };
  }

  /** The measured total artifact size in bytes (Req 4.3, 4.6). */
  modelSizeBytes(): number {
    return this.measuredBytes;
  }

  /**
   * Whether the measured artifact size reaches the 50 KB threshold (Req 4.6,
   * Property 12). Uses MODEL_SIZE_LIMIT_BYTES (51,200) as the inclusive bound.
   */
  get modelSizeExceeds(): boolean {
    return this.measuredBytes >= MODEL_SIZE_LIMIT_BYTES;
  }

  /** Whether the model has been loaded. */
  get isLoaded(): boolean {
    return this.model !== null;
  }

  /** The excluded cold-start warmup latency (ms), or null if not warmed up. */
  getWarmupLatencyMs(): number | null {
    return this.warmupLatencyMs;
  }

  /** Dispose the underlying model and free its tensors. */
  dispose(): void {
    if (this.model) {
      this.model.dispose();
      this.model = null;
    }
  }
}

/** Create a cognitive-load classifier backed by the shipped TF.js artifact. */
export function createClassifier(options?: ClassifierOptions): CnnGruClassifier {
  return new CnnGruClassifier(options);
}

/** Pure helper: whether a measured byte size reaches the size-exceeds threshold. */
export function modelSizeExceeds(bytes: number): boolean {
  return bytes >= MODEL_SIZE_LIMIT_BYTES;
}
