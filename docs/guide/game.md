# Oyun varlıkları (GLB, Unreal, düşük poligon)

P3D baskı parçası modelleyicisidir; oyun için **sınırlı ve bilinçli** bir dışa aktarım sunar: stilize/düşük poligonlu, düz
renkli, sert yüzeyli (hard-surface) varlıklar. **Kapsam dışı:** UV açma, doku, rig/animasyon, LOD zinciri, motora özel
biçimler. Bunlar gerekiyorsa GLB'yi Blender'da sürdürün.

## Modelleme
- Birimler yine mm, Z yukarı, önü −Y. Gerçek ölçüde çizin (araba ≈ 4000 mm). Tabla en fazla 20 000 × 20 000 mm
  (`settings.bedX/bedY`; 2 m üstünde ızgara 100/500 mm); yalnızca görseldir, `check` oyun profilinde tabla kurallarına bakmaz.
- **Düşük poligon:** proje çözünürlüğü (yuvarlak yüzey segmenti) 6–16 arası seçilebilir (arayüz → Ayarlar). `hull` şekli
  düşük çözünürlükte sadeleşmez; poligon bütçesi önemliyse gövdeyi `extrude`/`loft` ile kurun.
- **Simetri:** bir tarafı kurun, `mirror` ile kopyalayın (`p3d guide ops`).
- **Birlikte hareket eden parçalar** (teker = lastik + jant + göbek) bir **grup**tur; grubun `pivot`u dönme merkezidir
  (göbek merkezi). Grup adı move/rotate/duplicate/mirror/delete'te parça yerine kullanılabilir.
- Sıra halindeki aynı parçalar: `duplicate` + `count` + `offset`.

## Dışa aktarım
```bash
p3d export araba.glb [--file model.p3d.json] [--units m|mm] [--normals flat|smooth] [--parts a,b] [--skeleton]
```
- Standart glTF 2.0: **Y yukarı, metre** (varsayılan), önü +Z. Dönüşüm `(x, y, z)_p3d → (x, z, −y) × 0,001`. Unreal'in glTF
  içe aktarıcısı kendi Z-yukarı / cm düzenine çevirir.
- `--normals flat` (varsayılan) düşük poligon görünümü; `smooth` 50° kırılımlı.
- Renk → `baseColorFactor` (sRGB → lineer), metallic 0, roughness 0,9; aynı renk tek malzeme.
- Düğümler: gruplanmamış parça = düğüm (çevirisi parçanın merkezi); grup = düğüm (çevirisi pivot), üyeleri çocuk.
  Delikler uygulanmış haldedir; tamamen boşalan parça atlanır.
- **`--skeleton` (Unreal Chaos Vehicles):** tek bir skinned mesh; kökte `root` eklemi, her grup için pivotunda bir eklem
  (ağırlık 1 — gerçek rig değil). Kemik adları Unreal için ASCII'ye çevrilir (`sol ön teker` → `sol_on_teker`), özgün ad
  `extras.name`'de. Teker kemiklerini araç ayarlarında bu adlarla eşleyin.
- Arayüzde: Dışa aktar → "GLB (oyun motoru)" / "GLB + iskelet (Unreal araç)".

## Kontrol
`p3d check --profile game [--max-tris 20000]`: z-fighting, boolean hatası, boş delik, **toplam üçgen bütçesi** (parça başına
dağılım) ve bozuk (alanı ~0) üçgenler. Tabla teması ve 0,8 mm ince parça kuralları atlanır.

## Doğrulanmayanlar
- Gerçek Unreal içe aktarımı ve glTF Validator henüz denenmedi (yalnızca kendi ayrıştırıcı testlerimiz + three.js GLTFLoader).
- Özel çarpışma ağı (`UCX_` adlandırması) glTF'te doğrulanmadı; MVP için Unreal'in otomatik çarpışması kullanılabilir.
