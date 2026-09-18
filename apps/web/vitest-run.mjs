// Windows Git Bash can expose the drive letter in lowercase. Vitest 5 then
// loads duplicate file URLs that differ only by drive-letter case, which
// causes "failed to find the current suite" (or undefined `.config` on
// describe). This launcher canonicalizes the drive letter before starting
// Vitest. Remove it once the upstream Vitest issue is fixed.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

function withCanonicalDrive(filePath) {
  if (process.platform !== "win32") {
    return filePath;
  }

  return filePath.replace(
    /^([a-zA-Z]):/,
    (_, drive) => `${drive.toUpperCase()}:`,
  );
}

const packageDir =
  withCanonicalDrive(
    path.dirname(
      fileURLToPath(import.meta.url),
    ),
  );

process.chdir(packageDir);

const require = createRequire(
  path.join(
    packageDir,
    "package.json",
  ),
);

const vitestCli =
  withCanonicalDrive(
    path.join(
      path.dirname(
        require.resolve(
          "vitest/package.json",
        ),
      ),
      "vitest.mjs",
    ),
  );

const child = spawn(
  process.execPath,
  [
    vitestCli,
    "run",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    cwd: packageDir,
  },
);

child.on("error", (error) => {
  console.error(
    `Failed to start Vitest: ${error.message}`,
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(
      process.pid,
      signal,
    );
    return;
  }

  process.exit(code ?? 1);
});