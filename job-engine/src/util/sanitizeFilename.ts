/** Sanitizes an untrusted client-supplied filename for metadata storage. */
export function sanitizeFilename(input: unknown): string {
  if (typeof input !== "string") return "upload.zip";
  let name = input.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\x00-\x1f\x7f]/g, "");
  name = name.trim();
  if (name === "" || name === "." || name === "..") {
    name = "upload.zip";
  }
  if (name.length > 255) {
    name = name.slice(0, 255);
  }
  return name;
}