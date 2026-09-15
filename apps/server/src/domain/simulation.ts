import type { RoadGraph } from "./RoadGraph.js";
import type { Depot, Order, Route, Vehicle } from "./types.js";
import { checkPlanFeasibility } from "./planFeasibility.js";
import { SimulationClock } from "./simulationClock.js";
import {
  expandRoute,
  type ExpandedRoute,
  type RouteLeg,
} from "./routeExpansion.js";
import {
  SimulationEventLog,
  type SimulationEvent,
  type SimulationEventInput,
} from "./simulationEvents.js";

export type SimulationStatus = "not_started" | "running" | "completed";

export type VehiclePhase =
  | "idle_at_depot"
  | "traveling"
  | "servicing"
  | "completed";

export interface VehicleSimulationState {
  readonly vehicleId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly phase: VehiclePhase;

  /** Set when the vehicle sits on a node; null while it is on an edge. */
  readonly currentNodeId: string | null;
  readonly currentEdgeId: string | null;
  readonly edgeElapsed: number;

  /** Locked when the edge is entered; null while the vehicle is at a node. */
  readonly edgeDuration: number | null;

  /** Convenience for rendering only; never read by transition logic. */
  readonly edgeProgress: number;

  readonly legIndex: number;
  readonly edgeIndexInLeg: number;
  readonly nextStopSequenceNo: number | null;

  /** Append-only history. Earlier snapshots are always a prefix of later ones. */
  readonly completedEdgeIds: readonly string[];
  readonly completedLegIndexes: readonly number[];
  readonly servedOrderIds: readonly string[];

  readonly serviceElapsed: number;
  readonly totalTravelTime: number;
  readonly departedAtSimTime: number | null;
  readonly completedAtSimTime: number | null;
}

export interface OrderDeliveryRecord {
  readonly orderId: string;
  readonly nodeId: string;
  readonly vehicleId: string;
  readonly routeId: string;
  readonly sequenceNo: number;
  readonly deliveredAtSimTime: number;
}

export interface SimulationState {
  readonly status: SimulationStatus;
  readonly simTime: number;
  readonly depotNodeId: string;
  /** Sorted by vehicleId ascending. */
  readonly vehicles: readonly VehicleSimulationState[];
  /** In delivery order. */
  readonly deliveries: readonly OrderDeliveryRecord[];
  readonly completedAtSimTime: number | null;
}

export interface SimulationEngineOptions {
  readonly graph: RoadGraph;
  readonly depot: Depot;
  readonly routes: readonly Route[];
  readonly orders: readonly Order[];
  readonly vehicles: readonly Vehicle[];

  /** Real-time playback factor only; never affects state transitions. */
  readonly clockMultiplier?: number;

  /** Simulation-time units spent at each stop before the order is served. */
  readonly serviceTimePerStop?: number;
}

interface VehicleRuntime {
  readonly vehicleId: string;
  readonly expanded: ExpandedRoute;
  phase: VehiclePhase;
  currentNodeId: string | null;
  currentEdgeId: string | null;
  edgeElapsed: number;
  edgeDuration: number | null;
  legIndex: number;
  edgeIndexInLeg: number;
  serviceElapsed: number;
  totalTravelTime: number;
  departedAtSimTime: number | null;
  completedAtSimTime: number | null;
  readonly completedEdgeIds: string[];
  readonly completedLegIndexes: number[];
  readonly servedOrderIds: string[];
}

/**
 * Deterministic discrete-event execution of a static FleetSync plan.
 *
 * Time only ever moves through explicit `advanceBy` deltas: the engine never
 * reads a wall clock, sleeps, or schedules timers. A real-time playback driver
 * is expected to live outside the domain and simply call `advanceBy` with
 * `clock.toSimDuration(realElapsed)`.
 *
 * Nothing supplied by the caller is mutated. In particular `Order.status` is
 * left untouched: delivery is recorded in this engine's own state, so vehicle
 * capacity and order records remain exactly as the caller owns them.
 */
export class SimulationEngine {
  readonly #graph: RoadGraph;
  readonly #depotNodeId: string;
  readonly #serviceTimePerStop: number;
  readonly #clock: SimulationClock;
  readonly #log = new SimulationEventLog();
  readonly #runtimes: readonly VehicleRuntime[];
  readonly #maxSteps: number;
  readonly #deliveries: OrderDeliveryRecord[] = [];
  #status: SimulationStatus = "not_started";
  #completedAtSimTime: number | null = null;

  constructor(options: SimulationEngineOptions) {
    const serviceTimePerStop = options.serviceTimePerStop ?? 0;
    if (!Number.isFinite(serviceTimePerStop) || serviceTimePerStop < 0) {
      throw new Error(
        `Invalid service time per stop: ${String(serviceTimePerStop)}; expected a non-negative finite number`,
      );
    }

    // SimulationClock validates the multiplier and owns its error message.
    this.#clock = new SimulationClock({
      multiplier: options.clockMultiplier ?? 1,
    });

    this.#graph = options.graph;
    this.#serviceTimePerStop = serviceTimePerStop;
    this.#depotNodeId = options.depot.nodeId;

    if (!options.graph.hasNode(options.depot.nodeId)) {
      throw new Error(
        `Depot node ${options.depot.nodeId} for depot ${options.depot.id} does not exist in graph`,
      );
    }

    const vehiclesMap = new Map<string, Vehicle>();
    for (const vehicle of options.vehicles) {
      vehiclesMap.set(vehicle.id, vehicle);
    }

    const ordersMap = new Map<string, Order>();
    for (const order of options.orders) {
      ordersMap.set(order.id, order);
    }

    const depotsMap = new Map<string, Depot>([
      [options.depot.id, options.depot],
    ]);

    // Caller arrays are copied before sorting.
    const sortedRoutes = [...options.routes].sort((a, b) => {
      const byVehicle = compareIds(a.vehicleId, b.vehicleId);
      return byVehicle !== 0 ? byVehicle : compareIds(a.id, b.id);
    });

    const routeIdByVehicleId = new Map<string, string>();
    for (const route of sortedRoutes) {
      if (!vehiclesMap.has(route.vehicleId)) {
        throw new Error(
          `Route ${route.id} references unknown vehicle ${route.vehicleId}`,
        );
      }

      const existingRouteId = routeIdByVehicleId.get(route.vehicleId);
      if (existingRouteId !== undefined) {
        throw new Error(
          `Vehicle ${route.vehicleId} has more than one route: ${existingRouteId}, ${route.id}`,
        );
      }

      routeIdByVehicleId.set(route.vehicleId, route.id);
    }

    // Single authoritative pre-flight gate. Feasibility logic is not
    // duplicated here: constraint 11 of checkRouteFeasibility already proves
    // an open-edge path exists for every leg this engine will traverse.
    const feasibility = checkPlanFeasibility(
      sortedRoutes,
      vehiclesMap,
      ordersMap,
      depotsMap,
      options.graph,
    );

    if (!feasibility.feasible) {
      throw new Error(
        `Simulation requires a feasible plan; violations: ${feasibility.violations.join("; ")}`,
      );
    }

    const runtimes: VehicleRuntime[] = [];
    let transitionBudget = 0;

    for (const route of sortedRoutes) {
      const expansion = expandRoute(
        route,
        ordersMap,
        options.depot.nodeId,
        options.graph,
      );

      if (!expansion.ok) {
        throw new Error(
          `Cannot expand route ${route.id}: ${expansion.reason}; ${expansion.detail}`,
        );
      }

      const expanded = expansion.expanded;

      runtimes.push({
        vehicleId: route.vehicleId,
        expanded,
        phase: "idle_at_depot",
        currentNodeId: options.depot.nodeId,
        currentEdgeId: null,
        edgeElapsed: 0,
        edgeDuration: null,
        legIndex: 0,
        edgeIndexInLeg: 0,
        serviceElapsed: 0,
        totalTravelTime: 0,
        departedAtSimTime: null,
        completedAtSimTime: null,
        completedEdgeIds: [],
        completedLegIndexes: [],
        servedOrderIds: [],
      });

      for (const leg of expanded.legs) {
        transitionBudget += leg.edgeIds.length + 2;
      }
    }

    this.#runtimes = Object.freeze(runtimes);
    this.#maxSteps = transitionBudget * 4 + 64;
  }

  /**
   * Emits `simulation.started`, then departs every routed vehicle in ascending
   * vehicleId order. A vehicle whose route has no stops completes immediately.
   */
  start(): readonly SimulationEvent[] {
    if (this.#status !== "not_started") {
      throw new Error("Simulation has already been started");
    }

    const from = this.#log.size;
    this.#status = "running";

    this.#emit({
      simTime: this.#clock.simTime,
      type: "simulation.started",
      vehicleIds: Object.freeze(
        this.#runtimes.map((runtime) => runtime.vehicleId),
      ),
    });

    for (const runtime of this.#runtimes) {
      if (runtime.expanded.legs.length === 0) {
        this.#completeRoute(runtime);
      } else {
        this.#beginLeg(runtime);
      }
    }

    this.#settle();

    return this.#log.since(from);
  }

  /**
   * Advances simulation time by `delta` units and returns the events emitted
   * during this call.
   *
   * The loop always stops at the exact instant of the next transition, so the
   * result is independent of how a total delta is partitioned across calls.
   * Once the simulation completes, the clock stops: remaining budget is
   * discarded and `simTime` stays at the makespan.
   */
  advanceBy(delta: number): readonly SimulationEvent[] {
    if (this.#status === "not_started") {
      throw new Error("Cannot advance a simulation that has not been started");
    }

    if (!Number.isFinite(delta) || delta < 0) {
      throw new Error(
        `Invalid simulation time delta: ${String(delta)}; expected a non-negative finite number`,
      );
    }

    const from = this.#log.size;

    if (this.#isCompleted()) {
      return this.#log.since(from);
    }

    let remaining = delta;
    let steps = 0;

    while (remaining > 0) {
      if (++steps > this.#maxSteps) {
        throw new Error(
          "Simulation exceeded its maximum transition budget while advancing",
        );
      }

      const nextTransition = this.#timeToNextTransition();
      if (!Number.isFinite(nextTransition)) {
        break;
      }

      const step = Math.min(nextTransition, remaining);
      this.#applyProgress(step);
      this.#clock.advance(step);
      remaining -= step;

      this.#settle();

      if (this.#isCompleted()) {
        break;
      }
    }

    return this.#log.since(from);
  }

  getState(): SimulationState {
    return Object.freeze({
      status: this.#status,
      simTime: this.#clock.simTime,
      depotNodeId: this.#depotNodeId,
      vehicles: Object.freeze(
        this.#runtimes.map((runtime) => this.#snapshotVehicle(runtime)),
      ),
      deliveries: Object.freeze(
        this.#deliveries.map((delivery) => Object.freeze({ ...delivery })),
      ),
      completedAtSimTime: this.#completedAtSimTime,
    });
  }

  getEvents(): readonly SimulationEvent[] {
    return this.#log.all();
  }

  // ---------------------------------------------------------------------
  // time
  // ---------------------------------------------------------------------

  /**
   * Simulation time until this vehicle's next state transition. Infinite when
   * the vehicle is not currently consuming time.
   */
  #remainingOf(runtime: VehicleRuntime): number {
    if (runtime.phase === "traveling") {
      return (runtime.edgeDuration ?? 0) - runtime.edgeElapsed;
    }

    if (runtime.phase === "servicing") {
      return this.#serviceTimePerStop - runtime.serviceElapsed;
    }

    return Number.POSITIVE_INFINITY;
  }

  #timeToNextTransition(): number {
    let soonest = Number.POSITIVE_INFINITY;

    for (const runtime of this.#runtimes) {
      const remaining = this.#remainingOf(runtime);
      if (remaining < soonest) {
        soonest = remaining;
      }
    }

    return soonest;
  }

  /**
   * Moves every time-consuming vehicle forward by `step`.
   *
   * A vehicle whose remaining time is exactly consumed is snapped to its
   * duration rather than accumulated into it, so completion is exact and never
   * left short by floating-point drift.
   */
  #applyProgress(step: number): void {
    for (const runtime of this.#runtimes) {
      const remaining = this.#remainingOf(runtime);
      if (!Number.isFinite(remaining)) {
        continue;
      }

      const completesNow = step >= remaining;

      if (runtime.phase === "traveling") {
        const duration = runtime.edgeDuration ?? 0;
        const applied = completesNow ? remaining : step;
        runtime.edgeElapsed = completesNow ? duration : runtime.edgeElapsed + step;
        runtime.totalTravelTime += applied;
        continue;
      }

      runtime.serviceElapsed = completesNow
        ? this.#serviceTimePerStop
        : runtime.serviceElapsed + step;
    }
  }

  /**
   * Processes every transition that is due at the current simulation instant.
   *
   * Vehicles are taken in ascending vehicleId, and the first due vehicle is
   * re-selected each iteration — so a vehicle cascades through zero-duration
   * legs and zero service time completely before the next vehicle is touched,
   * without ever needing another advanceBy call.
   */
  #settle(): void {
    let steps = 0;

    while (true) {
      if (++steps > this.#maxSteps) {
        throw new Error(
          "Simulation did not progress; aborting to avoid an endless transition loop",
        );
      }

      const due = this.#runtimes.find(
        (runtime) => this.#remainingOf(runtime) <= 0,
      );

      if (due === undefined) {
        break;
      }

      this.#stepVehicle(due);
    }

    if (
      this.#status === "running" &&
      this.#runtimes.every((runtime) => runtime.phase === "completed")
    ) {
      this.#status = "completed";
      this.#completedAtSimTime = this.#clock.simTime;
      this.#emit({
        simTime: this.#clock.simTime,
        type: "simulation.completed",
        servedOrderCount: this.#deliveries.length,
        vehicleCount: this.#runtimes.length,
      });
    }
  }

  // ---------------------------------------------------------------------
  // transitions
  // ---------------------------------------------------------------------

  #stepVehicle(runtime: VehicleRuntime): void {
    if (runtime.phase === "traveling") {
      this.#completeEdge(runtime);
      return;
    }

    if (runtime.phase === "servicing") {
      this.#completeService(runtime);
      return;
    }

    throw new Error(
      `Vehicle ${runtime.vehicleId} has no pending transition in phase ${runtime.phase}`,
    );
  }

  #completeEdge(runtime: VehicleRuntime): void {
    const edgeId = runtime.currentEdgeId;
    if (edgeId === null) {
      throw new Error(
        `Vehicle ${runtime.vehicleId} is traveling without a current edge`,
      );
    }

    const leg = this.#requireLeg(runtime);
    const edge = this.#graph.getEdge(edgeId);

    this.#emit({
      simTime: this.#clock.simTime,
      type: "vehicle.edge_completed",
      vehicleId: runtime.vehicleId,
      edgeId,
      toNodeId: edge.toNodeId,
    });

    // Append-only: completed segments are never rewritten.
    runtime.completedEdgeIds.push(edgeId);
    runtime.currentEdgeId = null;
    runtime.edgeDuration = null;
    runtime.edgeElapsed = 0;
    runtime.currentNodeId = edge.toNodeId;
    runtime.edgeIndexInLeg += 1;

    if (runtime.edgeIndexInLeg < leg.edgeIds.length) {
      this.#enterEdge(runtime, leg);
      return;
    }

    this.#arriveAtLegEnd(runtime, leg);
  }

  #completeService(runtime: VehicleRuntime): void {
    const leg = this.#requireLeg(runtime);
    const orderId = leg.arrivalOrderId;
    const sequenceNo = leg.arrivalSequenceNo;

    if (orderId === null || sequenceNo === null) {
      throw new Error(
        `Vehicle ${runtime.vehicleId} is servicing a leg without an order`,
      );
    }

    this.#emit({
      simTime: this.#clock.simTime,
      type: "order.served",
      vehicleId: runtime.vehicleId,
      routeId: runtime.expanded.routeId,
      orderId,
      nodeId: leg.toNodeId,
      sequenceNo,
    });

    runtime.servedOrderIds.push(orderId);
    this.#deliveries.push({
      orderId,
      nodeId: leg.toNodeId,
      vehicleId: runtime.vehicleId,
      routeId: runtime.expanded.routeId,
      sequenceNo,
      deliveredAtSimTime: this.#clock.simTime,
    });

    runtime.serviceElapsed = 0;
    runtime.legIndex += 1;
    runtime.edgeIndexInLeg = 0;

    this.#beginLeg(runtime);
  }

  #beginLeg(runtime: VehicleRuntime): void {
    const leg = this.#requireLeg(runtime);

    runtime.phase = "traveling";
    runtime.edgeIndexInLeg = 0;
    runtime.currentNodeId = leg.fromNodeId;
    runtime.currentEdgeId = null;
    runtime.edgeDuration = null;
    runtime.edgeElapsed = 0;

    if (runtime.departedAtSimTime === null) {
      runtime.departedAtSimTime = this.#clock.simTime;
    }

    this.#emit({
      simTime: this.#clock.simTime,
      type: "vehicle.departed",
      vehicleId: runtime.vehicleId,
      routeId: runtime.expanded.routeId,
      legIndex: leg.legIndex,
      fromNodeId: leg.fromNodeId,
      toNodeId: leg.toNodeId,
    });

    if (leg.edgeIds.length === 0) {
      runtime.currentNodeId = leg.toNodeId;
      this.#arriveAtLegEnd(runtime, leg);
      return;
    }

    this.#enterEdge(runtime, leg);
  }

  #enterEdge(runtime: VehicleRuntime, leg: RouteLeg): void {
    const edgeId = leg.edgeIds[runtime.edgeIndexInLeg];
    if (edgeId === undefined) {
      throw new Error(
        `Vehicle ${runtime.vehicleId} has no edge at index ${runtime.edgeIndexInLeg} of leg ${leg.legIndex}`,
      );
    }

    const edge = this.#graph.getEdge(edgeId);

    runtime.phase = "traveling";
    runtime.currentEdgeId = edgeId;
    // Duration is locked at entry: an in-flight traversal is a commitment.
    runtime.edgeDuration = edge.currentWeight;
    runtime.edgeElapsed = 0;
    runtime.currentNodeId = null;

    this.#emit({
      simTime: this.#clock.simTime,
      type: "vehicle.edge_entered",
      vehicleId: runtime.vehicleId,
      edgeId,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      edgeDuration: edge.currentWeight,
    });
  }

  #arriveAtLegEnd(runtime: VehicleRuntime, leg: RouteLeg): void {
    runtime.completedLegIndexes.push(leg.legIndex);
    runtime.currentNodeId = leg.toNodeId;
    runtime.currentEdgeId = null;
    runtime.edgeDuration = null;
    runtime.edgeElapsed = 0;
    runtime.edgeIndexInLeg = 0;

    if (leg.arrivalOrderId === null) {
      this.#completeRoute(runtime);
      return;
    }

    runtime.phase = "servicing";
    runtime.serviceElapsed = 0;
  }

  #completeRoute(runtime: VehicleRuntime): void {
    runtime.phase = "completed";
    runtime.legIndex = runtime.expanded.legs.length;
    runtime.edgeIndexInLeg = 0;
    runtime.currentNodeId = this.#depotNodeId;
    runtime.currentEdgeId = null;
    runtime.edgeDuration = null;
    runtime.edgeElapsed = 0;
    runtime.serviceElapsed = 0;
    runtime.completedAtSimTime = this.#clock.simTime;

    this.#emit({
      simTime: this.#clock.simTime,
      type: "vehicle.route_completed",
      vehicleId: runtime.vehicleId,
      routeId: runtime.expanded.routeId,
      depotNodeId: this.#depotNodeId,
      totalTravelTime: runtime.totalTravelTime,
    });
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------

  /**
   * Read through a predicate rather than comparing `#status` inline: the
   * status is mutated inside `#settle()`, which TypeScript's control-flow
   * narrowing cannot see from the caller.
   */
  #isCompleted(): boolean {
    return this.#status === "completed";
  }

  #requireLeg(runtime: VehicleRuntime): RouteLeg {
    const leg = runtime.expanded.legs[runtime.legIndex];
    if (leg === undefined) {
      throw new Error(
        `Vehicle ${runtime.vehicleId} has no leg at index ${runtime.legIndex}`,
      );
    }

    return leg;
  }

  #emit(event: SimulationEventInput): void {
    this.#log.append(event);
  }

  #snapshotVehicle(runtime: VehicleRuntime): VehicleSimulationState {
    const currentLeg = runtime.expanded.legs[runtime.legIndex];
    const duration = runtime.edgeDuration;

    return Object.freeze({
      vehicleId: runtime.vehicleId,
      routeId: runtime.expanded.routeId,
      routeVersion: runtime.expanded.version,
      phase: runtime.phase,
      currentNodeId: runtime.currentNodeId,
      currentEdgeId: runtime.currentEdgeId,
      edgeElapsed: runtime.edgeElapsed,
      edgeDuration: duration,
      edgeProgress:
        duration === null || duration === 0 ? 0 : runtime.edgeElapsed / duration,
      legIndex: runtime.legIndex,
      edgeIndexInLeg: runtime.edgeIndexInLeg,
      nextStopSequenceNo: currentLeg?.arrivalSequenceNo ?? null,
      completedEdgeIds: Object.freeze([...runtime.completedEdgeIds]),
      completedLegIndexes: Object.freeze([...runtime.completedLegIndexes]),
      servedOrderIds: Object.freeze([...runtime.servedOrderIds]),
      serviceElapsed: runtime.serviceElapsed,
      totalTravelTime: runtime.totalTravelTime,
      departedAtSimTime: runtime.departedAtSimTime,
      completedAtSimTime: runtime.completedAtSimTime,
    });
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}