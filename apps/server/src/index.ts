export type {
  Depot,
  EdgeStatus,
  Order,
  OrderStatus,
  RoadEdge,
  RoadNode,
  Route,
  RouteStop,
  SoftTimeWindow,
  Vehicle,
  VehicleStatus,
} from "./domain/types.js";
export { RoadGraph } from "./domain/RoadGraph.js";
export { shortestPath } from "./domain/shortestPath.js";
export type { ShortestPathResult } from "./domain/shortestPath.js";

export function placeholder(): string {
  return "fleetsync";
}
