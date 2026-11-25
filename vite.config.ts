import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? 'dev') },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
});
