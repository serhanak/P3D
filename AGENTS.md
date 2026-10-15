# AGENTS.md — P3D geliştirici / LLM ajanı rehberi

Bu dosya, projede çalışacak yapay zekâ ajanları (Claude Code, Codex, Cursor vb.) ve geliştiriciler içindir.
Kalıcı bilgiyi (mimari, kurallar, değişmezler, nasıl yapılır) içerir. **Güncel durum, bilinen sorunlar ve
yol haritası için [`docs/STATUS.md`](docs/STATUS.md)'yi okuyun** ve bir iş bitirdiğinizde orayı güncelleyin.

## Proje özeti

P3D, 3D yazıcıya parça hazırlamak için tarayıcıda çalışan bir modelleme aracıdır. Kullanıcı parçaları
**Türkçe doğal dil komutlarıyla** ("mil parçasının çapını 10mm büyüt") ya da arayüzden oluşturur/değiştirir.
Parçalar renkli ve isimlidir, ölçüler 3B görünümde gösterilir, proje `.p3d.json` olarak kaydedilir,
sonuç OBJ (+MTL) olarak dışa aktarılır.

- Kullanıcı Türkçe konuşur. **Arayüz metinleri, hata mesajları ve kod yorumları Türkçe**; tanımlayıcılar
  (değişken/fonksiyon/tip adları) İngilizce.
- Yığın: Vite 8 + TypeScript 7 (tarayıcı), three.js 0.186, fflate (ZIP), Node 22 + `@anthropic-ai/sdk`
  (sunucu), vitest 5 (test). Geliştirme ortamı Windows 10 (Git Bash / PowerShell).

## Komutlar

```bash
npm install
npm run dev        # Vite geliştirme sunucusu, http://localhost:5173 (/api uçları dahil)
npm test           # vitest run — tüm testler
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build → dist/
npm start          # üretim: tsx server/index.ts → http://127.0.0.1:8080 (dist/ + /api)
```

Bir değişikliği bitirmeden önce **`npm run typecheck` ve `npm test` temiz olmalı.** Arayüz değişikliklerini
mümkünse tarayıcıda da kontrol edin (geliştirme sunucusu HMR ile yeniden yükler; proje localStorage'dan
geri gelir ama geri-al geçmişi ve seçim sıfırlanır).

Claude modu için `.env` (bkz. `.env.example`): `ANTHROPIC_API_KEY`, opsiyonel `P3D_MODEL`, `P3D_EFFORT`, `PORT`, `HOST`.
`.env` git'e girmez; anahtarı asla istemci koduna, loglara ya da commit'lere koymayın.

## Dizin yapısı

```
shared/ops.ts        İşlem (Op) tipleri + Claude için JSON şeması (RESPONSE_SCHEMA) + istemci/sunucu sözleşmesi
src/types.ts         Part / Project tipleri, newProject()
src/shapes.ts        Şekil tanımları: parametreler, takma adlar, geometri, ölçü çizgileri, analitik hacim, kısıtlar
src/engine.ts        applyOps(): işlemleri projeye uygular; bbox, parça bulma, adlandırma, sahne özeti
src/store.ts         Store: proje durumu, geri al/yinele (JSON anlık görüntü), localStorage otomatik kayıt
src/nlp/parser.ts    Yerel Türkçe komut ayrıştırıcı (çevrimdışı)
src/nlp/llm.ts       /api/status ve /api/nl istemcisi
src/text.ts          fold(): Türkçe küçük harf + aksan kaldırma (1:1 karakter eşlemesi)
src/colors.ts        Renk adları (TR/EN) → hex, "açık/koyu" değiştiricileri
src/viewer.ts        three.js görünümü: tabla, parçalar, isim/ölçü etiketleri (CSS2DRenderer), seçim, kamera
src/io.ts            Proje dosyası doğrulama (parseProject), OBJ/MTL üretimi, ZIP, indirme
src/ui.ts            Sol parça listesi + sağ özellik paneli (olay delegasyonu, HTML string render)
src/main.ts          Uygulama kurulumu: araç çubuğu, komut konsolu, kısayollar, ilk açılış örneği
src/style.css        Koyu tema; tüm stiller burada
server/api.ts        handleApi(): /api/status, /api/nl → Claude (Vite ara katmanı ve üretim sunucusu ortak)
server/prompt.ts     Claude sistem talimatı (sabit metin — önbelleklenir)
server/index.ts      Üretim HTTP sunucusu (dist/ statik + /api)
vite.config.ts       .env → process.env aktarımı, /api ara katmanı
tests/               parser.test.ts (ayrıştırıcı+motor), io.test.ts (OBJ manifold, proje dosyası)
docs/STATUS.md       Güncel durum, doğrulama durumu, bilinen sorunlar, yol haritası
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
- `viewer.sync()` her bildirimde tüm sahneyi projeyle eşitler; geometri yalnızca
  `shape|params|resolution` anahtarı değişince yeniden üretilir.

## Değişmezler ve kurallar (bozmayın)

**Koordinatlar ve birimler**
- Birim mm. **Z yukarı.** Tabla XY düzleminde, z = 0, orijin tabla merkezinde (dilimleyici kuralı).
  `THREE.Object3D.DEFAULT_UP` ve kamera `up` (0,0,1).
- `Part.position` = şeklin **geometrik merkezi** (dünya). `Part.rotation` = merkez etrafında XYZ Euler, **derece**.
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

**Sunucu / yapılandırma**
- `vite.config.ts` → `server/api.ts` → `shared/ops.ts` zincirindeki importlar **`.ts` uzantılı** yazılır
  (Vite'nin yerel config yükleyicisi uyarısı; `tsconfig` `allowImportingTsExtensions: true`).
  `src/` içindeki importlar uzantısızdır (bundler çözümlemesi).
- Üretim sunucusu varsayılan olarak `127.0.0.1`'e bağlanır (API anahtarı harcamasını ağa açmamak için).

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
- `parseClause` niyetleri **bu öncelik sırasıyla** dener: görünürlük (isim/ölçü) → silme → kopyalama →
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
- Claude yolu birim testlerinde çağrılmaz (gerçek API çağrısı para harcar). İstek biçimini doğrulamak için
  `ANTHROPIC_BASE_URL`'i yerel bir sahte sunucuya yönlendirip `interpret()` çağrılabilir.

## Git
- Ana dal `main`. Commit mesajları kısa, emir kipinde; Türkçe ya da İngilizce olabilir.
- `.env`, `node_modules/`, `dist/` commit'lenmez.
