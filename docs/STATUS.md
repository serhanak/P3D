# Proje durumu

> Son güncelleme: **2026-10-15** — MVP (v0.1). Bir işi bitiren ajan/geliştirici bu dosyayı güncellemelidir.

## Tamamlananlar (MVP)

- **Şekiller:** kutu, silindir, boru (iç/dış çap), koni (kesik koni dahil), küre, torus, prizma (3–128 kenar).
- **Doğal dil — yerel Türkçe ayrıştırıcı** (çevrimdışı): oluşturma (AxBxC, "20 mm çaplı", "çapı 20", adet,
  isim, renk, "X'in üstüne"), ölçü değiştirme (`10mm büyüt`, `30'a çıkar`, `%20 artır`, `2 katına çıkar`,
  `yarıya indir`, yarıçap), taşıma (eksen, yön kelimeleri, mutlak `x=… y=…`), döndürme, üstüne/yanına koy,
  tablaya indir, kopyala (adetli), sil, yeniden adlandır, renk (açık/koyu, hex), gizle/göster, seç,
  isim/ölçü görünürlüğü, geri al/yinele, "yardım". Türkçe hâl ekleri ve aksansız yazım desteklenir;
  "ve"/"sonra" ile birleşik komutlar ve önceki komuttan bağlam.
- **Doğal dil — Claude modu** (opsiyonel, `.env`'de `ANTHROPIC_API_KEY`): yapılandırılmış JSON çıktı ile
  aynı işlem listesini üretir. Otomatik modda yalnızca yerel ayrıştırıcının anlamadığı komutlar gider.
- **Görünüm:** Z-yukarı tabla ızgarası (10/50 mm), eksen göstergesi, renkli parçalar, kenar çizgileri,
  isim etiketleri (aç/kapa), ölçü çizgileri + etiketleri (aç/kapa), tıklayarak seçim, görünüm ön ayarları
  (İzo/Üst/Ön/Sağ), sığdır.
- **Paneller:** parça listesi (renk, görünürlük, sil), özellik paneli (ad, renk, ölçüler, konum — Z taban,
  döndürme, boyut, hacim, yaklaşık PLA ağırlığı, tablaya indir/kopyala/gizle/sil), hızlı ekleme düğmeleri.
- **Durum:** tüm değişiklikler işlem (Op) olarak; geri al/yinele (200 adım); localStorage otomatik kayıt.
- **Dosya:** proje kaydet/aç (`.p3d.json`, doğrulama ve onarım ile); OBJ dışa aktarım: tek OBJ,
  OBJ+MTL (renkli ZIP), her parça ayrı OBJ (ZIP), seçili parça. Ağlar kaynaklı (köşe paylaşımlı) ve manifold.
- **Ayarlar:** tabla boyutu, yuvarlak yüzey çözünürlüğü (32–192 segment; ekran + dışa aktarım).
- **Sunucu:** Vite ara katmanı (geliştirme) ve `server/index.ts` (üretim) aynı `/api` işleyicisini kullanır.

## Doğrulama durumu

| Alan | Durum |
|---|---|
| Ayrıştırıcı + işlem motoru | ✅ 22 otomatik test (`tests/parser.test.ts`) |
| OBJ çıktısı | ✅ Her şekil için kapalı/doğru yönlü ağ ve hacim ≈ analitik değer (`tests/io.test.ts`) |
| Proje kaydet/yükle | ✅ Gidiş-dönüş ve bozuk dosya onarımı testleri |
| Arayüz | ✅ Chrome'da elle denendi: komutlar, panelden düzenleme, geri al, isim/ölçü anahtarları, dışa aktarma menüsü, otomatik kayıttan geri yükleme; konsolda hata yok |
| Claude isteği | ⚠️ Yalnızca **sahte (mock) API** ile doğrulandı: istek biçimi (model, `fallbacks`, beta başlığı, `output_config`, şema) ve yanıt işleme. **Gerçek API ile hiç denenmedi.** |
| Dışa aktarılan dosyalar | ⚠️ İçerik testlerle doğrulandı; tarayıcıdan gerçek indirme ve dilimleyicide (PrusaSlicer/Cura/Bambu/Orca) açma **denenmedi** |
| Diğer tarayıcılar | ❔ Yalnızca Chrome denendi |
| Üretim sunucusu | ✅ `npm start` ile statik dosyalar, `/api/status`, dizin dışına çıkma engeli denendi |

## Bilinen sorunlar ve sınırlamalar

**Modelleme**
- **Boolean işlemler (delik açma/kesme) yok.** Basit delik için boru şekli kullanılabilir.
- Görünümde sürükleyerek taşıma/döndürme (gizmo) yok; konum komutla ya da panelden girilir.
- Parçalar birbirine bağlı değil: alttaki parça kalınlaşınca üstteki onunla yükselmez (iç içe girer);
  "X'i Y'nin üstüne koy" ile yeniden hizalanır. Gruplama yok.
- Pah/yuvarlatma, metin, vida dişi, ayna, dizi (array) yok.
- Otomatik yerleşim tabla doluysa parçayı tablanın dışına (sağa) koyar.
- `set_position` X/Y'yi parçanın merkezine uygular; tek kenarlı prizma/koni döndürülmüşse sınırlayıcı kutu
  merkezi ile küçük fark olabilir.

**Ayrıştırıcı**
- Fiilsiz, virgülle ayrılmış birden fazla şekil tek cümle sayılır: "50x30x10 kutu, 20 çaplı silindir ekle"
  yalnızca ilk şekli oluşturur (iki ayrı komut ya da "ve ... ekle" kullanılmalı).
- Oluştururken isim tek kelime (+ isteğe bağlı sayı) olmalı; çok kelimeli isim tırnakla: `adı "sol ayak"`.
- Aynı şekilden birden çok parça varken "kutunun" gibi şekil referansı bağlamdaki/son eklenen parçayı seçer.
- "halka/pul/rondela" → boru; torus için "torus/simit". Yönler: sağ +X, sol −X, arka/geri +Y, ön/ileri −Y.
- "Mili 10 mm büyüt" (ölçü adı olmadan mm ile) yalnızca kürede çalışır; diğerlerinde hangi ölçü olduğu sorulur.

**Claude modu**
- Akış (streaming) yok; yanıt gelene kadar konsolda "Claude düşünüyor…" görünür.
- Bağlam yalnızca son 6 komut metni + güncel sahne; çok turlu konuşma geçmişi tutulmaz.
- Maliyet/gecikme ayarı (effort) ölçülmedi; varsayılan `medium`.

**Uygulama**
- Geri-al geçmişi ve seçim sayfa yenilenince sıfırlanır (proje otomatik kayıttan gelir).
- Yoğun sahnelerde isim etiketleri üst üste binebilir.
- İstemci paketi ~665 kB (three.js); kod bölme yapılmadı.
- Hacim/ağırlık %100 doluluk varsayar. Gizli parçalar dışa aktarılmaz.

## Yol haritası (öncelik sırasıyla)

1. **Delik/boolean (CSG):** `three-bvh-csg` ile; `Part.role: 'solid' | 'hole'`; delikler kesiştiği katı
   parçalardan çıkarılır, görünümde yarı saydam gösterilir, dışa aktarım CSG sonucunu kullanır.
   Ayrıştırıcı ("tabana 5 mm çaplı delik aç") ve Claude şeması/talimatı güncellenir.
2. **Sürükleme gizmosu** (`TransformControls`), 1 mm / 15° yakalama; sürükleme bitince tek `Op`.
3. **STL ve 3MF dışa aktarım** (3MF çok renkli/çok parçalı baskı için Bambu/Prusa'da daha iyi).
4. **Gruplama / ebeveyn-çocuk** (üstteki parça alttakini takip etsin).
5. **Claude:** gerçek API ile uçtan uca test, akış + ilerleme göstergesi, değerlendirme seti, effort/maliyet ayarı.
6. Yeni şekiller: yuvarlatılmış kutu, pah, kama, metin; CSG sonrası somun/flanş gibi hazır parçalar.
7. Hizala/dağıt, ayna, dizi işlemleri ("4 köşeye yerleştir").
8. Geri-al geçmişini kalıcı tutma; birden çok proje listesi.
9. three.js için kod bölme.
