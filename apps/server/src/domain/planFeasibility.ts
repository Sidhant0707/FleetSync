import type { Depot, Order, Route, Vehicle } from "./types.js";
import type { RoadGraph } from "./RoadGraph.js";
import {
  checkRouteFeasibility,
  type FeasibilityResult,
} from "./feasibility.js";

/**
 * Order statuses excluded from duplicate-assignment reporting because they
 * are explicitly non-assignable by the current route-level policy.
 *
 * "unreachable" is intentionally NOT excluded: being unreachable and being
 * assigned to multiple routes are independent correctness violations.
 *
 * "delivered" is also intentionally NOT excluded because the current domain
 * policy does not yet define it as non-assignable.
 */
const STATUSES_EXCLUDED_FROM_DUPLICATE_CHECK: ReadonlySet<Order["status"]> =
  new Set(["cancelled"]);

/**
 * Validates a complete FleetSync routing plan.
 *
 * Route-level constraints are delegated to checkRouteFeasibility().
 * This module adds the single plan-level constraint that an order must not
 * appear in more than one distinct route.
 *
 * Unassigned orders are allowed.
 *
 * No mutation is performed on the supplied routes, vehicles, orders, depots,
 * or graph.
 */
export function checkPlanFeasibility(
  routes: readonly Route[],
  vehicles: Map<string, Vehicle>,
  orders: Map<string, Order>,
  depots: Map<string, Depot>,
  graph: RoadGraph,
): FeasibilityResult {
  const routeLevelViolations: string[] = [];

  // Maps each order ID to the distinct route IDs in which it appears.
  const routeIdsByOrderId = new Map<string, string[]>();

  for (const route of routes) {
    const routeResult = checkRouteFeasibility(
      route,
      vehicles,
      orders,
      depots,
      graph,
    );

    routeLevelViolations.push(...routeResult.violations);

    // Repetition within one route is the responsibility of
    // checkRouteFeasibility(). Count this route only once for plan-level
    // duplicate detection.
    const distinctOrderIdsInRoute = new Set<string>();

    for (const stop of route.stops) {
      distinctOrderIdsInRoute.add(stop.orderId);
    }

    for (const orderId of distinctOrderIdsInRoute) {
      const existingRouteIds = routeIdsByOrderId.get(orderId);

      if (existingRouteIds === undefined) {
        routeIdsByOrderId.set(orderId, [route.id]);
      } else if (!existingRouteIds.includes(route.id)) {
        // A route ID should normally be unique, but avoid counting the same
        // route twice if malformed input contains duplicate Route objects
        // with the same id.
        existingRouteIds.push(route.id);
      }
    }
  }

  // Sort order IDs so plan-level violations are deterministic.
  const duplicatedOrderIds = [...routeIdsByOrderId.entries()]
    .filter(([, routeIds]) => routeIds.length >= 2)
    .map(([orderId]) => orderId)
    .sort();

  const planLevelViolations: string[] = [];

  for (const orderId of duplicatedOrderIds) {
    const order = orders.get(orderId);

    // Unknown orders are already reported by checkRouteFeasibility().
    // Their status cannot be evaluated here.
    if (order === undefined) {
      continue;
    }

    if (STATUSES_EXCLUDED_FROM_DUPLICATE_CHECK.has(order.status)) {
      continue;
    }

    // Sort route IDs too, so the message is deterministic even when the
    // caller supplies routes in a different order.
    const routeIds = [...routeIdsByOrderId.get(orderId)!].sort();

    planLevelViolations.push(
      `Order ${orderId} is assigned to multiple routes: ${routeIds.join(", ")}`,
    );
  }

  const violations = [...routeLevelViolations, ...planLevelViolations];

  return {
    feasible: violations.length === 0,
    violations: Object.freeze(violations),
  };
}