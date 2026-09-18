import { RoadGraph } from "../domain/RoadGraph.js";
import type {
  Depot,
  Order,
  RoadNode,
  Vehicle,
} from "../domain/types.js";
import {
  buildStaticPlan,
  type StaticPlanResult,
} from "../domain/planBuilder.js";

export const DEMO_SERVICE_TIME_PER_STOP = 1;

interface EdgeDefinition {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
}

const NODES: readonly RoadNode[] = Object.freeze([
  { id: "D", lat: 28.47, lng: 77.5 },
  { id: "A", lat: 28.5, lng: 77.46 },
  { id: "B", lat: 28.52, lng: 77.53 },
  { id: "C", lat: 28.45, lng: 77.55 },
  { id: "E", lat: 28.43, lng: 77.48 },
]);

const EDGES: readonly EdgeDefinition[] = Object.freeze([
  { from: "D", to: "A", weight: 4 },
  { from: "A", to: "D", weight: 4 },

  { from: "D", to: "B", weight: 6 },
  { from: "B", to: "D", weight: 6 },

  { from: "D", to: "C", weight: 5 },
  { from: "C", to: "D", weight: 5 },

  { from: "D", to: "E", weight: 7 },
  { from: "E", to: "D", weight: 7 },

  { from: "A", to: "B", weight: 2 },
  { from: "B", to: "A", weight: 2 },

  { from: "C", to: "E", weight: 3 },
  { from: "E", to: "C", weight: 3 },

  { from: "A", to: "C", weight: 12 },
  { from: "C", to: "A", weight: 12 },

  { from: "B", to: "C", weight: 11 },
  { from: "C", to: "B", weight: 11 },

  { from: "A", to: "E", weight: 14 },
  { from: "E", to: "A", weight: 14 },

  { from: "B", to: "E", weight: 15 },
  { from: "E", to: "B", weight: 15 },
]);

const DEPOT: Depot = Object.freeze({
  id: "depot-1",
  name: "Central Depot",
  nodeId: "D",
});

const VEHICLES: readonly Vehicle[] = Object.freeze([
  Object.freeze<Vehicle>({
    id: "v1",
    label: "Van 1",
    capacity: 10,
    depotId: "depot-1",
    status: "idle",
  }),
  Object.freeze<Vehicle>({
    id: "v2",
    label: "Van 2",
    capacity: 10,
    depotId: "depot-1",
    status: "idle",
  }),
]);

const ORDERS: readonly Order[] = Object.freeze([
  Object.freeze<Order>({
    id: "o1",
    nodeId: "A",
    demand: 3,
    status: "pending",
  }),
  Object.freeze<Order>({
    id: "o2",
    nodeId: "B",
    demand: 4,
    status: "pending",
  }),
  Object.freeze<Order>({
    id: "o3",
    nodeId: "C",
    demand: 2,
    status: "pending",
  }),
  Object.freeze<Order>({
    id: "o4",
    nodeId: "E",
    demand: 3,
    status: "pending",
  }),
]);

export interface DemoScenario {
  readonly name: string;
  readonly graph: RoadGraph;
  readonly depot: Depot;
  readonly nodes: readonly RoadNode[];
  readonly edges: readonly {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    weight: number;
  }[];
  readonly vehicles: readonly Vehicle[];
  readonly orders: readonly Order[];
  readonly plan: StaticPlanResult;
  readonly serviceTimePerStop: number;
}

export function buildDemoGraph(): RoadGraph {
  const graph = new RoadGraph();

  for (const node of NODES) {
    graph.addNode({ ...node });
  }

  for (const edge of EDGES) {
    graph.addEdge({
      id: edgeId(edge.from, edge.to),
      fromNodeId: edge.from,
      toNodeId: edge.to,
      baseWeight: edge.weight,
    });
  }

  return graph;
}

export function createDemoScenario(): DemoScenario {
  const graph = buildDemoGraph();

  const plan = buildStaticPlan(
    graph,
    DEPOT,
    ORDERS,
    VEHICLES,
  );

  return {
    name: "Tiny fleet — 1 depot, 2 vehicles, 4 orders",
    graph,
    depot: DEPOT,
    nodes: NODES.map((node) => ({ ...node })),
    edges: EDGES.map((edge) => ({
      id: edgeId(edge.from, edge.to),
      fromNodeId: edge.from,
      toNodeId: edge.to,
      weight: edge.weight,
    })),
    vehicles: VEHICLES,
    orders: ORDERS,
    plan,
    serviceTimePerStop:
      DEMO_SERVICE_TIME_PER_STOP,
  };
}

function edgeId(
  from: string,
  to: string,
): string {
  return `${from}-${to}`;
}