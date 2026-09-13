import type { RoadGraph } from "./RoadGraph.js";

export interface ShortestPathResult {
  readonly reachable: boolean;
  readonly distance: number;
  readonly nodePath: readonly string[];
  readonly edgePath: readonly string[];
}

export function shortestPath(
  graph: RoadGraph,
  sourceId: string,
  targetId: string,
): ShortestPathResult {
  if (!graph.hasNode(sourceId)) {
    throw new Error(`Unknown source node ID: ${sourceId}`);
  }

  if (!graph.hasNode(targetId)) {
    throw new Error(`Unknown target node ID: ${targetId}`);
  }

  if (sourceId === targetId) {
    return {
      reachable: true,
      distance: 0,
      nodePath: [sourceId],
      edgePath: [],
    };
  }

  const distances = new Map<string, number>([[sourceId, 0]]);
  const previousNode = new Map<string, string>();
  const previousEdge = new Map<string, string>();
  const heap = new BinaryMinHeap();
  heap.push(0, sourceId);

  while (heap.size > 0) {
    const current = heap.pop();
    if (current === undefined) {
      break;
    }

    const bestDistance = distances.get(current.nodeId);
    if (bestDistance === undefined || current.distance > bestDistance) {
      continue;
    }

    if (current.nodeId === targetId) {
      break;
    }

    for (const edge of graph.getOutgoingEdges(current.nodeId)) {
      if (edge.status === "closed" || !Number.isFinite(edge.currentWeight)) {
        continue;
      }

      const candidate = current.distance + edge.currentWeight;
      const existing = distances.get(edge.toNodeId);

      if (existing !== undefined && candidate >= existing) {
        continue;
      }

      distances.set(edge.toNodeId, candidate);
      previousNode.set(edge.toNodeId, current.nodeId);
      previousEdge.set(edge.toNodeId, edge.id);
      heap.push(candidate, edge.toNodeId);
    }
  }

  const best = distances.get(targetId);
  if (best === undefined) {
    return unreachableResult();
  }

  return {
    reachable: true,
    distance: best,
    ...reconstructPath(sourceId, targetId, previousNode, previousEdge),
  };
}

function unreachableResult(): ShortestPathResult {
  return {
    reachable: false,
    distance: Number.POSITIVE_INFINITY,
    nodePath: [],
    edgePath: [],
  };
}

function reconstructPath(
  sourceId: string,
  targetId: string,
  previousNode: Map<string, string>,
  previousEdge: Map<string, string>,
): { nodePath: readonly string[]; edgePath: readonly string[] } {
  const reversedNodes: string[] = [targetId];
  const reversedEdges: string[] = [];
  let cursor = targetId;

  while (cursor !== sourceId) {
    const parent = previousNode.get(cursor);
    const viaEdge = previousEdge.get(cursor);
    if (parent === undefined || viaEdge === undefined) {
      return { nodePath: [], edgePath: [] };
    }

    reversedNodes.push(parent);
    reversedEdges.push(viaEdge);
    cursor = parent;
  }

  reversedNodes.reverse();
  reversedEdges.reverse();
  return { nodePath: reversedNodes, edgePath: reversedEdges };
}

class BinaryMinHeap {
  readonly #items: HeapEntry[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(distance: number, nodeId: string): void {
    this.#items.push({ distance, nodeId });
    this.#bubbleUp(this.#items.length - 1);
  }

  pop(): HeapEntry | undefined {
    const first = this.#items[0];
    const last = this.#items.pop();
    if (first === undefined || last === undefined) {
      return undefined;
    }

    if (this.#items.length > 0) {
      this.#items[0] = last;
      this.#bubbleDown(0);
    }

    return first;
  }

  #bubbleUp(index: number): void {
    let current = index;

    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (!this.#less(current, parent)) {
        break;
      }

      this.#swap(current, parent);
      current = parent;
    }
  }

  #bubbleDown(index: number): void {
    const length = this.#items.length;
    let current = index;

    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let smallest = current;

      if (left < length && this.#less(left, smallest)) {
        smallest = left;
      }

      if (right < length && this.#less(right, smallest)) {
        smallest = right;
      }

      if (smallest === current) {
        break;
      }

      this.#swap(current, smallest);
      current = smallest;
    }
  }

  #less(leftIndex: number, rightIndex: number): boolean {
    const left = this.#items[leftIndex];
    const right = this.#items[rightIndex];
    if (left === undefined || right === undefined) {
      return false;
    }

    if (left.distance !== right.distance) {
      return left.distance < right.distance;
    }

    return left.nodeId < right.nodeId;
  }

  #swap(leftIndex: number, rightIndex: number): void {
    const left = this.#items[leftIndex];
    const right = this.#items[rightIndex];
    if (left === undefined || right === undefined) {
      return;
    }

    this.#items[leftIndex] = right;
    this.#items[rightIndex] = left;
  }
}

interface HeapEntry {
  distance: number;
  nodeId: string;
}
