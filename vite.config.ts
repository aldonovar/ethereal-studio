import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// path: vite.config.ts
export default defineConfig(({ mode }) => {
  return {
    base: './', // Critical for relative path loading in Electron/Tauri
    server: {
      port: 3000,
      strictPort: true, // Fail if port is busy
      host: '0.0.0.0',
    },
    build: {
      target: 'esnext', // Optimize for modern webviews
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: mode === 'development',
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        '@hollowbits/core': path.resolve(__dirname, 'hollowbits-core/index.ts'),
      }
    }
  };
});
