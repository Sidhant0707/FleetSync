import type {
  EventDto,
  EventsDto,
  ScenarioDto,
  SimulationStateDto,
} from "./apiTypes.js";
import {
  buildDashboardView,
  LAYOUT_HEIGHT,
  LAYOUT_WIDTH,
  type DashboardView,
} from "./viewModel.js";

/**
 * Thin rendering shell.
 *
 * The browser owns nothing but pixels and a playback timer: every value shown
 * comes from the API, and every state change goes through the backend engine.
 */

const PLAY_INTERVAL_MS = 600;
const PLAY_DELTA = 1;

interface AppState {
  scenario: ScenarioDto | null;
  simulation: SimulationStateDto | null;
  events: EventDto[];
  nextSeq: number;
  playing: boolean;
  error: string | null;
}

const state: AppState = {
  scenario: null,
  simulation: null,
  events: [],
  nextSeq: 0,
  playing: false,
  error: null,
};

let playTimer: number | null = null;

/**
 * Every API interaction runs through this queue, so at most one request is in
 * flight at a time -- /api/simulation/advance in particular, whether it comes
 * from the play loop or from a button. Serialising also keeps refresh() from
 * overlapping with itself: two concurrent refreshes would read the same
 * state.nextSeq and append the same events twice.
 *
 * withErrorHandling never rejects, so the chain cannot be poisoned by a failed
 * action and later work still runs.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(action: () => Promise<void>): Promise<void> {
  const next = queue.then(() => withErrorHandling(action));
  queue = next;
  return next;
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const body = (await response.json()) as unknown;

  if (!response.ok) {
    throw new Error(readError(body, response.status));
  }

  return body as T;
}

async function apiPost<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as unknown;

  if (!response.ok) {
    throw new Error(readError(body, response.status));
  }

  return body as T;
}

function readError(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const message = (body as Record<string, unknown>)["error"];
    if (typeof message === "string") {
      return message;
    }
  }

  return `Request failed with status ${String(status)}`;
}

async function refresh(): Promise<void> {
  state.simulation = await apiGet<SimulationStateDto>("/api/simulation/state");
  const events = await apiGet<EventsDto>(
    `/api/simulation/events?sinceSeq=${String(state.nextSeq)}`,
  );
  state.events = [...state.events, ...events.events];
  state.nextSeq = events.nextSeq;
  render();
}

async function withErrorHandling(action: () => Promise<void>): Promise<void> {
  try {
    state.error = null;
    await action();
  } catch (error) {
    stopPlayback();
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function startSimulation(): Promise<void> {
  await apiPost<unknown>("/api/simulation/start", {});
  await refresh();
}

async function advanceOnce(delta: number): Promise<void> {
  await apiPost<unknown>("/api/simulation/advance", { delta });
  await refresh();
}

async function resetSimulation(): Promise<void> {
  stopPlayback();
  await apiPost<unknown>("/api/simulation/reset", {});
  state.events = [];
  state.nextSeq = 0;
  await refresh();
}

function scheduleNextTick(): void {
  if (!state.playing) {
    return;
  }

  playTimer = window.setTimeout(() => {
    playTimer = null;
    void runPlaybackTick();
  }, PLAY_INTERVAL_MS);
}

async function runPlaybackTick(): Promise<void> {
  // Playback may have been paused or reset while this timeout was pending.
  if (!state.playing || state.simulation?.status !== "running") {
    stopPlayback();
    render();
    return;
  }

  await enqueue(() => advanceOnce(PLAY_DELTA));

  // Only now that advance + refresh have fully settled do we consider another
  // tick. An error inside withErrorHandling already called stopPlayback(), and
  // a pause during the request already cleared state.playing, so re-reading
  // both conditions here covers every way the loop can end.
  if (!state.playing || state.simulation?.status !== "running") {
    stopPlayback();
    render();
    return;
  }

  scheduleNextTick();
}

function startPlayback(): void {
  if (state.playing || state.simulation?.status !== "running") {
    return;
  }

  state.playing = true;
  render();
  scheduleNextTick();
}

function stopPlayback(): void {
  if (playTimer !== null) {
    window.clearTimeout(playTimer);
    playTimer = null;
  }

  state.playing = false;
}

function render(): void {
  const root = document.querySelector("#app");
  if (root === null) {
    return;
  }

  if (state.scenario === null || state.simulation === null) {
    root.innerHTML = `<p class="muted">Loading scenario…</p>`;
    return;
  }

  const view = buildDashboardView(
    state.scenario,
    state.simulation,
    state.events,
  );

  root.innerHTML = [
    renderHeader(view),
    state.error === null ? "" : `<p class="error">${escapeHtml(state.error)}</p>`,
    renderControls(view),
    renderMap(view),
    renderVehicles(view),
    renderOrders(view),
    renderEvents(view),
  ].join("");

  bindControls();
}

function renderHeader(view: DashboardView): string {
  const statusClass = view.isCompleted
    ? "badge badge-done"
    : view.canAdvance
      ? "badge badge-running"
      : "badge";

  return `
    <header class="header">
      <div>
        <h1>FleetSync</h1>
        <p class="muted">${escapeHtml(view.scenarioName)}</p>
      </div>
      <div class="header-status">
        <span class="${statusClass}">${escapeHtml(view.statusLabel)}</span>
        <span class="sim-time">t = ${String(view.simTime)}</span>
        <span class="muted">${String(view.deliveredCount)}/${String(view.orderCount)} delivered</span>
      </div>
    </header>`;
}

function renderControls(view: DashboardView): string {
  // Advance is disabled during playback so a manual step cannot interleave
  // with the loop's own advance.
  return `
    <section class="controls">
      <button id="btn-start" ${view.canStart ? "" : "disabled"}>Start</button>
      <button id="btn-step" ${view.canAdvance && !state.playing ? "" : "disabled"}>Advance +1</button>
      <button id="btn-play" ${view.canAdvance && !state.playing ? "" : "disabled"}>Play</button>
      <button id="btn-pause" ${state.playing ? "" : "disabled"}>Pause</button>
      <button id="btn-reset">Reset</button>
    </section>`;
}

function renderMap(view: DashboardView): string {
  const edges = view.vehicles
    .flatMap((vehicle) => vehicle.chain)
    .map((stop) => stop.nodeId);

  const nodes = view.layout
    .map((node) => {
      const isVisited = edges.includes(node.id);
      const radius = node.isDepot ? 11 : 8;
      const className = node.isDepot
        ? "map-node map-depot"
        : isVisited
          ? "map-node map-stop"
          : "map-node";

      return `
        <circle cx="${String(node.x)}" cy="${String(node.y)}" r="${String(radius)}" class="${className}" />
        <text x="${String(node.x)}" y="${String(node.y - radius - 6)}" class="map-label">${escapeHtml(node.id)}</text>`;
    })
    .join("");

  const markers = view.markers
    .map(
      (marker) => `
        <circle cx="${String(marker.x)}" cy="${String(marker.y)}" r="7" class="map-vehicle" />
        <text x="${String(marker.x + 11)}" y="${String(marker.y + 4)}" class="map-vehicle-label">${escapeHtml(marker.vehicleId)}</text>`,
    )
    .join("");

  return `
    <section class="panel">
      <h2>Network</h2>
      <svg viewBox="0 0 ${String(LAYOUT_WIDTH)} ${String(LAYOUT_HEIGHT)}" class="map" role="img" aria-label="Fleet network">
        ${nodes}
        ${markers}
      </svg>
    </section>`;
}

function renderVehicles(view: DashboardView): string {
  const cards = view.vehicles
    .map(
      (vehicle) => `
      <article class="card">
        <div class="card-head">
          <strong>${escapeHtml(vehicle.vehicleId)}</strong>
          <span class="badge">${escapeHtml(vehicle.phaseLabel)}</span>
        </div>
        <dl>
          <div><dt>Route</dt><dd>${escapeHtml(vehicle.routeId)}</dd></div>
          <div><dt>Location</dt><dd>${escapeHtml(vehicle.locationLabel)}</dd></div>
          <div><dt>Edge progress</dt><dd>${String(vehicle.edgeProgressPercent)}%</dd></div>
          <div><dt>Travel time</dt><dd>${String(vehicle.totalTravelTime)} / ${String(vehicle.routeTravelTime)}</dd></div>
          <div><dt>Served</dt><dd>${vehicle.servedOrderIds.length === 0 ? "—" : escapeHtml(vehicle.servedOrderIds.join(", "))}</dd></div>
        </dl>
        <div class="progress"><div class="progress-fill" style="width:${String(vehicle.routeProgressPercent)}%"></div></div>
        <ol class="chain">
          ${vehicle.chain
            .map(
              (stop) =>
                `<li class="chain-${stop.state}">${escapeHtml(stop.label)}<span class="muted"> (${escapeHtml(stop.nodeId)})</span></li>`,
            )
            .join("")}
        </ol>
      </article>`,
    )
    .join("");

  return `<section class="panel"><h2>Vehicles</h2><div class="cards">${cards}</div></section>`;
}

function renderOrders(view: DashboardView): string {
  const rows = view.orders
    .map(
      (order) => `
      <tr class="${order.delivered ? "row-done" : ""}">
        <td>${escapeHtml(order.orderId)}</td>
        <td>${escapeHtml(order.nodeId)}</td>
        <td>${escapeHtml(order.assignedTo)}</td>
        <td>${escapeHtml(order.statusLabel)}</td>
      </tr>`,
    )
    .join("");

  return `
    <section class="panel">
      <h2>Orders</h2>
      <table>
        <thead><tr><th>Order</th><th>Node</th><th>Route</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderEvents(view: DashboardView): string {
  const rows = [...view.events]
    .reverse()
    .map(
      (event) => `
      <tr>
        <td>${String(event.seq)}</td>
        <td>${String(event.simTime)}</td>
        <td><code>${escapeHtml(event.type)}</code></td>
        <td>${escapeHtml(event.detail)}</td>
      </tr>`,
    )
    .join("");

  return `
    <section class="panel">
      <h2>Events <span class="muted">(${String(view.events.length)})</span></h2>
      <div class="scroll">
        <table>
          <thead><tr><th>#</th><th>t</th><th>Type</th><th>Detail</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function bindControls(): void {
  bind("#btn-start", () => {
    void enqueue(startSimulation);
  });

  bind("#btn-step", () => {
    void enqueue(() => advanceOnce(PLAY_DELTA));
  });

  // Stopping the timer synchronously means no further tick is scheduled while
  // the reset waits its turn in the queue.
  bind("#btn-reset", () => {
    stopPlayback();
    void enqueue(resetSimulation);
  });

  bind("#btn-play", () => {
    startPlayback();
  });

  bind("#btn-pause", () => {
    stopPlayback();
    render();
  });
}

function bind(selector: string, handler: () => void): void {
  const element = document.querySelector(selector);
  if (element instanceof HTMLButtonElement) {
    element.addEventListener("click", handler);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

void enqueue(async () => {
  state.scenario = await apiGet<ScenarioDto>("/api/simulation/scenario");
  await refresh();
});