import { describe, expect, it } from "vitest";

import {
  identifyAffectedEntities,
  resolveRouteCommitment,
  type AffectednessEvent,
  type AffectedEntityResult,
  type AffectedRoute,
  type RouteCommitment,
  type RouteEdgePosition,
  type RouteProgressInput,
} from "./affectedEntities.js";
import { RoadGraph } from "./RoadGraph.js";
import {
  expandRoute,
  type ExpandedRoute,
  type RouteLeg,
  type RouteLegKind,
} from "./routeExpansion.js";
import { SimulationEngine, type SimulationState } from "./simulation.js";
import type { Depot, Order, Route, Vehicle } from "./types.js";
import type { VehicleSimulationState } from "./simulation.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

type LegSpec = readonly [
  edgeIds: readonly string[],
  arrivalOrderId: string | null,
];

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a defined value");
  }

  return value;
}

/** Hand-built committed route; leg i arrives at node n(i+1). */
function makeRoute(
  routeId: string,
  vehicleId: string,
  specs: readonly LegSpec[],
  version = 1,
): ExpandedRoute {
  const legs: RouteLeg[] = specs.map(([edgeIds, arrivalOrderId], legIndex) => {
    const kind: RouteLegKind =
      legIndex === 0
        ? "depot_to_stop"
        : arrivalOrderId === null
          ? "stop_to_depot"
          : "stop_to_stop";

    return Object.freeze({
      legIndex,
      kind,
      fromNodeId: `n${String(legIndex)}`,
      toNodeId: `n${String(legIndex + 1)}`,
      arrivalOrderId,
      arrivalSequenceNo: arrivalOrderId === null ? null : legIndex + 1,
      edgeIds: Object.freeze([...edgeIds]),
      duration: edgeIds.length,
    });
  });

  return Object.freeze({
    routeId,
    vehicleId,
    version,
    depotNodeId: "n0",
    legs: Object.freeze(legs),
    totalTravelTime: legs.reduce((sum, leg) => sum + leg.duration, 0),
  });
}

type StateOverrides = Partial<{
  -readonly [K in keyof VehicleSimulationState]: VehicleSimulationState[K];
}>;

function makeState(
  route: ExpandedRoute,
  overrides: StateOverrides = {},
): VehicleSimulationState {
  return {
    vehicleId: route.vehicleId,
    routeId: route.routeId,
    routeVersion: route.version,
    phase: "idle_at_depot",
    currentNodeId: "n0",
    currentEdgeId: null,
    edgeElapsed: 0,
    edgeDuration: null,
    edgeProgress: 0,
    legIndex: 0,
    edgeIndexInLeg: 0,
    nextStopSequenceNo: null,
    completedEdgeIds: [],
    completedLegIndexes: [],
    servedOrderIds: [],
    serviceElapsed: 0,
    totalTravelTime: 0,
    departedAtSimTime: null,
    completedAtSimTime: null,
    ...overrides,
  };
}

/**
 * R1: repeated edge (eA at 0,0 and 3,0), a single-edge leg, a ZERO-EDGE leg
 * (leg 2) and a return leg.
 *
 *   leg 0: eA eB eC  -> o1
 *   leg 1: eD        -> o2
 *   leg 2: (none)    -> o3
 *   leg 3: eA eE     -> depot
 */
const R1_LEGS: readonly LegSpec[] = [
  [["eA", "eB", "eC"], "o1"],
  [["eD"], "o2"],
  [[], "o3"],
  [["eA", "eE"], null],
];

const R1 = makeRoute("route-z", "v-a", R1_LEGS);

/** Hand-written histories: deliberately not derived from the implementation. */
const R1_STATES = {
  idle: {},
  trav_0_0: {
    phase: "traveling",
    legIndex: 0,
    edgeIndexInLeg: 0,
    currentEdgeId: "eA",
  },
  trav_0_1: {
    phase: "traveling",
    legIndex: 0,
    edgeIndexInLeg: 1,
    currentEdgeId: "eB",
    completedEdgeIds: ["eA"],
  },
  trav_0_2: {
    phase: "traveling",
    legIndex: 0,
    edgeIndexInLeg: 2,
    currentEdgeId: "eC",
    completedEdgeIds: ["eA", "eB"],
  },
  trav_1_0: {
    phase: "traveling",
    legIndex: 1,
    edgeIndexInLeg: 0,
    currentEdgeId: "eD",
    completedEdgeIds: ["eA", "eB", "eC"],
    completedLegIndexes: [0],
    servedOrderIds: ["o1"],
  },
  serv_0: {
    phase: "servicing",
    legIndex: 0,
    completedEdgeIds: ["eA", "eB", "eC"],
    completedLegIndexes: [0],
  },
  serv_1: {
    phase: "servicing",
    legIndex: 1,
    completedEdgeIds: ["eA", "eB", "eC", "eD"],
    completedLegIndexes: [0, 1],
    servedOrderIds: ["o1"],
  },
  serv_2: {
    phase: "servicing",
    legIndex: 2,
    completedEdgeIds: ["eA", "eB", "eC", "eD"],
    completedLegIndexes: [0, 1, 2],
    servedOrderIds: ["o1", "o2"],
  },
  trav_3_0: {
    phase: "traveling",
    legIndex: 3,
    edgeIndexInLeg: 0,
    currentEdgeId: "eA",
    completedEdgeIds: ["eA", "eB", "eC", "eD"],
    completedLegIndexes: [0, 1, 2],
    servedOrderIds: ["o1", "o2", "o3"],
  },
  trav_3_1: {
    phase: "traveling",
    legIndex: 3,
    edgeIndexInLeg: 1,
    currentEdgeId: "eE",
    completedEdgeIds: ["eA", "eB", "eC", "eD", "eA"],
    completedLegIndexes: [0, 1, 2],
    servedOrderIds: ["o1", "o2", "o3"],
  },
  completed: {
    phase: "completed",
    legIndex: 4,
    completedEdgeIds: ["eA", "eB", "eC", "eD", "eA", "eE"],
    completedLegIndexes: [0, 1, 2, 3],
    servedOrderIds: ["o1", "o2", "o3"],
  },
} satisfies Record<string, StateOverrides>;

type R1StateName = keyof typeof R1_STATES;

function r1State(
  name: R1StateName,
  extra: StateOverrides = {},
): VehicleSimulationState {
  return makeState(R1, { ...R1_STATES[name], ...extra });
}

function r1Input(name: R1StateName): RouteProgressInput {
  return { routes: [R1], vehicleStates: [r1State(name)] };
}

function pos(legIndex: number, edgeIndexInLeg: number): RouteEdgePosition {
  return { legIndex, edgeIndexInLeg };
}

function closed(edgeId: string): AffectednessEvent {
  return { id: "ev-close", type: "road_closed", effectiveTime: 10, edgeId };
}

function retimed(edgeId: string): AffectednessEvent {
  return {
    id: "ev-ttc",
    type: "travel_time_changed",
    effectiveTime: 10,
    edgeId,
    multiplier: 2,
  };
}

function reopened(edgeId: string): AffectednessEvent {
  return { id: "ev-reopen", type: "road_reopened", effectiveTime: 10, edgeId };
}

function created(orderId = "o-new"): AffectednessEvent {
  return {
    id: "ev-create",
    type: "order_created",
    effectiveTime: 10,
    orderId,
    nodeId: "A",
    demand: 1,
  };
}

function expectFailure(
  result: AffectedEntityResult | ReturnType<typeof resolveRouteCommitment>,
  reason: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
    expect(result.detail.length).toBeGreaterThan(0);
  }
}

function affectedOf(result: AffectedEntityResult): readonly AffectedRoute[] {
  expect(result.ok).toBe(true);
  return result.ok ? result.affectedRoutes : [];
}

function commitmentOf(
  route: ExpandedRoute,
  state: VehicleSimulationState,
): RouteCommitment {
  const result = resolveRouteCommitment(route, state);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.detail);
  }

  return result.commitment;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }

  return value;
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return true;
  }

  return (
    Object.isFrozen(value) &&
    Object.values(value).every((child) => isDeepFrozen(child))
  );
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }

  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

// ---------------------------------------------------------------------------
// resolveRouteCommitment
// ---------------------------------------------------------------------------

describe("resolveRouteCommitment: commitment boundaries", () => {
  type Expected = {
    inFlight: { position: RouteEdgePosition; edgeId: string } | null;
    modifiableFrom: RouteEdgePosition | null;
  };

  const EXPECTED: Record<R1StateName, Expected> = {
    // idle: nothing in flight, whole route modifiable
    idle: { inFlight: null, modifiableFrom: pos(0, 0) },
    trav_0_0: {
      inFlight: { position: pos(0, 0), edgeId: "eA" },
      modifiableFrom: pos(0, 1),
    },
    // traveling mid-leg
    trav_0_1: {
      inFlight: { position: pos(0, 1), edgeId: "eB" },
      modifiableFrom: pos(0, 2),
    },
    // traveling on the final edge of a leg: next leg's first edge
    trav_0_2: {
      inFlight: { position: pos(0, 2), edgeId: "eC" },
      modifiableFrom: pos(1, 0),
    },
    // final edge of leg 1; leg 2 has no edges, so skip to leg 3
    trav_1_0: {
      inFlight: { position: pos(1, 0), edgeId: "eD" },
      modifiableFrom: pos(3, 0),
    },
    // servicing: leg just completed, edges after it are modifiable
    serv_0: { inFlight: null, modifiableFrom: pos(1, 0) },
    serv_1: { inFlight: null, modifiableFrom: pos(3, 0) },
    // servicing at the end of the zero-edge leg
    serv_2: { inFlight: null, modifiableFrom: pos(3, 0) },
    trav_3_0: {
      inFlight: { position: pos(3, 0), edgeId: "eA" },
      modifiableFrom: pos(3, 1),
    },
    // last edge of the whole route: nothing left to modify
    trav_3_1: {
      inFlight: { position: pos(3, 1), edgeId: "eE" },
      modifiableFrom: null,
    },
    completed: { inFlight: null, modifiableFrom: null },
  };

  it("resolves in-flight edge and modifiable suffix for every phase and position", () => {
    const actual: Record<string, unknown> = {};
    for (const name of Object.keys(R1_STATES) as R1StateName[]) {
      const commitment = commitmentOf(R1, r1State(name));
      actual[name] = {
        inFlight: commitment.inFlight,
        modifiableFrom: commitment.modifiableFrom,
      };
    }

    expect(actual).toEqual(EXPECTED);
  });

  it("reports route identity and phase on the commitment", () => {
    const commitment = commitmentOf(R1, r1State("serv_1"));

    expect(commitment).toMatchObject({
      routeId: "route-z",
      vehicleId: "v-a",
      routeVersion: 1,
      phase: "servicing",
    });
  });

  it("has no modifiable edge for a zero-stop route, idle or completed", () => {
    const empty = makeRoute("route-empty", "v-e", []);

    expect(commitmentOf(empty, makeState(empty))).toMatchObject({
      inFlight: null,
      modifiableFrom: null,
    });
    expect(
      commitmentOf(empty, makeState(empty, { phase: "completed", legIndex: 0 })),
    ).toMatchObject({ inFlight: null, modifiableFrom: null });
  });

  it("has no modifiable edge when only zero-edge legs follow", () => {
    const tail = makeRoute("route-tail", "v-t", [
      [["eA"], "t1"],
      [[], null],
    ]);

    const traveling = makeState(tail, {
      phase: "traveling",
      currentEdgeId: "eA",
    });
    const servicing = makeState(tail, {
      phase: "servicing",
      completedEdgeIds: ["eA"],
      completedLegIndexes: [0],
    });

    expect(commitmentOf(tail, traveling).modifiableFrom).toBeNull();
    expect(commitmentOf(tail, servicing).modifiableFrom).toBeNull();
  });
});

describe("resolveRouteCommitment: rejects inconsistent input", () => {
  it.each([
    ["wrong route ID", { routeId: "route-other" }],
    ["wrong route version", { routeVersion: 2 }],
    ["wrong vehicle ID", { vehicleId: "v-other" }],
  ] as const)("rejects a state with a %s as ROUTE_STATE_MISMATCH", (_label, overrides) => {
    expectFailure(
      resolveRouteCommitment(R1, r1State("idle", overrides)),
      "ROUTE_STATE_MISMATCH",
    );
  });

  it("rejects a wrong or missing current edge ID while traveling", () => {
    expectFailure(
      resolveRouteCommitment(R1, r1State("trav_0_1", { currentEdgeId: "eX" })),
      "INCONSISTENT_PROGRESS",
    );
    // eC is on the route but not at the reported position.
    expectFailure(
      resolveRouteCommitment(R1, r1State("trav_0_1", { currentEdgeId: "eC" })),
      "INCONSISTENT_PROGRESS",
    );
    expectFailure(
      resolveRouteCommitment(R1, r1State("trav_0_1", { currentEdgeId: null })),
      "INCONSISTENT_PROGRESS",
    );
  });

  it("rejects invalid indices and phase-specific contradictions", () => {
    const cases: Record<string, VehicleSimulationState> = {
      "traveling legIndex -1": r1State("trav_0_1", { legIndex: -1 }),
      "traveling legIndex 1.5": r1State("trav_0_1", { legIndex: 1.5 }),
      "traveling legIndex NaN": r1State("trav_0_1", { legIndex: Number.NaN }),
      "traveling legIndex past the end": r1State("trav_0_1", { legIndex: 4 }),
      "traveling edgeIndexInLeg -1": r1State("trav_0_1", { edgeIndexInLeg: -1 }),
      "traveling edgeIndexInLeg past the leg": r1State("trav_0_1", {
        edgeIndexInLeg: 3,
      }),
      "traveling on a zero-edge leg": r1State("trav_0_1", {
        legIndex: 2,
        edgeIndexInLeg: 0,
      }),
      "servicing legIndex past the end": r1State("serv_1", { legIndex: 4 }),
      "servicing legIndex -1": r1State("serv_1", { legIndex: -1 }),
      "servicing after the final leg": r1State("serv_1", { legIndex: 3 }),
      "servicing with edgeIndexInLeg 1": r1State("serv_1", { edgeIndexInLeg: 1 }),
      "servicing with a current edge": r1State("serv_1", { currentEdgeId: "eD" }),
      "idle with legIndex 1": r1State("idle", { legIndex: 1 }),
      "idle with a current edge": r1State("idle", { currentEdgeId: "eA" }),
      "completed with legIndex 3": r1State("completed", { legIndex: 3 }),
      "unknown phase": r1State("idle", {
        phase: "parked" as unknown as VehicleSimulationState["phase"],
      }),
    };

    const reasons = Object.fromEntries(
      Object.entries(cases).map(([name, state]) => {
        const result = resolveRouteCommitment(R1, state);
        return [name, result.ok ? "ACCEPTED" : result.reason];
      }),
    );

    expect(reasons).toEqual(
      Object.fromEntries(
        Object.keys(cases).map((name) => [name, "INCONSISTENT_PROGRESS"]),
      ),
    );
  });
});

describe("resolveRouteCommitment: completed-prefix validation", () => {
  it("rejects a completed sequence [A, C] where [A, B] is expected (same length)", () => {
    const result = resolveRouteCommitment(
      R1,
      r1State("trav_0_2", { completedEdgeIds: ["eA", "eC"] }),
    );

    expectFailure(result, "INCONSISTENT_PROGRESS");
    if (!result.ok) {
      expect(result.detail).toContain("completedEdgeIds[1]");
    }
  });

  it("requires the exact completed prefix: order, length and repeats", () => {
    const cases: Record<string, VehicleSimulationState> = {
      "wrong order": r1State("trav_0_2", { completedEdgeIds: ["eB", "eA"] }),
      "too few": r1State("trav_0_2", { completedEdgeIds: ["eA"] }),
      "too many": r1State("trav_0_2", {
        completedEdgeIds: ["eA", "eB", "eB"],
      }),
      "repeated edge replaced by another": r1State("trav_3_1", {
        completedEdgeIds: ["eA", "eB", "eC", "eD", "eD"],
      }),
      "repeated edge dropped": r1State("trav_3_1", {
        completedEdgeIds: ["eA", "eB", "eC", "eD"],
      }),
      "idle with history": r1State("idle", { completedEdgeIds: ["eA"] }),
      "completed missing the last edge": r1State("completed", {
        completedEdgeIds: ["eA", "eB", "eC", "eD", "eA"],
      }),
      "servicing missing a finished leg's edge": r1State("serv_1", {
        completedEdgeIds: ["eA", "eB", "eC"],
      }),
    };

    const reasons = Object.fromEntries(
      Object.entries(cases).map(([name, state]) => {
        const result = resolveRouteCommitment(R1, state);
        return [name, result.ok ? "ACCEPTED" : result.reason];
      }),
    );

    expect(reasons).toEqual(
      Object.fromEntries(
        Object.keys(cases).map((name) => [name, "INCONSISTENT_PROGRESS"]),
      ),
    );
  });

  it("also validates completed legs and served orders", () => {
    expectFailure(
      resolveRouteCommitment(R1, r1State("serv_1", { completedLegIndexes: [0] })),
      "INCONSISTENT_PROGRESS",
    );
    expectFailure(
      resolveRouteCommitment(R1, r1State("serv_1", { servedOrderIds: ["o2"] })),
      "INCONSISTENT_PROGRESS",
    );
    expectFailure(
      resolveRouteCommitment(R1, r1State("trav_1_0", { servedOrderIds: [] })),
      "INCONSISTENT_PROGRESS",
    );
  });
});

// ---------------------------------------------------------------------------
// road_closed / travel_time_changed
// ---------------------------------------------------------------------------

/** [state, edge, expected modifiable occurrences, inFlightOnEdge]. */
const MEMBERSHIP: ReadonlyArray<
  readonly [R1StateName, string, readonly RouteEdgePosition[], boolean]
> = [
  // idle: entire route, repeated edge reported at every occurrence
  ["idle", "eA", [pos(0, 0), pos(3, 0)], false],
  ["idle", "eB", [pos(0, 1)], false],
  ["idle", "eX", [], false],
  // completed occurrence ignored, later repeat reported
  ["trav_0_1", "eA", [pos(3, 0)], false],
  // in flight AND again later: still affected, flagged
  ["trav_0_0", "eA", [pos(3, 0)], true],
  // in-flight occurrence only: route unaffected
  ["trav_0_1", "eB", [], true],
  ["trav_3_0", "eA", [], true],
  ["trav_3_1", "eE", [], true],
  // already completed: ignored
  ["trav_0_2", "eB", [], false],
  ["trav_3_1", "eA", [], false],
  // modifiable occurrence right after the in-flight edge
  ["trav_0_0", "eB", [pos(0, 1)], false],
  ["trav_3_0", "eE", [pos(3, 1)], false],
  // across the zero-edge leg
  ["trav_1_0", "eE", [pos(3, 1)], false],
  // servicing: the completed leg is ignored, the rest is modifiable
  ["serv_0", "eD", [pos(1, 0)], false],
  ["serv_1", "eD", [], false],
  ["serv_1", "eE", [pos(3, 1)], false],
  ["serv_2", "eA", [pos(3, 0)], false],
  // completed vehicle: nothing is modifiable
  ["completed", "eA", [], false],
  ["completed", "eE", [], false],
];

describe("road_closed", () => {
  it("invalidates a route only for edges in its modifiable suffix", () => {
    const actual = MEMBERSHIP.map(([name, edgeId]) => {
      const [route] = affectedOf(
        identifyAffectedEntities(closed(edgeId), r1Input(name)),
      );
      return route === undefined
        ? { occurrences: [], inFlightOnEdge: false }
        : {
            impact: route.impact,
            occurrences: route.occurrences,
            inFlightOnEdge: route.inFlightOnEdge,
          };
    });

    const expected = MEMBERSHIP.map(([, , occurrences, inFlightOnEdge]) =>
      occurrences.length === 0
        ? { occurrences: [], inFlightOnEdge: false }
        : { impact: "INVALIDATED", occurrences, inFlightOnEdge },
    );

    expect(actual).toEqual(expected);
  });

  it("returns route identity and the closed edge ID", () => {
    const result = identifyAffectedEntities(closed("eB"), r1Input("idle"));

    expect(result).toEqual({
      ok: true,
      kind: "road_closed",
      edgeId: "eB",
      affectedRoutes: [
        {
          routeId: "route-z",
          vehicleId: "v-a",
          routeVersion: 1,
          impact: "INVALIDATED",
          occurrences: [pos(0, 1)],
          inFlightOnEdge: false,
        },
      ],
    });
  });

  it("handles several routes: only affected ones, sorted by vehicleId then routeId", () => {
    // routeId order is the reverse of vehicleId order on purpose.
    const r2 = makeRoute(
      "route-a",
      "v-b",
      [
        [["eA", "eF"], "p1"],
        [["eF", "eA"], null],
      ],
      3,
    );
    const r3 = makeRoute("route-m", "v-c", [
      [["eA"], "q1"],
      [["eA"], null],
    ]);
    const r4 = makeRoute("route-n", "v-d", [[["eZ"], "w1"], [["eZ"], null]]);

    const input: RouteProgressInput = {
      routes: [r4, r3, r2, R1],
      vehicleStates: [
        makeState(r3, {
          phase: "completed",
          legIndex: 2,
          completedEdgeIds: ["eA", "eA"],
          completedLegIndexes: [0, 1],
          servedOrderIds: ["q1"],
        }),
        makeState(r4),
        r1State("idle"),
        makeState(r2),
      ],
    };

    const affected = affectedOf(identifyAffectedEntities(closed("eA"), input));

    expect(affected.map((route) => route.vehicleId)).toEqual(["v-a", "v-b"]);
    expect(affected.map((route) => route.routeId)).toEqual([
      "route-z",
      "route-a",
    ]);
    expect(affected[1]).toMatchObject({
      routeVersion: 3,
      occurrences: [pos(0, 0), pos(1, 1)],
    });
  });

  it("returns an empty result when no route uses the edge", () => {
    expect(
      identifyAffectedEntities(closed("eX"), r1Input("idle")),
    ).toEqual({
      ok: true,
      kind: "road_closed",
      edgeId: "eX",
      affectedRoutes: [],
    });
  });

  it("succeeds with no routes and no states", () => {
    expect(
      identifyAffectedEntities(closed("eA"), { routes: [], vehicleStates: [] }),
    ).toMatchObject({ ok: true, affectedRoutes: [] });
  });
});

describe("travel_time_changed", () => {
  it("uses the same membership rules as closure but classifies as RETIMED", () => {
    for (const [name, edgeId] of MEMBERSHIP) {
      const closure = affectedOf(
        identifyAffectedEntities(closed(edgeId), r1Input(name)),
      );
      const retime = affectedOf(
        identifyAffectedEntities(retimed(edgeId), r1Input(name)),
      );

      expect(retime.map((r) => r.impact)).toEqual(
        closure.map(() => "RETIMED"),
      );
      expect(
        retime.map(({ impact: _impact, ...rest }) => rest),
      ).toEqual(closure.map(({ impact: _impact, ...rest }) => rest));
    }
  });

  it("does not affect a route whose only occurrence is in flight (duration locked at entry)", () => {
    const result = identifyAffectedEntities(retimed("eB"), r1Input("trav_0_1"));

    expect(result).toEqual({
      ok: true,
      kind: "travel_time_changed",
      edgeId: "eB",
      affectedRoutes: [],
    });
  });

  it("retimes a route with later occurrences while the in-flight one is unaffected", () => {
    const [route] = affectedOf(
      identifyAffectedEntities(retimed("eA"), r1Input("trav_0_0")),
    );

    expect(route).toMatchObject({
      impact: "RETIMED",
      occurrences: [pos(3, 0)],
      inFlightOnEdge: true,
    });
  });
});

describe("road_reopened", () => {
  it("never affects a committed route, even one containing the edge", () => {
    for (const name of Object.keys(R1_STATES) as R1StateName[]) {
      expect(identifyAffectedEntities(reopened("eA"), r1Input(name))).toEqual({
        ok: true,
        kind: "road_reopened",
        edgeId: "eA",
        affectedRoutes: [],
        mayEnableUnreachableOrders: true,
      });
    }
  });

  it("still reports corrupt route input instead of ignoring it", () => {
    expectFailure(
      identifyAffectedEntities(reopened("eA"), {
        routes: [R1],
        vehicleStates: [],
      }),
      "VEHICLE_STATE_MISSING",
    );
  });
});

describe("order_created", () => {
  it("is always processed, with no affected routes", () => {
    expect(identifyAffectedEntities(created("o-9"), r1Input("idle"))).toEqual({
      ok: true,
      kind: "order_created",
      orderId: "o-9",
      affectedRoutes: [],
      processing: "ALWAYS",
    });
  });

  it("is processed even when route input is deliberately inconsistent", () => {
    const inconsistent: RouteProgressInput[] = [
      { routes: [R1], vehicleStates: [] },
      { routes: [R1, R1], vehicleStates: [r1State("idle"), r1State("idle")] },
      {
        routes: [R1],
        vehicleStates: [r1State("trav_0_1", { currentEdgeId: "eX" })],
      },
      { routes: [], vehicleStates: [r1State("idle")] },
    ];

    for (const input of inconsistent) {
      expect(identifyAffectedEntities(created(), input)).toMatchObject({
        ok: true,
        kind: "order_created",
        processing: "ALWAYS",
      });
    }
  });

  it("does not read the route input at all", () => {
    const hostile = {
      get routes(): never {
        throw new Error("routes were read");
      },
      get vehicleStates(): never {
        throw new Error("vehicleStates were read");
      },
    } as unknown as RouteProgressInput;

    expect(() => identifyAffectedEntities(created(), hostile)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// input failures
// ---------------------------------------------------------------------------

describe("route input validation", () => {
  const R2 = makeRoute("route-b", "v-b", [[["eF"], "p1"], [["eF"], null]]);

  it("fails with VEHICLE_STATE_MISSING when a routed vehicle has no state", () => {
    expectFailure(
      identifyAffectedEntities(closed("eA"), {
        routes: [R1, R2],
        vehicleStates: [r1State("idle")],
      }),
      "VEHICLE_STATE_MISSING",
    );
  });

  it("fails with DUPLICATE_VEHICLE for two states of one vehicle", () => {
    expectFailure(
      identifyAffectedEntities(closed("eA"), {
        routes: [R1],
        vehicleStates: [r1State("idle"), r1State("idle")],
      }),
      "DUPLICATE_VEHICLE",
    );
  });

  it("fails with DUPLICATE_ROUTE_ID when two vehicles share a route ID", () => {
    const clash = makeRoute("route-z", "v-b", [[["eF"], "p1"], [["eF"], null]]);

    expectFailure(
      identifyAffectedEntities(closed("eA"), {
        routes: [R1, clash],
        vehicleStates: [r1State("idle"), makeState(clash)],
      }),
      "DUPLICATE_ROUTE_ID",
    );
  });

  it("fails with AMBIGUOUS_VEHICLE_ROUTE when one vehicle has two routes", () => {
    const second = makeRoute("route-second", "v-a", [[["eF"], "p1"], [["eF"], null]]);

    expectFailure(
      identifyAffectedEntities(closed("eA"), {
        routes: [R1, second],
        vehicleStates: [r1State("idle")],
      }),
      "AMBIGUOUS_VEHICLE_ROUTE",
    );
  });

  it("fails with UNEXPECTED_VEHICLE_STATE for a state without a route", () => {
    expectFailure(
      identifyAffectedEntities(closed("eA"), {
        routes: [R1],
        vehicleStates: [r1State("idle"), makeState(R2)],
      }),
      "UNEXPECTED_VEHICLE_STATE",
    );
  });

  it("propagates commitment failures for every road event", () => {
    const bad: RouteProgressInput = {
      routes: [R1],
      vehicleStates: [r1State("trav_0_1", { routeVersion: 9 })],
    };
    const badProgress: RouteProgressInput = {
      routes: [R1],
      vehicleStates: [r1State("trav_0_1", { currentEdgeId: "eX" })],
    };

    for (const event of [closed("eA"), retimed("eA"), reopened("eA")]) {
      expectFailure(identifyAffectedEntities(event, bad), "ROUTE_STATE_MISMATCH");
      expectFailure(
        identifyAffectedEntities(event, badProgress),
        "INCONSISTENT_PROGRESS",
      );
    }
  });

  it("returns a structured failure for deferred event types instead of throwing", () => {
    const deferred = [
      { id: "e1", type: "order_cancelled", effectiveTime: 1, orderId: "o1" },
      { id: "e2", type: "vehicle_broken_down", effectiveTime: 1, vehicleId: "v-a" },
    ] as unknown as AffectednessEvent[];

    for (const event of deferred) {
      expectFailure(
        identifyAffectedEntities(event, r1Input("idle")),
        "UNSUPPORTED_EVENT_TYPE",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

describe("purity", () => {
  const R2 = makeRoute("route-a", "v-b", [
    [["eA", "eF"], "p1"],
    [["eF", "eA"], null],
  ]);
  const R3 = makeRoute("route-m", "v-c", [[["eA"], "q1"], [["eA"], null]]);

  function threeRouteInput(): RouteProgressInput {
    return {
      routes: [R1, R2, R3],
      vehicleStates: [
        r1State("trav_0_1"),
        makeState(R2, {
          phase: "servicing",
          legIndex: 0,
          completedEdgeIds: ["eA", "eF"],
          completedLegIndexes: [0],
        }),
        makeState(R3),
      ],
    };
  }

  const EVENTS: AffectednessEvent[] = [
    closed("eA"),
    retimed("eA"),
    reopened("eA"),
    created(),
  ];

  it("never mutates its input, including deeply frozen input", () => {
    const plain = threeRouteInput();
    const before = structuredClone(plain);
    for (const event of EVENTS) {
      identifyAffectedEntities(event, plain);
    }
    expect(plain).toEqual(before);

    // Mutating a frozen object throws in strict (ESM) code.
    const frozen = deepFreeze(threeRouteInput());
    for (const event of EVENTS) {
      expect(() => identifyAffectedEntities(event, frozen)).not.toThrow();
    }
  });

  it("returns deeply frozen results, including failures and commitments", () => {
    for (const event of EVENTS) {
      expect(isDeepFrozen(identifyAffectedEntities(event, threeRouteInput()))).toBe(
        true,
      );
    }

    expect(
      isDeepFrozen(identifyAffectedEntities(closed("eA"), { routes: [R1], vehicleStates: [] })),
    ).toBe(true);

    for (const name of Object.keys(R1_STATES) as R1StateName[]) {
      expect(isDeepFrozen(resolveRouteCommitment(R1, r1State(name)))).toBe(true);
    }
    expect(
      isDeepFrozen(
        resolveRouteCommitment(R1, r1State("idle", { routeId: "nope" })),
      ),
    ).toBe(true);
  });

  it("does not alias input arrays in its results", () => {
    const result = identifyAffectedEntities(closed("eA"), threeRouteInput());
    const [route] = affectedOf(result);

    expect(route).toBeDefined();
    expect(route?.occurrences).not.toBe(R1.legs);
  });

  it("is deterministic: repeated calls give equal results", () => {
    for (const event of EVENTS) {
      const input = threeRouteInput();
      expect(identifyAffectedEntities(event, input)).toEqual(
        identifyAffectedEntities(event, input),
      );
    }
  });

  it("is independent of route and state input order", () => {
    const base = threeRouteInput();
    const routeOrders = permutations(base.routes);
    const stateOrders = permutations(base.vehicleStates);

    for (const event of [closed("eA"), retimed("eF"), reopened("eA")]) {
      const reference = identifyAffectedEntities(event, base);
      for (const routes of routeOrders) {
        for (const vehicleStates of stateOrders) {
          expect(
            identifyAffectedEntities(event, { routes, vehicleStates }),
          ).toEqual(reference);
        }
      }
    }
  });

  it("reports the same failure whatever the input order", () => {
    // Several simultaneous problems: a bad state and a missing state.
    const routes = [R1, R2, R3];
    const states = [r1State("trav_0_1", { currentEdgeId: "eX" }), makeState(R3)];
    const reference = identifyAffectedEntities(closed("eA"), {
      routes,
      vehicleStates: states,
    });
    expectFailure(reference, "VEHICLE_STATE_MISSING");

    for (const routeOrder of permutations(routes)) {
      for (const stateOrder of permutations(states)) {
        expect(
          identifyAffectedEntities(closed("eA"), {
            routes: routeOrder,
            vehicleStates: stateOrder,
          }),
        ).toEqual(reference);
      }
    }

    // Two commitment failures: the smallest vehicleId is reported.
    const twoBad = {
      routes: [R3, R1],
      vehicleStates: [
        makeState(R3, { routeVersion: 7 }),
        r1State("trav_0_1", { currentEdgeId: "eX" }),
      ],
    };
    const first = identifyAffectedEntities(closed("eA"), twoBad);
    expectFailure(first, "INCONSISTENT_PROGRESS");
    expect(
      identifyAffectedEntities(closed("eA"), {
        routes: [...twoBad.routes].reverse(),
        vehicleStates: [...twoBad.vehicleStates].reverse(),
      }),
    ).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// engine cross-check (read-only: uses only the public SimulationEngine API)
// ---------------------------------------------------------------------------

describe("cross-check against SimulationEngine", () => {
  const depot: Depot = { id: "dep", name: "Depot", nodeId: "D" };

  function buildGraph(): RoadGraph {
    const graph = new RoadGraph();
    for (const [index, id] of ["D", "A", "B", "C"].entries()) {
      graph.addNode({ id, lat: index, lng: 0 });
    }

    for (const [from, to, weight] of [
      ["D", "A", 2],
      ["A", "D", 2],
      ["A", "B", 3],
      ["B", "A", 3],
      ["B", "C", 2],
      ["C", "B", 2],
      ["C", "D", 4],
      ["D", "C", 4],
    ] as const) {
      graph.addEdge({
        id: `e-${from}${to}`,
        fromNodeId: from,
        toNodeId: to,
        baseWeight: weight,
      });
    }

    return graph;
  }

  const ORDER_NODES: Readonly<Record<string, string>> = {
    "o-b1": "B",
    "o-a": "A",
    "o-b2": "B",
    "o-d1": "D",
    "o-c": "C",
    "o-d2": "D",
  };

  /**
   * v-a: repeated edges (e-AB, e-BA). v-b: zero-edge FIRST leg (order at the
   * depot). v-c: zero-stop route. v-d: only zero-edge legs.
   */
  const ROUTES: readonly Route[] = [
    {
      id: "route-v-a",
      vehicleId: "v-a",
      version: 1,
      stops: [
        { orderId: "o-b1", sequenceNo: 1 },
        { orderId: "o-a", sequenceNo: 2 },
        { orderId: "o-b2", sequenceNo: 3 },
      ],
    },
    {
      id: "route-v-b",
      vehicleId: "v-b",
      version: 1,
      stops: [
        { orderId: "o-d1", sequenceNo: 1 },
        { orderId: "o-c", sequenceNo: 2 },
      ],
    },
    { id: "route-v-c", vehicleId: "v-c", version: 1, stops: [] },
    {
      id: "route-v-d",
      vehicleId: "v-d",
      version: 1,
      stops: [{ orderId: "o-d2", sequenceNo: 1 }],
    },
  ];

  const orders: Order[] = Object.entries(ORDER_NODES).map(([id, nodeId]) => ({
    id,
    nodeId,
    demand: 1,
    status: "assigned",
  }));

  const vehicles: Vehicle[] = ["v-a", "v-b", "v-c", "v-d"].map((id) => ({
    id,
    label: id,
    capacity: 100,
    depotId: "dep",
    status: "idle",
  }));

  interface Sample {
    readonly state: SimulationState;
    readonly eventCount: number;
  }

  interface Run {
    readonly graph: RoadGraph;
    readonly expanded: readonly ExpandedRoute[];
    readonly samples: readonly Sample[];
    /** Edges the engine enters after each sample, per vehicle, in order. */
    readonly futureEntered: ReadonlyArray<ReadonlyMap<string, readonly string[]>>;
  }

  function runEngine(): Run {
    const graph = buildGraph();
    const ordersMap = new Map(orders.map((order) => [order.id, order]));

    // The engine keeps its committed legs private. With an unchanged graph,
    // expandRoute (the function the constructor uses) reproduces them exactly.
    const expanded = ROUTES.map((route) => {
      const result = expandRoute(route, ordersMap, depot.nodeId, graph);
      if (!result.ok) {
        throw new Error(result.detail);
      }
      return result.expanded;
    });

    const engine = new SimulationEngine({
      graph,
      depot,
      routes: ROUTES,
      orders,
      vehicles,
      serviceTimePerStop: 1.5,
    });

    const samples: Sample[] = [{ state: engine.getState(), eventCount: 0 }];

    engine.start();
    samples.push({ state: engine.getState(), eventCount: engine.getEvents().length });

    for (let step = 0; engine.getState().status !== "completed"; step++) {
      if (step > 1000) {
        throw new Error("simulation did not complete");
      }
      engine.advanceBy(0.5);
      samples.push({
        state: engine.getState(),
        eventCount: engine.getEvents().length,
      });
    }

    const events = engine.getEvents();
    const futureEntered = samples.map((sample) => {
      const byVehicle = new Map<string, string[]>();
      for (const event of events.slice(sample.eventCount)) {
        if (event.type === "vehicle.edge_entered") {
          const list = byVehicle.get(event.vehicleId) ?? [];
          list.push(event.edgeId);
          byVehicle.set(event.vehicleId, list);
        }
      }
      return byVehicle;
    });

    return { graph, expanded, samples, futureEntered };
  }

  /** Edges from `from` (inclusive) to the end of the route, in order. */
  function edgesFrom(
    route: ExpandedRoute,
    from: RouteEdgePosition | null,
  ): string[] {
    if (from === null) {
      return [];
    }

    const edges: string[] = [];
    for (const [legIndex, leg] of route.legs.entries()) {
      for (const [edgeIndexInLeg, edgeId] of leg.edgeIds.entries()) {
        if (
          legIndex > from.legIndex ||
          (legIndex === from.legIndex && edgeIndexInLeg >= from.edgeIndexInLeg)
        ) {
          edges.push(edgeId);
        }
      }
    }
    return edges;
  }

  const run = runEngine();

  it("accepts every real engine state and its modifiable suffix equals the edges the engine later enters", () => {
    for (const [index, sample] of run.samples.entries()) {
      const future = run.futureEntered[index] ?? new Map<string, string[]>();

      for (const route of run.expanded) {
        const state = must(
          sample.state.vehicles.find((v) => v.vehicleId === route.vehicleId),
        );
        const commitment = commitmentOf(route, state);

        expect(edgesFrom(route, commitment.modifiableFrom)).toEqual(
          future.get(route.vehicleId) ?? [],
        );
        expect(commitment.inFlight?.edgeId ?? null).toBe(state.currentEdgeId);
      }
    }
  });

  it("flags exactly the vehicles that will still enter the closed edge, with the right occurrence count", () => {
    const edgeIds = ["e-DA", "e-AD", "e-AB", "e-BA", "e-BC", "e-CB", "e-CD", "e-DC"];

    for (const [index, sample] of run.samples.entries()) {
      const future = run.futureEntered[index] ?? new Map<string, string[]>();
      const input: RouteProgressInput = {
        routes: run.expanded,
        vehicleStates: sample.state.vehicles,
      };

      for (const edgeId of edgeIds) {
        const expected = [...future.entries()]
          .map(([vehicleId, entered]) => [
            vehicleId,
            entered.filter((id) => id === edgeId).length,
          ] as const)
          .filter(([, count]) => count > 0)
          .sort(([a], [b]) => (a < b ? -1 : 1));

        for (const event of [closed(edgeId), retimed(edgeId)]) {
          const actual = affectedOf(identifyAffectedEntities(event, input)).map(
            (route) => [route.vehicleId, route.occurrences.length] as const,
          );

          expect(actual).toEqual(expected);
        }
      }
    }
  });

  it("covers every phase, the final edge of a leg, and zero-edge legs", () => {
    const phases = new Set<string>();
    let finalEdgeOfLeg = false;
    let servicingZeroEdgeLeg = false;

    for (const sample of run.samples) {
      for (const state of sample.state.vehicles) {
        phases.add(state.phase);
        const route = must(
          run.expanded.find((r) => r.vehicleId === state.vehicleId),
        );
        const leg = route.legs[state.legIndex];

        if (state.phase === "traveling" && leg !== undefined) {
          finalEdgeOfLeg ||= state.edgeIndexInLeg === leg.edgeIds.length - 1;
        }
        if (state.phase === "servicing" && leg?.edgeIds.length === 0) {
          servicingZeroEdgeLeg = true;
        }
      }
    }

    expect([...phases].sort()).toEqual([
      "completed",
      "idle_at_depot",
      "servicing",
      "traveling",
    ]);
    expect(finalEdgeOfLeg).toBe(true);
    expect(servicingZeroEdgeLeg).toBe(true);
    expect(run.expanded.some((r) => r.legs.length === 0)).toBe(true);
    expect(
      run.expanded.some((r) => r.legs.some((leg) => leg.edgeIds.length === 0)),
    ).toBe(true);
  });
});