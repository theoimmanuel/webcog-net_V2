// Feature: webcam-no-face-detection (bugfix spec)
//
// Task 4.5: privacy guard verification for MediaPipe downloads.
//
// The fix loads the MediaPipe WASM runtime and the FaceLandmarker `.task` model
// over the network. These are body-less GET downloads, so the privacy guard
// must let them through unchanged (Req 2.5), while image/video request bodies
// remain blocked on every transport (Req 3.4). No change to
// lib/privacy/network-guard.ts is required for this.
//
// **Validates: Requirements 2.5, 3.4**

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Avoid pulling TF.js in just to read the URL constants from the pipeline.
vi.mock("@/lib/vision/classifier", () => ({
  createClassifier: vi.fn(),
}));

import {
  DEFAULT_FACE_LANDMARKER_MODEL,
  DEFAULT_MEDIAPIPE_WASM_BASE,
} from "@/lib/vision/pipeline";
import {
  BlockedTransmissionError,
  clearGuardObservers,
  installNetworkGuard,
  onGuardEvent,
  uninstallNetworkGuard,
  type GuardEvent,
} from "@/lib/privacy/network-guard";

// -----------------------------------------------------------------------------
// Transport stubs (installed BEFORE the guard so the guard wraps them)
// -----------------------------------------------------------------------------

const originals = {
  fetch: globalThis.fetch,
  xhrSend: XMLHttpRequest.prototype.send,
  sendBeacon: (navigator as Navigator & { sendBeacon?: Navigator["sendBeacon"] }).sendBeacon,
};

let fetchSpy: ReturnType<typeof vi.fn>;
let xhrSendSpy: ReturnType<typeof vi.fn>;
let beaconSpy: ReturnType<typeof vi.fn>;
let events: GuardEvent[];

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
  xhrSendSpy = vi.fn();
  beaconSpy = vi.fn(() => true);
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  XMLHttpRequest.prototype.send = xhrSendSpy as unknown as XMLHttpRequest["send"];
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: beaconSpy,
  });
  installNetworkGuard();
  events = [];
  onGuardEvent((e) => events.push(e));
});

afterEach(() => {
  clearGuardObservers();
  uninstallNetworkGuard();
  globalThis.fetch = originals.fetch;
  XMLHttpRequest.prototype.send = originals.xhrSend;
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: originals.sendBeacon,
  });
});

const MEDIAPIPE_URLS = [
  `${DEFAULT_MEDIAPIPE_WASM_BASE}/vision_wasm_internal.wasm`,
  `${DEFAULT_MEDIAPIPE_WASM_BASE}/vision_wasm_internal.js`,
  DEFAULT_FACE_LANDMARKER_MODEL,
];

describe("privacy guard allows MediaPipe asset downloads (Req 2.5)", () => {
  it.each(MEDIAPIPE_URLS)("fetch GET %s passes through as { blocked: false }", async (url) => {
    await expect(fetch(url)).resolves.toBeInstanceOf(Response);
    await expect(fetch(url, { method: "GET" })).resolves.toBeInstanceOf(Response);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe(url);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.transport).toBe("fetch");
      expect(e.url).toBe(url);
      expect(e.classification).toEqual({ blocked: false });
    }
  });

  it("fetch with a GET Request object for the model passes through", async () => {
    const req = new Request(DEFAULT_FACE_LANDMARKER_MODEL, { method: "GET" });
    await expect(fetch(req)).resolves.toBeInstanceOf(Response);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(req);
    expect(events).toHaveLength(1);
    expect(events[0].url).toBe(DEFAULT_FACE_LANDMARKER_MODEL);
    expect(events[0].classification).toEqual({ blocked: false });
  });

  it("XHR GET with a body-less send() for the WASM file passes through", () => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${DEFAULT_MEDIAPIPE_WASM_BASE}/vision_wasm_internal.wasm`);
    expect(() => xhr.send()).not.toThrow();

    expect(xhrSendSpy).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0].transport).toBe("xhr");
    expect(events[0].classification).toEqual({ blocked: false });
  });
});

describe("privacy guard still blocks image/video bodies (Req 3.4)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const webmBlob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm" });
  const jpegDataUrl = "data:image/jpeg;base64,/9j/4AAQ";

  it("fetch POST with an image/video body throws BlockedTransmissionError", () => {
    expect(() =>
      fetch(DEFAULT_FACE_LANDMARKER_MODEL, { method: "POST", body: PNG }),
    ).toThrow(BlockedTransmissionError);
    expect(() =>
      fetch("https://example.test/upload", { method: "POST", body: webmBlob() }),
    ).toThrow(BlockedTransmissionError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(events.every((e) => e.classification.blocked)).toBe(true);
  });

  it("XHR#send with an image body throws BlockedTransmissionError", () => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "https://example.test/upload");
    expect(() => xhr.send(jpegDataUrl)).toThrow(BlockedTransmissionError);
    expect(xhrSendSpy).not.toHaveBeenCalled();
  });

  it("sendBeacon with a video body throws BlockedTransmissionError", () => {
    expect(() => navigator.sendBeacon("https://example.test/beacon", webmBlob())).toThrow(
      BlockedTransmissionError,
    );
    expect(beaconSpy).not.toHaveBeenCalled();
  });
});
