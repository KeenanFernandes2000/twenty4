import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// twenty4 admin console — minimal Vite + React moderation/ops shell.
// Consumes the real API at VITE_API_URL (default http://127.0.0.1:4000).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: '127.0.0.1',
  },
  preview: {
    port: 5174,
    host: '127.0.0.1',
  },
});
