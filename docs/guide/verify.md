# Doğrulama döngüsü

Kör çizmeyin: anlamlı her adımdan sonra görün ve ölçün. Bir model bittiğinde `check` temiz olmalı.

| Komut | Ne verir | Ne zaman |
|---|---|---|
| `p3d snapshot [--views iso,front,back,left,right,top,bottom] [--size 1000x750] [--out klasör]` | PNG yolları; dosyaları Read ile açıp bakın | Her anlamlı adımdan sonra |
| `p3d measure [--parts a,b]` | Parça başına kutu ve **delikler uygulanmış** hacim; toplam **birleşik** (union) hacim ve PLA tahmini | Ölçü/hacim hedefi varken, orijinalle karşılaştırırken (birleşik hacmi kullanın) |
| `p3d check [--profile print\|game]` | Z-fighting (aynı düzlemde üst üste yüzeyler), boolean hataları, hiçbir şeyi kesmeyen delikler, ince parçalar, tabla teması; hata varsa çıkış kodu 1 | Her bitmiş modelde |
| `p3d section --axis x\|y\|z --at a,b [--parts …] [--file ref.stl] [--tol 0.1]` | Kesit çokgenleri ([y,z] / [x,z] / [x,y]); alan negatifse iç boşluk | Referanstan ölçerken, iç yapıyı kontrol ederken |

- Dik görünümler (front = −Y'den bakış, right = +X'ten) görünür parçaların kutusuna sığdırılır; isim/ölçü yazıları görüntüye
  girmez. `--out` için kendi geçici klasörünüzü (scratchpad) verin.
- Hepsi bağlı sekmenin sahnesinde ya da `--file model.p3d.json` ile dosyada çalışır. `measure`, `check`, `section` aynı
  motorla Node'da hesaplanır; `snapshot --file` WebGL için görünmez Chrome/Edge açar (~8 sn, P3D sunucusu çalışmalı).
- `check` profili: `print` (varsayılan; ince parça ve tabla teması dahil) ya da `game` (üçgen bütçesi `--max-tris`,
  bozuk üçgen; `p3d guide game`).
- Görüntüde bakılacaklar: titreşen yüzeyler, yarıklar, havada duran ya da iç içe giren parçalar, ters yön/eksen, eksik
  delik/çerçeve, beklenmeyen sivri uçlar.
- Kullanıcıya sonucu kısaca özetleyin: ne çizildi, ölçüler, `check` sonucu, açık kalan varsayımlar.
