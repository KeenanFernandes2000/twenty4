// Invite-code generation — ~10-char base62, URL-safe, cryptographically random.
// Collision is handled at the route layer (insert retry on the unique(code)).
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CODE_LEN = 10;

// Rejection-sampled base62 so the distribution is uniform (no modulo bias).
export function generateInviteCode(len = CODE_LEN): string {
  let out = "";
  while (out.length < len) {
    const bytes = randomBytes(len);
    for (let i = 0; i < bytes.length && out.length < len; i++) {
      const b = bytes[i]!;
      if (b < 248) out += ALPHABET[b % 62]; // 248 = floor(256/62)*62; reject the rest
    }
  }
  return out;
}
