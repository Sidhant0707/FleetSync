import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import {
  extname,
  join,
  normalize,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { SimulationService } from "./simulationService.js";
import {
  handleApiRequest,
  type ApiRequest,
} from "./router.js";

export interface FleetSyncServerOptions {
  readonly service?: SimulationService;
  readonly webRoot?: string;
}

const DEFAULT_WEB_ROOT = resolve(
  fileURLToPath(new URL("../../../web", import.meta.url)),
);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createFleetSyncServer(
  options: FleetSyncServerOptions = {},
): Server {
  const service =
    options.service ?? new SimulationService();

  const webRoot = resolve(
    options.webRoot ?? DEFAULT_WEB_ROOT,
  );

  return createServer((request, response) => {
    void handle(
      service,
      webRoot,
      request,
      response,
    ).catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (response.headersSent) {
        response.destroy();
        return;
      }

      sendJson(response, 500, {
        error: message,
      });
    });
  });
}

async function handle(
  service: SimulationService,
  webRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    "http://localhost",
  );

  const method = request.method ?? "GET";

  if (url.pathname.startsWith("/api/")) {
    let body: unknown;

    if (method === "POST") {
      const raw = await readBody(request);

      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          sendJson(response, 400, {
            error: "Request body is not valid JSON",
          });
          return;
        }
      } else {
        body = {};
      }
    }

    const apiRequest: ApiRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(
        url.searchParams.entries(),
      ),
      body,
    };

    const result = handleApiRequest(
      service,
      apiRequest,
    );

    sendJson(
      response,
      result.status,
      result.body,
    );

    return;
  }

  await serveStatic(
    webRoot,
    url.pathname,
    response,
  );
}

function readBody(
  request: IncomingMessage,
): Promise<string> {
  return new Promise(
    (resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];

      request.on(
        "data",
        (chunk: Buffer) => {
          chunks.push(chunk);
        },
      );

      request.on("end", () => {
        resolvePromise(
          Buffer.concat(chunks).toString("utf8"),
        );
      });

      request.on(
        "error",
        rejectPromise,
      );
    },
  );
}

export type StaticAssetResolution =
  | {
      readonly ok: true;
      readonly target: string;
      readonly contentType: string;
    }
  | {
      readonly ok: false;
      readonly status: 403 | 404;
    };

export function resolveStaticAssetPath(
  webRoot: string,
  pathname: string,
): StaticAssetResolution {
  const root = resolve(webRoot);

  const relativePath =
    pathname === "/"
      ? "index.html"
      : pathname.slice(1);

  const target = resolve(
    join(
      root,
      normalize(relativePath),
    ),
  );

  if (
    target !== root &&
    !target.startsWith(root + sep)
  ) {
    return {
      ok: false,
      status: 403,
    };
  }

  const contentType =
    CONTENT_TYPES[extname(target)];

  if (contentType === undefined) {
    return {
      ok: false,
      status: 404,
    };
  }

  return {
    ok: true,
    target,
    contentType,
  };
}

async function serveStatic(
  webRoot: string,
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const resolution =
    resolveStaticAssetPath(
      webRoot,
      pathname,
    );

  if (!resolution.ok) {
    sendJson(
      response,
      resolution.status,
      {
        error:
          resolution.status === 403
            ? "Forbidden"
            : `Not found: ${pathname}`,
      },
    );

    return;
  }

  try {
    const file =
      await readFile(resolution.target);

    response.writeHead(200, {
      "content-type":
        resolution.contentType,
      "cache-control": "no-store",
    });

    response.end(file);
  } catch {
    sendJson(
      response,
      404,
      {
        error: `Not found: ${pathname}`,
      },
    );
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);

  response.writeHead(status, {
    "content-type":
      "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  response.end(payload);
}