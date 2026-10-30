import { describe, it, expect } from "vitest";
import { RuntimeRegistry, PlaceholderRuntime } from "../runtime/executionRuntime.js";

describe("RuntimeRegistry", () => {
  it("resolves registered runtime", () => {
    const reg = new RuntimeRegistry();
    const rt = new PlaceholderRuntime();
    reg.register("python:3.12", rt);
    expect(reg.resolve("python:3.12")).toBe(rt);
    expect(reg.has("python:3.12")).toBe(true);
  });
  it("returns undefined for unknown runtime", () => {
    const reg = new RuntimeRegistry();
    expect(reg.resolve("bash")).toBeUndefined();
  });
});
