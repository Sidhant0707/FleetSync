import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createDemoScenario,
} from "./scenario.js";

import {
  SimulationEngine,
} from "../domain/simulation.js";

import {
  checkPlanFeasibility,
} from "../domain/planFeasibility.js";

function engineFor(
  scenario = createDemoScenario(),
): SimulationEngine {
  return new SimulationEngine({
    graph: scenario.graph,
    depot: scenario.depot,
    routes: scenario.plan.routes,
    orders: scenario.orders,
    vehicles: scenario.vehicles,
    serviceTimePerStop:
      scenario.serviceTimePerStop,
  });
}

describe("createDemoScenario", () => {
  it("uses the existing optimizer to build the demo routes", () => {
    const scenario =
      createDemoScenario();

    expect(
      scenario.plan.routes.map(
        (route) => ({
          id: route.id,
          vehicleId: route.vehicleId,
          stops: route.stops.map(
            (stop) => stop.orderId,
          ),
        }),
      ),
    ).toEqual([
      {
        id: "route-v1",
        vehicleId: "v1",
        stops: ["o1", "o2"],
      },
      {
        id: "route-v2",
        vehicleId: "v2",
        stops: ["o3", "o4"],
      },
    ]);
  });

  it("produces a feasible plan with all orders assigned", () => {
    const scenario =
      createDemoScenario();

    expect(
      scenario.plan.feasibility.feasible,
    ).toBe(true);

    expect(
      scenario.plan.feasibility.violations,
    ).toEqual([]);

    expect(
      scenario.plan.unassigned,
    ).toEqual([]);
  });

  it("passes an independent plan feasibility check", () => {
    const scenario =
      createDemoScenario();

    const result =
      checkPlanFeasibility(
        scenario.plan.routes,
        new Map(
          scenario.vehicles.map(
            (vehicle) => [
              vehicle.id,
              vehicle,
            ],
          ),
        ),
        new Map(
          scenario.orders.map(
            (order) => [
              order.id,
              order,
            ],
          ),
        ),
        new Map([
          [
            scenario.depot.id,
            scenario.depot,
          ],
        ]),
        scenario.graph,
      );

    expect(result.feasible).toBe(true);
  });

  it("is deterministic across calls", () => {
    const first =
      createDemoScenario();

    const second =
      createDemoScenario();

    expect(second.plan.routes)
      .toEqual(first.plan.routes);

    expect(second.nodes)
      .toEqual(first.nodes);

    expect(second.edges)
      .toEqual(first.edges);
  });

  it("creates an isolated graph per scenario", () => {
    const first =
      createDemoScenario();

    first.graph.closeEdge("D-A");

    const second =
      createDemoScenario();

    expect(
      second.graph.getEdge("D-A").status,
    ).toBe("open");
  });

  it("can be executed to completion", () => {
    const scenario =
      createDemoScenario();

    const engine =
      engineFor(scenario);

    engine.start();
    engine.advanceBy(100);

    const state =
      engine.getState();

    expect(state.status)
      .toBe("completed");

    expect(state.simTime)
      .toBe(17);

    expect(
      state.deliveries.map(
        (delivery) =>
          delivery.orderId,
      ),
    ).toEqual([
      "o1",
      "o3",
      "o2",
      "o4",
    ]);
  });

  it("does not mutate the scenario's source objects", () => {
    const scenario =
      createDemoScenario();

    const engine =
      engineFor(scenario);

    engine.start();
    engine.advanceBy(100);

    expect(
      scenario.orders.map(
        (order) => order.status,
      ),
    ).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);

    expect(
      scenario.vehicles.map(
        (vehicle) => vehicle.capacity,
      ),
    ).toEqual([10, 10]);
  });
});
