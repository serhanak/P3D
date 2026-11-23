# Doğrulama döngüsü

Kör çizmeyin: anlamlı her adımdan sonra görün ve ölçün. Bir model bittiğinde `check` temiz olmalı.

| Komut | Ne verir | Ne zaman |
|---|---|---|
| `p3d snapshot [--views iso,front,back,left,right,top,bottom] [--size 1000x750] [--style shaded\|wire\|xray] [--projection perspective\|ortho] [--out klasör]` | PNG yolları; dosyaları Read ile açıp bakın. Kenar 200–4096 piksel (aşan boyut orantılı küçültülür, uyarılır) | Her anlamlı adımdan sonra |
| `p3d measure [--parts a,b]` | Parça başına **delikler uygulanmış** kutu ve hacim; toplam **birleşik** (union) hacim ve PLA tahmini | Ölçü/hacim hedefi varken, orijinalle karşılaştırırken (birleşik hacmi kullanın) |
| `p3d check [--profile print\|game]` | Z-fighting (aynı düzlemde üst üste yüzeyler; ileti gerçek örtüşme alanını yazar, ince şeritte "kıl payı" der: değmesi gereken iki parçanın ortak noktaları birebir aynı değil — yuvarlama, teğet kırığı; ortak noktaları aynı değerlerle verin), boolean hataları, hiçbir şeyi kesmeyen delikler, ince parçalar, tabla teması; game: üçgen bütçesi, bozuk üçgen, görünmeyen (başka katının içinde kalan) üçgen sayısı (`export --cull-hidden` atar); hata varsa çıkış kodu 1 | Her bitmiş modelde |
| `p3d section --axis x\|y\|z --at a,b [--parts …] [--file ref.stl] [--tol 0.1]` | Kesit çokgenleri ([y,z] / [x,z] / [x,y]); alan negatifse iç boşluk | Referanstan ölçerken, iç yapıyı kontrol ederken |

- Dik görünümler (front = −Y'den bakış, right = +X'ten) görünür parçaların kutusuna sığdırılır; isim/ölçü yazıları görüntüye
  girmez. Yan görünüm `left` (−X'ten) ya da `right`'tır; `side` adında görünüm yoktur. `--out` için kendi geçici klasörünüzü
  (scratchpad) verin.
- **Perspektif (oran ve okunaklılık):** `--views eye` göz hizasıdır: görünür kutunun tabanından `--eye-height` (varsayılan 1000 mm;
  küçük sahnede kutu yarıçapının iki katıyla sınırlı) yukarıda, izometrikle aynı yandan (ön sağ), kutunun tamamı sığacak uzaklıktan kutu merkezine bakar. `--eye x,y,z` serbest
  kameradır (`camera.png`): `--target` (yoksa kutu merkezi) ve `--fov` (dikey derece, 10–120, varsayılan 50). Oyun nesnelerini
  oyuncunun gözünden görmek için: ör. kart `--eye-height 700`, yaya `--eye-height 1700`; nesneye 5–10 m uzaktan
  `--eye 0,-8000,1000 --target 0,0,800`. `--eye` / `--eye-height` verilip `--views` verilmezse yalnızca o görüntü çekilir.
- **Tel kafes (`--style wire`) ve X-ışını (`--style xray`):** gölgeli görüntü kırılım çizgilerini gösterir, üçgenleri göstermez.
  Üçgen topolojisine bakmak gerektiğinde tel kafes alın: düşük poligonlu oyun varlığı (yuvarlakların segment sayısı, `maxTris`
  bütçesiyle sadeleşmiş gövde, iğne üçgen, delik kesiminin bıraktığı uzun üçgen yelpazeleri), `export --cull-hidden` ile ayıklanmış
  GLB (atılan iç yüzler, birleşim çizgisi bölmeleri). Tel kafeste dolgu ve ışık aynıdır, arkadaki kenarlar gizlidir; X-ışınında dolgu
  soluktur, arkadakiler dahil tüm kenarlar parça renginde çizilir (iç içe parçalar, gizli yüzler). Varsayılan `shaded`; sekmedeki
  biçimden bağımsızdır. Bir GLB'yi içe aktarmadan görmek için: `p3d snapshot --file araba.glb --style wire` (ayrıca
  `scene/measure/check --file araba.glb`).
- **İzdüşüm (`--projection`):** varsayılan `perspective`: `iso` perspektif (30°), dik görünümler (front, top …) zaten ortografik.
  `--projection ortho` ile `iso` ve `camera` (`--eye`'dan hedefe bakış yönünde, görünür kutuyu çerçeveler) de dik izdüşümle çekilir:
  paralel kenarlar paralel kalır, ölçü/oran karşılaştırması ve teknik görünüm için. `eye` (göz hizası) her zaman perspektiftir ve
  `--fov` ortoda anlamsızdır: ikisi `ortho` ile hata verir. Sekmedeki kamera tipinden bağımsızdır. Ortoda `camera` görünümünde
  `--target` (yoksa kutu merkezi) **yalnızca bakış yönünü** belirler; çerçeve her zaman görünür kutuya oturur (hedef çerçevenin
  merkezi değildir).
- Arayüzde: görünüm grubundaki **Orto** düğmesi ya da **O** / **Num 5** perspektif ↔ ortografik kamera (hedef, bakış yönü ve
  hedefteki ölçek korunur, sahne ölçeğinden sınırlara kırpılarak; ortoda tekerlek yakınlaştırır). Kamera tipi yalnızca o sekmenin
  görünümüdür, projeye girmez. Kalem aracıyla çizilirken ya da nokta sürüklenirken kamera değişmez; kalemde eksen kilidi
  (X/Y/Z/N) açıkken Num 5 sayı girişine aittir (O yine çalışır).
- Arayüzde: araç çubuğunda **Gölgeli / Tel / X-ışını** düğmeleri ya da **W** (sırayla döner). Biçim yalnızca o sekmenin görünümüdür;
  projeye, geri-al geçmişine ve otomatik kayda girmez. **Aç…** bir `.glb`'yi yeni proje olarak açar (tek ağ parçası dosyadaki
  yerinde; dosyaya bağlı olmaz, Kaydet yeni bir `.p3d.json` indirir), **İçe aktar…** GLB'yi parça olarak ekler.
- Hepsi bağlı sekmenin sahnesinde ya da `--file model.p3d.json` ile dosyada çalışır. `measure`, `check`, `section` aynı
  motorla Node'da hesaplanır; `snapshot --file` WebGL için görünmez Chrome/Edge açar (~8 sn, P3D sunucusu çalışmalı).
- `check` profili: `print` (varsayılan; ince parça ve tabla teması dahil) ya da `game` (üçgen bütçesi `--max-tris`,
  bozuk üçgen; `p3d guide game`).
- Görüntüde bakılacaklar: titreşen yüzeyler, yarıklar, havada duran ya da iç içe giren parçalar, ters yön/eksen, eksik
  delik/çerçeve, beklenmeyen sivri uçlar.
- Kullanıcıya sonucu kısaca özetleyin: ne çizildi, ölçüler, `check` sonucu, açık kalan varsayımlar.
