import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // .env içeriğini sunucu tarafı için process.env'e aktar (istemci paketine girmez).
  const env = loadEnv(mode, process.cwd(), '');
  // Açılış parametreleri (scripts/launch.ts) önceden ayarladıysa onlar geçerlidir.
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'P3D_MODEL', 'P3D_EFFORT', 'P3D_LLM', 'P3D_BRIDGE', 'P3D_CLAUDE_BIN'];
  for (const key of keys) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }
  return {
    server: { port: Number(process.env.PORT || env.PORT) || 5173 },
    build: { chunkSizeWarningLimit: 1000 }, // three.js tek başına ~600 kB
    plugins: [
      {
        name: 'p3d-api',
        configureServer(server) {
          // API modülü istek anında yüklenir (ssrLoadModule): server/ ya da shared/ değişince geliştirme sunucusu
          // yeniden başlamaz (yeniden başlama sırasında yenilenen sekme bağlantısız kalıyordu), modül tazelenir.
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/api/')) return next();
            server
              .ssrLoadModule('/server/api.ts')
              .then((m) => (m as typeof import('./server/api.ts')).handleApi(req, res))
              .catch(next);
          });
        },
      },
    ],
  };
});
