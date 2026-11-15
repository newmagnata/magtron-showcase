import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3333',
      '/socket.io': { target: 'http://127.0.0.1:3333', ws: true },
    },
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, env: { ALLOW_REGISTRATION: 'true', ALLOW_PRIVATE_URLS: 'true', RATE_LIMIT_MAX: '100000' } },
} as any);
