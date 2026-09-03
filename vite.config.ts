import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Serve the training matrix in `npm run dev` only.
 *
 * The file is untracked and lives outside `public/`, so it is never copied into
 * `dist/` and never reaches the public bucket or the public repo. This middleware
 * exists so the flagged Training panel has real data locally; in a deployed build
 * the endpoint simply does not exist and the panel says the data is unavailable.
 *
 * Do not "simplify" this by moving the CSV into `public/`. That would publish
 * named process owners, internal document links and candid notes about business
 * gaps to anyone with the dashboard URL — and a feature flag would not stop it.
 */
function trainingMatrixDevOnly(): Plugin {
  return {
    name: 'training-matrix-dev-only',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__training-matrix.csv', (_req, res) => {
        try {
          const csv = readFileSync('data/training-sop-matrix.csv', 'utf8');
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.end(csv);
        } catch {
          res.statusCode = 404;
          res.end('');
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), trainingMatrixDevOnly()],
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
