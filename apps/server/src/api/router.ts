import {
  ApiError,
  type SimulationService,
} from "./simulationService.js";

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<
    Record<string, string>
  >;
  readonly body?: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

const ROUTES = {
  scenario:
    "/api/simulation/scenario",
  state:
    "/api/simulation/state",
  events:
    "/api/simulation/events",
  start:
    "/api/simulation/start",
  advance:
    "/api/simulation/advance",
  reset:
    "/api/simulation/reset",
} as const;

export function handleApiRequest(
  service: SimulationService,
  request: ApiRequest,
): ApiResponse {
  try {
    return route(
      service,
      request,
    );
  } catch (error) {
    if (
      error instanceof ApiError
    ) {
      return {
        status: error.statusCode,
        body: {
          error: error.message,
        },
      };
    }

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return {
      status: 500,
      body: {
        error: message,
      },
    };
  }
}

function route(
  service: SimulationService,
  request: ApiRequest,
): ApiResponse {
  const {
    method,
    path,
  } = request;

  switch (path) {
    case ROUTES.scenario:
      requireMethod(
        method,
        "GET",
      );

      return {
        status: 200,
        body:
          service.getScenario(),
      };

    case ROUTES.state:
      requireMethod(
        method,
        "GET",
      );

      return {
        status: 200,
        body:
          service.getState(),
      };

    case ROUTES.events:
      requireMethod(
        method,
        "GET",
      );

      return {
        status: 200,
        body: service.getEvents(
          parseSinceSeq(
            request.query?.[
              "sinceSeq"
            ],
          ),
        ),
      };

    case ROUTES.start:
      requireMethod(
        method,
        "POST",
      );

      return {
        status: 200,
        body: service.start(),
      };

    case ROUTES.advance:
      requireMethod(
        method,
        "POST",
      );

      return {
        status: 200,
        body: service.advance(
          readDelta(
            request.body,
          ),
        ),
      };

    case ROUTES.reset:
      requireMethod(
        method,
        "POST",
      );

      return {
        status: 200,
        body: service.reset(),
      };

    default:
      return {
        status: 404,
        body: {
          error: `Unknown endpoint: ${method} ${path}`,
        },
      };
  }
}

function requireMethod(
  actual: string,
  expected: "GET" | "POST",
): void {
  if (
    actual !== expected
  ) {
    throw new ApiError(
      405,
      `Method ${actual} not allowed; use ${expected}`,
    );
  }
}

function parseSinceSeq(
  raw: string | undefined,
): number {
  if (
    raw === undefined ||
    raw === ""
  ) {
    return 0;
  }

  const parsed =
    Number(raw);

  if (
    !Number.isInteger(
      parsed,
    ) ||
    parsed < 0
  ) {
    throw new ApiError(
      400,
      `sinceSeq must be a non-negative integer, got ${raw}`,
    );
  }

  return parsed;
}

function readDelta(
  body: unknown,
): number {
  if (
    typeof body !== "object" ||
    body === null
  ) {
    throw new ApiError(
      400,
      "Request body must be a JSON object with a delta",
    );
  }

  const delta =
    (
      body as Record<
        string,
        unknown
      >
    )["delta"];

  if (
    typeof delta !== "number"
  ) {
    throw new ApiError(
      400,
      `delta must be a number, got ${describe(delta)}`,
    );
  }

  return delta;
}

function describe(
  value: unknown,
): string {
  if (
    value === undefined
  ) {
    return "undefined";
  }

  return (
    JSON.stringify(value) ??
    "undefined"
  );
}