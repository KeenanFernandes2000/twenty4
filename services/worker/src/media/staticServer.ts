/**
 * Tiny static file server for render-time media.
 *
 * WHY: headless Chrome refuses `file://` URLs ("Not allowed to load local
 * resource"), so the renderer cannot point `<Img>`/`<OffthreadVideo>` at local
 * paths directly. The job layer downloads S3 media to a temp dir; this server
 * exposes that dir over `http://127.0.0.1:<port>/...` so the composition can load
 * it. (In production the same pattern serves the per-job temp dir; for true S3
 * one could alternatively pass presigned GET URLs in the srcMap.)
 *
 * Range requests are supported so `<OffthreadVideo>` can seek.
 */
import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { extname, join, normalize } from 'node:path';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
};

export interface MediaServer {
  /** Base URL, e.g. `http://127.0.0.1:54213`. */
  baseUrl: string;
  /** Map a filename (relative to rootDir) to its served URL. */
  url(relPath: string): string;
  /** Shut the server down. */
  close(): Promise<void>;
}

/** Start a static server rooted at `rootDir`. Resolves once it is listening. */
export function startMediaServer(rootDir: string): Promise<MediaServer> {
  const root = path.resolve(rootDir);

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
        // Prevent path traversal: resolved path must stay under root.
        const resolved = normalize(join(root, urlPath));
        if (!resolved.startsWith(root)) {
          res.writeHead(403).end('forbidden');
          return;
        }
        const st = await stat(resolved).catch(() => null);
        if (!st || !st.isFile()) {
          res.writeHead(404).end('not found');
          return;
        }
        const type = MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream';
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m && m[1] ? parseInt(m[1], 10) : 0;
          const end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Range': `bytes ${start}-${end}/${st.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
          });
          createReadStream(resolved, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': st.size,
            'Accept-Ranges': 'bytes',
          });
          createReadStream(resolved).pipe(res);
        }
      } catch {
        res.writeHead(500).end('error');
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('media server failed to bind'));
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        url: (relPath: string) =>
          `${baseUrl}/${relPath.split(path.sep).map(encodeURIComponent).join('/')}`,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
