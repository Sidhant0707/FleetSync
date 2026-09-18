import {
  SimulationEngine,
} from "../domain/simulation.js";
import {
  expandRoute,
} from "../domain/routeExpansion.js";
import type {
  Order,
} from "../domain/types.js";
import {
  createDemoScenario,
  type DemoScenario,
} from "../demo/scenario.js";
import {
  toEventDto,
  toRouteDto,
  toStateDto,
  type EventsDto,
  type RouteDto,
  type ScenarioDto,
  type SimulationStateDto,
} from "./dto.js";

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class SimulationService {
  #scenario: DemoScenario;
  #engine: SimulationEngine;

  constructor(
    private readonly createScenario:
      () => DemoScenario =
      createDemoScenario,
  ) {
    this.#scenario =
      createScenario();

    this.#engine =
      createEngine(this.#scenario);
  }

  getScenario(): ScenarioDto {
    const scenario =
      this.#scenario;

    return {
      name: scenario.name,

      depot: {
        id: scenario.depot.id,
        name: scenario.depot.name,
        nodeId: scenario.depot.nodeId,
      },

      nodes: scenario.nodes.map(
        (node) => ({ ...node }),
      ),

      edges: scenario.edges.map(
        (edge) => ({ ...edge }),
      ),

      vehicles:
        scenario.vehicles.map(
          (vehicle) => ({
            id: vehicle.id,
            label: vehicle.label,
            capacity: vehicle.capacity,
          }),
        ),

      orders:
        scenario.orders.map(
          (order) => ({
            id: order.id,
            nodeId: order.nodeId,
            demand: order.demand,
          }),
        ),

      routes:
        this.#buildRouteDtos(
          scenario.orders,
        ),

      unassignedOrders:
        scenario.plan.unassigned.map(
          (entry) => ({
            orderId: entry.orderId,
            reason: entry.reason,
          }),
        ),

      serviceTimePerStop:
        scenario.serviceTimePerStop,
    };
  }

  getState(): SimulationStateDto {
    return toStateDto(
      this.#engine.getState(),
      this.#scenario.orders,
      this.#scenario.plan.routes,
      this.#engine.getEvents().length,
    );
  }

  getEvents(
    sinceSeq = 0,
  ): EventsDto {
    const all =
      this.#engine.getEvents();

    if (
      !Number.isInteger(
        sinceSeq,
      ) ||
      sinceSeq < 0
    ) {
      throw new ApiError(
        400,
        `sinceSeq must be a non-negative integer, got ${String(sinceSeq)}`,
      );
    }

    return {
      events:
        all
          .slice(sinceSeq)
          .map(toEventDto),

      nextSeq: all.length,
    };
  }

  start(): {
    state: SimulationStateDto;
    events: EventsDto;
  } {
    if (
      this.#engine.getState()
        .status !== "not_started"
    ) {
      throw new ApiError(
        409,
        "Simulation has already been started",
      );
    }

    const sinceSeq =
      this.#engine
        .getEvents()
        .length;

    this.#engine.start();

    return {
      state: this.getState(),
      events:
        this.getEvents(
          sinceSeq,
        ),
    };
  }

  advance(
    delta: number,
  ): {
    state: SimulationStateDto;
    events: EventsDto;
  } {
    if (
      typeof delta !== "number" ||
      !Number.isFinite(delta) ||
      delta < 0
    ) {
      throw new ApiError(
        400,
        `delta must be a non-negative finite number, got ${String(delta)}`,
      );
    }

    if (
      this.#engine.getState()
        .status === "not_started"
    ) {
      throw new ApiError(
        409,
        "Simulation has not been started; POST /api/simulation/start first",
      );
    }

    const sinceSeq =
      this.#engine
        .getEvents()
        .length;

    this.#engine.advanceBy(
      delta,
    );

    return {
      state: this.getState(),
      events:
        this.getEvents(
          sinceSeq,
        ),
    };
  }

  reset(): {
    state: SimulationStateDto;
    events: EventsDto;
  } {
    this.#scenario =
      this.createScenario();

    this.#engine =
      createEngine(
        this.#scenario,
      );

    return {
      state: this.getState(),
      events:
        this.getEvents(0),
    };
  }

  #buildRouteDtos(
    orders: readonly Order[],
  ): readonly RouteDto[] {
    const orderMap =
      new Map(
        orders.map(
          (order) => [
            order.id,
            order,
          ],
        ),
      );

    return this.#scenario.plan.routes.map(
      (route) => {
        const expansion =
          expandRoute(
            route,
            orderMap,
            this.#scenario.depot.nodeId,
            this.#scenario.graph,
          );

        if (!expansion.ok) {
          throw new Error(
            `Cannot expand route ${route.id}: ${expansion.reason}; ${expansion.detail}`,
          );
        }

        return toRouteDto(
          route,
          expansion.expanded,
          orders,
        );
      },
    );
  }
}

function createEngine(
  scenario: DemoScenario,
): SimulationEngine {
  return new SimulationEngine({
    graph: scenario.graph,
    depot: scenario.depot,
    routes: scenario.plan.routes,
    orders: scenario.orders,
    vehicles: scenario.vehicles,
    serviceTimePerStop:
      scenario.serviceTimePerStop,
  });
}