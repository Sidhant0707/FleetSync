/**
 * Event taxonomy for the Phase 2 simulator.
 *
 * Deliberately limited to the seven events this milestone needs. Dynamic
 * events (closures, breakdowns, cancellations, repairs) belong to Phase 3 and
 * are not anticipated here.
 *
 * Every event carries a monotonic `seq` assigned by the log, so the log is a
 * total order and never needs re-sorting.
 */
export type SimulationEventType =
  | "simulation.started"
  | "vehicle.departed"
  | "vehicle.edge_entered"
  | "vehicle.edge_completed"
  | "order.served"
  | "vehicle.route_completed"
  | "simulation.completed";

interface SimulationEventBase<TType extends SimulationEventType> {
  readonly seq: number;
  readonly simTime: number;
  readonly type: TType;
}

export interface SimulationStartedEvent
  extends SimulationEventBase<"simulation.started"> {
  readonly vehicleIds: readonly string[];
}

export interface VehicleDepartedEvent
  extends SimulationEventBase<"vehicle.departed"> {
  readonly vehicleId: string;
  readonly routeId: string;
  readonly legIndex: number;
  readonly fromNodeId: string;
  readonly toNodeId: string;
}

export interface VehicleEdgeEnteredEvent
  extends SimulationEventBase<"vehicle.edge_entered"> {
  readonly vehicleId: string;
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly edgeDuration: number;
}

export interface VehicleEdgeCompletedEvent
  extends SimulationEventBase<"vehicle.edge_completed"> {
  readonly vehicleId: string;
  readonly edgeId: string;
  readonly toNodeId: string;
}

export interface OrderServedEvent extends SimulationEventBase<"order.served"> {
  readonly vehicleId: string;
  readonly routeId: string;
  readonly orderId: string;
  readonly nodeId: string;
  readonly sequenceNo: number;
}

export interface VehicleRouteCompletedEvent
  extends SimulationEventBase<"vehicle.route_completed"> {
  readonly vehicleId: string;
  readonly routeId: string;
  readonly depotNodeId: string;
  readonly totalTravelTime: number;
}

export interface SimulationCompletedEvent
  extends SimulationEventBase<"simulation.completed"> {
  readonly servedOrderCount: number;
  readonly vehicleCount: number;
}

export type SimulationEvent =
  | SimulationStartedEvent
  | VehicleDepartedEvent
  | VehicleEdgeEnteredEvent
  | VehicleEdgeCompletedEvent
  | OrderServedEvent
  | VehicleRouteCompletedEvent
  | SimulationCompletedEvent;

type WithoutSeq<TEvent> = TEvent extends SimulationEvent
  ? Omit<TEvent, "seq">
  : never;

/** An event as emitted by the engine; the log assigns `seq`. */
export type SimulationEventInput = WithoutSeq<SimulationEvent>;

/**
 * Append-only event log.
 *
 * There is no update, delete or reorder operation, by design: recorded history
 * is immutable, which is what makes `completedEdgeIds` and the rest of the
 * simulation record safe to replay and to stream later.
 */
export class SimulationEventLog {
  readonly #events: SimulationEvent[] = [];

  get size(): number {
    return this.#events.length;
  }

  append(input: SimulationEventInput): SimulationEvent {
    // The spread of a discriminated union plus `seq` is structurally exactly
    // one member of SimulationEvent, which the compiler cannot verify on a
    // spread. This single assertion is the only one in the module.
    const event = Object.freeze({
      ...input,
      seq: this.#events.length,
    }) as SimulationEvent;

    this.#events.push(event);
    return event;
  }

  all(): readonly SimulationEvent[] {
    return Object.freeze([...this.#events]);
  }

  /** Events appended at or after `seq`. */
  since(seq: number): readonly SimulationEvent[] {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new Error(
        `Invalid event sequence number: ${String(seq)}; expected a non-negative integer`,
      );
    }

    return Object.freeze(this.#events.slice(seq));
  }
}