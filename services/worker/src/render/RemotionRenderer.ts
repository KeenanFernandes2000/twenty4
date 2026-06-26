// RemotionRenderer (M7 §2/§3) — drives the FIXED infra/remotion render driver by
// SPAWNING `node infra/remotion/render.mjs` (Remotion needs Node; the worker stays
// on Bun and shells out, same philosophy as ffprobe). It writes edl.json + srcmap
// .json into a temp dir, runs the child with the §10 perf knobs (gl=null, x264
// veryfast, concurrency 1), enforces a HARD watchdog (SIGKILL on RENDER_TIMEOUT_MS),
// captures stderr for retryable-failure mapping, and on success reads result.json.
//
// On success the temp dir is LEFT in place (it holds montage.mp4/thumb.jpg the
// caller must upload) — the caller cleans dirname(videoPath). On failure the dir is
// self-cleaned before rejecting.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "@twenty4/contracts";
import type { Edl } from "@twenty4/contracts";
import { resolveInfraDir } from "../montage/infraDir.ts";
import type { Renderer, RenderResult } from "./Renderer.ts";

export class RemotionRenderer implements Renderer {
  constructor(private readonly env: Env) {}

  // Absolute path to render.mjs (INFRA_REMOTION_DIR resolved robustly: cwd then
  // walk-up from the module, so a non-repo-root cwd still finds the driver).
  private renderScriptPath(): string {
    return join(resolveInfraDir(this.env), "render.mjs");
  }

  async render(edl: Edl, srcMap: Record<string, string>): Promise<RenderResult> {
    const out = await mkdtemp(join(tmpdir(), "t4render-"));
    try {
      const edlPath = join(out, "edl.json");
      const srcmapPath = join(out, "srcmap.json");
      await writeFile(edlPath, JSON.stringify(edl));
      await writeFile(srcmapPath, JSON.stringify(srcMap));

      const script = this.renderScriptPath();
      const args = [
        script,
        "--edl",
        edlPath,
        "--srcmap",
        srcmapPath,
        "--out",
        out,
        "--gl",
        this.env.RENDER_GL,
        "--concurrency",
        String(this.env.REMOTION_CONCURRENCY),
        "--timeout",
        String(this.env.RENDER_TIMEOUT_MS),
        // MEDIA_SERVER_PORT (0 = ephemeral, the safe default) — lets ops pin the
        // local media server to a fixed port (firewall/observability).
        "--port",
        String(this.env.MEDIA_SERVER_PORT),
      ];

      await this.spawnRender(args, this.env.RENDER_TIMEOUT_MS);

      const result = JSON.parse(await readFile(join(out, "result.json"), "utf8")) as {
        durationMs: number;
        videoFile: string;
        thumbnailFile: string;
      };
      return {
        videoPath: join(out, result.videoFile),
        thumbnailPath: join(out, result.thumbnailFile),
        durationMs: result.durationMs,
      };
    } catch (err) {
      // Self-clean on failure (success path leaves the dir for the caller to upload).
      await rm(out, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  // Spawn `node <args>`; reject on non-zero exit (with captured stderr) or watchdog.
  private spawnRender(args: string[], timeoutMs: number): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const child = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let settled = false;

      // HARD watchdog: kill the child if it overruns the render budget.
      const watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`render watchdog: exceeded ${timeoutMs}ms — child SIGKILLed`));
      }, timeoutMs);

      child.stderr.on("data", (d) => {
        stderr += d.toString();
        // Bound the captured stderr so a chatty render can't balloon memory.
        if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
      });
      child.stdout.on("data", () => {}); // drain the machine-readable result line

      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        reject(new Error(`render spawn error: ${e.message}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        if (code === 0) resolvePromise();
        else reject(new Error(`render exited ${code}: ${stderr.slice(-2000) || "(no stderr)"}`));
      });
    });
  }
}
