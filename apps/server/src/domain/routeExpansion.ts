import type { RoadGraph } from "./RoadGraph.js";
import type { Order, Route } from "./types.js";
import { shortestPath } from "./shortestPath.js";

/**
 * A Route stores order IDs and sequence numbers, not graph paths. Expansion
 * turns it into the concrete traversal the simulator executes:
 *
 *   depot -> stop[0] -> ... -> stop[n - 1] -> depot
 *
 * Each leg is resolved with the existing directed Dijkstra implementation
 * (`shortestPath`). No alternative routing logic exists here, and Route is
 * left untouched.
 *
 * Stops are read in ARRAY order, not re-sorted by sequenceNo: constraint 10 of
 * checkRouteFeasibility already guarantees array order equals ascending
 * contiguous sequence numbers, and silently re-sorting would hide exactly the
 * violation that gate exists to catch.
 */
export type RouteLegKind = "depot_to_stop" | "stop_to_stop" | "stop_to_depot";

export interface RouteLeg {
  readonly legIndex: number;
  readonly kind: RouteLegKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;

  /** The order served on arrival, or null for the final return to the depot. */
  readonly arrivalOrderId: string | null;
  readonly arrivalSequenceNo: number | null;

  /** Edge IDs in traversal order. Empty when both endpoints are the same node. */
  readonly edgeIds: readonly string[];

  /** Sum of the traversed edges' currentWeight, i.e. the leg's travel time. */
  readonly duration: number;
}

export interface ExpandedRoute {
  readonly routeId: string;
  readonly vehicleId: string;
  readonly version: number;
  readonly depotNodeId: string;
  readonly legs: readonly RouteLeg[];
  readonly totalTravelTime: number;
}

export type RouteExpansionFailureReason =
  | "UNKNOWN_ORDER"
  | "ORDER_NODE_NOT_IN_GRAPH"
  | "UNREACHABLE_LEG";

export type RouteExpansionResult =
  | { readonly ok: true; readonly expanded: ExpandedRoute }
  | {
      readonly ok: false;
      readonly reason: RouteExpansionFailureReason;
      readonly detail: string;
    };

/**
 * Expands one route into its leg-by-leg graph traversal.
 *
 * Precondition: `depotNodeId` exists in `graph`. The caller (SimulationEngine)
 * validates this before expansion; violating it propagates shortestPath's own
 * "Unknown source node ID" error.
 *
 * A route with no stops expands to zero legs — such a vehicle never leaves the
 * depot and completes immediately.
 */
export function expandRoute(
  route: Route,
  orders: ReadonlyMap<string, Order>,
  depotNodeId: string,
  graph: RoadGraph,
): RouteExpansionResult {
  if (route.stops.length === 0) {
    return {
      ok: true,
      expanded: Object.freeze({
        routeId: route.id,
        vehicleId: route.vehicleId,
        version: route.version,
        depotNodeId,
        legs: Object.freeze([]),
        totalTravelTime: 0,
      }),
    };
  }

  const stopNodeIds: string[] = [];

  for (const stop of route.stops) {
    const order = orders.get(stop.orderId);

    if (order === undefined) {
      return {
        ok: false,
        reason: "UNKNOWN_ORDER",
        detail: `Order ${stop.orderId} referenced by route ${route.id} does not exist`,
      };
    }

    if (!graph.hasNode(order.nodeId)) {
      return {
        ok: false,
        reason: "ORDER_NODE_NOT_IN_GRAPH",
        detail: `Order node ${order.nodeId} for order ${order.id} does not exist in graph`,
      };
    }

    stopNodeIds.push(order.nodeId);
  }

  const nodeSequence = [depotNodeId, ...stopNodeIds, depotNodeId];
  const legs: RouteLeg[] = [];
  let totalTravelTime = 0;

  for (let legIndex = 0; legIndex < nodeSequence.length - 1; legIndex++) {
    const fromNodeId = nodeSequence[legIndex];
    const toNodeId = nodeSequence[legIndex + 1];

    if (fromNodeId === undefined || toNodeId === undefined) {
      return {
        ok: false,
        reason: "UNREACHABLE_LEG",
        detail: `Route ${route.id} has a malformed leg at index ${legIndex}`,
      };
    }

    const path = shortestPath(graph, fromNodeId, toNodeId);

    if (!path.reachable) {
      return {
        ok: false,
        reason: "UNREACHABLE_LEG",
        detail: `Route ${route.id} leg ${legIndex} cannot travel from ${fromNodeId} to ${toNodeId}`,
      };
    }

    const isFirstLeg = legIndex === 0;
    const isLastLeg = legIndex === nodeSequence.length - 2;
    const arrivalStop = isLastLeg ? undefined : route.stops[legIndex];

    legs.push(
      Object.freeze({
        legIndex,
        kind: legKind(isFirstLeg, isLastLeg),
        fromNodeId,
        toNodeId,
        arrivalOrderId: arrivalStop?.orderId ?? null,
        arrivalSequenceNo: arrivalStop?.sequenceNo ?? null,
        edgeIds: Object.freeze([...path.edgePath]),
        duration: path.distance,
      }),
    );

    totalTravelTime += path.distance;
  }

  return {
    ok: true,
    expanded: Object.freeze({
      routeId: route.id,
      vehicleId: route.vehicleId,
      version: route.version,
      depotNodeId,
      legs: Object.freeze(legs),
      totalTravelTime,
    }),
  };
}

function legKind(isFirstLeg: boolean, isLastLeg: boolean): RouteLegKind {
  if (isLastLeg) {
    return "stop_to_depot";
  }

  return isFirstLeg ? "depot_to_stop" : "stop_to_stop";
}