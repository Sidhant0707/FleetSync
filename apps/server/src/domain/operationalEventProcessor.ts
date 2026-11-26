import {
  identifyAffectedEntities,
  type AffectedEntityResult,
} from "./affectedEntities.js";
import {
  validateOperationalEvent,
  type OperationalEvent,
  type OperationalEventContext,
  type OperationalEventRejectionReason,
  type OperationalEventValidationResult,
} from "./operationalEvents.js";
import type { RoadGraph } from "./RoadGraph.js";
import type {
  RouteProgressSnapshot,
  SimulationEngine,
  SimulationStatus,
} from "./simulation.js";
import type { SimulationEvent } from "./simulationEvents.js";
import type { Order, Vehicle } from "./types.js";

/**
 * Operational event processing: the integration of
 *
 *   Operational Event Validation (M1) -> Simulation Engine
 *     -> Affected-Entity Identification (M2)
 *
 * This module coordinates existing pieces. It adds no routing, repair,
 * reassignment, re-expansion or optimisation: it only decides WHEN each
 * existing step runs relative to simulation time.
 *
 * Sequence for one event
 * ----------------------
 *   0. Gate: run the Milestone 1 validation against the current state. A
 *      rejection returns immediately; the engine is not advanced and nothing
 *      is mutated. This is sound because nothing the validator reads (graph,
 *      orders, vehicles, seen event IDs) is changed by the engine advancing,
 *      so the gate cannot disagree with step 4. Events of the two types
 *      Milestone 2 does not support are returned as `deferred` here too.
 *   1. Advance the engine to the event's effective time (`advanceTo`).
 *   2. Every transition due at that instant is settled. The engine settles
 *      after each step it takes, so this needs no extra call; the state is at
 *      rest when `advanceTo` returns. A vehicle that reached a node exactly at
 *      the event time has therefore already entered its next edge.
 *   3. Capture ONE `RouteProgressSnapshot`: committed routes, vehicle states
 *      and simulation time read together.
 *   4. Validate again, now at the settled instant, and apply. A no-op event is
 *      skipped (the graph is untouched). Otherwise the existing RoadGraph
 *      mutation runs, or for `order_created` the order is registered.
 *   5. `identifyAffectedEntities` runs on the snapshot from step 3. Routes are
 *      never re-expanded, so a path changed by the graph mutation of step 4
 *      cannot leak into the answer.
 *
 * Events with the same effective time are processed in call order. The second
 * call advances by zero and captures the same settled instant, but sees the
 * graph as the first event left it. Choosing that order is the caller's job.
 *
 * Event time
 * ----------
 * The engine is only ever advanced forward, by `advanceBy`. If it cannot reach
 * the effective time the result is `time_not_reached` and the event is NOT
 * applied. Two causes exist today:
 *   - the simulation completed first. The engine's clock stops at the
 *     makespan, so an event after it cannot be placed in simulation time;
 *   - the engine stalled. A vehicle that enters a closed edge gets an infinite
 *     duration and the engine stops advancing (see "Known limitation").
 * Time is compared exactly, with no tolerance. `advanceTo` assigns the clock
 * the requested instant when the engine reaches it, so a reachable effective
 * time, including a fractional one such as 0.9, always matches. A mismatch
 * therefore means completion or a stall, never rounding, and an event is never
 * processed at a slightly wrong instant. Transition instants inside the engine
 * are still floating-point sums, so an event meant to coincide with an arrival
 * whose edge durations are not exact binary fractions may fall an ulp on either
 * side of it.
 *
 * Known limitation (resolved by a later milestone)
 * ------------------------------------------------
 * Applying `road_closed` mutates the shared RoadGraph. If a route's modifiable
 * suffix contains that edge, the route is reported INVALIDATED but is NOT
 * repaired here. The engine still holds it, and when the vehicle reaches the
 * closed edge it enters it with an infinite duration and the engine stops
 * advancing. Until localized repair exists, do not advance past that point.
 * An edge already in flight is unaffected: its duration was locked at entry.
 *
 * Ownership
 * ---------
 * The processor owns the operational registry the validator needs: orders,
 * vehicles and the IDs of processed events. `order_created` adds a `pending`
 * order to that registry only; the engine is not given the order and no route
 * is changed. Rejected, deferred and time-not-reached events do not consume
 * their event ID.
 *
 * Preconditions: `graph` is the same RoadGraph instance the engine was built
 * with, and `engine` has been started before `process` is called.
 */

export interface OperationalEventProcessorOptions {
  readonly engine: SimulationEngine;
  /** Must be the graph instance the engine executes against. */
  readonly graph: RoadGraph;
  readonly orders: readonly Order[];
  readonly vehicles: readonly Vehicle[];
}

export type DeferredOperationalEventType =
  | "order_cancelled"
  | "vehicle_broken_down";

export type TimeNotReachedReason =
  | "SIMULATION_COMPLETED_BEFORE_EVENT"
  | "ENGINE_DID_NOT_REACH_EVENT_TIME";

interface ProcessingResultBase {
  readonly eventId: string;
  /**
   * Simulation events the engine emitted while this call advanced it. Empty
   * when the engine was not advanced.
   */
  readonly simulationEvents: readonly SimulationEvent[];
}

/** Validation failed. The graph and registry are unchanged. */
export interface RejectedResult extends ProcessingResultBase {
  readonly status: "rejected";
  readonly reason: OperationalEventRejectionReason;
  readonly detail: string;
}

/** Valid, but its type is not supported by affected-entity identification yet. */
export interface DeferredResult extends ProcessingResultBase {
  readonly status: "deferred";
  readonly eventType: DeferredOperationalEventType;
  readonly detail: string;
}

/** The engine could not be placed at the effective time. Nothing was applied. */
export interface TimeNotReachedResult extends ProcessingResultBase {
  readonly status: "time_not_reached";
  readonly reason: TimeNotReachedReason;
  readonly effectiveTime: number;
  readonly simTime: number;
  readonly simulationStatus: SimulationStatus;
}

/** Valid but a no-op. Skipped: nothing was applied and nothing is affected. */
export interface NoOpResult extends ProcessingResultBase {
  readonly status: "no_op";
  readonly snapshot: RouteProgressSnapshot;
}

/**
 * The event was applied. `identification` is the Milestone 2 answer computed
 * from `snapshot`, which was captured before the event was applied. It can be a
 * structured failure; the event is applied regardless.
 */
export interface AppliedResult extends ProcessingResultBase {
  readonly status: "applied";
  readonly snapshot: RouteProgressSnapshot;
  readonly identification: AffectedEntityResult;
}

export type OperationalEventProcessingResult =
  | RejectedResult
  | DeferredResult
  | TimeNotReachedResult
  | NoOpResult
  | AppliedResult;

export class OperationalEventProcessor {
  readonly #engine: SimulationEngine;
  readonly #graph: RoadGraph;
  readonly #orders = new Map<string, Order>();
  readonly #vehicles = new Map<string, Vehicle>();
  readonly #seenEventIds = new Set<string>();

  constructor(options: OperationalEventProcessorOptions) {
    this.#engine = options.engine;
    this.#graph = options.graph;

    for (const order of options.orders) {
      if (this.#orders.has(order.id)) {
        throw new Error(`Duplicate order ID: ${order.id}`);
      }

      this.#orders.set(order.id, order);
    }

    for (const vehicle of options.vehicles) {
      if (this.#vehicles.has(vehicle.id)) {
        throw new Error(`Duplicate vehicle ID: ${vehicle.id}`);
      }

      this.#vehicles.set(vehicle.id, vehicle);
    }
  }

  /**
   * Orders known to the processor, in registration order: the orders supplied
   * at construction followed by any created through `order_created` events.
   *
   * This is the processor's own operational registry, not the engine's state.
   * The engine never receives created orders, and an order's `status` here is
   * not synchronized with the engine (an order the engine has served still
   * reads `pending`). Do not derive service status from it.
   */
  getOrders(): readonly Order[] {
    return Object.freeze([...this.#orders.values()]);
  }

  process(event: OperationalEvent): OperationalEventProcessingResult {
    const before = this.#engine.getRouteProgressSnapshot();

    if (before.status === "not_started") {
      throw new Error(
        "Cannot process an operational event before the simulation has been started",
      );
    }

    // Step 0: gate. Nothing has been advanced or mutated yet.
    const gate = this.#validate(event, before.simTime);
    if (!gate.ok) {
      return rejected(event.id, gate, []);
    }

    if (event.type === "order_cancelled" || event.type === "vehicle_broken_down") {
      return Object.freeze({
        status: "deferred",
        eventId: event.id,
        eventType: event.type,
        detail: `Event ${event.id} of type ${event.type} is not supported by affected-entity identification yet`,
        simulationEvents: NO_SIMULATION_EVENTS,
      });
    }

    // Steps 1 and 2: advance; the engine settles every due transition.
    const simulationEvents = this.#engine.advanceTo(event.effectiveTime);

    // Step 3: one consistent capture, strictly before the event is applied.
    const snapshot = this.#engine.getRouteProgressSnapshot();

    if (snapshot.simTime !== event.effectiveTime) {
      return Object.freeze({
        status: "time_not_reached",
        eventId: event.id,
        reason:
          snapshot.status === "completed"
            ? "SIMULATION_COMPLETED_BEFORE_EVENT"
            : "ENGINE_DID_NOT_REACH_EVENT_TIME",
        effectiveTime: event.effectiveTime,
        simTime: snapshot.simTime,
        simulationStatus: snapshot.status,
        simulationEvents,
      });
    }

    // Step 4: validate at the settled instant, then skip or apply.
    const decision = this.#validate(event, snapshot.simTime);
    if (!decision.ok) {
      return rejected(event.id, decision, simulationEvents);
    }

    this.#seenEventIds.add(event.id);

    if (decision.noOp) {
      return Object.freeze({
        status: "no_op",
        eventId: event.id,
        snapshot,
        simulationEvents,
      });
    }

    switch (event.type) {
      case "road_closed":
        this.#graph.closeEdge(event.edgeId);
        break;
      case "road_reopened":
        this.#graph.reopenEdge(event.edgeId);
        break;
      case "travel_time_changed":
        this.#graph.setTravelTimeMultiplier(event.edgeId, event.multiplier);
        break;
      case "order_created":
        this.#orders.set(
          event.orderId,
          Object.freeze({
            id: event.orderId,
            nodeId: event.nodeId,
            demand: event.demand,
            status: "pending",
          }),
        );
        break;
    }

    // Step 5: identify on the captured committed routes, never re-expanded.
    const identification = identifyAffectedEntities(event, {
      routes: snapshot.routes,
      vehicleStates: snapshot.vehicleStates,
    });

    return Object.freeze({
      status: "applied",
      eventId: event.id,
      snapshot,
      identification,
      simulationEvents,
    });
  }

  #validate(
    event: OperationalEvent,
    currentSimTime: number,
  ): OperationalEventValidationResult {
    const context: OperationalEventContext = {
      graph: this.#graph,
      orders: this.#orders,
      vehicles: this.#vehicles,
      currentSimTime,
      seenEventIds: this.#seenEventIds,
    };

    return validateOperationalEvent(event, context);
  }
}

const NO_SIMULATION_EVENTS: readonly SimulationEvent[] = Object.freeze([]);

function rejected(
  eventId: string,
  failure: Extract<OperationalEventValidationResult, { readonly ok: false }>,
  simulationEvents: readonly SimulationEvent[],
): RejectedResult {
  return Object.freeze({
    status: "rejected",
    eventId,
    reason: failure.reason,
    detail: failure.detail,
    simulationEvents,
  });
}
