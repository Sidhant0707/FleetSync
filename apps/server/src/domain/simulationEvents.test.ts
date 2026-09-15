import { describe, expect, it } from "vitest";
import { SimulationEventLog } from "./simulationEvents.js";

describe("SimulationEventLog", () => {
  it("starts empty", () => {
    const log = new SimulationEventLog();

    expect(log.size).toBe(0);
    expect(log.all()).toEqual([]);
  });

  it("assigns monotonic sequence numbers starting at 0", () => {
    const log = new SimulationEventLog();

    log.append({
      simTime: 0,
      type: "simulation.started",
      vehicleIds: ["v1"],
    });
    log.append({
      simTime: 5,
      type: "order.served",
      vehicleId: "v1",
      routeId: "route-v1",
      orderId: "A",
      nodeId: "A",
      sequenceNo: 1,
    });

    expect(log.all().map((event) => event.seq)).toEqual([0, 1]);
    expect(log.size).toBe(2);
  });

  it("returns the appended event", () => {
    const log = new SimulationEventLog();

    const event = log.append({
      simTime: 12,
      type: "simulation.completed",
      servedOrderCount: 2,
      vehicleCount: 1,
    });

    expect(event).toEqual({
      seq: 0,
      simTime: 12,
      type: "simulation.completed",
      servedOrderCount: 2,
      vehicleCount: 1,
    });
  });

  it("returns only events appended at or after a sequence number", () => {
    const log = new SimulationEventLog();

    log.append({ simTime: 0, type: "simulation.started", vehicleIds: [] });
    const from = log.size;
    log.append({
      simTime: 3,
      type: "vehicle.edge_completed",
      vehicleId: "v1",
      edgeId: "D-A",
      toNodeId: "A",
    });

    expect(log.since(from).map((event) => event.type)).toEqual([
      "vehicle.edge_completed",
    ]);
    expect(log.since(log.size)).toEqual([]);
  });

  it("rejects an invalid sequence number", () => {
    const log = new SimulationEventLog();

    expect(() => log.since(-1)).toThrow(/Invalid event sequence number/);
    expect(() => log.since(1.5)).toThrow(/Invalid event sequence number/);
  });

  it("freezes appended events and returns copies of the log", () => {
    const log = new SimulationEventLog();
    const event = log.append({
      simTime: 0,
      type: "simulation.started",
      vehicleIds: ["v1"],
    });

    expect(Object.isFrozen(event)).toBe(true);
    expect(() => {
      (event as { simTime: number }).simTime = 99;
    }).toThrow();

    const all = log.all();
    expect(Object.isFrozen(all)).toBe(true);
    expect(() => {
      (all as unknown[]).push(event);
    }).toThrow();
    expect(log.size).toBe(1);
  });
});