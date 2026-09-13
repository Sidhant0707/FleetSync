import type { RoadEdge, RoadNode } from "./types.js";

export class RoadGraph {
  readonly #nodes = new Map<string, RoadNode>();
  readonly #edges = new Map<string, MutableEdge>();
  readonly #outgoing = new Map<string, string[]>();

  addNode(node: RoadNode): void {
    if (this.#nodes.has(node.id)) {
      throw new Error(`Duplicate node ID: ${node.id}`);
    }

    this.#nodes.set(node.id, Object.freeze({ ...node }));
    this.#outgoing.set(node.id, []);
  }

  addEdge(edge: {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    baseWeight: number;
  }): void {
    if (this.#edges.has(edge.id)) {
      throw new Error(`Duplicate edge ID: ${edge.id}`);
    }

    if (!this.#nodes.has(edge.fromNodeId)) {
      throw new Error(
        `Edge ${edge.id} references unknown node ID: ${edge.fromNodeId}`,
      );
    }

    if (!this.#nodes.has(edge.toNodeId)) {
      throw new Error(
        `Edge ${edge.id} references unknown node ID: ${edge.toNodeId}`,
      );
    }

    if (!Number.isFinite(edge.baseWeight) || edge.baseWeight <= 0) {
      throw new Error(
        `Edge ${edge.id} has invalid baseWeight: ${String(edge.baseWeight)}`,
      );
    }

    this.#edges.set(edge.id, {
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      baseWeight: edge.baseWeight,
      currentWeight: edge.baseWeight,
      status: "open",
    });

    const outgoing = this.#outgoing.get(edge.fromNodeId);
    if (outgoing === undefined) {
      throw new Error(`Unknown node ID: ${edge.fromNodeId}`);
    }

    outgoing.push(edge.id);
    outgoing.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  hasNode(nodeId: string): boolean {
    return this.#nodes.has(nodeId);
  }

  getNode(nodeId: string): RoadNode {
    const node = this.#nodes.get(nodeId);
    if (node === undefined) {
      throw new Error(`Unknown node ID: ${nodeId}`);
    }

    return snapshotNode(node);
  }

  getEdge(edgeId: string): RoadEdge {
    return snapshotEdge(this.#requireEdge(edgeId));
  }

  getOutgoingEdges(nodeId: string): readonly RoadEdge[] {
    const outgoing = this.#outgoing.get(nodeId);
    if (outgoing === undefined) {
      throw new Error(`Unknown node ID: ${nodeId}`);
    }

    return Object.freeze(
      outgoing.map((edgeId) => snapshotEdge(this.#requireEdge(edgeId))),
    );
  }

  closeEdge(edgeId: string): void {
    const edge = this.#requireEdge(edgeId);
    edge.status = "closed";
    edge.currentWeight = Number.POSITIVE_INFINITY;
  }

  reopenEdge(edgeId: string): void {
    const edge = this.#requireEdge(edgeId);
    edge.status = "open";
    edge.currentWeight = edge.baseWeight;
  }

  setTravelTimeMultiplier(edgeId: string, multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new Error(`Invalid travel-time multiplier: ${String(multiplier)}`);
    }

    const edge = this.#requireEdge(edgeId);
    if (edge.status === "closed") {
      throw new Error(
        `Cannot apply travel-time multiplier to closed edge: ${edgeId}`,
      );
    }

    edge.currentWeight = edge.baseWeight * multiplier;
  }

  #requireEdge(edgeId: string): MutableEdge {
    const edge = this.#edges.get(edgeId);
    if (edge === undefined) {
      throw new Error(`Unknown edge ID: ${edgeId}`);
    }

    return edge;
  }
}

interface MutableEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  baseWeight: number;
  currentWeight: number;
  status: RoadEdge["status"];
}

function snapshotNode(node: RoadNode): RoadNode {
  return Object.freeze({
    id: node.id,
    lat: node.lat,
    lng: node.lng,
  });
}

function snapshotEdge(edge: MutableEdge): RoadEdge {
  return Object.freeze({
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    baseWeight: edge.baseWeight,
    currentWeight: edge.currentWeight,
    status: edge.status,
  });
}
