/**
 * Deterministic simulation clock.
 *
 * This is a pure counter of SIMULATION time. It knows nothing about vehicles,
 * routes, events or the road graph, and it never reads the wall clock.
 *
 * `multiplier` exists only so that a future real-time playback driver (which
 * lives OUTSIDE the domain) can convert between real milliseconds and
 * simulation-time units. No state transition in the simulator may depend on
 * it: the engine advances time exclusively through explicit deltas.
 */
export interface SimulationClockOptions {
  /** Simulation time the clock starts at. Defaults to 0. */
  readonly startTime?: number;

  /** Real-time playback acceleration factor. Defaults to 1. */
  readonly multiplier?: number;
}

export class SimulationClock {
  #simTime: number;
  #multiplier: number;

  constructor(options: SimulationClockOptions = {}) {
    const startTime = options.startTime ?? 0;
    const multiplier = options.multiplier ?? 1;

    if (!Number.isFinite(startTime) || startTime < 0) {
      throw new Error(
        `Invalid simulation start time: ${String(startTime)}; expected a non-negative finite number`,
      );
    }

    assertValidMultiplier(multiplier);

    this.#simTime = startTime;
    this.#multiplier = multiplier;
  }

  get simTime(): number {
    return this.#simTime;
  }

  get multiplier(): number {
    return this.#multiplier;
  }

  setMultiplier(multiplier: number): void {
    assertValidMultiplier(multiplier);
    this.#multiplier = multiplier;
  }

  /**
   * Moves simulation time forward by `delta` simulation-time units.
   *
   * The multiplier deliberately does NOT apply here; it is a playback concern
   * only.
   */
  advance(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) {
      throw new Error(
        `Invalid simulation time delta: ${String(delta)}; expected a non-negative finite number`,
      );
    }

    this.#simTime += delta;
  }

  /** Converts elapsed real milliseconds into simulation-time units. */
  toSimDuration(realDuration: number): number {
    if (!Number.isFinite(realDuration) || realDuration < 0) {
      throw new Error(
        `Invalid real duration: ${String(realDuration)}; expected a non-negative finite number`,
      );
    }

    return realDuration * this.#multiplier;
  }

  /** Converts simulation-time units into the real duration playback would take. */
  toRealDuration(simDuration: number): number {
    if (!Number.isFinite(simDuration) || simDuration < 0) {
      throw new Error(
        `Invalid simulation duration: ${String(simDuration)}; expected a non-negative finite number`,
      );
    }

    return simDuration / this.#multiplier;
  }
}

function assertValidMultiplier(multiplier: number): void {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(
      `Invalid clock multiplier: ${String(multiplier)}; expected a positive finite number`,
    );
  }
}