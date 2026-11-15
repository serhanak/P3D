# Oyun varlıkları (GLB, Unreal, düşük poligon)

P3D baskı parçası modelleyicisidir; oyun için **sınırlı ve bilinçli** bir dışa aktarım sunar: stilize/düşük poligonlu, düz
renkli, sert yüzeyli (hard-surface) varlıklar. **Kapsam dışı:** UV açma, doku, rig/animasyon, LOD zinciri, motora özel
biçimler. Bunlar gerekiyorsa GLB'yi Blender'da sürdürün.

## Modelleme
- Birimler yine mm, Z yukarı, önü −Y. Gerçek ölçüde çizin (araba ≈ 4000 mm). Tabla en fazla 20 000 × 20 000 mm
  (`settings.bedX/bedY`; 2 m üstünde ızgara 100/500 mm); yalnızca görseldir, `check` oyun profilinde tabla kurallarına bakmaz.
- **Düşük poligon:** proje çözünürlüğü (yuvarlak yüzey segmenti) 6–16 arası seçilebilir (arayüz → Ayarlar). Parça başına
  `resolution` (6–192) proje ayarını o parçada geçersiz kılar: ör. proje 8, teker `resolution: 16`; ya da eklem/eldiven
  küreleri `resolution: 6` (küre 6 segmentte 36, 8'de 48 üçgen). Silindir, boru, koni, küre, torus, döndürme, yumuşak
  loft ve yaylı ya da yuvarlak kesitli süpürmede geçerlidir; diğer şekillerde uyarıyla yok sayılır (`p3d guide modeling` →
  "Parça çözünürlüğü"). `hull` çözünürlükle sadeleşmez; gövdeye `geom.maxTris`
  ile üçgen bütçesi verin (ör. `{"kind": "hull", "stations": […], "maxTris": 1500}`): ağ bütçeyi aşmaz, keskin
  küpeşte/ayna kalır, bozuk üçgen bırakmaz.
- **Borular ve bükülen profiller** (tampon, korkuluk, kafes): parça parça prizma yerine tek `sweep` (`p3d guide modeling` →
  "Süpürme"): tek kapalı ağ, iç kapak ve bindirme yok, z-fighting yok. **Süpürme üçgen sayısı:** kesitte N nokta (yuvarlak
  kesitte N = s, içi boşsa 2s; H boşluk), s etkin çözünürlük. Halka sayısı m = 2 (uçlar) + gönye köşesi başına 1 + yay başına
  (k + 1), k = ⌈s · dönüş / 360°⌉ (arada düz parça kalmayan iki yay ya da yolun ucuna dayanan yay bir halkayı paylaşır:
  her biri için 1 eksik). Üçgen: açık yolda `2·N·(m − 1) + 2·(N − 2 + 2H)`,
  kapalı yolda `2·N·m`. Örnek: Ø28 U tampon, iki 90° köşe, s = 10 → k = 3, m = 10 → 196 üçgen; s = 16 → 380.
- **Saydam parçalar** (cam, vizör, far camı): `opacity` = opaklık (0–1; saydamlık = 1 − opaklık; ör. füme cam koyu renk + 0,4).
  GLB'ye malzeme alfası olarak gider; parça yine katı ağdır.
- **Düz ayrıntılar** (plaka, far, harf, şerit, dama karesi): kutu yerine **kaplama** `decal` (`p3d guide modeling` → "Kaplama"):
  kalınlıksız, yüzü yerel +Z'ye bakan, yüzeyden `lift` (0,5 mm) ayrık çokgen; dikdörtgen 2 üçgen (kutu 12). `place_on_surface`
  ile oturtun; iki yüzü görünen ince levhada `double: true` (GLB malzemesi `doubleSided`, üçgen çoğaltılmaz). Damalı bayrak
  (4 × 1,2 m, iki yüzde 16'şar kare): 16 kutu × 12 = 192 yerine 12 + 32 × 2 = 76 üçgen.
- **Birbirine değen / gömülü parçalar** (lastik yığını, gövdeye gömülü pim): değen kapaklar ve gömülü yüzler hiç görünmez;
  `export --cull-hidden` atar, `check --profile game --cull-hidden` bütçeyi ona göre sayar (aşağıda).
- **Simetri:** bir tarafı kurun, `mirror` ile kopyalayın (`p3d guide ops`).
- **Birlikte hareket eden parçalar** (teker = lastik + jant + göbek) bir **grup**tur; grubun `pivot`u dönme merkezidir
  (göbek merkezi). Grup adı move/rotate/duplicate/mirror/delete'te parça yerine kullanılabilir.
- Sıra halindeki aynı parçalar: `duplicate` + `count` + `offset`.

## Dışa aktarım
```bash
p3d export araba.glb [--file model.p3d.json] [--units m|mm] [--normals flat|smooth] [--parts a,b] [--skeleton] [--cull-hidden]
```
- Standart glTF 2.0: **Y yukarı, metre** (varsayılan), önü +Z. Dönüşüm `(x, y, z)_p3d → (x, z, −y) × 0,001`. Unreal'in glTF
  içe aktarıcısı kendi Z-yukarı / cm düzenine çevirir.
- `--normals flat` (varsayılan) düşük poligon görünümü; `smooth` 50° kırılımlı.
- Renk → `baseColorFactor` (sRGB → lineer), metallic 0, roughness 0,9; aynı renk ve saydamlık tek malzeme. Saydam parça
  (`opacity` < 1): alfa = `baseColorFactor[3]` (= opacity) ve `alphaMode: "BLEND"`, malzeme adı `P3D_rrggbb_aNN`
  (NN = opacity × 100); opak malzemelerde `alphaMode` yazılmaz (glTF varsayılanı OPAQUE). İskelet modunda primitifler de
  malzemeye (renk + saydamlık) göre ayrışır.
- Düğümler: gruplanmamış parça = düğüm (çevirisi parçanın merkezi); grup = düğüm (çevirisi pivot), üyeleri çocuk.
  Delikler uygulanmış haldedir; tamamen boşalan parça atlanır.
- **`--cull-hidden`** (betikte `exportFile(…, { cullHidden: true })` / `buildGlb`): hiç görünmeyen üçgenler atılır. Kural (kesin):
  üçgen kenarlarından biraz içeri küçültülüp normali boyunca biraz dışarı itildiğinde (ε = en az 0,001 mm, büyük sahnede ölçeğin
  milyonda biri) **tamamen** başka bir dışa aktarılan, kapalı ve opak katının içinde kalıyorsa (bir noktası içeride ve o katının
  hiçbir üçgeni onu kesmiyor). Böylece üst üste duran parçaların değen kapakları ve gömülü kısımlar gider (4 yığılı 8 kenarlı
  prizma: 112 → 76 üçgen). Kalanlar: kısmen örtülen üçgen (bölme yok; ör. küçük bir delikten görünen kapak altı), iki ayrı parçanın
  birlikte örttüğü üçgen, aynı yerde duran eş parçalar (z-fighting). **Saydam parça örtmez** (görünen opaklığı < 1: cam kabindeki
  koltuk kalır); kendisi opak parçalarca ayıklanabilir. Düğümler, gruplar, pivot ve iskelet aynı kalır; tüm üçgenleri gizli parçanın
  düğümü ağsız yazılır. Kaplamalar ne atılır ne atar. Ayıklanan ağ kapalı değildir: STL/3MF/OBJ'de seçenek hata verir. Çıktı
  satırı atılan, eklenen ve kalan üçgen sayısını söyler.
  - **Birleşim çizgileri su geçirmez kalır:** iki parçanın aynı düzlemdeki yüzleri bir çizgide birleşip kenar uçları eşleşmiyorsa
    (bir parçanın köşesi öbürünün kenarının ortasına düşüyorsa: ör. farklı kalınlıkta üst üste iki kutunun uç yüzleri), atılan yüz
    bu kıl payı açıklığın arkasını kapatıyordu. T-kavşağı onarımı o kenarı kullanan üçgenleri o köşede böler; birkaç üçgen eklenebilir
    (4 prizma: 36 atılır / 0 eklenir; Benchy: 3.629 / 5). Yalnızca çatlak yapan T noktaları bölünür: köşesi bir yüzün köşegenine düşen
    kutu gibi durumlar bölünmez (o yüz zaten su geçirmezdir). **Ayıklama üçgen sayısını hiçbir zaman artırmaz:** bir parçanın atılan
    üçgenlerinin doğurduğu bölmeler atılanlara eşit ya da fazlaysa o parçanın atılanları geri konur (ör. farklı kalınlıkta üst üste iki
    kutu: 2 atılırdı, 8 eklenirdi → hiçbir şey atılmaz, çıktı seçeneksizle aynı). `check --cull-hidden` aynı kuralla sayar. Bölünen
    siluet kenarlarında piksel kapsaması yuvarlamadan ötürü tek tük bir piksel kayabilir (çatlak değil).
  - **Tüketici köşe konumlarını nicemlememeli ya da parçaları ayrı ayrı sıkıştırmamalı:** birleşim çizgisindeki köşeler ayrı
    düğümlerde aynı konumdadır; ayrı ayrı nicemlenince ayrışır ve çatlar. Godot'nun GLB yükleyicisi varsayılan olarak köşe
    konumlarını 16 bit'e nicemler: `GLTFDocument.append_from_file(yol, durum, 64)` (bayrak 64 = sıkıştırmayı kapat) ile yükleyin.
- Kaplama (`decal`) parça gibi yazılır; iki yüzlüsünün malzemesi `doubleSided: true`, adı `P3D_rrggbb[_aNN]_ds` (malzemeler renk,
  saydamlık ve iki yüzlülüğe göre ayrışır). OBJ/MTL'de iki yüzlülük yoktur: iki yüzlü kaplama için GLB kullanın.
- **`--skeleton` (Unreal Chaos Vehicles):** tek bir skinned mesh; kökte `root` eklemi, her grup için pivotunda bir eklem
  (ağırlık 1 — gerçek rig değil). Kemik adları Unreal için ASCII'ye çevrilir (`sol ön teker` → `sol_on_teker`), özgün ad
  `extras.name`'de. Teker kemiklerini araç ayarlarında bu adlarla eşleyin.
- Arayüzde: Dışa aktar → "GLB (oyun motoru)" / "GLB + iskelet (Unreal araç)".

## Kontrol
`p3d check --profile game [--max-tris 20000] [--cull-hidden]`: z-fighting, boolean hatası, boş delik, **toplam üçgen bütçesi**
(parça başına dağılım; bütçenin ≥ %5'ini tutan yuvarlak parçalar etkin segmentleriyle listelenip parça başına `resolution`
önerilir) ve bozuk (alanı ~0) üçgenler. Tabla teması ve 0,8 mm ince parça kuralları atlanır. Gizli üçgenler ayrıca
bildirilmez (yığılı model de "check temiz" olabilir). `--cull-hidden` (betikte `checkProject(p, { profile: 'game', cullHidden:
true })`) bütçeyi `export --cull-hidden` çıktısındaki sayıyla hesaplar; verilmezse ve bütçe aşılırsa uyarı "N üçgen görünmez;
`export --cull-hidden` ile atılır" der.

## Doğrulanmayanlar
- Gerçek Unreal içe aktarımı ve glTF Validator henüz denenmedi (yalnızca kendi ayrıştırıcı testlerimiz + three.js GLTFLoader).
- Özel çarpışma ağı (`UCX_` adlandırması) glTF'te doğrulanmadı; MVP için Unreal'in otomatik çarpışması kullanılabilir.
