import { defineConfig, loadEnv } from 'vite';
import { handleApi } from './server/api.ts';

export default defineConfig(({ mode }) => {
  // .env içeriğini sunucu tarafı için process.env'e aktar (istemci paketine girmez).
  const env = loadEnv(mode, process.cwd(), '');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'P3D_MODEL', 'P3D_EFFORT']) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }
  return {
    server: { port: Number(env.PORT) || 5173 },
    build: { chunkSizeWarningLimit: 1000 }, // three.js tek başına ~600 kB
    plugins: [
      {
        name: 'p3d-api',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/api/')) return next();
            handleApi(req, res).catch(next);
          });
        },
      },
    ],
  };
});
