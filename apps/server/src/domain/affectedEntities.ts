import type {
  OrderCreatedEvent,
  RoadClosedEvent,
  RoadReopenedEvent,
  TravelTimeChangedEvent,
} from "./operationalEvents.js";
import type { ExpandedRoute, RouteLeg } from "./routeExpansion.js";
import type { VehiclePhase, VehicleSimulationState } from "./simulation.js";

/**
 * Affected-entity identification: which COMMITTED routes does an operational
 * event touch?
 *
 *   Operational Event -> Affected-Entity Identification -> Localized Repair
 *   -> Feasibility Validation -> Warm-Started Fallback -> Versioned Update
 *
 * This module only answers "which routes, and at which edge positions". It
 * does not repair, reassign orders, apply events, read the RoadGraph, or touch
 * the simulation engine. It is pure and deterministic: no clock, randomness
 * or I/O, no input is mutated, and every result is deeply frozen.
 *
 * Input: the engine's frozen committed legs
 * -----------------------------------------
 * SimulationEngine keeps its expanded routes private and freezes their legs at
 * construction. Re-running `expandRoute` after a graph change could pick a
 * different path, so this module never re-expands: the caller supplies the
 * actual committed `ExpandedRoute[]` together with the engine's
 * `VehicleSimulationState[]` (from `getState().vehicles`). Providing the
 * engine's committed legs is a Milestone 3 concern.
 *
 * Commitment boundary
 * -------------------
 * Positions are (legIndex, edgeIndexInLeg) into `ExpandedRoute.legs`.
 *
 *   phase           in-flight edge        modifiable suffix
 *   idle_at_depot   none                  every edge of the route
 *   traveling       the current edge      edges after the current edge
 *   servicing       none                  edges of legs after the current leg
 *   completed       none                  none
 *
 * While `servicing`, `legIndex` still names the leg just completed, so all of
 * its edges are complete. A zero-edge leg has no positions; the first
 * modifiable position is the first position that exists at or after the raw
 * boundary, or null when no edge remains. An in-flight edge is committed: its
 * duration is locked at entry, so closing or retiming it does not affect the
 * traversal in progress. Occurrences in completed edges are ignored.
 *
 * Committed stops: the stop at the end of the in-flight leg and the stop
 * currently being serviced are committed. Only edge positions are reported
 * here; what happens to those stops or their orders is a repair concern.
 *
 * Progress validation
 * -------------------
 * `resolveRouteCommitment` does not trust a state. Besides route identity and
 * index ranges, it rebuilds what the engine's append-only history MUST be for
 * the reported position and requires an exact match (order and duplicates
 * included, not just length):
 *   - completedEdgeIds: the concatenated edges of every fully completed leg,
 *     plus, while traveling, the edges of the current leg before the
 *     in-flight one;
 *   - completedLegIndexes: 0..n-1 for the n completed legs;
 *   - servedOrderIds: the arrival orders of legs whose service has finished.
 * `[A, C]` is rejected where `[A, B]` is expected even though both have two
 * elements.
 *
 * Route uniqueness
 * ----------------
 * The engine builds exactly one runtime per route and rejects a second route
 * for the same vehicle, so states and routes are 1:1 by vehicleId. This
 * module enforces that: duplicate vehicle states, duplicate route IDs (the
 * engine does not check this, but results identify routes by routeId),
 * several routes for one vehicle, a route without a state and a state without
 * a route are all structured failures. Input is checked in a fixed phase
 * order and routes are visited sorted by (vehicleId, routeId), so the result,
 * including which failure is reported, does not depend on input order.
 *
 * Event semantics
 * ---------------
 *   - road_closed:         routes with the edge in their modifiable suffix are
 *                          INVALIDATED.
 *   - travel_time_changed: same membership, classified RETIMED.
 *   - road_reopened:       cannot invalidate a committed route. Returns no
 *                          affected routes and `mayEnableUnreachableOrders`.
 *                          Route improvement is not detected.
 *   - order_created:       always processable. Never inspects the route input,
 *                          so even inconsistent input cannot block it.
 *   - order_cancelled and vehicle_broken_down are deferred; passing one at
 *     runtime returns UNSUPPORTED_EVENT_TYPE.
 * The commitment-resolving events (closure, retime and reopening) all validate
 * the route input, so a corrupt snapshot is reported rather than ignored.
 *
 * Caller contracts
 * ----------------
 *   - This module is graph-free. The caller must skip events whose
 *     `validateOperationalEvent` result has `noOp: true`; a no-op
 *     travel_time_changed must never be reported as RETIMED.
 *   - Same-instant ordering (Milestone 3 must follow this):
 *       1. advance the simulation to the event's effective time;
 *       2. settle every transition due at that instant;
 *       3. capture vehicle progress;
 *       4. apply the event;
 *       5. identify affected entities.
 *     A vehicle that reaches a node at exactly the event time and enters its
 *     next edge during settlement already has that edge in flight, so it is
 *     committed.
 */

export type AffectednessEvent =
  | RoadClosedEvent
  | RoadReopenedEvent
  | TravelTimeChangedEvent
  | OrderCreatedEvent;

/** Position of one edge in a route: leg, then edge within that leg. */
export interface RouteEdgePosition {
  readonly legIndex: number;
  readonly edgeIndexInLeg: number;
}

export interface RouteCommitment {
  readonly routeId: string;
  readonly vehicleId: string;
  readonly routeVersion: number;
  readonly phase: VehiclePhase;
  /** The edge being traversed right now; null when the vehicle is at a node. */
  readonly inFlight: {
    readonly position: RouteEdgePosition;
    readonly edgeId: string;
  } | null;
  /**
   * First edge position that a repair may still change, or null when no edge
   * remains. Always a position that exists.
   */
  readonly modifiableFrom: RouteEdgePosition | null;
}

export type CommitmentFailureReason =
  | "ROUTE_STATE_MISMATCH"
  | "INCONSISTENT_PROGRESS";

export type RouteCommitmentResult =
  | {
      readonly ok: true;
      readonly commitment: RouteCommitment;
    }
  | {
      readonly ok: false;
      readonly reason: CommitmentFailureReason;
      readonly detail: string;
    };

export interface RouteProgressInput {
  readonly routes: readonly ExpandedRoute[];
  readonly vehicleStates: readonly VehicleSimulationState[];
}

export interface AffectedRoute {
  readonly routeId: string;
  readonly vehicleId: string;
  readonly routeVersion: number;
  readonly impact: "INVALIDATED" | "RETIMED";
  /** Every modifiable occurrence of the edge, in route order. Never empty. */
  readonly occurrences: readonly RouteEdgePosition[];
  /** True when the edge is also the one being traversed right now. */
  readonly inFlightOnEdge: boolean;
}

export type AffectedEntityFailureReason =
  | CommitmentFailureReason
  | "VEHICLE_STATE_MISSING"
  | "DUPLICATE_VEHICLE"
  | "DUPLICATE_ROUTE_ID"
  | "AMBIGUOUS_VEHICLE_ROUTE"
  | "UNEXPECTED_VEHICLE_STATE"
  | "UNSUPPORTED_EVENT_TYPE";

export interface AffectedEntityFailure {
  readonly ok: false;
  readonly reason: AffectedEntityFailureReason;
  readonly detail: string;
}

export interface RoadClosedAffectedResult {
  readonly ok: true;
  readonly kind: "road_closed";
  readonly edgeId: string;
  readonly affectedRoutes: readonly AffectedRoute[];
}

export interface TravelTimeChangedAffectedResult {
  readonly ok: true;
  readonly kind: "travel_time_changed";
  readonly edgeId: string;
  readonly affectedRoutes: readonly AffectedRoute[];
}

export interface RoadReopenedAffectedResult {
  readonly ok: true;
  readonly kind: "road_reopened";
  readonly edgeId: string;
  readonly affectedRoutes: readonly [];
  readonly mayEnableUnreachableOrders: true;
}

export interface OrderCreatedAffectedResult {
  readonly ok: true;
  readonly kind: "order_created";
  readonly orderId: string;
  readonly affectedRoutes: readonly [];
  readonly processing: "ALWAYS";
}

export type AffectedEntityResult =
  | RoadClosedAffectedResult
  | TravelTimeChangedAffectedResult
  | RoadReopenedAffectedResult
  | OrderCreatedAffectedResult
  | AffectedEntityFailure;

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Resolves what is committed and what may still change for one vehicle, after
 * checking that `state` really describes progress along `route`.
 *
 * Failures are structured, never thrown:
 *   - ROUTE_STATE_MISMATCH: the state is not for this vehicle/route/version.
 *   - INCONSISTENT_PROGRESS: indices, current edge, or the completed-edge,
 *     completed-leg or served-order history do not match the route.
 */
export function resolveRouteCommitment(
  route: ExpandedRoute,
  state: VehicleSimulationState,
): RouteCommitmentResult {
  if (state.vehicleId !== route.vehicleId) {
    return commitmentFailure(
      "ROUTE_STATE_MISMATCH",
      `State is for vehicle ${state.vehicleId} but route ${route.routeId} belongs to vehicle ${route.vehicleId}`,
    );
  }

  if (state.routeId !== route.routeId) {
    return commitmentFailure(
      "ROUTE_STATE_MISMATCH",
      `State of vehicle ${state.vehicleId} is for route ${state.routeId}, not route ${route.routeId}`,
    );
  }

  if (state.routeVersion !== route.version) {
    return commitmentFailure(
      "ROUTE_STATE_MISMATCH",
      `State of vehicle ${state.vehicleId} is for route version ${String(state.routeVersion)}, not version ${String(route.version)}`,
    );
  }

  switch (state.phase) {
    case "idle_at_depot":
      return resolveIdle(route, state);
    case "traveling":
      return resolveTraveling(route, state);
    case "servicing":
      return resolveServicing(route, state);
    case "completed":
      return resolveCompleted(route, state);
    default:
      return inconsistent(
        `Vehicle ${state.vehicleId} has unknown phase: ${String(state.phase)}`,
      );
  }
}

/**
 * Identifies the committed routes an event affects. See the module doc for
 * the rules and for the caller contracts (skip no-op events; same-instant
 * ordering).
 */
export function identifyAffectedEntities(
  event: AffectednessEvent,
  input: RouteProgressInput,
): AffectedEntityResult {
  switch (event.type) {
    case "order_created":
      // Deliberately does not read `input`: inconsistent route input must
      // never prevent a new order from being processed.
      return Object.freeze({
        ok: true,
        kind: "order_created",
        orderId: event.orderId,
        affectedRoutes: NO_ROUTES,
        processing: "ALWAYS",
      });

    case "road_closed": {
      const resolved = resolveInput(input);
      if (!resolved.ok) {
        return resolved;
      }

      return Object.freeze({
        ok: true,
        kind: "road_closed",
        edgeId: event.edgeId,
        affectedRoutes: collectAffected(
          resolved.entries,
          event.edgeId,
          "INVALIDATED",
        ),
      });
    }

    case "travel_time_changed": {
      const resolved = resolveInput(input);
      if (!resolved.ok) {
        return resolved;
      }

      return Object.freeze({
        ok: true,
        kind: "travel_time_changed",
        edgeId: event.edgeId,
        affectedRoutes: collectAffected(
          resolved.entries,
          event.edgeId,
          "RETIMED",
        ),
      });
    }

    case "road_reopened": {
      // A reopening cannot invalidate a committed route, but the input is
      // still validated so a corrupt snapshot is reported, not ignored.
      const resolved = resolveInput(input);
      if (!resolved.ok) {
        return resolved;
      }

      return Object.freeze({
        ok: true,
        kind: "road_reopened",
        edgeId: event.edgeId,
        affectedRoutes: NO_ROUTES,
        mayEnableUnreachableOrders: true,
      });
    }

    default:
      return unsupportedEvent(event);
  }
}

// ---------------------------------------------------------------------------
// commitment resolution
// ---------------------------------------------------------------------------

function resolveIdle(
  route: ExpandedRoute,
  state: VehicleSimulationState,
): RouteCommitmentResult {
  if (
    state.legIndex !== 0 ||
    state.edgeIndexInLeg !== 0 ||
    state.currentEdgeId !== null
  ) {
    return inconsistent(
      `Vehicle ${state.vehicleId} is idle_at_depot but reports legIndex ${String(state.legIndex)}, edgeIndexInLeg ${String(state.edgeIndexInLeg)}, currentEdgeId ${String(state.currentEdgeId)}`,
    );
  }

  const historyProblem = checkHistory(route, state, {
    completedEdgeIds: [],
    completedLegCount: 0,
    servedLegCount: 0,
  });
  if (historyProblem !== null) {
    return inconsistent(historyProblem);
  }

  return buildCommitment(route, state, null, firstEdgeFromLeg(route.legs, 0));
}

function resolveTraveling(
  route: ExpandedRoute,
  state: VehicleSimulationState,
): RouteCommitmentResult {
  const { legIndex, edgeIndexInLeg } = state;
  const leg = legAt(route, legIndex);
  if (leg === undefined) {
    return inconsistent(
      `Vehicle ${state.vehicleId} is traveling at legIndex ${String(legIndex)}, outside route ${route.routeId} (${String(route.legs.length)} legs)`,
    );
  }

  if (
    !Number.isInteger(edgeIndexInLeg) ||
    edgeIndexInLeg < 0 ||
    edgeIndexInLeg >= leg.edgeIds.length
  ) {
    return inconsistent(
      `Vehicle ${state.vehicleId} is traveling at edgeIndexInLeg ${String(edgeIndexInLeg)}, outside leg ${String(legIndex)} (${String(leg.edgeIds.length)} edges)`,
    );
  }

  const edgeId = leg.edgeIds[edgeIndexInLeg];
  if (edgeId === undefined || state.currentEdgeId !== edgeId) {
    return inconsistent(
      `Vehicle ${state.vehicleId} reports currentEdgeId ${String(state.currentEdgeId)} but leg ${String(legIndex)} edge ${String(edgeIndexInLeg)} is ${String(edgeId)}`,
    );
  }

  const historyProblem = checkHistory(route, state, {
    completedEdgeIds: [
      ...edgesOfLegs(route.legs, legIndex),
      ...leg.edgeIds.slice(0, edgeIndexInLeg),
    ],
    completedLegCount: legIndex,
    servedLegCount: legIndex,
  });
  if (historyProblem !== null) {
    return inconsistent(historyProblem);
  }

  const next: RouteEdgePosition | null =
    edgeIndexInLeg + 1 < leg.edgeIds.length
      ? { legIndex, edgeIndexInLeg: edgeIndexInLeg + 1 }
      : firstEdgeFromLeg(route.legs, legIndex + 1);

  return buildCommitment(
    route,
    state,
    { position: { legIndex, edgeIndexInLeg }, edgeId },
    next,
  );
}

function resolveServicing(
  route: ExpandedRoute,
  state: VehicleSimulationState,
): RouteCommitmentResult {
  const { legIndex } = state;
  const leg = legAt(route, legIndex);
  if (leg === undefined) {
    return inconsistent(
      `Vehicle ${state.vehicleId} is servicing at legIndex ${String(legIndex)}, outside route ${route.routeId} (${String(route.legs.length)} legs)`,
    );
  }

  if (leg.arrivalOrderId === null) {
    return inconsistent(
      `Vehicle ${state.vehicleId} is servicing after leg ${String(legIndex)}, which has no arrival order`,
    );
  }

  // The engine resets edgeIndexInLeg to 0 on arrival at a leg end.
  if (state.edgeIndexInLeg !== 0 || state.currentEdgeId !== null) {
    return inconsistent(
      `Vehicle ${state.vehicleId} is servicing but reports edgeIndexInLeg ${String(state.edgeIndexInLeg)}, currentEdgeId ${String(state.currentEdgeId)}`,
    );
  }

  const historyProblem = checkHistory(route, state, {
    completedEdgeIds: edgesOfLegs(route.legs, legIndex + 1),
    completedLegCount: legIndex + 1,
    servedLegCount: legIndex,
  });
  if (historyProblem !== null) {
    return inconsistent(historyProblem);
  }

  return buildCommitment(
    route,
    state,
    null,
    firstEdgeFromLeg(route.legs, legIndex + 1),
  );
}

function resolveCompleted(
  route: ExpandedRoute,
  state: VehicleSimulationState,
): RouteCommitmentResult {
  if (
    state.legIndex !== route.legs.length ||
    state.edgeIndexInLeg !== 0 ||
    state.currentEdgeId !== null
  ) {
    return inconsistent(
      `Vehicle ${state.vehicleId} is completed but reports legIndex ${String(state.legIndex)} (expected ${String(route.legs.length)}), edgeIndexInLeg ${String(state.edgeIndexInLeg)}, currentEdgeId ${String(state.currentEdgeId)}`,
    );
  }

  const historyProblem = checkHistory(route, state, {
    completedEdgeIds: edgesOfLegs(route.legs, route.legs.length),
    completedLegCount: route.legs.length,
    servedLegCount: route.legs.length,
  });
  if (historyProblem !== null) {
    return inconsistent(historyProblem);
  }

  return buildCommitment(route, state, null, null);
}

interface ExpectedHistory {
  readonly completedEdgeIds: readonly string[];
  /** Legs fully traversed: expected completedLegIndexes is 0..n-1. */
  readonly completedLegCount: number;
  /** Legs whose arrival order has been served. */
  readonly servedLegCount: number;
}

/**
 * Compares the state's append-only history with the exact history the engine
 * must have produced for the reported position. Returns a description of the
 * first discrepancy, or null when the history matches.
 */
function checkHistory(
  route: ExpandedRoute,
  state: VehicleSimulationState,
  expected: ExpectedHistory,
): string | null {
  const expectedLegIndexes = Array.from(
    { length: expected.completedLegCount },
    (_, index) => index,
  );

  const expectedServed: string[] = [];
  for (const leg of route.legs.slice(0, expected.servedLegCount)) {
    if (leg.arrivalOrderId !== null) {
      expectedServed.push(leg.arrivalOrderId);
    }
  }

  return (
    sequenceMismatch(
      "completedEdgeIds",
      state.vehicleId,
      state.completedEdgeIds,
      expected.completedEdgeIds,
    ) ??
    sequenceMismatch(
      "completedLegIndexes",
      state.vehicleId,
      state.completedLegIndexes,
      expectedLegIndexes,
    ) ??
    sequenceMismatch(
      "servedOrderIds",
      state.vehicleId,
      state.servedOrderIds,
      expectedServed,
    )
  );
}

function sequenceMismatch<T extends string | number>(
  field: string,
  vehicleId: string,
  actual: readonly T[],
  expected: readonly T[],
): string | null {
  if (actual.length !== expected.length) {
    return `Vehicle ${vehicleId} ${field} has ${String(actual.length)} entries, expected ${String(expected.length)}`;
  }

  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) {
      return `Vehicle ${vehicleId} ${field}[${String(index)}] is ${String(actual[index])}, expected ${String(expected[index])}`;
    }
  }

  return null;
}

function legAt(route: ExpandedRoute, legIndex: number): RouteLeg | undefined {
  if (!Number.isInteger(legIndex) || legIndex < 0) {
    return undefined;
  }

  return route.legs[legIndex];
}

/** Edges of legs [0, count), concatenated in traversal order. */
function edgesOfLegs(legs: readonly RouteLeg[], count: number): string[] {
  return legs.slice(0, count).flatMap((leg) => [...leg.edgeIds]);
}

/**
 * First edge position at or after `startLeg`, skipping zero-edge legs, or
 * null when no edge remains.
 */
function firstEdgeFromLeg(
  legs: readonly RouteLeg[],
  startLeg: number,
): RouteEdgePosition | null {
  for (let legIndex = startLeg; legIndex < legs.length; legIndex++) {
    const leg = legs[legIndex];
    if (leg !== undefined && leg.edgeIds.length > 0) {
      return { legIndex, edgeIndexInLeg: 0 };
    }
  }

  return null;
}

function buildCommitment(
  route: ExpandedRoute,
  state: VehicleSimulationState,
  inFlight: {
    readonly position: RouteEdgePosition;
    readonly edgeId: string;
  } | null,
  modifiableFrom: RouteEdgePosition | null,
): RouteCommitmentResult {
  return Object.freeze({
    ok: true,
    commitment: Object.freeze({
      routeId: route.routeId,
      vehicleId: route.vehicleId,
      routeVersion: route.version,
      phase: state.phase,
      inFlight:
        inFlight === null
          ? null
          : Object.freeze({
              position: Object.freeze({ ...inFlight.position }),
              edgeId: inFlight.edgeId,
            }),
      modifiableFrom:
        modifiableFrom === null ? null : Object.freeze({ ...modifiableFrom }),
    }),
  });
}

function inconsistent(detail: string): RouteCommitmentResult {
  return commitmentFailure("INCONSISTENT_PROGRESS", detail);
}

function commitmentFailure(
  reason: CommitmentFailureReason,
  detail: string,
): RouteCommitmentResult {
  return Object.freeze({ ok: false, reason, detail });
}

// ---------------------------------------------------------------------------
// input validation and affectedness
// ---------------------------------------------------------------------------

interface ResolvedRoute {
  readonly route: ExpandedRoute;
  readonly commitment: RouteCommitment;
}

type ResolvedInput =
  | { readonly ok: true; readonly entries: readonly ResolvedRoute[] }
  | AffectedEntityFailure;

const NO_ROUTES: readonly [] = Object.freeze([] as const);

/**
 * Validates the whole input in a fixed phase order, then resolves every
 * commitment with routes sorted by (vehicleId, routeId). Within a phase the
 * smallest offending ID is reported, so the outcome never depends on the
 * order the caller listed routes or states.
 */
function resolveInput(input: RouteProgressInput): ResolvedInput {
  const stateByVehicleId = new Map<string, VehicleSimulationState>();
  const duplicateStateVehicleIds = new Set<string>();
  for (const state of input.vehicleStates) {
    if (stateByVehicleId.has(state.vehicleId)) {
      duplicateStateVehicleIds.add(state.vehicleId);
    } else {
      stateByVehicleId.set(state.vehicleId, state);
    }
  }

  const duplicateStateVehicleId = smallest(duplicateStateVehicleIds);
  if (duplicateStateVehicleId !== undefined) {
    return failure(
      "DUPLICATE_VEHICLE",
      `More than one vehicle state for vehicle ${duplicateStateVehicleId}`,
    );
  }

  const seenRouteIds = new Set<string>();
  const duplicateRouteIds = new Set<string>();
  const routeCountByVehicleId = new Map<string, number>();
  for (const route of input.routes) {
    if (seenRouteIds.has(route.routeId)) {
      duplicateRouteIds.add(route.routeId);
    }
    seenRouteIds.add(route.routeId);
    routeCountByVehicleId.set(
      route.vehicleId,
      (routeCountByVehicleId.get(route.vehicleId) ?? 0) + 1,
    );
  }

  const duplicateRouteId = smallest(duplicateRouteIds);
  if (duplicateRouteId !== undefined) {
    return failure(
      "DUPLICATE_ROUTE_ID",
      `More than one route with ID ${duplicateRouteId}`,
    );
  }

  const ambiguousVehicleId = smallest(
    [...routeCountByVehicleId]
      .filter(([, count]) => count > 1)
      .map(([vehicleId]) => vehicleId),
  );
  if (ambiguousVehicleId !== undefined) {
    return failure(
      "AMBIGUOUS_VEHICLE_ROUTE",
      `Vehicle ${ambiguousVehicleId} has more than one committed route`,
    );
  }

  const missingStateVehicleId = smallest(
    [...routeCountByVehicleId.keys()].filter(
      (vehicleId) => !stateByVehicleId.has(vehicleId),
    ),
  );
  if (missingStateVehicleId !== undefined) {
    return failure(
      "VEHICLE_STATE_MISSING",
      `No vehicle state for vehicle ${missingStateVehicleId}, which has a committed route`,
    );
  }

  const unexpectedStateVehicleId = smallest(
    [...stateByVehicleId.keys()].filter(
      (vehicleId) => !routeCountByVehicleId.has(vehicleId),
    ),
  );
  if (unexpectedStateVehicleId !== undefined) {
    return failure(
      "UNEXPECTED_VEHICLE_STATE",
      `Vehicle ${unexpectedStateVehicleId} has a state but no committed route`,
    );
  }

  const sortedRoutes = [...input.routes].sort((a, b) => {
    const byVehicle = compareIds(a.vehicleId, b.vehicleId);
    return byVehicle !== 0 ? byVehicle : compareIds(a.routeId, b.routeId);
  });

  const entries: ResolvedRoute[] = [];
  for (const route of sortedRoutes) {
    const state = stateByVehicleId.get(route.vehicleId);
    if (state === undefined) {
      // Unreachable: the missing-state phase above rejects this.
      return failure(
        "VEHICLE_STATE_MISSING",
        `No vehicle state for vehicle ${route.vehicleId}`,
      );
    }

    const resolved = resolveRouteCommitment(route, state);
    if (!resolved.ok) {
      return failure(resolved.reason, resolved.detail);
    }

    entries.push({ route, commitment: resolved.commitment });
  }

  return { ok: true, entries };
}

function collectAffected(
  entries: readonly ResolvedRoute[],
  edgeId: string,
  impact: AffectedRoute["impact"],
): readonly AffectedRoute[] {
  const affected: AffectedRoute[] = [];

  for (const entry of entries) {
    const result = findAffectedRoute(entry, edgeId, impact);
    if (result !== null) {
      affected.push(result);
    }
  }

  // `entries` is already sorted by (vehicleId, routeId).
  return Object.freeze(affected);
}

/**
 * Scans the route in order. An occurrence counts only inside the modifiable
 * suffix. The in-flight occurrence is recorded in `inFlightOnEdge` but never
 * makes the route affected on its own; completed occurrences are ignored.
 */
function findAffectedRoute(
  entry: ResolvedRoute,
  edgeId: string,
  impact: AffectedRoute["impact"],
): AffectedRoute | null {
  const { route, commitment } = entry;
  const occurrences: RouteEdgePosition[] = [];
  let inFlightOnEdge = false;

  for (const [legIndex, leg] of route.legs.entries()) {
    for (const [edgeIndexInLeg, candidate] of leg.edgeIds.entries()) {
      if (candidate !== edgeId) {
        continue;
      }

      const position = { legIndex, edgeIndexInLeg };

      if (
        commitment.inFlight !== null &&
        comparePositions(position, commitment.inFlight.position) === 0
      ) {
        inFlightOnEdge = true;
        continue;
      }

      if (
        commitment.modifiableFrom !== null &&
        comparePositions(position, commitment.modifiableFrom) >= 0
      ) {
        occurrences.push(Object.freeze(position));
      }
    }
  }

  if (occurrences.length === 0) {
    return null;
  }

  return Object.freeze({
    routeId: route.routeId,
    vehicleId: route.vehicleId,
    routeVersion: route.version,
    impact,
    occurrences: Object.freeze(occurrences),
    inFlightOnEdge,
  });
}

function comparePositions(a: RouteEdgePosition, b: RouteEdgePosition): number {
  return a.legIndex !== b.legIndex
    ? a.legIndex - b.legIndex
    : a.edgeIndexInLeg - b.edgeIndexInLeg;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function smallest(ids: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const id of ids) {
    if (best === undefined || compareIds(id, best) < 0) {
      best = id;
    }
  }

  return best;
}

function failure(
  reason: AffectedEntityFailureReason,
  detail: string,
): AffectedEntityFailure {
  return Object.freeze({ ok: false, reason, detail });
}

/**
 * Compile-time exhaustiveness guard for the switch in identifyAffectedEntities.
 * At runtime it returns a structured failure for the deferred event types
 * (order_cancelled, vehicle_broken_down) and for any malformed event.
 */
function unsupportedEvent(event: never): AffectedEntityFailure {
  const type = (event as { readonly type?: unknown }).type;
  return failure(
    "UNSUPPORTED_EVENT_TYPE",
    `Affected-entity identification does not support event type: ${String(type)}`,
  );
}