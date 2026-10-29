# Örnek projeler

Uygulamada üst çubuktaki **Aç…** ile açılır. Açtıktan sonra isim ve ölçü etiketlerini üst
çubuktaki **İsimler** / **Ölçüler** anahtarlarıyla açabilirsiniz (kalabalık olmasın diye kapalı kaydedildi).

| Dosya | İçerik |
|---|---|
| [`3dbenchy.p3d.json`](3dbenchy.p3d.json) | 3DBenchy römorkörünün temel şekillerle yaklaşık modeli — 31 parça, 60 × 31 × 48 mm |

## 3DBenchy

[3DBenchy](https://www.3dbenchy.com/), Creative Tools'un (Daniel Norée) 3D yazıcı kalibrasyon modelidir;
Şubat 2025'ten beri **kamu malıdır (CC0)**. Bu dosya orijinal ağdan türetilmedi; P3D'nin temel şekilleriyle
(kutu, silindir, boru) yeniden kurulmuş bir yaklaşımdır.

Resmi ölçülere uyanlar: genel boyut 60 × 31 × 48 mm, baca Ø7 ve 11 mm derin Ø3 ağız, çatı 23 mm / 5.5°,
ön cam 10.5 × 9.5 mm, arka pencere Ø9 / Ø12, kargo kasası dış 12 × 10.81 / iç 8 × 7 mm (üstü tabandan
15.5 mm), loça Ø4. Gövde ve kabin ölçüleri bu değerlere uyacak şekilde tahmin edildi.

Yaklaşımlar (P3D'de boolean/CSG ve serbest yüzey yok):
- Tekne 3 mm'lik katmanlardan oluşur (kutu + yarım daire burun); 40° pruva eğimi basamaklıdır.
- Camlar, kasa boşluğu ve isim plakası yüzeye yapışık ince koyu plakalardır; kabin içi dolu.
- Pruva üstü (`tekne4_baş`, `tekne5_baş`) silindirinin arka yarısı kabinin içinde kalır.

Parça adları: `tekne1…5` (+ `_baş`), `küpeşte_sancak/iskele`, `ayna`, `kabin`, `çatı`, `baca`, `baca_ağzı`,
`ön_cam`, `yan_cam_*`, `arka_pencere`, `arka_cam`, `kasa_*`, `loça_*`, `olta_tutucu`, `isim_plakası`.
Pruva +X, kıç −X; sancak (sağ) −Y, iskele (sol) +Y.
