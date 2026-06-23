# Sample media — montage test fixtures

Drop **~10–30 mixed photos and videos** here. These are the inputs used to test the montage maker.

Referenced by:
- **M6** (`reference/milestones/M6-capture-today.md`) — gallery-import testing.
- **M7** (`reference/milestones/M7-montage.md`) — the §7.5 render gate runs against this folder and must produce a real 1080×1920 ~30s h264 MP4.

## What to provide

- **Photos:** JPG / PNG / HEIC.
- **Videos:** MP4 / MOV, each ≤ 60s (per the spec's per-clip limit).
- A realistic mix (some bright/sharp, some motion, some with faces) so the clip-scoring heuristics have something to discriminate.
- Keep total volume reasonable for git; if files are large, we can switch this to a gitignored local path instead.

> This README is a placeholder so the folder is tracked. Replace/augment with the actual media when ready.
