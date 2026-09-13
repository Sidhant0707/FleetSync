export interface RoadNode {
  readonly id: string;
  readonly lat: number;
  readonly lng: number;
}

export type EdgeStatus = "open" | "closed";

export interface RoadEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly baseWeight: number;
  readonly currentWeight: number;
  readonly status: EdgeStatus;
}

export interface Depot {
  readonly id: string;
  readonly name: string;
  readonly nodeId: string;
}

export type VehicleStatus = "idle" | "enroute" | "broken_down";

export interface Vehicle {
  readonly id: string;
  readonly label: string;
  readonly capacity: number;
  readonly depotId: string;
  readonly status: VehicleStatus;
}

export type OrderStatus =
  | "pending"
  | "assigned"
  | "unreachable"
  | "delivered"
  | "cancelled";

export interface SoftTimeWindow {
  readonly earliest: number;
  readonly latest: number;
}

export interface Order {
  readonly id: string;
  readonly nodeId: string;
  readonly demand: number;
  readonly window?: SoftTimeWindow;
  readonly status: OrderStatus;
}

export interface RouteStop {
  readonly orderId: string;
  readonly sequenceNo: number;
}

export interface Route {
  readonly id: string;
  readonly vehicleId: string;
  readonly version: number;
  readonly stops: readonly RouteStop[];
}
