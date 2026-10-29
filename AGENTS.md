# AGENTS.md — P3D geliştirici / LLM ajanı rehberi

Bu dosya, projede çalışacak yapay zekâ ajanları (Claude Code, Codex, Cursor vb.) ve geliştiriciler içindir.
Kalıcı bilgiyi (mimari, kurallar, değişmezler, nasıl yapılır) içerir. **Güncel durum, bilinen sorunlar ve
yol haritası için [`docs/STATUS.md`](docs/STATUS.md)'yi okuyun** ve bir iş bitirdiğinizde orayı güncelleyin.

## Proje özeti

P3D, 3D yazıcıya parça hazırlamak için tarayıcıda çalışan bir modelleme aracıdır. Kullanıcı parçaları
**Türkçe doğal dil komutlarıyla** ("mil parçasının çapını 10mm büyüt") ya da arayüzden oluşturur/değiştirir.
Parçalar renkli ve isimlidir, ölçüler 3B görünümde gösterilir. Temel şekillerin yanında serbest biçimler
(ekstrüzyon, döndürme, loft), delikler (boolean, manifold-3d) ve içe aktarılan ağlar (STL/OBJ/3MF) vardır.
Proje `.p3d.json` olarak kaydedilir, sonuç 3MF / STL / OBJ olarak dışa aktarılır.

- Kullanıcı Türkçe konuşur. **Arayüz metinleri, hata mesajları ve kod yorumları Türkçe**; tanımlayıcılar
  (değişken/fonksiyon/tip adları) İngilizce.
- Yığın: Vite 8 + TypeScript 7 (tarayıcı), three.js 0.186, manifold-3d 3.5 (boolean/kesit, WASM), meshoptimizer
  (ağ sadeleştirme), fflate (ZIP/3MF), Node 22 + `@anthropic-ai/sdk`
  (sunucu), vitest 5 (test). Geliştirme ortamı Windows 10 (Git Bash / PowerShell).

## Komutlar

```bash
npm install
npm run dev        # Vite geliştirme sunucusu, http://localhost:5173 (/api uçları + köprü dahil)
npm run dev:claude # aynısı, serbest komutlar bu makinedeki Claude Code hesabıyla (--llm=claude-cli)
npm test           # vitest run — tüm testler
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build → dist/
npm start          # üretim: dist/ + /api → http://127.0.0.1:8080 (köprü kapalı)
npm run -s p3d -- scene | ops | undo | redo | fit   # Claude Code köprüsü (aşağıya bakın)
npm run -s p3d -- snapshot | measure | section | import   # görüntü, ölçüm, kesit, ağ içe aktarma
```

`dev` ve `start` `scripts/launch.ts` üzerinden çalışır; açılış parametreleri ortam değişkenlerine çevrilir
(parametre > ortam > `.env`): `--llm=auto|api|claude-cli|off` (`P3D_LLM`), `--bridge` / `--no-bridge`
(`P3D_BRIDGE`), `--port`, `--host`, `--model`, `--effort`, `--claude-bin`. Ör. `npm start -- --llm=api`.

Bir değişikliği bitirmeden önce **`npm run typecheck` ve `npm test` temiz olmalı.** Arayüz değişikliklerini
mümkünse tarayıcıda da kontrol edin (geliştirme sunucusu HMR ile yeniden yükler; proje localStorage'dan
geri gelir ama geri-al geçmişi ve seçim sıfırlanır).

Claude modu için `.env` (bkz. `.env.example`): `P3D_LLM`, `ANTHROPIC_API_KEY`, opsiyonel `P3D_MODEL`,
`P3D_EFFORT`, `P3D_BRIDGE`, `P3D_CLAUDE_BIN`, `PORT`, `HOST`.
`.env` git'e girmez; anahtarı asla istemci koduna, loglara ya da commit'lere koymayın.

## Kullanıcıyla terminalden tasarlamak (Claude Code köprüsü)

Kullanıcı bu terminalde "4 ayaklı masa yap" gibi istekler yazarsa, açık tarayıcı sekmesindeki sahneyi
**doğrudan** değiştirebilirsiniz (API anahtarı gerekmez; işlemleri siz üretirsiniz):

1. Geliştirme sunucusu çalışıyor olmalı (`npm run dev`, arka planda) ve uygulama tarayıcıda açık olmalı.
2. `npm run -s p3d -- scene` → sahne özeti (parça adı, şekil, parametreler, merkez, bbox, renk; `*` seçili).
   `--full` tüm proje JSON'unu verir.
3. İşlemleri `shared/ops.ts`'teki `Op` tipine göre JSON olarak stdin'den gönderin; yanıt mesajları,
   hataları ve güncel sahneyi döner (hata varsa çıkış kodu 1):
   ```bash
   npm run -s p3d -- ops --label "kullanıcının isteği" <<'EOF'
   [{"op":"create","shape":"cylinder","name":"ayak1","params":[{"name":"diameter","value":6},{"name":"height","value":20}],"position":{"x":27,"y":17,"z":10}}]
   EOF
   ```
   `params` her zaman dizidir: `{name, value, mode?: 'set'|'add'|'mul'}` (`name` bir `ParamKey` ya da `wall`).
   `position` merkezdir (taban değil); `set_position` yalnızca burada/yerelde vardır ve `z`'si tabandır.
4. `npm run -s p3d -- undo | redo | fit`. Her `ops` çağrısı tarayıcıda tek geri-al adımıdır ve günlükte
   "Claude Code" etiketiyle görünür.

Komutlar **en son bağlanan** sekmeye gider. Test için kullanıcının sekmesine işlem göndermeyin; gerekirse
önce sorun ya da sonradan `undo` ile geri alın. Köprü `server/bridge.ts` (sunucu) ↔ `src/bridge.ts`
(tarayıcı, SSE + PUT sahne) ↔ `scripts/p3d.ts` (CLI) üçlüsüdür.

### Doğrulama döngüsü (çizdiğinizi görün ve ölçün)
Kör çizmeyin; her anlamlı adımdan sonra kontrol edin:
- `snapshot [--views iso,front,back,left,right,top,bottom] [--size 1000x750] [--out klasör]` → PNG yolları yazdırır;
  dosyaları Read ile açıp bakın. Dik görünümler (front = −Y'den bakış, right = +X'ten) görünür parçaların kutusuna
  sığdırılır; isim/ölçü yazıları (CSS) görüntüye girmez. Salt okunurdur, sahneyi değiştirmez.
- `measure` → parça başına kutu ve **delikler uygulanmış** hacim; toplam ayrıca **birleşik** (union, örtüşmeler bir kez)
  hacim ve PLA tahmini. Orijinalle karşılaştırmada birleşik hacmi kullanın. Node'da aynı motorla hesaplanır.
- `check` → farklı katıların aynı düzlemde aynı yöne bakan üst üste yüzeyleri (ekranda z-fighting), boolean hataları,
  hiçbir şeyi kesmeyen delikler, 0,8 mm altı parçalar, tabla teması. Hata varsa çıkış kodu 1. Her bitmiş modelde çalıştırın.
- `section --axis x|y|z --at a,b [--parts …] [--tol 0.1]` → kesit çokgenleri ([y,z] / [x,z] / [x,y]);
  `--file ref.stl` ile sahne olmadan bir dosyada. Alan negatifse "(iç boşluk)".
- Bir nesneyi **orijinaline yakın** çizmek için: referansı `import ref.stl --role reference --keep-position` ile
  yarı saydam alın, `section --file` ile istasyon / su hattı / boyuna kesitlerden ölçün, yapıyı (hangi özellik
  hangi şekil) siz kurun, sayıları ölçümden alın; sonra `snapshot` + `measure` ile karşılaştırın.
  Örnek akış: `examples/README.md` (3DBenchy).

### Serbest biçimler ve delikler (AI-first)
- Ham üçgen/mesh üretmeyin; niyeti `extrude` (profil), `revolve` (profil [r, a]), `loft` (kesitler) ile verin,
  motor kapalı ağı üretir. `geom` koordinatları **yeniden merkezlenmez**: `position` {0,0,0} ile yazdığınız sayılar
  dünya koordinatıdır (önerilen). 2B nokta ekseni: z → [x,y], x → [y,z], y → [x,z].
- Loft kesitlerinde nokta sayısı ve başlangıç/dönüş yönü aynı olsun (örn. alt orta, saat yönünün tersi); farklıysa
  yeniden örneklenir ve başlangıç alttaki noktaya hizalanır.
- Doğrulama hataları açıklayıcıdır ("Kesit 30: kenarlar birbirini kesiyor", "en az 3 farklı nokta"); hatalı işlem
  uygulanmaz, diğerleri uygulanır — mesajı okuyup düzeltin.
- Boşluk, pencere, delik, cep: `role: "hole"` parça (katının içinden 1 mm taşsın). Delik varsayılan olarak kutusu
  kesişen **tüm görünür katılardan** çıkar; komşu parçaları (içindeki dümen, çerçeve, flanş…) da keseceği için
  `cuts: ["hedef"]` ile sınırlayın.
- **Z-fighting kuralı:** aynı delik iki katıyı keserse ikisinde aynı düzlemde kesim yüzü oluşur ve ekranda titreşir.
  Her deliği tek parçaya bağlayın; birden fazla parçanın oyulması gerekiyorsa her biri için ayrı delik kullanın ve
  kesim yüzünü diğer parçanın malzemesi içinde bırakın (ör. kabin zemini: kabin içi yalnızca kabini, kabin duvarları
  içinde biten ikinci delik yalnızca tekneyi keser). Çerçeve açıklığını deliğinden ~0,1 mm büyük çizin. `check` bulur.
- Çerçeve/pervaz: `extrude` + `frame: genişlik` (profil açıklıktır), `open: true` son→ilk kenarı açık bırakır.
- Eğri yüzeye oturan parçalar: `place_on_surface {part, target, near, offset}` → yerel +Z yüzey normaline döner.
- Organik yüzeyler: `loft` + `smooth: true` (monoton kübik, taşma yapmaz), keskin kalacak indisler `sharp`, uçta
  tek noktalı kesit. Kesit noktalarını ölçülen eğri boyunca eşit yay uzunluğuyla dağıtın (z'ye göre eşit değil).
  **Loft, kesiti ucunda sıfıra inen ya da topolojisi değişen gövdelerde (tekne başı/kıçı, küpeşte + kuyu) zayıftır:**
  uçlar bozulur, keskin kenar gövdeye karışır. Bunlar için **`hull` (endaze) şeklini** kullanın: istasyon başına
  `{x, keel, sheer, breadth[]}` (breadth omurgadan küpeşteye eşit aralıklı yarı genişlikler, her istasyonda aynı sayı).
  Uygulama tabloyu örtük yüzeye çevirir (`geom.ts` → `hullSdf`, `csg.hullSolid`: önce `Regularize` sadeleştirme, sonra
  yan profil ekstrüzyonuyla kesişim → keskin küpeşte/taban/ayna). Taban yarı genişliği ≥ 1,5 mm olan istasyonda taban
  keskin kesilir, V istasyonda (≤ 0,5) bodoslama örtük yüzeyin kendisidir. Oyuk (güverte) için ikinci bir `hull` delik.
  Örnek mesh gömmeyin: örnekler ve kalıcı modeller uygulamanın kendi şekilleriyle kurulmalı (3DBenchy: `examples/`).
- **Dışa aktarım ve boolean girdisi indisli ağ kullanır** (`model.baseIndexed` / `exportGeometry`): üreticilerin ve
  boolean'ın indisli ağını konuma göre yeniden kaynaklamayın — yüzeylerin bir noktada değdiği yerlerde ayrı köşeler
  çöker ve kenarlar bozulur. Konuma göre kaynaklama yalnız three.js ilkellerinin (indissiz) dikiş kopyaları içindir.
- Ağ sadeleştirme `meshoptimizer` + `Regularize` (iğne üçgen bırakmaz); `initCsg()` meshoptimizer'ı da hazırlar.
  `mesh` ve `hull` parçalarında gölge kırılımı ve kenar çizgisi eşiği 50°'dir (gerçek 90° kenarlar görünür, üçgen
  gürültüsü görünmez). `hull` ağı pahalıdır (~2 sn); `geom.ts` aynı tablo + çözünürlük için önbellekler.

## Dizin yapısı

```
shared/ops.ts        İşlem (Op) tipleri + Claude için JSON şeması (RESPONSE_SCHEMA) + istemci/sunucu sözleşmesi
src/types.ts         Part / Project tipleri, newProject()
src/shapes.ts        Şekil tanımları: parametreler, takma adlar, geometri, ölçü çizgileri, analitik hacim, kısıtlar
src/geom.ts          extrude/revolve/loft/mesh: geom doğrulama (sanitizeGeom), kapalı ağ üretimi, varsayılanlar
src/assets.ts        İçe aktarılmış ağ deposu (base64 Float32/Uint32); projede yalnızca kimlik tutulur
src/csg.ts           manifold-3d: başlatma (initCsg), çıkarma (delik), hacim, düzlem kesiti
src/model.ts         Parçanın son geometrisi (delikler çıkarılmış): görünüm, dışa aktarım ve hacim ortak
src/meshio.ts        STL/OBJ/3MF okuma (+ kaynak, sadeleştirme, merkezleme), STL/3MF yazma
src/engine.ts        applyOps(): işlemleri projeye uygular; bbox, parça bulma, adlandırma, sahne özeti
src/store.ts         Store: proje durumu, geri al/yinele (JSON anlık görüntü), localStorage otomatik kayıt
src/nlp/parser.ts    Yerel Türkçe komut ayrıştırıcı (çevrimdışı)
src/nlp/llm.ts       /api/status ve /api/nl istemcisi
src/text.ts          fold(): Türkçe küçük harf + aksan kaldırma (1:1 karakter eşlemesi)
src/colors.ts        Renk adları (TR/EN) → hex, "açık/koyu" değiştiricileri
src/viewer.ts        three.js görünümü: tabla, parçalar, isim/ölçü etiketleri (CSS2DRenderer), seçim, kamera, snapshot()
src/io.ts            Proje dosyası doğrulama (parseProject), OBJ/MTL üretimi, ZIP, indirme
src/ui.ts            Sol parça listesi + sağ özellik paneli (olay delegasyonu, HTML string render)
src/main.ts          Uygulama kurulumu: araç çubuğu, komut konsolu, kısayollar, ilk açılış örneği
src/style.css        Koyu tema; tüm stiller burada
server/api.ts        handleApi(): /api/status, /api/nl → Claude (API ya da claude -p), /api/bridge (Vite ara katmanı ve üretim sunucusu ortak)
server/config.ts     P3D_LLM / P3D_BRIDGE / model / effort okuma, etkin arka uç seçimi
server/claude-cli.ts claude-cli arka ucu: `claude -p --json-schema …` alt süreci
server/bridge.ts     Claude Code köprüsü sunucu tarafı (SSE, sahne deposu, sonuç bekleme)
src/bridge.ts        Köprünün tarayıcı tarafı (sahneyi bildirir, gelen işlemleri store.apply ile uygular)
scripts/launch.ts    npm run dev / npm start başlatıcısı: açılış parametreleri → ortam değişkenleri
scripts/p3d.ts       Köprü CLI'si (npm run p3d)
server/prompt.ts     Claude sistem talimatı (sabit metin — önbelleklenir)
server/index.ts      Üretim HTTP sunucusu (dist/ statik + /api)
vite.config.ts       .env → process.env aktarımı, /api ara katmanı
tests/               parser.test.ts (ayrıştırıcı+motor), io.test.ts (OBJ manifold, proje dosyası, examples/),
                     geom.test.ts (extrude/revolve/loft, delik, roller, kesit, STL/3MF/OBJ içe-dışa aktarma)
examples/            Örnek .p3d.json projeleri (Aç… ile yüklenir); io.test.ts hepsinin onarımsız yüklendiğini doğrular
examples/tools/      Örnek üreteçleri (tsx ile çalışır, tsconfig dışı): build-3dbenchy.ts referans STL'den Benchy'yi kurar
docs/STATUS.md       Güncel durum, doğrulama durumu, bilinen sorunlar, yol haritası
.claude/agents/      Claude Code alt ajanları (ölçüm, uygulama, doğrulama, inceleme); kullanım: CLAUDE.md
```

## Mimari: tek değişiklik yolu

```
Yerel ayrıştırıcı ─┐
Claude (/api/nl) ──┼──► Op[] ──► Store.apply(ops) ──► engine.applyOps(draft) ──► yeni Project
Arayüz düzenleme ──┘                    │ (önceki JSON undo yığınına)          │
                                        └──► abonelere bildir ──► viewer.sync() + paneller
```

- **Projeyi doğrudan değiştirmeyin.** Her kullanıcı değişikliği bir `Op` listesi olarak `store.apply()`'dan
  geçer; böylece geri alma, doğrulama, mesajlar ve "taban sabit" davranışı her kaynak için aynıdır.
  İşlem olmayan ayar değişiklikleri (proje adı, tabla boyutu, çözünürlük) `store.mutate()` kullanır.
- `applyOps` taslak bir kopya üzerinde çalışır; her işlem kendi try/catch'inde çalışır, hatalar
  `OpError` ile Türkçe mesaj olarak `res.errors`'a, başarılar `res.messages`'a gider. Bir işlem hatası
  sonraki işlemleri durdurmaz. Tüm liste tek geri-al adımıdır.
- `Store.apply` seçimi işlemlerin dokunduğu son parçaya taşır; ayrıştırıcı bağlamı ("yüksekliğini de artır")
  bu sayede seçili parçadan gelir.
- `viewer.sync()` her bildirimde tüm sahneyi projeyle eşitler; geometri yalnızca `model.solidKey()`
  (şekil + params + geom + çözünürlük + kesen deliklerin geometri ve göreli konumları) değişince yeniden üretilir.
- Görünen = dışa aktarılan: viewer, `io.ts` (OBJ/STL/3MF) ve hacim `model.solidGeometry()` / `solidVolume()` kullanır.

## Değişmezler ve kurallar (bozmayın)

**Koordinatlar ve birimler**
- Birim mm. **Z yukarı.** Tabla XY düzleminde, z = 0, orijin tabla merkezinde (dilimleyici kuralı).
  `THREE.Object3D.DEFAULT_UP` ve kamera `up` (0,0,1).
- `Part.position` = şeklin **geometrik merkezi** (dünya). `Part.rotation` = merkez etrafında XYZ Euler, **derece**.
  İstisna: `extrude/revolve/loft` (ve `mesh`) geometrisi yeniden merkezlenmez; `position` profil koordinatlarının
  orijinini taşır, döndürme o orijin etrafındadır. `mesh` içe aktarılırken ağ kendi kutu merkezine taşınır
  (`--keep-position` dosyadaki yerini konum olarak verir).
- Arayüzde X/Y merkezi, **Z ise parçanın tabanını** (bbox min z) gösterir. `set_position` işleminde de
  `z` tabandır. Claude'a giden sahne özetinde ise `position` merkezdir, ayrıca `bbox` verilir.
- Ölçü (`params`) veya döndürme değişince parça **tabanını (min z) ve XY merkezini korur**
  (`engine.ts` → `anchored()`), konum açıkça verilmedikçe. Parçalar birbirine bağlı değildir.

**Şekiller (`src/shapes.ts`)**
- `build()` geometriyi **orijinde ortalanmış, Z ekseni yukarı** üretir (CylinderGeometry Y ekseninde
  doğar → `rotateX(PI/2)`; ExtrudeGeometry +Z'de doğar → `translate(0,0,-h/2)`).
- Her şekil **kapalı, manifold, normalleri dışa bakan** ağ üretmelidir. `tests/io.test.ts` bunu tüm
  `SHAPES` için otomatik doğrular (yönlü kenar kontrolü + işaretli hacim ≈ analitik hacim).
- `volume()` analitik (gerçek) hacimdir; panelde ve testte kullanılır.
- `sanitizeParams()` min/max/tamsayı sınırlarını ve `fix()` kısıtlarını (ör. boru iç çap < dış çap) uygular.
- `geom` şekillerinde `dims`/`volume` yoktur: ölçü çizgileri ağın kutusundan, hacim ağdan hesaplanır. Hepsinde
  `scale` parametresi tüm geometriyi büyütür (`scale` işlemi bunu değiştirir). `sanitizeGeom()` kapalı, kendini
  kesmeyen çokgen, revolve'da r ≥ 0, loft'ta ≥ 2 farklı konumlu kesit ister; dosya yüklerken geçersiz parça atlanır.

**Roller, delikler, ağlar**
- `role` yok = katı. `hole`: kutusu kesişen görünür katılardan manifold-3d ile çıkarılır; kendisi dışa aktarılmaz.
  `reference`: yalnızca görsel, dışa aktarılmaz, kesilmez. Parça `visible: false` ise delik kesmez;
  `view.showHoles` yalnızca delik görüntüsünü kapatır, kesme sürer.
- Çerçeve (`frame`) de manifold-3d ister. Geometri üretilemezse `buildGeometry` 5 mm'lik yer tutucu küp döndürür
  (sahne çizilmeye devam eder, konsola uyarı yazılır).
- manifold-3d WASM'ı kullanılmadan önce `initCsg()` beklenmelidir (tarayıcıda `main.ts` üst düzey await +
  `manifold.wasm?url`; Node'da testler `beforeAll(() => initCsg())`). Yüklenemezse delikler uygulanmaz, uyarı verilir.
  Manifold nesneleri JS çöp toplayıcısına bırakılmaz: `delete()` edin (bkz. `csg.ts`).
- Ağ verisi (`MeshAsset`) **projede tutulmaz**: `assets.ts` deposunda; geri-al anlık görüntüleri ve otomatik kayıt
  yalnızca kimliği taşır (aksi hâlde 200 adımlık geri-al yüzlerce MB olur). Dosyaya yazarken `projectToJson`
  kullanılan ağları `assets` altında gömer, `parseProject` depoya alır. Otomatik kayıtta ağlar ayrı anahtardadır
  (`p3d.autosave.assets.v1`); sığmazsa kullanıcı uyarılır, parça yer tutucu küp olarak görünür.

**Metin işleme**
- `fold()` karakter karakter eşler; **çıktı uzunluğu girdiyle aynıdır.** Ayrıştırıcı katlanmış metinde
  bulduğu indeksleri orijinal metinden isim kesmek için kullanır. Uzunluk değiştiren dönüşüm eklemeyin
  (uzunluk değiştiren ön işlemler yalnızca sayı/anahtar kelime aramasında, `preprocessNumbers()` ile).

**Claude entegrasyonu (`server/api.ts`)**
- API anahtarı **yalnızca sunucuda**. İstemci `/api/nl`'e sahne özeti + komut gönderir, `Op[]` alır,
  işlemleri istemci uygular (sunucu durumsuzdur).
- Model varsayılanı `claude-opus-5-5`. Yapılandırılmış çıktı: `output_config.format = { type: 'json_schema', schema: RESPONSE_SCHEMA }`,
  `output_config.effort` (varsayılan `medium`). Reddetmeye karşı `betas: ['server-side-fallback-2026-07-01']`
  + `fallbacks: 'default'` (beta uç noktası `client.beta.messages.create`).
- Opus 5.5'te **zorunlu `tool_choice` (any/tool) 400 döner** ve `thinking: {type:'disabled'}` 400 döner;
  bu yüzden araç yerine yapılandırılmış çıktı kullanılıyor ve `thinking` parametresi gönderilmiyor.
- Şemada her alan zorunludur; "ayarlama" anlamı için string alanlarda `""`, nesne/boolean'da `null` kullanılır.
  `normalizeLlmOp()` bunları opsiyonel alanlara çevirir. Şema yalnızca yapılandırılmış çıktının desteklediği
  özellikleri kullanmalı (`anyOf`, `const`, `enum`, `additionalProperties: false`; `minimum`/`maxLength` yok).
- `stop_reason` `refusal` / `max_tokens` içerik okunmadan önce kontrol edilir; SDK hata sınıfları
  (`Anthropic.AuthenticationError`, `RateLimitError`, …) en özelden genele yakalanır.
- `SYSTEM_PROMPT` sabit tutulur (önbellek için `cache_control`); değişken veri (sahne, geçmiş) kullanıcı mesajındadır.
- Arka uç `server/config.ts` → `llmBackend()` ile seçilir. `auto` **asla** `claude-cli` seçmez: Claude.ai/Claude Code
  girişi başka kullanıcılara sunulan bir hizmette kullanılamaz, `claude-cli` yalnızca kullanıcının kendi
  makinesinde, kendi hesabıyla açıkça seçilir. Sunucu kurulumu `api` kullanır. Hesabın OAuth jetonunu alıp
  API'yi doğrudan çağıran kod yazmayın.
- `claude-cli` (`server/claude-cli.ts`): `claude -p --output-format json --json-schema <RESPONSE_SCHEMA>
  --system-prompt <SYSTEM_PROMPT> --tools "" --strict-mcp-config --no-session-persistence --model --effort`,
  geçici dizinde çalışır (proje CLAUDE.md'si karışmasın), komut stdin'den gider, sonuç `structured_output`'tan
  okunur. `--bare` kullanılamaz (yalnızca API anahtarı kabul eder). Tipik süre ~10 sn.

**Sunucu / yapılandırma**
- `vite.config.ts` → `server/api.ts` → `shared/ops.ts` zincirindeki importlar **`.ts` uzantılı** yazılır
  (Vite'nin yerel config yükleyicisi uyarısı; `tsconfig` `allowImportingTsExtensions: true`).
  `src/` içindeki importlar uzantısızdır (bundler çözümlemesi).
- Üretim sunucusu varsayılan olarak `127.0.0.1`'e bağlanır (API anahtarı harcamasını ağa açmamak için).
- Köprü yazma uçları (`/api/bridge/*` POST/PUT) yalnızca `Content-Type: application/json` kabul eder; böylece
  başka bir sitenin tarayıcıdan gönderdiği "basit istek" CORS ön kontrolüne takılır. Köprüde kimlik doğrulama
  yoktur; ağa açık bir sunucuda `--bridge` açmayın.
- `scripts/launch.ts` → vite / `server/index.ts`; `vite.config.ts` `.env` değerlerini yalnızca ortamda yoksa
  yazar (açılış parametresi kazanır).
- Geliştirmede `/api` modülü istek anında `server.ssrLoadModule('/server/api.ts')` ile yüklenir; `vite.config.ts`
  sunucu dosyalarını içe aktarmaz. Böylece `server/` ya da `shared/` değişince sunucu yeniden başlamaz (yeniden başlama
  sırasında yenilenen sekme bağlantısız kalıyordu). Köprü durumu bu yüzden `globalThis.__p3dBridge`'te tutulur.

**Görünüm**
- `CSS2DObject` DOM öğeleri, nesnenin ebeveyni sahneden çıkarılınca kendiliğinden silinmez;
  `viewer.ts` bunları `clearDims()` / `disposeEntry()` içinde elle siler. Yeni etiket eklerken aynısını yapın.
- Geometri/malzeme `dispose()` edilmeden atılmaz.

## Nasıl yapılır

### Yeni bir işlem (Op) eklemek
1. `shared/ops.ts`: `Op` birleşimine ekleyin. Claude kullanacaksa `RESPONSE_SCHEMA`'ya `opSchema(...)` ekleyin
   (tüm alanlar zorunlu; boş değer `""`/`null`). Yalnızca yerelse şemaya eklemeyin (ör. `set_position`).
2. `src/engine.ts` → `applyOps` içine `case` ekleyin; parçayı `must()` ile bulun, `touch()` çağırın,
   Türkçe mesaj yazın, hatada `OpError` fırlatın. Ölçü/döndürme değiştiriyorsa `anchored()` kullanın.
3. Claude'a açıksa `server/prompt.ts`'deki "Operations" bölümünü güncelleyin.
4. Gerekirse ayrıştırıcıya kalıp ekleyin ve `tests/` altında test yazın.

### Yeni bir şekil eklemek
1. `shared/ops.ts` → `SHAPES` (ve yeni parametre adı gerekiyorsa `PARAM_KEYS`).
2. `src/shapes.ts` → `SHAPE_DEFS`'e `ShapeDef`: `params` (Türkçe etiket, min/def), `aliases` (genel ölçü
   kelimesi → parametre; ayrıştırıcı ve motor bunu kullanır), `build`, `dims`, `volume`, gerekiyorsa `fix`.
3. `src/nlp/parser.ts` → `SHAPE_WORDS` (katlanmış kök; ünsüz yumuşaması varsa ikinci kök, ör. `cubuk`/`cubug`)
   ve `parseCreate` içindeki etiketsiz sayı sırası (`order`).
4. `server/prompt.ts` → "Shapes and their params" listesi.
5. `npm test` — `io.test.ts` yeni şekli otomatik olarak manifold/hacim testinden geçirir.

### Ayrıştırıcıya yeni bir Türkçe kalıp eklemek (`src/nlp/parser.ts`)
- Akış: `parseCommand` → `splitClauses` (`;`, satır sonu, "sonra"; " ve "/", " yalnızca iki tarafta da fiil
  varsa) → her cümle için `parseClause`.
- `parseClause` niyetleri **bu öncelik sırasıyla** dener: görünürlük (isim/ölçü) → delik/rol ("delik aç",
  "delik yap", "delikleri gizle") → silme → kopyalama →
  oluşturma (yalın şekil kelimesi + oluşturma fiili) → yeniden adlandırma → üstüne/yanına koy → tablaya indir →
  döndürme → taşıma/konum → ölçü değişikliği → bütün ölçekleme → renk → göster/gizle → seçme.
  Yeni niyeti doğru yere koyun; daha genel kalıpların önüne geçebilir.
- Parça referansları: `findNameMentions` (isim + `SUFFIXES` kümesindeki hâl ekleri ya da kesme işareti),
  sonra şekil kelimeleri ("kutunun" → o şekildeki parça, `resolveShapeRef`). Referans yoksa bağlam
  (önceki cümle / seçili parça) kullanılır.
- Tüm eşleştirme **katlanmış** metinde yapılır (`ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u`); regex'leri buna göre yazın.
- Ölçü kelimeleri `KEYWORDS`; sayılar `findNumbers` (birim, %, "kat", yönelme eki "30'a" = hedef değer);
  eşleştirme `associate` (sıfat biçimi "çaplı" önceki sayıyı, iyelik "çapı" sonraki sayıyı alır).
- Anlaşılmayan cümle `unrecognized`'a düşer; **Otomatik** modda komutun tamamı Claude'a gider.
- Her yeni kalıp için `tests/parser.test.ts`'e `run(p, '...')` ile test ekleyin.

## Test yazma
- `tests/parser.test.ts` içindeki `run(project, text, sel)` yardımcısı arayüzdeki akışı taklit eder
  (ayrıştır → `applyOps` → seçimi güncelle). `partBox(...).min.z` ile taban yüksekliği kontrol edilir.
- three.js geometri kodu Node'da çalışır; DOM gerektiren kod (`viewer.ts`, `ui.ts`, `main.ts`, `download`) test edilmez.
- Geometri testlerinde analitik değerle karşılaştırın (alan × uzunluk, Pappus, kesik piramit) ve `checkWorldMesh`
  ile kapalılığı doğrulayın (`tests/geom.test.ts`). Delik testleri için `beforeAll(() => initCsg())`.
- `examples/*.p3d.json` dosyaları onarımsız yüklenmeli (`parseProject(raw)` = `raw`); proje biçimine alan
  eklerseniz örnekleri yeniden üretin.
- Claude yolu birim testlerinde çağrılmaz (gerçek API çağrısı para harcar). İstek biçimini doğrulamak için
  `ANTHROPIC_BASE_URL`'i yerel bir sahte sunucuya yönlendirip `interpret()` çağrılabilir. `claude-cli` yolu
  `P3D_CLAUDE_BIN` ile sahte bir programa yönlendirilebilir.

## Git
- Ana dal `main`. Commit mesajları kısa, emir kipinde; Türkçe ya da İngilizce olabilir.
- `.env`, `node_modules/`, `dist/` commit'lenmez.
