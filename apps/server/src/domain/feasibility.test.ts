import { describe, expect, it } from "vitest";
import { RoadGraph } from "./RoadGraph.js";
import { checkRouteFeasibility } from "./feasibility.js";
import type { Depot, Order, Route, Vehicle } from "./types.js";

describe("checkRouteFeasibility", () => {
  function setupGraph(): RoadGraph {
    const graph = new RoadGraph();
    // Add depot node and order nodes
    graph.addNode({ id: "depot", lat: 0, lng: 0 });
    graph.addNode({ id: "order1", lat: 1, lng: 1 });
    graph.addNode({ id: "order2", lat: 2, lng: 2 });
    graph.addNode({ id: "order3", lat: 3, lng: 3 });
    graph.addNode({ id: "unreachable", lat: 10, lng: 10 });

    // Add edges: depot -> order1 -> order2 -> depot
    graph.addEdge({
      id: "e1",
      fromNodeId: "depot",
      toNodeId: "order1",
      baseWeight: 1,
    });
    graph.addEdge({
      id: "e2",
      fromNodeId: "order1",
      toNodeId: "order2",
      baseWeight: 1,
    });
    graph.addEdge({
      id: "e3",
      fromNodeId: "order2",
      toNodeId: "depot",
      baseWeight: 1,
    });

    // Add edge for order3 (for multi-stop testing)
    graph.addEdge({
      id: "e4",
      fromNodeId: "order2",
      toNodeId: "order3",
      baseWeight: 1,
    });
    graph.addEdge({
      id: "e5",
      fromNodeId: "order3",
      toNodeId: "depot",
      baseWeight: 1,
    });

    return graph;
  }

  function createVehicle(
    id: string = "v1",
    depotId: string = "d1",
    status: "idle" | "enroute" | "broken_down" = "idle",
    capacity: number = 100,
  ): Vehicle {
    return {
      id,
      label: `Vehicle ${id}`,
      capacity,
      depotId,
      status,
    };
  }

  function createDepot(id: string = "d1", nodeId: string = "depot"): Depot {
    return {
      id,
      name: `Depot ${id}`,
      nodeId,
    };
  }

  function createOrder(
    id: string,
    nodeId: string,
    demand: number = 10,
    status: "pending" | "assigned" | "unreachable" | "delivered" | "cancelled" = "pending",
  ): Order {
    return {
      id,
      nodeId,
      demand,
      status,
    };
  }

  function createRoute(
    id: string = "r1",
    vehicleId: string = "v1",
    version: number = 1,
    stops: Array<{ orderId: string; sequenceNo: number }> = [],
  ): Route {
    return {
      id,
      vehicleId,
      version,
      stops: Object.freeze(stops),
    };
  }

  describe("valid routes", () => {
    it("accepts an empty route", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, []),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("accepts a simple single-order route", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "order1", sequenceNo: 1 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("accepts a multi-order route with proper connectivity", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 20)],
        ["order3", createOrder("order3", "order3", 15)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
          { orderId: "order3", sequenceNo: 3 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("accepts a route with demand exactly at vehicle capacity", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle("v1", "d1", "idle", 50)]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 30)],
        ["order2", createOrder("order2", "order2", 20)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(true);
      expect(result.violations).toEqual([]);
    });
  });

  describe("constraint 1: vehicle exists and is not broken_down", () => {
    it("rejects route when vehicle does not exist", () => {
      const graph = setupGraph();
      const vehicles = new Map<string, Vehicle>();
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "nonexistent_vehicle"),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Vehicle nonexistent_vehicle does not exist",
      );
    });

    it("rejects route when vehicle is broken_down", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1", "broken_down")],
      ]);
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1"),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Vehicle v1 is broken_down and cannot perform routes",
      );
    });
  });

  describe("constraint 3: vehicle capacity must be a valid non-negative finite number", () => {
    it("rejects route when vehicle capacity is NaN", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle("v1", "d1", "idle", NaN)]]);
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, []),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Vehicle v1 has an invalid capacity NaN; capacity must be a non-negative finite number",
      );
    });

    it("rejects route when vehicle capacity is negative", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle("v1", "d1", "idle", -5)]]);
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, []),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Vehicle v1 has an invalid capacity -5; capacity must be a non-negative finite number",
      );
    });

    it("rejects route when vehicle capacity is Infinity", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1", "idle", Infinity)],
      ]);
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, []),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Vehicle v1 has an invalid capacity Infinity; capacity must be a non-negative finite number",
      );
    });

    it("does not also report a bogus 'exceeds capacity' violation when capacity itself is invalid", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle("v1", "d1", "idle", NaN)]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "order1", sequenceNo: 1 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(
        result.violations.some((violation) => violation.includes("exceeds vehicle capacity")),
      ).toBe(false);
    });
  });

  describe("constraint 4: every order in the route exists", () => {
    it("rejects route with non-existent order", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "nonexistent", sequenceNo: 2 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Order nonexistent referenced in route does not exist",
      );
    });
  });

  describe("constraint 5: no cancelled order may be assigned", () => {
    it("rejects route with cancelled order", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10, "cancelled")],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "order1", sequenceNo: 1 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Order order1 is cancelled and cannot be assigned to a route",
      );
    });

    // Whether "delivered" or "assigned" orders should be routable is a
    // domain-policy question this function does not invent an answer to;
    // those statuses are left unrestricted intentionally, not by omission.
  });

  describe("constraint 6: no unreachable order may be assigned", () => {
    it("rejects route with unreachable order", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10, "unreachable")],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "order1", sequenceNo: 1 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Order order1 is unreachable and cannot be assigned to a route",
      );
    });
  });

  describe("constraint 7: no order may appear more than once", () => {
    it("rejects route with duplicate order", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order1", sequenceNo: 2 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Order order1 appears multiple times in the route",
      );
    });
  });

  describe("constraint 8: order demand must be a valid non-negative finite number", () => {
    it("rejects route when an order's demand is NaN", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", NaN)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "order1", sequenceNo: 1 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Order order1 has an invalid demand NaN; demand must be a non-negative finite number",
      );
    });

    it("rejects route when an order's demand is negative", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", -10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "order1", sequenceNo: 1 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Order order1 has an invalid demand -10; demand must be a non-negative finite number",
      );
    });

    it("does not let an invalid demand corrupt the total demand used elsewhere", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle("v1", "d1", "idle", 50)]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 30)],
        ["order2", createOrder("order2", "order2", NaN)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Order order2 has an invalid demand NaN; demand must be a non-negative finite number",
      );
      expect(
        result.violations.some((violation) => violation.includes("exceeds vehicle capacity")),
      ).toBe(false);
    });
  });

  describe("constraint 9: total demand <= vehicle capacity", () => {
    it("rejects route when demand exceeds capacity", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle("v1", "d1", "idle", 50)]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 30)],
        ["order2", createOrder("order2", "order2", 25)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Total demand 55 exceeds vehicle capacity 50",
      );
    });
  });

  describe("constraint 10: stop sequence numbers must be well-formed", () => {
    it("rejects a sequence number of 0", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "order1", sequenceNo: 0 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Stop for order order1 has an invalid sequence number, expected a positive integer but got 0",
      );
    });

    it("rejects a negative sequence number", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "order1", sequenceNo: -1 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Stop for order order1 has an invalid sequence number, expected a positive integer but got -1",
      );
    });

    it("rejects a non-integer sequence number", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "order1", sequenceNo: 1.5 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Stop for order order1 has an invalid sequence number, expected a positive integer but got 1.5",
      );
    });

    it("rejects a duplicate sequence number", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 1 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Sequence number 1 is used by more than one stop (orders order1 and order2)",
      );
    });

    it("rejects a skipped (non-contiguous) sequence number", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 3 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Route stop sequence numbers must be contiguous starting at 1 with no gaps; got [1, 3]",
      );
    });

    it("rejects stops listed out of ascending sequence order", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        // sequenceNo says order2 (seq 1) should come before order1 (seq 2),
        // but the array lists order1 first — the declared sequence and the
        // actual traversal order disagree.
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 2 },
          { orderId: "order2", sequenceNo: 1 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Route stops are not listed in ascending sequence order: order order1 (sequence 2) appears before order order2 (sequence 1)",
      );
    });

    it("accepts sequence numbers that are contiguous, unique, and in ascending order", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(true);
      expect(result.violations).toEqual([]);
    });
  });

  describe("constraint 11: reachability from/to depot using open edges", () => {
    it("rejects when depot does not exist", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle("v1", "nonexistent")]]);
      const orders = new Map<string, Order>();
      const depots = new Map<string, Depot>();

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, []),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Depot nonexistent for vehicle v1 does not exist",
      );
    });

    it("rejects when depot node does not exist in graph", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot("d1", "nonexistent_node")]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, []),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Depot node nonexistent_node for depot d1 does not exist in graph",
      );
    });

    it("rejects when order node does not exist in graph, reporting it only once", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "nonexistent_node", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "order1", sequenceNo: 1 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Order node nonexistent_node for order order1 does not exist in graph",
      );
      // Regression guard: a single-stop route means this order is checked as
      // both the "first" and "last" stop internally — it must only be
      // reported once, not once per internal check.
      const occurrences = result.violations.filter(
        (violation) =>
          violation ===
          "Order node nonexistent_node for order order1 does not exist in graph",
      );
      expect(occurrences).toHaveLength(1);
    });

    it("rejects when the last stop's order node does not exist in graph, reporting it only once", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "missing_node", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      // Regression guard: on a multi-stop route, the last order's node is
      // validated once while checking the previous leg's destination and
      // again while checking the return-to-depot leg. It must still only be
      // reported once.
      const occurrences = result.violations.filter(
        (violation) =>
          violation ===
          "Order node missing_node for order order2 does not exist in graph",
      );
      expect(occurrences).toHaveLength(1);
    });

    it("rejects when first order is not reachable from depot", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["unreachable", createOrder("unreachable", "unreachable", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [{ orderId: "unreachable", sequenceNo: 1 }]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Cannot reach first order node unreachable from depot node depot using open edges",
      );
    });

    it("rejects when intermediate orders are not reachable", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["unreachable", createOrder("unreachable", "unreachable", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "unreachable", sequenceNo: 2 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Cannot reach order node unreachable from order node order1 using open edges",
      );
    });

    it("rejects when last order cannot return to depot", () => {
      const graph = setupGraph();
      // Add order4 that can be reached but can't return to depot
      graph.addNode({ id: "order4", lat: 4, lng: 4 });
      graph.addEdge({
        id: "e6",
        fromNodeId: "order2",
        toNodeId: "order4",
        baseWeight: 1,
      });
      // No edge back to depot from order4

      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order4", createOrder("order4", "order4", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order4", sequenceNo: 2 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Cannot return from last order node order4 to depot node depot using open edges",
      );
    });

    it("rejects when edge is closed in the path", () => {
      const graph = setupGraph();
      graph.closeEdge("e2"); // Close edge from order1 to order2

      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Cannot reach order node order2 from order node order1 using open edges",
      );
    });
  });

  describe("constraint 12: route version must be positive integer", () => {
    it("rejects route with zero version", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 0, []),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Route version must be a positive integer, got 0",
      );
    });

    it("rejects route with negative version", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", -5, []),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Route version must be a positive integer, got -5",
      );
    });

    it("rejects route with non-integer version", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1.5, []),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Route version must be a positive integer, got 1.5",
      );
    });
  });

  describe("multiple violations", () => {
    it("reports all violations found in a route", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle("v1", "d1", "idle", 50)]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 30)],
        ["order2", createOrder("order2", "order2", 30, "cancelled")],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
          { orderId: "order1", sequenceNo: 3 }, // duplicate
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations.length).toBeGreaterThan(1);
      expect(result.violations).toContain(
        "Order order2 is cancelled and cannot be assigned to a route",
      );
      expect(result.violations).toContain(
        "Order order1 appears multiple times in the route",
      );
      expect(result.violations).toContain(
        "Total demand 60 exceeds vehicle capacity 50",
      );
    });

    it("reports capacity, demand, and sequencing violations together", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle("v1", "d1", "idle", -1)]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", -5)],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const result = checkRouteFeasibility(
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 1 }, // duplicate sequence number
        ]),
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Vehicle v1 has an invalid capacity -1; capacity must be a non-negative finite number",
      );
      expect(result.violations).toContain(
        "Order order1 has an invalid demand -5; demand must be a non-negative finite number",
      );
      expect(result.violations).toContain(
        "Sequence number 1 is used by more than one stop (orders order1 and order2)",
      );
    });
  });
});