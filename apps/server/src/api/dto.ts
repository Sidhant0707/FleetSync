import type { SimulationEvent } from "../domain/simulationEvents.js";
import type {
  SimulationState,
  VehicleSimulationState,
} from "../domain/simulation.js";
import type {
  Order,
  Route,
} from "../domain/types.js";
import type {
  ExpandedRoute,
} from "../domain/routeExpansion.js";

export interface NodeDto {
  readonly id: string;
  readonly lat: number;
  readonly lng: number;
}

export interface EdgeDto {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly weight: number;
}

export interface RouteLegDto {
  readonly legIndex: number;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly arrivalOrderId: string | null;
  readonly edgeIds: readonly string[];
  readonly duration: number;
}

export interface RouteDto {
  readonly routeId: string;
  readonly vehicleId: string;
  readonly version: number;
  readonly stops: readonly {
    readonly orderId: string;
    readonly sequenceNo: number;
    readonly nodeId: string;
  }[];
  readonly legs: readonly RouteLegDto[];
  readonly totalTravelTime: number;
}

export interface ScenarioDto {
  readonly name: string;
  readonly depot: {
    readonly id: string;
    readonly name: string;
    readonly nodeId: string;
  };
  readonly nodes: readonly NodeDto[];
  readonly edges: readonly EdgeDto[];
  readonly vehicles: readonly {
    readonly id: string;
    readonly label: string;
    readonly capacity: number;
  }[];
  readonly orders: readonly {
    readonly id: string;
    readonly nodeId: string;
    readonly demand: number;
  }[];
  readonly routes: readonly RouteDto[];
  readonly unassignedOrders: readonly {
    readonly orderId: string;
    readonly reason: string;
  }[];
  readonly serviceTimePerStop: number;
}

export interface VehicleDto {
  readonly vehicleId: string;
  readonly routeId: string;
  readonly phase: VehicleSimulationState["phase"];
  readonly currentNodeId: string | null;
  readonly currentEdgeId: string | null;
  readonly edgeElapsed: number;
  readonly edgeDuration: number | null;
  readonly edgeProgress: number;
  readonly legIndex: number;
  readonly nextStopSequenceNo: number | null;
  readonly completedEdgeIds: readonly string[];
  readonly servedOrderIds: readonly string[];
  readonly totalTravelTime: number;
  readonly completedAtSimTime: number | null;
}

export interface OrderStatusDto {
  readonly orderId: string;
  readonly nodeId: string;
  readonly demand: number;
  readonly assignedRouteId: string | null;
  readonly sequenceNo: number | null;
  readonly delivered: boolean;
  readonly deliveredAtSimTime: number | null;
  readonly deliveredByVehicleId: string | null;
}

export interface SimulationStateDto {
  readonly status: SimulationState["status"];
  readonly simTime: number;
  readonly depotNodeId: string;
  readonly completedAtSimTime: number | null;
  readonly vehicles: readonly VehicleDto[];
  readonly orders: readonly OrderStatusDto[];
  readonly eventCount: number;
}

export interface EventDto {
  readonly seq: number;
  readonly simTime: number;
  readonly type: SimulationEvent["type"];
  readonly vehicleId: string | null;
  readonly orderId: string | null;
  readonly edgeId: string | null;
  readonly nodeId: string | null;
}

export interface EventsDto {
  readonly events: readonly EventDto[];
  readonly nextSeq: number;
}

export function toVehicleDto(
  vehicle: VehicleSimulationState,
): VehicleDto {
  return {
    vehicleId: vehicle.vehicleId,
    routeId: vehicle.routeId,
    phase: vehicle.phase,
    currentNodeId: vehicle.currentNodeId,
    currentEdgeId: vehicle.currentEdgeId,
    edgeElapsed: vehicle.edgeElapsed,
    edgeDuration: vehicle.edgeDuration,
    edgeProgress: vehicle.edgeProgress,
    legIndex: vehicle.legIndex,
    nextStopSequenceNo:
      vehicle.nextStopSequenceNo,
    completedEdgeIds: [
      ...vehicle.completedEdgeIds,
    ],
    servedOrderIds: [
      ...vehicle.servedOrderIds,
    ],
    totalTravelTime:
      vehicle.totalTravelTime,
    completedAtSimTime:
      vehicle.completedAtSimTime,
  };
}

export function toOrderStatusDtos(
  orders: readonly Order[],
  routes: readonly Route[],
  state: SimulationState,
): readonly OrderStatusDto[] {
  const assignment = new Map<
    string,
    {
      routeId: string;
      sequenceNo: number;
    }
  >();

  for (const route of routes) {
    for (const stop of route.stops) {
      assignment.set(stop.orderId, {
        routeId: route.id,
        sequenceNo: stop.sequenceNo,
      });
    }
  }

  const deliveries = new Map(
    state.deliveries.map(
      (delivery) => [
        delivery.orderId,
        delivery,
      ],
    ),
  );

  return orders
    .map(
      (
        order,
      ): OrderStatusDto => {
        const assigned =
          assignment.get(order.id) ??
          null;

        const delivery =
          deliveries.get(order.id) ??
          null;

        return {
          orderId: order.id,
          nodeId: order.nodeId,
          demand: order.demand,
          assignedRouteId:
            assigned?.routeId ?? null,
          sequenceNo:
            assigned?.sequenceNo ?? null,
          delivered:
            delivery !== null,
          deliveredAtSimTime:
            delivery?.deliveredAtSimTime ??
            null,
          deliveredByVehicleId:
            delivery?.vehicleId ?? null,
        };
      },
    )
    .sort(
      (a, b) =>
        a.orderId < b.orderId
          ? -1
          : a.orderId > b.orderId
            ? 1
            : 0,
    );
}

export function toStateDto(
  state: SimulationState,
  orders: readonly Order[],
  routes: readonly Route[],
  eventCount: number,
): SimulationStateDto {
  return {
    status: state.status,
    simTime: state.simTime,
    depotNodeId: state.depotNodeId,
    completedAtSimTime:
      state.completedAtSimTime,
    vehicles: state.vehicles.map(
      toVehicleDto,
    ),
    orders: toOrderStatusDtos(
      orders,
      routes,
      state,
    ),
    eventCount,
  };
}

export function toEventDto(
  event: SimulationEvent,
): EventDto {
  const base = {
    seq: event.seq,
    simTime: event.simTime,
    type: event.type,
    vehicleId: null,
    orderId: null,
    edgeId: null,
    nodeId: null,
  } satisfies EventDto;

  switch (event.type) {
    case "simulation.started":
    case "simulation.completed":
      return base;

    case "vehicle.departed":
      return {
        ...base,
        vehicleId: event.vehicleId,
        nodeId: event.fromNodeId,
      };

    case "vehicle.edge_entered":
      return {
        ...base,
        vehicleId: event.vehicleId,
        edgeId: event.edgeId,
        nodeId: event.fromNodeId,
      };

    case "vehicle.edge_completed":
      return {
        ...base,
        vehicleId: event.vehicleId,
        edgeId: event.edgeId,
        nodeId: event.toNodeId,
      };

    case "order.served":
      return {
        ...base,
        vehicleId: event.vehicleId,
        orderId: event.orderId,
        nodeId: event.nodeId,
      };

    case "vehicle.route_completed":
      return {
        ...base,
        vehicleId: event.vehicleId,
        nodeId: event.depotNodeId,
      };
  }
}

export function toRouteDto(
  route: Route,
  expanded: ExpandedRoute,
  orders: readonly Order[],
): RouteDto {
  const nodeIdByOrderId =
    new Map(
      orders.map(
        (order) => [
          order.id,
          order.nodeId,
        ],
      ),
    );

  return {
    routeId: route.id,
    vehicleId: route.vehicleId,
    version: route.version,
    stops: route.stops.map(
      (stop) => ({
        orderId: stop.orderId,
        sequenceNo: stop.sequenceNo,
        nodeId:
          nodeIdByOrderId.get(
            stop.orderId,
          ) ?? "",
      }),
    ),
    legs: expanded.legs.map(
      (leg) => ({
        legIndex: leg.legIndex,
        fromNodeId: leg.fromNodeId,
        toNodeId: leg.toNodeId,
        arrivalOrderId:
          leg.arrivalOrderId,
        edgeIds: [...leg.edgeIds],
        duration: leg.duration,
      }),
    ),
    totalTravelTime:
      expanded.totalTravelTime,
  };
}