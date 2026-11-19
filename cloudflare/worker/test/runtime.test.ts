import { describe, expect, it } from "vitest";
import { decideTelemetry, isOffline } from "../src/runtime";
import type { RuntimeState } from "../src/types";
import { telemetry } from "./fixtures";

const previous: RuntimeState = { online: true, lastTelemetryAt: 1000, lastPersistedAt: 1000, lastState: "NORMAL", latest: telemetry };

describe("runtime persistence and availability", () => {
  it("samples normal telemetry at ten seconds", () => {
    expect(decideTelemetry(previous, telemetry, 9999, 10_000).persist).toBe(false);
    expect(decideTelemetry(previous, telemetry, 11_000, 10_000).persist).toBe(true);
  });
  it("persists critical states immediately", () => expect(decideTelemetry(previous, { ...telemetry, state: "FIRE" }, 1001, 10_000).persist).toBe(true));
  it("persists any state transition immediately", () => expect(decideTelemetry(previous, { ...telemetry, state: "HOT" }, 1001, 10_000).persist).toBe(true));
  it("uses runtime telemetry timestamp for offline detection", () => {
    expect(isOffline(previous, 15_999, 15_000)).toBe(false);
    expect(isOffline(previous, 16_000, 15_000)).toBe(true);
  });
});
