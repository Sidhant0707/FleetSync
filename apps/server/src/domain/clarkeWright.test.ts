import { describe, expect, it } from "vitest";
import { RoadGraph } from "./RoadGraph.js";
import type { Order } from "./types.js";
import { buildCostMatrix } from "./travelCost.js";
import { runClarkeWright } from "./clarkeWright.js";

function makeOrder(
  id: string,
  nodeId: string,
  demand: number,
): Order {
  return {
    id,
    nodeId,
    demand,
    status: "pending",
  };
}

function addNode(
  graph: RoadGraph,
  id: string,
): void {
  graph.addNode({
    id,
    lat: 0,
    lng: 0,
  });
}

function addEdge(
  graph: RoadGraph,
  from: string,
  to: string,
  weight: number,
): void {
  graph.addEdge({
    id: `${from}-${to}`,
    fromNodeId: from,
    toNodeId: to,
    baseWeight: weight,
  });
}

describe("runClarkeWright", () => {
  it("merges two orders when positive savings favor the direction", () => {
    const graph = new RoadGraph();

    ["D", "A", "B"].forEach((id) => addNode(graph, id));

    addEdge(graph, "D", "A", 5);
    addEdge(graph, "A", "D", 5);
    addEdge(graph, "D", "B", 5);
    addEdge(graph, "B", "D", 5);

    addEdge(graph, "A", "B", 2);
    addEdge(graph, "B", "A", 2);

    const orders = [
      makeOrder("A", "A", 1),
      makeOrder("B", "B", 1),
    ];

    const costs = buildCostMatrix({
      graph,
      nodeIds: ["D", "A", "B"],
    });

    const result = runClarkeWright({
      depotNodeId: "D",
      orders,
      vehicleCapacity: 10,
      costs,
    });

    expect(result.chains).toHaveLength(1);
    expect(result.chains[0]?.stops.map((o) => o.id)).toEqual([
      "A",
      "B",
    ]);
    expect(result.chains[0]?.totalDemand).toBe(2);
  });

  it("does not merge when the combined demand exceeds capacity", () => {
    const graph = new RoadGraph();

    ["D", "A", "B"].forEach((id) => addNode(graph, id));

    addEdge(graph, "D", "A", 5);
    addEdge(graph, "A", "D", 5);
    addEdge(graph, "D", "B", 5);
    addEdge(graph, "B", "D", 5);
    addEdge(graph, "A", "B", 2);
    addEdge(graph, "B", "A", 2);

    const orders = [
      makeOrder("A", "A", 5),
      makeOrder("B", "B", 5),
    ];

    const costs = buildCostMatrix({
      graph,
      nodeIds: ["D", "A", "B"],
    });

    const result = runClarkeWright({
      depotNodeId: "D",
      orders,
      vehicleCapacity: 8,
      costs,
    });

    expect(result.chains).toHaveLength(2);
    expect(
      result.chains.every((chain) => chain.stops.length === 1),
    ).toBe(true);
  });

  it("respects direction and chooses the feasible cheap direction", () => {
    const graph = new RoadGraph();

    ["D", "A", "B"].forEach((id) => addNode(graph, id));

    addEdge(graph, "D", "A", 10);
    addEdge(graph, "A", "D", 10);
    addEdge(graph, "D", "B", 10);
    addEdge(graph, "B", "D", 10);

    // A -> B exists; B -> A does not.
    addEdge(graph, "A", "B", 1);

    const orders = [
      makeOrder("A", "A", 1),
      makeOrder("B", "B", 1),
    ];

    const costs = buildCostMatrix({
      graph,
      nodeIds: ["D", "A", "B"],
    });

    const result = runClarkeWright({
      depotNodeId: "D",
      orders,
      vehicleCapacity: 10,
      costs,
    });

    expect(result.chains).toHaveLength(1);
    expect(result.chains[0]?.stops.map((o) => o.id)).toEqual([
      "A",
      "B",
    ]);
  });

  it("does not merge when every remaining savings value is non-positive", () => {
    const graph = new RoadGraph();

    ["D", "A", "B"].forEach((id) => addNode(graph, id));

    /*
     * Solo routes cost:
     * D -> A -> D = 10
     * D -> B -> D = 10
     *
     * A -> B = 20
     *
     * Savings:
     * s(A,B) = 5 + 5 - 20 = -10
     *
     * Therefore the two singleton routes must remain separate.
     */
    addEdge(graph, "D", "A", 5);
    addEdge(graph, "A", "D", 5);
    addEdge(graph, "D", "B", 5);
    addEdge(graph, "B", "D", 5);
    addEdge(graph, "A", "B", 20);
    addEdge(graph, "B", "A", 20);

    const orders = [
      makeOrder("A", "A", 1),
      makeOrder("B", "B", 1),
    ];

    const costs = buildCostMatrix({
      graph,
      nodeIds: ["D", "A", "B"],
    });

    const result = runClarkeWright({
      depotNodeId: "D",
      orders,
      vehicleCapacity: 10,
      costs,
    });

    expect(result.chains).toHaveLength(2);

    expect(
      result.chains.map((chain) =>
        chain.stops.map((o) => o.id),
      ),
    ).toEqual([
      ["A"],
      ["B"],
    ]);
  });

  it("chains three orders through successive valid merges", () => {
    const graph = new RoadGraph();

    ["D", "A", "B", "C"].forEach((id) => addNode(graph, id));

    addEdge(graph, "D", "A", 1);
    addEdge(graph, "A", "D", 1);

    addEdge(graph, "D", "B", 3);
    addEdge(graph, "B", "D", 3);

    addEdge(graph, "D", "C", 5);
    addEdge(graph, "C", "D", 5);

    addEdge(graph, "A", "B", 1);
    addEdge(graph, "B", "A", 5);

    addEdge(graph, "B", "C", 1);
    addEdge(graph, "C", "B", 5);

    addEdge(graph, "A", "C", 10);
    addEdge(graph, "C", "A", 10);

    const orders = [
      makeOrder("A", "A", 1),
      makeOrder("B", "B", 1),
      makeOrder("C", "C", 1),
    ];

    const costs = buildCostMatrix({
      graph,
      nodeIds: ["D", "A", "B", "C"],
    });

    const result = runClarkeWright({
      depotNodeId: "D",
      orders,
      vehicleCapacity: 10,
      costs,
    });

    expect(result.chains).toHaveLength(1);
    expect(result.chains[0]?.stops.map((o) => o.id)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(result.chains[0]?.totalDemand).toBe(3);
    expect(result.chains[0]?.headNodeId).toBe("A");
    expect(result.chains[0]?.tailNodeId).toBe("C");
  });

  it("skips a savings candidate whose direct connection is unreachable", () => {
    const graph = new RoadGraph();

    ["D", "A", "B"].forEach((id) => addNode(graph, id));

    addEdge(graph, "D", "A", 5);
    addEdge(graph, "A", "D", 5);
    addEdge(graph, "D", "B", 5);
    addEdge(graph, "B", "D", 5);

    // No A -> B edge and no alternate path from A to B.

    const orders = [
      makeOrder("A", "A", 1),
      makeOrder("B", "B", 1),
    ];

    const costs = buildCostMatrix({
      graph,
      nodeIds: ["D", "A", "B"],
    });

    const result = runClarkeWright({
      depotNodeId: "D",
      orders,
      vehicleCapacity: 10,
      costs,
    });

    expect(result.chains).toHaveLength(2);
    expect(
      result.chains.map((chain) =>
        chain.stops.map((o) => o.id),
      ),
    ).toEqual([
      ["A"],
      ["B"],
    ]);
  });

  it("keeps orders that cannot complete a depot round trip as separate chains", () => {
    const graph = new RoadGraph();

    ["D", "A", "B"].forEach((id) => addNode(graph, id));

    // Both orders are reachable from the depot, but neither can return.
    addEdge(graph, "D", "A", 5);
    addEdge(graph, "D", "B", 5);

    const orders = [
      makeOrder("A", "A", 1),
      makeOrder("B", "B", 1),
    ];

    const costs = buildCostMatrix({
      graph,
      nodeIds: ["D", "A", "B"],
    });

    const result = runClarkeWright({
      depotNodeId: "D",
      orders,
      vehicleCapacity: 10,
      costs,
    });

    expect(result.chains).toHaveLength(2);
    expect(
      result.chains.every((chain) => chain.stops.length === 1),
    ).toBe(true);
  });

  it("handles a single order without merging", () => {
    const graph = new RoadGraph();

    ["D", "A"].forEach((id) => addNode(graph, id));

    addEdge(graph, "D", "A", 5);
    addEdge(graph, "A", "D", 5);

    const orders = [
      makeOrder("A", "A", 1),
    ];

    const costs = buildCostMatrix({
      graph,
      nodeIds: ["D", "A"],
    });

    const result = runClarkeWright({
      depotNodeId: "D",
      orders,
      vehicleCapacity: 10,
      costs,
    });

    expect(result.chains).toHaveLength(1);
    expect(result.chains[0]?.stops.map((o) => o.id)).toEqual([
      "A",
    ]);
  });

  it("produces the same result regardless of input order", () => {
    const graph = new RoadGraph();

    ["D", "A", "B", "C"].forEach((id) => addNode(graph, id));

    addEdge(graph, "D", "A", 1);
    addEdge(graph, "A", "D", 1);

    addEdge(graph, "D", "B", 3);
    addEdge(graph, "B", "D", 3);

    addEdge(graph, "D", "C", 5);
    addEdge(graph, "C", "D", 5);

    addEdge(graph, "A", "B", 1);
    addEdge(graph, "B", "A", 5);

    addEdge(graph, "B", "C", 1);
    addEdge(graph, "C", "B", 5);

    addEdge(graph, "A", "C", 10);
    addEdge(graph, "C", "A", 10);

    const costs = buildCostMatrix({
      graph,
      nodeIds: ["D", "A", "B", "C"],
    });

    const ordersAscending = [
      makeOrder("A", "A", 1),
      makeOrder("B", "B", 1),
      makeOrder("C", "C", 1),
    ];

    const ordersShuffled = [
      makeOrder("C", "C", 1),
      makeOrder("A", "A", 1),
      makeOrder("B", "B", 1),
    ];

    const resultOne = runClarkeWright({
      depotNodeId: "D",
      orders: ordersAscending,
      vehicleCapacity: 10,
      costs,
    });

    const resultTwo = runClarkeWright({
      depotNodeId: "D",
      orders: ordersShuffled,
      vehicleCapacity: 10,
      costs,
    });

    expect(resultTwo).toEqual(resultOne);
  });

  it("uses deterministic tie-breaking for equal savings", () => {
    const graph = new RoadGraph();

    ["D", "A", "B", "C"].forEach((id) => addNode(graph, id));

    addEdge(graph, "D", "A", 5);
    addEdge(graph, "A", "D", 5);

    addEdge(graph, "D", "B", 5);
    addEdge(graph, "B", "D", 5);

    addEdge(graph, "D", "C", 5);
    addEdge(graph, "C", "D", 5);

    // Equal savings from A->B and A->C.
    addEdge(graph, "A", "B", 2);
    addEdge(graph, "B", "A", 10);

    addEdge(graph, "A", "C", 2);
    addEdge(graph, "C", "A", 10);

    const orders = [
      makeOrder("A", "A", 1),
      makeOrder("B", "B", 1),
      makeOrder("C", "C", 1),
    ];

    const costs = buildCostMatrix({
      graph,
      nodeIds: ["D", "A", "B", "C"],
    });

    const result = runClarkeWright({
      depotNodeId: "D",
      orders,
      vehicleCapacity: 10,
      costs,
    });

    /*
     * A->B and A->C have the same saving. Lexicographic tie-breaking gives
     * A->B precedence, so B becomes part of A's chain first.
     */
    expect(
      result.chains.some((chain) =>
        chain.stops.map((o) => o.id).join(",") === "A,B",
      ),
    ).toBe(true);
  });
});