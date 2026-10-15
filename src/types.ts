import type { ShapeType, Vec3 } from '../shared/ops';

export type { ShapeType, Vec3 };

export interface Part {
  id: string;
  name: string;
  shape: ShapeType;
  /** Şekle özgü ölçüler (mm; prizmada `sides` adet). */
  params: Record<string, number>;
  /** Parçanın geometrik merkezinin dünya konumu (mm). Z yukarı, tabla z=0. */
  position: Vec3;
  /** Merkez etrafında XYZ Euler açıları (derece). */
  rotation: Vec3;
  color: string;
  visible: boolean;
}

export interface Project {
  format: 'p3d';
  version: 1;
  name: string;
  parts: Part[];
  view: {
    showNames: boolean;
    showDimensions: boolean;
  };
  settings: {
    /** Yuvarlak yüzeylerdeki segment sayısı (ekran + dışa aktarım). */
    resolution: number;
    bedX: number;
    bedY: number;
  };
}

export function newProject(name = 'Yeni proje'): Project {
  return {
    format: 'p3d',
    version: 1,
    name,
    parts: [],
    view: { showNames: true, showDimensions: true },
    settings: { resolution: 96, bedX: 220, bedY: 220 },
  };
}
