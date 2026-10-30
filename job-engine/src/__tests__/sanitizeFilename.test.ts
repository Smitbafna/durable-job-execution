import { describe, it, expect } from "vitest";
import { sanitizeFilename } from "../util/sanitizeFilename.js";

describe("sanitizeFilename", () => {
  it("strips path components", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a/b/c.zip")).toBe("c.zip");
  });
  it("handles empty and dot", () => {
    expect(sanitizeFilename("")).toBe("upload.zip");
    expect(sanitizeFilename("..")).toBe("upload.zip");
  });
  it("truncates long names", () => {
    const long = "a".repeat(300) + ".zip";
    expect(sanitizeFilename(long).length).toBe(255);
  });
  it("removes control chars", () => {
    expect(sanitizeFilename("bad\x00name.zip")).toBe("badname.zip");
  });
  it("non-string returns default", () => {
    expect(sanitizeFilename(42 as unknown)).toBe("upload.zip");
  });
});