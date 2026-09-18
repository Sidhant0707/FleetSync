import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFleetSyncServer,
  resolveStaticAssetPath,
} from "./httpServer.js";
import type {
  SimulationStateDto,
} from "./dto.js";

const WEB_ROOT = resolve(
  fileURLToPath(
    new URL("../../../web", import.meta.url),
  ),
);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createFleetSyncServer({
    webRoot: WEB_ROOT,
  });

  await new Promise<void>(
    (resolvePromise) => {
      server.listen(
        0,
        "127.0.0.1",
        resolvePromise,
      );
    },
  );

  const address =
    server.address() as AddressInfo;

  baseUrl =
    `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>(
    (resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise();
        }
      });
    },
  );
});

async function getJson(
  path: string,
): Promise<{
  status: number;
  body: unknown;
}> {
  const response =
    await fetch(`${baseUrl}${path}`);

  return {
    status: response.status,
    body:
      (await response.json()) as unknown,
  };
}

async function postJson(
  path: string,
  payload: unknown,
): Promise<{
  status: number;
  body: unknown;
}> {
  const response = await fetch(
    `${baseUrl}${path}`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  return {
    status: response.status,
    body:
      (await response.json()) as unknown,
  };
}

describe("FleetSync HTTP server", () => {
  it("serves the dashboard root", async () => {
    const response =
      await fetch(`${baseUrl}/`);

    const html =
      await response.text();

    expect(response.status).toBe(200);
    expect(
      response.headers.get(
        "content-type",
      ),
    ).toContain("text/html");

    expect(html).toContain(
      `id="app"`,
    );

    expect(html).toContain(
      "./dist/app.js",
    );
  });

  it("does not expose source or config files", async () => {
    expect(
      (
        await fetch(
          `${baseUrl}/package.json`,
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await fetch(
          `${baseUrl}/tsconfig.json`,
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await fetch(
          `${baseUrl}/src/app.ts`,
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await fetch(
          `${baseUrl}/styles.css`,
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await fetch(
          `${baseUrl}/dist/app.js`,
        )
      ).status,
    ).toBe(200);
  });

  it("runs the complete lifecycle", async () => {
    const initial =
      await getJson(
        "/api/simulation/state",
      );

    expect(initial.status).toBe(200);

    expect(
      (
        initial.body as SimulationStateDto
      ).status,
    ).toBe("not_started");

    const started =
      await postJson(
        "/api/simulation/start",
        {},
      );

    expect(started.status).toBe(200);

    const advanced =
      await postJson(
        "/api/simulation/advance",
        { delta: 5 },
      );

    expect(advanced.status).toBe(200);

    const midway =
      await getJson(
        "/api/simulation/state",
      );

    const midwayState =
      midway.body as SimulationStateDto;

    expect(
      midwayState.simTime,
    ).toBe(5);

    expect(
      midwayState.orders
        .filter(
          (order) => order.delivered,
        )
        .map(
          (order) => order.orderId,
        ),
    ).toEqual(["o1"]);

    await postJson(
      "/api/simulation/advance",
      { delta: 12 },
    );

    const finalState =
      (
        await getJson(
          "/api/simulation/state",
        )
      ).body as SimulationStateDto;

    expect(
      finalState.status,
    ).toBe("completed");

    expect(
      finalState.simTime,
    ).toBe(17);

    expect(
      finalState.orders.every(
        (order) =>
          order.delivered,
      ),
    ).toBe(true);

    const events =
      await getJson(
        "/api/simulation/events?sinceSeq=0",
      );

    expect(events.status).toBe(200);

    const reset =
      await postJson(
        "/api/simulation/reset",
        {},
      );

    expect(reset.status).toBe(200);

    expect(
      (
        await getJson(
          "/api/simulation/state",
        )
      ).body,
    ).toMatchObject({
      status: "not_started",
    });
  });

  it("handles lifecycle and request errors", async () => {
    expect(
      (
        await postJson(
          "/api/simulation/advance",
          { delta: 1 },
        )
      ).status,
    ).toBe(409);

    expect(
      (
        await getJson(
          "/api/simulation/unknown",
        )
      ).status,
    ).toBe(404);

    const malformed =
      await fetch(
        `${baseUrl}/api/simulation/advance`,
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json",
          },
          body: "{not json",
        },
      );

    expect(
      malformed.status,
    ).toBe(400);
  });
});

describe(
  "resolveStaticAssetPath",
  () => {
    it("blocks a path that escapes webRoot", () => {
      expect(
        resolveStaticAssetPath(
          WEB_ROOT,
          "/../../../etc/passwd",
        ),
      ).toEqual({
        ok: false,
        status: 403,
      });
    });

    it("blocks escaped allowlisted extensions too", () => {
      expect(
        resolveStaticAssetPath(
          WEB_ROOT,
          "/../../../../etc/hosts.css",
        ),
      ).toEqual({
        ok: false,
        status: 403,
      });
    });

    it("allows dashboard assets", () => {
      expect(
        resolveStaticAssetPath(
          WEB_ROOT,
          "/styles.css",
        ),
      ).toMatchObject({
        ok: true,
        contentType:
          expect.stringContaining(
            "text/css",
          ),
      });
    });

    it("hides source and config files", () => {
      expect(
        resolveStaticAssetPath(
          WEB_ROOT,
          "/package.json",
        ),
      ).toEqual({
        ok: false,
        status: 404,
      });

      expect(
        resolveStaticAssetPath(
          WEB_ROOT,
          "/src/app.ts",
        ),
      ).toEqual({
        ok: false,
        status: 404,
      });
    });
  },
);