import type {
  EdgeDto,
  EventDto,
  NodeDto,
  RouteDto,
  ScenarioDto,
  SimulationStateDto,
  VehicleDto,
} from "./apiTypes.js";

/**
 * Turns API responses into everything the page renders.
 *
 * This module is deliberately DOM-free and derives every value from backend
 * state: no positions, deliveries or progress are invented here.
 */

export interface ChainStopView {
  readonly nodeId: string;
  readonly label: string;
  readonly state: "done" | "current" | "pending";
}

export interface VehicleView {
  readonly vehicleId: string;
  readonly routeId: string;
  readonly phase: string;
  readonly phaseLabel: string;
  readonly locationLabel: string;
  readonly currentNodeId: string | null;
  readonly currentEdgeId: string | null;
  readonly edgeProgressPercent: number;
  readonly routeProgressPercent: number;
  readonly servedOrderIds: readonly string[];
  readonly totalTravelTime: number;
  readonly routeTravelTime: number;
  readonly chain: readonly ChainStopView[];
}

export interface OrderView {
  readonly orderId: string;
  readonly nodeId: string;
  readonly assignedTo: string;
  readonly delivered: boolean;
  readonly statusLabel: string;
}

export interface EventView {
  readonly seq: number;
  readonly simTime: number;
  readonly type: string;
  readonly detail: string;
}

export interface NodeLayout {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly isDepot: boolean;
}

export interface VehicleMarker {
  readonly vehicleId: string;
  readonly x: number;
  readonly y: number;
}

export interface DashboardView {
  readonly scenarioName: string;
  readonly statusLabel: string;
  readonly simTime: number;
  readonly canStart: boolean;
  readonly canAdvance: boolean;
  readonly isCompleted: boolean;
  readonly deliveredCount: number;
  readonly orderCount: number;
  readonly vehicles: readonly VehicleView[];
  readonly orders: readonly OrderView[];
  readonly events: readonly EventView[];
  readonly layout: readonly NodeLayout[];
  readonly markers: readonly VehicleMarker[];
}

const PHASE_LABELS: Readonly<Record<string, string>> = {
  idle_at_depot: "Idle at depot",
  traveling: "Traveling",
  servicing: "Servicing",
  completed: "Completed",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  not_started: "Not started",
  running: "Running",
  completed: "Completed",
};

export const LAYOUT_WIDTH = 640;
export const LAYOUT_HEIGHT = 360;
const LAYOUT_PADDING = 44;

export function buildDashboardView(
  scenario: ScenarioDto,
  state: SimulationStateDto,
  events: readonly EventDto[],
): DashboardView {
  const layout = computeLayout(scenario.nodes, state.depotNodeId);

  const routesByVehicle = new Map(
    scenario.routes.map((route) => [route.vehicleId, route]),
  );

  const vehicles = state.vehicles.map((vehicle) =>
    buildVehicleView(
      vehicle,
      routesByVehicle.get(vehicle.vehicleId) ?? null,
    ),
  );

  return {
    scenarioName: scenario.name,
    statusLabel: STATUS_LABELS[state.status] ?? state.status,
    simTime: state.simTime,
    canStart: state.status === "not_started",
    canAdvance: state.status === "running",
    isCompleted: state.status === "completed",
    deliveredCount: state.orders.filter((order) => order.delivered).length,
    orderCount: state.orders.length,
    vehicles,
    orders: state.orders.map((order) => ({
      orderId: order.orderId,
      nodeId: order.nodeId,
      assignedTo: order.assignedRouteId ?? "unassigned",
      delivered: order.delivered,
      statusLabel: order.delivered
        ? `Delivered at t=${String(order.deliveredAtSimTime ?? 0)} by ${String(order.deliveredByVehicleId ?? "?")}`
        : "Pending",
    })),
    events: events.map(toEventView),
    layout,
    markers: state.vehicles
      .map((vehicle) =>
        computeVehicleMarker(vehicle, layout, scenario.edges),
      )
      .filter((marker): marker is VehicleMarker => marker !== null),
  };
}

function buildVehicleView(
  vehicle: VehicleDto,
  route: RouteDto | null,
): VehicleView {
  const routeTravelTime = route?.totalTravelTime ?? 0;

  return {
    vehicleId: vehicle.vehicleId,
    routeId: vehicle.routeId,
    phase: vehicle.phase,
    phaseLabel: PHASE_LABELS[vehicle.phase] ?? vehicle.phase,
    locationLabel:
      vehicle.currentEdgeId !== null
        ? `On edge ${vehicle.currentEdgeId}`
        : `At node ${vehicle.currentNodeId ?? "?"}`,
    currentNodeId: vehicle.currentNodeId,
    currentEdgeId: vehicle.currentEdgeId,
    edgeProgressPercent: round(vehicle.edgeProgress * 100),
    routeProgressPercent:
      routeTravelTime === 0
        ? vehicle.phase === "completed"
          ? 100
          : 0
        : round((vehicle.totalTravelTime / routeTravelTime) * 100),
    servedOrderIds: vehicle.servedOrderIds,
    totalTravelTime: vehicle.totalTravelTime,
    routeTravelTime,
    chain: buildChain(vehicle, route),
  };
}

function buildChain(
  vehicle: VehicleDto,
  route: RouteDto | null,
): readonly ChainStopView[] {
  if (route === null) {
    return [];
  }

  const served = new Set(vehicle.servedOrderIds);
  const depotNodeId = route.legs[0]?.fromNodeId ?? "";

  const chain: ChainStopView[] = [
    {
      nodeId: depotNodeId,
      label: "Depot",
      state: vehicle.phase === "idle_at_depot" ? "current" : "done",
    },
  ];

  let currentAssigned = false;

  for (const stop of route.stops) {
    const isDone = served.has(stop.orderId);
    let stopState: ChainStopView["state"] = "pending";

    if (isDone) {
      stopState = "done";
    } else if (!currentAssigned && vehicle.phase !== "idle_at_depot") {
      stopState = "current";
      currentAssigned = true;
    }

    chain.push({
      nodeId: stop.nodeId,
      label: stop.orderId,
      state: stopState,
    });
  }

  chain.push({
    nodeId: depotNodeId,
    label: "Depot",
    state:
      vehicle.phase === "completed"
        ? "done"
        : currentAssigned
          ? "pending"
          : "current",
  });

  return chain;
}

function toEventView(event: EventDto): EventView {
  const parts: string[] = [];

  if (event.vehicleId !== null) {
    parts.push(event.vehicleId);
  }

  if (event.orderId !== null) {
    parts.push(`order ${event.orderId}`);
  }

  if (event.edgeId !== null) {
    parts.push(`edge ${event.edgeId}`);
  } else if (event.nodeId !== null) {
    parts.push(`node ${event.nodeId}`);
  }

  return {
    seq: event.seq,
    simTime: event.simTime,
    type: event.type,
    detail: parts.join(" · "),
  };
}

/** Projects lat/lng onto the SVG canvas. Purely presentational. */
export function computeLayout(
  nodes: readonly NodeDto[],
  depotNodeId: string,
): readonly NodeLayout[] {
  if (nodes.length === 0) {
    return [];
  }

  const lats = nodes.map((node) => node.lat);
  const lngs = nodes.map((node) => node.lng);

  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const spanLat = maxLat - minLat || 1;
  const spanLng = maxLng - minLng || 1;

  const usableWidth = LAYOUT_WIDTH - LAYOUT_PADDING * 2;
  const usableHeight = LAYOUT_HEIGHT - LAYOUT_PADDING * 2;

  return nodes.map((node) => ({
    id: node.id,
    x: round(
      LAYOUT_PADDING +
        ((node.lng - minLng) / spanLng) * usableWidth,
    ),
    y: round(
      LAYOUT_PADDING +
        ((maxLat - node.lat) / spanLat) * usableHeight,
    ),
    isDepot: node.id === depotNodeId,
  }));
}

export function computeVehicleMarker(
  vehicle: VehicleDto,
  layout: readonly NodeLayout[],
  edges: readonly EdgeDto[],
): VehicleMarker | null {
  const positions = new Map(layout.map((node) => [node.id, node]));

  if (vehicle.currentNodeId !== null) {
    const node = positions.get(vehicle.currentNodeId);

    return node === undefined
      ? null
      : {
          vehicleId: vehicle.vehicleId,
          x: node.x,
          y: node.y,
        };
  }

  if (vehicle.currentEdgeId === null) {
    return null;
  }

  const edge = edges.find(
    (candidate) => candidate.id === vehicle.currentEdgeId,
  );

  if (edge === undefined) {
    return null;
  }

  const from = positions.get(edge.fromNodeId);
  const to = positions.get(edge.toNodeId);

  if (from === undefined || to === undefined) {
    return null;
  }

  return {
    vehicleId: vehicle.vehicleId,
    x: round(
      from.x + (to.x - from.x) * vehicle.edgeProgress,
    ),
    y: round(
      from.y + (to.y - from.y) * vehicle.edgeProgress,
    ),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}