import { describe, expect, it } from "vitest";
import { RoadGraph } from "./RoadGraph.js";
import { buildCostMatrix, getCost } from "./travelCost.js";

function buildLinearGraph(): RoadGraph {
  const graph = new RoadGraph();

  graph.addNode({ id: "A", lat: 0, lng: 0 });
  graph.addNode({ id: "B", lat: 0, lng: 1 });
  graph.addNode({ id: "C", lat: 0, lng: 2 });

  graph.addEdge({
    id: "A-B",
    fromNodeId: "A",
    toNodeId: "B",
    baseWeight: 10,
  });

  graph.addEdge({
    id: "B-A",
    fromNodeId: "B",
    toNodeId: "A",
    baseWeight: 10,
  });

  graph.addEdge({
    id: "B-C",
    fromNodeId: "B",
    toNodeId: "C",
    baseWeight: 5,
  });

  graph.addEdge({
    id: "C-B",
    fromNodeId: "C",
    toNodeId: "B",
    baseWeight: 5,
  });

  return graph;
}

describe("buildCostMatrix / getCost", () => {
  it("returns the correct multi-hop directed cost", () => {
    const graph = buildLinearGraph();

    const matrix = buildCostMatrix({
      graph,
      nodeIds: ["A", "B", "C"],
    });

    const cost = getCost(matrix, "A", "C");

    expect(cost).not.toBeNull();
    expect(cost?.reachable).toBe(true);
    expect(cost?.distance).toBe(15);
    expect(cost?.nodePath).toEqual(["A", "B", "C"]);
  });

  it("returns a reachable zero-cost self result", () => {
    const graph = buildLinearGraph();

    const matrix = buildCostMatrix({
      graph,
      nodeIds: ["A", "B", "C"],
    });

    expect(getCost(matrix, "B", "B")).toEqual({
      reachable: true,
      distance: 0,
      nodePath: ["B"],
      edgePath: [],
    });
  });

  it("treats opposite directions independently", () => {
    const graph = buildLinearGraph();

    graph.closeEdge("A-B");

    const matrix = buildCostMatrix({
      graph,
      nodeIds: ["A", "B"],
    });

    expect(getCost(matrix, "A", "B")).toBeNull();
    expect(getCost(matrix, "B", "A")).not.toBeNull();
  });

  it("returns null for genuinely disconnected nodes", () => {
    const graph = new RoadGraph();

    graph.addNode({ id: "X", lat: 0, lng: 0 });
    graph.addNode({ id: "Y", lat: 1, lng: 1 });

    const matrix = buildCostMatrix({
      graph,
      nodeIds: ["X", "Y"],
    });

    expect(getCost(matrix, "X", "Y")).toBeNull();
    expect(getCost(matrix, "Y", "X")).toBeNull();
  });

  it("returns null when querying outside the matrix node set", () => {
    const graph = buildLinearGraph();

    const matrix = buildCostMatrix({
      graph,
      nodeIds: ["A", "B"],
    });

    expect(getCost(matrix, "A", "C")).toBeNull();
  });

  it("produces identical results regardless of nodeIds input order", () => {
    const graph = buildLinearGraph();

    const matrixOne = buildCostMatrix({
      graph,
      nodeIds: ["A", "B", "C"],
    });

    const matrixTwo = buildCostMatrix({
      graph,
      nodeIds: ["C", "A", "B"],
    });

    expect(getCost(matrixOne, "A", "C")).toEqual(
      getCost(matrixTwo, "A", "C"),
    );

    expect(getCost(matrixOne, "C", "A")).toEqual(
      getCost(matrixTwo, "C", "A"),
    );
  });

  it("deduplicates repeated node IDs", () => {
    const graph = buildLinearGraph();

    expect(() =>
      buildCostMatrix({
        graph,
        nodeIds: ["A", "A", "B"],
      }),
    ).not.toThrow();
  });
});