import {
  describe,
  expect,
  it,
} from "vitest";

import {
  handleApiRequest,
  type ApiRequest,
} from "./router.js";

import { SimulationService } from "./simulationService.js";

const SCENARIO_KEYS = [
  "name",
  "depot",
  "nodes",
  "edges",
  "vehicles",
  "orders",
  "routes",
  "unassignedOrders",
  "serviceTimePerStop",
];

const ROUTE_KEYS = [
  "routeId",
  "vehicleId",
  "version",
  "stops",
  "legs",
  "totalTravelTime",
];

const LEG_KEYS = [
  "legIndex",
  "fromNodeId",
  "toNodeId",
  "arrivalOrderId",
  "edgeIds",
  "duration",
];

const VEHICLE_KEYS = [
  "vehicleId",
  "routeId",
  "phase",
  "currentNodeId",
  "currentEdgeId",
  "edgeElapsed",
  "edgeDuration",
  "edgeProgress",
  "legIndex",
  "nextStopSequenceNo",
  "completedEdgeIds",
  "servedOrderIds",
  "totalTravelTime",
  "completedAtSimTime",
];

const ORDER_STATUS_KEYS = [
  "orderId",
  "nodeId",
  "demand",
  "assignedRouteId",
  "sequenceNo",
  "delivered",
  "deliveredAtSimTime",
  "deliveredByVehicleId",
];

const STATE_KEYS = [
  "status",
  "simTime",
  "depotNodeId",
  "completedAtSimTime",
  "vehicles",
  "orders",
  "eventCount",
];

const EVENT_KEYS = [
  "seq",
  "simTime",
  "type",
  "vehicleId",
  "orderId",
  "edgeId",
  "nodeId",
];

function call(
  service: SimulationService,
  request: ApiRequest,
): unknown {
  return handleApiRequest(
    service,
    request,
  ).body;
}

describe("frontend/backend DTO contract", () => {
  it("keeps the scenario shape stable", () => {
    const body =
      call(
        new SimulationService(),
        {
          method: "GET",
          path:
            "/api/simulation/scenario",
        },
      ) as Record<string, unknown>;

    expect(
      Object.keys(body).sort(),
    ).toEqual(
      [...SCENARIO_KEYS].sort(),
    );

    const route =
      (body["routes"] as unknown[])[0] as Record<
        string,
        unknown
      >;

    expect(
      Object.keys(route).sort(),
    ).toEqual(
      [...ROUTE_KEYS].sort(),
    );

    const leg =
      (route["legs"] as unknown[])[0] as Record<
        string,
        unknown
      >;

    expect(
      Object.keys(leg).sort(),
    ).toEqual(
      [...LEG_KEYS].sort(),
    );
  });

  it("keeps the simulation state shape stable", () => {
    const service =
      new SimulationService();

    service.start();
    service.advance(2);

    const body =
      call(service, {
        method: "GET",
        path:
          "/api/simulation/state",
      }) as Record<string, unknown>;

    expect(
      Object.keys(body).sort(),
    ).toEqual(
      [...STATE_KEYS].sort(),
    );

    const vehicle =
      (body["vehicles"] as unknown[])[0] as Record<
        string,
        unknown
      >;

    expect(
      Object.keys(vehicle).sort(),
    ).toEqual(
      [...VEHICLE_KEYS].sort(),
    );

    const order =
      (body["orders"] as unknown[])[0] as Record<
        string,
        unknown
      >;

    expect(
      Object.keys(order).sort(),
    ).toEqual(
      [...ORDER_STATUS_KEYS].sort(),
    );
  });

  it("keeps the event shape stable", () => {
    const service =
      new SimulationService();

    service.start();

    const body =
      call(service, {
        method: "GET",
        path:
          "/api/simulation/events",
      }) as {
        events: unknown[];
        nextSeq: number;
      };

    expect(typeof body.nextSeq)
      .toBe("number");

    const event =
      body.events[0] as Record<
        string,
        unknown
      >;

    expect(
      Object.keys(event).sort(),
    ).toEqual(
      [...EVENT_KEYS].sort(),
    );
  });

  it("keeps the advance response shape stable", () => {
    const service =
      new SimulationService();

    service.start();

    const body =
      call(service, {
        method: "POST",
        path:
          "/api/simulation/advance",
        body: { delta: 1 },
      }) as Record<
        string,
        unknown
      >;

    expect(
      Object.keys(body).sort(),
    ).toEqual([
      "events",
      "state",
    ]);

    expect(
      Object.keys(
        body["state"] as object,
      ).sort(),
    ).toEqual(
      [...STATE_KEYS].sort(),
    );

    expect(
      Object.keys(
        body["events"] as object,
      ).sort(),
    ).toEqual([
      "events",
      "nextSeq",
    ]);
  });

  it("provides numeric edge progress for the map marker", () => {
    const service =
      new SimulationService();

    service.start();
    service.advance(1);

    const body =
      call(service, {
        method: "GET",
        path:
          "/api/simulation/state",
      }) as {
        vehicles: {
          currentEdgeId: string | null;
          edgeProgress: number;
        }[];
      };

    const traveling =
      body.vehicles.find(
        (vehicle) =>
          vehicle.currentEdgeId !== null,
      );

    expect(traveling).toBeDefined();
    expect(
      typeof traveling?.edgeProgress,
    ).toBe("number");
  });
});
