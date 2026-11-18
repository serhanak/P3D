# Proje durumu

> Son güncelleme: **2026-11-18** — GLB okuma (arayüzde Aç…/İçe aktar…, `p3d import`, `--file x.glb`), tel kafes / X-ışını
> görünümü (araç çubuğu + W, `snapshot --style wire|xray`), ortografik kamera (Orto düğmesi + O / Num 5, `snapshot --projection ortho`). Önceki: **2026-11-16** — BoltRush #22: `p3d <komut> --help` sunucu/sekme denetiminden önce yanıtlanır (komut başına
> yardım; `--views side` hatası left/right önerir). Önceki: **2026-11-15** — BoltRush #21: `--cull-hidden` birleşim çizgisi T-kavşağı onarımı (su geçirmez görünen yüzey) ve
> net kayıp kuralı (ayıklama üçgen sayısını hiç artırmaz). Önceki: **2026-11-15** — BoltRush #18–20: GLB gizli üçgen ayıklama (`--cull-hidden`), kaplama şekli `decal`,
> `snapshot` perspektif kamera (`eye` göz hizası, `--eye/--target/--fov`). Önceki: **2026-11-15** — `sweep` (yol boyunca süpürme,
> boru; BoltRush #14 / #16, [`SWEEP.md`](SWEEP.md) Faz 1). Önceki: **2026-11-14** — parça saydamlığı (`opacity`) ve parça başına çözünürlük (`resolution`), BoltRush istekleri
> #17 / #15; `sweep` tasarımı onaylandı ([`SWEEP.md`](SWEEP.md), #14 / #16). Önceki: **2026-11-13** — BoltRush istekleri #11–13: `solidBox`/`solidPartsBox` (delikler çıkarılmış kutu; `measure`
> kutusu da kesimli), `snapshot --size` sessiz kırpma yerine 4096'ya kadar orantılı oturtma + uyarı, prizma köşe fazı rehberde.
> Önceki: **2026-11-11** — loft: kesitte ardışık çakışık nokta (dejenere kenar) nokta eşleşmesini korur (BoltRush isteği #8:
> nokta atılınca kesitler yeniden örneklenip yüzey sessizce yanlış çıkıyordu). Önceki: **2026-11-09** — eskiz katmanı: kalem aracıyla ekranda çizerek niyet tarifi (`Project.sketch`, `sketch_*` işlemleri,
> `p3d sketch`, snapshot'ta görünür; eskiz → geometri dönüşümü bilinçli olarak yok). Önceki: **2026-11-07** — `hull` her boyutta üretiliyor (BoltRush raporu: 1 m'lik gövde WASM'ı çökertiyordu; ızgara
> bütçesi + sınır boşluğu), üretilemeyen geometri artık işlem hatası ve `check` hatası; `hull` için `geom.maxTris` üçgen
> bütçesi (oyun varlığı, BoltRush isteği #7). Önceki: **2026-11-02** — v0.4: başka projelerden kullanım ([`EXTERNAL-USE.md`](EXTERNAL-USE.md)): global `p3d`
> komutu, `/w/<ad>` çalışma alanları, tarayıcısız çekirdek (`src/api.ts`, `--file`, `apply`, `export`, `p3d run`,
> görünmez Chrome ile `snapshot --file`), kullanım rehberi (`docs/guide/`) + kullanıcı skill'i; oyun dışa aktarımı (GLB,
> gruplar/pivot, ayna, `count`, düşük poligon, `check --profile game`). Önceki: v0.3 (2026-10-29) `hull`, çerçeve,
> yüzeye oturtma, delik hedefi, birleştirme, `check`; 3DBenchy örneği.

## Yeni oturuma başlarken (ajanlar için)

1. `npm install` · `npm run typecheck` · `npm test` (409 test, ~50 sn) — hepsi temiz olmalı. Global komut ve skill için bir kez `npm link` + `p3d skill install`
   (README → Kurulum; `p3d status` kurulu skill eskiyse uyarır).
2. Modelleme/arayüz işi için: `npm run dev` (arka planda; Claude Code hesabıyla serbest komutlar için `npm run dev:claude`),
   kullanıcının tarayıcı sekmesi açık olmalı; `p3d status` / `p3d scene` ile bağlantıyı doğrulayın (409 = alanda bağlı sekme
   yok → kullanıcıdan F5 isteyin). Kullanıcı kök sekmede değişiklik yapılmasına izin verdi ve ilerlemeyi orada izlemeyi seviyor;
   deneme/test için kendi alanınızı (`--ws deneme`) ya da `--file` kullanın.
3. Doğrulama döngüsü: `snapshot --out <scratchpad>` (Read ile bakın) · `measure` (birleşik hacim) · `check` (z-fighting) ·
   `section`. Ayrıntı: `docs/guide/verify.md`, `docs/guide/modeling.md` (CLAUDE.md içe aktarır).
4. Örnekler uygulamanın kendi şekilleriyle kurulur, mesh gömülmez. 3DBenchy üreteci: `examples/tools/build-3dbenchy.ts`
   (referans STL indirme komutu dosyanın başında; repoya koymayın).
5. Hacimli işleri alt ajanlara devredin (`.claude/agents/`: p3d-measurer, p3d-implementer, p3d-verifier, p3d-reviewer;
   kurallar CLAUDE.md → "Alt ajanlar"). Sahneyi yalnızca ana oturum değiştirir.
6. Bu dosyayı iş bitince güncelleyin; commit mesajları kısa, Türkçe olabilir; `main` dalı, GitHub `serhanak/P3D` (özel). Bir işi bitiren ajan/geliştirici bu dosyayı güncellemelidir.

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
- **Büyük `hull` düzeltmesi (2026-11-07):** ızgara kenarı mutlak mm olduğundan nokta sayısı hacimle büyüyordu (60 mm 1,6 sn,
  240 mm 56 sn, 1 m'de "memory access out of bounds" + sonraki çağrılarda "null function or function signature mismatch";
  parça sessizce 5 mm küpe düşüyordu). Şimdi `HULL_MAX_CELLS` (2,5 milyon) aşılınca tablo küçültülüp üretilir, ağ geri
  büyütülür (60 mm–3 m arası ~1–4 sn). Ayrıca manifold 3.5 `levelSet`'in bir hatası bulundu: yüzey ızgara sınırına bir hücreden
  yakınken (eski pay 0,2 mm) bazı boyutlarda (ör. 60 × 31 × 27 kutu) WASM içinde çöküyor; sınır boşluğu iki hücreye çıkarıldı
  (`hullGap`), ızgara `LEVEL_SET_MAX_CELLS` (30 milyon) üstündeyse WASM'a verilmeden reddedilir. Benchy teknesi değişmedi
  (hacim 10,69 cm³ aynı, kutu farkı 0,04 mm). Üretilemeyen geometri: geom veren `create`/`update` hata döndürür (çekirdek
  hazırsa), `check` yer tutucuya düşen parçayı hata sayar.
- **`hull` üçgen bütçesi `geom.maxTris` (2026-11-07, BoltRush isteği #7):** varsayılan ağ çözünürlükten bağımsız ~30–60 bin
  üçgendi (2,2 m'lik gövde çözünürlük 12'de 34 bin, kesim çizgisinde iğne üçgenler). `maxTris` (100–1 000 000) verilince ağ
  bütçeyi aşmaz: gövde bütçenin iki katına sadeleştirilip profille kesilir, son ağ `RegularizeLight` ile bütçeye iner; ızgara
  da küçülür (`maxTris × 250` nokta, en az 250 bin → 2,2 m gövde 1000 üçgende 0,35 sn, 3,5 yerine). Muz gövdesi (BoltRush)
  1000 üçgende hacim farkı −%0,1, 200 üçgende −%1; Benchy teknesi 1000 üçgende −%0,2. Claude şeması/talimatı (0 = varsayılan),
  panel özeti, `check --profile game` bütçe uyarısı `maxTris`'i önerir. Varsayılan (alan yok) davranış değişmedi.
- **Eskiz katmanı (2026-11-09):** kullanıcı 3B görünümün üstüne kalem aracıyla (P) yollar çizerek yapılacak işi **tarif eder**;
  eskiz geometri üretmez, dışa aktarılmaz, `check`'e girmez. Düzlem görünümden seçilir (Üst → Z, Ön → Y, Sağ → X; seçili parçanın
  kameraya bakan yüzü ya da tabla), tıkla = köşe, sürükle = Bezier eğri, ilk noktaya tıkla = kapat; noktalar seçilip düzlemde ya da
  kilitli eksende (X/Y/Z, N = düzlem normali) sürüklenir, sayı + Enter mutlak değer verir (Shift+Enter göreli), Shift yakalar (1 mm,
  parça köşe/yüz merkezleri, eskiz noktaları), Ctrl+tık kenara nokta ekler. Yollar `Project.sketch`'te ("Yol N", `note`), her değişiklik
  Op (`sketch_add/update/move/delete`; yalnızca yerel/köprü, Claude şemasında yok; geri alınabilir), `SceneSummary.sketch` ile köprüye
  ve `/api/nl`'e gider (prompt'ta "Sketch" bölümü), `p3d snapshot` görüntüsüne WebGL sprite adlarıyla girer, `p3d sketch [--json]
  [--clear]` listeler/siler, `p3d scene` sonunda `eskiz (N)` satırları. Paneller: sol eskiz listesi, sağda ad/not/kapalı/düzlem/nokta
  tablosu. Kurallar: `sketch_update` tüm noktalar düzlem normalinde aynı konumdaysa `plane.at`'ı da taşır; kapalı yol en az 3 nokta ister
  (azsa açık kalır); dosyadaki bozuk eskiz yolu uyarıyla atlanır (parça kaybı sayılmaz, `export`/`apply`'ı durdurmaz); ~3°'den sığ
  açıyla düzleme tıklama yok sayılır. Rehber `p3d guide sketch`, skill güncellendi. Eskiz → geometri dönüşümü bilinçli olarak yok (yol haritası 10).
- **Oyun varlığı: gizli üçgen ayıklama, kaplama, göz hizası görüntü (2026-11-15, BoltRush istekleri #18 / #19 / #20):**
  - `export x.glb --cull-hidden` (`GlbOptions` / `ExportOptions.cullHidden`, `src/cull.ts`): kesin test — üçgen kenarlarından ε
    içeri küçültülüp normal boyunca ε (≥ 1e-3 mm, ölçekle büyür) dışarı itilir; ağırlık merkezi **aynı** başka kapalı, opak katının
    içindeyse (ışın paritesi) ve o katının hiçbir üçgeni küçültülmüş üçgeni kesmiyorsa (BVH + ayırıcı eksen) atılır. Kısmen örtülen
    üçgen kalır (bölme yok); sayısal belirsizlikte kalır. Saydam (`opacity` < 1) parça örtücü değildir (cam içindeki koltuk kalır).
    Gruplar/düğümler/iskelet aynı; tümü gizli parça ağsız düğüm. Yalnız GLB (STL/3MF/OBJ'de hata: baskı kapalı ağ ister).
    `check --profile game [--cull-hidden]`: ayrı uyarı yok (temiz model temiz kalır); `--cull-hidden` ile bütçe ayıklanmış sayıyla
    hesaplanır, verilmezse bütçe aşımı uyarısına "N üçgen görünmez; export --cull-hidden ile atılır" eklenir. 4 prizma yığını
    112 → 76 üçgen; ayıklama 800 parçalı yığında ~270 ms, Benchy'de ~590 ms (3 629 / 60 652 üçgen atılır).
  - **Birleşim çizgisi onarımı (#21):** atılan yüz, iki parçanın aynı düzlemdeki dış yüzleri arasındaki eşleşmeyen (T'li) birleşim
    çizgisini arkadan örtüyordu; atılınca tek piksellik çatlak görünüyordu (Boltrush: 172 pist nesnesinin 9'u, 215 parçanın 10'u).
    Şimdi atılan üçgenlerin köşeleri T noktası adayıdır; adayın kalan bir kenarıyla aynı doğrudaki kalan kenarlar (yalnız çatlak
    yapanlar) o noktada bölünür (geometrik eşleşme, iki yan, sarım ve normal korunur, köşe float32 dünya değeriyle). **Net kayıp
    kuralı:** bir parçanın atılanlarının doğurduğu bölmeler atılanlara eşit ya da fazlaysa o parçanın atılanları geri konur
    (farklı kalınlıkta üst üste iki kutu: seçeneksizle bayt bayt aynı). Benchy 3 629 atılır / 5 eklenir; GLB süresi +~0,3 sn.
  - Yeni şekil `decal` (Kaplama): `geom {profile, holes?, double?, lift?}` kalınlıksız düz çokgen, yerel +Z'ye bakar, `lift`
    (varsayılan 0,5 mm; 0/null = varsayılan) kadar ayrık; `double` → GLB `doubleSided` (üçgen çoğaltılmaz). `place_on_surface` ile
    yüzeye oturur (`place_on` lift'i hesaba katar). Hacmi 0, delik olamaz/kesilmez, STL/3MF/Birleştir'e girmez (uyarıyla), GLB/OBJ'ye
    girer, ayıklamaya girmez; `check`'te kaplama–katı z-fighting yalnız < 1e-3 mm; `section`/`measure` varsayılan kümesinde atlanır;
    aşağı bakan kaplamada `place_on` hata verir. Boltrush bayrağı (4000 × 50 × 1200 + 2 × 16 dama): 192 → 76 üçgen. Görünümde
    `polygonOffset`. Kararlı API'ye `printableParts`, `isDecal` (yalnız ekleme); `exportableParts` kaplamaları da içerir (GLB/OBJ,
    açık ağ) — kaplamasız projede sonuç aynı; `mergedMesh` kaplamaları atlar. Claude şeması + talimatı, rehber (modeling/game/ops/scripts).
  - `snapshot` perspektif: `--views eye` göz hizası (görünür kutunun tabanından `--eye-height`, varsayılan 1000 mm; ön sağdan; kutu
    sığacak uzaklıktan merkeze), `--eye x,y,z [--target x,y,z] [--fov 50]` serbest kamera (`camera.png`); `--eye`/`--eye-height`
    verilip `--views` verilmezse yalnız o görüntü; varsayılan göz yüksekliği küçük sahnede kutu yarıçapının iki katıyla sınırlı;
    yakın düzlem göz sahnenin içindeyken sahne ölçeğinden (kart gözü önündeki nesneler kesilmez). Geçersiz değerler tarayıcı
    açılmadan hata. (İstek 9'un arka çapraz görünüşü de `--eye` ile alınabilir.)
- **`sweep` — yol boyunca süpürme (2026-11-15, BoltRush istekleri #14 / #16; tasarım [`SWEEP.md`](SWEEP.md) Faz 1):** yeni geom
  şekli (`Süpürme`). `path` [x,y,z(,r)], `closed`, `bend` (köşe yayı; 0 = gönye), kesit `profile`/`holes` ya da `diameter`/
  `innerDiameter` (boru), `up` (varsayılan +Z), `frame` `up`/`rmf`. Kararlar: varsayılan `up`, yuvarlak kesitte kendiliğinden `rmf`
  (yuvarlak olmayan kesitte düşey bölüm hatası); sığmayan köşe yarıçapı hata (sığan en büyüğü söyler). Açık yolun uçları yola dik ve
  düz: aynı kesitli parçalar uç uca dikişsiz eklenir (`rmf`'de son uç da `up`'a hizalanır, fark yaylara dağıtılır). Doğrulama:
  katlanma (yayda ve gönyede), ≥ 150° gönye, kendini kesen kesit, profil + çap, sınırlar (yol/kesit ≤ 1024 nokta, ağ ≤ 1 milyon köşe).
  Ayna birebir (u = −u, ters sıra; yan dörtgenler kısa köşegenden). Çözünürlük yalnızca yuvarlak kesit ya da yaylı köşe varken
  kullanılır (kenar sayısı = kiriş/tam daire). Claude şeması + talimatı, rehber (modeling/ops/game), skill tek satır. Boltrush'ın
  Retro boru tamponu tek parça: çözünürlük 10'da 196, 16'da 380 üçgen (bugün 11 prizma × 40 = 440 + bindirme + 0,4 mm çap hilesi).
  Eskizden süpürme (Faz 2, kopya) yapılmadı. İnceleme sonrası kurallar: `up` çerçevesinde halkalar arası burulma > 45° hata
  (`bend` ya da `frame: "rmf"` önerir); baştan sona `up` yönündeki yolda yuvarlak olmayan kesit `up` ister; doğrusal ara noktalar
  yay/katlanma denetiminde kenar zincirine katılır; değerler ±1 000 000 mm; yol × kesit > 1 milyon köşe doğrulamada reddedilir;
  boşluklar profilin içinde ve ayrık olmalı; noktadaki 4. değer yalnızca > 0 iken `bend`'i ezer.
  - Uç kapağı: earcut doğrusal köşeleri atınca T-kavşağı (kapalı olmayan ağ) kalıyordu; içi boş yuvarlak boruda kapak artık iki
    halka arası şerit, genel profilde `fixTJunctions` (yalnızca eşsiz kenar varsa devreye girer). Aynı onarım `extrude`'a da
    uygulandı (hizalı boşluklu extrude da bozuktu); sağlam extrude/revolve/loft ağları bayt bayt aynı (96 ağ karşılaştırıldı).
- **Parça saydamlığı ve parça çözünürlüğü (2026-11-14, BoltRush istekleri #17 / #15):**
  - `Part.opacity` (0–1): `create`/`update` alanı (grupta da), panelde Opaklık, yerel ayrıştırıcı ("yarı saydam yap", "%30 saydam",
    "camı 30 saydam yap", "opak yap"; saydamlık = 1 − opaklık; sonuç 0 olacaksa hata → "gizle"). Yalnızca görsel: dışa aktarım,
    hacim, `check`, delik değişmez. Görünen değer rol varsayılanının (referans 0,35, delik 0,3) yerine geçer; katıda 1 alanı siler,
    referans/delikte 1 açık değerdir (opak referans). GLB alfa + `BLEND` (malzeme renk + saydamlığa göre), 3MF `#RRGGBBAA`, MTL `d`.
    Claude yolunda `opacity: 0` "verilmedi" sayılır (şema boş sayıyı 0 ile doldurabiliyor). Saydamlığı 0 olan parça seçimde atlanır.
  - `Part.resolution` (6–192): silindir, boru, koni, küre, torus, revolve ve yumuşak loft'ta proje çözünürlüğünün yerine geçer
    (`shapes.partSeg`; kutu, hacim, önbellek anahtarları, delik kesimi, `check`, `place_on_surface`, görünüm). Başka şekillerde
    (kutu, prizma, extrude, hull, mesh, yumuşak olmayan loft) hata değil uyarı + yok sayma (Claude "hepsini low-poly yap" derken parça
    kaybolmasın); dosyadan gelirse uyarıyla kaldırılır. Grupta verilemez (0/null yok sayılır). Küre enlemi segmentten türer
    (6 → 36, 8 → 48 üçgen; ayrı parametre yok). `check --profile game` bütçe aşımında büyük yuvarlak parçalara `resolution` önerir.
  - `update` artık tüm alanları uygulamadan önce doğrular: hatalı alan parçada yarım değişiklik bırakmaz (`cuts` dahil).
  - Sekmeden gelen sahnede onarım uyarıları CLI'de stdout'a basılır (eskiden stderr).
- **Kesimli kutu, snapshot boyutu, prizma fazı (2026-11-13, BoltRush istekleri #11–13):**
  - `partBox`/`partsBox` şeklin **kesimsiz** kutusudur (sözleşme; yerleştirme işlemleri, delik eşleştirmesi, sahne `bbox`'ı onu
    kullanır) ama bu belgelenmemişti; betikler kesilen parçada yanlış sınır yazıyordu. Kararlı yüzeye `solidBox(project, part)` /
    `solidPartsBox(project, parts)` eklendi (`src/model.ts`): dışa aktarılan / `worldMesh` ağının kutusu; kesen delik yoksa `partBox`,
    delik tümünü keserse boş kutu; konum+döndürme+`solidKey` ile önbellekli. `p3d measure` parça ve TOPLAM kutusunu artık bununla
    yazar (hacimle aynı geometri). `scene` bbox'ı değişmedi (rehberde "kesimsiz" diye yazıldı).
  - `snapshot --size` her kenarı ayrı ayrı sessizce 2400'e kırpıyordu (3200x640 → 2400x640). Şimdi `fitSnapshotSize` (`shared/ops.ts`,
    köprü ve CLI ortak): kenar 200–4096 piksel, uzun kenar aşarsa iki kenar orantılı küçültülür; CLI değişiklikte `uyarı:` basar,
    PNG başlığı istenenden farklıysa (tarayıcı tuvali küçültürse) uyarır, geçersiz `--size` ve bilinmeyen `--views` adı tarayıcı
    açılmadan hata verir (eskiden görünüm adı sessizce atılıyordu). Yol satırları değişmedi.
  - Prizma köşe fazı `docs/guide/modeling.md`'de (düz kenar yerel −Y; `x: 90` her n'de düz taban; `y: 90` yalnız n 4'ün katıysa,
    değilse `rotation.z = 90 mod (360/n)`; genel kural). Yeni `phase` parametresi eklenmedi: `rotation.z` (XYZ Euler'de önce,
    parçanın kendi ekseninde) aynı işi görür. Claude talimatındaki prizma satırına kısa not.
- **Loft çakışık nokta (2026-11-11, BoltRush isteği #8):** `cleanLoop` ardışık çakışık noktaları attığı için 8 noktalı kesit 6'ya
  düşüyor, sayılar farklı göründüğünden kesitler yay uzunluğuyla yeniden örneklenip indis eşleşmesi kayıyordu (hata/uyarı yok; örnekte
  hacim 498 yerine 533,3 cm³). Şimdi loft kesitleri birlikte temizlenir (`loftLoops`): kapanış tekrarı atılmış → hiç atılmamış →
  tümü atılmış biçimlerden nokta sayılarını eşit tutan (ve 1024'ü aşmayan) ilki seçilir; atılan kapanış noktasına verilen `sharp`
  indisi 0'a eşlenir (aynada 0–1 çakışık çifti sona geçer); çakışık noktalar ağda tek köşedir (`repeatGroups`: yan dörtgen
  üçgene iner, kapak tekil noktalarla, ağ kapalı, bozuk üçgen yok), yumuşatmada teğetler tekil noktalardan hesaplanır (yüzey
  değişmez). Çakışık nokta içermeyen loft'larda ağ bayt bayt aynı; ilk noktayı sonda tekrarlayan kesitler eskisi gibi kırpılır.
- **Örtük yüzey ve ölçüm yardımcıları** (`csg.ts`): `levelSetGeometry` (sdf → kapalı ağ, isteğe bağlı manifold
  sadeleştirme), `sliceMany` (bir ağda çok kesit, tek dönüşüm). İçe aktarma sadeleştirmesi `Regularize` ile.
  Testler her örneğin onarımsız yüklendiğini ve kapalı ağ olarak dışa aktarıldığını doğrular.
- **Başlatıcı** (`scripts/launch.ts`): `npm run dev|start -- --llm --bridge --port --host --model --effort --claude-bin`.
- **GLB okuma ve tel kafes görünümü (2026-11-18):**
  - GLB okuma (`src/meshio.ts`, bağımlılıksız, eşzamanlı): düğüm ağacı (matrix/TRS), ayna dönüşümünde sarım çevirme, strip/fan,
    `byteStride`, u8/u16/u32 indis, normalize tamsayı, `data:` URI, skin (Σ w · eklem dünyası · ters bağlama · v; P3D `--skeleton`
    çıktısı doğru yerde). Eksen/birim `gltf.ts`'in tersi (glTF (X, Y, Z) → P3D (X, −Z, Y) × 1000; `asset.extras.units` 'mm' ise × 1).
    Tüm ilkeller tek mesh parçasında birleşir (STL/OBJ/3MF gibi; `geom.src` ile yeniden üretim aynı, proje biçimi değişmedi). GLB'de
    varsayılan sadeleştirme sınırı 1 000 000 üçgen (`defaultMaxTris`; topoloji görülsün diye), diğer biçimler 60 000.
    `EXT_mesh_gpu_instancing` uygulanır (örnek başına kopya, aynalı örnekte sarım çevrilir; skin ile birlikte desteklenmez).
    Desteklenmeyen (açık hata, sessiz kayıp yok): `.gltf`, Draco/meshopt (zorunlu, kullanılan, ilkel ya da bufferView düzeyinde),
    zorunlu `KHR_mesh_quantization`, seyrek erişimci, harici tampon. Bozuk dosya (taşan/şişirilmiş erişimci, düğüm döngüsü, eksik ters
    bağlama matrisi, eklem indisi dışarıda) "GLB bozuk" hatası verir.
  - Arayüz: **İçe aktar…** GLB'yi parça olarak ekler; **Aç…** bir `.glb`'den yeni proje kurar (tek ağ parçası dosyadaki yerinde, tabla
    sığacak kadar büyür, dosyaya bağlı değil). `.mts` arayüzden açılmaz (bilinçli: Node betiği; `p3d run` + `p3d open`).
  - CLI: `scene/snapshot/measure/check/section/sketch --file x.glb|stl|obj|3mf` bellekte tek parçalı proje kurar; yazan komutlar
    (`apply`, `export`, `sketch --clear`) ağ dosyasını reddeder; `scene --full` ağ dosyasında `src`'yi mutlak yazar. `p3d import x.glb`. Kararlı API'ye `defaultMaxTris`, `projectFromMesh`,
    `loadMeshFileProject` (yalnız ekleme).
  - Görünüm biçimi Gölgeli / Tel kafes / X-ışını: araç çubuğu düğmeleri (etiket "Tel"; dar ekranda araç çubuğu sığsın diye) ve **W**.
    Yalnızca bellekte (`Project.view`'a girmez). Tel kafes: dolgu + her üçgen kenarı, arkadakiler gizli; X-ışını: dolgu soluk, tüm
    kenarlar parça renginde. `WireframeGeometry` tembel, `geomKey` ile önbellekli, Gölgeli'ye dönüşte bırakılır; görünür üçgen ≥ 500 bin
    ise günlükte bir kez yavaşlık uyarısı. `snapshot --style shaded|wire|xray` arayüzdeki biçimden bağımsız (`finally`'de geri
    yüklenir); verilmezse eski görüntü bayt bayt aynı. `p3d-reviewer` incelemesi (kritik/yüksek yok; 2 orta, 6 düşük) düzeltildi.
  - Ortografik kamera: görünüm grubunda **Orto** aç/kapa (`O` / `Num 5`; metin alanında, basılı tutma tekrarında ve kalem aracında
    çizim/sürükleme sürerken tetiklenmez; eksen kilidi açıkken Num 5 sayı girişine gider). Perspektif ve orto kamera birlikte tutulur,
    yalnızca bellekte; geçişte hedef, bakış yönü ve hedefteki görünür ölçek korunur. Kamera matematiği DOM'suz `src/camera-math.ts`'te
    (`orthoHeightFor`, `perspDistanceFor`, `viewLimits`, `orthoDepth`, `orthoFrameCamera`): yakınlaştırma sahne yarıçapına göre
    sınırlı (görünür yükseklik r·5e-4 … r·20), ortoda kamera her karede sahne küresinin (tabla + parçalar + eskiz + kalem yardımcıları)
    dışında durur; derinlik doğrusal, 20 m tablada titreme yok. Seçim ışını, kalem aracı, etiketler, sığdırma ve yeniden boyutlanma iki tipte de çalışır. 1600 px altında
    araç çubuğu düğme dolgusu küçülür (en dar ~1506 px). `snapshot --projection ortho`: `iso` ve `camera` orto (dik görünümler zaten
    orto; `camera`'da `--target` yalnızca yön verir, çerçeve görünür kutuya oturur); `eye` perspektiftir, `ortho` + eye/
    `--eye-height`/`--fov` tarayıcı açılmadan, köprüye doğrudan gelirse 400 hata; verilmezse görüntü bayt bayt aynı. `p3d-reviewer`
    incelemesi (kritik/yüksek yok; 3 orta, 4 düşük) düzeltildi.
- **Komut yardımı (2026-11-16, BoltRush isteği #22):** `p3d <komut> --help` / `-h` / `p3d help <komut>` sunucu, sekme ve çalışma
  alanı denetiminden önce yanıtlanır (eskiden `snapshot --help` sekme yokken "bağlı sekme yok" hatası veriyordu): kullanım metninden o
  komutun satırları + rehber konusu (snapshot'ta görünüm listesi, dev'de başlatıcı bayrakları); bayrak değeri olan `--help` ve `run`'da
  betikten sonraki `--help` yardım sayılmaz; `p3d --help` artık çıkış 0. `--views side` hatası "left ya da right" önerir.
- **Global `p3d` komutu** (`bin/p3d.mjs`, depoda bir kez `npm link`): her klasörden; `p3d dev` sunucuyu her klasörden
  başlatır; `p3d skill install` skill'e bu makinedeki depo yolunu yazar (kaynakta `{{P3D_DIR}}`), `status` eskiyse uyarır; göreli yollar komutun yazıldığı
  klasöre göre (`npm run p3d` altında `INIT_CWD`). Tam komut listesi: `docs/guide/cli.md`.
- **Çalışma alanları (v0.4):** `/w/<ad>`; komut ve sahne alanın en son bağlanan sekmesinden (sekme kimliği, PUT `seq`,
  `rev`); bağlı sekme yoksa 409. Kök localStorage'da (anahtarlar aynı), alanlar IndexedDB'de; okunamayan/parça düşen kayıt
  yedeğe alınır; aynı alan ikinci sekmede salt okunur. Alan seçimi `--ws` > `P3D_WS` > `p3d.json` > kök; P3D dışından alan seçilmeden sahneyi değiştiren komutlar köke gitmez (`--ws ""` gerekir). `status`, `view`,
  `open` (geri alınabilir, kaydedilmemiş işi korur), `save` (atomik; başka dosyaya bağlı/boş sekme/P3D olmayan dosya
  korumaları, içerik özetiyle "kaydedildi"). Sekmede `<alan> · <dosya> ●` rozeti.
- **Tarayıcısız çekirdek (v0.4):** `src/api.ts` kararlı yüzey (`package.json` exports) + `src/files.ts`
  (`loadProjectFile`, `saveProjectFile`, `exportFile`); `p3d run <betik>` (`import … from 'p3d'` kurulumsuz);
  `scene|check|measure|section|export --file m.p3d.json`; `apply --file` (hata varsa yazmaz, `--dry-run`, `--new`);
  `export .stl/.3mf/.obj/.glb`; içe aktarılan ağ yolla anılır (`geom.src`; kaydederken gömülmez, `--embed`);
  `snapshot --file` görünmez Chrome/Edge ile (~8 sn).
- **Oyun dışa aktarımı (v0.4):** GLB (`src/gltf.ts`; Y-yukarı/metre, düz/yumuşak normal, sRGB→lineer malzeme, grup
  düğümleri, `--skeleton` ile Unreal Chaos için katı iskelet, ASCII kemik adları); gruplar + pivot (`group`, `ungroup`,
  `set_pivot`; move/rotate/duplicate/mirror/delete grup adıyla); `mirror` (her şekilde geometri yansır; loft birebir);
  `duplicate.count` (dizi); çözünürlük alt sınırı 6; `check --profile game` (üçgen bütçesi, bozuk üçgen).
- **Kullanım rehberi + skill (v0.4):** `docs/guide/` (index, cli, ops, modeling, verify, ambiguity, workspaces, scripts,
  game) tek kaynak; `p3d guide [konu]`; kullanıcı skill'i `tools/skill/p3d/SKILL.md` → `p3d skill install`
  (`~/.claude/skills/p3d`); belirsizlik protokolü (`ask-critical` / `assume` / `ask-all`, `p3d.json` → `onAmbiguity`).
- **VibroBal geçişi:** `VibroBal/enclosure/build.mts` artık `import … from 'p3d'` ve kendi klasöründen
  `p3d run build.mts canta-v2`; çıktılar eskisiyle bayt bayt aynı (yalnızca rastgele kimlikler farklı).
- **Görünüm:** Z-yukarı tabla ızgarası (10/50 mm), eksen göstergesi, renkli parçalar, kenar çizgileri,
  isim etiketleri (aç/kapa), ölçü çizgileri + etiketleri (aç/kapa), tıklayarak seçim, görünüm ön ayarları
  (İzo/Üst/Ön/Sağ), sığdır.
- **Paneller:** parça listesi (renk, görünürlük, sil), özellik paneli (ad, renk, ölçüler, konum — Z taban,
  döndürme, boyut, hacim, yaklaşık PLA ağırlığı, tablaya indir/kopyala/gizle/sil), hızlı ekleme düğmeleri.
- **Durum:** tüm değişiklikler işlem (Op) olarak; geri al/yinele (200 adım); localStorage otomatik kayıt.
- **Dosya:** proje kaydet/aç (`.p3d.json`, doğrulama ve onarım ile); dışa aktarım: 3MF (renkli, parça başına
  nesne), STL (tümü / seçili), OBJ, OBJ+MTL (ZIP), her parça ayrı OBJ. Yalnızca görünür katılar; delikler uygulanmış.
- **Ayarlar:** tabla boyutu (20–20 000 mm; 2 m üstünde ızgara 100/500 mm, oyun ölçeği için), yuvarlak yüzey çözünürlüğü (6–192 segment; ekran + dışa aktarım).
- **Sunucu:** Vite ara katmanı (geliştirme) ve `server/index.ts` (üretim) aynı `/api` işleyicisini kullanır.

## Doğrulama durumu

| Alan | Durum |
|---|---|
| Ayrıştırıcı + işlem motoru | ✅ 26 otomatik test (`tests/parser.test.ts`; delik/rol kalıpları dahil) |
| Serbest biçimler, delik, ağ G/Ç | ✅ 17 test (`tests/geom.test.ts`): analitik hacim (alan×uzunluk, Pappus, kesik piramit), kapalılık, x/y eksen yönelimi, doğrulama hataları, delik hacmi, gizli/rol, kesit, STL/3MF/OBJ okuma, sadeleştirme, dosyada ağ |
| Görüntü alma (`snapshot`) | ✅ Gerçek sekmede: iso/ön/üst/arka; delik kesimi üstten görüntüde doğrulandı |
| Claude yeni şema (`geom`, `role`) | ✅ `claude -p` ile: "ortasına 5 mm delik aç + vazo" → silindir `role: hole` + içi boş `revolve` profili (~10 sn). API anahtarıyla denenmedi |
| 3DBenchy kabul testi | ✅ Orijinal STL referans alınarak çizildi; kutu 60 × 31 × 48 (orijinal 60 × 31 × 48), birleşik hacim −%1,9; `check` temiz; tekne ağında <3° iğne üçgen 19/45 000. Son sürüm sahnede görüntülerle (izo/ön/yan/arka) doğrulandı |
| Büyük `hull` | ✅ 3 test (`tests/geom.test.ts`: 1 m kutu tablosu tam hacim + `check` temiz, 10 kat eğri tablo = ölçekli kopya, ızgara sınırı WASM'ı bozmadan reddeder). Elle: kutu/eğri tablo 20 mm–3 m, çözünürlük 12/96/192, her biri ayrı süreçte temiz; BoltRush'ın birebir tekrarı (`p3d apply --new` → `scene` → `check`) doğru kutu; 1 m gövdenin görüntüsü tabloya uyuyor. Tarayıcı sekmesinde büyük gövde **denenmedi** |
| `hull` `maxTris` | ✅ 2 test (`tests/geom.test.ts`: 2,2 m muz gövdesi 1000/4000/200 üçgende bütçe aşılmaz, hacim farkı < %1 / %3, kutu doğru, bozuk üçgen yok; doğrulama: aralık dışı hata, 0/null varsayılan, kesir yuvarlanır). Elle: muz/kutu/Benchy 100–5000 üçgen, çözünürlük 12/96; `p3d apply --new` + `check --profile game` temiz; görünmez Chrome görüntüsünde 2000/500 üçgenlik gövdeler tabloya uyuyor. Gerçek Claude ile ve Unreal'de **denenmedi** |
| Eskiz katmanı | ✅ 31 test (`tests/sketch.test.ts`: Op'lar, özet, Bezier örnekleme, dosya gidiş-dönüş, Store seçimi; `tests/sketch-edit.test.ts`: ışın–düzlem, eksen kilidi, yakalama, tutamaç, kenar bölme; `cli.test.ts`: `p3d sketch`). Görünmez Chrome + CDP duman testi, gerçek fare/klavye (kare çiz/kapat, eğri nokta, Z kilidi + "15" Enter, çoklu seçim N kilidi, Ctrl+tık nokta ekle, Delete, Esc zinciri; konsol temiz; düzeltmelerden sonra tekrarlandı); `snapshot --file` izo/üst görüntüde yollar, ok, işaret ve adlar; `p3d-reviewer` incelemesi (10 bulgu, kritik yok) düzeltildi. Kullanıcının gerçek sekmesinde elle ve gerçek Claude ile eskiz yorumu **denenmedi** |
| Gizli üçgen ayıklama / kaplama / perspektif görüntü | ✅ `tests/cull.test.ts` (12: 4 prizma 112 → 76, kutu üstünde kutu, gömülü pim, ayrık/kısmi örtü kalır, saydam örtücü atmaz, plaka + delik + kapak (deliğin üstündeki üçgen kalır), grup/iskelet yapısı, seçenek yokken GLB aynı, STL hatası, check bütçe notu), `tests/decal.test.ts` (18: ağ, normal, yüzeye oturtma, doubleSided, baskı biçimlerinde atlama, hacim 0, check, çakışan kaplama, ayıklamayla etkileşim, dosya, ayna, delik rolü hatası, Claude şeması), köprü/CLI kamera testleri. Seçenek verilmeden Benchy ve karışık sahnede GLB/STL/3MF/OBJ/birleşik STL/hacim/check bayt bayt aynı. Benchy'de ayıklanan 3 629 üçgenin yalnız iç yüzler olduğu ve ayıklanmış GLB'de görünür yüz kaybı olmadığı görüntüyle denetlendi; `p3d-reviewer` incelemesi (kritik yok; 2 orta — saydam örtücü, örnekleme — ve 7 düşük bulgu düzeltildi); dama bayrağı iki yüzde titremesiz; `eye`/`camera` görüntüleri oyun ölçeğinde doğru. Unreal içe aktarımı, glTF Validator, gerçek Claude ve arayüzde elle **denenmedi** |
| Birleşim çizgisi onarımı (#21) | ✅ `tests/cull.test.ts` (5 sahne: iki kutu, ters, yan yana, çerçeve + levha, köşegen; dünya, GLB düz/yumuşak, iskelet; çatlak yapan T-kavşağı 0, bit eşliği, normaller, net kayıp kuralı, hiçbir sahnede toplam > seçeneksiz). Elle: iki kutu seçeneksizle bayt bayt aynı, 4 prizma 112 → 76 (eklenen 0), Benchy 3 629 / 5. Boltrush `glbcmp` (Godot, 626 görünüş): onarımdan önce iki kutu 17, ters 13, yan yana 7 iç delik → onarımla iç delik 0 (kalan 1–8 piksel siluet kenarında alt piksel yuvarlama; net kayıp kuralıyla bu üç sahne artık hiç ayıklanmıyor). **BoltRush doğruladı (0d7376a):** seçeneksiz 172 pist nesnesi + 432 parça dosyası bayt bayt aynı; ayıklamayla pist nesneleri 49 687 → 42 690 (−%14,1), parçalar 298 446 → 267 709 (−%10,3), LOD1 68 076 → 59 443 üçgen, `check` temiz; `glbcmp` (176 yön) iki kütüphanede iç delik 0 (yalnız 2 siluet pikseli), önceki 19 sorunlu varlık temiz; 12 RC3'te GPU kare süresi p50 4,26 → 4,11 ms |
| `sweep` | ✅ `tests/sweep.test.ts` (29 test; 9'u inceleme düzeltmelerinin kırılan testleri) + `game.test.ts` (3 sweep parçası × 2 dönüş × 3 düzlem birebir ayna) + `cli.test.ts`: düz yol = extrude hacmi; gönyeli L/Z yol = alan × orta çizgi (1e-6); kapalı daire yol Pappus (kiriş düzeltmeli); 3B rmf/up/kemer kapalı manifold; hata mesajları (sığmayan yarıçap "en fazla", katlanma, 150° gönye, biçim); dikiş indisi 6–24 segment; uç uca dikişsiz; çözünürlük 8 → 76, 32 → 700 üçgen; GLB, `check --profile game`, dosya gidiş-dönüşü, Claude şeması null/0 doldurmaları. Elle: `apply --new` + `scene` + `check` + `measure` + STL/GLB/3MF; görünmez Chrome görüntülerinde pahlı tampon halkası, içi boş 3B boru, düşey kemer, gönyeli çerçeve, Retro tamponu doğru. `p3d-reviewer` (~1500 rastgele süpürme; 1 yüksek: kapak T-kavşağı, 3 orta, 5 düşük) düzeltildi; Ø6/Ø3 boru, delikle kesilmiş yaylı boru ve iki boşluklu profil `check` (print/game) temiz. Gerçek Claude ile, kullanıcının sekmesinde panelden ve Unreal'de **denenmedi**. **BoltRush doğruladı (568f464):** sweep kullanan 4 pist nesnesinin GLB'leri bayt bayt aynı, 215 parça + 172 pist nesnesi yeniden üretildi (geometri aynı, `check --profile game` temiz), Retro boru tamponları tek sweep'e geçti (4 parçada 2572 → 2004 üçgen, 0,4 mm çap hilesi kalktı) |
| Parça saydamlığı / çözünürlüğü | ✅ `tests/part-look.test.ts` + ayrıştırıcı/CLI/köprü testleri (toplam 33 yeni): Op'lar, aralık ve tip hataları, grup, `normalizeLlmOp`, rol varsayılanı ve opak referans, dosya gidiş-dönüşü ve onarım uyarıları, GLB alfa/BLEND (iskelet dahil), 3MF/MTL alfa, opacity 0'da dışa aktarım/hacim/check/delik aynı; analitik üçgen sayıları, 6 segmentte kapalılık, önbellek ayrımı, delikte etkin seg, yuvarlak olmayan şekilde uyarı, `update` atomikliği. Alan yokken STL/GLB/OBJ çıktısı HEAD ile bayt bayt aynı (9 dosya). `p3d-reviewer` incelemesi (kritik yok; 6 bulgu düzeltildi). Görünmez Chrome görüntüsünde cam yarı saydam, 8/96 segment küre, 6 segment torus doğru. Panel alanları ve saydam parçada tıklama gerçek tarayıcıda elle, yeni alanlar gerçek Claude ile ve Unreal'de **denenmedi** |
| Kesimli kutu / snapshot boyutu / prizma fazı | ✅ 5 test (`tests/geom.test.ts`: BoltRush örneği `partsBox` 50 / `solidPartsBox` 0 = `worldMesh`, döndürülmüş + taşınmış parça (önbellek), deliksiz = `partBox`, tümüyle kesilen = boş; prizma n = 3–16 için rehberdeki üç kural ve BoltRush ölçümleri; `tests/bridge.test.ts`: `fitSnapshotSize` ve köprünün sekmeye ilettiği boyut; `tests/cli.test.ts`: geçersiz `--size` / görünüm). Elle: `p3d run` ile BoltRush yeniden üretimi, `measure --file` kesimli kutu, görünmez Chrome'da 4096x800 ve 6000x6000 → 4096x4096 PNG (başlık doğrulandı), altıgen prizma `y 90, z 30` önden düz tabanlı. Kullanıcının gerçek sekmesinde (donanım GPU) 4096 görüntü **denenmedi** |
| Loft çakışık nokta | ✅ 4 test (`tests/geom.test.ts`: BoltRush örneği tam hacim 533,33 cm³ + `check --profile game` temiz + ayna; kapanış tekrarı / kapanışta ve başta dejenere kenar (prizmatoid tam hacmi 750) / eşleşmeyi bozan tekrar / 1024 sınırı; uç kesit, 3 kesitte kısmi çakışma düz ve yumuşak, ayna + `sharp`; yumuşak loft'ta çakışık nokta hacmi değiştirmez), düzeltme olmadan kırılıyorlar. Çakışık noktasız 8 tip loft'un ağı HEAD ile bayt bayt aynı; `p3d-reviewer` 120 rastgele loft'ta fark bulmadı, 3 bulgusu (ayna + sharp, 1024 sınırı, test kapsamı) düzeltildi. Elle: `p3d apply --new` + `measure` + `check` (düz ve yumuşak, 3 kesit), görünmez Chrome görüntüsünde çıkıntı ön kesitte kenardan doğuyor |
| GLB okuma / tel kafes | ✅ `tests/glb-read.test.ts` (30; bozuk dosya, sıkıştırma reddi, skin + ayna, örnekleme gidiş-dönüşü dahil; 4 sahne × 4 GLB çeşidi (varsayılan, mm, yumuşak normal, iskelet) gidiş-dönüşte üçgen kümesi dünya ağıyla aynı (1e-3 mm, sarım), `cullHidden`, el yapımı GLB'ler (strip/fan, stride, ofset, TRS/matrix, negatif ölçek, data: URI, skin), hata durumları, tabla büyümesi, kaydet → aç) + CLI (`scene/measure/check --file x.glb` kaynak projeyle aynı kutu/hacim, yazan komut reddi ve dosya bayt bayt aynı, `--style` doğrulaması) + köprü (`style` iletimi). Elle: BoltRush `glb/` altındaki tüm GLB'ler ayrıştı, üçgen sayıları `index.json` ile aynı; `beam_steel_1x4.glb` 660 üçgen, 100 × 400 × 100; konsept-01/03 kutuları kaynak `.p3d.json` ile aynı; görünmez Chrome'da `snapshot --file x.glb --style wire/xray` ve arayüz (Aç… GLB, düğmeler, W, X-ışınında seçim; konsol temiz); `style` verilmeden snapshot HEAD ile bayt bayt aynı. Kullanıcının gerçek sekmesinde fareyle ve başka araçların ürettiği GLB'lerle (Blender vb.) **denenmedi** |
| Ortografik kamera | ✅ `tests/camera-math.test.ts` (3: gidiş-dönüşte uzaklık/yükseklik, sınır kırpma, 4 yarıçap × 200 rastgele hedef/yönde sahne küresi [near, far] içinde ve kamera dışarıda, `orthoFrameCamera` çerçevesi) + köprü/CLI (`projection` iletimi, ortho + eye/fov/eye'sız camera reddi, yardım). Varsayılan ve orto snapshot önceki turla bayt bayt aynı. Görünmez Chrome + CDP: düğme/O/Num 5, tekrar tuşu, aşırı zoom sonrası geri dönüş, hedef kaydırıp döndürme, kalemde çizerken geçiş reddi, eksen kilidinde Num 5, 1021 parçalı araç 20 m tablada; konsol temiz. Kullanıcının sekmesinde fareyle **denenmedi** |
| v0.3 özellikleri | ✅ 67 test (tekne şekli: kutu tablosu tam hacim, sıfır genişlikte kapanma, doğrulama; dışa aktarılan örnek tekne kapalı ağ dahil) (örtük yüzey küre hacmi, `sliceMany` = `sliceGeometry`, Regularize iğne üçgen <%1 dahil): yumuşak loft hacmi (daireye yakınsama), uç (koni ≈ πr²h/3), sharp (tam kutu), cuts, çerçeve (kapalı/açık alan), eğik yüzeye dik oturtma, birleşim hacmi, `check` çakışma bulur/temizde susar |
| OBJ çıktısı | ✅ Her şekil için kapalı/doğru yönlü ağ ve hacim ≈ analitik değer (`tests/io.test.ts`) |
| Proje kaydet/yükle | ✅ Gidiş-dönüş ve bozuk dosya onarımı testleri; `examples/` dosyaları onarımsız yüklenir |
| Arayüz | ✅ Chrome'da elle denendi: komutlar, panelden düzenleme, geri al, isim/ölçü anahtarları, dışa aktarma menüsü, otomatik kayıttan geri yükleme; konsolda hata yok |
| Claude isteği — `api` | ⚠️ Yalnızca **sahte (mock) API** ile doğrulandı: istek biçimi (model, `fallbacks`, beta başlığı, `output_config`, şema) ve yanıt işleme. **Gerçek API anahtarıyla hiç denenmedi.** |
| Claude isteği — `claude-cli` | ✅ Gerçek `claude -p` (Claude Code 2.1.312, Windows) ile `/api/nl` uçtan uca: "tabanın dört köşesine … ayaklar koy" → doğru 5 işlem, ~9,4 sn. Tarayıcı arayüzünden (Claude modu seçiciyle) denenmedi; giriş yapılmamış/`claude` bulunamadı hata mesajları denenmedi |
| Global `p3d` komutu | ✅ 2 test (`tests/cli.test.ts`: başka klasörden göreli `--file`, `npm run p3d` altında `INIT_CWD`). Elle: `npm link` sonrası Git Bash ve PowerShell'de başka klasörden `section --file` ve çalışan sunucuya `scene`; ayrı bir klasörde `npm link p3d` ile `p3d/src/*.ts` içe aktarılıp (P3D'nin tsx'iyle) `applyOps` + `initCsg` + `checkProject` çalıştı |
| Çalışma alanları + köprü v0.4 | ✅ `tests/bridge.test.ts` (gerçek http sunucusu, sahte sekme: ws yalıtımı, hedef sekme, 409, rev/seq, load/mark_saved/özet, kopma, open/save korumaları) + `tests/workspace.test.ts` (p3d.json keşfi, kök kayıt biçimi, Store, yedek). Elle: görünmez Chrome'da `/w/deneme-ui` sekmesi — başlık/rozet, ops, save → rozet temiz, değişiklik → ●, Chrome yeniden açılınca IndexedDB'den geri geldi (dosya bağı + ●), `open` + `undo` önceki içeriğe döndü, WebGL snapshot; kök sekmeye dokunulmadı. İkinci sekme salt okunur bandı ve bozuk kayıt yedeği tarayıcıda **elle denenmedi** |
| Tarayıcısız çekirdek | ✅ `tests/api.test.ts`, `tests/cli.test.ts` (alt süreç: `run` + `from 'p3d'`, `apply` hata/--dry-run/--new, `export` stl/3mf/glb, `check --profile game`, `guide`, `skill install`). `snapshot --file` Windows + Chrome'da elle; macOS/Linux tarayıcı yolları ve Ctrl+C ile kapatma denenmedi. Rehberdeki betik örneği `p3d run` ile çalıştı. VibroBal `build.mts` yeni yüzeyle aynı çıktıyı üretti |
| Oyun dışa aktarımı | ✅ `tests/game.test.ts` (GLB başlık/chunk/accessor, eksen, birim, malzeme, flat/smooth, grup düğümleri, iskelet eklemleri/ağırlık/inverseBind, boş parça atlama, ASCII kemik adları; gruplar; ayna her şekil türü tek/çift segment, birebir loft; count; düşük çözünürlükte kapalılık; check game, 45° yanlış z-fighting düzeltmesi). three GLTFLoader ile Node'da yükleniyor. **Unreal'e gerçek içe aktarım ve glTF Validator denenmedi**; yeni Op şemaları gerçek Claude ile denenmedi |
| Kullanım rehberi | ✅ `tests/guide.test.ts`: her Op `ops.md`'de, her CLI komutu `cli.md`'de, skill yalnızca var olan konulara yönlendirir |
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
  (alttaki nokta), bükülme olabilir. `smooth` olmadan yüzey kesitler arasında doğrusaldır. Çakışık nokta yalnızca tam eşitse
  (1e-4 mm yuvarlamadan sonra) dejenere kenar sayılır; dosyaya önceden kaydedilmiş (noktası atılmış) hatalı loft'lar kendiliğinden
  düzelmez, kesitleri yeniden üretin.
- `place_on_surface` deliksiz yüzeye göre çalışır ve en yakın noktayı kaba kuvvetle arar (çok büyük ağlarda yavaş).
- Loft, ucunda sıfıra inen ya da topolojisi değişen gövdelerde (tekne başı/kıçı, küpeşte + kuyu) bozuk sonuç verir;
  bu gövdeler için `hull` şekli kullanılmalı.
- `hull` üretimi ~1–4 sn sürer (tarayıcıda ana iş parçacığında; açılışta ve tablo değişince). Büyük gövdelerde ayrıntı
  bütçeyle sınırlı (1 m gövdede ızgara ~4 mm; ağ zaten ~60 bin üçgene sadeleşir) ve y'de ~%0,3 asimetri olabilir.
- manifold WASM'ı bir kez çökerse (`RuntimeError`) modül sekme/süreç boyunca bozuk kalır; tüm boolean/delik/tekne
  işlemleri sayfa yenilenene (ya da süreç yeniden başlayana) kadar başarısız olur. Kendiliğinden yeniden yükleme yok.
  Bilinen tetikleyiciler (`levelSet` sınır boşluğu, dev ızgara) kapatıldı. Yüzeydeki yumuşak
  kırılımlar (ör. küpeşte altındaki dikey bant başlangıcı) hafif dalgalı çıkar; birkaç tek tük kısa kenar izi kalabilir.
- `hull` y'de simetrik ve x boyuncadır (eksen seçimi yok); istasyon kesitleri tek parça (iç boşluk tabloyla değil,
  ikinci bir `hull` delikle).
- Sahnede büyük referans ağ (ör. 80 bin üçgen) varken tarayıcının otomatik kayıt kotası (~5 MB) dolabilir; uygulama uyarır.
- Görünümde sürükleyerek taşıma/döndürme (gizmo) yok; konum komutla ya da panelden girilir.
- Parçalar birbirine bağlı değil: alttaki parça kalınlaşınca üstteki onunla yükselmez (iç içe girer);
  "X'i Y'nin üstüne koy" ile yeniden hizalanır. Gruplar yalnızca birlikte taşıma/döndürme/kopyalama/aynalama ve GLB
  hiyerarşisi içindir (ebeveyn-çocuk izleme yok); arayüzde grup oluşturma düğmesi yok (işlemle).
- Keyfi kenar yuvarlatma, metin, vida dişi yok (pah profilde çizilebilir).
- Ayna: `hull` yüzeyi ~0,5 mm'ye kadar simetrik; aynalanmış loft'un geom'u yeniden yazılırsa `mirrored` bayrağı düşer
  (aslını düzenleyip yeniden aynalayın). Dosyadan yüklenen projede parça ile grup aynı adı taşıyorsa onarılmaz.
- `hull` varsayılan ağı çözünürlükle sadeleşmez (< 34 segmentte ızgara kenarı 1 mm'de kalır); oyun bütçesi için `geom.maxTris`
  verin. Çok küçük bütçede (≲ 300) sivri uçlar birkaç mm kısalabilir (2,2 m gövde 500 üçgende baş ucu ~10 mm), yumuşak
  kırılımlar (küpeşte altındaki dikey bant) yuvarlanır.
- Otomatik yerleşim tabla doluysa parçayı tablanın dışına (sağa) koyar.
- Saydam parçalar `depthWrite` kapalı çizilir: içbükey tek bir saydam ağda yüz sıralama kusurları görülebilir (three.js'te olağan).
- Deliksiz yuvarlak parçada panel hacmi analitiktir (çözünürlükten bağımsız); düşük çözünürlükte (ör. 6 segment küre) dışa
  aktarılan ağın hacmi daha küçüktür. Gerçek ağ hacmi: `p3d measure` → birleşik hacim.
- Parça çözünürlüğü değişince parça merkezi yerinde kalır (taban sabitlenmez; proje çözünürlüğü değişince de böyle).
- `sweep`: yolun kendini kesmesi (sarmal, kendine yaklaşan halka) denetlenmez (ağ kapalı ama kendini keser). Yuvarlak kesitte gönye
  katlanma sınırı daire sınırıyla hesaplanır (S dönüşte biraz tutucu). Tek çözünürlük hem kesit kenar sayısını hem yay kiriş
  sayısını belirler (ayrı ayarlanamaz). Baştan sona düşey yolda başlangıç çerçevesi +Y/+X yedeğidir; bu uç durumda y düzlemindeki
  ayna yuvarlak kesitte birebir olmayabilir. Yerel ayrıştırıcıda süpürme kalıbı yok (yol nokta listesi ister). Tırmanırken keskin
  gönyeyle dönen yol (ör. 90° dönen merdiven küpeştesi) `up` burulma sınırına (45°) takılır: köşeye `bend` verin. Eşit köşegenli
  düzlemsel dörtgenlerde aynanın üçgen kümesi birebir değil (geometri aynı).
- `hull` ağlarında ayıklamadan bağımsız T-kavşakları var (Benchy teknesinde 193, katalog teknesinde 9; büyük olasılıkla sıfır
  alanlı üçgenlerle kapatılmış dikişler, `check game` "bozuk üçgen"): her çizimde tek piksellik çatlak yapabilir. Extrude, sweep ve
  diğer şekillerde yok.
- GLB tüketicisi köşe konumlarını nicemlememeli (Godot `GLTFDocument.append_from_file` varsayılanı 16 bit; bayrak 64 kapatır):
  ayrı düğümlerin çakışan köşeleri ayrışır, ayıklanmış birleşim çizgileri çatlar (`p3d guide game`).
- `--cull-hidden`: iki ayrı katının birlikte örttüğü üçgen ve kısmen örtülen üçgen kalır (bölme yok); statik pozdur (iskelette hareket eden parçalar arasındaki yüz
  hareketle görünür olabilir). Arayüzün GLB menüsünde seçenek yok (CLI/API). `check` 800 parçada ~7,5 sn (çakışık düzlem taraması).
- Kaplama (`decal`) açık ağdır: baskı biçimlerine girmez; `lift` 0 verilemez (varsayılana döner).
- `extrude`: boşluğun profil içinde/ayrık olduğu denetlenmez (kenara değen boşluk bozuk ağ verir); var olan dosyalar yüklenmez hâle
  gelmesin diye eklenmedi (sweep'te denetleniyor).
- GLB okuma malzeme, renk, normal ve UV almaz: dosya tek renkli tek parça açılır (çok parçalı P3D GLB'si de birleşir; renkli
  parçalar için kaynak `.p3d.json`'u açın). 1 000 000 üçgenlik GLB tarayıcının otomatik kayıt kotasını aşabilir (uyarı verilir).
- Tel kafes: yüksek çözünürlüklü yuvarlak parçalar (96 segment) yoğun koyu görünür; X-ışını çizgileri tablanın altından da görünür;
  tel kafeste kaplama dolgusu derinlik yazmadan en son çizilir (cam arkasındaki kaplama camla renklenmez). Araç çubuğu ~1506 px
  altında taşar (1100 px altında görünüm grubu gizlenir; kısayollar çalışır).
- Ortografik kamera sayfa yenilenince perspektife döner (yalnızca bellekte). Ortoda sığdırma perspektifle aynı yüksekliği alır (dar
  pencerede yanlardan kırpılabilir). Hedef sahneden çok uzağa kaydırılırsa yörünge o hedef çevresinde döner (sahne kırpılmaz, kadraj
  dışına çıkabilir). Ortoda üst üste binen CSS etiketlerinin sırası kameraya radyal uzaklıkla belirlenir (yanlış etiket üstte kalabilir).
- `set_position` X/Y'yi parçanın merkezine uygular; tek kenarlı prizma/koni döndürülmüşse sınırlayıcı kutu
  merkezi ile küçük fark olabilir.

**Eskiz**
- Tutamaçlar yalnızca nokta oluştururken (sürükleyerek) kurulur; var olan tutamacı sürükleme ve tüm yolu tek hamlede taşıma yok
  (nokta tablosundan ya da `sketch_move` ile). Dokunmatik giriş ele alınmadı.
- Ad etiketleri (WebGL sprite) yakın yollarda üst üste binebilir; işaret (marker) perspektifte küçüktür.
- Kalem açıkken sol tuş eskize aittir: kamera orta tuşla döner, sağ tuşla kayar. Eksen bakış yönüne ~11°'den yakınken kilitli
  sürükleme ekran dikeyine düşer (üstten bakarken Z kilidi: yukarı = kameraya doğru).
- Dosyadaki bozuk eskiz yolu uyarıyla atlanır ve bir sonraki kayıtta onsuz yazılır (yedek alınmaz). Panelde "Kapalı" kutusu 3 noktadan az
  yolda işaretlense de yol açık kalır (motor mesajla söyler).

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
- Komutlar ve sahne çalışma alanının **en son bağlanan** sekmesinindir; aynı alan iki sekmede açıksa eski sekme kayıt
  yazmaz ama hâlâ düzenlenebilir. Kimlik doğrulama yok (yalnızca `application/json` zorunluluğu); ağa açık sunucuda açmayın.
- Komut sırasında bağlantı koparsa (409/504) komut uygulanmış olabilir; körlemesine tekrarlamadan `p3d scene` ile bakın.
- `open`'ın sekme denetimi ile yükleme arasında küçük bir yarış kalır (yükleme geri alınabilir). Sunucudaki ağ deposu
  (`state.assets`) sınırsız büyür; `snapshot --file` geçici alanları `/workspaces` listesinde 0 sekmeyle kalır (en fazla 20).
- Gömülü bir ağı yeniden yolla anılan yapmanın yolu yok (`--no-embed` yok). Sert kapanmada (terminal kapanması)
  `snapshot --file`'ın Chrome süreci ve `p3d-chrome-*` geçici profili kalabilir.
- `src` dosyası değişirse aynı kimlikli ağı zaten yüklemiş sekme/süreç eski ağı tutar. Tarayıcının **Aç…** düğmesi ağı
  gömülü olmayan dosyada mesh parçalarını yer tutucu gösterir (uyarır; Kaydet de uyarır ve dosyayı "kaydedildi" saymaz);
  bu dosyaları `p3d open` ile açın.
- Sunucu yeniden başlayınca sekme otomatik yeniden bağlanır (EventSource), ama sahne bir değişiklik olana ya da
  bağlantı açılana kadar sunucuda yoktur (`scene` → 409).
- Sayfa, sunucu yeniden başlarken yüklenirse sekme bağlantısız kalır ve elle yenilemek gerekir. Bu, `vite.config.ts`
  sunucu dosyalarını içe aktardığı için her `server/`/`shared/` değişikliğinde oluyordu; artık API `ssrLoadModule` ile
  yükleniyor ve sunucu yeniden başlamıyor (yalnızca `vite.config.ts` değişirse başlar). `/api/status` ağ hatasında
  yeniden deneniyor.
- İçe aktarılan büyük ağ (≈1–2 MB base64) sahneyle birlikte sunucuya bir kez gönderilir; çok sayıda büyük ağda
  yavaşlayabilir.
- Windows'ta arka planda başlatılan `npm run dev` durdurulunca alt node süreci açık kalabilir (port meşgul).
- Global `p3d` komutu `npm link` ile **geliştirme klasörünü** gösterir: P3D'de yarım kalan bir değişiklik başka
  projelerdeki oturumları da etkiler (kararlı kurulum ayrımı ertelendi; tetikleyici: EXTERNAL-USE.md → Kararlar).

**Uygulama**
- Geri-al geçmişi ve seçim sayfa yenilenince sıfırlanır (proje otomatik kayıttan gelir).
- Yoğun sahnelerde isim etiketleri üst üste binebilir.
- İstemci paketi ~1,01 MB (Vite 1000 kB uyarısı) + manifold.wasm 541 kB; kod bölme yapılmadı.
- Otomatik kayıt tarayıcı kotası (~5 MB) ile sınırlı; büyük içe aktarılmış ağlar sığmazsa uyarı verilir.
- Hacim/ağırlık %100 doluluk varsayar. Gizli parçalar dışa aktarılmaz.

## Yol haritası (öncelik sırasıyla)

0. **Başka projelerden kullanım:** adımlar 1–6 tamam ([`EXTERNAL-USE.md`](EXTERNAL-USE.md)). Sıradaki: GLB'yi Unreal'e
   gerçekten aktarıp (araç iskeleti dahil) doğrulamak; yeni Op şemalarını gerçek Claude ile denemek; skill'i başka bir
   oturumda kullanıp rehberi düzeltmek; gerekirse `p3d-designer` alt ajanı ve kararlı kurulum ayrımı (tetikleyiciler:
   EXTERNAL-USE.md → Kararlar).
1. **Dışa aktarım ve arayüz doğrulaması:** 3MF/STL'yi Bambu/Prusa/Orca'da açıp renk ve ölçek kontrolü;
   v0.2 arayüz öğelerini tarayıcıda elle deneme.
2. **Gruplama (devamı) ve ekranda birleşim:** gruplar v0.4'te var; ebeveyn-çocuk izleme, arayüzden grup; grup içi union'ı ekranda da
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
7. Hizala/dağıt ("4 köşeye yerleştir"); ayna ve dizi (`duplicate.count`) v0.4'te var.
8. Geri-al geçmişini kalıcı tutma; birden çok proje listesi.
9. three.js için kod bölme.
10. **Eskizden geometri:** `sweep` Faz 1 yapıldı ([`SWEEP.md`](SWEEP.md)). Sıradaki: Faz 2 = eskiz yolundan süpürme (kopya:
    "Bu yolu süpür" eskiz yolunu örnekleyip `geom.path`'e yazar). Kalan (ertelendi, tartışılacak): eskiz yolu → ekstrüde et / delik
    kes balonu; `geom.sketch` canlı bağı; paralel düzlemlerdeki kapalı yollar → loft kesitleri (yol yüksekliği = `at`).
