// @twenty4/worker — BullMQ job runner (placeholder).
// No jobs until M7 (render pipeline) / deletion lifecycle. M0 ships an empty
// entrypoint so the workspace resolves and the layout is complete.

export function startWorker(): void {
  // Intentionally empty at M0. Render + deletion jobs land in M7+.
}

if (import.meta.main) {
  startWorker();
}
