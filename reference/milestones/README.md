# twenty4 Rebuild — Milestone Plans (M0–M9, the MVP)

Individual, detailed planning files for each MVP milestone. Derived from `reference/REBUILD_PLAN.md` (the high-level sequence), `reference/twenty4_Development_Spec.md` (authoritative product spec), and `reference/PHASE1_WORK_RECAP.md` (lessons from the first build).

**Read order:** this README (locked decisions + conventions) → `M0` … → `M9`.

---

## Locked decisions (apply to every milestone)

| Area | Decision |
|---|---|
| Approach | **Clean rewrite.** The old `phase-1-foundation` code is a *reference for learnings only* — do not copy it. Rebuild each module fresh, applying the recap's fixes from the start. |
| Language | **TypeScript everywhere. No Python** — including beat detection (TS/WASM, e.g. essentia.js, not aubio/librosa). |
| Runtime / PM | **Bun** for API, packages, scripts, tests. **Node** only where unavoidable: Metro (Expo bundling) and Remotion (render). |
| Local infra | **Docker compose** for Postgres + Redis + MinIO. One canonical infra story (no parallel host-based path). MinIO must still be reachable from the Android device over LAN/Tailscale. |
| Tests | **Live-stack integration** against real Postgres/Redis/MinIO (the phase-1 approach that caught a real bug nearly every slice). |
| Auth (MVP) | **Phone + email OTP.** Apple/Google/social deferred to M14. **Email OTP via the canonical email service** (nodemailer → **Mailpit** in dev, **SES**-ready for prod, Handlebars templates, `NODE_ENV`-switched). **Phone OTP via a dev console transport** until an SMS vendor (M15). |
| Montage | **Remotion from the start** at M7 (no ffmpeg stub). Keep the swappable `Renderer` interface so Lambda is a later drop-in. |
| Sample media | Provided by the user in a tracked **`fixtures/sample-media/`** folder (~10–30 mixed photos/videos). Used for montage testing in **M6 (import)** and **M7 (render)**. |
| Design | **Reuse the Ember design tokens** extracted from `reference/Spool.html` (dark theme: colors, fonts, spacing), re-implemented in React Native. |
| Mobile runtime | **Expo Go first, Android-first.** JS-only libs through MVP. Foreground/streaming uploads only; background/native upload + dev-client deferred to M13. iOS deferred to M14. |
| Branching | **Single `rebuild/v2` branch** off `main`, **one commit per milestone**, each merged only after its Android acceptance check passes. |
| Source of truth | Product behavior = `twenty4_Development_Spec.md` (it supersedes the PRD and resolves Q1–Q15). Don't re-decide spec-locked items (day-window 4am→4am, upload limits, MIME allowlist, 11-table model, invite 7-day/25-use, reaction set, 24h deletion contract). |

## Cross-cutting conventions

- **Contracts-as-spine:** all Drizzle schema, Zod DTOs, EDL, enums, and the error taxonomy live in `packages/contracts` (single source of truth, consumed as TS source, no build step).
- **Error envelope:** every API error returns `{ error: { code, status, message } }`.
- **Migrations:** Drizzle; include `enums.ts` in the schema set; first migration prepends `CREATE EXTENSION citext, pgcrypto`.
- **Drizzle single-copy:** pin one physical `drizzle-orm` from day one (kysely devDep on the contracts package + dedupe lever) **before** adding Better Auth.
- **Day-window:** 4am→4am in device-local tz, resolved server-side, persisted on the row, never recomputed at read.
- **Storage:** S3-compatible, signed-URL only, no public read; presign host must equal the host the client connects to.
- **Analytics firewall:** allow-listed event dimensions only; never store user id or content in analytics.
- Every milestone ends with an explicit **Android (Expo Go) acceptance check** on a real device.

---

## File template (each Mx file follows this structure)

```
# Mx — <Name>
> Spec phase: P1 · Depends on: <prior milestones> · Branch commit: <one per milestone on rebuild/v2>

## 1. Goal
One or two sentences: what's demonstrably true on-device when this milestone is done.

## 2. Scope
- In scope: …
- Explicitly out of scope (and which later milestone owns it): …

## 3. Tasks (ordered checklist)
- [ ] concrete, verifiable steps…

## 4. Data model & migrations
Tables/columns/enums touched; migration name(s). "None" if N/A.

## 5. API endpoints
Method + path + auth + one-line purpose. "None" if N/A.

## 6. Mobile (Expo Go, Android)
Screens/components/stores added or wired. "None" if N/A.

## 7. Tests (live-stack)
Specific integration tests to write and what they assert.

## 8. Acceptance criteria
Bulleted, verifiable. MUST include a concrete **Android device check**.

## 9. Dependencies & prerequisites
Libs/services/env that must exist first.

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md)
The specific recap pitfalls this milestone must pre-empt, cited.

## 11. Open decisions / flags
Anything still needing a call (with the current default).
```

---

## Milestone index

| # | File | Goal |
|---|---|---|
| M0 | `M0-foundations.md` | Bun monorepo + Docker infra + Android↔backend networking proven |
| M1 | `M1-api-skeleton.md` | Fastify-on-Bun base: health, DB-verify, error envelope, content-type, CORS |
| M2 | `M2-auth.md` | Better Auth phone + email OTP, sessions, guards |
| M3 | `M3-groups.md` | Private groups + invite/join + membership authz |
| M4 | `M4-storage-upload.md` | Presigned direct-PUT, day-bucket, validation — device-verified |
| M5 | `M5-mobile-shell.md` | Expo Go app on Android: routing, API client, auth + group screens |
| M6 | `M6-capture-today.md` | Camera + gallery import, today bucket, upload-progress UI |
| M7 | `M7-montage.md` | Remotion render pipeline (BullMQ) → generate → review → publish |
| M8 | `M8-feed-social.md` | Block-filtered feed, reactions, comments |
| M9 | `M9-ephemerality.md` | 24h hard-delete contract: expire/cleanup jobs, replace flow |

🧪 **Thin core loop** demonstrable at end of M8 · ✅ **MVP / Phase-1 Alpha** complete at end of M9.
