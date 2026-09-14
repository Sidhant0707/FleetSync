import type { RoadGraph } from "./RoadGraph.js";
import { shortestPath, type ShortestPathResult } from "./shortestPath.js";

/**
 * Directed pairwise travel costs between a fixed set of nodes.
 *
 * The matrix is built from the existing single-pair Dijkstra implementation.
 * Because the road graph is directed, A -> B and B -> A are computed
 * independently.
 *
 * A reachable result is stored as the actual ShortestPathResult.
 * An unreachable pair is stored explicitly as null.
 */
export type CostLookup = ReadonlyMap<
  string,
  ReadonlyMap<string, ShortestPathResult | null>
>;

export interface BuildCostMatrixOptions {
  readonly graph: RoadGraph;
  readonly nodeIds: readonly string[];
}

/**
 * Computes shortest-path results for every ordered pair in nodeIds.
 *
 * nodeIds are deduplicated and sorted first so that matrix construction is
 * deterministic regardless of input order.
 *
 * shortestPath() is intentionally called for every ordered pair because the
 * existing API is single-pair Dijkstra and the graph is directed.
 */
export function buildCostMatrix(
  options: BuildCostMatrixOptions,
): CostLookup {
  const { graph, nodeIds } = options;

  const sortedNodeIds = [...new Set(nodeIds)].sort();

  const matrix = new Map<
    string,
    Map<string, ShortestPathResult | null>
  >();

  for (const sourceId of sortedNodeIds) {
    const row = new Map<string, ShortestPathResult | null>();

    for (const targetId of sortedNodeIds) {
      const result = shortestPath(
        graph,
        sourceId,
        targetId,
      );

      row.set(
        targetId,
        result.reachable ? result : null,
      );
    }

    matrix.set(sourceId, row);
  }

  return matrix;
}

/**
 * Returns the stored directed cost from `from` to `to`.
 *
 * A missing entry is treated as unreachable.
 */
export function getCost(
  matrix: CostLookup,
  from: string,
  to: string,
): ShortestPathResult | null {
  return matrix.get(from)?.get(to) ?? null;
}