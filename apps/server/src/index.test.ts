import { describe, expect, it } from "vitest";
import { placeholder } from "./index.js";

describe("placeholder", () => {
  it("returns fleetsync", () => {
    expect(placeholder()).toBe("fleetsync");
  });
});
