// @twenty4/api-client — typed fetch client for mobile (and later admin).
// Depends only on @twenty4/contracts. M0 ships a placeholder; the real typed
// client lands alongside the API surface (M1+).

export interface ApiClientOptions {
  /**
   * Base URL of the API. MUST be the machine's LAN/Tailscale IP on a real
   * device (e.g. http://100.98.100.117:3000), never 127.0.0.1. See RUNNING.md.
   */
  baseUrl: string;
}

export function createApiClient(options: ApiClientOptions) {
  return {
    async health(): Promise<{ status: string }> {
      const res = await fetch(`${options.baseUrl}/health`);
      return (await res.json()) as { status: string };
    },
  };
}
