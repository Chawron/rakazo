import { describe, expect, it } from "vitest";
import {
  docDeliveryGateEnabled,
  effectResultProvesDocCheck,
  isPdfContent,
  runHasPassingDocCheck,
} from "./doc-delivery-gate.js";

const SHA = "b".repeat(64);
const OTHER_SHA = "c".repeat(64);

describe("docDeliveryGateEnabled", () => {
  it("is on by default and off only for explicit off values", () => {
    expect(docDeliveryGateEnabled({})).toBe(true);
    expect(docDeliveryGateEnabled({ RAKAZO_DOC_DELIVERY_GATE: "on" })).toBe(true);
    expect(docDeliveryGateEnabled({ RAKAZO_DOC_DELIVERY_GATE: "off" })).toBe(false);
    expect(docDeliveryGateEnabled({ RAKAZO_DOC_DELIVERY_GATE: " OFF " })).toBe(false);
    expect(docDeliveryGateEnabled({ RAKAZO_DOC_DELIVERY_GATE: "false" })).toBe(false);
    expect(docDeliveryGateEnabled({ RAKAZO_DOC_DELIVERY_GATE: "0" })).toBe(false);
  });
});

describe("effectResultProvesDocCheck", () => {
  it("accepts a direct passing verdict for the same hash", () => {
    expect(effectResultProvesDocCheck({ passed: true, sha256: SHA }, SHA)).toBe(true);
  });

  it("rejects a failing verdict and a verdict for another file", () => {
    expect(effectResultProvesDocCheck({ passed: false, sha256: SHA }, SHA)).toBe(false);
    expect(effectResultProvesDocCheck({ passed: true, sha256: OTHER_SHA }, SHA)).toBe(false);
  });

  it("rejects a render result, which names the hash but carries no verdict", () => {
    expect(effectResultProvesDocCheck({ ok: true, sha256: SHA, pages: 2 }, SHA)).toBe(false);
  });

  it("finds the verdict inside an MCP envelope (structured content and JSON text)", () => {
    const verdict = { passed: true, sha256: SHA, criteria: [] };
    expect(effectResultProvesDocCheck({ structuredContent: verdict }, SHA)).toBe(true);
    expect(
      effectResultProvesDocCheck({ content: [{ type: "text", text: JSON.stringify(verdict) }] }, SHA),
    ).toBe(true);
  });

  it("ignores non-results", () => {
    expect(effectResultProvesDocCheck(null, SHA)).toBe(false);
    expect(effectResultProvesDocCheck("passed", SHA)).toBe(false);
    expect(effectResultProvesDocCheck(42, SHA)).toBe(false);
  });
});

describe("isPdfContent", () => {
  it("detects the PDF signature at the start or after a short preamble", () => {
    expect(isPdfContent(new TextEncoder().encode("%PDF-1.4 body"))).toBe(true);
    expect(isPdfContent(new TextEncoder().encode("\n\n%PDF-1.7 body"))).toBe(true);
  });

  it("ignores plain text and text that merely mentions the signature late", () => {
    expect(isPdfContent(new TextEncoder().encode("meeting notes"))).toBe(false);
    expect(isPdfContent(new TextEncoder().encode("x".repeat(2000) + "%PDF-"))).toBe(false);
    expect(isPdfContent(new Uint8Array(0))).toBe(false);
  });
});

describe("runHasPassingDocCheck", () => {
  it("scans the run's completed effects for the verdict", async () => {
    const store = {
      externalEffect: {
        findMany: async () => [
          { result: { ok: true, sha256: SHA } },
          {
            result: {
              content: [{ type: "text", text: JSON.stringify({ passed: true, sha256: SHA }) }],
            },
          },
        ],
      },
    };
    await expect(runHasPassingDocCheck(store, "run-1", SHA)).resolves.toBe(true);
    await expect(runHasPassingDocCheck(store, "run-1", OTHER_SHA)).resolves.toBe(false);
  });
});
