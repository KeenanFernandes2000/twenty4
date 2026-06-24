// Magic-byte container sniffer (M4 CRITICAL-1). Dependency-free header inspection
// so the worker validates the ACTUAL container bytes rather than trusting the
// client-declared / HeadObject content-type. The verdict gates `valid` BEFORE the
// timestamp hierarchy runs: a non-image / mislabeled file is rejected outright.
//
// Containers we recognise:
//   - JPEG: starts FF D8 FF
//   - PNG:  starts 89 50 4E 47 0D 0A 1A 0A
//   - ISO-BMFF (`ftyp` box): bytes 4..8 == "ftyp"; major brand at 8..12 tells
//     HEIC vs MP4 vs MOV. MOV/QuickTime is also recognised by a top-level
//     `moov`/`mdat`/`free`/`wide`/`skip` atom.
//
// Returns a coarse container family; the caller maps it to the declared mediaType.

export type SniffedContainer = "jpeg" | "png" | "heic" | "mp4" | "mov" | "unknown";

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1", "hevx"]);
// MP4 / fragmented-mp4 brand families.
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "mmp4",
  "m4v ",
  "m4a ",
  "f4v ",
  "ndsc",
]);
// QuickTime brand (the trailing two spaces are significant: "qt  ").
const MOV_BRANDS = new Set(["qt  "]);
// Top-level atoms that mark a QuickTime/ISO-BMFF stream when there is no `ftyp`.
const ISO_TOP_ATOMS = new Set(["moov", "mdat", "free", "skip", "wide", "pnot"]);

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString("latin1");
}

/**
 * Sniff the container family from the leading bytes. Never throws; returns
 * "unknown" for anything unrecognised (callers treat that as a rejection).
 */
export function sniffContainer(bytes: Buffer): SniffedContainer {
  if (bytes.length < 12) return "unknown";

  // JPEG — FF D8 FF.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";

  // PNG — 89 50 4E 47 0D 0A 1A 0A.
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }

  // ISO-BMFF `ftyp` box: size(4) + "ftyp"(4) + major brand(4).
  const box = ascii(bytes, 4, 8);
  if (box === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (HEIC_BRANDS.has(brand)) return "heic";
    if (MOV_BRANDS.has(brand)) return "mov";
    if (MP4_BRANDS.has(brand)) return "mp4";
    // Unknown ftyp brand: assume mp4 family (most permissive video container).
    // We still return "unknown" so an unrecognised brand is rejected — the spec
    // wants an explicit allowlist, not a catch-all.
    return "unknown";
  }

  // No `ftyp`: a top-level QuickTime/ISO atom (moov/mdat/...) → treat as MOV.
  const topAtom = ascii(bytes, 4, 8);
  if (ISO_TOP_ATOMS.has(topAtom)) return "mov";

  return "unknown";
}

/**
 * Does the sniffed container satisfy the declared mediaType?
 *   photo ⇒ jpeg | png | heic
 *   video ⇒ mp4  | mov
 */
export function sniffMatchesMediaType(
  mediaType: "photo" | "video",
  container: SniffedContainer,
): boolean {
  if (container === "unknown") return false;
  if (mediaType === "photo") return container === "jpeg" || container === "png" || container === "heic";
  return container === "mp4" || container === "mov";
}
