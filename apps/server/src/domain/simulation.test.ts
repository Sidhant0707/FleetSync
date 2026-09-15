import { describe, expect, it } from "vitest";
import { RoadGraph } from "./RoadGraph.js";
import { SimulationEngine } from "./simulation.js";
import type { SimulationEngineOptions } from "./simulation.js";
import type { SimulationEvent } from "./simulationEvents.js";
import type { Depot, Order, Route, RouteStop, Vehicle } from "./types.js";

function addNode(graph: RoadGraph, id: string): void {
  graph.addNode({ id, lat: 0, lng: 0 });
}

function addEdge(
  graph: RoadGraph,
  from: string,
  to: string,
  weight: number,
): void {
  graph.addEdge({
    id: `${from}-${to}`,
    fromNodeId: from,
    toNodeId: to,
    baseWeight: weight,
  });
}

/**
 * D <-> A, D <-> B, plus a one-way A -> B shortcut.
 * U is reachable from D but cannot return.
 */
function buildGraph(): RoadGraph {
  const graph = new RoadGraph();

  ["D", "A", "B", "U"].forEach((id) => addNode(graph, id));

  addEdge(graph, "D", "A", 5);
  addEdge(graph, "A", "D", 5);
  addEdge(graph, "D", "B", 5);
  addEdge(graph, "B", "D", 5);
  addEdge(graph, "A", "B", 2);
  addEdge(graph, "D", "U", 5);

  return graph;
}

function createDepot(): Depot {
  return { id: "d1", name: "Depot d1", nodeId: "D" };
}

function createVehicle(id: string, capacity = 10): Vehicle {
  return {
    id,
    label: `Vehicle ${id}`,
    capacity,
    depotId: "d1",
    status: "idle",
  };
}

function createOrder(id: string, nodeId: string, demand = 1): Order {
  return { id, nodeId, demand, status: "pending" };
}

function createRoute(vehicleId: string, ...orderIds: readonly string[]): Route {
  const stops: RouteStop[] = orderIds.map((orderId, index) => ({
    orderId,
    sequenceNo: index + 1,
  }));

  return {
    id: `route-${vehicleId}`,
    vehicleId,
    version: 1,
    stops: Object.freeze(stops),
  };
}

/**
 * Single vehicle serving A then B, exactly the plan buildStaticPlan produces
 * for this graph: D -> A (5) -> B (2) -> D (5).
 */
function twoStopSetup(
  overrides: Partial<SimulationEngineOptions> = {},
): SimulationEngineOptions {
  return {
    graph: buildGraph(),
    depot: createDepot(),
    routes: [createRoute("v1", "A", "B")],
    orders: [createOrder("A", "A"), createOrder("B", "B")],
    vehicles: [createVehicle("v1")],
    ...overrides,
  };
}

function summarize(
  events: readonly SimulationEvent[],
): readonly (readonly [number, number, string])[] {
  return events.map((event) => [event.seq, event.simTime, event.type] as const);
}

describe("SimulationEngine", () => {
  describe("lifecycle", () => {
    it("emits the started event and departs the vehicle", () => {
      const engine = new SimulationEngine(twoStopSetup());

      const events = engine.start();

      expect(summarize(events)).toEqual([
        [0, 0, "simulation.started"],
        [1, 0, "vehicle.departed"],
        [2, 0, "vehicle.edge_entered"],
      ]);

      const vehicle = engine.getState().vehicles[0];
      expect(vehicle).toMatchObject({
        phase: "traveling",
        currentNodeId: null,
        currentEdgeId: "D-A",
        edgeDuration: 5,
        edgeElapsed: 0,
        legIndex: 0,
        nextStopSequenceNo: 1,
        departedAtSimTime: 0,
      });
      expect(engine.getState().status).toBe("running");
    });

    it("rejects a second start", () => {
      const engine = new SimulationEngine(twoStopSetup());
      engine.start();

      expect(() => engine.start()).toThrow(
        /Simulation has already been started/,
      );
    });

    it("rejects advancing before start", () => {
      const engine = new SimulationEngine(twoStopSetup());

      expect(() => engine.advanceBy(5)).toThrow(
        /Cannot advance a simulation that has not been started/,
      );
      expect(engine.getState().status).toBe("not_started");
    });

    it("rejects a negative or non-finite delta", () => {
      const engine = new SimulationEngine(twoStopSetup());
      engine.start();

      for (const delta of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => engine.advanceBy(delta)).toThrow(
          /Invalid simulation time delta/,
        );
      }
      expect(engine.getState().simTime).toBe(0);
    });

    it("reports idle_at_depot before start", () => {
      const engine = new SimulationEngine(twoStopSetup());

      expect(engine.getState()).toMatchObject({
        status: "not_started",
        simTime: 0,
        depotNodeId: "D",
      });
      expect(engine.getState().vehicles[0]).toMatchObject({
        phase: "idle_at_depot",
        currentNodeId: "D",
        currentEdgeId: null,
        totalTravelTime: 0,
      });
    });
  });

  describe("movement, delivery and completion", () => {
    it("produces the full deterministic event sequence", () => {
      const engine = new SimulationEngine(twoStopSetup());

      engine.start();
      engine.advanceBy(20);

      expect(summarize(engine.getEvents())).toEqual([
        [0, 0, "simulation.started"],
        [1, 0, "vehicle.departed"],
        [2, 0, "vehicle.edge_entered"],
        [3, 5, "vehicle.edge_completed"],
        [4, 5, "order.served"],
        [5, 5, "vehicle.departed"],
        [6, 5, "vehicle.edge_entered"],
        [7, 7, "vehicle.edge_completed"],
        [8, 7, "order.served"],
        [9, 7, "vehicle.departed"],
        [10, 7, "vehicle.edge_entered"],
        [11, 12, "vehicle.edge_completed"],
        [12, 12, "vehicle.route_completed"],
        [13, 12, "simulation.completed"],
      ]);
    });

    it("holds partial progress in the middle of an edge", () => {
      const engine = new SimulationEngine(twoStopSetup());
      engine.start();

      engine.advanceBy(5);
      const events = engine.advanceBy(1);

      expect(events).toEqual([]);
      expect(engine.getState().simTime).toBe(6);
      expect(engine.getState().vehicles[0]).toMatchObject({
        phase: "traveling",
        currentNodeId: null,
        currentEdgeId: "A-B",
        edgeElapsed: 1,
        edgeDuration: 2,
        edgeProgress: 0.5,
        legIndex: 1,
        completedEdgeIds: ["D-A"],
        servedOrderIds: ["A"],
        totalTravelTime: 6,
      });
    });

    it("serves each order on arrival at its own route stop", () => {
      const engine = new SimulationEngine(twoStopSetup());
      engine.start();
      engine.advanceBy(20);

      expect(engine.getState().deliveries).toEqual([
        {
          orderId: "A",
          nodeId: "A",
          vehicleId: "v1",
          routeId: "route-v1",
          sequenceNo: 1,
          deliveredAtSimTime: 5,
        },
        {
          orderId: "B",
          nodeId: "B",
          vehicleId: "v1",
          routeId: "route-v1",
          sequenceNo: 2,
          deliveredAtSimTime: 7,
        },
      ]);
    });

    it("returns the vehicle to the depot and completes at the makespan", () => {
      const engine = new SimulationEngine(twoStopSetup());
      engine.start();
      engine.advanceBy(100);

      const state = engine.getState();

      expect(state.status).toBe("completed");
      expect(state.simTime).toBe(12);
      expect(state.completedAtSimTime).toBe(12);
      expect(state.vehicles[0]).toMatchObject({
        phase: "completed",
        currentNodeId: "D",
        currentEdgeId: null,
        completedEdgeIds: ["D-A", "A-B", "B-D"],
        completedLegIndexes: [0, 1, 2],
        servedOrderIds: ["A", "B"],
        totalTravelTime: 12,
        completedAtSimTime: 12,
        nextStopSequenceNo: null,
      });
    });

    it("stops the clock and emits nothing once completed", () => {
      const engine = new SimulationEngine(twoStopSetup());
      engine.start();
      engine.advanceBy(100);

      const events = engine.advanceBy(50);

      expect(events).toEqual([]);
      expect(engine.getState().simTime).toBe(12);
      expect(engine.getState().status).toBe("completed");
    });

    it("completes a zero-stop route immediately at start", () => {
      const engine = new SimulationEngine(
        twoStopSetup({
          routes: [createRoute("v1")],
        }),
      );

      const events = engine.start();

      expect(summarize(events)).toEqual([
        [0, 0, "simulation.started"],
        [1, 0, "vehicle.route_completed"],
        [2, 0, "simulation.completed"],
      ]);
      expect(engine.getState()).toMatchObject({
        status: "completed",
        simTime: 0,
        completedAtSimTime: 0,
      });
      expect(engine.getState().vehicles[0]).toMatchObject({
        phase: "completed",
        currentNodeId: "D",
        totalTravelTime: 0,
      });
    });
  });

  describe("zero-duration work", () => {
    it("resolves a zero-duration leg and zero service time without another advanceBy", () => {
      // Two orders on node A: the A -> A leg has no edges and zero duration.
      const engine = new SimulationEngine(
        twoStopSetup({
          routes: [createRoute("v1", "A1", "A2")],
          orders: [createOrder("A1", "A"), createOrder("A2", "A")],
        }),
      );

      engine.start();
      const events = engine.advanceBy(5);

      expect(summarize(events)).toEqual([
        [3, 5, "vehicle.edge_completed"],
        [4, 5, "order.served"],
        [5, 5, "vehicle.departed"],
        [6, 5, "order.served"],
        [7, 5, "vehicle.departed"],
        [8, 5, "vehicle.edge_entered"],
      ]);
      expect(engine.getState().vehicles[0]).toMatchObject({
        servedOrderIds: ["A1", "A2"],
        currentEdgeId: "A-D",
      });
    });

    it("delays delivery by the configured service time", () => {
      const engine = new SimulationEngine(
        twoStopSetup({ serviceTimePerStop: 3 }),
      );

      engine.start();
      engine.advanceBy(100);

      expect(
        engine
          .getState()
          .deliveries.map((delivery) => delivery.deliveredAtSimTime),
      ).toEqual([8, 13]);
      // 12 units of travel plus two three-unit stops.
      expect(engine.getState().simTime).toBe(18);
      expect(engine.getState().vehicles[0]?.totalTravelTime).toBe(12);
    });
  });

  describe("multiple vehicles", () => {
    it("orders same-instant events by ascending vehicleId", () => {
      const engine = new SimulationEngine(
        twoStopSetup({
          routes: [createRoute("v2", "B"), createRoute("v1", "A")],
          orders: [createOrder("A", "A"), createOrder("B", "B")],
          vehicles: [createVehicle("v2"), createVehicle("v1")],
        }),
      );

      engine.start();
      engine.advanceBy(100);

      const vehicleOrderAtDeparture = engine
        .getEvents()
        .filter((event) => event.type === "vehicle.departed" && event.simTime === 0)
        .map((event) => (event.type === "vehicle.departed" ? event.vehicleId : ""));

      expect(vehicleOrderAtDeparture).toEqual(["v1", "v2"]);
      expect(engine.getState().vehicles.map((v) => v.vehicleId)).toEqual([
        "v1",
        "v2",
      ]);
      expect(engine.getState().deliveries.map((d) => d.orderId)).toEqual([
        "A",
        "B",
      ]);
      expect(engine.getState().status).toBe("completed");
      expect(engine.getState().simTime).toBe(10);
    });

    it("completes only after every route has finished", () => {
      // v1: D -> A -> D = 2. v2: D -> B -> D = 10.
      const graph = new RoadGraph();
      ["D", "A", "B"].forEach((id) => addNode(graph, id));
      addEdge(graph, "D", "A", 1);
      addEdge(graph, "A", "D", 1);
      addEdge(graph, "D", "B", 5);
      addEdge(graph, "B", "D", 5);

      const engine = new SimulationEngine(
        twoStopSetup({
          graph,
          routes: [createRoute("v1", "A"), createRoute("v2", "B")],
          orders: [createOrder("A", "A"), createOrder("B", "B")],
          vehicles: [createVehicle("v1"), createVehicle("v2")],
        }),
      );

      engine.start();
      engine.advanceBy(2);

      const midState = engine.getState();
      expect(midState.status).toBe("running");
      expect(midState.vehicles[0]?.phase).toBe("completed");
      expect(midState.vehicles[1]?.phase).toBe("traveling");

      engine.advanceBy(8);

      expect(engine.getState().status).toBe("completed");
      expect(engine.getState().simTime).toBe(10);
      expect(engine.getEvents().at(-1)?.type).toBe("simulation.completed");
    });
  });

  describe("determinism", () => {
    it("is unaffected by how a total delta is partitioned", () => {
      const whole = new SimulationEngine(twoStopSetup());
      whole.start();
      whole.advanceBy(10);

      const split = new SimulationEngine(twoStopSetup());
      split.start();
      split.advanceBy(5);
      split.advanceBy(5);

      const fine = new SimulationEngine(twoStopSetup());
      fine.start();
      for (let i = 0; i < 10; i++) {
        fine.advanceBy(1);
      }

      expect(split.getEvents()).toEqual(whole.getEvents());
      expect(fine.getEvents()).toEqual(whole.getEvents());
      expect(split.getState()).toEqual(whole.getState());
      expect(fine.getState()).toEqual(whole.getState());
    });

    it("produces identical results for identical initial state", () => {
      const first = new SimulationEngine(twoStopSetup());
      const second = new SimulationEngine(twoStopSetup());

      first.start();
      first.advanceBy(100);
      second.start();
      second.advanceBy(100);

      expect(second.getEvents()).toEqual(first.getEvents());
      expect(second.getState()).toEqual(first.getState());
    });

    it("keeps the clock multiplier out of state transitions", () => {
      const normal = new SimulationEngine(twoStopSetup());
      const accelerated = new SimulationEngine(
        twoStopSetup({ clockMultiplier: 60 }),
      );

      normal.start();
      normal.advanceBy(100);
      accelerated.start();
      accelerated.advanceBy(100);

      expect(accelerated.getEvents()).toEqual(normal.getEvents());
      expect(accelerated.getState()).toEqual(normal.getState());
    });
  });

  describe("completed segment immutability", () => {
    it("only ever extends completedEdgeIds and never rewrites earlier snapshots", () => {
      const engine = new SimulationEngine(twoStopSetup());
      engine.start();

      const snapshots: (readonly string[])[] = [];

      engine.advanceBy(5);
      const afterFirst = engine.getState().vehicles[0]?.completedEdgeIds ?? [];
      snapshots.push(afterFirst);

      engine.advanceBy(2);
      snapshots.push(engine.getState().vehicles[0]?.completedEdgeIds ?? []);

      engine.advanceBy(5);
      snapshots.push(engine.getState().vehicles[0]?.completedEdgeIds ?? []);

      expect(snapshots).toEqual([
        ["D-A"],
        ["D-A", "A-B"],
        ["D-A", "A-B", "B-D"],
      ]);

      // Every earlier snapshot remains a strict prefix of every later one,
      // and the array handed out earlier is untouched by later progress.
      for (let i = 0; i < snapshots.length - 1; i++) {
        const earlier = snapshots[i] ?? [];
        const later = snapshots[i + 1] ?? [];
        expect(later.slice(0, earlier.length)).toEqual(earlier);
      }
      expect(afterFirst).toEqual(["D-A"]);
    });

    it("hands out frozen snapshots that cannot be mutated by callers", () => {
      const engine = new SimulationEngine(twoStopSetup());
      engine.start();
      engine.advanceBy(5);

      const state = engine.getState();
      const vehicle = state.vehicles[0];
      expect(vehicle).toBeDefined();
      if (vehicle === undefined) {
        return;
      }

      expect(() => {
        (state as { simTime: number }).simTime = 99;
      }).toThrow();
      expect(() => {
        (vehicle.completedEdgeIds as string[]).push("X-Y");
      }).toThrow();
      expect(() => {
        (vehicle as { phase: string }).phase = "completed";
      }).toThrow();

      expect(engine.getState().vehicles[0]?.completedEdgeIds).toEqual(["D-A"]);
    });
  });

  describe("construction gates", () => {
    it("rejects an infeasible plan", () => {
      expect(
        () =>
          new SimulationEngine(
            twoStopSetup({
              // Demand 99 exceeds the vehicle's capacity of 10.
              orders: [createOrder("A", "A", 99), createOrder("B", "B")],
            }),
          ),
      ).toThrow(/Simulation requires a feasible plan; violations:.*exceeds vehicle capacity/);
    });

    it("rejects a plan whose route cannot return to the depot", () => {
      expect(
        () =>
          new SimulationEngine(
            twoStopSetup({
              routes: [createRoute("v1", "U")],
              orders: [createOrder("U", "U")],
            }),
          ),
      ).toThrow(/Cannot return from last order node U to depot node D/);
    });

    it("rejects an invalid clock multiplier", () => {
      expect(
        () => new SimulationEngine(twoStopSetup({ clockMultiplier: 0 })),
      ).toThrow(/Invalid clock multiplier/);
    });

    it("rejects an invalid service time", () => {
      expect(
        () => new SimulationEngine(twoStopSetup({ serviceTimePerStop: -1 })),
      ).toThrow(/Invalid service time per stop/);
      expect(
        () =>
          new SimulationEngine(
            twoStopSetup({ serviceTimePerStop: Number.NaN }),
          ),
      ).toThrow(/Invalid service time per stop/);
    });

    it("rejects two routes for the same vehicle", () => {
      expect(
        () =>
          new SimulationEngine(
            twoStopSetup({
              routes: [
                { ...createRoute("v1", "A"), id: "route-a" },
                { ...createRoute("v1", "B"), id: "route-b" },
              ],
            }),
          ),
      ).toThrow(
        /Vehicle v1 has more than one route: route-a, route-b/,
      );
    });

    it("rejects a route referencing an unknown vehicle", () => {
      expect(
        () =>
          new SimulationEngine(
            twoStopSetup({
              routes: [createRoute("ghost", "A")],
            }),
          ),
      ).toThrow(/Route route-ghost references unknown vehicle ghost/);
    });

    it("rejects a depot node that is absent from the graph", () => {
      expect(
        () =>
          new SimulationEngine(
            twoStopSetup({
              depot: { id: "d1", name: "Depot d1", nodeId: "missing" },
            }),
          ),
      ).toThrow(/Depot node missing for depot d1 does not exist in graph/);
    });
  });

  describe("caller-owned inputs", () => {
    it("does not mutate the supplied routes, orders or vehicles", () => {
      const options = twoStopSetup({
        routes: [createRoute("v2", "B"), createRoute("v1", "A")],
        orders: [createOrder("A", "A"), createOrder("B", "B")],
        vehicles: [createVehicle("v2"), createVehicle("v1")],
      });

      const before = JSON.stringify({
        routes: options.routes,
        orders: options.orders,
        vehicles: options.vehicles,
      });

      const engine = new SimulationEngine(options);
      engine.start();
      engine.advanceBy(100);

      expect(
        JSON.stringify({
          routes: options.routes,
          orders: options.orders,
          vehicles: options.vehicles,
        }),
      ).toBe(before);

      // Delivery is recorded by the engine, never by rewriting order status.
      expect(options.orders.map((order) => order.status)).toEqual([
        "pending",
        "pending",
      ]);
      expect(options.vehicles.map((vehicle) => vehicle.capacity)).toEqual([
        10, 10,
      ]);
    });
  });
});