import { describe, expect, it } from "vitest";
import { SimulationClock } from "./simulationClock.js";

describe("SimulationClock", () => {
  describe("construction", () => {
    it("defaults to simTime 0 and multiplier 1", () => {
      const clock = new SimulationClock();

      expect(clock.simTime).toBe(0);
      expect(clock.multiplier).toBe(1);
    });

    it("accepts an explicit start time and multiplier", () => {
      const clock = new SimulationClock({ startTime: 25, multiplier: 4 });

      expect(clock.simTime).toBe(25);
      expect(clock.multiplier).toBe(4);
    });

    it("rejects a non-positive or non-finite multiplier", () => {
      for (const multiplier of [
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(() => new SimulationClock({ multiplier })).toThrow(
          /Invalid clock multiplier/,
        );
      }
    });

    it("rejects a negative or non-finite start time", () => {
      for (const startTime of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new SimulationClock({ startTime })).toThrow(
          /Invalid simulation start time/,
        );
      }
    });
  });

  describe("advancement", () => {
    it("accumulates deltas", () => {
      const clock = new SimulationClock();

      clock.advance(10);
      clock.advance(5);

      expect(clock.simTime).toBe(15);
    });

    it("treats a zero delta as a no-op", () => {
      const clock = new SimulationClock({ startTime: 7 });

      clock.advance(0);

      expect(clock.simTime).toBe(7);
    });

    it("rejects a negative or non-finite delta", () => {
      const clock = new SimulationClock();

      for (const delta of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => clock.advance(delta)).toThrow(
          /Invalid simulation time delta/,
        );
      }

      expect(clock.simTime).toBe(0);
    });

    it("does not let the multiplier scale simulation time", () => {
      const clock = new SimulationClock({ multiplier: 10 });

      clock.advance(3);

      expect(clock.simTime).toBe(3);
    });
  });

  describe("multiplier and conversion", () => {
    it("updates the multiplier without touching simulation time", () => {
      const clock = new SimulationClock();
      clock.advance(4);

      clock.setMultiplier(2.5);

      expect(clock.multiplier).toBe(2.5);
      expect(clock.simTime).toBe(4);
    });

    it("rejects an invalid multiplier update", () => {
      const clock = new SimulationClock({ multiplier: 3 });

      expect(() => clock.setMultiplier(0)).toThrow(/Invalid clock multiplier/);
      expect(clock.multiplier).toBe(3);
    });

    it("converts real duration to simulation duration", () => {
      const clock = new SimulationClock({ multiplier: 8 });

      expect(clock.toSimDuration(1000)).toBe(8000);
      expect(clock.toSimDuration(0)).toBe(0);
    });

    it("converts simulation duration to real duration", () => {
      const clock = new SimulationClock({ multiplier: 8 });

      expect(clock.toRealDuration(8000)).toBe(1000);
      expect(clock.toRealDuration(0)).toBe(0);
    });

    it("rejects negative or non-finite conversion inputs", () => {
      const clock = new SimulationClock();

      expect(() => clock.toSimDuration(-1)).toThrow(/Invalid real duration/);
      expect(() => clock.toSimDuration(Number.NaN)).toThrow(
        /Invalid real duration/,
      );
      expect(() => clock.toRealDuration(-1)).toThrow(
        /Invalid simulation duration/,
      );
      expect(() => clock.toRealDuration(Number.NaN)).toThrow(
        /Invalid simulation duration/,
      );
    });
  });
});