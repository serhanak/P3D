# Betikle üretim (`p3d run`, `import from 'p3d'`)

Parametrik ya da tekrarlı modeller (muhafaza aileleri, pist parçaları, toplu varlıklar) için işlemleri bir betikle üretin;
betik projenizin reposunda durur, P3D'yi **yalnızca `p3d` paket adıyla** kullanır.

```ts
// uret.mts — çalıştırma: p3d run uret.mts 120
import { applyOps, checkProject, initCsg, newProject, THREE } from 'p3d';
import { saveProjectFile, exportFile } from 'p3d';

const width = Number(process.argv[2] ?? 100);
await initCsg();
const p = newProject('kutu');
const r = applyOps(p, [
  { op: 'create', shape: 'box', name: 'govde', params: [{ name: 'width', value: width }, { name: 'depth', value: 60 }, { name: 'height', value: 30 }], position: { x: 0, y: 0, z: 15 } },
], null);
if (r.errors.length) throw new Error(r.errors.join('\n'));
const issues = checkProject(p);
saveProjectFile(p, 'kutu.p3d.json');
await exportFile(p, 'kutu.stl');
console.log(new THREE.Vector3(width, 60, 30).length(), issues);
```

- `p3d run` betiği komutun yazıldığı klasörde çalıştırır; `process.argv.slice(2)` betiğin argümanlarıdır. Kurulum gerekmez:
  `p3d` adı P3D'nin kararlı yüzeyine (`src/api.ts`) çözülür; `THREE` de oradan gelir (ayrı three kurmayın).
- Editörde tip desteği isterseniz proje klasörünüzde `npm link p3d` (isteğe bağlı).
- **Kararlı yüzey** (`src/api.ts`): `newProject`, `applyOps`, `parseProject`, `projectToJson`, `checkProject`, `initCsg`,
  `subtract`, `manifoldVolume`, `partBox`, `partMatrix`, `partsBox`, `mergedMesh`, `worldMesh`, `sliceMany`, `exportGeometry`,
  `exportableParts`, `baseIndexed`, `roleOf`, `solidVolume`, `parseMeshFile`, `meshAssetFromSoup`, `registerAsset`,
  `decodedAsset`, `getAsset`, `usedAssets`, `buildStl`, `build3mf`, `buildGlb`, `sceneSummary`, `SHAPES`, `THREE`;
  Node yardımcıları `loadProjectFile`, `saveProjectFile`, `exportFile`, `readMeshFile`; tipler `Project`, `Part`, `Op` …
  P3D'nin iç modüllerini (`…/P3D/src/*.ts`) doğrudan içe aktarmayın — iç yapı değişebilir, bu yüzey değişmez.
- `initCsg()` delik/boolean ve sadeleştirmeden önce beklenmelidir (`loadProjectFile`/`exportFile` kendileri bekler).
- Betik çıktısını sekmede görmek için: `p3d open --ws <alan> kutu.p3d.json` ya da tarayıcısız `p3d snapshot --file kutu.p3d.json`.
- Tek seferlik işlem listeleri için betik yerine `p3d apply --file model.p3d.json --ops ops.json` yeterlidir.
