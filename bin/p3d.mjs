#!/usr/bin/env node
// Global `p3d` komutu (`npm link` ile kurulur): scripts/p3d.ts'yi çağıranın klasöründe çalıştırır;
// TypeScript'i tsx çevirir. Böylece göreli dosya yolları komutun yazıldığı klasöre göre çözülür.
// `p3d` paket adı çözümleme kancasıyla bu deponun src/api.ts'sine gider (`p3d run <betik>` için; bkz. p3d-resolve.mjs).
import { register as registerHooks } from 'node:module';
import { register } from 'tsx/esm/api';

register();
// tsx'ten sonra: son kaydedilen kanca önce çalışır.
registerHooks('./p3d-resolve.mjs', import.meta.url);
globalThis.__p3dResolveHook = true;
await import('../scripts/p3d.ts');
