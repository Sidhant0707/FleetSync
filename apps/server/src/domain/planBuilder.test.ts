import { describe, expect, it } from "vitest";
import { RoadGraph } from "./RoadGraph.js";
import {
  checkPlanFeasibility,
} from "./planFeasibility.js";
import { buildStaticPlan } from "./planBuilder.js";
import type {
  Depot,
  Order,
  Vehicle,
} from "./types.js";

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

/**
 * Depot D plus four order nodes with independent round trips.
 *
 * There are no direct order-to-order edges, so Clarke-Wright cannot construct
 * multi-stop merges in this graph. This makes vehicle-assignment outcomes
 * deterministic and easy to reason about.
 *
 * UNREACHABLE can be reached from D but has no return path to D.
 */
function buildGraph(): RoadGraph {
  const graph = new RoadGraph();

  [
    "D",
    "O1",
    "O2",
    "O3",
    "O4",
    "UNREACHABLE",
  ].forEach((id) => addNode(graph, id));

  addEdge(graph, "D", "O1", 5);
  addEdge(graph, "O1", "D", 5);

  addEdge(graph, "D", "O2", 5);
  addEdge(graph, "O2", "D", 5);

  addEdge(graph, "D", "O3", 5);
  addEdge(graph, "O3", "D", 5);

  addEdge(graph, "D", "O4", 5);
  addEdge(graph, "O4", "D", 5);

  addEdge(graph, "D", "UNREACHABLE", 5);

  return graph;
}

/**
 * Graph that produces a deterministic three-stop Clarke-Wright chain.
 */
function buildChainableGraph(): RoadGraph {
  const graph = new RoadGraph();

  ["D", "A", "B", "C"].forEach((id) =>
    addNode(graph, id),
  );

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

  return graph;
}

function createDepot(
  id = "D",
  nodeId = "D",
): Depot {
  return {
    id,
    name: `Depot ${id}`,
    nodeId,
  };
}

function createVehicle(
  id: string,
  depotId = "D",
  status: Vehicle["status"] = "idle",
  capacity = 10,
): Vehicle {
  return {
    id,
    label: `Vehicle ${id}`,
    capacity,
    depotId,
    status,
  };
}

function createOrder(
  id: string,
  nodeId: string,
  demand = 1,
  status: Order["status"] = "pending",
): Order {
  return {
    id,
    nodeId,
    demand,
    status,
  };
}

describe("buildStaticPlan", () => {
  it("builds one feasible route for a single reachable order within capacity", () => {
    const graph = buildGraph();
    const depot = createDepot();
    const vehicles = [
      createVehicle("v1"),
    ];
    const orders = [
      createOrder("O1", "O1", 3),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(result.routes).toEqual([
      {
        id: "route-v1",
        vehicleId: "v1",
        version: 1,
        stops: [
          {
            orderId: "O1",
            sequenceNo: 1,
          },
        ],
      },
    ]);

    expect(result.unassigned).toEqual([]);
    expect(result.feasibility.feasible).toBe(true);
  });

  it("excludes cancelled orders from routing and reports them as CANCELLED", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const vehicles = [
      createVehicle("v1"),
    ];

    const orders = [
      createOrder(
        "O1",
        "O1",
        1,
        "pending",
      ),
      createOrder(
        "O2",
        "O2",
        1,
        "cancelled",
      ),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(result.unassigned).toEqual([
      {
        orderId: "O2",
        reason: "CANCELLED",
      },
    ]);

    expect(
      result.routes.some((route) =>
        route.stops.some(
          (stop) => stop.orderId === "O2",
        ),
      ),
    ).toBe(false);
  });

  it("reports an order whose demand exceeds capacity", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const vehicles = [
      createVehicle(
        "v1",
        "D",
        "idle",
        5,
      ),
    ];

    const orders = [
      createOrder(
        "O1",
        "O1",
        10,
      ),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(result.unassigned).toEqual([
      {
        orderId: "O1",
        reason: "DEMAND_EXCEEDS_CAPACITY",
      },
    ]);

    expect(result.routes).toEqual([]);
    expect(result.feasibility.feasible).toBe(true);
  });

  it("reports an order with no depot round trip as UNREACHABLE", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const vehicles = [
      createVehicle("v1"),
    ];

    const orders = [
      createOrder(
        "O1",
        "UNREACHABLE",
        1,
      ),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(result.unassigned).toEqual([
      {
        orderId: "O1",
        reason: "UNREACHABLE",
      },
    ]);

    expect(result.routes).toEqual([]);
    expect(result.feasibility.feasible).toBe(true);
  });

  it("marks excess chains as NO_VEHICLE_AVAILABLE", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const vehicles = [
      createVehicle("v1"),
      createVehicle("v2"),
    ];

    const orders = [
      createOrder("O1", "O1", 1),
      createOrder("O2", "O2", 1),
      createOrder("O3", "O3", 1),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(result.routes).toHaveLength(2);

    expect(result.unassigned).toEqual([
      {
        orderId: "O3",
        reason: "NO_VEHICLE_AVAILABLE",
      },
    ]);
  });

  it("ignores vehicles based at a different depot", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const vehicles = [
      createVehicle(
        "v1",
        "OTHER_DEPOT",
      ),
    ];

    const orders = [
      createOrder("O1", "O1", 1),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(result.routes).toEqual([]);

    expect(result.unassigned).toEqual([
      {
        orderId: "O1",
        reason: "NO_VEHICLE_AVAILABLE",
      },
    ]);
  });

  it("ignores vehicles that are not idle", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const vehicles = [
      createVehicle(
        "v1",
        "D",
        "enroute",
      ),
    ];

    const orders = [
      createOrder("O1", "O1", 1),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(result.routes).toEqual([]);

    expect(result.unassigned).toEqual([
      {
        orderId: "O1",
        reason: "NO_VEHICLE_AVAILABLE",
      },
    ]);
  });

  it("handles zero eligible vehicles without skipping final feasibility", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const vehicles: Vehicle[] = [];

    const orders = [
      createOrder("O1", "O1", 1),
      createOrder("O2", "O2", 1),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(result.routes).toEqual([]);

    expect(result.unassigned).toEqual([
      {
        orderId: "O1",
        reason: "NO_VEHICLE_AVAILABLE",
      },
      {
        orderId: "O2",
        reason: "NO_VEHICLE_AVAILABLE",
      },
    ]);

    expect(result.feasibility.feasible).toBe(true);
  });

  it("throws when eligible vehicles do not share the same capacity", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const vehicles = [
      createVehicle(
        "v1",
        "D",
        "idle",
        5,
      ),
      createVehicle(
        "v2",
        "D",
        "idle",
        8,
      ),
    ];

    const orders = [
      createOrder("O1", "O1", 1),
    ];

    expect(() =>
      buildStaticPlan(
        graph,
        depot,
        orders,
        vehicles,
      ),
    ).toThrow(
      "FleetSync requires homogeneous vehicle capacity",
    );
  });

  it("throws when an eligible vehicle has an invalid capacity", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const invalidCapacities = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
    ];

    for (const capacity of invalidCapacities) {
      const vehicles = [
        createVehicle(
          "v1",
          "D",
          "idle",
          capacity,
        ),
      ];

      const orders = [
        createOrder("O1", "O1", 1),
      ];

      expect(() =>
        buildStaticPlan(
          graph,
          depot,
          orders,
          vehicles,
        ),
      ).toThrow(
        "FleetSync requires a finite non-negative vehicle capacity",
      );
    }
  });

  it("names each route deterministically after its assigned vehicle", () => {
    const graph = buildChainableGraph();
    const depot = createDepot("D", "D");

    const vehicles = [
      createVehicle("v42"),
    ];

    const orders = [
      createOrder("A", "A", 1),
      createOrder("B", "B", 1),
      createOrder("C", "C", 1),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.id).toBe(
      "route-v42",
    );
    expect(result.routes[0]?.vehicleId).toBe(
      "v42",
    );
  });

  it("assigns 1-based contiguous sequence numbers in chain order", () => {
    const graph = buildChainableGraph();
    const depot = createDepot("D", "D");

    const vehicles = [
      createVehicle("v1"),
    ];

    const orders = [
      createOrder("A", "A", 1),
      createOrder("B", "B", 1),
      createOrder("C", "C", 1),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(result.routes[0]?.stops).toEqual([
      {
        orderId: "A",
        sequenceNo: 1,
      },
      {
        orderId: "B",
        sequenceNo: 2,
      },
      {
        orderId: "C",
        sequenceNo: 3,
      },
    ]);
  });

  it("produces the same plan regardless of input array order", () => {
    const graphOne = buildGraph();
    const graphTwo = buildGraph();

    const depot = createDepot();

    const vehiclesAscending = [
      createVehicle("v1"),
      createVehicle("v2"),
    ];

    const vehiclesShuffled = [
      createVehicle("v2"),
      createVehicle("v1"),
    ];

    const ordersAscending = [
      createOrder("O1", "O1", 1),
      createOrder("O2", "O2", 1),
    ];

    const ordersShuffled = [
      createOrder("O2", "O2", 1),
      createOrder("O1", "O1", 1),
    ];

    const resultOne = buildStaticPlan(
      graphOne,
      depot,
      ordersAscending,
      vehiclesAscending,
    );

    const resultTwo = buildStaticPlan(
      graphTwo,
      depot,
      ordersShuffled,
      vehiclesShuffled,
    );

    expect(resultTwo).toEqual(resultOne);
  });

  it("returns the same feasibility result as an independent final check", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const vehicles = [
      createVehicle("v1"),
    ];

    const orders = [
      createOrder("O1", "O1", 1),
    ];

    const result = buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    const vehiclesMap = new Map(
      vehicles.map((vehicle) => [
        vehicle.id,
        vehicle,
      ]),
    );

    const ordersMap = new Map(
      orders.map((order) => [
        order.id,
        order,
      ]),
    );

    const depotsMap = new Map([
      [depot.id, depot],
    ]);

    const independentFeasibility =
      checkPlanFeasibility(
        result.routes,
        vehiclesMap,
        ordersMap,
        depotsMap,
        graph,
      );

    expect(result.feasibility).toEqual(
      independentFeasibility,
    );
  });

  it("does not mutate the input orders or vehicles arrays", () => {
    const graph = buildGraph();
    const depot = createDepot();

    const vehicles = [
      createVehicle("v2"),
      createVehicle("v1"),
    ];

    const orders = [
      createOrder("O2", "O2", 1),
      createOrder("O1", "O1", 1),
    ];

    const originalVehicles = [...vehicles];
    const originalOrders = [...orders];

    buildStaticPlan(
      graph,
      depot,
      orders,
      vehicles,
    );

    expect(vehicles).toEqual(
      originalVehicles,
    );

    expect(orders).toEqual(
      originalOrders,
    );
  });
});