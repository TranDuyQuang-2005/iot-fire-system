import type { RuntimeState, Telemetry } from "./types";

const CRITICAL_STATES = new Set(["WARNING", "HIGH_RISK", "FIRE", "SUPPRESSING", "POST_FIRE"]);

export interface TelemetryDecision {
  becameOnline: boolean;
  stateTransition: boolean;
  persist: boolean;
  next: RuntimeState;
}

export function decideTelemetry(
  previous: RuntimeState | null,
  telemetry: Telemetry,
  nowMs: number,
  persistenceIntervalMs: number
): TelemetryDecision {
  const becameOnline = previous === null || !previous.online;
  const stateTransition = previous?.lastState !== null && previous?.lastState !== undefined && previous.lastState !== telemetry.state;
  const intervalElapsed = previous === null || nowMs - previous.lastPersistedAt >= persistenceIntervalMs;
  const persist = intervalElapsed || stateTransition || CRITICAL_STATES.has(telemetry.state);
  return {
    becameOnline,
    stateTransition,
    persist,
    next: {
      online: true,
      lastTelemetryAt: nowMs,
      lastPersistedAt: persist ? nowMs : (previous?.lastPersistedAt ?? 0),
      lastState: telemetry.state,
      latest: telemetry
    }
  };
}

export function isOffline(state: RuntimeState, nowMs: number, timeoutMs: number): boolean {
  return state.online && nowMs - state.lastTelemetryAt >= timeoutMs;
}
