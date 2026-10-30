import { describe, it, expect } from "vitest";
import { validateExecutionSpec } from "../domain/executionSpec.js";
import { AppError } from "../errors.js";

const valid = {
  artifactId: "123e4567-e89b-41d4-a716-446655440000",
  runtime: "python:3.12",
  command: ["python", "main.py"],
  workingDirectory: ".",
  input: { x: 1 },
  resources: { cpu: 1, memoryMb: 128, timeoutSeconds: 10 },
};

describe("validateExecutionSpec", () => {
  it("accepts valid spec", () => {
    const r = validateExecutionSpec(valid);
    expect(r).not.toBeInstanceOf(AppError);
  });
  it("rejects missing artifactId", () => {
    const r = validateExecutionSpec({ ...valid, artifactId: "" });
    expect(r).toBeInstanceOf(AppError);
  });
  it("rejects malformed artifactId", () => {
    const r = validateExecutionSpec({ ...valid, artifactId: "not-a-uuid" });
    expect(r).toBeInstanceOf(AppError);
  });
  it("rejects excessively large input", () => {
    const r = validateExecutionSpec({ ...valid, input: { data: "x".repeat(70000) } });
    expect(r).toBeInstanceOf(AppError);
  });
  it("rejects excessively nested input", () => {
    let nested: any = {};
    for (let i = 0; i < 20; i++) nested = { n: nested };
    const r = validateExecutionSpec({ ...valid, input: nested });
    expect(r).toBeInstanceOf(AppError);
  });
  it("rejects unknown runtime", () => {
    const r = validateExecutionSpec({ ...valid, runtime: "bash" });
    expect(r).toBeInstanceOf(AppError);
  });
  it("rejects empty command", () => {
    const r = validateExecutionSpec({ ...valid, command: [] });
    expect(r).toBeInstanceOf(AppError);
  });
  it("rejects absolute workingDirectory", () => {
    const r = validateExecutionSpec({ ...valid, workingDirectory: "/tmp" });
    expect(r).toBeInstanceOf(AppError);
  });
  it("rejects traversal workingDirectory", () => {
    const r = validateExecutionSpec({ ...valid, workingDirectory: "../x" });
    expect(r).toBeInstanceOf(AppError);
  });
  it("rejects invalid resource values", () => {
    const r = validateExecutionSpec({
      ...valid,
      resources: { cpu: 0, memoryMb: 1, timeoutSeconds: 1 },
    });
    expect(r).toBeInstanceOf(AppError);
  });
  it("rejects unknown fields", () => {
    const r = validateExecutionSpec({ ...valid, foo: 1 });
    expect(r).toBeInstanceOf(AppError);
  });
  it("rejects invalid input", () => {
    const r = validateExecutionSpec({ ...valid, input: [1, 2] });
    expect(r).toBeInstanceOf(AppError);
  });
});
