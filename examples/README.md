# Örnek projeler

Uygulamada üst çubuktaki **Aç…** ile açılır. İsim, ölçü ve delik görüntüleri kalabalık olmasın diye kapalı
kaydedildi; üst çubuktaki **İsimler** / **Ölçüler** / **Delikler** anahtarlarıyla açabilirsiniz.

| Dosya | İçerik |
|---|---|
| [`3dbenchy.p3d.json`](3dbenchy.p3d.json) | 3DBenchy römorkörü — 27 parça (14 katı + 13 delik), 60 × 31 × 48 mm, birleşik hacim 15,25 cm³; tamamen uygulamanın kendi şekilleriyle (mesh ve loft yok), 150 kB |

## 3DBenchy

[3DBenchy](https://www.3dbenchy.com/), Creative Tools'un (Daniel Norée) 3D yazıcı kalibrasyon modelidir;
Şubat 2025'ten beri **kamu malıdır (CC0)**. Bu dosya orijinal ağın kopyası değildir: P3D parçalarıyla yeniden
kurulmuş, ölçüleri orijinalden alınmış bir modeldir.

**Nasıl çizildi (yapay zekâ doğrulama döngüsü):**
1. Orijinal STL ([CreativeTools/3DBenchy](https://github.com/CreativeTools/3DBenchy), `Single-part/3DBenchy.stl`)
   `npm run -s p3d -- import … --role reference --keep-position` ile sahneye yarı saydam referans olarak alındı.
   Çerçeve ve loça ölçüleri aynı deponun `Multi-part/` dosyalarından (kapı çerçevesi, pencere, loça) alındı.
2. `npm run -s p3d -- section --file … --axis x|y|z --at …` ile istasyon, su hattı ve boyuna kesitler ölçüldü
   (endaze: yarı genişlikler, küpeşte, güverte, omurga). Loça bandı ölçümde maskelendi.
3. **Tekne = uygulamanın `hull` (endaze) şekli:** 0,5 mm aralıklı 120 istasyonda yarı genişlik, omurga→küpeşte
   arasında 31 eşit yükseklikte ölçüldü (x boyunca hafif süzüldü) ve tablo olarak projeye yazıldı:
   `{x, keel, sheer, breadth: [31 sayı]}`. Yüzeyi uygulama üretir: tablo örtük yüzeye çevrilir (manifold-3d `levelSet`),
   yan profilin (omurga + küpeşte çizgisi) ekstrüzyonuyla kesiştirilir — küpeşte, düz taban, ayna keskin; başta V
   biçimli bodoslama örtük yüzeyin kendisi. **Güverte kuyusu** ikinci bir `hull` (omurgası güverte, `role: hole`,
   `cuts: ["tekne"]`); güverte köşesi de keskin. Tablo düzenlenirse tekne yeniden üretilir.
4. Kabin yamuk planlı `extrude`; kapılar (kutu + yatay silindir), ön cam, arka pencere ve iç boşluk yalnızca kabini
   keser. Kabin zemini teknenin yüzeyidir (tekneyi kabin duvarları içinde biten ayrı bir delik oyar).
   Kapı pervazları `frame: 1.4, open: true`, ön cam çerçevesi `frame: 1.4`; loça delikleri (Ø4,6) ve boruları
   (Ø5,8/Ø4, dışa 0,4 mm taşan çerçeve) `place_on_surface` ile tekne yüzeyine dik. Çatı yan profil ekstrüzyonu (5,5°) + öne genişleme için iki yan kesim, baca `revolve` (11 mm derin ağız).
   **Modelde loft kullanılmadı.**
5. Tüm adımlar üreteçte: [`tools/build-3dbenchy.ts`](tools/build-3dbenchy.ts) — referans STL'yi ölçer, işlem listesini
   kurar, uygulamanın motoruyla projeyi oluşturur, `check` ve birleşik hacmi yazdırır, bu dosyayı yeniden üretir.
6. `snapshot` ile görüntüler, `measure` ile hacim, `check` ile çakışan yüzey (z-fighting) denetimi:
   **sorun yok**; birleşik hacim 15,25 cm³ (orijinal 15,55; −%1,9).


**Resmi ölçülerle uyum:** genel 60 × 31 × 48 mm, baca Ø7 başlık + 11 mm derin Ø3 ağız, çatı 23 mm / 5,5°,
ön cam 10,5 × 9,5, arka pencere Ø9 / Ø12 çerçeve, kasa dış 10,81 × 12 / iç 7 × 8 (üstü 15,5), loça Ø4.

**Basitleştirmeler:** kabin duvarları dik (orijinalde hafif içe eğik), alt yüzdeki "CT 3DBenchy" yazısı ve kıç
isim plakası yok, dümen basit bir torus.

Pruva +X, kıç −X; sancak (sağ) −Y, iskele (sol) +Y. Delik parçaları dosyada görünür (kesmeleri için) ama
`showHoles: false` ile görüntüleri kapalıdır.
