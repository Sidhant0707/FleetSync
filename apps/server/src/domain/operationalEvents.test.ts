import { describe, expect, it } from "vitest";

import {
  OPERATIONAL_EVENT_TYPES,
  validateOperationalEvent,
  type OperationalEvent,
  type OperationalEventContext,
  type OperationalEventRejectionReason,
  type OperationalEventType,
} from "./operationalEvents.js";
import { RoadGraph } from "./RoadGraph.js";
import type { Order, Vehicle } from "./types.js";

const EDGE_IDS = ["e-DA", "e-AB", "e-BD", "e-AD"] as const;

interface Fixture {
  readonly graph: RoadGraph;
  readonly orders: Map<string, Order>;
  readonly vehicles: Map<string, Vehicle>;
  readonly seenEventIds: Set<string>;
  readonly context: OperationalEventContext;
}

/**
 * Nodes D (depot), A, B and C. C has no edges, so it is unreachable from
 * everywhere. e-AD is closed; all other edges are open at base weight.
 */
function makeFixture(currentSimTime = 5): Fixture {
  const graph = new RoadGraph();
  for (const [id, lat] of [
    ["D", 0],
    ["A", 1],
    ["B", 2],
    ["C", 3],
  ] as const) {
    graph.addNode({ id, lat, lng: 0 });
  }

  graph.addEdge({ id: "e-DA", fromNodeId: "D", toNodeId: "A", baseWeight: 2 });
  graph.addEdge({ id: "e-AB", fromNodeId: "A", toNodeId: "B", baseWeight: 3 });
  graph.addEdge({ id: "e-BD", fromNodeId: "B", toNodeId: "D", baseWeight: 4 });
  graph.addEdge({ id: "e-AD", fromNodeId: "A", toNodeId: "D", baseWeight: 2 });
  graph.closeEdge("e-AD");

  const orders = new Map<string, Order>(
    (
      [
        ["o-pending", "A", "pending"],
        ["o-assigned", "B", "assigned"],
        ["o-delivered", "A", "delivered"],
        ["o-cancelled", "B", "cancelled"],
      ] as const
    ).map(([id, nodeId, status]) => [
      id,
      { id, nodeId, demand: 1, status },
    ]),
  );

  const vehicles = new Map<string, Vehicle>([
    [
      "v-idle",
      { id: "v-idle", label: "V1", capacity: 10, depotId: "dep", status: "idle" },
    ],
    [
      "v-broken",
      {
        id: "v-broken",
        label: "V2",
        capacity: 10,
        depotId: "dep",
        status: "broken_down",
      },
    ],
  ]);

  const seenEventIds = new Set<string>(["seen-1"]);

  return {
    graph,
    orders,
    vehicles,
    seenEventIds,
    context: { graph, orders, vehicles, currentSimTime, seenEventIds },
  };
}

/** One valid, state-changing event per type against makeFixture(). */
const VALID_EVENTS: Readonly<Record<OperationalEventType, OperationalEvent>> = {
  road_closed: {
    id: "ev-close",
    type: "road_closed",
    effectiveTime: 6,
    edgeId: "e-AB",
  },
  road_reopened: {
    id: "ev-reopen",
    type: "road_reopened",
    effectiveTime: 6,
    edgeId: "e-AD",
  },
  travel_time_changed: {
    id: "ev-ttc",
    type: "travel_time_changed",
    effectiveTime: 6,
    edgeId: "e-AB",
    multiplier: 2.5,
  },
  order_created: {
    id: "ev-create",
    type: "order_created",
    effectiveTime: 6,
    orderId: "o-new",
    nodeId: "A",
    demand: 3,
  },
  order_cancelled: {
    id: "ev-cancel",
    type: "order_cancelled",
    effectiveTime: 6,
    orderId: "o-pending",
  },
  vehicle_broken_down: {
    id: "ev-break",
    type: "vehicle_broken_down",
    effectiveTime: 6,
    vehicleId: "v-idle",
  },
};

function expectRejected(
  event: OperationalEvent,
  reason: OperationalEventRejectionReason,
  fixture: Fixture = makeFixture(),
): void {
  const result = validateOperationalEvent(event, fixture.context);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
    expect(result.detail.length).toBeGreaterThan(0);
  }
}

function expectAccepted(
  event: OperationalEvent,
  noOp: boolean,
  fixture: Fixture = makeFixture(),
): void {
  const result = validateOperationalEvent(event, fixture.context);
  expect(result).toEqual({ ok: true, noOp });
}

describe("operational event model", () => {
  it("has a valid example for every event type", () => {
    expect(Object.keys(VALID_EVENTS).sort()).toEqual(
      [...OPERATIONAL_EVENT_TYPES].sort(),
    );
    for (const type of OPERATIONAL_EVENT_TYPES) {
      expect(VALID_EVENTS[type].type).toBe(type);
    }
  });

  it.each(OPERATIONAL_EVENT_TYPES)(
    "accepts a valid %s event as a state-changing event",
    (type) => {
      expectAccepted(VALID_EVENTS[type], false);
    },
  );
});

describe("event ID and effective time", () => {
  it("rejects an empty event ID", () => {
    expectRejected({ ...VALID_EVENTS.road_closed, id: "" }, "INVALID_EVENT_ID");
  });

  it("rejects a duplicate event ID for every event type", () => {
    for (const type of OPERATIONAL_EVENT_TYPES) {
      expectRejected({ ...VALID_EVENTS[type], id: "seen-1" }, "DUPLICATE_EVENT_ID");
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["negative", -1],
  ])("rejects a %s effective time", (_label, effectiveTime) => {
    expectRejected(
      { ...VALID_EVENTS.road_closed, effectiveTime },
      "INVALID_EFFECTIVE_TIME",
    );
  });

  it("rejects an effective time before the current simulation time", () => {
    expectRejected(
      { ...VALID_EVENTS.road_closed, effectiveTime: 4.999 },
      "EFFECTIVE_TIME_IN_PAST",
    );
  });

  it("accepts an effective time equal to the current simulation time", () => {
    expectAccepted({ ...VALID_EVENTS.road_closed, effectiveTime: 5 }, false);
  });

  it("accepts an effective time in the future", () => {
    expectAccepted({ ...VALID_EVENTS.road_closed, effectiveTime: 1000 }, false);
  });

  it("accepts effective time 0 at simulation time 0", () => {
    expectAccepted(
      { ...VALID_EVENTS.road_closed, effectiveTime: 0 },
      false,
      makeFixture(0),
    );
  });

  it("checks the event ID before the effective time", () => {
    expectRejected(
      { ...VALID_EVENTS.road_closed, id: "seen-1", effectiveTime: Number.NaN },
      "DUPLICATE_EVENT_ID",
    );
  });

  it("rejects an unknown event type without throwing", () => {
    const malformed = {
      id: "ev-x",
      type: "teleport",
      effectiveTime: 6,
    } as unknown as OperationalEvent;

    expectRejected(malformed, "UNKNOWN_EVENT_TYPE");
  });
});

describe("road_closed", () => {
  it("rejects an unknown edge", () => {
    expectRejected(
      { ...VALID_EVENTS.road_closed, edgeId: "e-nope" } as OperationalEvent,
      "UNKNOWN_EDGE",
    );
  });

  it("is an idempotent no-op on an already-closed edge", () => {
    expectAccepted(
      { ...VALID_EVENTS.road_closed, edgeId: "e-AD" } as OperationalEvent,
      true,
    );
  });
});

describe("road_reopened", () => {
  it("rejects an unknown edge", () => {
    expectRejected(
      { ...VALID_EVENTS.road_reopened, edgeId: "e-nope" } as OperationalEvent,
      "UNKNOWN_EDGE",
    );
  });

  it("is a no-op on an already-open edge", () => {
    expectAccepted(
      { ...VALID_EVENTS.road_reopened, edgeId: "e-AB" } as OperationalEvent,
      true,
    );
  });
});

describe("travel_time_changed", () => {
  it("rejects an unknown edge", () => {
    expectRejected(
      { ...VALID_EVENTS.travel_time_changed, edgeId: "e-nope" } as OperationalEvent,
      "UNKNOWN_EDGE",
    );
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
  ])("rejects a %s multiplier", (_label, multiplier) => {
    expectRejected(
      { ...VALID_EVENTS.travel_time_changed, multiplier } as OperationalEvent,
      "INVALID_MULTIPLIER",
    );
  });

  it("rejects a change on a closed edge", () => {
    expectRejected(
      { ...VALID_EVENTS.travel_time_changed, edgeId: "e-AD" } as OperationalEvent,
      "EDGE_CLOSED",
    );
  });

  it("treats multiplier 1 on an unmodified edge as a no-op", () => {
    expectAccepted(
      { ...VALID_EVENTS.travel_time_changed, multiplier: 1 } as OperationalEvent,
      true,
    );
  });

  it("treats a multiplier equal to the edge's current one as a no-op", () => {
    const fixture = makeFixture();
    fixture.graph.setTravelTimeMultiplier("e-AB", 2.5);

    expectAccepted(VALID_EVENTS.travel_time_changed, true, fixture);
  });

  it("treats a different multiplier on a modified edge as a change", () => {
    const fixture = makeFixture();
    fixture.graph.setTravelTimeMultiplier("e-AB", 2.5);

    expectAccepted(
      { ...VALID_EVENTS.travel_time_changed, multiplier: 1 } as OperationalEvent,
      false,
      fixture,
    );
  });
});

describe("order_created", () => {
  const created = VALID_EVENTS.order_created;

  it("rejects an order ID that already exists, whatever its status", () => {
    for (const orderId of [
      "o-pending",
      "o-assigned",
      "o-delivered",
      "o-cancelled",
    ]) {
      expectRejected({ ...created, orderId } as OperationalEvent, "DUPLICATE_ORDER_ID");
    }
  });

  it("rejects a node that is not in the graph", () => {
    expectRejected(
      { ...created, nodeId: "Z" } as OperationalEvent,
      "NODE_NOT_IN_GRAPH",
    );
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
  ])("rejects a %s demand", (_label, demand) => {
    expectRejected({ ...created, demand } as OperationalEvent, "INVALID_DEMAND");
  });

  it("rejects a time window until time windows are supported", () => {
    expectRejected(
      { ...created, window: { earliest: 10, latest: 20 } } as OperationalEvent,
      "WINDOW_NOT_SUPPORTED",
    );
  });

  it("accepts an order whose node is currently unreachable", () => {
    // Node C exists but has no edges, so no path reaches it.
    expectAccepted({ ...created, nodeId: "C" } as OperationalEvent, false);
  });

  it("accepts an order whose only inbound edge is closed", () => {
    const fixture = makeFixture();
    fixture.graph.closeEdge("e-DA");

    expectAccepted(created, false, fixture);
  });
});

describe("order_cancelled", () => {
  const cancelled = VALID_EVENTS.order_cancelled;

  it("rejects an unknown order", () => {
    expectRejected(
      { ...cancelled, orderId: "o-nope" } as OperationalEvent,
      "UNKNOWN_ORDER",
    );
  });

  it("rejects cancelling a delivered order", () => {
    expectRejected(
      { ...cancelled, orderId: "o-delivered" } as OperationalEvent,
      "ORDER_ALREADY_DELIVERED",
    );
  });

  it("is a no-op for an already-cancelled order", () => {
    expectAccepted(
      { ...cancelled, orderId: "o-cancelled" } as OperationalEvent,
      true,
    );
  });

  it("accepts cancelling an assigned order as a state change", () => {
    expectAccepted(
      { ...cancelled, orderId: "o-assigned" } as OperationalEvent,
      false,
    );
  });
});

describe("vehicle_broken_down", () => {
  it("rejects an unknown vehicle", () => {
    expectRejected(
      { ...VALID_EVENTS.vehicle_broken_down, vehicleId: "v-nope" } as OperationalEvent,
      "UNKNOWN_VEHICLE",
    );
  });

  it("is a no-op for an already-broken-down vehicle", () => {
    expectAccepted(
      { ...VALID_EVENTS.vehicle_broken_down, vehicleId: "v-broken" } as OperationalEvent,
      true,
    );
  });
});

describe("unexpected graph errors", () => {
  const EDGE_EVENT_TYPES = [
    "road_closed",
    "road_reopened",
    "travel_time_changed",
  ] as const;

  it("rethrows a getEdge error other than unknown edge", () => {
    const fixture = makeFixture();
    const context: OperationalEventContext = {
      ...fixture.context,
      graph: {
        hasNode: () => true,
        getEdge: () => {
          throw new Error("graph exploded");
        },
      },
    };

    for (const type of EDGE_EVENT_TYPES) {
      expect(() => validateOperationalEvent(VALID_EVENTS[type], context)).toThrow(
        "graph exploded",
      );
    }
  });

  it("rethrows an unknown-edge error that names a different edge", () => {
    const fixture = makeFixture();
    const context: OperationalEventContext = {
      ...fixture.context,
      graph: {
        hasNode: () => true,
        getEdge: () => {
          throw new Error("Unknown edge ID: some-other-edge");
        },
      },
    };

    for (const type of EDGE_EVENT_TYPES) {
      expect(() => validateOperationalEvent(VALID_EVENTS[type], context)).toThrow(
        "Unknown edge ID: some-other-edge",
      );
    }
  });
});

describe("purity", () => {
  interface StateSnapshot {
    readonly edges: readonly unknown[];
    readonly orders: readonly unknown[];
    readonly vehicles: readonly unknown[];
    readonly seenEventIds: readonly string[];
    readonly currentSimTime: number;
  }

  function snapshot(fixture: Fixture): StateSnapshot {
    return structuredClone({
      edges: EDGE_IDS.map((id) => ({ ...fixture.graph.getEdge(id) })),
      orders: [...fixture.orders.entries()],
      vehicles: [...fixture.vehicles.entries()],
      seenEventIds: [...fixture.seenEventIds],
      currentSimTime: fixture.context.currentSimTime,
    });
  }

  /** Event cases covering accepted, no-op and rejected outcomes. */
  const CASES: readonly OperationalEvent[] = [
    ...OPERATIONAL_EVENT_TYPES.map((type) => VALID_EVENTS[type]),
    { ...VALID_EVENTS.road_closed, edgeId: "e-AD" } as OperationalEvent,
    { ...VALID_EVENTS.road_reopened, edgeId: "e-nope" } as OperationalEvent,
    { ...VALID_EVENTS.order_created, orderId: "o-pending" } as OperationalEvent,
    { ...VALID_EVENTS.order_cancelled, orderId: "o-delivered" } as OperationalEvent,
    { ...VALID_EVENTS.road_closed, id: "seen-1" },
  ];

  it("never mutates the graph, orders, vehicles, seen IDs or time", () => {
    const fixture = makeFixture();
    const before = snapshot(fixture);

    for (const event of CASES) {
      validateOperationalEvent(event, fixture.context);
    }

    expect(snapshot(fixture)).toEqual(before);
  });

  it("does not record the event ID as seen", () => {
    const fixture = makeFixture();

    validateOperationalEvent(VALID_EVENTS.road_closed, fixture.context);

    expect(fixture.seenEventIds.has("ev-close")).toBe(false);
    expect(
      validateOperationalEvent(VALID_EVENTS.road_closed, fixture.context),
    ).toEqual({ ok: true, noOp: false });
  });

  // Shallow only: Object.freeze cannot make a Map, a Set or RoadGraph's private
  // fields immutable. Non-mutation of those is covered by the snapshot test.
  it("accepts shallow-frozen event objects and a shallow-frozen context object", () => {
    const fixture = makeFixture();
    Object.freeze(fixture.context);

    for (const event of CASES) {
      expect(() =>
        validateOperationalEvent(Object.freeze({ ...event }), fixture.context),
      ).not.toThrow();
    }
  });

  it("is deterministic: repeated calls give equal results", () => {
    const fixture = makeFixture();

    for (const event of CASES) {
      const first = validateOperationalEvent(event, fixture.context);
      const second = validateOperationalEvent(event, fixture.context);
      expect(second).toEqual(first);
    }
  });

  it("is independent of call order", () => {
    const forward = makeFixture();
    const backward = makeFixture();

    const forwardResults = CASES.map((event) =>
      validateOperationalEvent(event, forward.context),
    );
    const backwardResults = [...CASES]
      .reverse()
      .map((event) => validateOperationalEvent(event, backward.context))
      .reverse();

    expect(backwardResults).toEqual(forwardResults);
  });

  it("returns frozen results", () => {
    const fixture = makeFixture();

    expect(
      Object.isFrozen(
        validateOperationalEvent(VALID_EVENTS.road_closed, fixture.context),
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        validateOperationalEvent(
          { ...VALID_EVENTS.road_closed, id: "seen-1" },
          fixture.context,
        ),
      ),
    ).toBe(true);
  });
});