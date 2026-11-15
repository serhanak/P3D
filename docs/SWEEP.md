# Süpürme (`sweep`) — tasarım taslağı

> **Durum: tasarım onaylandı (2026-11-14), Faz 1 uygulandı (2026-11-15); Faz 2 (eskiz bağı) bekliyor.** Boltrush istekleri #14 (düzlemde yol boyunca süpürme) ve
> #16 (3B yol boyunca boru) ile yol haritası 10'daki ertelenmiş `sweep`. Kararlar: (1) çerçeve varsayılanı `up`, yuvarlak
> kesitte kendiliğinden `rmf`, yuvarlak olmayan kesitte düşey bölüm hatası; (2) sığmayan köşe yarıçapı hata (sığan en büyük
> yarıçapı söyler); (3) eskiz bağı kopya (Faz 2).

## Amaç ve kapsam

Kapalı bir kesiti bir yol boyunca süpüren **tek** bir `geom` türü. Aynı tür hem düzlemdeki yolları hem 3B yolları
karşılar; boru da ayrı bir şekil değildir, yuvarlak kesitli bir süpürmedir.

| Kullanım | Bugün (Boltrush) | `sweep` ile |
|---|---|---|
| Rental tampon halkası: yatay yol, R 150 köşeler, pahlı kesit, üç parça dikişte buluşuyor | z-loft + kenar başına içe kaydırma (`go-body.mts` `band`/`inset`); yuvarlak ya da eğik kesit kurulamıyor | Kesit `[u, v]` + yol + `bend: 150`; uçlar yola dik ve düz, parçalar dikişsiz birleşir |
| Retro boru tamponu: düzlem dışına çıkan çoklu çizgi, köşeleri yay | Yay betikte (`fillet`) + parça parça `prism` + bindirme; z-fighting için ardışık parçalarda 0,4 mm çap farkı (U tampon 11 parça) | `diameter: 28`, `bend: …`; tek kapalı ağ, iç kapak ve bindirme yok |
| Kemer / kapı şeridi (`ribbon`): düşey düzlemdeki eğri boyunca ince bant | Eğriyi betikte kaydırıp `extrude` | Dikdörtgen kesit, `up` = düzlemin normali |
| İleride: korkuluk, kablo kanalı, kulp, pist bordürü | Loft / basamaklama | Yol + kesit |

Kapsam dışı (v1):
- Yol boyunca değişen kesit (ölçek ya da burulma). Bunun için loft var.
- Bezier yol. Eskizden alınırken örneklenir (aşağıda "Eskiz bağı").
- Yolun kendini kesmesinin genel denetimi (bkz. "Doğrulama").

## Biçim

```jsonc
{
  "kind": "sweep",
  "path": [[x, y, z], [x, y, z, r], …],  // ≥ 2 nokta; 4. değer (isteğe bağlı) o köşenin yay yarıçapı
  "closed": false,                       // true: son → ilk nokta da bağlanır, uç kapağı yok (halka)
  "bend": 0,                             // köşe yay yarıçapı (mm), varsayılan 0 = keskin gönye; noktadaki r önceliklidir
  // kesit: ya profile ya diameter
  "profile": [[u, v], …],                // kapalı çokgen; u = gidiş yönünün sağı, v = "yukarı"; (0,0) yolun üstünde
  "holes": [[[u, v], …]],                // isteğe bağlı iç boşluklar (extrude'daki gibi)
  "diameter": 28,                        // yuvarlak kesit (kenar sayısı = parçanın/projenin çözünürlüğü)
  "innerDiameter": 20,                   // isteğe bağlı: içi boş boru
  "up": [0, 0, 1],                       // kesitin v ekseninin yönü (varsayılan +Z)
  "frame": "up"                          // "up" | "rmf" (Karar 1)
}
```

- Koordinatlar diğer `geom` türleri gibidir: geometri yeniden merkezlenmez, `position` yol koordinatlarının orijinini
  taşır. `position` {0,0,0} ile yazılan yol dünya koordinatıdır. Parametre olarak `scale` vardır.
- **Kesit düzlemi:** her noktada `v` ekseni, `up`'ın teğete dik bileşenidir; `u = teğet × v` gidiş yönünün sağıdır. Yatay
  yolda `v` = +Z olur. Saat yönünün tersine dönen kapalı yolda `u` dışarıyı gösterir, yani tampon kesitinde `u > 0` dış yüzdür.
- **Düzlemdeki yol:** `up` olarak düzlemin normali verilirse (yatay yolda varsayılan +Z zaten budur) çerçeve tam
  düzlemseldir; burulma ve tekillik olmaz. Düşey düzlemdeki kemer için `up: [0, 1, 0]`.
- **Köşeler:** `bend` (ya da noktadaki `r`) > 0 ise köşe o yarıçapta bir yaya çevrilir. Yay, çözünürlüğe göre bölünür
  (tam daire = çözünürlük kadar kiriş). `bend` 0 ise gönye kullanılır: köşedeki kesit açıortay düzleminde durur ve dönüş
  yönünde `1/cos(θ/2)` uzar.
- **Uçlar (açık yol):** yola dik, düz kapak. Aynı kesitle süpürülen iki parça, uç noktaları ve son teğetleri aynıysa
  dikişsiz birleşir. Rental halkasının üç parçası böyle kurulur.
- **Boru:** `diameter` verilince kesit `sides` = etkin çözünürlükte bir çokgen olur. Parça başına çözünürlük (#15, ayrı
  iş) ile LOD1'de yalnızca boruların kenar sayısı düşürülebilir. Çokgen kesitin bir düz kenarı alta (`−v`) bakar.

## Çerçeve: `up` ve `rmf` (Karar 1 — seçilen: a)

3B yolda kesitin yol çevresinde nasıl döneceğini çerçeve belirler.

- **`up` (önerilen varsayılan):** kesit hep `up` yönüne göre dik kalır. Yokuş çıkan korkuluk, rampa bordürü ve yatay
  tampon için doğru olan budur. Teğet `up`'a ~10°'den yakın olduğunda (düşey bölüm) çerçeve tanımsız kalır.
- **`rmf` (dönmeyi en aza indiren çerçeve, double reflection):** kesit yol boyunca kendi çevresinde dönmez. Her yolda
  tanımlıdır ve borular için doğrudur. İlk çerçeve `up`'tan alınır. Kapalı yolda kapanıştaki açı farkı yol boyunca eşit
  dağıtılır. Sarmal bir rampada kesit "yukarı"ya göre yavaşça yatar; korkulukta bu yanlıştır.

Öneri:
- Varsayılan `up` olsun.
- Kesit yuvarlaksa (`diameter`) çerçevenin dönmesi görünmez; bu durumda `rmf` kendiliğinden seçilsin.
- Yuvarlak olmayan kesitte düşey bölüm varsa açıklayıcı hata verilsin ("dikey bölüm var: `frame: \"rmf\"` verin ya da
  `up`'ı değiştirin"). Sessiz geçiş yapılmasın.

Seçenekler: (a) öneri; (b) her zaman `rmf` (basit ama korkuluk gibi kesitler yokuşta yatar); (c) her zaman `up` (düşey
bölümlü borular hata verir).

## Köşe yarıçapı sığmazsa (Karar 2 — seçilen: hata)

Yayın teğet boyu, köşeye bağlanan kenarların yarısını aşarsa yarıçap sığmaz.

- **Hata (önerilen):** mesaj o köşede sığan en büyük yarıçapı söyler. P3D'nin "sessiz düzeltme yok" çizgisiyle uyumludur;
  #12 de sessiz kırpma yüzünden açılmıştı.
- **Kırpma + uyarı:** Boltrush'ın `fillet`'i gibi, sığan en büyük yarıçapa iner ve işlem mesajında söyler.

## Doğrulama (`sanitizeGeom`)

Açıklayıcı Türkçe hata veren durumlar:
- Yolda 2'den az nokta; ardışık iki noktanın çakışması; kapalı yolda 3'ten az nokta.
- Kesit kendini kesiyor, alanı yok ya da `diameter` ≤ 0; `innerDiameter` ≥ `diameter`.
- **İç yanın katlanması:** büküm yarıçapı kesitin dönüş içindeki genişliğinden küçük (`r ≤` kesitin o yöndeki uzanımı).
  Gönyede, bir kenar iki ucundaki gönye paylarının toplamından kısaysa.
- Gönyede dönüş ≥ 150° (gönye sonsuza uzar; `bend` verin).
- Çerçevenin tanımsız kaldığı yer (Karar 1).

Denetlenmeyen: yolun kendisine çok yaklaşması ya da kesişmesi (ör. sarmal, kendini kesen halka). Ağ kapalı kalır ama
kendini keser. v1'de kullanıcının sorumluluğundadır; ileride `check` bunu bildirebilir.

## Motor ve diğer işlemler

- Ağ: yol örneklenir (yaylar + gönyeler), her örnekte kesit halkası, halkalar arası dörtgenler, açık yolda iki uç
  kapağı (üçgenleme `ShapeUtils`). İndisli, kapalı, normalleri dışa bakan ağ üretilir; delik ve dışa aktarım mevcut yoldan
  geçer.
- Üçgen sayısı: `örnek sayısı × kesit noktası × 2 (+ kapaklar)`. Örnek: 10 kenarlı U boru, 2 köşe × 8 kiriş + 3 düz
  kenar → ~400 üçgen, tek ağ.
- **Ayna:** yol yansıtılır; çerçevenin el kuralı değiştiğinden kesitte `u` işaret değiştirir ve sırası ters çevrilir
  (birebir ayna, loft'taki `mirrored` bayrağı gerekmez).
- `update` ile `geom` yeniden yazılır (diğer türler gibi). `place_on_surface`, gruplar ve GLB değişmeden çalışır.
- Claude şeması: `geom` `anyOf`'una `sweep` girer (tüm alanlar zorunlu, boş = `null`); talimata kısa bir bölüm eklenir.
  Yerel ayrıştırıcıya kalıp eklenmez (yol nokta listesi istiyor).
- Rehber: `modeling.md` → Serbest biçimler (sweep, çerçeve kuralı, kapsam dışı), `ops.md`.

## Eskiz bağı (Karar 3 — seçilen: kopya; yol haritası 10'un parçası, v1'den sonra)

Eskiz katmanında kullanıcının çizdiği yol, süpürmenin yolu olabilir.

- **Kopya (önerilen):** bir komut / panel düğmesi ("Bu yolu süpür") eskiz yolunu örnekleyip `geom.path`'e yazar. Bezier
  örneklenir, köşeler `r` olarak taşınır. `geom` kendi başına yeter; eskiz silinse de parça kalır.
- **Canlı bağ (`geom.sketch: "Yol 3"`):** eskizde nokta oynayınca parça yeniden üretilir. Daha güçlü ama projede eskiz ile
  geometri arasında bağımlılık doğar (silme/yeniden adlandırma, dosya doğrulama, geri al). Kopyadan sonra gerekirse eklenir.

## Testler (uygulamada)

- Düz yol = `extrude` hacmi; gönyeli L yol = alan × orta çizgi uzunluğu (kesitin ağırlık merkezi yolun üstündeyse tam).
- Daire yol (`closed`, `bend`) + daire kesit ≈ torus (Pappus, çokgen düzeltmesiyle).
- 3B yol: `rmf`'de kapanış farkı dağıtılmış, kapalı ağ; `up`'ta düşey bölüm hatası; yuvarlak kesitte kendiliğinden `rmf`.
- Doğrulama hataları (katlanma, sığmayan yarıçap, ≥ 150° gönye, kendini kesen kesit).
- Ayna birebir; iki parça uç uca dikişsiz (kesit halkaları aynı); düşük çözünürlükte kapalılık; GLB / `check --profile game`.
- Boltrush'ın U tamponunun birebir tekrarı: tek ağ, `check` temiz (bugünkü z-fighting yok).

## Tahmini iş

Faz 1 (bu taslak, eskiz bağı hariç):
- `src/geom.ts` üreteci ve doğrulaması (~300 satır);
- şema, talimat, rehber;
- ~10 test.

Uygulayıcı ajanla yaklaşık bir oturum sürer. Faz 2 (eskizden kopya) ayrı ve küçüktür.

## Uygulama notları (Faz 1)

Kod: `src/geom.ts` → "Süpürme" bölümü (`sanitizeSweep`, `sweepPlan`, `sweepSamples`, `sweepFrames`, `checkSweep`,
`checkUpTwist`, `sweepRaw`); testler `tests/sweep.test.ts`, ayna `tests/game.test.ts`, CLI `tests/cli.test.ts`.

### Tasarımdan sapmalar ve verilen kararlar
- **`rmf` uç hizalaması:** tasarımda yalnızca kapalı yolun kapanış farkı dağıtılıyordu. Açık yolda da son uçtaki fark (son teğet
  up'a ~1°'den yakın değilse) dağıtılır; böylece aynı kesitle uç uca süpürülen borular dikişsiz birleşir ve iki uçta da kesit
  up'a hizalıdır. Fark yay boyuna göre **yalnızca yaylara** dağıtılır (düz kenarlar burulmaz, düşük poligonda yüzler düz kalır);
  yolda yay yoksa tüm uzunluğa. Yuvarlak kesitte fark 360°/kenar kipine indirilir (çokgen kendi simetrisiyle döner, burulma en
  fazla yarım kenar); kapalı yolda dikişte halka indisi o kadar kayar.
- **RMF hesabı:** her adımda teğetten kirişe, kirişten sonraki teğete iki en küçük dönme. Düz kenarda ve düzlemsel yayda (yol
  yalnızca bunlardan oluşur) kesindir; double reflection bu iki durumda aynı sonucu verir. İlk teğet up'a ~1°'den yakınsa
  başlangıç çerçevesi up'ın tanımlı olduğu ilk örnekten geri taşınır.
- **Kısa köşegen kuralı:** yan dörtgenler kısa köşegeninden bölünür. Kural konumdan gelir (indis sırasından değil); aynada kesit
  sırası ters dönse de aynı köşegen seçilir, `mirrored` bayrağı gerekmez.
- **Yay sığma:** bir yay, komşu köşesi de yay olan kenar zincirinin en az yarısını (komşunun payı yarıdan azsa kalanını), komşusu
  gönye ya da yolun ucu olan zincirin tamamını kullanabilir. Hata o köşede sığan en büyük yarıçapı (0,01'e aşağı yuvarlı) söyler.
- **Katlanma:** yayda yarıçap > kesitin dönüşün iç yanındaki uzanımı; gönyede her kesit noktası için iki uçtaki pay (gönye payı ya
  da yay teğeti) toplamı < zincir uzunluğu (nokta nokta, yöne bağlı). Yuvarlak kesitte daire sınırı kullanılır (güvenli yanda).
  Denetimler çözünürlükten bağımsızdır (yaylar 2°'lik adımla örneklenir) ve `sanitizeGeom`'dadır.
- **Kapaklar:** içi boş yuvarlak boruda iki halka arasında şerit üçgenlenir; diğer kesitlerde earcut. Earcut'un atladığı doğrusal
  kapak köşeleri (ör. aynı hizadaki boşluklar) T-kavşağı onarımıyla kapanır (`fixTJunctions`: eşsiz yönlü kenarın üstüne düşen köşede
  üçgen bölünür). Aynı onarım `extrude`'a da uygulanır; kapalı ağlarda hiçbir şey değiştirmez (örnek ve test extrude'larında
  ağlar bayt bayt aynı).
- **Sınırlar ve eşikler:** gönye ≤ 150°; `up` çerçevesinde dikey bölüm 10°; düz geçiş < 1e-6 rad (köşe ve halka yok); tam 180°
  geri dönüş hata; çakışık örnekler (< 1e-6 mm) birleşir; yay sığma toleransı 1e-9 mm. Yol ≤ 1024 nokta, kesit ≤ 1024 nokta;
  ağ ≤ 1 milyon köşe (halka × kesit noktası) — doğrulamada çözünürlükten bağımsız alt sınır (yol noktası × kesit noktası;
  yuvarlak kesit en az 6 kenar), üretimde gerçek sayı.
- **Çözünürlük:** sweep yalnızca yuvarlak kesit ya da yaylı köşe varken çözünürlük kullanır (`usesResolution`); yay başına
  ⌈s · dönüş / 360°⌉ kiriş, yuvarlak kesitte s kenar.

### İncelemeden gelen kurallar (2026-11-15)
- **`up` burulma sınırı:** `up` çerçevesinde ardışık halkalar arasındaki burulma (en küçük dönmeyle taşınan çerçeveye göre açı;
  gönyede ayrıca gönye halkası ile kenarın kendi çerçevesi arasında; yayda toplam burulmanın en düşük çözünürlükteki kiriş sayısına
  bölümü) 45°'yi aşarsa hata: "up bu yolda hızla dönüyor … frame: "rmf" verin, köşeye yarıçap verin (bend) …". Düzlemsel yollarda
  (up düzlemin içinde ya da normali) burulma 0'dır; yatay tampon, rampa, düşey kemer, sarmal küpeşte (yaylı ya da gönyeli,
  ~37° eğime kadar) geçer. Tırmanırken 90° dönen **keskin gönye** (ör. %50 eğimli merdivende) ~48° burulur ve reddedilir:
  kesit gerçekten kenar boyunca o kadar dönerdi; `bend` ile ~24°'ye iner.
- **Tamamen up yönündeki yol:** yuvarlak olmayan kesitte hata ("yol baştan sona up yönünde: kesit yönünü belirlemek için up'ı yola
  dik verin"); yedek eksen (+Y/+X) aynaya göre eşdeğişken olmadığından kullanılmaz. Yuvarlak kesitte yedek kalır. Verilen `up` aynada
  yansıdığından bu yol da birebir aynalanır.
- **Mutlak koordinat sınırı:** yol, kesit (profil, boşluk, çap), `bend` ve `up` değerleri en fazla ±1 000 000 mm (1e150 NaN ağ
  üretiyordu).
- **4. değer kuralı:** yol noktasındaki r yalnızca > 0 iken `bend`'i ezer; 0 ya da yok = `bend` (sanitize 0'ı yazmaz). Her noktaya
  "yarıçap yok" anlamında 0 yazan bir model `bend`'i sessizce kapatmaz. Tek köşede gönye: `bend` verilmez, yaylı köşelere r verilir.
- **Doğrusal ara noktalar:** tam doğrusal noktalar (dönüş < 1e-6 rad) yay payı ve katlanma denetiminde kenar zincirine katılır
  (zincir uzunluğu = toplam); eskizden örneklenen yollar sahte "sığmıyor" / "yetmiyor" hatası vermez.
- **Boşluk doğrulaması (yalnızca sweep):** boşluklar profilin içinde, profil kenarına değmeyen, birbirini kesmeyen ve kapsamayan
  çokgenler olmalı. Extrude'a eklenmedi (var olan dosyalar yüklenmeye devam etsin); extrude'da bu eksik bilinen sorundur.

### Bilinen sınırlar
- Yolun kendine çok yaklaşması ya da kendini kesmesi denetlenmez (sarmal, kendini kesen halka): ağ kapalı kalır ama kendini keser.
- Tek çözünürlük hem yuvarlak kesitin kenar sayısını hem yay kiriş sayısını belirler (ör. "10 kenar + 22,5° kiriş" kurulamaz:
  10 → 3 kiriş/90°, 16 → 16 kenar).
- Yuvarlak kesitte gönye katlanma sınırı daireyle hesaplanır: iç yanları zıt yönde olan kısa S dönüşlerinde gerekenden tutucudur.
- Kısa köşegen eşitliğinde (düzlemsel dörtgen, ör. düz kenar ya da burulmasız yay) özgün ve aynadaki parça farklı köşegeni seçebilir:
  geometri birebir aynadır, üçgen kümesi değil.
- Yalnızca yol tümüyle up yönündeyken yuvarlak kesitte kullanılan yedek eksen y aynasında çokgeni (tek kenar sayısında) 180°
  döndürebilir; köşe kümesi kenar sayısı çiftse aynıdır.
