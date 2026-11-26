import { describe, expect, it } from "vitest";
import { RoadGraph } from "./RoadGraph.js";
import { expandRoute } from "./routeExpansion.js";
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

describe("SimulationEngine.getRouteProgressSnapshot", () => {
  it("returns the engine's own committed routes with ids, versions and leg order", () => {
    const engine = new SimulationEngine(twoStopSetup());
    engine.start();

    const snapshot = engine.getRouteProgressSnapshot();

    expect(snapshot.routes).toHaveLength(1);
    const route = snapshot.routes[0];
    expect(route).toMatchObject({
      routeId: "route-v1",
      vehicleId: "v1",
      version: 1,
      depotNodeId: "D",
      totalTravelTime: 12,
    });
    expect(
      route?.legs.map((leg) => [
        leg.legIndex,
        leg.kind,
        leg.fromNodeId,
        leg.toNodeId,
        [...leg.edgeIds],
        leg.arrivalOrderId,
        leg.arrivalSequenceNo,
      ]),
    ).toEqual([
      [0, "depot_to_stop", "D", "A", ["D-A"], "A", 1],
      [1, "stop_to_stop", "A", "B", ["A-B"], "B", 2],
      [2, "stop_to_depot", "B", "D", ["B-D"], null, null],
    ]);

    // The very same objects on every call: exposed, not reconstructed.
    expect(engine.getRouteProgressSnapshot().routes[0]).toBe(route);
  });

  it("keeps the committed legs after the graph changes, unlike a fresh expansion", () => {
    const options = twoStopSetup();
    const engine = new SimulationEngine(options);
    engine.start();

    const committed = engine.getRouteProgressSnapshot().routes[0];

    // Closing A-B would send a re-expanded leg A -> B through the depot.
    options.graph.closeEdge("A-B");

    const reExpanded = expandRoute(
      createRoute("v1", "A", "B"),
      new Map(options.orders.map((order) => [order.id, order])),
      "D",
      options.graph,
    );

    expect(reExpanded.ok).toBe(true);
    if (reExpanded.ok) {
      expect(reExpanded.expanded.legs[1]?.edgeIds).toEqual(["A-D", "D-B"]);
    }

    expect(committed?.legs[1]?.edgeIds).toEqual(["A-B"]);
    expect(engine.getRouteProgressSnapshot().routes[0]).toBe(committed);
  });

  it("cannot be used to change the engine", () => {
    const engine = new SimulationEngine(twoStopSetup());
    engine.start();

    const snapshot = engine.getRouteProgressSnapshot();
    const route = snapshot.routes[0];
    const leg = route?.legs[1];
    const state = snapshot.vehicleStates[0];

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.routes)).toBe(true);
    expect(Object.isFrozen(snapshot.vehicleStates)).toBe(true);
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route?.legs)).toBe(true);
    expect(Object.isFrozen(leg)).toBe(true);
    expect(Object.isFrozen(leg?.edgeIds)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state?.completedEdgeIds)).toBe(true);

    // Every write is refused; none reaches the engine.
    expect(Reflect.set(snapshot.routes, 0, undefined)).toBe(false);
    expect(Reflect.set(route ?? {}, "version", 99)).toBe(false);
    expect(Reflect.set(route?.legs ?? [], 1, undefined)).toBe(false);
    expect(Reflect.set(leg?.edgeIds ?? [], 0, "X")).toBe(false);
    expect(Reflect.set(state ?? {}, "phase", "completed")).toBe(false);

    expect(engine.getRouteProgressSnapshot().routes[0]?.legs[1]?.edgeIds).toEqual([
      "A-B",
    ]);

    engine.advanceBy(100);
    expect(engine.getState().status).toBe("completed");
    expect(engine.getState().simTime).toBe(12);
  });

  it("returns fresh arrays on each call that share the same route objects", () => {
    const engine = new SimulationEngine(twoStopSetup());
    engine.start();

    const first = engine.getRouteProgressSnapshot();
    const second = engine.getRouteProgressSnapshot();

    expect(second).not.toBe(first);
    expect(second.routes).not.toBe(first.routes);
    expect(second.vehicleStates).not.toBe(first.vehicleStates);
    expect(second.routes[0]).toBe(first.routes[0]);
  });

  it("describes one consistent instant: routes, vehicle states and time agree", () => {
    const engine = new SimulationEngine(
      twoStopSetup({
        routes: [createRoute("v2", "B"), createRoute("v1", "A")],
        vehicles: [createVehicle("v2"), createVehicle("v1")],
      }),
    );
    engine.start();
    engine.advanceBy(3);

    const snapshot = engine.getRouteProgressSnapshot();
    const state = engine.getState();

    expect(snapshot.status).toBe(state.status);
    expect(snapshot.simTime).toBe(3);
    expect(snapshot.simTime).toBe(state.simTime);
    expect(snapshot.vehicleStates).toEqual(state.vehicles);

    // Both arrays are sorted by vehicleId and line up index for index.
    expect(snapshot.routes.map((route) => route.vehicleId)).toEqual(["v1", "v2"]);
    expect(snapshot.vehicleStates.map((vehicle) => vehicle.vehicleId)).toEqual([
      "v1",
      "v2",
    ]);
    snapshot.routes.forEach((route, index) => {
      expect(snapshot.vehicleStates[index]).toMatchObject({
        vehicleId: route.vehicleId,
        routeId: route.routeId,
        routeVersion: route.version,
      });
    });
  });

  it("is available before start, with every vehicle idle at the depot", () => {
    const engine = new SimulationEngine(twoStopSetup());

    const snapshot = engine.getRouteProgressSnapshot();

    expect(snapshot.status).toBe("not_started");
    expect(snapshot.simTime).toBe(0);
    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.vehicleStates[0]).toMatchObject({
      phase: "idle_at_depot",
      currentNodeId: "D",
    });
  });

  it("is taken at a settled instant: a vehicle arriving exactly now has entered its next edge", () => {
    const engine = new SimulationEngine(twoStopSetup());
    engine.start();
    engine.advanceBy(5);

    const snapshot = engine.getRouteProgressSnapshot();

    expect(snapshot.simTime).toBe(5);
    expect(snapshot.vehicleStates[0]).toMatchObject({
      phase: "traveling",
      currentEdgeId: "A-B",
      edgeElapsed: 0,
      legIndex: 1,
      edgeIndexInLeg: 0,
      completedEdgeIds: ["D-A"],
      completedLegIndexes: [0],
      servedOrderIds: ["A"],
    });
  });
});


describe("SimulationEngine.advanceTo", () => {
  function startedEngine(
    overrides: Partial<SimulationEngineOptions> = {},
  ): SimulationEngine {
    const engine = new SimulationEngine(twoStopSetup(overrides));
    engine.start();
    return engine;
  }

  it("lands exactly on 0.9 from 0.2, where adding a computed delta does not", () => {
    // The floating-point fact this method exists to avoid.
    expect(0.2 + (0.9 - 0.2)).not.toBe(0.9);

    const engine = startedEngine();
    engine.advanceBy(0.2);
    expect(engine.getState().simTime).toBe(0.2);

    engine.advanceTo(0.9);

    const state = engine.getState();
    expect(state.simTime).toBe(0.9);
    expect(state.status).toBe("running");
    expect(state.vehicles[0]).toMatchObject({
      phase: "traveling",
      currentEdgeId: "D-A",
    });
    expect(state.vehicles[0]?.edgeElapsed).toBeCloseTo(0.9, 12);
  });

  it("lands exactly on every reachable pair of tenths up to 2.0", () => {
    for (let from = 1; from <= 20; from += 1) {
      for (let to = from + 1; to <= 20; to += 1) {
        const engine = startedEngine();
        engine.advanceTo(from / 10);
        engine.advanceTo(to / 10);

        expect(engine.getState().simTime, `${from / 10} -> ${to / 10}`).toBe(
          to / 10,
        );
      }
    }
  });

  it("stops at each transition on the way and lands exactly on the target", () => {
    const engine = startedEngine();

    const events = engine.advanceTo(7.1);

    expect(engine.getState().simTime).toBe(7.1);
    expect(engine.getState().vehicles[0]?.completedEdgeIds).toEqual([
      "D-A",
      "A-B",
    ]);
    // Transitions keep their own exact instants (5 and 7), not the target's.
    expect(
      events
        .filter((event) => event.type === "vehicle.edge_completed")
        .map((event) => event.simTime),
    ).toEqual([5, 7]);
  });

  it("matches advanceBy on integer times: same events, same state", () => {
    const byTarget = startedEngine();
    const byDelta = startedEngine();

    const targetEvents = byTarget.advanceTo(5);
    const deltaEvents = byDelta.advanceBy(5);

    expect(targetEvents).toEqual(deltaEvents);
    expect(byTarget.getState()).toEqual(byDelta.getState());
    // Same-instant transitions are settled before returning.
    expect(byTarget.getState().vehicles[0]).toMatchObject({
      currentEdgeId: "A-B",
      edgeElapsed: 0,
      servedOrderIds: ["A"],
    });
  });

  it("is a no-op when the target equals the current time", () => {
    const engine = startedEngine();
    engine.advanceTo(3);
    const before = engine.getState();

    expect(engine.advanceTo(3)).toEqual([]);
    expect(engine.getState()).toEqual(before);
  });

  it("rejects an unstarted engine, a past target, and a non-finite target", () => {
    const unstarted = new SimulationEngine(twoStopSetup());
    expect(() => unstarted.advanceTo(1)).toThrow(/has not been started/);

    const engine = startedEngine();
    engine.advanceTo(3);
    expect(() => engine.advanceTo(2.9)).toThrow(/Invalid simulation target time/);
    for (const target of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => engine.advanceTo(target)).toThrow(
        /Invalid simulation target time/,
      );
    }
    expect(engine.getState().simTime).toBe(3);
  });

  it("stops at the makespan when the plan completes before the target", () => {
    const engine = startedEngine();

    const events = engine.advanceTo(100);

    expect(engine.getState()).toMatchObject({ status: "completed", simTime: 12 });
    expect(events.at(-1)?.type).toBe("simulation.completed");

    // Completed: a later target changes nothing and emits nothing.
    expect(engine.advanceTo(200)).toEqual([]);
    expect(engine.getState().simTime).toBe(12);
    // A target in the past is still invalid.
    expect(() => engine.advanceTo(5)).toThrow(/Invalid simulation target time/);
  });

  it("stops where the engine stalls on a closed edge instead of reaching the target", () => {
    const options = twoStopSetup();
    // Close after construction: routes are expanded at construction, so the
    // committed route still uses A-B, as it does for an operational closure.
    const engine = new SimulationEngine(options);
    engine.start();
    options.graph.closeEdge("A-B");

    const events = engine.advanceTo(10);

    expect(events.at(-1)?.type).toBe("vehicle.edge_entered");
    expect(engine.getState().status).toBe("running");
    expect(engine.getState().simTime).toBe(5);
    expect(engine.getState().vehicles[0]).toMatchObject({
      currentEdgeId: "A-B",
      edgeDuration: Number.POSITIVE_INFINITY,
    });
    // Repeating the request is stable and does not throw.
    expect(engine.advanceTo(10)).toEqual([]);
    expect(engine.getState().simTime).toBe(5);
  });
});
