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
  ölçüleri oradan hesaplayın.

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
| `prism` | `sides` (3–128), `diameter` (köşeden köşeye), `height` |

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
  yay uzunluğuyla dağıtın. **Loft, kesiti ucunda sıfıra inen ya da topolojisi değişen gövdelerde zayıftır** → `hull`.
- **`hull`** `{kind, stations: [{x, keel, sheer, breadth[]}]}`: x boyunca, y'de simetrik gövde (endaze). `breadth` omurgadan
  küpeşteye eşit aralıklı yarı genişliklerdir, her istasyonda aynı sayı; x artan sırada. İlk/son istasyon düz ayna ile kapanır;
  tüm genişlikleri 0 olan istasyon sivri uçtur. Tekne, kano, gövde, araç kaportası gibi sivrilen gövdeler için. Oyuk (güverte)
  için ikinci bir `hull` delik. Üretimi ~2 sn sürer.
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
