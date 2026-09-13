import type { Depot, Order, Route, RouteStop, Vehicle } from "./types.js";
import { RoadGraph } from "./RoadGraph.js";

export interface FeasibilityResult {
  readonly feasible: boolean;
  readonly violations: readonly string[];
}

/**
 * Validates whether a Route is structurally and operationally feasible for FleetSync.
 *
 * Hard constraints checked:
 * 1. Vehicle exists and is not broken_down
 * 2. Route references that vehicle
 * 3. Vehicle capacity must be a non-negative, finite number
 * 4. Every order in the route exists
 * 5. No cancelled order may be assigned
 * 6. No unreachable order may be assigned — per the FleetSync invariant that
 *    unreachable orders are not assigned until they become assignable again
 *    (all other order statuses remain unrestricted; whether e.g. "delivered"
 *    orders should be assignable is a domain-policy decision this function
 *    does not invent)
 * 7. No order may appear more than once in the route
 * 8. Every order's demand must be a non-negative, finite number
 * 9. Total demand of assigned orders <= vehicle capacity
 * 10. Stop sequence numbers must be positive integers, unique, contiguous
 *     starting at 1, and listed in ascending order — i.e. the declared
 *     sequenceNo must match the array order actually used for the traversal
 *     checked by constraint 11
 * 11. Every order node must be reachable from the depot, consecutive stops
 *     must be reachable from one another, and the route must be able to
 *     return to the depot, all using currently open graph edges
 * 12. Route version must be a positive integer
 */
export function checkRouteFeasibility(
  route: Route,
  vehicles: Map<string, Vehicle>,
  orders: Map<string, Order>,
  depots: Map<string, Depot>,
  graph: RoadGraph,
): FeasibilityResult {
  const violations: string[] = [];

  // Constraint 12: Route version must be a positive integer
  if (!Number.isInteger(route.version) || route.version <= 0) {
    violations.push(
      `Route version must be a positive integer, got ${route.version}`,
    );
    // Early return since we can't proceed without a valid route structure
    return { feasible: false, violations };
  }

  // Constraint 1: Vehicle exists and is not broken_down
  const vehicle = vehicles.get(route.vehicleId);
  if (!vehicle) {
    violations.push(`Vehicle ${route.vehicleId} does not exist`);
    return { feasible: false, violations };
  }

  if (vehicle.status === "broken_down") {
    violations.push(
      `Vehicle ${route.vehicleId} is broken_down and cannot perform routes`,
    );
    return { feasible: false, violations };
  }

  // Constraint 2: Route references that vehicle (already validated by constraint 1)

  // Constraint 3: Vehicle capacity must be a sane, non-negative finite number.
  // Guard this before summing demand below so a corrupt capacity (NaN,
  // negative, Infinity) can't silently swallow an over-capacity route.
  const capacityIsValid =
    Number.isFinite(vehicle.capacity) && vehicle.capacity >= 0;
  if (!capacityIsValid) {
    violations.push(
      `Vehicle ${route.vehicleId} has an invalid capacity ${vehicle.capacity}; capacity must be a non-negative finite number`,
    );
  }

  // Constraint 10: Stop sequence numbers must be well-formed and consistent
  // with the array order used for the traversal checks below.
  violations.push(...validateStopSequencing(route.stops));

  // Constraints 4, 5, 6, 7 & 8: every order exists, no cancelled orders, no
  // unreachable orders, no duplicates, and every demand value is sane
  const orderIds = new Set<string>();
  let totalDemand = 0;

  for (const stop of route.stops) {
    const order = orders.get(stop.orderId);

    // Constraint 4: Every order in the route exists
    if (!order) {
      violations.push(`Order ${stop.orderId} referenced in route does not exist`);
      continue;
    }

    // Constraint 5: No cancelled order may be assigned
    if (order.status === "cancelled") {
      violations.push(
        `Order ${stop.orderId} is cancelled and cannot be assigned to a route`,
      );
    }

    // Constraint 6: No unreachable order may be assigned. FleetSync invariant:
    // unreachable orders are not assigned until they become assignable again.
    if (order.status === "unreachable") {
      violations.push(
        `Order ${stop.orderId} is unreachable and cannot be assigned to a route`,
      );
    }

    // Constraint 7: No order may appear more than once in the route
    if (orderIds.has(stop.orderId)) {
      violations.push(
        `Order ${stop.orderId} appears multiple times in the route`,
      );
      continue;
    }
    orderIds.add(stop.orderId);

    // Constraint 8: Demand must be a sane, non-negative finite number. A
    // corrupt demand (NaN, negative, Infinity) is reported directly instead
    // of being folded into totalDemand, where it could hide the real total
    // (e.g. NaN would make every ">" capacity comparison silently false).
    if (!Number.isFinite(order.demand) || order.demand < 0) {
      violations.push(
        `Order ${stop.orderId} has an invalid demand ${order.demand}; demand must be a non-negative finite number`,
      );
      continue;
    }
    totalDemand += order.demand;
  }

  // Constraint 9: Total demand of assigned orders <= vehicle capacity.
  // Skipped when capacity itself is invalid (constraint 3 already reported
  // that; comparing against a NaN/negative capacity wouldn't mean anything).
  if (capacityIsValid && totalDemand > vehicle.capacity) {
    violations.push(
      `Total demand ${totalDemand} exceeds vehicle capacity ${vehicle.capacity}`,
    );
  }

  // Constraint 11: Every order node must be reachable from the depot and the
  // route must be able to return to the depot
  const depot = depots.get(vehicle.depotId);
  if (!depot) {
    violations.push(
      `Depot ${vehicle.depotId} for vehicle ${route.vehicleId} does not exist`,
    );
    return { feasible: false, violations };
  }

  if (!graph.hasNode(depot.nodeId)) {
    violations.push(
      `Depot node ${depot.nodeId} for depot ${vehicle.depotId} does not exist in graph`,
    );
    return { feasible: false, violations };
  }

  if (route.stops.length > 0) {
    // Tracks which orders have already had a "node does not exist in graph"
    // violation reported. Without this, an order that sits at the boundary
    // between two checks (e.g. the last stop, which is validated both as the
    // final leg of the consecutive-stop loop and again as "last order") would
    // have the exact same violation message pushed twice.
    const reportedMissingNodeOrderIds = new Set<string>();

    const nodeExists = (order: Order): boolean => {
      if (graph.hasNode(order.nodeId)) {
        return true;
      }
      if (!reportedMissingNodeOrderIds.has(order.id)) {
        reportedMissingNodeOrderIds.add(order.id);
        violations.push(
          `Order node ${order.nodeId} for order ${order.id} does not exist in graph`,
        );
      }
      return false;
    };

    // Check reachability from depot to first stop
    const firstStop = route.stops[0];
    const firstOrder = firstStop ? orders.get(firstStop.orderId) : undefined;
    if (firstOrder && nodeExists(firstOrder)) {
      if (!canReachWithOpenEdges(graph, depot.nodeId, firstOrder.nodeId)) {
        violations.push(
          `Cannot reach first order node ${firstOrder.nodeId} from depot node ${depot.nodeId} using open edges`,
        );
      }
    }

    // Check reachability between consecutive stops
    for (let i = 0; i < route.stops.length - 1; i++) {
      const currentStop = route.stops[i];
      const nextStop = route.stops[i + 1];
      const currentOrder = currentStop ? orders.get(currentStop.orderId) : undefined;
      const nextOrder = nextStop ? orders.get(nextStop.orderId) : undefined;

      if (currentOrder && nextOrder && nodeExists(nextOrder)) {
        if (!canReachWithOpenEdges(graph, currentOrder.nodeId, nextOrder.nodeId)) {
          violations.push(
            `Cannot reach order node ${nextOrder.nodeId} from order node ${currentOrder.nodeId} using open edges`,
          );
        }
      }
    }

    // Check reachability from last stop back to depot
    const lastStop = route.stops[route.stops.length - 1];
    const lastOrder = lastStop ? orders.get(lastStop.orderId) : undefined;
    if (lastOrder && nodeExists(lastOrder)) {
      if (!canReachWithOpenEdges(graph, lastOrder.nodeId, depot.nodeId)) {
        violations.push(
          `Cannot return from last order node ${lastOrder.nodeId} to depot node ${depot.nodeId} using open edges`,
        );
      }
    }
  }

  return {
    feasible: violations.length === 0,
    violations: Object.freeze(violations),
  };
}

/**
 * Validates that a route's declared stop sequence numbers are internally
 * consistent, instead of trusting array position alone:
 *  - each sequenceNo must be a positive integer
 *  - no two stops may share the same sequenceNo
 *  - sequenceNo values must be contiguous, starting at 1 (no gaps)
 *  - stops must be listed in ascending sequenceNo order, so the array order
 *    that reachability checks actually traverse matches the declared intent
 */
function validateStopSequencing(stops: readonly RouteStop[]): string[] {
  const violations: string[] = [];
  if (stops.length === 0) {
    return violations;
  }

  const firstStopIdBySequenceNo = new Map<number, string>();
  let hasMalformedSequenceNo = false;

  for (const stop of stops) {
    const { sequenceNo, orderId } = stop;
    if (!Number.isInteger(sequenceNo) || sequenceNo <= 0) {
      violations.push(
        `Stop for order ${orderId} has an invalid sequence number, expected a positive integer but got ${sequenceNo}`,
      );
      hasMalformedSequenceNo = true;
      continue;
    }

    const existingOrderId = firstStopIdBySequenceNo.get(sequenceNo);
    if (existingOrderId !== undefined) {
      violations.push(
        `Sequence number ${sequenceNo} is used by more than one stop (orders ${existingOrderId} and ${orderId})`,
      );
    } else {
      firstStopIdBySequenceNo.set(sequenceNo, orderId);
    }
  }

  // Gaps and ordering are only meaningful once every sequenceNo is at least
  // structurally valid; a malformed value already has its own violation above.
  if (hasMalformedSequenceNo) {
    return violations;
  }

  const uniqueSequenceNos = [...firstStopIdBySequenceNo.keys()].sort(
    (a, b) => a - b,
  );
  const isContiguousFromOne =
    uniqueSequenceNos.length === stops.length &&
    uniqueSequenceNos.every((value, index) => value === index + 1);

  if (!isContiguousFromOne) {
    violations.push(
      `Route stop sequence numbers must be contiguous starting at 1 with no gaps; got [${stops
        .map((stop) => stop.sequenceNo)
        .join(", ")}]`,
    );
    return violations;
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const current = stops[i]!;
    const next = stops[i + 1]!;
    if (current.sequenceNo >= next.sequenceNo) {
      violations.push(
        `Route stops are not listed in ascending sequence order: order ${current.orderId} (sequence ${current.sequenceNo}) appears before order ${next.orderId} (sequence ${next.sequenceNo})`,
      );
      break; // one message is enough; further pairs would just restate the same disorder
    }
  }

  return violations;
}

/**
 * Checks if there's a reachable path from source to target using only open edges.
 * Uses BFS with an index-based queue (instead of Array.prototype.shift()) so
 * dequeuing is O(1) rather than O(n), which matters as the graph grows.
 */
function canReachWithOpenEdges(
  graph: RoadGraph,
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) {
    return true;
  }

  const visited = new Set<string>([sourceId]);
  const queue: string[] = [sourceId];
  let head = 0;

  while (head < queue.length) {
    const currentId = queue[head++]!;

    if (currentId === targetId) {
      return true;
    }

    const outgoingEdges = graph.getOutgoingEdges(currentId);
    for (const edge of outgoingEdges) {
      // Only traverse open edges
      if (edge.status === "open" && !visited.has(edge.toNodeId)) {
        visited.add(edge.toNodeId);
        queue.push(edge.toNodeId);
      }
    }
  }

  return false;
}