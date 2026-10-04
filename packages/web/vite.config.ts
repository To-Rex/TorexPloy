import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the dashboard runs on Vite and proxies the API (including SSE and terminal WebSockets) to the control plane.
const api = process.env.PLOY_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: api, changeOrigin: false, ws: true } },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler') || id.includes('react-router')) return 'react';
          if (id.includes('@tanstack')) return 'query';
          return undefined;
        },
      },
    },
  },
});
