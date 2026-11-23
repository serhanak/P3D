# Modelleme kuralları

## Koordinatlar ve birimler
- Birim **mm**, **Z yukarı**. Tabla XY düzleminde (z = 0), orijin tabla merkezinde. Yönler: sağ +X, arka +Y, ön −Y.
- `position` şeklin **geometrik merkezidir** (dünya). Yüksekliği h olan ve s yüksekliğindeki bir yüzeye oturan parçanın
  z'si `s + h/2` olur.
- `rotation` merkez etrafında XYZ Euler, **derece**.
- İstisna: `extrude` / `revolve` / `loft` / `hull` / `sweep` / `decal` (ve içe aktarılan `mesh`) geometrisi **yeniden merkezlenmez**. `position`
  profil koordinatlarının orijinini taşır; döndürme o orijin etrafındadır. `position` {0,0,0} ile yazdığınız sayılar
  dünya koordinatıdır (önerilen).
- Ölçü ya da döndürme değişince parça **tabanını (min z) ve XY merkezini korur** (konum açıkça verilmedikçe). Parçalar
  birbirine bağlı değildir: alttaki kalınlaşınca üstteki onunla yükselmez (`place_on` ile yeniden hizalayın).
- `set_position` (yalnızca yerel/köprü) işleminde `z` **tabandır**; diğer her yerde merkezdir. Sahne özetinde `bbox` verilir;
  ölçüleri oradan hesaplayın. `bbox` (ve betiklerde `partBox`/`partsBox`) şeklin **kesimsiz** kutusudur; yerleştirme işlemleri
  de onu kullanır. Delikler çıkarılmış son hâlin kutusu: `p3d measure` ya da betikte `solidBox`/`solidPartsBox`.

## İşlem (Op) gönderme
- İşlemler JSON dizisidir (ayrıntı: `p3d guide ops`). `params` **her zaman dizidir**:
  `{name, value, mode?: 'set'|'add'|'mul'}`; `name` bir şekil parametresi ya da `wall`.
- `update` içindeki değerler **mutlaktır**; göreli istekleri ("çapını 10 mm büyüt") mevcut değerden siz hesaplayın.
- Bir listedeki hatalı işlem uygulanmaz, diğerleri uygulanır; hata mesajları açıklayıcıdır — okuyup düzeltin.
- Konum hesaplamak yerine `place_on`, `place_beside`, `drop_to_bed`, `place_on_surface` tercih edin.

## Temel şekiller
| Şekil | Parametreler |
|---|---|
| `box` | `width` (X), `depth` (Y), `height` (Z) |
| `cylinder` | `diameter`, `height` (eksen Z) |
| `tube` | `outerDiameter`, `innerDiameter` (< dış), `height` |
| `cone` | `bottomDiameter`, `topDiameter` (0 = sivri), `height` |
| `sphere` | `diameter` |
| `torus` | `diameter` (dış), `thickness` (halka kesiti); XY düzleminde yatar |
| `prism` | `sides` (3–128), `diameter` (köşeden köşeye), `height` — köşe fazı aşağıda |

**Prizma köşe fazı.** Bir düz kenar yerel **−Y**'ye bakar (köşeler `−90° + 180°/n + k·360°/n` açılarında; R = çap/2, düz
kenarın merkeze uzaklığı `R·cos(180°/n)`). Dik dururken ön yüz (−Y) her n'de düzdür; ±X'te düz kenar yalnızca n **4'ün katıysa**
vardır (n = 6, 10, 14 … ±X'te köşe; tek n'de +Y'de köşe). Yatırırken:
- `rotation: {x: 90}` (eksen Y'ye yatar): taban her n'de **düz**.
- `rotation: {y: 90}` (eksen X'e yatar): taban yalnızca n 4'ün katıysa düz (n = 4, 8, 12); 6 ve 10'da köşe alta gelir
  (çap 1000'de z aralığı n = 4 ±353,6; 6 ±500; 8 ±461,9; 10 ±500; 12 ±483). Düz taban için prizmayı kendi ekseni çevresinde
  `rotation.z = 90 mod (360/n)` çevirin: n = 6 → 30, n = 10 → 18, n = 3 → 90, n = 5 → 18 (XYZ Euler'de z önce, parçanın
  kendi ekseninde uygulanır). Genel kural: yerel θ yönünde (derece, +X'ten) düz kenar için `rotation.z ≡ θ + 90 (mod 360/n)`;
  köşe için buna `180/n` ekleyin.

## Serbest biçimler (`geom`)
Eğri/eğik yüzeyleri ilkel şekillerle **basamaklamayın**; ham üçgen de üretmeyin. Niyeti şekille verin, motor kapalı ağı üretir.
2B nokta ekseni: `axis` z → [x, y], x → [y, z], y → [x, z]. Çokgenler kapalıdır (ilk nokta tekrarlanmaz), kendini kesmez,
noktalar çevre boyunca sıralıdır. Nokta sayısını makul tutun (çokgen başına tipik 6–40).

- **`extrude`** `{kind, axis, profile, holes, frame, open}`: profil `height` kadar, merkezli (−h/2…+h/2) çekilir. `holes` iç
  çokgenlerdir. `frame > 0` parçayı profil çevresinde o genişlikte bir çerçeveye çevirir (profil açıklık olur; kapı/pencere
  pervazı, bezel); `open: true` son→ilk kenarı açık bırakır (U pervaz).
- **`revolve`** `{kind, axis, profile}`: profil noktaları `[r, a]` (r ≥ 0 eksene uzaklık, a eksen boyunca), 360° döndürülür.
  Topuz, şişe, flanş, pahlı somun.
- **`loft`** `{kind, axis, sections: [{at, points}], smooth, sharp}`: kesitler arası yüzey. Her kesitte **aynı nokta sayısı**,
  aynı başlangıç noktası ve aynı dönüş yönü (ör. alt orta, saat yönünün tersi). Uçta tek noktalı kesit sivri bitirir.
  `smooth: true` organik yüzey (monoton kübik, taşmaz), `sharp` keskin kalacak indisler. Yumuşatma etkin çözünürlüğe bağlıdır
  (aşağıda "Parça çözünürlüğü"): çevrede kenar başına `round(çözünürlük / 24)`, kesitler arasında aralık başına
  `round(çözünürlük / 32)` alt bölüm. **Çözünürlük 36'nın altında yumuşatma etkisizdir** (ağ `smooth: false` ile aynı; oyun
  projelerinin 8 / 16 değerleri dahil), 36–47 arasında yalnızca çevrede yumuşar; düşük poligon projede yumuşak loft'a
  `resolution: 48` verin. İşlem iletisi bu durumda uyarır. Kesit noktalarını eğri boyunca eşit
  yay uzunluğuyla dağıtın. Bir kesitte **ardışık iki noktayı çakıştırmak** (dejenere kenar) noktanın orada erimiş olması
  demektir: nokta sayısı ve indis eşleşmesi korunur, nokta öbür kesitte açılır (kesit boyunca doğup büyüyen çıkıntı/oyuk;
  `smooth` yüzeyini değiştirmez). Çakışık noktalar sayılınca da kesitlerin nokta sayısı eşit değilse tekrarlar atılır ve
  kesitler yeniden örneklenir. **Loft, kesiti ucunda sıfıra inen ya da topolojisi değişen gövdelerde zayıftır** → `hull`.
- **`hull`** `{kind, stations: [{x, keel, sheer, breadth[]}]}`: x boyunca, y'de simetrik gövde (endaze). `breadth` omurgadan
  küpeşteye eşit aralıklı yarı genişliklerdir, her istasyonda aynı sayı; x artan sırada. İlk/son istasyon düz ayna ile kapanır;
  tüm genişlikleri 0 olan istasyon sivri uçtur. Tekne, kano, gövde, araç kaportası gibi sivrilen gövdeler için. Oyuk (güverte)
  için ikinci bir `hull` delik. Üretimi ~1–4 sn sürer; her boyutta çalışır (1 m üstü gövdeler aynı ızgara bütçesiyle,
  ayrıntı gövde boyunun ~%0,4'ü). Üretilemeyen geometri işlem hatası olarak döner, `check` de bildirir. Varsayılan ağ
  ayrıntılıdır (~30–60 bin üçgen, çözünürlükten bağımsız); düşük poligon için `maxTris` (100–1 000 000) üçgen bütçesi verin:
  ağ en fazla o kadar üçgen olur, üretim de hızlanır (2 m'lik gövde 1000 üçgende ~0,4 sn, hacim farkı < %0,5).
- **`sweep`** `{kind, path, closed, bend, profile, holes, diameter, innerDiameter, up, frame}`: sabit bir kesit 3B çoklu çizgi
  boyunca süpürülür. Boru, kulp, korkuluk, tampon, pervaz, kablo kanalı gibi kesiti değişmeyen ama yolu dönen parçalar için
  (extrude yalnızca düz gider; kesit değişiyorsa loft). Ayrıntı aşağıda.
- **`decal`** `{kind, profile, holes, double, lift}`: kalınlıksız düz **kaplama** (plaka, far, harf, şerit, dama karesi);
  katı değildir. Ayrıntı aşağıda ("Kaplama").
- Hepsinde `scale` parametresi tüm geometriyi büyütür (kaplamada yalnızca profili; `lift` değişmez).

### Süpürme (`sweep`)
- **Yol:** `path` noktaları `[x, y, z]` (yerel mm; geometri yeniden merkezlenmez, `position` {0,0,0} ile dünya koordinatı) ya da
  `[x, y, z, r]`: **r > 0** ise o köşenin yay yarıçapıdır ve `bend`'i ezer; **0 ya da yok = `bend`** (0 "yarıçap yok" demektir,
  gönye değil). Tek köşede gönye isteniyorsa `bend` verilmez, yaylı köşelere r verilir. En az 2 nokta, en fazla 1024; ardışık
  noktalar farklı; değerler (yol, kesit, `bend`, çap, `up`) en fazla ±1 000 000 mm. Aynı doğru üzerindeki ara noktalar sorun
  değildir: yay payı ve katlanma köşeden köşeye toplam uzunlukla denetlenir. `closed: true` son → ilk noktayı da bağlar (halka;
  en az 3 nokta, ilk noktada da köşe işlenir, kapak yok; ilk noktayı sonda tekrarlamayın — tekrarlanırsa atılır).
- **Kesit:** ya `profile` (çokgen `[u, v]`, isteğe bağlı `holes`) ya `diameter` (yuvarlak; kenar sayısı = etkin çözünürlük, köşeden
  köşeye çap, bir düz kenar −v'ye bakar; `innerDiameter` içi boş boru). İkisi birden ya da hiçbiri hatadır. **u gidiş yönünün
  sağı, v "yukarı"**, (0, 0) yolun üstündedir: yatay yolda v = +Z; saat yönünün tersine dönen kapalı yolda u > 0 dış yüzdür.
  Boşluklar profilin içinde olmalı; profilin kenarına ve birbirine değmemeli, birbirini kapsamamalı (yoksa hata).
  Bütçe: yol noktası × kesit noktası (yuvarlak kesitte en az 6, içi boşsa 12) 1 milyonu aşamaz; çözünürlükle artan halka ×
  kenar sayısı da üretimde aynı sınıra bağlıdır.
- **Çerçeve:** `up` (yok = [0, 0, 1]) kesitin v yönüdür: her noktada up'ın teğete dik bileşeni. Düzlemdeki yolda `up` = o düzlemin
  normali (yatay yol: varsayılan; XZ düzlemindeki kemer: `[0, 1, 0]`) — çerçeve tam düzlemsel, burulma yok. `frame` yok =
  yuvarlak kesitte `"rmf"`, profilde `"up"`. `"up"`: kesit yokuşta da up'a göre dik kalır (korkuluk, rampa bordürü); yolun bir
  yeri up'a ~10°'den yakınsa hata ("dikey bölüm var"). Kesit ardışık halkalar arasında 45°'den fazla burulursa da hata ("up bu
  yolda hızla dönüyor"): eğik bir `up` ya da tırmanırken dönen keskin gönye (ör. %50 eğimli merdivende 90° köşe ~48°) — köşeye
  `bend` verin (burulma yaya yayılır) ya da `"rmf"` kullanın. `"rmf"`: kesit yol boyunca kendi çevresinde dönmez (her yolda
  tanımlı; borular); ilk çerçeve up'tan alınır, uçlar up'a hizalanır: kapalı yolda kapanış farkı, açık yolda son uçtaki fark yay
  boyuna göre yaylara dağıtılır (düz kenarlar burulmaz; yay yoksa tüm uzunluğa). Yuvarlak kesitte fark çokgenin kendi simetrisine
  (360°/kenar) indirilir. Yol baştan sona up yönündeyse (düşey dikme) profil kesitte `up`'ı yola dik verin (yoksa hata); yuvarlak
  kesitte gerekmez.
- **Köşeler:** `bend` (ya da noktadaki r) > 0 ise köşe o yarıçapta yaya çevrilir (tam daire başına çözünürlük kadar kiriş);
  yoksa gönye: kesit açıortay düzleminde, dönüş yönünde 1/cos(θ/2) uzar (en fazla 150° dönüş). Yayın teğet boyu r·tan(θ/2)
  komşu kenarlara sığmalı (komşu köşe de yaysa kenarın en az yarısı, komşunun payı yarıdan azsa kalanı); sığmazsa hata o köşeye
  sığan en büyük yarıçapı söyler. Yarıçap, kesitin dönüşün iç yanındaki uzanımından büyük olmalı (yuvarlak kesitte çap/2); gönyede
  kenar, iki ucundaki gönye paylarının (nokta nokta, yöne bağlı) toplamından uzun olmalı. Yoksa iç yan katlanır: hata.
- **Uçlar:** açık yolun iki ucu yola dik düz kapaktır. Aynı kesitle süpürülen, uç noktası ve teğeti aynı iki parça dikişsiz
  birleşir (uç halkaları çakışır; parçaları ayrı renklendirmek için böyle bölün).
- **Ayna** yolu ve up'ı yansıtır, profilde u işaret değiştirir: kopya birebir aynadır.
- **Kapsam dışı:** yol boyunca değişen kesit (ölçek, burulma → loft), Bezier yol (noktaları örnekleyin), eskizden süpürme. Yolun
  kendine çok yaklaşması/kesişmesi denetlenmez (sarmal, kendini kesen halka: ağ kapalı kalır ama kendini keser).
- Örnek (tampon halkası, pahlı kesit):
  `{"kind":"sweep","path":[[-100,-60,0],[100,-60,0],[100,60,0],[-100,60,0]],"closed":true,"bend":30,"profile":[[-4,0],[4,0],[6,2],[6,10],[4,12],[-4,12],[-6,10],[-6,2]]}`;
  3B boru: `{"kind":"sweep","path":[[0,0,0],[40,0,0],[40,30,20],[0,30,40]],"bend":8,"diameter":6}`.

### Kaplama (`decal`)
- **Ne zaman:** bir yüzeyin üstündeki düz renk bölgesi (plaka, far, harf, şerit, logo, dama karesi). Kutuyla çizmek 12 üçgen
  tutar (görünen 2); kaplama profilin üçgenleri kadardır (dikdörtgen 2). Oyun varlıkları için; baskıda karşılığı yoktur.
- **Biçim:** `profile` yerel XY düzleminde kapalı çokgen [x, y] (extrude gibi; ilk nokta tekrarlanmaz), `holes` içteki boşluklar
  (profilin içinde, kenarına değmeyen). Yüz yerel **+Z**'ye bakar; ağ `z = lift`'tedir (varsayılan 0,5 mm, 0,01–100; `lift`
  yok / null / 0 = 0,5): taşıyıcı yüzeyle çakışıp titremesin. `double: true` iki yüzlü (ekranda ve GLB malzemesinde
  `doubleSided`; üçgen çoğaltılmaz) — ince levha, tabela, kalınlıksız bayrak için.
- **Yerleştirme:** `place_on_surface` (yerel +Z'yi yüzey normaline çevirir; kaplama yüzeyden `lift` kadar dışarıda kalır) ya da
  `position` + `rotation` (yerel +Z = bakış yönü: `rotation` {x: 90} −Y'ye (ön yüz), {x: −90} +Y'ye, {y: 90} +X'e bakar; {x: 90}'da
  profilin y'si dünya z'sidir). `place_on` tabanı hedefin üstüne koyar (yukarı bakan kaplama `lift` kadar yukarıda; aşağı bakan
  kaplamada hata verir: `place_on_surface` kullanın ya da döndürün). Parçalar
  birbirine bağlı değildir: taşıyıcıyla birlikte taşımak için ikisini bir **grup** yapın. Ayna yüzü yansıyan yöne çevirir (arka yüz
  için ön yüzün kaplamalarını `mirror` edin).
- **Katı değildir:** hacmi 0 (`measure` ve `section` varsayılan kümesine, katı toplamına ve birleşik hacme girmez), delik kesmez ve
  delikle kesilmez, `role: "hole"` verilemez (referans olabilir). Baskıya girmez: STL / 3MF / Birleştir'de uyarıyla atlanır; GLB ve
  OBJ'ye girer (OBJ/MTL'de iki yüzlülük yoktur; iki yüzlü kaplama için GLB kullanın). `check`'te
  kapalılık, ince parça ve tabla kurallarına girmez; z-fighting: taşıyıcı yüzle yalnızca tam çakışırsa (`lift`'i geri alan
  konum), başka bir kaplamayla aynı düzlemde üst üste binerse bildirilir. Gizli yüz ayıklamasına (`--cull-hidden`) girmez.
- Örnek — plaka, kaputun ön yüzüne:
  `{"op":"create","shape":"decal","name":"plaka","color":"#f2c94c","geom":{"kind":"decal","profile":[[-150,-55],[150,-55],[150,55],[-150,55]]}}`
  sonra `{"op":"place_on_surface","part":"plaka","target":"kaput","near":{"x":0,"y":-400,"z":90}}` (kaputun önündeki bir nokta).
- Örnek — damalı bayrak (4000 × 50 × 1200 kutu, iki yüzüne 16'şar 500 × 300 kare): ön yüz kareleri
  `{"op":"create","shape":"decal","name":"kare0","color":"#111111","rotation":{"x":90,"y":0,"z":0},"position":{"x":-1750,"y":-25,"z":150},"geom":{"kind":"decal","profile":[[-250,-150],[250,-150],[250,150],[-250,150]]}}`
  (8 × 4 ızgaranın koyu yarısı: x = −1750 + 500·sütun, z = 150 + 300·satır), `group` "ön" + `{"op":"mirror","part":"ön","plane":"y","at":0,"name":"arka"}`.
  16 kutu × 12 = 192 üçgen yerine 12 + 32 × 2 = 76.

## Roller ve delikler
- `role` yok = katı. `hole`: kutusu kesişen görünür katılardan çıkarılır (ekranda, hacimde, dışa aktarımda aynı); kendisi
  dışa aktarılmaz. `reference`: yalnızca görsel; dışa aktarılmaz, kesilmez.
- Delik katının içinden **~1 mm taşsın**. Delik varsayılan olarak kesiştiği **tüm** katıları keser; komşu parçaları
  kesmemesi için `cuts: ["hedef"]` ile sınırlayın.
- **Z-fighting kuralı:** aynı delik iki katıyı keserse ikisinde aynı düzlemde kesim yüzü oluşur ve ekranda titreşir. Her deliği
  tek parçaya bağlayın; birden fazla parça oyulacaksa her biri için ayrı delik kullanın ve kesim yüzünü diğer parçanın malzemesi
  içinde bırakın. Çerçeve açıklığını deliğinden ~0,1 mm büyük çizin. `p3d check` bulur.

## Saydamlık (`opacity`)
- `create` / `update` alanı = **opaklık**, 0 (tamamen saydam) – 1 (opak); yoksa opak. **Saydamlık = 1 − opaklık** ("%30
  saydam" = `opacity: 0.7`). Katıda yalnızca `< 1` iken saklanır, `update` ile 1 vermek alanı kaldırır; aralık dışı değer işlem
  hatasıdır. Cam, vizör, far camı, rüzgârlık için (ör. füme cam: koyu renk + `0.4`). Parçayı gizlemek için `visible: false`
  kullanın; Claude yolunda `opacity: 0` "verilmedi" sayılır (şemadaki boş sayı parçayı görünmez yapmasın), yerel/köprü
  işlemleri 0'ı kabul eder.
- **Yalnızca görseldir:** parça yine katıdır; dışa aktarılır (opacity 0 da), hacme ve `check`'e girer, delikler onu keser, delik
  parçası saydam olsa da keser. Ekranda yarı saydam çizilir (kenar çizgileri de soluklaşır), `snapshot` görüntüsüne girer.
  Görünen saydamlığı 0 olan parça tıklamada atlanır (arkasındaki seçilir).
- Dışa aktarımda: GLB'de malzeme alfası (`baseColorFactor[3]`) + `alphaMode: "BLEND"` (aynı renk ve saydamlık tek malzeme),
  3MF'te `displaycolor` `#RRGGBBAA`, OBJ+MTL'de `d`. STL'de karşılığı yoktur.
- **Roller:** görünen saydamlık parçanın `opacity`'sidir; alan yoksa katı opak, `reference` 0,35, `hole` 0,3 çizilir. Yani
  `opacity` rolün varsayılan yarı saydamlığının yerine geçer: referans ağı `opacity: 0.7` ile daha belirgin, `0.15` ile daha
  silik, `1` ile tamamen opak yapılabilir (referans ve delikte `1` açık değer olarak saklanır; parça katıya dönerse kalkar).
- Yerel komutlar (oran yüzde ya da 0–1 kesir; işaretsiz sayı 1'den büyükse yüzdedir, 100'ü aşamaz): "camı yarı saydam yap"
  (0,5; oran verilmezse de 0,5), "%30 saydam yap" / "30 saydam yap" / "saydamlığını 0,3 yap" (0,7), "saydamlığını %40 yap"
  (0,6), "%70 opak" / "opaklığını 0,7 yap" (0,7), "opak yap" / "saydamlığını kaldır" (1; referansta da); oluştururken "yarı
  saydam küre ekle". Sonuç tamamen saydam olacaksa ("%100 saydam", "saydamlığını 1 yap") işlem üretilmez, hata verir: gizlemek
  için "gizle".

## Parça çözünürlüğü (`resolution`)
- Proje çözünürlüğü (`settings.resolution`, Ayarlar) tüm yuvarlak yüzeylerin segment sayısıdır. Bir parçaya kendi değerini
  vermek için `create` / `update` alanı `resolution` (6–192 tamsayı; kesir yuvarlanır): `0` / null proje ayarıdır (`update`'te
  `0` alanı kaldırır). Yuvarlak şekilde sınır dışı değer işlem hatasıdır. Panelde **Çözünürlük** alanı (boş = proje ayarı).
- Geçerli şekiller: `cylinder`, `tube`, `cone`, `sphere`, `torus`, `revolve`, `loft` (yalnızca `smooth: true` iken), `sweep`
  (yalnızca yaylı köşe ya da yuvarlak kesit varken: yay kirişleri ve kesit kenar sayısı). Kutu, prizma, ekstrüzyon, yumuşak
  olmayan loft ve yaysız köşeli kesitli süpürme segment kullanmaz; `hull` (üçgen bütçesi `geom.maxTris`) ve `mesh`
  etkilenmez. Bunlara verilen `resolution` **yok sayılır** ve işlem mesajına uyarı yazılır (işlem hata vermez; toplu "düşük
  poligon" isteği parça kaybettirmez). Yumuşak loft'un geometrisi yumuşak olmayana (süpürmeninki yaysız köşeli kesitliye)
  dönerse alan kalkar. Grupta `resolution` > 0 hatadır (0/null yok).
- Etkin değer ekranda, kutuda (`bbox`), hacimde, deliklerde (delik parçası kendi çözünürlüğüyle keser), `check`'te ve tüm dışa
  aktarımlarda kullanılır. Değişince parçanın merkezi yerinde kalır.
- Kürede enlem sayısı segmentten türer (`max(4, segment/2)`), torusta kesit segmenti de (`max(4, min(12, segment − 4),
  segment/3)`). Üçgen sayıları: küre `2·s·(enlem − 1)` (8 → 48, 16 → 224), silindir `4·s`, torus `2·s·kesit` (16 → 384);
  süpürme: `p3d guide game` → "Süpürme üçgen sayısı".
- **Yumuşak loft eşiği:** alt bölüm çevrede `p = max(1, round(s/24))`, kesit aralığı başına `a = max(1, round(s/32))`;
  1 = o yönde yumuşatma yok. **s < 36: yumuşatma etkisiz** (ağ `smooth: false` ile bayt bayt aynı), 36–47: yalnızca çevrede
  (kesitler arası doğrusal), ≥ 48: iki yönde (varsayılan proje ayarı 96: p = 4, a = 3). İki kesitli loft'ta kesitler arası
  yüzey her çözünürlükte doğrusaldır (yalnızca çevre yumuşar). `create` / `update` (geom ya da çözünürlük verilince) etkisiz
  ya da yarım yumuşatmada işlem iletisine uyarı yazar. Uçsuz, N noktalı K kesitli dışbükey loft'ta üçgen sayısı
  `2·N·p·(K − 1)·a + 2·(N·p − 2)`: sekizgen 6 kesit s ≤ 35'te 92, 48'de 348.
- Oyun için tipik kullanım: proje ayarı düşük (ör. 8), göze batan büyük yuvarlaklar (teker) `resolution: 16`; ya da proje
  ayarı yüksek, küçük küreler/eklemler `resolution: 6–8`. Yumuşak loft'a düşük projede `resolution: 48` (çevrede 2, kesitler
  arasında 2 alt bölüm; 72 → 3 / 2, 96 → 4 / 3).

## Yüzeye oturtma
`place_on_surface {part, target, near, offset}`: parçayı hedefin `near` noktasına en yakın yüzey noktasına koyar ve yerel +Z
eksenini yüzey normaline çevirir; `offset` normal boyunca kaydırır. Eğri/eğik yüzeydeki flanş, perçin, topuz için.

## Bir nesneyi orijinaline yakın çizmek
1. Referansı yarı saydam alın: `p3d import ref.stl --role reference --keep-position` (daha belirgin/silik için `update` ile
   `opacity`).
2. `p3d section --file ref.stl --axis … --at …` ile istasyon / su hattı / boyuna kesitlerden ölçün.
3. Yapıyı (hangi özellik hangi şekil) siz kurun, sayıları ölçümden alın.
4. `snapshot` + `measure` (birleşik hacim) ile karşılaştırın. Örnek akış: P3D deposunda `examples/README.md` (3DBenchy).

## Kaçınılacaklar
- Ham mesh/üçgen üretmek; eğriyi kutularla basamaklamak.
- Kalıcı modellere/örneklere mesh gömmek (uygulamanın kendi şekilleriyle kurun).
- Bir deliği birden fazla katıya kestirmek (z-fighting).
- Sahneyi okumadan konum hesaplamak; ölçüleri `bbox`'tan alın.
