import type { GroupDef, MeshAsset, PartGeom, Role, ShapeType, SketchPath, Vec3 } from '../shared/ops';

export type { GroupDef, MeshAsset, PartGeom, Role, ShapeType, SketchPath, Vec3 };

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
  /** extrude/revolve/loft/mesh için nokta dizileri; bu şekillerde `position` profil koordinatlarının orijinini taşır. */
  geom?: PartGeom;
  /** Yoksa katı (solid). */
  role?: Role;
  /** Delik parçası için: yalnızca bu parçaları (id) keser. Yoksa kutusu kesişen tüm katıları keser. */
  cuts?: string[];
  /** Üyesi olduğu grubun adı (`Project.groups`); yoksa gruplanmamış. Bir parça yalnızca bir grupta olabilir. */
  group?: string;
  /**
   * Görsel saydamlık (0–1; 0 = tamamen saydam). Yoksa 1 (opak); yalnızca < 1 iken tutulur. Yalnızca görünüm ve malzemedir
   * (GLB alfa, 3MF/MTL): parça yine dışa aktarılır, hacme ve `check`'e girer, delikler onu keser.
   */
  opacity?: number;
  /**
   * Parça başına yuvarlak yüzey çözünürlüğü (segment, 6–192 tamsayı). Yoksa proje ayarı (`settings.resolution`). Yalnızca
   * segment kullanan şekillerde bulunur (shapes.ts → RESOLUTION_SHAPES; `hull` ve `mesh` hariç); etkin değer: `partSeg`.
   */
  resolution?: number;
}

export interface Project {
  format: 'p3d';
  version: 1;
  name: string;
  parts: Part[];
  /** Parça grupları (ad + pivot). Yoksa grup yok; boş dizi tutulmaz. */
  groups?: GroupDef[];
  /**
   * Kullanıcının çizdiği eskiz yolları (niyet verisi: geometri üretmez, dışa aktarılmaz, check'e girmez; bkz. sketch.ts).
   * Yoksa eskiz yok; boş dizi tutulmaz.
   */
  sketch?: SketchPath[];
  /** Yalnızca dosyada: mesh parçalarının ağ verisi. Bellekte src/assets.ts deposunda tutulur (geri-al anlık görüntülerine girmez). */
  assets?: Record<string, MeshAsset>;
  view: {
    showNames: boolean;
    showDimensions: boolean;
    /** Delik parçalarının yarı saydam görüntüsü (kesme her durumda uygulanır). */
    showHoles: boolean;
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
    view: { showNames: true, showDimensions: true, showHoles: true },
    settings: { resolution: 96, bedX: 220, bedY: 220 },
  };
}
