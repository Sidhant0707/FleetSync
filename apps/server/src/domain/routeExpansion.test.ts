import { describe, expect, it } from "vitest";
import { RoadGraph } from "./RoadGraph.js";
import { expandRoute } from "./routeExpansion.js";
import type { Order, Route, RouteStop } from "./types.js";

function addNode(graph: RoadGraph, id: string): void {
  graph.addNode({ id, lat: 0, lng: 0 });
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

/**
 * D <-> A, D <-> B, A -> B direct.
 * C is reachable from D only through M.
 * U can be reached from D but has no return path.
 */
function buildGraph(): RoadGraph {
  const graph = new RoadGraph();

  ["D", "A", "B", "C", "M", "U"].forEach((id) => addNode(graph, id));

  addEdge(graph, "D", "A", 5);
  addEdge(graph, "A", "D", 5);
  addEdge(graph, "D", "B", 5);
  addEdge(graph, "B", "D", 5);
  addEdge(graph, "A", "B", 2);

  addEdge(graph, "D", "M", 1);
  addEdge(graph, "M", "C", 2);
  addEdge(graph, "C", "D", 4);

  addEdge(graph, "D", "U", 5);

  return graph;
}

function makeOrder(id: string, nodeId: string): Order {
  return { id, nodeId, demand: 1, status: "pending" };
}

function makeOrders(...orders: readonly Order[]): ReadonlyMap<string, Order> {
  return new Map(orders.map((order) => [order.id, order]));
}

function makeRoute(stops: readonly RouteStop[]): Route {
  return {
    id: "route-v1",
    vehicleId: "v1",
    version: 1,
    stops: Object.freeze([...stops]),
  };
}

function stopsFor(...orderIds: readonly string[]): RouteStop[] {
  return orderIds.map((orderId, index) => ({
    orderId,
    sequenceNo: index + 1,
  }));
}

describe("expandRoute", () => {
  it("expands a zero-stop route into zero legs", () => {
    const graph = buildGraph();

    const result = expandRoute(makeRoute([]), makeOrders(), "D", graph);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.expanded).toEqual({
      routeId: "route-v1",
      vehicleId: "v1",
      version: 1,
      depotNodeId: "D",
      legs: [],
      totalTravelTime: 0,
    });
  });

  it("expands a single-stop route into an out-and-back pair of legs", () => {
    const graph = buildGraph();

    const result = expandRoute(
      makeRoute(stopsFor("oA")),
      makeOrders(makeOrder("oA", "A")),
      "D",
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.expanded.legs).toEqual([
      {
        legIndex: 0,
        kind: "depot_to_stop",
        fromNodeId: "D",
        toNodeId: "A",
        arrivalOrderId: "oA",
        arrivalSequenceNo: 1,
        edgeIds: ["D-A"],
        duration: 5,
      },
      {
        legIndex: 1,
        kind: "stop_to_depot",
        fromNodeId: "A",
        toNodeId: "D",
        arrivalOrderId: null,
        arrivalSequenceNo: null,
        edgeIds: ["A-D"],
        duration: 5,
      },
    ]);

    expect(result.expanded.totalTravelTime).toBe(10);
  });

  it("expands a multi-stop route with one leg per hop plus the depot return", () => {
    const graph = buildGraph();

    const result = expandRoute(
      makeRoute(stopsFor("oA", "oB")),
      makeOrders(makeOrder("oA", "A"), makeOrder("oB", "B")),
      "D",
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(
      result.expanded.legs.map((leg) => [
        leg.kind,
        leg.fromNodeId,
        leg.toNodeId,
        leg.arrivalOrderId,
        leg.arrivalSequenceNo,
        leg.edgeIds,
        leg.duration,
      ]),
    ).toEqual([
      ["depot_to_stop", "D", "A", "oA", 1, ["D-A"], 5],
      ["stop_to_stop", "A", "B", "oB", 2, ["A-B"], 2],
      ["stop_to_depot", "B", "D", null, null, ["B-D"], 5],
    ]);

    expect(result.expanded.totalTravelTime).toBe(12);
  });

  it("resolves a multi-hop leg through the shortest path", () => {
    const graph = buildGraph();

    const result = expandRoute(
      makeRoute(stopsFor("oC")),
      makeOrders(makeOrder("oC", "C")),
      "D",
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.expanded.legs[0]).toMatchObject({
      edgeIds: ["D-M", "M-C"],
      duration: 3,
    });
    expect(result.expanded.legs[1]).toMatchObject({
      edgeIds: ["C-D"],
      duration: 4,
    });
    expect(result.expanded.totalTravelTime).toBe(7);
  });

  it("produces a zero-duration leg with no edges between two stops on the same node", () => {
    const graph = buildGraph();

    const result = expandRoute(
      makeRoute(stopsFor("oA1", "oA2")),
      makeOrders(makeOrder("oA1", "A"), makeOrder("oA2", "A")),
      "D",
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.expanded.legs[1]).toEqual({
      legIndex: 1,
      kind: "stop_to_stop",
      fromNodeId: "A",
      toNodeId: "A",
      arrivalOrderId: "oA2",
      arrivalSequenceNo: 2,
      edgeIds: [],
      duration: 0,
    });
  });

  it("reflects the graph's current edge weights", () => {
    const graph = buildGraph();
    graph.setTravelTimeMultiplier("D-A", 3);

    const result = expandRoute(
      makeRoute(stopsFor("oA")),
      makeOrders(makeOrder("oA", "A")),
      "D",
      graph,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.expanded.legs[0]?.duration).toBe(15);
    expect(result.expanded.totalTravelTime).toBe(20);
  });

  it("fails with UNKNOWN_ORDER when a stop references a missing order", () => {
    const graph = buildGraph();

    const result = expandRoute(
      makeRoute(stopsFor("ghost")),
      makeOrders(),
      "D",
      graph,
    );

    expect(result).toEqual({
      ok: false,
      reason: "UNKNOWN_ORDER",
      detail: "Order ghost referenced by route route-v1 does not exist",
    });
  });

  it("fails with ORDER_NODE_NOT_IN_GRAPH when an order node is absent", () => {
    const graph = buildGraph();

    const result = expandRoute(
      makeRoute(stopsFor("oX")),
      makeOrders(makeOrder("oX", "missing-node")),
      "D",
      graph,
    );

    expect(result).toEqual({
      ok: false,
      reason: "ORDER_NODE_NOT_IN_GRAPH",
      detail:
        "Order node missing-node for order oX does not exist in graph",
    });
  });

  it("fails with UNREACHABLE_LEG when the vehicle cannot return to the depot", () => {
    const graph = buildGraph();

    const result = expandRoute(
      makeRoute(stopsFor("oU")),
      makeOrders(makeOrder("oU", "U")),
      "D",
      graph,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.reason).toBe("UNREACHABLE_LEG");
    expect(result.detail).toContain("leg 1 cannot travel from U to D");
  });

  it("does not mutate the supplied route and returns frozen legs", () => {
    const graph = buildGraph();
    const route = makeRoute(stopsFor("oA", "oB"));
    const snapshot = JSON.stringify(route);

    const result = expandRoute(
      route,
      makeOrders(makeOrder("oA", "A"), makeOrder("oB", "B")),
      "D",
      graph,
    );

    expect(JSON.stringify(route)).toBe(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(Object.isFrozen(result.expanded)).toBe(true);
    expect(Object.isFrozen(result.expanded.legs)).toBe(true);
    expect(Object.isFrozen(result.expanded.legs[0])).toBe(true);
  });
});