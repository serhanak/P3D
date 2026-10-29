// İçe aktarılmış ağların (mesh) deposu. Ağ verisi büyük olduğundan projeye değil buraya konur:
// geri-al anlık görüntüleri ve otomatik kayıt yalnızca `geom.asset` kimliğini taşır.
// Proje dosyasına kaydederken kullanılan varlıklar `Project.assets` olarak eklenir (io.ts).
import type { MeshAsset } from '../shared/ops';
import type { Project } from './types';

export interface DecodedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

const assets = new Map<string, MeshAsset>();
const decoded = new Map<string, DecodedMesh>();

// ---------------------------------------------------------------------------
// base64 (tarayıcı ve Node'da çalışır)

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const f32ToB64 = (a: Float32Array) => bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const u32ToB64 = (a: Uint32Array) => bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

function b64ToF32(b64: string): Float32Array {
  const bytes = base64ToBytes(b64);
  if (bytes.length % 12) throw new Error('Ağ verisi bozuk (konumlar).');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function b64ToU32(b64: string): Uint32Array {
  const bytes = base64ToBytes(b64);
  if (bytes.length % 12) throw new Error('Ağ verisi bozuk (üçgenler).');
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

// ---------------------------------------------------------------------------

export function newAssetId(): string {
  return 'a_' + Math.random().toString(36).slice(2, 10);
}

export function makeAsset(name: string, positions: Float32Array, indices: Uint32Array, id = newAssetId()): MeshAsset {
  return { id, name, positions: f32ToB64(positions), indices: u32ToB64(indices), triangles: indices.length / 3 };
}

/** Varlığı doğrular ve depoya ekler (aynı kimlik varsa üzerine yazmaz). */
export function registerAsset(raw: unknown): MeshAsset {
  const a = raw as Partial<MeshAsset> | null;
  if (!a || typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(a.id)) throw new Error('Geçersiz ağ kimliği.');
  if (typeof a.positions !== 'string' || typeof a.indices !== 'string') throw new Error('Ağ verisi eksik.');
  const existing = assets.get(a.id);
  if (existing) return existing;
  const positions = b64ToF32(a.positions);
  const indices = b64ToU32(a.indices);
  const nv = positions.length / 3;
  for (let i = 0; i < indices.length; i++) if (indices[i] >= nv) throw new Error('Ağ verisi bozuk (indis aralık dışı).');
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new Error('Ağ verisi bozuk (sayı değil).');
  const asset: MeshAsset = {
    id: a.id,
    name: typeof a.name === 'string' && a.name ? a.name : a.id,
    positions: a.positions,
    indices: a.indices,
    triangles: indices.length / 3,
  };
  assets.set(asset.id, asset);
  decoded.set(asset.id, { positions, indices });
  return asset;
}

export function getAsset(id: string): MeshAsset | undefined {
  return assets.get(id);
}

export function decodedAsset(id: string): DecodedMesh | undefined {
  return decoded.get(id);
}

/** Projede kullanılan varlıklar (dosyaya yazmak için). */
export function usedAssets(project: Project): Record<string, MeshAsset> {
  const out: Record<string, MeshAsset> = {};
  for (const p of project.parts) {
    if (p.geom?.kind === 'mesh') {
      const a = assets.get(p.geom.asset);
      if (a) out[a.id] = a;
    }
  }
  return out;
}
