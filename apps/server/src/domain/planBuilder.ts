import type { RoadGraph } from "./RoadGraph.js";
import type {
  Depot,
  Order,
  Route,
  Vehicle,
} from "./types.js";
import type { FeasibilityResult } from "./feasibility.js";
import {
  buildCostMatrix,
  getCost,
} from "./travelCost.js";
import { runClarkeWright } from "./clarkeWright.js";
import {
  assignVehiclesDeterministic,
} from "./vehicleAssignment.js";
import {
  checkPlanFeasibility,
} from "./planFeasibility.js";

export type UnassignedReason =
  | "CANCELLED"
  | "UNREACHABLE"
  | "DEMAND_EXCEEDS_CAPACITY"
  | "NO_VEHICLE_AVAILABLE";

export interface UnassignedOrder {
  readonly orderId: string;
  readonly reason: UnassignedReason;
}

export interface StaticPlanResult {
  readonly routes: readonly Route[];
  readonly unassigned: readonly UnassignedOrder[];
  readonly feasibility: FeasibilityResult;
}

/**
 * Builds the first complete static FleetSync routing plan.
 *
 * Pipeline:
 *
 * eligible vehicles
 * -> cancelled/pending split
 * -> capacity filter
 * -> directed cost matrix
 * -> reachability filter
 * -> Clarke-Wright
 * -> deterministic vehicle assignment
 * -> Route construction
 * -> final plan feasibility validation
 *
 * Unassigned orders are a valid outcome.
 *
 * This milestone does not implement:
 * - 2-opt
 * - Or-opt
 * - dynamic re-optimization
 * - time-window optimization
 * - heterogeneous vehicle capacities
 * - API/database/WebSocket logic
 */
export function buildStaticPlan(
  graph: RoadGraph,
  depot: Depot,
  orders: readonly Order[],
  vehicles: readonly Vehicle[],
): StaticPlanResult {
  const unassigned: UnassignedOrder[] = [];

  /*
   * Step 1: identify vehicles that can participate in this static plan.
   */
  const eligibleVehicles = vehicles
    .filter(
      (vehicle) =>
        vehicle.depotId === depot.id &&
        vehicle.status === "idle",
    )
    .slice()
    .sort((a, b) => compareIds(a.id, b.id));

  /*
   * Step 2: cancelled orders are explicitly reported as unassigned and never
   * enter the planning pipeline.
   */
  for (const order of orders) {
    if (order.status === "cancelled") {
      unassigned.push({
        orderId: order.id,
        reason: "CANCELLED",
      });
    }
  }

  /*
   * Step 3: only pending orders are considered by this static planner.
   */
  const pendingOrders = orders
    .filter((order) => order.status === "pending")
    .slice()
    .sort((a, b) => compareIds(a.id, b.id));

  /*
   * These maps intentionally contain the COMPLETE original input universe.
   * checkPlanFeasibility() must see the original entities, not only filtered
   * working subsets.
   */
  const {
    vehiclesMap,
    ordersMap,
    depotsMap,
  } = buildLookupMaps(
    vehicles,
    orders,
    depot,
  );

  /*
   * Step 4: if no eligible vehicles exist, all pending orders are unassigned.
   * We still run the final feasibility gate against the empty route set.
   */
  if (eligibleVehicles.length === 0) {
    for (const order of pendingOrders) {
      unassigned.push({
        orderId: order.id,
        reason: "NO_VEHICLE_AVAILABLE",
      });
    }

    const feasibility = checkPlanFeasibility(
      [],
      vehiclesMap,
      ordersMap,
      depotsMap,
      graph,
    );

    return {
      routes: Object.freeze([]),
      unassigned: Object.freeze(
        sortUnassigned(unassigned),
      ),
      feasibility,
    };
  }

  /*
   * Step 5: FleetSync assumes homogeneous capacity among eligible vehicles.
   */
  const commonCapacity = eligibleVehicles[0]!.capacity;

  /*
   * Reject invalid fleet configuration before doing any optimization work.
   */
  if (
    !Number.isFinite(commonCapacity) ||
    commonCapacity < 0
  ) {
    throw new Error(
      "FleetSync requires a finite non-negative vehicle capacity",
    );
  }

  for (const vehicle of eligibleVehicles) {
    if (vehicle.capacity !== commonCapacity) {
      throw new Error(
        "FleetSync requires homogeneous vehicle capacity",
      );
    }
  }

  /*
   * Step 6: an order exceeding one vehicle's capacity can never be served
   * by this homogeneous fleet.
   */
  const capacityFilteredOrders: Order[] = [];

  for (const order of pendingOrders) {
    if (order.demand > commonCapacity) {
      unassigned.push({
        orderId: order.id,
        reason: "DEMAND_EXCEEDS_CAPACITY",
      });
    } else {
      capacityFilteredOrders.push(order);
    }
  }

  /*
   * Step 7: build the exact node set needed by this planning run.
   * Duplicate order node IDs are harmless and are removed here.
   */
  const nodeIds = [
    ...new Set([
      depot.nodeId,
      ...capacityFilteredOrders.map(
        (order) => order.nodeId,
      ),
    ]),
  ];

  /*
   * Step 8: build the directed pairwise cost matrix through the existing
   * travel-cost layer. Dijkstra is not called directly here.
   */
  const costs = buildCostMatrix({
    graph,
    nodeIds,
  });

  /*
   * Step 9: an order must be reachable in both directions to form a valid
   * depot -> order -> depot solo route.
   */
  const reachableOrders: Order[] = [];

  for (const order of capacityFilteredOrders) {
    const outbound = getCost(
      costs,
      depot.nodeId,
      order.nodeId,
    );

    const inbound = getCost(
      costs,
      order.nodeId,
      depot.nodeId,
    );

    if (
      outbound === null ||
      inbound === null
    ) {
      unassigned.push({
        orderId: order.id,
        reason: "UNREACHABLE",
      });
    } else {
      reachableOrders.push(order);
    }
  }

  /*
   * Step 10: construct the initial routes with directed Clarke-Wright.
   */
  const { chains } = runClarkeWright({
    depotNodeId: depot.nodeId,
    orders: reachableOrders,
    vehicleCapacity: commonCapacity,
    costs,
  });

  /*
   * Step 11: deterministically assign chains to eligible vehicles.
   */
  const {
    assigned,
    unassignedChains,
  } = assignVehiclesDeterministic({
    chains,
    vehicleIds: eligibleVehicles.map(
      (vehicle) => vehicle.id,
    ),
  });

  /*
   * Step 12: every order belonging to a chain without a vehicle remains
   * unassigned.
   */
  for (const chain of unassignedChains) {
    for (const stop of chain.stops) {
      unassigned.push({
        orderId: stop.id,
        reason: "NO_VEHICLE_AVAILABLE",
      });
    }
  }

  /*
   * Step 13: convert each assigned chain into the existing Route shape.
   *
   * Route sequence numbers are intentionally 1-based.
   */
  const routes: Route[] = assigned.map(
    ({ vehicleId, chain }) => ({
      id: `route-${vehicleId}`,
      vehicleId,
      version: 1,
      stops: Object.freeze(
        chain.stops.map((stop, index) => ({
          orderId: stop.id,
          sequenceNo: index + 1,
        })),
      ),
    }),
  );

  /*
   * Step 15: final authoritative feasibility gate.
   *
   * No alternative validation result is substituted here.
   */
  const feasibility = checkPlanFeasibility(
    routes,
    vehiclesMap,
    ordersMap,
    depotsMap,
    graph,
  );

  /*
   * Step 16: return deterministic output.
   */
  return {
    routes: Object.freeze(routes),
    unassigned: Object.freeze(
      sortUnassigned(unassigned),
    ),
    feasibility,
  };
}

/**
 * Builds complete lookup maps from the ORIGINAL input collections.
 */
function buildLookupMaps(
  vehicles: readonly Vehicle[],
  orders: readonly Order[],
  depot: Depot,
): {
  vehiclesMap: Map<string, Vehicle>;
  ordersMap: Map<string, Order>;
  depotsMap: Map<string, Depot>;
} {
  const vehiclesMap = new Map<string, Vehicle>();

  for (const vehicle of vehicles) {
    vehiclesMap.set(vehicle.id, vehicle);
  }

  const ordersMap = new Map<string, Order>();

  for (const order of orders) {
    ordersMap.set(order.id, order);
  }

  const depotsMap = new Map<string, Depot>([
    [depot.id, depot],
  ]);

  return {
    vehiclesMap,
    ordersMap,
    depotsMap,
  };
}

function sortUnassigned(
  unassignedOrders: readonly UnassignedOrder[],
): UnassignedOrder[] {
  return [...unassignedOrders].sort(
    (a, b) => compareIds(a.orderId, b.orderId),
  );
}

function compareIds(
  a: string,
  b: string,
): number {
  return a < b ? -1 : a > b ? 1 : 0;
}