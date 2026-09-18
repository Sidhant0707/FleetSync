import { fileURLToPath } from "node:url";
import { createFleetSyncServer } from "./api/httpServer.js";

export const DEFAULT_PORT = 4000;

export function readPort(
  raw: string | undefined = process.env["PORT"],
): number {
  if (raw === undefined || raw === "") {
    return DEFAULT_PORT;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `PORT must be an integer between 1 and 65535, got ${raw}`,
    );
  }

  return parsed;
}

export function startServer(port: number = readPort()) {
  const server = createFleetSyncServer();

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${String(port)} is already in use.`);
    } else {
      console.error("FleetSync server error:", error);
    }

    process.exitCode = 1;
  });

  server.listen(port, () => {
    console.log(
      `FleetSync server listening on http://localhost:${String(port)}`,
    );
  });

  return server;
}

/*
 * Importing this module must NOT automatically open a socket.
 * The server starts only when this file itself is the process entry point.
 */
const invokedPath = process.argv[1];

if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === invokedPath
) {
  startServer();
}