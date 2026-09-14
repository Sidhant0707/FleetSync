import { describe, expect, it } from "vitest";
import type { Order } from "./types.js";
import type { RouteChain } from "./clarkeWright.js";
import { assignVehiclesDeterministic } from "./vehicleAssignment.js";

function makeOrder(
  id: string,
  demand: number,
): Order {
  return {
    id,
    nodeId: id,
    demand,
    status: "pending",
  };
}

function makeChain(
  chainId: number,
  stopIds: readonly string[],
  demandPerStop = 1,
): RouteChain {
  const stops = stopIds.map((id) =>
    makeOrder(id, demandPerStop),
  );

  const totalDemand = stops.reduce(
    (sum, stop) => sum + stop.demand,
    0,
  );

  return {
    chainId,
    stops: Object.freeze(stops),
    totalDemand,
    headNodeId: stops[0]!.nodeId,
    tailNodeId: stops[stops.length - 1]!.nodeId,
  };
}

describe("assignVehiclesDeterministic", () => {
  it("assigns every chain when there are more vehicles than chains", () => {
    const chains = [
      makeChain(0, ["A"]),
      makeChain(1, ["B"]),
    ];

    const result = assignVehiclesDeterministic({
      chains,
      vehicleIds: ["v1", "v2", "v3"],
    });

    expect(result.assigned).toHaveLength(2);
    expect(result.unassignedChains).toEqual([]);
  });

  it("pairs every chain with a vehicle when counts match exactly", () => {
    const chains = [
      makeChain(0, ["A"]),
      makeChain(1, ["B"]),
    ];

    const result = assignVehiclesDeterministic({
      chains,
      vehicleIds: ["v1", "v2"],
    });

    expect(result.assigned).toHaveLength(2);
    expect(result.unassignedChains).toEqual([]);
  });

  it("leaves excess chains unassigned when there are fewer vehicles than chains", () => {
    const chains = [
      makeChain(0, ["A"]),
      makeChain(1, ["B"]),
      makeChain(2, ["C"]),
    ];

    const result = assignVehiclesDeterministic({
      chains,
      vehicleIds: ["v1"],
    });

    expect(result.assigned).toHaveLength(1);
    expect(result.unassignedChains).toHaveLength(2);
  });

  it("assigns the highest-demand chain first when vehicles are scarce", () => {
    const light = makeChain(0, ["A"], 1);
    const heavy = makeChain(1, ["B"], 5);

    const result = assignVehiclesDeterministic({
      chains: [light, heavy],
      vehicleIds: ["v1"],
    });

    expect(result.assigned).toEqual([
      {
        vehicleId: "v1",
        chain: heavy,
      },
    ]);

    expect(result.unassignedChains).toEqual([light]);
  });

  it("breaks equal-demand ties using the ascending first-stop order id", () => {
    const chainB = makeChain(0, ["B"], 3);
    const chainA = makeChain(1, ["A"], 3);

    const result = assignVehiclesDeterministic({
      chains: [chainB, chainA],
      vehicleIds: ["v1"],
    });

    expect(result.assigned).toEqual([
      {
        vehicleId: "v1",
        chain: chainA,
      },
    ]);

    expect(result.unassignedChains).toEqual([chainB]);
  });

  it("uses chainId as the final tiebreak when demand and first-stop id are equal", () => {
    const higherChainId = makeChain(5, ["A"], 2);
    const lowerChainId = makeChain(2, ["A"], 2);

    const result = assignVehiclesDeterministic({
      chains: [higherChainId, lowerChainId],
      vehicleIds: ["v1"],
    });

    expect(result.assigned).toEqual([
      {
        vehicleId: "v1",
        chain: lowerChainId,
      },
    ]);

    expect(result.unassignedChains).toEqual([higherChainId]);
  });

  it("normalizes unsorted vehicle IDs before pairing", () => {
    const chains = [
      makeChain(0, ["A"]),
      makeChain(1, ["B"]),
    ];

    const result = assignVehiclesDeterministic({
      chains,
      vehicleIds: ["v9", "v2"],
    });

    expect(result.assigned).toEqual([
      {
        vehicleId: "v2",
        chain: chains[0],
      },
      {
        vehicleId: "v9",
        chain: chains[1],
      },
    ]);
  });

  it("returns no assignments when there are no chains", () => {
    const result = assignVehiclesDeterministic({
      chains: [],
      vehicleIds: ["v1", "v2"],
    });

    expect(result.assigned).toEqual([]);
    expect(result.unassignedChains).toEqual([]);
  });

  it("leaves every chain unassigned when there are no vehicles", () => {
    const chains = [
      makeChain(0, ["A"]),
      makeChain(1, ["B"]),
    ];

    const result = assignVehiclesDeterministic({
      chains,
      vehicleIds: [],
    });

    expect(result.assigned).toEqual([]);
    expect(result.unassignedChains).toEqual(chains);
  });

  it("does not mutate the caller-supplied arrays", () => {
    const chains = [
      makeChain(1, ["B"]),
      makeChain(0, ["A"]),
    ];

    const vehicleIds = ["v9", "v2"];

    const originalChains = [...chains];
    const originalVehicleIds = [...vehicleIds];

    assignVehiclesDeterministic({
      chains,
      vehicleIds,
    });

    expect(chains).toEqual(originalChains);
    expect(vehicleIds).toEqual(originalVehicleIds);
  });
});