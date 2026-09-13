import { describe, expect, it } from "vitest";
import { RoadGraph } from "./RoadGraph.js";
import { shortestPath } from "./shortestPath.js";

function diamondGraph(): RoadGraph {
  const graph = new RoadGraph();
  for (const id of ["s", "a", "b", "t"]) {
    graph.addNode({ id, lat: 0, lng: 0 });
  }

  graph.addEdge({ id: "s-a", fromNodeId: "s", toNodeId: "a", baseWeight: 1 });
  graph.addEdge({ id: "s-b", fromNodeId: "s", toNodeId: "b", baseWeight: 5 });
  graph.addEdge({ id: "a-t", fromNodeId: "a", toNodeId: "t", baseWeight: 1 });
  graph.addEdge({ id: "b-t", fromNodeId: "b", toNodeId: "t", baseWeight: 1 });
  return graph;
}

describe("shortestPath", () => {
  it("finds the normal shortest path", () => {
    const graph = diamondGraph();
    const result = shortestPath(graph, "s", "t");

    expect(result).toEqual({
      reachable: true,
      distance: 2,
      nodePath: ["s", "a", "t"],
      edgePath: ["s-a", "a-t"],
    });
  });

  it("returns a zero-length path when source equals target", () => {
    const graph = diamondGraph();
    const result = shortestPath(graph, "s", "s");

    expect(result).toEqual({
      reachable: true,
      distance: 0,
      nodePath: ["s"],
      edgePath: [],
    });
  });

  it("respects directed edges", () => {
    const graph = new RoadGraph();
    graph.addNode({ id: "a", lat: 0, lng: 0 });
    graph.addNode({ id: "b", lat: 0, lng: 0 });
    graph.addEdge({ id: "ab", fromNodeId: "a", toNodeId: "b", baseWeight: 2 });

    expect(shortestPath(graph, "a", "b")).toMatchObject({
      reachable: true,
      distance: 2,
      nodePath: ["a", "b"],
      edgePath: ["ab"],
    });
    expect(shortestPath(graph, "b", "a")).toEqual({
      reachable: false,
      distance: Number.POSITIVE_INFINITY,
      nodePath: [],
      edgePath: [],
    });
  });

  it("returns an unreachable result for a disconnected target", () => {
    const graph = new RoadGraph();
    graph.addNode({ id: "a", lat: 0, lng: 0 });
    graph.addNode({ id: "b", lat: 0, lng: 0 });

    expect(shortestPath(graph, "a", "b")).toEqual({
      reachable: false,
      distance: Number.POSITIVE_INFINITY,
      nodePath: [],
      edgePath: [],
    });
  });

  it("rejects an unknown source node", () => {
    const graph = diamondGraph();
    expect(() => shortestPath(graph, "missing", "t")).toThrow(
      /Unknown source node ID: missing/,
    );
  });

  it("rejects an unknown target node", () => {
    const graph = diamondGraph();
    expect(() => shortestPath(graph, "s", "missing")).toThrow(
      /Unknown target node ID: missing/,
    );
  });

  it("reroutes around a closed edge", () => {
    const graph = diamondGraph();
    graph.closeEdge("s-a");

    expect(shortestPath(graph, "s", "t")).toEqual({
      reachable: true,
      distance: 6,
      nodePath: ["s", "b", "t"],
      edgePath: ["s-b", "b-t"],
    });
  });

  it("becomes unreachable when remaining edges are closed", () => {
    const graph = diamondGraph();
    graph.closeEdge("s-a");
    graph.closeEdge("s-b");

    expect(shortestPath(graph, "s", "t")).toEqual({
      reachable: false,
      distance: Number.POSITIVE_INFINITY,
      nodePath: [],
      edgePath: [],
    });
  });

  it("changes the chosen route after a travel-time update", () => {
    const graph = diamondGraph();
    graph.setTravelTimeMultiplier("s-a", 10);

    expect(shortestPath(graph, "s", "t")).toEqual({
      reachable: true,
      distance: 6,
      nodePath: ["s", "b", "t"],
      edgePath: ["s-b", "b-t"],
    });
  });

  it("restores route availability after reopening an edge", () => {
    const graph = diamondGraph();
    graph.closeEdge("s-a");
    graph.closeEdge("s-b");
    expect(shortestPath(graph, "s", "t").reachable).toBe(false);

    graph.reopenEdge("s-a");

    expect(shortestPath(graph, "s", "t")).toEqual({
      reachable: true,
      distance: 2,
      nodePath: ["s", "a", "t"],
      edgePath: ["s-a", "a-t"],
    });
  });

  it("returns the same result on repeated execution", () => {
    const graph = diamondGraph();
    const first = shortestPath(graph, "s", "t");
    const second = shortestPath(graph, "s", "t");

    expect(second).toEqual(first);
  });

  it("breaks equal-cost ties deterministically", () => {
    const graph = new RoadGraph();
    for (const id of ["s", "m", "n", "t"]) {
      graph.addNode({ id, lat: 0, lng: 0 });
    }

    graph.addEdge({ id: "s-m", fromNodeId: "s", toNodeId: "m", baseWeight: 1 });
    graph.addEdge({ id: "s-n", fromNodeId: "s", toNodeId: "n", baseWeight: 1 });
    graph.addEdge({ id: "m-t", fromNodeId: "m", toNodeId: "t", baseWeight: 1 });
    graph.addEdge({ id: "n-t", fromNodeId: "n", toNodeId: "t", baseWeight: 1 });

    const expected = {
      reachable: true,
      distance: 2,
      nodePath: ["s", "m", "t"],
      edgePath: ["s-m", "m-t"],
    };

    expect(shortestPath(graph, "s", "t")).toEqual(expected);
    expect(shortestPath(graph, "s", "t")).toEqual(expected);
  });
});
