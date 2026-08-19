import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Reports and the SPA share a bucket; hashed asset names make the
    // long-cache/short-cache split in infra/deploy.sh safe.
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Local dev against a real bucket: `VITE_S3_ORIGIN=https://bucket.s3.us-west-2.amazonaws.com npm run dev`
      // keeps listing calls same-origin, exactly as CloudFront does in production.
      ...(process.env.VITE_S3_ORIGIN
        ? {
            '^/(runs|\\?list-type)': {
              target: process.env.VITE_S3_ORIGIN,
              changeOrigin: true,
            },
          }
        : {}),
    },
  },
});
