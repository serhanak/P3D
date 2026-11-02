// Node çözümleme kancası (`module.register`): `p3d` paket adını bu deponun kararlı yüzeyine (src/api.ts) çözer.
// Böylece `p3d run <betik>` ile çalışan tüketici betikleri, kendi repolarında npm link ya da tsx kurulumu olmadan
// `import { applyOps, THREE } from 'p3d'` yazabilir. Kanca tsx'ten sonra kaydedilir (son kaydedilen önce çalışır) ve
// yalnızca belirteci dosya adresine çevirip zincire devreder: biçimi (TypeScript → module) tsx'in çözümleyicisi belirler,
// yüklemeyi tsx çevirir. Diğer belirteçler zincirde aynen devam eder.
const TARGETS = {
  p3d: new URL('../src/api.ts', import.meta.url).href,
  'p3d/package.json': new URL('../package.json', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(Object.hasOwn(TARGETS, specifier) ? TARGETS[specifier] : specifier, context);
}
