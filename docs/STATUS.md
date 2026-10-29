# Proje durumu

> Son güncelleme: **2026-10-29** — v0.3: tekne (`hull`) şekli, çerçeve, yüzeye oturtma, delik hedefi, birleştirme, `check`,
> indisli dışa aktarım; 3DBenchy örneği yalnızca uygulamanın kendi şekilleriyle.

## Yeni oturuma başlarken (ajanlar için)

1. `npm install` · `npm run typecheck` · `npm test` (67 test, ~10 sn) — hepsi temiz olmalı.
2. Modelleme/arayüz işi için: `npm run dev` (arka planda; Claude Code hesabıyla serbest komutlar için `npm run dev:claude`),
   kullanıcının tarayıcı sekmesi açık olmalı; `npm run -s p3d -- scene` ile bağlantıyı doğrulayın (409 = sekme bağlı
   değil → kullanıcıdan F5 isteyin). Kullanıcı sahnede değişiklik yapılmasına izin verdi ve ilerlemeyi orada izlemeyi seviyor.
3. Doğrulama döngüsü: `snapshot --out <scratchpad>` (Read ile bakın) · `measure` (birleşik hacim) · `check` (z-fighting) ·
   `section`. Ayrıntı: AGENTS.md → "Doğrulama döngüsü", "Serbest biçimler ve delikler".
4. Örnekler uygulamanın kendi şekilleriyle kurulur, mesh gömülmez. 3DBenchy üreteci: `examples/tools/build-3dbenchy.ts`
   (referans STL indirme komutu dosyanın başında; repoya koymayın).
5. Bu dosyayı iş bitince güncelleyin; commit mesajları kısa, Türkçe olabilir; `main` dalı, GitHub `serhanak/P3D` (özel). Bir işi bitiren ajan/geliştirici bu dosyayı güncellemelidir.

## Tamamlananlar (MVP)

- **Şekiller:** kutu, silindir, boru (iç/dış çap), koni (kesik koni dahil), küre, torus, prizma (3–128 kenar).
- **Serbest biçimler (`geom`):** ekstrüzyon (profil + boşluklar, x/y/z ekseni), döndürme (profil [r, a]), loft
  (kesitler arası yüzey; farklı nokta sayısı yeniden örneklenir), hepsinde `scale`. Doğrulama: kapalı, kendini
  kesmeyen çokgen; açıklayıcı Türkçe hata. Panelde geometri JSON olarak düzenlenir.
- **v0.3 eklemeleri:** loft `smooth` (monoton kübik; taşmasız) + `sharp` köşeler + uçta tek noktalı kesit;
  extrude `frame` (profil = açıklık, `open` ile U pervaz); `place_on_surface` (eğri yüzeye dik oturtma, yumuşak normal);
  delik hedefi `cuts` (panelde **Keser** alanı); **Birleştir** dışa aktarımı (union, tek gövde STL/3MF);
  `check` (z-fighting, boolean hatası, boş delik, ince parça, tabla teması); `measure` birleşik hacim.
- **Roller ve delikler:** katı / delik / referans. Delik, kutusu kesişen görünür katılardan manifold-3d ile çıkarılır
  (ekranda, hacimde ve tüm dışa aktarımlarda aynı sonuç); "Delikler" anahtarı yalnızca görüntüyü gizler.
  Ayrıştırıcı: "tabana 5 mm çaplı delik aç", "… 8 mm derinliğinde", "X'i delik/katı/referans yap", "delikleri gizle".
- **Ağ içe aktarma:** STL / OBJ / 3MF (arayüz **İçe aktar…** ya da `p3d import`); kaynak, gerekirse meshoptimizer ile
  sadeleştirme (varsayılan 60 bin üçgen), merkezleme; ağ verisi geri-al geçmişine girmez, proje dosyasına gömülür.
- **Yapay zekâ doğrulama döngüsü (CLI):** `snapshot` (dik izdüşüm + izometrik PNG), `measure` (delikli hacim, kutu),
  `section` (sahnede ya da dosyada kesit çokgenleri), `import --role reference --keep-position`.
- **Doğal dil — yerel Türkçe ayrıştırıcı** (çevrimdışı): oluşturma (AxBxC, "20 mm çaplı", "çapı 20", adet,
  isim, renk, "X'in üstüne"), ölçü değiştirme (`10mm büyüt`, `30'a çıkar`, `%20 artır`, `2 katına çıkar`,
  `yarıya indir`, yarıçap), taşıma (eksen, yön kelimeleri, mutlak `x=… y=…`), döndürme, üstüne/yanına koy,
  tablaya indir, kopyala (adetli), sil, yeniden adlandır, renk (açık/koyu, hex), gizle/göster, seç,
  isim/ölçü görünürlüğü, geri al/yinele, "yardım". Türkçe hâl ekleri ve aksansız yazım desteklenir;
  "ve"/"sonra" ile birleşik komutlar ve önceki komuttan bağlam.
- **Doğal dil — Claude modu** (opsiyonel): yapılandırılmış JSON çıktı ile aynı işlem listesini üretir.
  Otomatik modda yalnızca yerel ayrıştırıcının anlamadığı komutlar gider. Arka uç açılışta seçilir
  (`--llm` / `P3D_LLM`): `api` (ANTHROPIC_API_KEY, sunucu kurulumu), `claude-cli` (makinedeki `claude -p`,
  kullanıcının kendi Claude Code hesabı; yalnızca kişisel kullanım), `off`, `auto` (anahtar varsa api).
- **Claude Code köprüsü** (`/api/bridge`, `npm run p3d`): terminaldeki Claude Code oturumu açık sekmenin
  sahnesini okur ve işlem gönderir; sekmede canlı uygulanır, geri alınabilir, günlükte "Claude Code" etiketi.
  `npm run dev`'de açık, `npm start`'ta kapalı (`--bridge`).
- **Tekne (`hull`, endaze) şekli:** istasyon tablosu (`x, keel, sheer, breadth[]`) → örtük yüzey ∩ yan profil;
  keskin küpeşte/taban/ayna, V bodoslama; önbellekli üretim. Claude şeması ve talimatında var.
- **Örnek projeler** (`examples/`): `3dbenchy.p3d.json` — 3DBenchy (CC0), orijinal STL'den ölçülerek **yalnızca
  uygulamanın kendi şekilleriyle** kuruldu (mesh ve loft yok): `hull` tekne + `hull` güverte kuyusu deliği, çerçeveli
  kapı/pencere, yüzeye oturan loça boruları, çatı ekstrüzyon + yan kesimler; 27 parça, 150 kB, `check` temiz,
  birleşik hacim 15,25 cm³ (orijinal 15,55; −%1,9).
- **Örtük yüzey ve ölçüm yardımcıları** (`csg.ts`): `levelSetGeometry` (sdf → kapalı ağ, isteğe bağlı manifold
  sadeleştirme), `sliceMany` (bir ağda çok kesit, tek dönüşüm). İçe aktarma sadeleştirmesi `Regularize` ile.
  Testler her örneğin onarımsız yüklendiğini ve kapalı ağ olarak dışa aktarıldığını doğrular.
- **Başlatıcı** (`scripts/launch.ts`): `npm run dev|start -- --llm --bridge --port --host --model --effort --claude-bin`.
- **Görünüm:** Z-yukarı tabla ızgarası (10/50 mm), eksen göstergesi, renkli parçalar, kenar çizgileri,
  isim etiketleri (aç/kapa), ölçü çizgileri + etiketleri (aç/kapa), tıklayarak seçim, görünüm ön ayarları
  (İzo/Üst/Ön/Sağ), sığdır.
- **Paneller:** parça listesi (renk, görünürlük, sil), özellik paneli (ad, renk, ölçüler, konum — Z taban,
  döndürme, boyut, hacim, yaklaşık PLA ağırlığı, tablaya indir/kopyala/gizle/sil), hızlı ekleme düğmeleri.
- **Durum:** tüm değişiklikler işlem (Op) olarak; geri al/yinele (200 adım); localStorage otomatik kayıt.
- **Dosya:** proje kaydet/aç (`.p3d.json`, doğrulama ve onarım ile); dışa aktarım: 3MF (renkli, parça başına
  nesne), STL (tümü / seçili), OBJ, OBJ+MTL (ZIP), her parça ayrı OBJ. Yalnızca görünür katılar; delikler uygulanmış.
- **Ayarlar:** tabla boyutu, yuvarlak yüzey çözünürlüğü (32–192 segment; ekran + dışa aktarım).
- **Sunucu:** Vite ara katmanı (geliştirme) ve `server/index.ts` (üretim) aynı `/api` işleyicisini kullanır.

## Doğrulama durumu

| Alan | Durum |
|---|---|
| Ayrıştırıcı + işlem motoru | ✅ 26 otomatik test (`tests/parser.test.ts`; delik/rol kalıpları dahil) |
| Serbest biçimler, delik, ağ G/Ç | ✅ 17 test (`tests/geom.test.ts`): analitik hacim (alan×uzunluk, Pappus, kesik piramit), kapalılık, x/y eksen yönelimi, doğrulama hataları, delik hacmi, gizli/rol, kesit, STL/3MF/OBJ okuma, sadeleştirme, dosyada ağ |
| Görüntü alma (`snapshot`) | ✅ Gerçek sekmede: iso/ön/üst/arka; delik kesimi üstten görüntüde doğrulandı |
| Claude yeni şema (`geom`, `role`) | ✅ `claude -p` ile: "ortasına 5 mm delik aç + vazo" → silindir `role: hole` + içi boş `revolve` profili (~10 sn). API anahtarıyla denenmedi |
| 3DBenchy kabul testi | ✅ Orijinal STL referans alınarak çizildi; kutu 60 × 31 × 48 (orijinal 60 × 31 × 48), birleşik hacim −%1,9; `check` temiz; tekne ağında <3° iğne üçgen 19/45 000. Son sürüm sahnede görüntülerle (izo/ön/yan/arka) doğrulandı |
| v0.3 özellikleri | ✅ 67 test (tekne şekli: kutu tablosu tam hacim, sıfır genişlikte kapanma, doğrulama; dışa aktarılan örnek tekne kapalı ağ dahil) (örtük yüzey küre hacmi, `sliceMany` = `sliceGeometry`, Regularize iğne üçgen <%1 dahil): yumuşak loft hacmi (daireye yakınsama), uç (koni ≈ πr²h/3), sharp (tam kutu), cuts, çerçeve (kapalı/açık alan), eğik yüzeye dik oturtma, birleşim hacmi, `check` çakışma bulur/temizde susar |
| OBJ çıktısı | ✅ Her şekil için kapalı/doğru yönlü ağ ve hacim ≈ analitik değer (`tests/io.test.ts`) |
| Proje kaydet/yükle | ✅ Gidiş-dönüş ve bozuk dosya onarımı testleri; `examples/` dosyaları onarımsız yüklenir |
| Arayüz | ✅ Chrome'da elle denendi: komutlar, panelden düzenleme, geri al, isim/ölçü anahtarları, dışa aktarma menüsü, otomatik kayıttan geri yükleme; konsolda hata yok |
| Claude isteği — `api` | ⚠️ Yalnızca **sahte (mock) API** ile doğrulandı: istek biçimi (model, `fallbacks`, beta başlığı, `output_config`, şema) ve yanıt işleme. **Gerçek API anahtarıyla hiç denenmedi.** |
| Claude isteği — `claude-cli` | ✅ Gerçek `claude -p` (Claude Code 2.1.312, Windows) ile `/api/nl` uçtan uca: "tabanın dört köşesine … ayaklar koy" → doğru 5 işlem, ~9,4 sn. Tarayıcı arayüzünden (Claude modu seçiciyle) denenmedi; giriş yapılmamış/`claude` bulunamadı hata mesajları denenmedi |
| Claude Code köprüsü | ✅ Gerçek tarayıcı sekmesiyle: `ops` (oluşturma, üstüne koyma, renk), hatalı işlem → çıkış kodu 1, `undo`, `scene`; `text/plain` ile yazma reddi; geçersiz girdi. Birden çok sekme davranışı denenmedi |
| Başlatıcı / ayarlar | ✅ `start --llm=api` anahtarsız → uyarı + Claude kapalı, köprü 404; `start --llm=claude-cli --bridge`; bilinmeyen parametre → kullanım metni; `dev:claude` |
| Dışa aktarılan dosyalar | ⚠️ İçerik testlerle doğrulandı (STL/3MF/OBJ okunup aynı üçgen sayısı); tarayıcıdan gerçek indirme ve dilimleyicide (PrusaSlicer/Cura/Bambu/Orca) açma **denenmedi** — özellikle 3MF renkleri |
| Arayüz (v0.2) | ⚠️ İçe aktar düğmesi, rol seçici, geometri JSON alanı, Delikler anahtarı, STL/3MF menüsü tarayıcıda **elle tıklanarak denenmedi** (Chrome eklentisi bağlı değildi); aynı işlemler köprüden denendi |
| Diğer tarayıcılar | ❔ Yalnızca Chrome denendi |
| Üretim sunucusu | ✅ `npm start` ile statik dosyalar, `/api/status`, dizin dışına çıkma engeli denendi |

## Bilinen sorunlar ve sınırlamalar

**Modelleme**
- Delik `cuts` verilmezse kutusu kesişen **tüm** görünür katıları keser. Kesişim (intersect) işlemi yok; birleşim
  yalnızca dışa aktarımda (Birleştir) — ekranda parçalar ayrı çizilir, örtüşen/çakışan yüzeyler `check` ile bulunur.
- Ekranda ve panelde toplam hacim parçaların toplamıdır (örtüşmeler iki kez sayılır); gerçek hacim için
  `p3d measure` → birleşik hacim.
- `check` çakışma testi düzlem kovası + üçgen örtüşmesiyle yaklaşıktır (alan tahmini kabadır); çok büyük ağlarda
  çift başına 200 bin üçgen karşılaştırmasıyla sınırlıdır.
- Kapalı olmayan (manifold olmayan) içe aktarılmış ağlar deliklerle kesilemez (uyarı verilir, ağ olduğu gibi kalır).
- Loft kesitlerinde nokta karşılığı kullanıcıya/yapay zekâya bağlı; farklı sayıda noktada otomatik hizalama basittir
  (alttaki nokta), bükülme olabilir. `smooth` olmadan yüzey kesitler arasında doğrusaldır.
- `place_on_surface` deliksiz yüzeye göre çalışır ve en yakın noktayı kaba kuvvetle arar (çok büyük ağlarda yavaş).
- Loft, ucunda sıfıra inen ya da topolojisi değişen gövdelerde (tekne başı/kıçı, küpeşte + kuyu) bozuk sonuç verir;
  bu gövdeler için `hull` şekli kullanılmalı.
- `hull` üretimi yaklaşık 2 sn sürer (tarayıcıda ana iş parçacığında; açılışta ve tablo değişince). Yüzeydeki yumuşak
  kırılımlar (ör. küpeşte altındaki dikey bant başlangıcı) hafif dalgalı çıkar; birkaç tek tük kısa kenar izi kalabilir.
- `hull` y'de simetrik ve x boyuncadır (eksen seçimi yok); istasyon kesitleri tek parça (iç boşluk tabloyla değil,
  ikinci bir `hull` delikle).
- Sahnede büyük referans ağ (ör. 80 bin üçgen) varken tarayıcının otomatik kayıt kotası (~5 MB) dolabilir; uygulama uyarır.
- Görünümde sürükleyerek taşıma/döndürme (gizmo) yok; konum komutla ya da panelden girilir.
- Parçalar birbirine bağlı değil: alttaki parça kalınlaşınca üstteki onunla yükselmez (iç içe girer);
  "X'i Y'nin üstüne koy" ile yeniden hizalanır. Gruplama yok.
- Keyfi kenar yuvarlatma, metin, vida dişi, ayna, dizi (array) yok (pah profilde çizilebilir).
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
- `claude-cli` her komutta yeni bir `claude` süreci açar (~10 sn); istek iptali yok, zaman aşımı 180 sn.
  Kullanıcının Claude Code kullanım sınırlarını paylaşır.
- Bağlam yalnızca son 6 komut metni + güncel sahne; çok turlu konuşma geçmişi tutulmaz.
- Maliyet/gecikme ayarı (effort) ölçülmedi; varsayılan `medium`.

**Claude Code köprüsü**
- Komutlar yalnızca **en son bağlanan** sekmeye gider; sahne de son bildiren sekmenindir. Kimlik doğrulama yok
  (yalnızca `application/json` zorunluluğu); ağa açık sunucuda açmayın.
- Sunucu yeniden başlayınca sekme otomatik yeniden bağlanır (EventSource), ama sahne bir değişiklik olana ya da
  bağlantı açılana kadar sunucuda yoktur (`scene` → 409).
- Sayfa, sunucu yeniden başlarken yüklenirse sekme bağlantısız kalır ve elle yenilemek gerekir. Bu, `vite.config.ts`
  sunucu dosyalarını içe aktardığı için her `server/`/`shared/` değişikliğinde oluyordu; artık API `ssrLoadModule` ile
  yükleniyor ve sunucu yeniden başlamıyor (yalnızca `vite.config.ts` değişirse başlar). `/api/status` ağ hatasında
  yeniden deneniyor.
- İçe aktarılan büyük ağ (≈1–2 MB base64) sahneyle birlikte sunucuya bir kez gönderilir; çok sayıda büyük ağda
  yavaşlayabilir.
- Windows'ta arka planda başlatılan `npm run dev` durdurulunca alt node süreci açık kalabilir (port meşgul).

**Uygulama**
- Geri-al geçmişi ve seçim sayfa yenilenince sıfırlanır (proje otomatik kayıttan gelir).
- Yoğun sahnelerde isim etiketleri üst üste binebilir.
- İstemci paketi ~910 kB + manifold.wasm 541 kB; kod bölme yapılmadı.
- Otomatik kayıt tarayıcı kotası (~5 MB) ile sınırlı; büyük içe aktarılmış ağlar sığmazsa uyarı verilir.
- Hacim/ağırlık %100 doluluk varsayar. Gizli parçalar dışa aktarılmaz.

## Yol haritası (öncelik sırasıyla)

1. **Dışa aktarım ve arayüz doğrulaması:** 3MF/STL'yi Bambu/Prusa/Orca'da açıp renk ve ölçek kontrolü;
   v0.2 arayüz öğelerini tarayıcıda elle deneme.
2. **Gruplama ve ekranda birleşim:** ebeveyn-çocuk (üstteki parça alttakini takip etsin); grup içi union'ı ekranda da
   gösterme (renkler orijinal parçalara göre: manifold `runOriginalID`); intersect.
3. **Yuvarlatma:** profil köşelerinde yarıçap (extrude/revolve noktasına `r`); gerekirse OpenCascade (replicad) ile
   gerçek kenar yuvarlatma ve STEP.
4. **Sürükleme gizmosu** (`TransformControls`), 1 mm / 15° yakalama; sürükleme bitince tek `Op`.
5. **Claude:** gerçek API anahtarıyla uçtan uca test, akış + ilerleme göstergesi, değerlendirme seti, effort/maliyet ayarı;
   `claude-cli` için kalıcı süreç (`--input-format stream-json`) ile gecikmeyi düşürme.
6. `hull` için arka planda (Web Worker) üretim, eksen seçimi; referanstan endaze tablosu çıkaran CLI komutu
   (`p3d lines`; şu an 3DBenchy için scratch betikle). Yeni şekiller: metin, vida dişi; hazır parçalar.
   Referanstan otomatik loft çıkarma aracı (`p3d lines`: istasyon kesitlerinden U/kapalı kesit üretimi; şu an
   3DBenchy için scratch betikle yapıldı).
7. Hizala/dağıt, ayna, dizi işlemleri ("4 köşeye yerleştir").
8. Geri-al geçmişini kalıcı tutma; birden çok proje listesi.
9. three.js için kod bölme.
