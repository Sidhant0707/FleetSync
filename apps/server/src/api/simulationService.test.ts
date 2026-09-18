import { describe, expect, it } from "vitest";
import {
  ApiError,
  SimulationService,
} from "./simulationService.js";

function advanceToCompletion(
  service: SimulationService,
): void {
  let guard = 0;

  while (
    service.getState().status !== "completed"
  ) {
    guard += 1;

    if (guard > 200) {
      throw new Error(
        "Simulation did not complete",
      );
    }

    service.advance(1);
  }
}

describe("SimulationService", () => {
  it("exposes the deterministic scenario plan", () => {
    const scenario =
      new SimulationService().getScenario();

    expect(
      scenario.nodes.map((node) => node.id),
    ).toEqual(["D", "A", "B", "C", "E"]);

    expect(
      scenario.routes.map(
        (route) => route.routeId,
      ),
    ).toEqual(["route-v1", "route-v2"]);

    expect(
      scenario.routes[0]?.legs.map(
        (leg) =>
          `${leg.fromNodeId}->${leg.toNodeId}:${String(leg.duration)}`,
      ),
    ).toEqual([
      "D->A:4",
      "A->B:2",
      "B->D:6",
    ]);

    expect(
      scenario.routes[0]?.totalTravelTime,
    ).toBe(12);

    expect(
      scenario.unassignedOrders,
    ).toEqual([]);
  });

  it("reports a fresh simulation correctly", () => {
    const state =
      new SimulationService().getState();

    expect(state.status).toBe("not_started");
    expect(state.simTime).toBe(0);
    expect(state.eventCount).toBe(0);

    expect(
      state.vehicles.map(
        (vehicle) => vehicle.phase,
      ),
    ).toEqual([
      "idle_at_depot",
      "idle_at_depot",
    ]);

    expect(
      state.orders.every(
        (order) => !order.delivered,
      ),
    ).toBe(true);
  });

  it("starts and returns emitted events", () => {
    const service = new SimulationService();

    const result = service.start();

    expect(result.state.status).toBe(
      "running",
    );

    expect(
      result.events.events.map(
        (event) => event.type,
      ),
    ).toEqual([
      "simulation.started",
      "vehicle.departed",
      "vehicle.edge_entered",
      "vehicle.departed",
      "vehicle.edge_entered",
    ]);

    expect(
      result.events.events[0]?.seq,
    ).toBe(0);
  });

  it("rejects a second start", () => {
    const service = new SimulationService();

    service.start();

    expect(() => service.start())
      .toThrow(ApiError);

    expect(() => service.start())
      .toThrow(/already been started/);
  });

  it("rejects advance before start", () => {
    const service = new SimulationService();

    expect(() => service.advance(1))
      .toThrow(ApiError);

    try {
      service.advance(1);
    } catch (error) {
      expect(
        (error as ApiError).statusCode,
      ).toBe(409);
    }
  });

  it("rejects invalid delta values", () => {
    const service = new SimulationService();

    service.start();

    for (
      const delta of [
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]
    ) {
      expect(() => service.advance(delta))
        .toThrow(ApiError);
    }
  });

  it("moves a vehicle along its current edge", () => {
    const service = new SimulationService();

    service.start();
    service.advance(2);

    const vehicle =
      service.getState().vehicles[0];

    expect(vehicle).toMatchObject({
      phase: "traveling",
      currentNodeId: null,
      currentEdgeId: "D-A",
      edgeElapsed: 2,
      edgeDuration: 4,
      edgeProgress: 0.5,
    });

    expect(
      service.getState().simTime,
    ).toBe(2);
  });

  it("serves an order at its stop", () => {
    const service = new SimulationService();

    service.start();
    service.advance(5);

    const delivered =
      service
        .getState()
        .orders
        .filter(
          (order) => order.delivered,
        );

    expect(
      delivered.map(
        (order) => order.orderId,
      ),
    ).toEqual(["o1"]);

    expect(delivered[0]).toMatchObject({
      deliveredAtSimTime: 5,
      deliveredByVehicleId: "v1",
    });
  });

  it("reaches deterministic completion", () => {
    const service = new SimulationService();

    service.start();
    advanceToCompletion(service);

    const state =
      service.getState();

    expect(state.status).toBe(
      "completed",
    );

    expect(state.simTime).toBe(17);
    expect(state.completedAtSimTime).toBe(17);

    expect(
      state.orders.every(
        (order) => order.delivered,
      ),
    ).toBe(true);

    expect(
      state.vehicles.every(
        (vehicle) =>
          vehicle.phase === "completed",
      ),
    ).toBe(true);
  });

  it("produces no new events after completion", () => {
    const service = new SimulationService();

    service.start();
    advanceToCompletion(service);

    const result = service.advance(10);

    expect(result.events.events)
      .toEqual([]);

    expect(result.state.simTime)
      .toBe(17);

    expect(result.state.status)
      .toBe("completed");
  });

  it("is invariant to delta partitioning", () => {
    const coarse =
      new SimulationService();

    coarse.start();
    coarse.advance(17);

    const fine =
      new SimulationService();

    fine.start();

    for (let i = 0; i < 17; i += 1) {
      fine.advance(1);
    }

    expect(fine.getState())
      .toEqual(coarse.getState());

    expect(fine.getEvents())
      .toEqual(coarse.getEvents());
  });

  it("supports incremental event retrieval", () => {
    const service = new SimulationService();

    service.start();

    const afterStart =
      service.getEvents().nextSeq;

    service.advance(5);

    const incremental =
      service.getEvents(afterStart);

    expect(
      incremental.events.every(
        (event) =>
          event.seq >= afterStart,
      ),
    ).toBe(true);

    expect(
      incremental.nextSeq,
    ).toBe(
      service.getState().eventCount,
    );

    expect(
      incremental.events.map(
        (event) => event.type,
      ),
    ).toContain("order.served");
  });

  it("rejects a negative event sequence", () => {
    const service = new SimulationService();

    expect(() => service.getEvents(-1))
      .toThrow(ApiError);

    try {
      service.getEvents(-1);
    } catch (error) {
      expect(
        (error as ApiError).statusCode,
      ).toBe(400);
    }
  });

  it("resets to a fresh simulation", () => {
    const service =
      new SimulationService();

    service.start();
    advanceToCompletion(service);

    const result = service.reset();

    expect(result.state.status)
      .toBe("not_started");

    expect(result.state.simTime)
      .toBe(0);

    expect(result.state.eventCount)
      .toBe(0);

    expect(result.events.events)
      .toEqual([]);

    expect(
      result.state.orders.every(
        (order) => !order.delivered,
      ),
    ).toBe(true);
  });

  it("allows a deterministic second run", () => {
    const service =
      new SimulationService();

    service.start();
    advanceToCompletion(service);

    const firstRun =
      service.getState();

    service.reset();
    service.start();
    advanceToCompletion(service);

    expect(service.getState())
      .toEqual(firstRun);
  });
});
