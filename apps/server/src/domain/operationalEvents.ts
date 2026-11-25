import type { RoadGraph } from "./RoadGraph.js";
import type { Order, RoadEdge, SoftTimeWindow, Vehicle } from "./types.js";

/**
 * Operational events: the entry point of the dynamic pipeline
 *
 *   Operational Event -> Affected-Entity Identification -> Localized Repair
 *   -> Feasibility Validation -> Warm-Started Fallback -> Versioned Update
 *
 * This module only DEFINES events and VALIDATES them. It does not apply them,
 * schedule them, or touch the simulation engine, the graph, orders or
 * vehicles. Applying a valid event is a later milestone.
 *
 * Event timing
 * ------------
 * Every event carries a unique `id` and an explicit `effectiveTime` in
 * SIMULATION time. Wall-clock time never appears here. An event is rejected
 * if its effective time is not finite, is negative, or lies before the
 * context's current simulation time. Equal to the current time is accepted.
 * Ordering of events that share an effective time, and splitting engine
 * advances at an event's effective time, are deliberately NOT decided here;
 * they belong to the engine plan-update milestone.
 *
 * Idempotency and `noOp`
 * ----------------------
 * `noOp: true` means "valid, but applying it would not change the current
 * state". It is never a rejection. The no-op cases are:
 *   - road_closed on an edge that is already closed
 *   - road_reopened on an edge that is already open
 *   - travel_time_changed whose multiplier equals the edge's current one
 *   - order_cancelled for an order that is already cancelled
 *   - vehicle_broken_down for a vehicle that is already broken down
 * A duplicate event ID is always a rejection, never a no-op.
 *
 * Reachability
 * ------------
 * A structurally valid order_created event is accepted even when its node is
 * currently unreachable from the depot. Reachability is a downstream
 * assignment decision (the order becomes `unreachable` and must become
 * assignable again when a path returns); it is not a validation concern.
 *
 * Other decisions
 * ---------------
 *   - order_created with a `window` is rejected (WINDOW_NOT_SUPPORTED): soft
 *     time windows are not implemented, and a field must not be silently
 *     ignored.
 *   - travel_time_changed carries an ABSOLUTE multiplier (finite, > 0) on the
 *     edge's base weight; 1 resets it. On a closed edge it is rejected
 *     (EDGE_CLOSED), because RoadGraph.setTravelTimeMultiplier throws there
 *     and a valid event must never fail on application.
 *   - Cancelling an order in any state other than delivered is valid; what
 *     cancelling an assigned order means for a route is a repair concern.
 *   - vehicle_broken_down is valid for any known vehicle; where the vehicle
 *     is left is a later milestone.
 *
 * Purity
 * ------
 * validateOperationalEvent reads its arguments and returns a fresh frozen
 * result. It calls only RoadGraph.hasNode and RoadGraph.getEdge (both
 * read-only), never mutates the context or the event, and has no clock,
 * randomness or I/O. Same inputs always give the same result. An unexpected
 * error from the graph (anything but "unknown edge") is rethrown, not
 * converted into a rejection.
 */

export const OPERATIONAL_EVENT_TYPES = [
  "road_closed",
  "road_reopened",
  "travel_time_changed",
  "order_created",
  "order_cancelled",
  "vehicle_broken_down",
] as const;

export type OperationalEventType = (typeof OPERATIONAL_EVENT_TYPES)[number];

interface OperationalEventBase {
  /** Unique across all operational events. */
  readonly id: string;
  /** Simulation time at which the event takes effect. */
  readonly effectiveTime: number;
}

export interface RoadClosedEvent extends OperationalEventBase {
  readonly type: "road_closed";
  readonly edgeId: string;
}

export interface RoadReopenedEvent extends OperationalEventBase {
  readonly type: "road_reopened";
  readonly edgeId: string;
}

export interface TravelTimeChangedEvent extends OperationalEventBase {
  readonly type: "travel_time_changed";
  readonly edgeId: string;
  /** Absolute multiplier on the edge's base weight. Finite and > 0. */
  readonly multiplier: number;
}

export interface OrderCreatedEvent extends OperationalEventBase {
  readonly type: "order_created";
  readonly orderId: string;
  readonly nodeId: string;
  readonly demand: number;
  /** Not supported yet: presence is rejected, see module doc. */
  readonly window?: SoftTimeWindow;
}

export interface OrderCancelledEvent extends OperationalEventBase {
  readonly type: "order_cancelled";
  readonly orderId: string;
}

export interface VehicleBrokenDownEvent extends OperationalEventBase {
  readonly type: "vehicle_broken_down";
  readonly vehicleId: string;
}

export type OperationalEvent =
  | RoadClosedEvent
  | RoadReopenedEvent
  | TravelTimeChangedEvent
  | OrderCreatedEvent
  | OrderCancelledEvent
  | VehicleBrokenDownEvent;

/** The only RoadGraph surface validation may use. Both methods are read-only. */
export type OperationalGraphView = Pick<RoadGraph, "hasNode" | "getEdge">;

/**
 * Read-only state a validation decision is made against. The caller owns it;
 * the validator never modifies any part of it, including `seenEventIds`.
 *
 * Precondition: `currentSimTime` is finite and >= 0.
 */
export interface OperationalEventContext {
  readonly graph: OperationalGraphView;
  readonly orders: ReadonlyMap<string, Order>;
  readonly vehicles: ReadonlyMap<string, Vehicle>;
  readonly currentSimTime: number;
  readonly seenEventIds: ReadonlySet<string>;
}

export type OperationalEventRejectionReason =
  | "UNKNOWN_EVENT_TYPE"
  | "INVALID_EVENT_ID"
  | "DUPLICATE_EVENT_ID"
  | "INVALID_EFFECTIVE_TIME"
  | "EFFECTIVE_TIME_IN_PAST"
  | "UNKNOWN_EDGE"
  | "EDGE_CLOSED"
  | "INVALID_MULTIPLIER"
  | "UNKNOWN_ORDER"
  | "DUPLICATE_ORDER_ID"
  | "NODE_NOT_IN_GRAPH"
  | "INVALID_DEMAND"
  | "WINDOW_NOT_SUPPORTED"
  | "ORDER_ALREADY_DELIVERED"
  | "UNKNOWN_VEHICLE";

export type OperationalEventValidationResult =
  | {
      readonly ok: true;
      /** True when the event is valid but would not change current state. */
      readonly noOp: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: OperationalEventRejectionReason;
      readonly detail: string;
    };

export function validateOperationalEvent(
  event: OperationalEvent,
  context: OperationalEventContext,
): OperationalEventValidationResult {
  if (typeof event.id !== "string" || event.id.length === 0) {
    return reject("INVALID_EVENT_ID", "Event ID must be a non-empty string");
  }

  if (context.seenEventIds.has(event.id)) {
    return reject("DUPLICATE_EVENT_ID", `Duplicate event ID: ${event.id}`);
  }

  if (!Number.isFinite(event.effectiveTime) || event.effectiveTime < 0) {
    return reject(
      "INVALID_EFFECTIVE_TIME",
      `Event ${event.id} has invalid effectiveTime: ${String(event.effectiveTime)}`,
    );
  }

  if (event.effectiveTime < context.currentSimTime) {
    return reject(
      "EFFECTIVE_TIME_IN_PAST",
      `Event ${event.id} effectiveTime ${String(event.effectiveTime)} is before current simulation time ${String(context.currentSimTime)}`,
    );
  }

  switch (event.type) {
    case "road_closed":
      return validateRoadClosed(event, context);
    case "road_reopened":
      return validateRoadReopened(event, context);
    case "travel_time_changed":
      return validateTravelTimeChanged(event, context);
    case "order_created":
      return validateOrderCreated(event, context);
    case "order_cancelled":
      return validateOrderCancelled(event, context);
    case "vehicle_broken_down":
      return validateVehicleBrokenDown(event, context);
    default:
      return unknownEventType(event);
  }
}

function validateRoadClosed(
  event: RoadClosedEvent,
  context: OperationalEventContext,
): OperationalEventValidationResult {
  const edge = findEdge(context.graph, event.edgeId);
  if (edge === undefined) {
    return unknownEdge(event.id, event.edgeId);
  }

  return accept(edge.status === "closed");
}

function validateRoadReopened(
  event: RoadReopenedEvent,
  context: OperationalEventContext,
): OperationalEventValidationResult {
  const edge = findEdge(context.graph, event.edgeId);
  if (edge === undefined) {
    return unknownEdge(event.id, event.edgeId);
  }

  return accept(edge.status === "open");
}

function validateTravelTimeChanged(
  event: TravelTimeChangedEvent,
  context: OperationalEventContext,
): OperationalEventValidationResult {
  if (!Number.isFinite(event.multiplier) || event.multiplier <= 0) {
    return reject(
      "INVALID_MULTIPLIER",
      `Event ${event.id} has invalid multiplier: ${String(event.multiplier)}`,
    );
  }

  const edge = findEdge(context.graph, event.edgeId);
  if (edge === undefined) {
    return unknownEdge(event.id, event.edgeId);
  }

  if (edge.status === "closed") {
    return reject(
      "EDGE_CLOSED",
      `Event ${event.id} cannot change travel time of closed edge: ${event.edgeId}`,
    );
  }

  // Same expression RoadGraph.setTravelTimeMultiplier uses, so equality is exact.
  return accept(edge.currentWeight === edge.baseWeight * event.multiplier);
}

function validateOrderCreated(
  event: OrderCreatedEvent,
  context: OperationalEventContext,
): OperationalEventValidationResult {
  if (context.orders.has(event.orderId)) {
    return reject(
      "DUPLICATE_ORDER_ID",
      `Event ${event.id} reuses existing order ID: ${event.orderId}`,
    );
  }

  if (!context.graph.hasNode(event.nodeId)) {
    return reject(
      "NODE_NOT_IN_GRAPH",
      `Event ${event.id} order ${event.orderId} references node not in graph: ${event.nodeId}`,
    );
  }

  if (!Number.isFinite(event.demand) || event.demand <= 0) {
    return reject(
      "INVALID_DEMAND",
      `Event ${event.id} order ${event.orderId} has invalid demand: ${String(event.demand)}`,
    );
  }

  if (event.window !== undefined) {
    return reject(
      "WINDOW_NOT_SUPPORTED",
      `Event ${event.id} order ${event.orderId} sets a time window, which is not supported yet`,
    );
  }

  // No reachability check: an unreachable destination is still a valid order.
  return accept(false);
}

function validateOrderCancelled(
  event: OrderCancelledEvent,
  context: OperationalEventContext,
): OperationalEventValidationResult {
  const order = context.orders.get(event.orderId);
  if (order === undefined) {
    return reject(
      "UNKNOWN_ORDER",
      `Event ${event.id} references unknown order ID: ${event.orderId}`,
    );
  }

  if (order.status === "delivered") {
    return reject(
      "ORDER_ALREADY_DELIVERED",
      `Event ${event.id} cannot cancel delivered order: ${event.orderId}`,
    );
  }

  return accept(order.status === "cancelled");
}

function validateVehicleBrokenDown(
  event: VehicleBrokenDownEvent,
  context: OperationalEventContext,
): OperationalEventValidationResult {
  const vehicle = context.vehicles.get(event.vehicleId);
  if (vehicle === undefined) {
    return reject(
      "UNKNOWN_VEHICLE",
      `Event ${event.id} references unknown vehicle ID: ${event.vehicleId}`,
    );
  }

  return accept(vehicle.status === "broken_down");
}

/**
 * RoadGraph has no hasEdge, so edge existence is probed through getEdge.
 *
 * Assumption (verified against RoadGraph.ts): getEdge has exactly one throw
 * site, #requireEdge, which throws `Error("Unknown edge ID: <edgeId>")`.
 * snapshotEdge only builds and freezes a plain object and cannot throw.
 *
 * Only that exact error is translated to `undefined`. Anything else is a bug
 * or a changed RoadGraph contract and is rethrown rather than masked as
 * "unknown edge". If RoadGraph ever rewords that message, the UNKNOWN_EDGE
 * tests fail loudly instead of the validator misreporting.
 */
function findEdge(
  graph: OperationalGraphView,
  edgeId: string,
): RoadEdge | undefined {
  try {
    return graph.getEdge(edgeId);
  } catch (error) {
    if (error instanceof Error && error.message === `Unknown edge ID: ${edgeId}`) {
      return undefined;
    }

    throw error;
  }
}

function accept(noOp: boolean): OperationalEventValidationResult {
  return Object.freeze({ ok: true, noOp });
}

function reject(
  reason: OperationalEventRejectionReason,
  detail: string,
): OperationalEventValidationResult {
  return Object.freeze({ ok: false, reason, detail });
}

function unknownEdge(
  eventId: string,
  edgeId: string,
): OperationalEventValidationResult {
  return reject(
    "UNKNOWN_EDGE",
    `Event ${eventId} references unknown edge ID: ${edgeId}`,
  );
}

/**
 * Compile-time exhaustiveness guard for the switch above: adding a member to
 * OperationalEvent without handling it makes this call a type error. At
 * runtime it rejects, rather than throws, a malformed event.
 */
function unknownEventType(event: never): OperationalEventValidationResult {
  const type = (event as { readonly type?: unknown }).type;
  return reject("UNKNOWN_EVENT_TYPE", `Unknown event type: ${String(type)}`);
}