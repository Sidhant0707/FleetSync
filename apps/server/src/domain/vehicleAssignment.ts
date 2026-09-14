import type { RouteChain } from "./clarkeWright.js";

export interface AssignmentInput {
  readonly chains: readonly RouteChain[];
  readonly vehicleIds: readonly string[];
}

export interface AssignedChain {
  readonly vehicleId: string;
  readonly chain: RouteChain;
}

export interface AssignmentResult {
  readonly assigned: readonly AssignedChain[];
  readonly unassignedChains: readonly RouteChain[];
}

/**
 * Deterministically pairs already-constructed RouteChains with eligible
 * homogeneous-capacity vehicles.
 *
 * Chain priority:
 * 1. totalDemand descending
 * 2. first stop order id ascending
 * 3. chainId ascending
 *
 * Vehicle priority:
 * 1. vehicle id ascending
 *
 * The sorted chains and vehicles are then paired index-for-index.
 *
 * Inputs are copied before sorting, so caller-owned arrays are not mutated.
 */
export function assignVehiclesDeterministic(
  input: AssignmentInput,
): AssignmentResult {
  const sortedChains = [...input.chains].sort(compareChains);
  const sortedVehicleIds = [...input.vehicleIds].sort(compareIds);

  const assigned: AssignedChain[] = [];
  const unassignedChains: RouteChain[] = [];

  for (const [index, chain] of sortedChains.entries()) {
    const vehicleId = sortedVehicleIds[index];

    if (vehicleId === undefined) {
      unassignedChains.push(chain);
      continue;
    }

    assigned.push({
      vehicleId,
      chain,
    });
  }

  return {
    assigned: Object.freeze(assigned),
    unassignedChains: Object.freeze(unassignedChains),
  };
}

function compareChains(
  a: RouteChain,
  b: RouteChain,
): number {
  if (a.totalDemand !== b.totalDemand) {
    return b.totalDemand - a.totalDemand;
  }

  /*
   * A RouteChain is always non-empty because Clarke-Wright creates singleton
   * chains and only merges existing non-empty chains.
   */
  const aFirstStopId = a.stops[0]!.id;
  const bFirstStopId = b.stops[0]!.id;

  if (aFirstStopId !== bFirstStopId) {
    return compareIds(aFirstStopId, bFirstStopId);
  }

  return a.chainId - b.chainId;
}

function compareIds(
  a: string,
  b: string,
): number {
  return a < b ? -1 : a > b ? 1 : 0;
}