/**
 * Privacy transmission guard (Requirements 1.5, 1.6).
 *
 * WebCog-Net performs all webcam capture and inference in the browser and must
 * transmit zero video frames and zero derived biometric imagery to any server
 * (Req 1.5). This module is the single safety net that enforces that invariant:
 * it wraps `fetch`, `XMLHttpRequest#send`, and `navigator.sendBeacon`, inspects
 * every outbound payload, and — if a payload resembles image or video binary
 * data — blocks the transmission by throwing before any bytes leave the page
 * (Req 1.6). The data therefore remains only in volatile browser memory; the
 * guard never copies, stores, or forwards it anywhere.
 *
 * The guard also exposes an instrumentation hook so tests (and dev tooling) can
 * observe every attempted payload and every blocked payload without the data
 * ever being transmitted.
 *
 * Design notes:
 * - Classification is conservative: anything that looks like image/video binary
 *   is blocked. Non-image payloads (plain JSON/text, form fields of text) pass
 *   through so the guard never interferes with legitimate, image-free traffic.
 * - `install()` is idempotent and returns an uninstaller, which keeps it safe to
 *   mount at app init and trivial to set up / tear down around a test.
 */

/** The kind of binary media the guard recognizes and blocks. */
export type BlockedMediaKind = "image" | "video";

/** How a payload was classified against the image/video media rules. */
export type PayloadClassification =
  | { blocked: false }
  | { blocked: true; kind: BlockedMediaKind; reason: string };

/** The transport an outbound payload was attempted on. */
export type GuardTransport = "fetch" | "xhr" | "sendBeacon";

/** A single payload the guard inspected, surfaced to the instrumentation hook. */
export interface GuardEvent {
  /** The transport the transmission was attempted on. */
  transport: GuardTransport;
  /** The request target, when it can be derived without side effects. */
  url?: string;
  /** Whether the payload was blocked (image/video binary) or allowed. */
  classification: PayloadClassification;
  /** Session-epoch milliseconds when the attempt was observed. */
  timestamp: number;
}

/** Observer invoked for every attempted payload the guard inspects. */
export type GuardObserver = (event: GuardEvent) => void;

/**
 * Error thrown when the guard blocks an image/video payload. Carries the
 * classification so a caller or test can assert exactly why it was blocked.
 */
export class BlockedTransmissionError extends Error {
  readonly transport: GuardTransport;
  readonly kind: BlockedMediaKind;

  constructor(transport: GuardTransport, kind: BlockedMediaKind, reason: string) {
    super(
      `WebCog-Net privacy guard blocked a ${kind} payload on ${transport}: ${reason}`,
    );
    this.name = "BlockedTransmissionError";
    this.transport = transport;
    this.kind = kind;
  }
}

// --- Instrumentation hook ---------------------------------------------------

const observers = new Set<GuardObserver>();

/**
 * Register an observer that receives a {@link GuardEvent} for every payload the
 * guard inspects — both allowed and blocked. Returns an unsubscribe function.
 *
 * Observers are notified before a blocked payload throws, so a test can record
 * the attempted and blocked payloads even though nothing is ever transmitted.
 */
export function onGuardEvent(observer: GuardObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

/** Remove every registered observer. Primarily for test isolation. */
export function clearGuardObservers(): void {
  observers.clear();
}

function emit(event: GuardEvent): void {
  // Snapshot so an observer that unsubscribes mid-iteration is safe.
  for (const observer of Array.from(observers)) {
    try {
      observer(event);
    } catch {
      // An observer must never affect transmission control flow.
    }
  }
}

// --- Payload classification -------------------------------------------------

/** Common image/video container magic numbers for raw binary buffers. */
const BINARY_SIGNATURES: ReadonlyArray<{
  kind: BlockedMediaKind;
  label: string;
  bytes: readonly number[];
  offset?: number;
}> = [
  { kind: "image", label: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { kind: "image", label: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { kind: "image", label: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] },
  { kind: "image", label: "BMP", bytes: [0x42, 0x4d] },
  { kind: "image", label: "WEBP/RIFF", bytes: [0x52, 0x49, 0x46, 0x46] },
  // ISO base media (MP4/QuickTime/etc.): "ftyp" box type at offset 4.
  { kind: "video", label: "MP4/ISO-BMFF", bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  // WebM / Matroska EBML header.
  { kind: "video", label: "WebM/Matroska", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
];

function matchesSignature(view: Uint8Array): PayloadClassification {
  for (const sig of BINARY_SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (view.length < offset + sig.bytes.length) {
      continue;
    }
    let hit = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (view[offset + i] !== sig.bytes[i]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      return {
        blocked: true,
        kind: sig.kind,
        reason: `binary buffer matches ${sig.label} signature`,
      };
    }
  }
  return { blocked: false };
}

function kindFromMime(mime: string): BlockedMediaKind | null {
  const normalized = mime.trim().toLowerCase();
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  return null;
}

function classifyDataUrl(value: string): PayloadClassification {
  const match = /^data:(image|video)\//i.exec(value.trimStart());
  if (match) {
    const kind = match[1].toLowerCase() as BlockedMediaKind;
    return {
      blocked: true,
      kind,
      reason: `canvas/data URL with ${kind} MIME type`,
    };
  }
  return { blocked: false };
}

function hasConstructor(value: object, name: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    value.constructor != null &&
    value.constructor.name === name
  );
}

/**
 * Classify a single payload value. Returns a blocked classification when the
 * value resembles image/video binary data:
 *
 * - `Blob`/`File` whose type is an `image/*` or `video/*` MIME type
 * - `ImageBitmap` and `ImageData` (raw decoded pixels — biometric imagery)
 * - `ArrayBuffer`/typed-array views whose bytes match an image/video signature
 * - strings that are `data:image/` or `data:video/` canvas data URLs
 *
 * Non-media values (plain text, JSON, text form fields) are not blocked.
 */
export function classifyPayload(payload: unknown): PayloadClassification {
  if (payload == null) {
    return { blocked: false };
  }

  // Blob / File — classify by declared MIME type.
  if (typeof Blob !== "undefined" && payload instanceof Blob) {
    const kind = kindFromMime(payload.type);
    if (kind) {
      return {
        blocked: true,
        kind,
        reason: `Blob with ${payload.type} MIME type`,
      };
    }
    return { blocked: false };
  }

  // Decoded pixel sources are always biometric imagery.
  if (typeof ImageData !== "undefined" && payload instanceof ImageData) {
    return { blocked: true, kind: "image", reason: "ImageData pixel buffer" };
  }
  if (typeof ImageBitmap !== "undefined" && payload instanceof ImageBitmap) {
    return { blocked: true, kind: "image", reason: "ImageBitmap frame" };
  }
  // Environments without a global ImageBitmap/ImageData (e.g. jsdom) — fall
  // back to a structural name check so the guard still blocks these.
  if (
    typeof payload === "object" &&
    (hasConstructor(payload as object, "ImageBitmap") ||
      hasConstructor(payload as object, "ImageData"))
  ) {
    return {
      blocked: true,
      kind: "image",
      reason: `${(payload as object).constructor.name} frame`,
    };
  }

  // Raw binary — inspect leading bytes for an image/video container signature.
  if (payload instanceof ArrayBuffer) {
    return matchesSignature(new Uint8Array(payload));
  }
  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    return matchesSignature(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }

  // Canvas / data URLs encoded as strings.
  if (typeof payload === "string") {
    return classifyDataUrl(payload);
  }

  // Multipart / url-encoded bodies — inspect each entry.
  if (typeof FormData !== "undefined" && payload instanceof FormData) {
    for (const value of payload.values()) {
      const inner = classifyPayload(value);
      if (inner.blocked) {
        return inner;
      }
    }
    return { blocked: false };
  }
  if (typeof URLSearchParams !== "undefined" && payload instanceof URLSearchParams) {
    for (const [, value] of payload.entries()) {
      const inner = classifyDataUrl(value);
      if (inner.blocked) {
        return inner;
      }
    }
    return { blocked: false };
  }

  return { blocked: false };
}

// --- Transport wrapping -----------------------------------------------------

interface SavedGlobals {
  fetch?: typeof globalThis.fetch;
  xhrSend?: typeof XMLHttpRequest.prototype.send;
  sendBeacon?: typeof navigator.sendBeacon;
}

let installed = false;
let saved: SavedGlobals = {};

function urlFromFetchInput(input: unknown): string | undefined {
  try {
    if (typeof input === "string") {
      return input;
    }
    if (typeof URL !== "undefined" && input instanceof URL) {
      return input.toString();
    }
    if (
      typeof Request !== "undefined" &&
      input instanceof Request &&
      typeof input.url === "string"
    ) {
      return input.url;
    }
  } catch {
    // Deriving the URL is best-effort only and never gates the guard.
  }
  return undefined;
}

/**
 * Inspect a payload for a given transport, notify observers, and block the
 * transmission by throwing when the payload is image/video binary data.
 * Returns normally only when the payload is allowed.
 */
function guardPayload(
  transport: GuardTransport,
  payload: unknown,
  url: string | undefined,
): void {
  const classification = classifyPayload(payload);
  emit({ transport, url, classification, timestamp: Date.now() });
  if (classification.blocked) {
    throw new BlockedTransmissionError(
      transport,
      classification.kind,
      classification.reason,
    );
  }
}

/**
 * Install the guard by wrapping `fetch`, `XMLHttpRequest#send`, and
 * `navigator.sendBeacon` on the current global scope. Mount this once at app
 * init so any accidental image/video transmission is blocked and surfaced
 * (Req 1.6).
 *
 * The call is idempotent: installing while already installed is a no-op that
 * returns the existing uninstaller. The returned function restores the original
 * globals, which keeps the guard easy to tear down between tests.
 */
export function installNetworkGuard(): () => void {
  if (installed) {
    return uninstallNetworkGuard;
  }
  installed = true;

  // fetch
  if (typeof globalThis.fetch === "function") {
    saved.fetch = globalThis.fetch;
    const originalFetch = saved.fetch;
    globalThis.fetch = function guardedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url = urlFromFetchInput(input);
      // The body may live on the init or on a Request instance.
      let body: unknown = init?.body;
      if (
        body == null &&
        typeof Request !== "undefined" &&
        input instanceof Request
      ) {
        // A Request's body is a stream; classify what we can see structurally.
        body = (input as Request & { body?: unknown }).body;
      }
      guardPayload("fetch", body, url);
      return originalFetch.call(this, input as RequestInfo | URL, init);
    };
  }

  // XMLHttpRequest#send
  if (typeof XMLHttpRequest !== "undefined") {
    saved.xhrSend = XMLHttpRequest.prototype.send;
    const originalSend = saved.xhrSend;
    XMLHttpRequest.prototype.send = function guardedSend(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      guardPayload("xhr", body, undefined);
      return originalSend.call(this, body);
    };
  }

  // navigator.sendBeacon
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.sendBeacon === "function"
  ) {
    saved.sendBeacon = navigator.sendBeacon.bind(navigator);
    const originalBeacon = saved.sendBeacon;
    navigator.sendBeacon = function guardedSendBeacon(
      url: string | URL,
      data?: BodyInit | null,
    ): boolean {
      guardPayload("sendBeacon", data, typeof url === "string" ? url : url?.toString());
      return originalBeacon(url, data);
    };
  }

  return uninstallNetworkGuard;
}

/**
 * Restore the original `fetch`, `XMLHttpRequest#send`, and `sendBeacon`
 * implementations. Safe to call when the guard is not installed.
 */
export function uninstallNetworkGuard(): void {
  if (!installed) {
    return;
  }
  if (saved.fetch) {
    globalThis.fetch = saved.fetch;
  }
  if (saved.xhrSend && typeof XMLHttpRequest !== "undefined") {
    XMLHttpRequest.prototype.send = saved.xhrSend;
  }
  if (saved.sendBeacon && typeof navigator !== "undefined") {
    navigator.sendBeacon = saved.sendBeacon;
  }
  saved = {};
  installed = false;
}

/** Whether the guard is currently installed. Primarily for tests. */
export function isNetworkGuardInstalled(): boolean {
  return installed;
}
