import { describe, expect, it } from "vitest";

import {
  buildDashboardView,
  computeLayout,
  computeVehicleMarker,
} from "./viewModel.js";

import type {
  EdgeDto,
  EventDto,
  NodeDto,
  ScenarioDto,
  SimulationStateDto,
  VehicleDto,
} from "./apiTypes.js";

function scenario(): ScenarioDto {
  return {
    name: "Test fleet",
    depot: {
      id: "depot-1",
      name: "Depot",
      nodeId: "D",
    },
    nodes: [
      { id: "D", lat: 0, lng: 0 },
      { id: "A", lat: 1, lng: 0 },
      { id: "B", lat: 1, lng: 1 },
    ],
    edges: [
      {
        id: "D-A",
        fromNodeId: "D",
        toNodeId: "A",
        weight: 4,
      },
      {
        id: "A-D",
        fromNodeId: "A",
        toNodeId: "D",
        weight: 4,
      },
      {
        id: "A-B",
        fromNodeId: "A",
        toNodeId: "B",
        weight: 2,
      },
      {
        id: "B-D",
        fromNodeId: "B",
        toNodeId: "D",
        weight: 6,
      },
    ],
    vehicles: [
      {
        id: "v1",
        label: "Van 1",
        capacity: 10,
      },
    ],
    orders: [
      {
        id: "o1",
        nodeId: "A",
        demand: 3,
      },
      {
        id: "o2",
        nodeId: "B",
        demand: 4,
      },
    ],
    routes: [
      {
        routeId: "route-v1",
        vehicleId: "v1",
        version: 1,
        stops: [
          {
            orderId: "o1",
            sequenceNo: 1,
            nodeId: "A",
          },
          {
            orderId: "o2",
            sequenceNo: 2,
            nodeId: "B",
          },
        ],
        legs: [
          {
            legIndex: 0,
            fromNodeId: "D",
            toNodeId: "A",
            arrivalOrderId: "o1",
            edgeIds: ["D-A"],
            duration: 4,
          },
          {
            legIndex: 1,
            fromNodeId: "A",
            toNodeId: "B",
            arrivalOrderId: "o2",
            edgeIds: ["A-B"],
            duration: 2,
          },
          {
            legIndex: 2,
            fromNodeId: "B",
            toNodeId: "D",
            arrivalOrderId: null,
            edgeIds: ["B-D"],
            duration: 6,
          },
        ],
        totalTravelTime: 12,
      },
    ],
    unassignedOrders: [],
    serviceTimePerStop: 0,
  };
}

function vehicle(
  overrides: Partial<VehicleDto> = {},
): VehicleDto {
  return {
    vehicleId: "v1",
    routeId: "route-v1",
    phase: "idle_at_depot",
    currentNodeId: "D",
    currentEdgeId: null,
    edgeElapsed: 0,
    edgeDuration: null,
    edgeProgress: 0,
    legIndex: 0,
    nextStopSequenceNo: 1,
    completedEdgeIds: [],
    servedOrderIds: [],
    totalTravelTime: 0,
    completedAtSimTime: null,
    ...overrides,
  };
}

function state(
  overrides: Partial<SimulationStateDto> = {},
): SimulationStateDto {
  return {
    status: "not_started",
    simTime: 0,
    depotNodeId: "D",
    completedAtSimTime: null,
    vehicles: [vehicle()],
    orders: [
      {
        orderId: "o1",
        nodeId: "A",
        demand: 3,
        assignedRouteId: "route-v1",
        sequenceNo: 1,
        delivered: false,
        deliveredAtSimTime: null,
        deliveredByVehicleId: null,
      },
      {
        orderId: "o2",
        nodeId: "B",
        demand: 4,
        assignedRouteId: "route-v1",
        sequenceNo: 2,
        delivered: false,
        deliveredAtSimTime: null,
        deliveredByVehicleId: null,
      },
    ],
    eventCount: 0,
    ...overrides,
  };
}

describe("computeLayout", () => {
  it("projects nodes into the SVG canvas and flags the depot", () => {
    const layout = computeLayout(
      scenario().nodes,
      "D",
    );

    expect(
      layout.find((node) => node.id === "D")?.isDepot,
    ).toBe(true);

    expect(
      layout.find((node) => node.id === "A")?.isDepot,
    ).toBe(false);

    expect(layout).toHaveLength(3);
  });

  it("returns an empty layout for no nodes", () => {
    expect(computeLayout([], "D")).toEqual([]);
  });
});

describe("computeVehicleMarker", () => {
  const nodes: readonly NodeDto[] = scenario().nodes;
  const edges: readonly EdgeDto[] = scenario().edges;
  const layout = computeLayout(nodes, "D");

  it("places a stationary vehicle at its node", () => {
    const marker = computeVehicleMarker(
      vehicle({
        currentNodeId: "A",
        currentEdgeId: null,
      }),
      layout,
      edges,
    );

    const nodeA = layout.find(
      (node) => node.id === "A",
    );

    expect(marker).toEqual({
      vehicleId: "v1",
      x: nodeA?.x,
      y: nodeA?.y,
    });
  });

  it("interpolates a vehicle along its current edge", () => {
    const marker = computeVehicleMarker(
      vehicle({
        currentNodeId: null,
        currentEdgeId: "D-A",
        edgeProgress: 0.25,
      }),
      layout,
      edges,
    );

    const from = layout.find(
      (node) => node.id === "D",
    )!;

    const to = layout.find(
      (node) => node.id === "A",
    )!;

    expect(marker?.x).toBeCloseTo(
      from.x + (to.x - from.x) * 0.25,
      5,
    );

    expect(marker?.y).toBeCloseTo(
      from.y + (to.y - from.y) * 0.25,
      5,
    );
  });

  it("returns null for an unknown edge", () => {
    const marker = computeVehicleMarker(
      vehicle({
        currentNodeId: null,
        currentEdgeId: "ghost-edge",
      }),
      layout,
      edges,
    );

    expect(marker).toBeNull();
  });
});

describe("buildDashboardView", () => {
  it("marks a fresh simulation as startable", () => {
    const view = buildDashboardView(
      scenario(),
      state(),
      [],
    );

    expect(view.statusLabel).toBe("Not started");
    expect(view.canStart).toBe(true);
    expect(view.canAdvance).toBe(false);
    expect(view.isCompleted).toBe(false);
    expect(view.deliveredCount).toBe(0);
    expect(view.orderCount).toBe(2);
  });

  it("reflects vehicle and route progress", () => {
    const view = buildDashboardView(
      scenario(),
      state({
        status: "running",
        simTime: 2,
        vehicles: [
          vehicle({
            phase: "traveling",
            currentNodeId: null,
            currentEdgeId: "D-A",
            edgeElapsed: 2,
            edgeDuration: 4,
            edgeProgress: 0.5,
            totalTravelTime: 2,
          }),
        ],
      }),
      [],
    );

    const vehicleView = view.vehicles[0];

    expect(vehicleView?.phaseLabel).toBe("Traveling");
    expect(vehicleView?.locationLabel).toBe(
      "On edge D-A",
    );
    expect(vehicleView?.edgeProgressPercent).toBe(50);
    expect(
      vehicleView?.routeProgressPercent,
    ).toBeCloseTo(16.67, 1);
  });

  it("shows delivered orders using backend data", () => {
    const view = buildDashboardView(
      scenario(),
      state({
        orders: [
          {
            orderId: "o1",
            nodeId: "A",
            demand: 3,
            assignedRouteId: "route-v1",
            sequenceNo: 1,
            delivered: true,
            deliveredAtSimTime: 4,
            deliveredByVehicleId: "v1",
          },
          {
            orderId: "o2",
            nodeId: "B",
            demand: 4,
            assignedRouteId: "route-v1",
            sequenceNo: 2,
            delivered: false,
            deliveredAtSimTime: null,
            deliveredByVehicleId: null,
          },
        ],
      }),
      [],
    );

    expect(view.deliveredCount).toBe(1);

    expect(view.orders[0]).toMatchObject({
      orderId: "o1",
      delivered: true,
      statusLabel: "Delivered at t=4 by v1",
    });

    expect(view.orders[1]).toMatchObject({
      orderId: "o2",
      delivered: false,
      statusLabel: "Pending",
    });
  });

  it("derives chain state from served orders", () => {
    const view = buildDashboardView(
      scenario(),
      state({
        vehicles: [
          vehicle({
            phase: "traveling",
            currentNodeId: null,
            currentEdgeId: "A-B",
            servedOrderIds: ["o1"],
          }),
        ],
      }),
      [],
    );

    expect(
      view.vehicles[0]?.chain.map(
        (stop) => stop.state,
      ),
    ).toEqual([
      "done",
      "done",
      "current",
      "pending",
    ]);
  });

  it("reports completion state correctly", () => {
    const view = buildDashboardView(
      scenario(),
      state({
        status: "completed",
        simTime: 12,
        completedAtSimTime: 12,
        vehicles: [
          vehicle({
            phase: "completed",
            currentNodeId: "D",
            currentEdgeId: null,
            servedOrderIds: ["o1", "o2"],
            totalTravelTime: 12,
            completedAtSimTime: 12,
          }),
        ],
        orders: [
          {
            orderId: "o1",
            nodeId: "A",
            demand: 3,
            assignedRouteId: "route-v1",
            sequenceNo: 1,
            delivered: true,
            deliveredAtSimTime: 6,
            deliveredByVehicleId: "v1",
          },
          {
            orderId: "o2",
            nodeId: "B",
            demand: 4,
            assignedRouteId: "route-v1",
            sequenceNo: 2,
            delivered: true,
            deliveredAtSimTime: 8,
            deliveredByVehicleId: "v1",
          },
        ],
      }),
      [],
    );

    expect(view.isCompleted).toBe(true);
    expect(view.canAdvance).toBe(false);
    expect(view.deliveredCount).toBe(2);
    expect(
      view.vehicles[0]?.routeProgressPercent,
    ).toBe(100);

    expect(
      view.vehicles[0]?.chain.every(
        (stop) => stop.state === "done",
      ),
    ).toBe(true);
  });

  it("renders event detail", () => {
    const events: readonly EventDto[] = [
      {
        seq: 4,
        simTime: 5,
        type: "order.served",
        vehicleId: "v1",
        orderId: "o1",
        edgeId: null,
        nodeId: "A",
      },
      {
        seq: 3,
        simTime: 5,
        type: "vehicle.edge_completed",
        vehicleId: "v1",
        orderId: null,
        edgeId: "D-A",
        nodeId: "A",
      },
    ];

    const view = buildDashboardView(
      scenario(),
      state(),
      events,
    );

    expect(view.events).toEqual([
      {
        seq: 4,
        simTime: 5,
        type: "order.served",
        detail: "v1 · order o1 · node A",
      },
      {
        seq: 3,
        simTime: 5,
        type: "vehicle.edge_completed",
        detail: "v1 · edge D-A",
      },
    ]);
  });

  it("does not fabricate a vehicle position", () => {
    const view = buildDashboardView(
      scenario(),
      state({
        vehicles: [
          vehicle({
            currentNodeId: null,
            currentEdgeId: null,
          }),
        ],
      }),
      [],
    );

    expect(view.markers).toEqual([]);
  });
});