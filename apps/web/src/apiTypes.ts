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

export type VehiclePhase =
  | "idle_at_depot"
  | "traveling"
  | "servicing"
  | "completed";

export type SimulationStatus = "not_started" | "running" | "completed";

export interface VehicleDto {
  readonly vehicleId: string;
  readonly routeId: string;
  readonly phase: VehiclePhase;
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
  readonly status: SimulationStatus;
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
  readonly type: string;
  readonly vehicleId: string | null;
  readonly orderId: string | null;
  readonly edgeId: string | null;
  readonly nodeId: string | null;
}

export interface EventsDto {
  readonly events: readonly EventDto[];
  readonly nextSeq: number;
}