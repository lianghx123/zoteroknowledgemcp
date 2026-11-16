import { ParseError } from "../shared/contracts/parsing";

export function imageType(bytes: Uint8Array): { extension: string; mediaType: string } {
  if (bytes[0] === 137 && new TextDecoder().decode(bytes.slice(1, 4)) === "PNG") return { extension: "png", mediaType: "image/png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: "jpg", mediaType: "image/jpeg" };
  if (new TextDecoder().decode(bytes.slice(0, 3)) === "GIF") return { extension: "gif", mediaType: "image/gif" };
  if (new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return { extension: "webp", mediaType: "image/webp" };
  throw new ParseError("image-format");
}
