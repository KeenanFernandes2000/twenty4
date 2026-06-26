// Shared montage enums (M7) — the z.enum string-unions for `theme` + montage
// `status`. These are HAND-DUPLICATED with the pgEnums of the same name in
// db/schema/enums.ts (`theme`, `montage_status`) — keep both lists in sync.
//
// Kept in their own module so both dto/edl.ts (the strict EDL contract) and
// dto/montage.ts can import them without pulling each other in.
import { z } from "zod";

// Montage theme — drives per-theme pacing/transition/overlay in the EDL builder
// (M7 §2). Stored as `text` on the montage row; the pgEnum exists for a
// documented CREATE TYPE.
export const themeEnum = z.enum(["chill", "party", "clean", "travel", "random", "fast_cut", "soft"]);
export type Theme = z.infer<typeof themeEnum>;

// Montage lifecycle status machine (M7 §2/§4):
//   not_generated → generating → draft_ready → published
// side-branches → failed; (deleted_by_user / removed_by_admin / expired reserved
// for M8/M9).
export const montageStatusEnum = z.enum([
  "not_generated",
  "generating",
  "draft_ready",
  "published",
  "failed",
  "deleted_by_user",
  "removed_by_admin",
  "expired",
]);
export type MontageStatus = z.infer<typeof montageStatusEnum>;
