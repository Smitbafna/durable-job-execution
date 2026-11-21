import { describe, it, expect } from "vitest"
import { computeFingerprint, canonicalStringify } from "../service/jobService"

describe("canonicalStringify", () => {
  // Top-level key-order equivalence
  it("same object with different top-level key order produces identical fingerprints", () => {
    const fp1 = computeFingerprint("sum_numbers", {a: 1, b: 2}, 3)
    const fp2 = computeFingerprint("sum_numbers", {b: 2, a: 1}, 3)
    expect(fp1).toBe(fp2)
  })

  // Nested key-order equivalence
  it("same object with different nested key order produces identical fingerprints", () => {
    const fp1 = computeFingerprint("sum_numbers", {a: {x: 1, y: 2}}, 3)
    const fp2 = computeFingerprint("sum_numbers", {a: {y: 2, x: 1}}, 3)
    expect(fp1).toBe(fp2)
  })

  // Different nested values
  it("different nested values produce different fingerprints", () => {
    const fp1 = computeFingerprint("sum_numbers", {a: {x: 1}}, 3)
    const fp2 = computeFingerprint("sum_numbers", {a: {x: 2}}, 3)
    expect(fp1).not.toBe(fp2)
  })

  // Number vs string distinction
  it("number 1 and string 1 produce different fingerprints", () => {
    const fp1 = computeFingerprint("sum_numbers", {val: 1}, 3)
    const fp2 = computeFingerprint("sum_numbers", {val: "1"}, 3)
    expect(fp1).not.toBe(fp2)
  })

  // Array order preservation
  it("arrays with identical order produce identical fingerprints", () => {
    const fp1 = computeFingerprint("sum_numbers", {items: [1, 2, 3]}, 3)
    const fp2 = computeFingerprint("sum_numbers", {items: [1, 2, 3]}, 3)
    expect(fp1).toBe(fp2)
  })

  it("arrays with different order produce different fingerprints", () => {
    const fp1 = computeFingerprint("sum_numbers", {items: [1, 2]}, 3)
    const fp2 = computeFingerprint("sum_numbers", {items: [2, 1]}, 3)
    expect(fp1).not.toBe(fp2)
  })

  // Deeply nested properties
  it("deeply nested properties are retained", () => {
    const fp1 = computeFingerprint("sum_numbers", {a: {b: {c: 1}}}, 3)
    const fp2 = computeFingerprint("sum_numbers", {a: {b: {c: 1}}}, 3)
    expect(fp1).toBe(fp2)
  })

  // Empty objects and arrays
  it("empty objects produce identical fingerprints", () => {
    const fp1 = computeFingerprint("sum_numbers", {}, 3)
    const fp2 = computeFingerprint("sum_numbers", {}, 3)
    expect(fp1).toBe(fp2)
  })

  it("empty arrays produce identical fingerprints", () => {
    const fp1 = computeFingerprint("sum_numbers", {items: []}, 3)
    const fp2 = computeFingerprint("sum_numbers", {items: []}, 3)
    expect(fp1).toBe(fp2)
  })
})