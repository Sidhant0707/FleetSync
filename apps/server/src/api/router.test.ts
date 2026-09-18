import { describe, expect, it } from "vitest";
import {
  handleApiRequest,
  type ApiRequest,
} from "./router.js";
import { SimulationService } from "./simulationService.js";
import type { SimulationStateDto } from "./dto.js";

function get(
  path: string,
  query?: Record<string, string>,
): ApiRequest {
  return query === undefined
    ? { method: "GET", path }
    : { method: "GET", path, query };
}

function post(
  path: string,
  body?: unknown,
): ApiRequest {
  return {
    method: "POST",
    path,
    body: body ?? {},
  };
}

function asState(body: unknown): SimulationStateDto {
  return body as SimulationStateDto;
}

describe("handleApiRequest", () => {
  it("returns the scenario", () => {
    const response = handleApiRequest(
      new SimulationService(),
      get("/api/simulation/scenario"),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      depot: { nodeId: "D" },
    });
  });

  it("returns the initial state", () => {
    const response = handleApiRequest(
      new SimulationService(),
      get("/api/simulation/state"),
    );

    expect(response.status).toBe(200);
    expect(asState(response.body).status).toBe(
      "not_started",
    );
  });

  it("starts the simulation", () => {
    const service = new SimulationService();

    const response = handleApiRequest(
      service,
      post("/api/simulation/start"),
    );

    expect(response.status).toBe(200);
    expect(service.getState().status).toBe("running");
  });

  it("returns 409 when starting twice", () => {
    const service = new SimulationService();

    handleApiRequest(
      service,
      post("/api/simulation/start"),
    );

    const response = handleApiRequest(
      service,
      post("/api/simulation/start"),
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: "Simulation has already been started",
    });
  });

  it("returns 409 when advancing before start", () => {
    const response = handleApiRequest(
      new SimulationService(),
      post("/api/simulation/advance", { delta: 1 }),
    );

    expect(response.status).toBe(409);
  });

  it("advances by the requested delta", () => {
    const service = new SimulationService();

    handleApiRequest(
      service,
      post("/api/simulation/start"),
    );

    const response = handleApiRequest(
      service,
      post("/api/simulation/advance", { delta: 4 }),
    );

    expect(response.status).toBe(200);
    expect(service.getState().simTime).toBe(4);
    expect(response.body).toMatchObject({
      state: { simTime: 4 },
    });
  });

  it("advances repeatedly and reports completion", () => {
    const service = new SimulationService();

    handleApiRequest(
      service,
      post("/api/simulation/start"),
    );

    let last = handleApiRequest(
      service,
      post("/api/simulation/advance", { delta: 1 }),
    );

    for (let i = 0; i < 25; i += 1) {
      last = handleApiRequest(
        service,
        post("/api/simulation/advance", { delta: 1 }),
      );
    }

    expect(last.status).toBe(200);
    expect(service.getState()).toMatchObject({
      status: "completed",
      simTime: 17,
    });
  });

  it("returns 400 for invalid delta input", () => {
    const service = new SimulationService();

    handleApiRequest(
      service,
      post("/api/simulation/start"),
    );

    expect(
      handleApiRequest(
        service,
        post("/api/simulation/advance", {}),
      ).status,
    ).toBe(400);

    expect(
      handleApiRequest(
        service,
        post("/api/simulation/advance", {
          delta: "1",
        }),
      ).status,
    ).toBe(400);

    expect(
      handleApiRequest(
        service,
        {
          method: "POST",
          path: "/api/simulation/advance",
          body: null,
        },
      ).status,
    ).toBe(400);
  });

  it("returns 400 for a negative delta", () => {
    const service = new SimulationService();

    handleApiRequest(
      service,
      post("/api/simulation/start"),
    );

    const response = handleApiRequest(
      service,
      post("/api/simulation/advance", {
        delta: -5,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns events after a sequence number", () => {
    const service = new SimulationService();

    handleApiRequest(
      service,
      post("/api/simulation/start"),
    );

    handleApiRequest(
      service,
      post("/api/simulation/advance", {
        delta: 5,
      }),
    );

    const response = handleApiRequest(
      service,
      get("/api/simulation/events", {
        sinceSeq: "5",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      nextSeq: service.getState().eventCount,
    });
  });

  it("returns 400 for invalid sinceSeq", () => {
    const response = handleApiRequest(
      new SimulationService(),
      get("/api/simulation/events", {
        sinceSeq: "-2",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("resets to a fresh simulation", () => {
    const service = new SimulationService();

    handleApiRequest(
      service,
      post("/api/simulation/start"),
    );

    handleApiRequest(
      service,
      post("/api/simulation/advance", {
        delta: 6,
      }),
    );

    const response = handleApiRequest(
      service,
      post("/api/simulation/reset"),
    );

    expect(response.status).toBe(200);
    expect(service.getState()).toMatchObject({
      status: "not_started",
      simTime: 0,
    });
  });

  it("returns 405 for the wrong method", () => {
    const response = handleApiRequest(
      new SimulationService(),
      post("/api/simulation/state"),
    );

    expect(response.status).toBe(405);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("GET"),
    });
  });

  it("returns 404 for an unknown endpoint", () => {
    const response = handleApiRequest(
      new SimulationService(),
      get("/api/simulation/nonsense"),
    );

    expect(response.status).toBe(404);
  });

  it("is deterministic for identical request sequences", () => {
    const runOnce = (): unknown => {
      const service = new SimulationService();

      handleApiRequest(
        service,
        post("/api/simulation/start"),
      );

      handleApiRequest(
        service,
        post("/api/simulation/advance", {
          delta: 9,
        }),
      );

      return handleApiRequest(
        service,
        get("/api/simulation/state"),
      ).body;
    };

    expect(runOnce()).toEqual(runOnce());
  });
});
