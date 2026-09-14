import type { Order } from "./types.js";
import { getCost, type CostLookup } from "./travelCost.js";

/**
 * A candidate route before vehicle assignment.
 *
 * The depot is implicit at both ends:
 *
 * depot -> stops[0] -> ... -> stops[n - 1] -> depot
 */
export interface RouteChain {
  readonly chainId: number;
  readonly stops: readonly Order[];
  readonly totalDemand: number;
  readonly headNodeId: string;
  readonly tailNodeId: string;
}

export interface ClarkeWrightInput {
  readonly depotNodeId: string;

  /**
   * Orders must already be filtered by the caller:
   * - cancelled orders excluded
   * - unreachable orders excluded
   * - demand exceeding vehicle capacity excluded
   */
  readonly orders: readonly Order[];

  readonly vehicleCapacity: number;
  readonly costs: CostLookup;
}

export interface ClarkeWrightResult {
  readonly chains: readonly RouteChain[];
}

interface SavingsEdge {
  readonly fromOrderId: string;
  readonly toOrderId: string;
  readonly savings: number;
}

interface MutableChain {
  readonly chainId: number;
  readonly stops: Order[];
  totalDemand: number;
  headNodeId: string;
  tailNodeId: string;
}

/**
 * Deterministic directed Clarke-Wright savings construction.
 *
 * For an ordered customer pair (i, j):
 *
 *   s(i, j) = c(i, depot) + c(depot, j) - c(i, j)
 *
 * Because the road graph is directed, s(i, j) and s(j, i) are distinct
 * candidates and are evaluated independently.
 *
 * A savings candidate may be applied only when:
 * - i is currently the tail of one chain
 * - j is currently the head of another chain
 * - the chains are distinct
 * - combined demand fits the vehicle capacity
 *
 * Zero/negative savings are never applied because such a merge does not
 * improve the route cost relative to keeping the two chains separate.
 *
 * Time-window penalties are intentionally not considered during construction;
 * time windows are soft and are evaluated elsewhere.
 */
export function runClarkeWright(
  input: ClarkeWrightInput,
): ClarkeWrightResult {
  const {
    depotNodeId,
    orders,
    vehicleCapacity,
    costs,
  } = input;

  if (!Number.isFinite(vehicleCapacity) || vehicleCapacity < 0) {
    throw new Error("Clarke-Wright requires a finite non-negative vehicle capacity");
  }

  const sortedOrders = [...orders].sort((a, b) => compareIds(a.id, b.id));

  const chainsById = new Map<number, MutableChain>();
  const chainIdByOrderId = new Map<string, number>();

  /*
   * Singleton chains are created in deterministic order. Their chainId
   * therefore remains stable across different input array orderings.
   */
  for (const [index, order] of sortedOrders.entries()) {
    if (!Number.isFinite(order.demand) || order.demand < 0) {
      throw new Error(`Invalid demand for order ${order.id}`);
    }

    if (order.demand > vehicleCapacity) {
      throw new Error(
        `Order ${order.id} exceeds Clarke-Wright vehicle capacity`,
      );
    }

    const chain: MutableChain = {
      chainId: index,
      stops: [order],
      totalDemand: order.demand,
      headNodeId: order.nodeId,
      tailNodeId: order.nodeId,
    };

    chainsById.set(chain.chainId, chain);
    chainIdByOrderId.set(order.id, chain.chainId);
  }

  const savingsList = buildSavingsList(
    sortedOrders,
    depotNodeId,
    costs,
  );

  for (const edge of savingsList) {
    /*
     * savingsList is sorted descending. Once the first non-positive saving
     * appears, every remaining candidate is also non-positive.
     */
    if (edge.savings <= 0) {
      break;
    }

    const fromChainId = chainIdByOrderId.get(edge.fromOrderId);
    const toChainId = chainIdByOrderId.get(edge.toOrderId);

    if (
      fromChainId === undefined ||
      toChainId === undefined ||
      fromChainId === toChainId
    ) {
      continue;
    }

    const fromChain = chainsById.get(fromChainId);
    const toChain = chainsById.get(toChainId);

    if (fromChain === undefined || toChain === undefined) {
      continue;
    }

    /*
     * Lazy endpoint validation is important. A customer that was once an
     * endpoint may become an interior stop after an earlier merge.
     */
    const currentTailOrderId =
      fromChain.stops[fromChain.stops.length - 1]?.id;

    const currentHeadOrderId = fromChainId !== toChainId
      ? toChain.stops[0]?.id
      : undefined;

    if (
      currentTailOrderId !== edge.fromOrderId ||
      currentHeadOrderId !== edge.toOrderId
    ) {
      continue;
    }

    if (
      fromChain.totalDemand + toChain.totalDemand >
      vehicleCapacity
    ) {
      continue;
    }

    /*
     * The savings formula already guarantees that i -> j was reachable when
     * this candidate was created. Still, verify the pair exists in the
     * current cost lookup so the merge gate remains explicit.
     */
    const connectingCost = getCost(
      costs,
      fromChain.tailNodeId,
      toChain.headNodeId,
    );

    if (connectingCost === null) {
      continue;
    }

    /*
     * Keep the first chain as the surviving chain. This makes the merge
     * deterministic and preserves the original chainId.
     */
    fromChain.stops.push(...toChain.stops);
    fromChain.totalDemand += toChain.totalDemand;
    fromChain.tailNodeId = toChain.tailNodeId;

    for (const stop of toChain.stops) {
      chainIdByOrderId.set(stop.id, fromChain.chainId);
    }

    chainsById.delete(toChain.chainId);
  }

  const chains = [...chainsById.values()]
    .sort((a, b) => a.chainId - b.chainId)
    .map((chain): RouteChain => ({
      chainId: chain.chainId,
      stops: Object.freeze([...chain.stops]),
      totalDemand: chain.totalDemand,
      headNodeId: chain.headNodeId,
      tailNodeId: chain.tailNodeId,
    }));

  return {
    chains: Object.freeze(chains),
  };
}

function buildSavingsList(
  sortedOrders: readonly Order[],
  depotNodeId: string,
  costs: CostLookup,
): SavingsEdge[] {
  const savingsList: SavingsEdge[] = [];

  for (const fromOrder of sortedOrders) {
    const returnCost = getCost(
      costs,
      fromOrder.nodeId,
      depotNodeId,
    );

    if (returnCost === null) {
      continue;
    }

    for (const toOrder of sortedOrders) {
      if (fromOrder.id === toOrder.id) {
        continue;
      }

      const departureCost = getCost(
        costs,
        depotNodeId,
        toOrder.nodeId,
      );

      const directCost = getCost(
        costs,
        fromOrder.nodeId,
        toOrder.nodeId,
      );

      if (
        departureCost === null ||
        directCost === null
      ) {
        continue;
      }

      const savings =
        returnCost.distance +
        departureCost.distance -
        directCost.distance;

      /*
       * Never allow NaN or infinities into the ordering logic.
       * shortestPath should normally prevent this, but rejecting bad values
       * here keeps the optimizer deterministic and fail-safe.
       */
      if (!Number.isFinite(savings)) {
        continue;
      }

      savingsList.push({
        fromOrderId: fromOrder.id,
        toOrderId: toOrder.id,
        savings,
      });
    }
  }

  savingsList.sort((a, b) => {
    if (a.savings !== b.savings) {
      return b.savings - a.savings;
    }

    if (a.fromOrderId !== b.fromOrderId) {
      return compareIds(a.fromOrderId, b.fromOrderId);
    }

    return compareIds(a.toOrderId, b.toOrderId);
  });

  return savingsList;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}