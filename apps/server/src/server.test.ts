import { describe, expect, it } from "vitest";
import * as indexModule from "./index.js";
import { DEFAULT_PORT, readPort } from "./server.js";

describe("server bootstrap", () => {
  it("keeps index.ts side-effect free", () => {
    expect(Object.keys(indexModule).sort()).toEqual([
      "RoadGraph",
      "placeholder",
      "shortestPath",
    ]);
  });

  it("uses port 4000 by default", () => {
    expect(readPort(undefined)).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(4000);
  });

  it("accepts a valid explicit port", () => {
    expect(readPort("4000")).toBe(4000);
    expect(readPort("65535")).toBe(65535);
    expect(readPort("1")).toBe(1);
  });

  it("rejects invalid ports", () => {
    expect(() => readPort("0")).toThrow();
    expect(() => readPort("65536")).toThrow();
    expect(() => readPort("-1")).toThrow();
    expect(() => readPort("abc")).toThrow();
    expect(() => readPort("4.5")).toThrow();
  });
});