// Feature: webcam-no-face-detection (bugfix spec)
//
// Property 2: Preservation - privacy guard body-blocking (Req 3.4).
//
// Observed on UNFIXED code and asserted here so the fix cannot regress it:
// with `installNetworkGuard()` active, image/video request bodies are blocked on
// fetch / XHR#send / sendBeacon with BlockedTransmissionError, while text/JSON
// bodies and body-less GETs pass through to the underlying transport. The
// block/allow decision is exactly `classifyPayload(body).blocked`.
//
// **Validates: Requirements 3.4**

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import {
  BlockedTransmissionError,
  classifyPayload,
  installNetworkGuard,
  uninstallNetworkGuard,
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
});

afterEach(() => {
  uninstallNetworkGuard();
  globalThis.fetch = originals.fetch;
  XMLHttpRequest.prototype.send = originals.xhrSend;
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: originals.sendBeacon,
  });
});

// -----------------------------------------------------------------------------
// Payload generators
// -----------------------------------------------------------------------------

const SIGNATURES: { bytes: number[]; offset?: number }[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47] }, // PNG
  { bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF
  { bytes: [0x42, 0x4d] }, // BMP
  { bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF/WEBP
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // MP4 ftyp
  { bytes: [0x1a, 0x45, 0xdf, 0xa3] }, // WebM
];

/** Image/video bodies the guard must block. */
const mediaBodyArb: fc.Arbitrary<unknown> = fc.oneof(
  fc
    .tuple(fc.constantFrom("image", "video"), fc.constantFrom("png", "jpeg", "webm", "mp4", "gif"))
    .map(([major, minor]) => new Blob([new Uint8Array([1, 2, 3])], { type: `${major}/${minor}` })),
  fc
    .tuple(fc.constantFrom(...SIGNATURES), fc.uint8Array({ maxLength: 32 }))
    .map(([sig, tail]) => {
      const offset = sig.offset ?? 0;
      const out = new Uint8Array(offset + sig.bytes.length + tail.length);
      out.set(sig.bytes, offset);
      out.set(tail, offset + sig.bytes.length);
      return out;
    }),
  fc
    .tuple(fc.constantFrom("image/png", "image/jpeg", "video/webm"), fc.base64String())
    .map(([mime, b64]) => `data:${mime};base64,${b64}`),
);

/** Text / JSON bodies (and absent bodies) the guard must allow. */
const textBodyArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string().filter((s) => !/^data:(image|video)\//i.test(s.trimStart())),
  fc.jsonValue().map((v) => JSON.stringify(v)),
  fc.constantFrom(undefined, null),
);

const bodyArb = fc.oneof(
  mediaBodyArb.map((body) => ({ body, media: true })),
  textBodyArb.map((body) => ({ body, media: false })),
);

// -----------------------------------------------------------------------------
// Properties
// -----------------------------------------------------------------------------

describe("Property 2 (case 5): privacy guard block/allow classification is preserved", () => {
  it("classifyPayload blocks exactly the image/video bodies", () => {
    fc.assert(
      fc.property(bodyArb, ({ body, media }) => {
        expect(classifyPayload(body).blocked).toBe(media);
      }),
      { numRuns: 200 },
    );
  });

  it("fetch / XHR#send / sendBeacon block media bodies with BlockedTransmissionError and pass others through", () => {
    fc.assert(
      fc.property(bodyArb, ({ body, media }) => {
        fetchSpy.mockClear();
        xhrSendSpy.mockClear();
        beaconSpy.mockClear();

        const doFetch = () =>
          fetch("https://example.test/upload", {
            method: "POST",
            body: body as BodyInit | null | undefined,
          });
        const doXhr = () => {
          const xhr = new XMLHttpRequest();
          xhr.send(body as XMLHttpRequestBodyInit | null | undefined);
        };
        const doBeacon = () =>
          navigator.sendBeacon("https://example.test/beacon", body as BodyInit | null);

        if (media) {
          expect(doFetch).toThrow(BlockedTransmissionError);
          expect(doXhr).toThrow(BlockedTransmissionError);
          expect(doBeacon).toThrow(BlockedTransmissionError);
          expect(fetchSpy).not.toHaveBeenCalled();
          expect(xhrSendSpy).not.toHaveBeenCalled();
          expect(beaconSpy).not.toHaveBeenCalled();
        } else {
          expect(doFetch).not.toThrow();
          expect(doXhr).not.toThrow();
          expect(doBeacon).not.toThrow();
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expect(xhrSendSpy).toHaveBeenCalledTimes(1);
          expect(beaconSpy).toHaveBeenCalledTimes(1);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("body-less GET requests are allowed through", () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        fetchSpy.mockClear();
        expect(() => fetch(url)).not.toThrow();
        expect(() => fetch(url, { method: "GET" })).not.toThrow();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      }),
      { numRuns: 50 },
    );
  });
});
