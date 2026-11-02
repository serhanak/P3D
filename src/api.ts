// P3D kütüphane yüzeyi — KARARLI YÜZEY; KIRAN DEĞİŞİKLİK YAPMAYIN.
//
// Başka projelerin üretim betikleri P3D'ye yalnızca bu dosya üzerinden erişir: `import { applyOps, THREE } from 'p3d'`
// (package.json → exports; `p3d run <betik>` kurulumsuz çözer). Buradaki ad, imza ve davranışlar sözleşmedir
// (docs/EXTERNAL-USE.md → İlkeler 2): ekleme serbest; ad kaldırmak/değiştirmek ya da anlamını değiştirmek göç ve sözleşme
// testi (tests/api.test.ts) ister. İç modüller (src/*.ts) serbestçe değişir; tüketiciler onları doğrudan içe aktarmaz.
//
// Birim mm, Z yukarı; `Part.position` geometrik merkez. Boolean (delik), birleşim ve kesit için önce `await initCsg()`
// (loadProjectFile ve exportFile kendileri hazırlar). Node yardımcıları (loadProjectFile, saveProjectFile, exportFile)
// yalnızca Node'da çalışır.

export * as THREE from 'three';

// Proje ve işlemler
export { newProject } from './types';
export type { GroupDef, MeshAsset, Part, PartGeom, Project, Role, ShapeType, Vec3 } from './types';
export { SHAPES } from '../shared/ops';
export type { Axis, LoftGeom, LoftSection, MeshGeom, Op, OpName, ParamChange, Pt2, SceneSummary, SceneSummaryPart, Side } from '../shared/ops';
export { applyOps, partBox, partMatrix, partsBox, sceneSummary } from './engine';
export type { ApplyResult } from './engine';

// Proje dosyası (metin)
export { mergedMesh, parseProject, projectToJson, worldMesh } from './io';

// Geometri, boolean, kesit
export { initCsg, manifoldVolume, sliceMany, subtract } from './csg';
export type { Cutter } from './csg';
export { baseIndexed, exportGeometry, exportableParts, roleOf, solidVolume } from './model';

// Ağlar
export { decodedAsset, getAsset, registerAsset, usedAssets } from './assets';
export type { DecodedMesh } from './assets';
export { build3mf, buildStl, meshAssetFromSoup, parseMeshFile } from './meshio';
export type { ImportedMesh, WorldMesh } from './meshio';

// Denetim ve oyun dışa aktarımı
export { checkProject } from './check';
export type { CheckIssue, CheckOptions } from './check';
export { buildGlb } from './gltf';
export type { GlbOptions } from './gltf';

// Node dosya yardımcıları
export { exportFile, loadProjectFile, readMeshFile, saveProjectFile } from './files';
export type { ExportFormat, ExportOptions, ExportResult, LoadOptions, SaveOptions, SaveResult } from './files';
