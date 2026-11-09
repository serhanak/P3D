# Eskiz: ekranda çizerek tarif etme

Kullanıcı tarayıcıda 3B görünümün üstüne kalem aracıyla çizgiler çizerek ne istediğini **tarif eder**: üstten bir çokgen
çizip notuna "kapak, 3 mm kalın" yazar, bir okla "buraya 4 vida" der. Bu çizgiler **niyet verisidir**: geometri üretmez,
dışa aktarılmaz, `check`'e girmez, deliklerle kesilmez. Siz (ya da `/api/nl`'deki Claude) eskizi okuyup parçaları var olan
işlemlerle kurarsınız; eskizi kendiliğinden geometriye çeviren bir işlem yoktur.

## Veri modeli
Projede `sketch` dizisi (eskiz yoksa alan hiç bulunmaz). Her **yol**:

| Alan | Anlam |
|---|---|
| `id` | Kimlik |
| `name` | "Yol 1", "Yol 2"… Yalnızca eskiz yolları arasında benzersiz (parça adlarıyla çakışabilir) |
| `closed` | Kapalı mı (son → ilk kenarı da çizilir) |
| `plane` | Çizim düzlemi `{axis, at}`: `axis` eksenine dik, o eksende `at` konumunda. `{"axis": "z", "at": 0}` = üstten, tablada |
| `points` | 1–1000 nokta `{p, hIn?, hOut?}`: `p` dünya koordinatı (mm); `hIn` / `hOut` Bezier tutamaçları, `p`'ye **göreli** |
| `note` | Kullanıcının kısa notu (≤ 200 karakter); yoksa alan yok |

Tutamaçsız kenar düzdür; bir ucunda tutamaç varsa kübik Bezier'dir (`p_i`, `p_i + hOut_i`, `p_{i+1} + hIn_{i+1}`, `p_{i+1}`).
İşlemlerde yola adıyla (büyük/küçük harf ve aksan duyarsız) ya da kimliğiyle başvurulur.

## Türler
| Tür (`kind`) | Ne zaman | Özetteki ek alanlar |
|---|---|---|
| `marker` (işaret) | Tek nokta | — |
| `arrow` (ok) | Açık, iki nokta: p0 → p1 | `length` (mm), `direction` (birim yön) |
| `line` (çizgi) | Diğer açık yollar | `length` |
| `polygon` (kapalı çokgen) | Kapalı, ≥ 3 nokta | `length` (çevre) |

Her yolun özetinde `bbox` vardır; eğri (tutamaçlı) yollarda ayrıca `polyline` (örneklenmiş noktalar, kapalı yolda ilk nokta
tekrarlanmaz). Sayılar 2 ondalığa yuvarlanır.

## Ajan iş akışı
1. **Okuyun:** `p3d scene` çıktısının sonunda `eskiz (N):` satırları; ayrıntı `p3d sketch` (tür, nokta, düzlem, kutu, not),
   tamamı `p3d sketch --json` (sahne özetindeki `sketch` ile aynı; `--sample 16` eğrileri daha sık örnekler). Dosyada
   `--file m.p3d.json`. Eskizler sekmede çizilir; `p3d snapshot` görüntülerinde de görünür.
2. **Yorumlayın:** notu ve türü birlikte okuyun ("3 mm kalın", "4 vida"). Belirsizse sorun (`p3d guide ambiguity`).
3. **Kullanın:** koordinatlar dünya mm'dir, doğrudan kullanılır.
   - **Kapalı çokgen → ekstrüzyon profili.** Düzlem ekseni a ise her nokta (eğride `polyline`) geom kuralıyla 2B'ye iner:
     a = z → [x, y], a = x → [y, z], a = y → [x, z] (betikte `pathProfile(yol)`, `import … from 'p3d'`). `geom.axis` = a,
     `position` {0, 0, 0}; ekstrüzyon konuma göre merkezli (−h/2…+h/2) çekildiğinden düzlemden yukarı büyümesi için
     `position`'ın a bileşeni `at + height/2` olur (öbür yöne `at − height/2`).
   - **Ok → yön ve uzaklık:** `move` için `dx, dy, dz = direction × length`; ya da ucuna (p1) bir şey koyun.
   - **İşaret → konum:** delik ya da parça merkezi.
   - **Çizgi → izlenecek yol ya da kenar.**
4. **Temizleyin:** iş bitince kullandığınız yolu silin (`sketch_delete` ya da `p3d sketch --clear "Yol 1"`; tümü:
   `p3d sketch --clear`). Kullanıcı eskizi bırakmak isterse dokunmayın.

## Örnek
Kullanıcı üstten (z = 0) 40 × 20 mm dikdörtgen çizdi, notu "kapak, 3 mm". `p3d sketch --json`:
```json
[{"id":"p_k3x9a1bq","name":"Yol 1","kind":"polygon","closed":true,"plane":{"axis":"z","at":0},
  "points":[{"p":{"x":-20,"y":-10,"z":0}},{"p":{"x":20,"y":-10,"z":0}},{"p":{"x":20,"y":10,"z":0}},{"p":{"x":-20,"y":10,"z":0}}],
  "length":120,"bbox":{"min":{"x":-20,"y":-10,"z":0},"max":{"x":20,"y":10,"z":0}},"note":"kapak, 3 mm"}]
```
Tabladan yukarı 3 mm kapak, sonra eskizi silme:
```json
[
  {"op":"create","shape":"extrude","name":"kapak","params":[{"name":"height","value":3}],
   "geom":{"kind":"extrude","axis":"z","profile":[[-20,-10],[20,-10],[20,10],[-20,10]],"holes":[]},
   "position":{"x":0,"y":0,"z":1.5}},
  {"op":"sketch_delete","path":"Yol 1"}
]
```

## Eskiz işlemleri (yalnızca yerel/köprü; Claude şemasında yok)
```json
[
  {"op":"sketch_add","closed":true,"note":"kapak, 3 mm",
   "points":[{"p":{"x":-20,"y":-10,"z":0}},{"p":{"x":20,"y":-10,"z":0}},{"p":{"x":20,"y":10,"z":0}},{"p":{"x":-20,"y":10,"z":0}}]},
  {"op":"sketch_add","name":"vida","points":[{"p":{"x":0,"y":0,"z":5}},{"p":{"x":0,"y":0,"z":17}}],"note":"buraya 4 vida"},
  {"op":"sketch_update","path":"Yol 1","note":"kapak, 4 mm"},
  {"op":"sketch_move","path":"vida","indices":[1],"dx":0,"dy":0,"dz":3},
  {"op":"sketch_delete","path":"vida"}
]
```
- `sketch_add`: `name` ""/yok = "Yol N" (çakışırsa sonuna sayı eklenir). `plane` yoksa noktalardan türetilir: tüm z eşit → z;
  tüm y eşit → y; tüm x eşit → x; değilse z düzlemi, `at` = en küçük z.
- `sketch_update`: verilmeyen (yok/null) alan değişmez; `points` verilirse tamamı değişir; `note: ""` notu siler; başka bir
  yolun adı verilirse hata. `points` verilip `plane` verilmezse ve yeni noktaların hepsi düzlem ekseninde aynı konumdaysa
  `plane.at` o konuma gelir (yol normal yönünde taşındı); değilse düzlem değişmez. Kapalı yol 3 noktanın altına inince açık olur
  (`sketch_add` için de: `closed` en az 3 nokta ister).
- `sketch_move`: `indices` yok/boş = tüm noktalar; tutamaçlar göreli olduğundan noktayla gider. Tüm yol taşınınca `plane.at`
  da kayar.
- `sketch_delete`: `path` yok/"" = tüm eskiz silinir (eskiz yoksa hata değil).

## Arayüz (kalem aracı)
Araç çubuğunda **✎ Kalem** (ya da **P**) kalemi açar; **Eskiz** anahtarı katmanı gizler/gösterir (yalnızca görünüm, projeye
yazılmaz; kalem açıkken katman hep görünür). Kalem açıkken sol tuş eskize aittir; kamerayı orta tuş döndürür, sağ tuş
kaydırır, tekerlek yakınlaştırır, **F** sığdırır. Görünümün üstündeki yüzen çubukta çizim düzlemi, eksen kilidi, değer alanı
ve "Yakala 1 mm" bulunur.

- **Çizim düzlemi:** açılışta seçili eskiz yolunun düzlemi; yoksa bakış yönüne en yakın eksen (üstten bakınca z, önden y),
  seçili parça varsa onun kameraya bakan yüzünde, yoksa 0'da. Kamera dönse de düzlem değişmez; çubuktan (X/Y/Z + konum)
  değiştirilir. Çizgiler düzlemdeki ızgaranın üstüne düşer.
- **Çizmek:** boş yere tıklamak köşe noktası, tıklayıp sürüklemek eğri (Bezier) noktası koyar; sürükleme yönü çıkış
  tutamacıdır. ≥ 3 noktada **ilk noktaya tıklamak** yolu kapatıp bitirir; **Enter** ya da çift tık açık bitirir (1 nokta
  işaret, 2 ok, ≥ 3 çizgi). **Backspace** son noktayı siler, **Esc** taslağı iptal eder. Biten yol seçili kalır, kalem açık kalır.
- **Düzenlemek:** noktaya tıklayıp sürüklemek onu taşır (yol düzlemine paralel); **Shift+tık** seçime ekler/çıkarır, seçili
  noktalar birlikte gider. Çizgiye tıklamak yolu seçer; **Ctrl+tık** o kenara nokta ekler (eğri kenar şeklini koruyarak
  bölünür). **Delete** seçili noktaları (yoksa yolu) siler.
- **Üçüncü eksen:** **X / Y / Z** o eksende taşımayı kilitler (aynı tuş kaldırır), **N** yol düzleminin normalini (üstten
  çizilmiş yolda z: noktayı yukarı kaldırır). Kilit ekseni ekranda renkli kılavuz çizgisiyle görünür. Nokta seçiliyken ve kilit
  varken rakam yazıp **Enter** o eksende mutlak değer verir, **Shift+Enter** göreli taşır ("Z = 15"); çubuktaki değer alanı da
  aynı işi yapar ("göreli" kutusuyla).
- **Yakalama:** **Shift** basılıyken (ya da "Yakala 1 mm" işaretliyse) nokta parçaların köşelerine / yüz merkezlerine / diğer
  eskiz noktalarına (≈ 10 px içinde), yoksa 1 mm ızgaraya yakalanır.
- **Esc** sırası: sürükleme/taslak iptal → yazılan sayı → eksen kilidi → nokta seçimi → kalemi kapat.
- **Paneller:** sol listede "Eskiz" bölümü (tür, ad, nokta sayısı, not; ✕ sil); seçili yolun sağ panelinde ad, **not**
  (Claude bunu okur), kapalı, düzlem, uzunluk/çevre, kutu, nokta tablosu (x/y/z düzenlenebilir) ve **Kalemle düzenle**.
- Her değişiklik tek işlemdir (`sketch_add` / `sketch_update` / `sketch_delete`), Ctrl+Z ile geri alınır. Sürükleme bırakılınca
  tek adım olur. Yollar, oklar, işaretler ve adları WebGL'de çizildiğinden `p3d snapshot` görüntülerine girer (kadraja
  katılır); ızgara, kılavuz, taslak ve seçim vurgusu görüntüye girmez.
