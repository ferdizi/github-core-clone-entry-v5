// A logical clock: every timestamp the forge stamps comes from here, never from
// the wall clock and never from Math.random, so a run's state is deterministic
// and a replay sees the same bytes. The base is 2025-01-01T00:00:00Z; each call
// advances one second.

export const CLOCK_BASE_EPOCH = 1735689600;

let tick = 0;

/** The next logical second, as epoch seconds. */
export function tickNow(): number {
  const now = CLOCK_BASE_EPOCH + tick;
  tick += 1;
  return now;
}

/** The next logical second, as an ISO-8601 UTC string. */
export function isoNow(): string {
  return new Date(tickNow() * 1000).toISOString();
}

/** A git timestamp line fragment for an epoch second: "<epoch> +0000". */
export function gitTimestamp(epochSec: number): string {
  return `${epochSec} +0000`;
}
