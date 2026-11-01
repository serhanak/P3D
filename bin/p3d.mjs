#!/usr/bin/env node
// Global `p3d` komutu (`npm link` ile kurulur): scripts/p3d.ts'yi çağıranın klasöründe çalıştırır;
// TypeScript'i tsx çevirir. Böylece göreli dosya yolları komutun yazıldığı klasöre göre çözülür.
import { register } from 'tsx/esm/api';

register();
await import('../scripts/p3d.ts');
