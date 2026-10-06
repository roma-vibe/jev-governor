import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// `npm run ui:dev` serves the app on :5173 and proxies /api to the real
// server (node ui/server.ts, port 4777 unless JEV_UI_PORT says otherwise).
const target = `http://127.0.0.1:${process.env.JEV_UI_PORT ?? 4777}`;

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5173,
    // The app imports shared logic from ../hooks/lib.
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        // The server only accepts mutations whose Origin is its own.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('origin', target));
        },
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
