import { describe, expect, it } from "vitest";
import { RoadGraph } from "./RoadGraph.js";
import { checkPlanFeasibility } from "./planFeasibility.js";
import type { Depot, Order, Route, Vehicle } from "./types.js";

describe("checkPlanFeasibility", () => {
  function setupGraph(): RoadGraph {
    const graph = new RoadGraph();
    // Add depot node and order nodes
    graph.addNode({ id: "depot", lat: 0, lng: 0 });
    graph.addNode({ id: "order1", lat: 1, lng: 1 });
    graph.addNode({ id: "order2", lat: 2, lng: 2 });
    graph.addNode({ id: "order3", lat: 3, lng: 3 });
    graph.addNode({ id: "order4", lat: 4, lng: 4 });
    graph.addNode({ id: "unreachable", lat: 10, lng: 10 });

    // Add edges: depot -> order1 -> order2 -> order3 -> depot
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
      toNodeId: "order3",
      baseWeight: 1,
    });
    graph.addEdge({
      id: "e4",
      fromNodeId: "order3",
      toNodeId: "order4",
      baseWeight: 1,
    });
    graph.addEdge({
      id: "e5",
      fromNodeId: "order4",
      toNodeId: "depot",
      baseWeight: 1,
    });

    // Alternate path for separate routes
    graph.addEdge({
      id: "e6",
      fromNodeId: "depot",
      toNodeId: "order2",
      baseWeight: 1,
    });
    graph.addEdge({
      id: "e7",
      fromNodeId: "order2",
      toNodeId: "depot",
      baseWeight: 1,
    });

    graph.addEdge({
      id: "e8",
      fromNodeId: "depot",
      toNodeId: "order3",
      baseWeight: 1,
    });
    graph.addEdge({
      id: "e9",
      fromNodeId: "order3",
      toNodeId: "depot",
      baseWeight: 1,
    });

    graph.addEdge({
      id: "e10",
      fromNodeId: "depot",
      toNodeId: "order4",
      baseWeight: 1,
    });
    graph.addEdge({
      id: "e11",
      fromNodeId: "order4",
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

  describe("valid plans", () => {
    it("accepts an empty plan", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map<string, Order>();
      const depots = new Map([["d1", createDepot()]]);

      const result = checkPlanFeasibility(
        [],
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("accepts a single valid route", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("accepts multiple valid routes with distinct orders", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1")],
        ["v2", createVehicle("v2", "d1")],
      ]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
        ["order3", createOrder("order3", "order3", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
        createRoute("r2", "v2", 1, [
          { orderId: "order2", sequenceNo: 1 },
          { orderId: "order3", sequenceNo: 2 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("allows unassigned orders", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
        ["order3", createOrder("order3", "order3", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      // order2 and order3 are unassigned, which is allowed
      expect(result.feasible).toBe(true);
      expect(result.violations).toEqual([]);
    });
  });

  describe("route-level violations", () => {
    it("preserves route-level violations in plan result", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle("v1", "d1", "idle", 10)]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations.some((v) =>
        v.includes("exceeds vehicle capacity"),
      )).toBe(true);
    });

    it("includes route violations from multiple routes", () => {
      const graph = setupGraph();
      // Both vehicles have insufficient capacity
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1", "idle", 5)],
        ["v2", createVehicle("v2", "d1", "idle", 5)],
      ]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
        createRoute("r2", "v2", 1, [
          { orderId: "order2", sequenceNo: 1 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      // Both routes should have capacity violations
      const capacityViolations = result.violations.filter((v) =>
        v.includes("exceeds vehicle capacity"),
      );
      expect(capacityViolations.length).toBe(2);
    });
  });

  describe("same order appearing twice within one route", () => {
    it("reports route-level violation, not plan-level duplicate", () => {
      const graph = setupGraph();
      const vehicles = new Map([["v1", createVehicle()]]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order1", sequenceNo: 2 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      // Should have route-level duplicate violation, not plan-level
      expect(result.violations.some((v) =>
        v.includes("appears multiple times in the route"),
      )).toBe(true);
      expect(result.violations.some((v) =>
        v.includes("assigned to multiple routes"),
      )).toBe(false);
    });
  });

  describe("plan-level violations: same order in different routes", () => {
    it("detects order assigned to two different routes", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1")],
        ["v2", createVehicle("v2", "d1")],
      ]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
        createRoute("r2", "v2", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations.some((v) =>
        v.includes("Order order1 is assigned to multiple routes"),
      )).toBe(true);
    });

    it("reports all duplicated orders in deterministic order", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1")],
        ["v2", createVehicle("v2", "d1")],
        ["v3", createVehicle("v3", "d1")],
      ]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
        ["order3", createOrder("order3", "order3", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
        createRoute("r2", "v2", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order3", sequenceNo: 2 },
        ]),
        createRoute("r3", "v3", 1, [
          { orderId: "order2", sequenceNo: 1 },
          { orderId: "order3", sequenceNo: 2 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      const violations = result.violations;
      expect(violations).toContain(
        "Order order1 is assigned to multiple routes: r1, r2",
      );
      expect(violations).toContain(
        "Order order2 is assigned to multiple routes: r1, r3",
      );
      expect(violations).toContain(
        "Order order3 is assigned to multiple routes: r2, r3",
      );
    });

    it("reports duplicate assignment with multiple route IDs in deterministic order", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1")],
        ["v2", createVehicle("v2", "d1")],
        ["v3", createVehicle("v3", "d1")],
      ]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      // Create routes with IDs in non-alphabetical order
      const routes = [
        createRoute("r3", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
        createRoute("r1", "v2", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
        createRoute("r2", "v3", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations).toContain(
        "Order order1 is assigned to multiple routes: r1, r2, r3",
      );
    });
  });

  describe("cancelled orders", () => {
    it("does not produce plan-level duplicate-assignment violation for cancelled orders", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1")],
        ["v2", createVehicle("v2", "d1")],
      ]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10, "cancelled")],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
        createRoute("r2", "v2", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      // Should have route-level violations (cancelled order can't be assigned)
      // but NOT plan-level duplicate-assignment violation
      expect(result.violations.some((v) =>
        v.includes("is assigned to multiple routes"),
      )).toBe(false);
      // But should have the route-level violations for cancelled orders
      expect(result.violations.some((v) =>
        v.includes("is cancelled and cannot be assigned"),
      )).toBe(true);
    });

    it("excludes cancelled orders from plan-level check while including non-cancelled duplicates", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1")],
        ["v2", createVehicle("v2", "d1")],
        ["v3", createVehicle("v3", "d1")],
      ]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10, "cancelled")],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
        createRoute("r2", "v2", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
        createRoute("r3", "v3", 1, [
          { orderId: "order2", sequenceNo: 1 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      // order1 duplicates should NOT appear in plan-level violations
      const order1Violations = result.violations.filter((v) =>
        v.includes("order1") && v.includes("assigned to multiple routes"),
      );
      expect(order1Violations.length).toBe(0);

      // order2 duplicates SHOULD appear in plan-level violations
      expect(result.violations.some((v) =>
        v.includes("Order order2 is assigned to multiple routes"),
      )).toBe(true);
    });
  });

  describe("unreachable orders", () => {
    it("produces both route-level unreachable violations and plan-level duplicate-assignment violation", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1")],
        ["v2", createVehicle("v2", "d1")],
      ]);
      const orders = new Map([
        ["unreachable", createOrder("unreachable", "unreachable", 10, "unreachable")],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "unreachable", sequenceNo: 1 },
        ]),
        createRoute("r2", "v2", 1, [
          { orderId: "unreachable", sequenceNo: 1 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      // Both route-level unreachable violations and plan-level duplicate violation
      const reachabilityViolations = result.violations.filter((v) =>
        v.includes("reach") || v.includes("reachable"),
      );
      expect(reachabilityViolations.length).toBeGreaterThanOrEqual(2);

      // Plan-level violation should also be present
      expect(result.violations.some((v) =>
        v.includes("Order unreachable is assigned to multiple routes"),
      )).toBe(true);
    });
  });

  describe("complex scenarios", () => {
    it("handles mixed valid and invalid routes", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1")],
        ["v2", createVehicle("v2", "d1")],
      ]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        // Valid route
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
        // Invalid route: same order in two routes
        createRoute("r2", "v2", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations.some((v) =>
        v.includes("Order order1 is assigned to multiple routes"),
      )).toBe(true);
    });

    it("accumulates both route-level and plan-level violations", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1", "idle", 5)],
        ["v2", createVehicle("v2", "d1", "idle", 5)],
      ]);
      const orders = new Map([
        ["order1", createOrder("order1", "order1", 10)],
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        // Both have capacity violation AND shared order1
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
        createRoute("r2", "v2", 1, [
          { orderId: "order1", sequenceNo: 1 },
          { orderId: "order2", sequenceNo: 2 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      expect(result.violations.length).toBeGreaterThan(1);
      // Should have capacity violations
      expect(result.violations.some((v) =>
        v.includes("exceeds vehicle capacity"),
      )).toBe(true);
      // Should have plan-level duplicate
      expect(result.violations.some((v) =>
        v.includes("Order order1 is assigned to multiple routes"),
      )).toBe(true);
    });

    it("handles unknown orders referenced in duplicate check", () => {
      const graph = setupGraph();
      const vehicles = new Map([
        ["v1", createVehicle("v1", "d1")],
        ["v2", createVehicle("v2", "d1")],
      ]);
      // order1 is unknown, order2 is known
      const orders = new Map([
        ["order2", createOrder("order2", "order2", 10)],
      ]);
      const depots = new Map([["d1", createDepot()]]);

      const routes = [
        createRoute("r1", "v1", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
        createRoute("r2", "v2", 1, [
          { orderId: "order1", sequenceNo: 1 },
        ]),
      ];

      const result = checkPlanFeasibility(
        routes,
        vehicles,
        orders,
        depots,
        graph,
      );

      expect(result.feasible).toBe(false);
      // Should report unknown orders from routes, but not plan-level duplicate
      // since unknown orders' status cannot be evaluated
      const violations = result.violations;
      const planLevelDuplicates = violations.filter((v) =>
        v.includes("assigned to multiple routes"),
      );
      expect(planLevelDuplicates.length).toBe(0);
    });
  });
});
