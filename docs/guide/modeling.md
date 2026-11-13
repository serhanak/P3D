# Modelleme kuralları

## Koordinatlar ve birimler
- Birim **mm**, **Z yukarı**. Tabla XY düzleminde (z = 0), orijin tabla merkezinde. Yönler: sağ +X, arka +Y, ön −Y.
- `position` şeklin **geometrik merkezidir** (dünya). Yüksekliği h olan ve s yüksekliğindeki bir yüzeye oturan parçanın
  z'si `s + h/2` olur.
- `rotation` merkez etrafında XYZ Euler, **derece**.
- İstisna: `extrude` / `revolve` / `loft` / `hull` (ve içe aktarılan `mesh`) geometrisi **yeniden merkezlenmez**. `position`
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
  `smooth: true` organik yüzey (monoton kübik, taşmaz), `sharp` keskin kalacak indisler. Kesit noktalarını eğri boyunca eşit
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
- Hepsinde `scale` parametresi tüm geometriyi büyütür.

## Roller ve delikler
- `role` yok = katı. `hole`: kutusu kesişen görünür katılardan çıkarılır (ekranda, hacimde, dışa aktarımda aynı); kendisi
  dışa aktarılmaz. `reference`: yalnızca görsel; dışa aktarılmaz, kesilmez.
- Delik katının içinden **~1 mm taşsın**. Delik varsayılan olarak kesiştiği **tüm** katıları keser; komşu parçaları
  kesmemesi için `cuts: ["hedef"]` ile sınırlayın.
- **Z-fighting kuralı:** aynı delik iki katıyı keserse ikisinde aynı düzlemde kesim yüzü oluşur ve ekranda titreşir. Her deliği
  tek parçaya bağlayın; birden fazla parça oyulacaksa her biri için ayrı delik kullanın ve kesim yüzünü diğer parçanın malzemesi
  içinde bırakın. Çerçeve açıklığını deliğinden ~0,1 mm büyük çizin. `p3d check` bulur.

## Yüzeye oturtma
`place_on_surface {part, target, near, offset}`: parçayı hedefin `near` noktasına en yakın yüzey noktasına koyar ve yerel +Z
eksenini yüzey normaline çevirir; `offset` normal boyunca kaydırır. Eğri/eğik yüzeydeki flanş, perçin, topuz için.

## Bir nesneyi orijinaline yakın çizmek
1. Referansı yarı saydam alın: `p3d import ref.stl --role reference --keep-position`.
2. `p3d section --file ref.stl --axis … --at …` ile istasyon / su hattı / boyuna kesitlerden ölçün.
3. Yapıyı (hangi özellik hangi şekil) siz kurun, sayıları ölçümden alın.
4. `snapshot` + `measure` (birleşik hacim) ile karşılaştırın. Örnek akış: P3D deposunda `examples/README.md` (3DBenchy).

## Kaçınılacaklar
- Ham mesh/üçgen üretmek; eğriyi kutularla basamaklamak.
- Kalıcı modellere/örneklere mesh gömmek (uygulamanın kendi şekilleriyle kurun).
- Bir deliği birden fazla katıya kestirmek (z-fighting).
- Sahneyi okumadan konum hesaplamak; ölçüleri `bbox`'tan alın.
