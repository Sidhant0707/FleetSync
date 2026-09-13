import { describe, expect, it } from "vitest";
import { RoadGraph } from "./RoadGraph.js";
import type { RoadEdge } from "./types.js";

function graphWithNodes(...ids: string[]): RoadGraph {
  const graph = new RoadGraph();
  for (const [index, id] of ids.entries()) {
    graph.addNode({ id, lat: index, lng: index });
  }
  return graph;
}

describe("RoadGraph", () => {
  it("inserts and retrieves nodes", () => {
    const graph = new RoadGraph();
    graph.addNode({ id: "n1", lat: 12.9, lng: 77.6 });

    expect(graph.hasNode("n1")).toBe(true);
    expect(graph.getNode("n1")).toEqual({ id: "n1", lat: 12.9, lng: 77.6 });
  });

  it("rejects duplicate node IDs", () => {
    const graph = graphWithNodes("n1");

    expect(() => graph.addNode({ id: "n1", lat: 0, lng: 0 })).toThrow(
      /Duplicate node ID: n1/,
    );
  });

  it("inserts directed edges with currentWeight equal to baseWeight", () => {
    const graph = graphWithNodes("a", "b");
    graph.addEdge({
      id: "e1",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 4,
    });

    expect(graph.getEdge("e1")).toEqual({
      id: "e1",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 4,
      currentWeight: 4,
      status: "open",
    });
    expect(graph.getOutgoingEdges("a").map((edge) => edge.id)).toEqual(["e1"]);
    expect(graph.getOutgoingEdges("b")).toEqual([]);
  });

  it("rejects duplicate edge IDs", () => {
    const graph = graphWithNodes("a", "b", "c");
    graph.addEdge({
      id: "e1",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 1,
    });

    expect(() =>
      graph.addEdge({
        id: "e1",
        fromNodeId: "b",
        toNodeId: "c",
        baseWeight: 2,
      }),
    ).toThrow(/Duplicate edge ID: e1/);
  });

  it("stores edges as directed", () => {
    const graph = graphWithNodes("a", "b");
    graph.addEdge({
      id: "ab",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 1,
    });

    expect(graph.getOutgoingEdges("a")).toHaveLength(1);
    expect(graph.getOutgoingEdges("b")).toHaveLength(0);
  });

  it("rejects edges whose endpoints do not exist", () => {
    const graph = graphWithNodes("a");

    expect(() =>
      graph.addEdge({
        id: "missing-from",
        fromNodeId: "ghost",
        toNodeId: "a",
        baseWeight: 1,
      }),
    ).toThrow(/unknown node ID: ghost/);

    expect(() =>
      graph.addEdge({
        id: "missing-to",
        fromNodeId: "a",
        toNodeId: "ghost",
        baseWeight: 1,
      }),
    ).toThrow(/unknown node ID: ghost/);
  });

  it("rejects non-positive or non-finite base weights", () => {
    const graph = graphWithNodes("a", "b");

    expect(() =>
      graph.addEdge({
        id: "zero",
        fromNodeId: "a",
        toNodeId: "b",
        baseWeight: 0,
      }),
    ).toThrow(/invalid baseWeight/);

    expect(() =>
      graph.addEdge({
        id: "negative",
        fromNodeId: "a",
        toNodeId: "b",
        baseWeight: -2,
      }),
    ).toThrow(/invalid baseWeight/);

    expect(() =>
      graph.addEdge({
        id: "infinite",
        fromNodeId: "a",
        toNodeId: "b",
        baseWeight: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/invalid baseWeight/);

    expect(() =>
      graph.addEdge({
        id: "nan",
        fromNodeId: "a",
        toNodeId: "b",
        baseWeight: Number.NaN,
      }),
    ).toThrow(/invalid baseWeight/);
  });

  it("closes an edge", () => {
    const graph = graphWithNodes("a", "b");
    graph.addEdge({
      id: "e1",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 5,
    });

    graph.closeEdge("e1");

    const closed = graph.getEdge("e1");
    expect(closed.status).toBe("closed");
    expect(closed.currentWeight).toBe(Number.POSITIVE_INFINITY);
    expect(closed.baseWeight).toBe(5);
  });

  it("reopens an edge and restores baseWeight", () => {
    const graph = graphWithNodes("a", "b");
    graph.addEdge({
      id: "e1",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 5,
    });
    graph.setTravelTimeMultiplier("e1", 3);
    graph.closeEdge("e1");

    graph.reopenEdge("e1");

    expect(graph.getEdge("e1")).toMatchObject({
      status: "open",
      currentWeight: 5,
      baseWeight: 5,
    });
  });

  it("applies a travel-time multiplier to an open edge", () => {
    const graph = graphWithNodes("a", "b");
    graph.addEdge({
      id: "e1",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 10,
    });

    graph.setTravelTimeMultiplier("e1", 1.5);

    expect(graph.getEdge("e1").currentWeight).toBe(15);
  });

  it("scales multipliers from baseWeight, not the previous currentWeight", () => {
    const graph = graphWithNodes("a", "b");
    graph.addEdge({
      id: "e1",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 8,
    });

    graph.setTravelTimeMultiplier("e1", 2);
    expect(graph.getEdge("e1").currentWeight).toBe(16);

    graph.setTravelTimeMultiplier("e1", 0.25);
    expect(graph.getEdge("e1").currentWeight).toBe(2);
  });

  it("rejects a multiplier on a closed edge", () => {
    const graph = graphWithNodes("a", "b");
    graph.addEdge({
      id: "e1",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 4,
    });
    graph.closeEdge("e1");

    expect(() => graph.setTravelTimeMultiplier("e1", 2)).toThrow(
      /closed edge: e1/,
    );
  });

  it("rejects invalid multipliers", () => {
    const graph = graphWithNodes("a", "b");
    graph.addEdge({
      id: "e1",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 4,
    });

    expect(() => graph.setTravelTimeMultiplier("e1", 0)).toThrow(
      /Invalid travel-time multiplier/,
    );
    expect(() => graph.setTravelTimeMultiplier("e1", -1)).toThrow(
      /Invalid travel-time multiplier/,
    );
    expect(() =>
      graph.setTravelTimeMultiplier("e1", Number.POSITIVE_INFINITY),
    ).toThrow(/Invalid travel-time multiplier/);
  });

  it("produces clear errors for unknown nodes and edges", () => {
    const graph = graphWithNodes("a");

    expect(() => graph.getNode("missing")).toThrow(/Unknown node ID: missing/);
    expect(() => graph.getOutgoingEdges("missing")).toThrow(
      /Unknown node ID: missing/,
    );
    expect(() => graph.getEdge("missing")).toThrow(/Unknown edge ID: missing/);
    expect(() => graph.closeEdge("missing")).toThrow(/Unknown edge ID: missing/);
    expect(() => graph.reopenEdge("missing")).toThrow(
      /Unknown edge ID: missing/,
    );
  });

  it("does not allow callers to mutate internal graph state through returned objects", () => {
    const graph = graphWithNodes("a", "b");
    graph.addEdge({
      id: "e1",
      fromNodeId: "a",
      toNodeId: "b",
      baseWeight: 3,
    });

    const node = graph.getNode("a");
    const edge = graph.getEdge("e1");
    const outgoing = graph.getOutgoingEdges("a");
    const outgoingEdge = outgoing[0];

    expect(outgoingEdge).toBeDefined();

    expect(() => {
      (node as { lat: number }).lat = 99;
    }).toThrow();
    expect(() => {
      (edge as { currentWeight: number }).currentWeight = 0;
    }).toThrow();
    expect(() => {
      (outgoing as RoadEdge[]).push(edge);
    }).toThrow();
    expect(() => {
      (outgoingEdge as { status: string }).status = "closed";
    }).toThrow();

    expect(graph.getNode("a").lat).toBe(0);
    expect(graph.getEdge("e1")).toMatchObject({
      currentWeight: 3,
      status: "open",
    });
    expect(graph.getOutgoingEdges("a")).toHaveLength(1);
  });
});
