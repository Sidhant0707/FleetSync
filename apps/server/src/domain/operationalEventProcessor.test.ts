import { describe, expect, it, vi } from "vitest";

import { OperationalEventProcessor } from "./operationalEventProcessor.js";
import type {
  AppliedResult,
  NoOpResult,
  OperationalEventProcessingResult,
} from "./operationalEventProcessor.js";
import type { OperationalEvent } from "./operationalEvents.js";
import { RoadGraph } from "./RoadGraph.js";
import { expandRoute } from "./routeExpansion.js";
import { SimulationEngine } from "./simulation.js";
import type { Depot, Order, Route, RouteStop, Vehicle } from "./types.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

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

/** D <-> A (5), D <-> B (5), one-way A -> B shortcut (2), D -> U (5). */
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

const DEPOT: Depot = { id: "d1", name: "Depot d1", nodeId: "D" };

function createVehicle(id: string): Vehicle {
  return {
    id,
    label: `Vehicle ${id}`,
    capacity: 10,
    depotId: "d1",
    status: "idle",
  };
}

function createOrder(id: string, nodeId: string): Order {
  return { id, nodeId, demand: 1, status: "pending" };
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

interface Harness {
  readonly graph: RoadGraph;
  readonly engine: SimulationEngine;
  readonly processor: OperationalEventProcessor;
  readonly orders: readonly Order[];
  readonly vehicles: readonly Vehicle[];
}

/**
 * One vehicle, D -> A (5) -> B (2) -> D (5), so with no service time:
 *   t 0-5  on D-A     t 5-7  on A-B     t 7-12  on B-D
 */
function harness(options: { serviceTimePerStop?: number; start?: boolean } = {}): Harness {
  const graph = buildGraph();
  const orders = [createOrder("A", "A"), createOrder("B", "B")];
  const vehicles = [createVehicle("v1")];
  const engine = new SimulationEngine({
    graph,
    depot: DEPOT,
    routes: [createRoute("v1", "A", "B")],
    orders,
    vehicles,
    ...(options.serviceTimePerStop === undefined
      ? {}
      : { serviceTimePerStop: options.serviceTimePerStop }),
  });

  if (options.start !== false) {
    engine.start();
  }

  return {
    graph,
    engine,
    processor: new OperationalEventProcessor({ engine, graph, orders, vehicles }),
    orders,
    vehicles,
  };
}

function closed(id: string, effectiveTime: number, edgeId: string): OperationalEvent {
  return { type: "road_closed", id, effectiveTime, edgeId };
}

function reopened(id: string, effectiveTime: number, edgeId: string): OperationalEvent {
  return { type: "road_reopened", id, effectiveTime, edgeId };
}

function retimed(
  id: string,
  effectiveTime: number,
  edgeId: string,
  multiplier: number,
): OperationalEvent {
  return { type: "travel_time_changed", id, effectiveTime, edgeId, multiplier };
}

function orderCreated(
  id: string,
  effectiveTime: number,
  orderId: string,
  nodeId = "U",
): OperationalEvent {
  return { type: "order_created", id, effectiveTime, orderId, nodeId, demand: 2 };
}

function applied(result: OperationalEventProcessingResult): AppliedResult {
  if (result.status !== "applied") {
    throw new Error(`expected applied, got ${JSON.stringify(result)}`);
  }

  return result;
}

function noOp(result: OperationalEventProcessingResult): NoOpResult {
  if (result.status !== "no_op") {
    throw new Error(`expected no_op, got ${JSON.stringify(result)}`);
  }

  return result;
}

function affectedRoutes(result: AppliedResult): unknown {
  if (!result.identification.ok) {
    throw new Error(`identification failed: ${result.identification.detail}`);
  }

  return result.identification.affectedRoutes;
}

const R1_INVALIDATED_AT_LEG_2 = [
  {
    routeId: "route-v1",
    vehicleId: "v1",
    routeVersion: 1,
    impact: "INVALIDATED",
    occurrences: [{ legIndex: 2, edgeIndexInLeg: 0 }],
    inFlightOnEdge: false,
  },
];

// ---------------------------------------------------------------------------
// same-instant ordering
// ---------------------------------------------------------------------------

describe("OperationalEventProcessor same-instant ordering", () => {
  it("treats the edge a vehicle enters exactly at the event time as in flight", () => {
    const { processor, graph, engine } = harness();

    const result = applied(processor.process(closed("e1", 5, "A-B")));

    // Settled before capture: D-A completed, A served, A-B entered, all at t=5.
    expect(result.snapshot.simTime).toBe(5);
    expect(result.snapshot.vehicleStates[0]).toMatchObject({
      phase: "traveling",
      currentEdgeId: "A-B",
      edgeElapsed: 0,
      edgeDuration: 2,
      legIndex: 1,
      edgeIndexInLeg: 0,
      completedEdgeIds: ["D-A"],
      servedOrderIds: ["A"],
    });
    expect(
      result.simulationEvents.map((event) => [event.simTime, event.type]),
    ).toEqual([
      [5, "vehicle.edge_completed"],
      [5, "order.served"],
      [5, "vehicle.departed"],
      [5, "vehicle.edge_entered"],
    ]);

    // The newly entered edge is committed, so closing it affects no route.
    expect(affectedRoutes(result)).toEqual([]);
    expect(graph.getEdge("A-B").status).toBe("closed");

    // The traversal in progress keeps its locked duration and ends on time.
    engine.advanceBy(2);
    expect(engine.getState().vehicles[0]?.completedEdgeIds).toEqual(["D-A", "A-B"]);
    expect(engine.getState().simTime).toBe(7);
  });

  it("still reports edges after the one entered at the event time", () => {
    const { processor } = harness();

    const result = applied(processor.process(closed("e1", 5, "B-D")));

    expect(affectedRoutes(result)).toEqual(R1_INVALIDATED_AT_LEG_2);
  });

  it("keeps the commitment boundary of a vehicle still traversing its edge", () => {
    const a = harness();
    const midEdge = applied(a.processor.process(closed("e1", 3, "D-A")));

    expect(midEdge.snapshot.vehicleStates[0]).toMatchObject({
      phase: "traveling",
      currentEdgeId: "D-A",
      edgeElapsed: 3,
    });
    // Committed: closing the in-flight edge changes nothing for the route.
    expect(affectedRoutes(midEdge)).toEqual([]);

    // The traversal still finishes at its original time.
    a.engine.advanceBy(2);
    expect(a.engine.getState().vehicles[0]?.completedEdgeIds).toEqual(["D-A"]);
    expect(a.engine.getState().simTime).toBe(5);

    const b = harness();
    const ahead = applied(b.processor.process(closed("e1", 3, "A-B")));
    expect(affectedRoutes(ahead)).toEqual([
      {
        routeId: "route-v1",
        vehicleId: "v1",
        routeVersion: 1,
        impact: "INVALIDATED",
        occurrences: [{ legIndex: 1, edgeIndexInLeg: 0 }],
        inFlightOnEdge: false,
      },
    ]);
  });

  it("settles service completion due at the event time before capturing", () => {
    // D-A 0-5, serve A 5-7, A-B 7-9.
    const arrival = harness({ serviceTimePerStop: 2 });
    const servicing = applied(arrival.processor.process(closed("e1", 5, "A-B")));

    expect(servicing.snapshot.vehicleStates[0]).toMatchObject({
      phase: "servicing",
      currentEdgeId: null,
      serviceElapsed: 0,
    });
    // Still servicing A: the whole next leg is modifiable.
    expect(affectedRoutes(servicing)).toEqual([
      {
        routeId: "route-v1",
        vehicleId: "v1",
        routeVersion: 1,
        impact: "INVALIDATED",
        occurrences: [{ legIndex: 1, edgeIndexInLeg: 0 }],
        inFlightOnEdge: false,
      },
    ]);

    const departure = harness({ serviceTimePerStop: 2 });
    const entered = applied(departure.processor.process(closed("e1", 7, "A-B")));

    expect(entered.snapshot.vehicleStates[0]).toMatchObject({
      phase: "traveling",
      currentEdgeId: "A-B",
      servedOrderIds: ["A"],
    });
    expect(entered.simulationEvents.map((event) => event.type)).toContain(
      "order.served",
    );
    expect(affectedRoutes(entered)).toEqual([]);
  });

  it("runs advance, then capture, then apply, then identify on the captured routes", () => {
    const { processor, graph, engine } = harness();
    const advance = vi.spyOn(engine, "advanceTo");
    const capture = vi.spyOn(engine, "getRouteProgressSnapshot");
    const close = vi.spyOn(graph, "closeEdge");

    const result = applied(processor.process(closed("e1", 5, "B-D")));

    const advanceAt = advance.mock.invocationCallOrder[0];
    const closeAt = close.mock.invocationCallOrder[0];
    expect(advance).toHaveBeenCalledWith(5);
    expect(advanceAt).toBeDefined();
    expect(closeAt).toBeDefined();

    // The graph is mutated only after the engine has advanced.
    expect(closeAt ?? Number.NaN).toBeGreaterThan(advanceAt ?? Number.NaN);

    // At least one capture falls after the advance and before the mutation.
    // How many other captures the gate takes is not part of the contract.
    expect(
      capture.mock.invocationCallOrder.some(
        (order) =>
          order > (advanceAt ?? Number.NaN) && order < (closeAt ?? Number.NaN),
      ),
    ).toBe(true);

    expect(result.snapshot.simTime).toBe(5);
  });

  it("identifies on the engine's committed routes, not a re-expansion after the change", () => {
    const { processor, graph, engine, orders } = harness();

    const result = applied(processor.process(closed("e1", 0, "A-B")));

    // A re-expansion on the changed graph would route A -> B through the depot.
    const reExpanded = expandRoute(
      createRoute("v1", "A", "B"),
      new Map(orders.map((order) => [order.id, order])),
      "D",
      graph,
    );
    expect(reExpanded.ok && reExpanded.expanded.legs[1]?.edgeIds).toEqual([
      "A-D",
      "D-B",
    ]);

    // The committed route still holds A-B, so it is the one reported.
    expect(affectedRoutes(result)).toEqual([
      {
        routeId: "route-v1",
        vehicleId: "v1",
        routeVersion: 1,
        impact: "INVALIDATED",
        occurrences: [{ legIndex: 1, edgeIndexInLeg: 0 }],
        inFlightOnEdge: false,
      },
    ]);
    expect(result.snapshot.routes[0]).toBe(
      engine.getRouteProgressSnapshot().routes[0],
    );
    expect(result.snapshot.routes[0]?.legs[1]?.edgeIds).toEqual(["A-B"]);
  });

  it("processes several events at one instant in call order without advancing again", () => {
    const { processor, graph } = harness();

    const first = applied(processor.process(closed("e1", 5, "B-D")));
    const second = applied(processor.process(retimed("e2", 5, "D-A", 3)));

    expect(first.simulationEvents).toHaveLength(4);
    expect(second.simulationEvents).toEqual([]);
    expect(second.snapshot.simTime).toBe(5);
    expect(second.snapshot.vehicleStates).toEqual(first.snapshot.vehicleStates);
    expect(graph.getEdge("B-D").status).toBe("closed");
    expect(graph.getEdge("D-A").currentWeight).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// supported events
// ---------------------------------------------------------------------------

describe("OperationalEventProcessor applies valid events", () => {
  it("closes a road and reports the invalidated route", () => {
    const { processor, graph } = harness();

    const result = applied(processor.process(closed("e1", 1, "B-D")));

    expect(graph.getEdge("B-D")).toMatchObject({
      status: "closed",
      currentWeight: Number.POSITIVE_INFINITY,
    });
    expect(result.identification).toMatchObject({
      ok: true,
      kind: "road_closed",
      edgeId: "B-D",
    });
    expect(affectedRoutes(result)).toEqual(R1_INVALIDATED_AT_LEG_2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it("reopens a road and lets the vehicle use it", () => {
    const { processor, graph, engine } = harness();

    applied(processor.process(closed("e1", 1, "A-B")));
    const result = applied(processor.process(reopened("e2", 2, "A-B")));

    expect(graph.getEdge("A-B")).toMatchObject({ status: "open", currentWeight: 2 });
    expect(result.identification).toMatchObject({
      ok: true,
      kind: "road_reopened",
      edgeId: "A-B",
      affectedRoutes: [],
      mayEnableUnreachableOrders: true,
    });

    engine.advanceBy(100);
    expect(engine.getState().status).toBe("completed");
    expect(engine.getState().simTime).toBe(12);
  });

  it("changes a travel time, reports RETIMED, and the engine uses the new weight", () => {
    const { processor, graph, engine } = harness();

    const result = applied(processor.process(retimed("e1", 1, "B-D", 2)));

    expect(graph.getEdge("B-D").currentWeight).toBe(10);
    expect(result.identification).toMatchObject({
      ok: true,
      kind: "travel_time_changed",
      edgeId: "B-D",
    });
    expect(affectedRoutes(result)).toEqual([
      {
        ...R1_INVALIDATED_AT_LEG_2[0],
        impact: "RETIMED",
      },
    ]);

    // D-A 5 + A-B 2 + B-D 10: the weight is read when B-D is entered.
    engine.advanceBy(100);
    expect(engine.getState().simTime).toBe(17);
  });

  it("leaves a retimed in-flight edge's duration locked", () => {
    const { processor, engine } = harness();

    const result = applied(processor.process(retimed("e1", 3, "D-A", 3)));

    expect(affectedRoutes(result)).toEqual([]);

    engine.advanceBy(2);
    expect(engine.getState().vehicles[0]?.completedEdgeIds).toEqual(["D-A"]);
    expect(engine.getState().simTime).toBe(5);
  });

  it("creates an order without touching routes or the engine", () => {
    const { processor, engine } = harness();
    const routesBefore = engine.getRouteProgressSnapshot().routes[0];

    const result = applied(processor.process(orderCreated("e1", 2, "O3")));

    expect(result.identification).toEqual({
      ok: true,
      kind: "order_created",
      orderId: "O3",
      affectedRoutes: [],
      processing: "ALWAYS",
    });
    expect(processor.getOrders().map((order) => order.id)).toEqual([
      "A",
      "B",
      "O3",
    ]);
    expect(processor.getOrders().at(-1)).toEqual({
      id: "O3",
      nodeId: "U",
      demand: 2,
      status: "pending",
    });
    expect(engine.getRouteProgressSnapshot().routes[0]).toBe(routesBefore);
  });
});

// ---------------------------------------------------------------------------
// invalid events
// ---------------------------------------------------------------------------

describe("OperationalEventProcessor rejects invalid events without applying them", () => {
  it("rejects an unknown edge before advancing, and does not consume the event ID", () => {
    const { processor, graph, engine } = harness();

    const result = processor.process(closed("e1", 4, "NOPE"));

    expect(result).toMatchObject({
      status: "rejected",
      eventId: "e1",
      reason: "UNKNOWN_EDGE",
      simulationEvents: [],
    });
    expect(engine.getState().simTime).toBe(0);
    expect(graph.getEdge("A-B").status).toBe("open");

    // A corrected event may reuse the ID.
    applied(processor.process(closed("e1", 4, "A-B")));
  });

  it("rejects an effective time in the past and leaves time where it was", () => {
    const { processor, engine } = harness();
    applied(processor.process(orderCreated("e1", 5, "O3")));

    const result = processor.process(closed("e2", 3, "B-D"));

    expect(result).toMatchObject({
      status: "rejected",
      reason: "EFFECTIVE_TIME_IN_PAST",
    });
    expect(engine.getState().simTime).toBe(5);
  });

  it("rejects a non-finite effective time without advancing", () => {
    const { processor, engine } = harness();

    const result = processor.process(closed("e1", Number.NaN, "B-D"));

    expect(result).toMatchObject({
      status: "rejected",
      reason: "INVALID_EFFECTIVE_TIME",
    });
    expect(engine.getState().simTime).toBe(0);
  });

  it("rejects a duplicate event ID", () => {
    const { processor } = harness();
    applied(processor.process(closed("e1", 1, "B-D")));

    expect(processor.process(closed("e1", 2, "A-B"))).toMatchObject({
      status: "rejected",
      reason: "DUPLICATE_EVENT_ID",
    });
  });

  it("rejects an invalid multiplier and a retime of a closed edge", () => {
    const { processor, graph } = harness();

    expect(processor.process(retimed("e1", 1, "B-D", 0))).toMatchObject({
      status: "rejected",
      reason: "INVALID_MULTIPLIER",
    });

    applied(processor.process(closed("e2", 1, "A-B")));

    expect(processor.process(retimed("e3", 2, "A-B", 2))).toMatchObject({
      status: "rejected",
      reason: "EDGE_CLOSED",
    });
    expect(graph.getEdge("A-B").currentWeight).toBe(Number.POSITIVE_INFINITY);
    expect(graph.getEdge("B-D").currentWeight).toBe(5);
  });

  it("rejects a duplicate order and an unsupported time window, registering neither", () => {
    const { processor } = harness();

    expect(processor.process(orderCreated("e1", 1, "A"))).toMatchObject({
      status: "rejected",
      reason: "DUPLICATE_ORDER_ID",
    });
    expect(
      processor.process({
        type: "order_created",
        id: "e2",
        effectiveTime: 1,
        orderId: "O9",
        nodeId: "U",
        demand: 1,
        window: { earliest: 0, latest: 10 },
      }),
    ).toMatchObject({ status: "rejected", reason: "WINDOW_NOT_SUPPORTED" });
    expect(processor.getOrders().map((order) => order.id)).toEqual(["A", "B"]);
  });
});

// ---------------------------------------------------------------------------
// no-op events
// ---------------------------------------------------------------------------

describe("OperationalEventProcessor skips no-op events", () => {
  it("never reports a no-op travel-time change as RETIMED", () => {
    const { processor, graph } = harness();

    const result = noOp(processor.process(retimed("e1", 1, "B-D", 1)));

    expect("identification" in result).toBe(false);
    expect(graph.getEdge("B-D").currentWeight).toBe(5);

    // Same for a repeat of a multiplier that is already in force.
    applied(processor.process(retimed("e2", 2, "B-D", 2)));
    const repeat = noOp(processor.process(retimed("e3", 3, "B-D", 2)));

    expect("identification" in repeat).toBe(false);
    expect(graph.getEdge("B-D").currentWeight).toBe(10);

    // A real change back to 1 is not a no-op.
    const reset = applied(processor.process(retimed("e4", 4, "B-D", 1)));
    expect(affectedRoutes(reset)).toMatchObject([{ impact: "RETIMED" }]);
    expect(graph.getEdge("B-D").currentWeight).toBe(5);
  });

  it("skips closing a closed edge and reopening an open edge", () => {
    const { processor, graph } = harness();

    noOp(processor.process(reopened("e1", 1, "B-D")));
    expect(graph.getEdge("B-D").status).toBe("open");

    applied(processor.process(closed("e2", 2, "B-D")));
    const again = noOp(processor.process(closed("e3", 3, "B-D")));

    expect("identification" in again).toBe(false);
    expect(graph.getEdge("B-D").status).toBe("closed");
  });

  it("still moves the simulation to the event time, and consumes the event ID", () => {
    const { processor, engine } = harness();

    const result = noOp(processor.process(retimed("e1", 3, "B-D", 1)));

    expect(result.snapshot.simTime).toBe(3);
    expect(engine.getState().simTime).toBe(3);
    expect(processor.process(retimed("e1", 4, "B-D", 2))).toMatchObject({
      status: "rejected",
      reason: "DUPLICATE_EVENT_ID",
    });
  });
});

// ---------------------------------------------------------------------------
// deferred events, preconditions and time limits
// ---------------------------------------------------------------------------

describe("OperationalEventProcessor boundaries", () => {
  it("defers the two event types identification does not support, changing nothing", () => {
    const { processor, engine } = harness();

    expect(
      processor.process({
        type: "order_cancelled",
        id: "e1",
        effectiveTime: 4,
        orderId: "A",
      }),
    ).toMatchObject({
      status: "deferred",
      eventType: "order_cancelled",
      simulationEvents: [],
    });
    expect(
      processor.process({
        type: "vehicle_broken_down",
        id: "e2",
        effectiveTime: 4,
        vehicleId: "v1",
      }),
    ).toMatchObject({ status: "deferred", eventType: "vehicle_broken_down" });
    expect(engine.getState().simTime).toBe(0);

    // Validation still applies first.
    expect(
      processor.process({
        type: "order_cancelled",
        id: "e3",
        effectiveTime: 4,
        orderId: "NOPE",
      }),
    ).toMatchObject({ status: "rejected", reason: "UNKNOWN_ORDER" });
  });

  it("refuses to run before the simulation has started", () => {
    const { processor } = harness({ start: false });

    expect(() => processor.process(closed("e1", 0, "B-D"))).toThrow(
      /before the simulation has been started/,
    );
  });

  it("reports an event after the simulation completes, and applies one at the makespan", () => {
    const late = harness();
    const result = late.processor.process(closed("e1", 50, "B-D"));

    expect(result).toMatchObject({
      status: "time_not_reached",
      reason: "SIMULATION_COMPLETED_BEFORE_EVENT",
      effectiveTime: 50,
      simTime: 12,
      simulationStatus: "completed",
    });
    expect(result.simulationEvents.at(-1)?.type).toBe("simulation.completed");
    expect(late.graph.getEdge("B-D").status).toBe("open");

    const exact = harness();
    exact.engine.advanceBy(100);
    const atMakespan = applied(exact.processor.process(closed("e1", 12, "B-D")));

    expect(atMakespan.snapshot.status).toBe("completed");
    expect(affectedRoutes(atMakespan)).toEqual([]);
  });

  it("does not apply an event the engine cannot reach after an invalidating closure", () => {
    const { processor, graph, engine } = harness();

    // Close A-B ahead of the vehicle. The route is invalidated but not repaired.
    applied(processor.process(closed("e1", 3, "A-B")));

    // At t=5 the vehicle enters A-B with an infinite duration and the engine stops.
    const result = processor.process(orderCreated("e2", 10, "O3"));

    expect(result).toMatchObject({
      status: "time_not_reached",
      reason: "ENGINE_DID_NOT_REACH_EVENT_TIME",
      effectiveTime: 10,
      simTime: 5,
      simulationStatus: "running",
    });
    expect(engine.getState().vehicles[0]).toMatchObject({
      currentEdgeId: "A-B",
      edgeDuration: Number.POSITIVE_INFINITY,
    });
    expect(processor.getOrders().map((order) => order.id)).toEqual(["A", "B"]);
    expect(graph.getEdge("A-B").status).toBe("closed");

    // Nothing was consumed: the same ID gets the same answer, not a duplicate.
    expect(processor.process(orderCreated("e2", 10, "O3"))).toMatchObject({
      status: "time_not_reached",
    });
  });

  it("rejects duplicate order or vehicle IDs at construction", () => {
    const { engine, graph } = harness();

    expect(
      () =>
        new OperationalEventProcessor({
          engine,
          graph,
          orders: [createOrder("A", "A"), createOrder("A", "B")],
          vehicles: [createVehicle("v1")],
        }),
    ).toThrow(/Duplicate order ID: A/);
    expect(
      () =>
        new OperationalEventProcessor({
          engine,
          graph,
          orders: [createOrder("A", "A")],
          vehicles: [createVehicle("v1"), createVehicle("v1")],
        }),
    ).toThrow(/Duplicate vehicle ID: v1/);
  });
});

// ---------------------------------------------------------------------------
// exact event time
// ---------------------------------------------------------------------------

describe("OperationalEventProcessor lands on fractional event times exactly", () => {
  it("applies an event at 0.9 after one at 0.2, with the clock exactly on 0.9", () => {
    const { processor, graph, engine } = harness();

    applied(processor.process(orderCreated("e1", 0.2, "O3")));
    expect(engine.getState().simTime).toBe(0.2);

    // Advancing by 0.9 - 0.2 and adding it to 0.2 gives 0.8999999999999999.
    const result = applied(processor.process(closed("e2", 0.9, "B-D")));

    expect(result.snapshot.simTime).toBe(0.9);
    expect(engine.getState().simTime).toBe(0.9);
    expect(graph.getEdge("B-D").status).toBe("closed");
  });

  it("never reports time_not_reached for a reachable fractional time", () => {
    // Every pair of tenths up to 2.0: the engine is mid-edge (D-A lasts 5)
    // for all of them, so each target is reachable.
    for (let from = 1; from <= 20; from += 1) {
      for (let to = from + 1; to <= 20; to += 1) {
        const { processor, engine } = harness();
        const start = from / 10;
        const target = to / 10;

        applied(processor.process(orderCreated("e1", start, "O3")));
        const result = processor.process(orderCreated("e2", target, "O4"));

        expect(result.status, `${start} -> ${target}`).toBe("applied");
        expect(engine.getState().simTime, `${start} -> ${target}`).toBe(target);
      }
    }
  });
});
