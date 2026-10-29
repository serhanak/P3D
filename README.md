# P3D — Doğal dille 3D yazıcı parçası tasarımı (MVP)

Tarayıcıda çalışan, parçaları **Türkçe komutlarla** oluşturup değiştirebildiğiniz basit bir 3D modelleme aracı.
Parçalar renkli ve isimlidir, ölçüler 3B görünümde gösterilir, proje kaydedilip yüklenebilir ve
3D yazıcı için **OBJ** olarak dışa aktarılır.

## Kurulum ve çalıştırma

```bash
npm install
npm run dev          # http://localhost:5173 (yalnızca yerel ayrıştırıcı; API anahtarı varsa Claude da açık)
npm run dev:claude   # aynısı, serbest komutlar bu bilgisayardaki Claude Code hesabınızla (bkz. Claude modu)
```

Üretim derlemesi:

```bash
npm run build        # tip denetimi + dist/
npm start            # http://127.0.0.1:8080 (dist/ + /api)
npm test             # ayrıştırıcı, işlem motoru, OBJ ve proje dosyası testleri
```

### Claude modu (opsiyonel)

Yerel ayrıştırıcı internet ve API anahtarı olmadan çalışır. Serbest anlatımlı komutlar
(“4 ayaklı küçük bir masa yap”) için Claude'u üç yoldan biriyle kullanabilirsiniz:

| Yol | Ne zaman | Nasıl açılır |
|---|---|---|
| **API anahtarı** (`api`) | Sunucu kurulumu; uygulamayı başkalarına açıyorsanız tek seçenek | `cp .env.example .env`, içine `ANTHROPIC_API_KEY=...` yazın, sunucuyu yeniden başlatın (`npm start -- --llm=api` anahtar yoksa uyarır) |
| **Claude Code hesabı** (`claude-cli`) | Kendi bilgisayarınızda, kendi Claude Code hesabınızla denemeler | `npm run dev:claude` ya da `npm run dev -- --llm=claude-cli` |
| **Terminalden Claude Code ile** (köprü) | Tasarımı Claude Code oturumunda sohbet ederek yapmak | `npm run dev` + Claude Code'a terminalde ne istediğinizi yazın |

- **`claude-cli`**: sunucu her serbest komut için makinedeki `claude -p`'yi araçsız çalıştırır; istek o makinede
  `claude` ile giriş yapmış kullanıcının hesabından gider (yanıt ~10 sn). Claude Code kurulu ve giriş yapılmış
  olmalı. **Yalnızca kişisel kullanım içindir**: Claude.ai/Claude Code hesabı başkalarına sunulan bir hizmette
  kullanılamaz; sunucu kurulumunda API anahtarı kullanın. `auto` modu bu yolu asla kendiliğinden seçmez.
- **Köprü**: açık sekme sahnesini sunucuya bildirir; terminaldeki Claude Code `npm run -s p3d -- scene` ile
  sahneyi okur, `npm run -s p3d -- ops` ile işlem gönderir. Değişiklikler sekmede canlı görünür, günlükte
  “Claude Code” etiketiyle yazılır ve Ctrl+Z ile geri alınabilir. `npm run dev`'de açık, `npm start`'ta kapalıdır
  (`--bridge` / `--no-bridge`).
- API anahtarı yalnızca sunucuda kullanılır, tarayıcıya gönderilmez. İstekler `fallbacks: "default"` ile gider
  (güvenlik sınıflandırıcısı reddederse önerilen yedek modelle tekrar denenir).
- Komut kutusunun solundaki seçici: **Otomatik** (önce yerel, anlaşılmazsa Claude), **Yerel**, **Claude**.

Açılış parametreleri (`.env`'deki değerlerin önüne geçer; `npm run dev -- --help`):

```bash
npm run dev -- --llm=claude-cli          # auto | api | claude-cli | off
npm run dev -- --no-bridge --port=5180
npm start   -- --llm=api --host=127.0.0.1 --port=8080
npm start   -- --model=claude-opus-5-5 --effort=low
```

## Özellikler

| İstek | Nasıl |
|---|---|
| Parçalar farklı renkte | Her parçanın rengi var; listeden, özellik panelinden ya da “tabanı mavi yap” ile değişir |
| İsimlendirme | Oluştururken “adı mil olsun”, sonra “milin adını şaft yap” ya da panelden |
| İsimleri aç/kapat | Üst çubuktaki **İsimler** anahtarı ya da “isimleri gizle / göster” |
| “x parçasının çapını 10mm büyüt” | Yerel ayrıştırıcı Türkçe ekleri anlar: `10mm büyüt`, `30'a çıkar`, `%20 artır`, `2 katına çıkar`, `yarıya indir`, `yarıçapını 2 mm küçült` |
| Ölçüleri gör/gizle | **Ölçüler** anahtarı ya da “ölçüleri gizle”; panelde sınırlayıcı kutu, hacim ve yaklaşık PLA ağırlığı |
| Kaydet / yükle | **Kaydet** (`.p3d.json`, Ctrl+S) / **Aç…**; ayrıca tarayıcıda otomatik kayıt |
| OBJ dışa aktarım | Tek OBJ · OBJ+MTL (renkli, ZIP) · her parça ayrı OBJ (çok renkli baskı için, ZIP) · seçili parça |

Şekiller: kutu, silindir, boru (iç/dış çap), koni (kesik koni), küre, torus, prizma (altıgen vb.).
Tüm değişiklikler geri alınabilir (Ctrl+Z / Ctrl+Y). Ölçü ya da döndürme değişince parça tabanını korur,
yani tablada duran parça tablada kalır.

### Örnek komutlar

```
50x30x10 kutu oluştur adı taban olsun
20 mm çaplı 40 mm yüksekliğinde kırmızı silindir ekle adı mil
tabanın üstüne 10 çaplı 30 yüksekliğinde silindir ekle adı direk
mil parçasının çapını 10mm büyüt ve yüksekliğini 5 mm azalt
mili tabanın üstüne koy · kapağı tabanın sağına koy · mili yere indir
mili x yönünde 20 mm taşı · mili x=10 y=20 konumuna taşı
mili x ekseninde 90 derece döndür · mili yatır
mili kopyala · mili sil · mili gizle · tümünü göster
isimleri gizle · ölçüleri göster · geri al
```

Komut kutusuna `yardım` yazarak listeyi görebilirsiniz; ↑/↓ önceki komutları getirir.

### Örnek projeler

[`examples/`](examples/) klasöründe **Aç…** ile yüklenebilecek hazır projeler var; ör.
[`3dbenchy.p3d.json`](examples/3dbenchy.p3d.json) — 3DBenchy'nin (CC0) temel şekillerle 60 × 31 × 48 mm yaklaşık modeli.

## Koordinatlar ve birimler

- Birim mm, **Z yukarı**, tabla XY düzleminde (z = 0) ve orijin tabla merkezinde — dilimleyicilerin
  (PrusaSlicer, Cura, Bambu/Orca) beklediği yön. OBJ dosyaları bu koordinatlarla yazılır.
- Panelde X/Y parçanın merkezini, **Z parçanın tabanını** gösterir.
- Dışa aktarılan ağlar kapalı (manifold) ve dışa dönüktür; testlerde her şekil için doğrulanır.

## Mimari

```
shared/ops.ts        İşlem türleri (create/update/move/rotate/...) + Claude için JSON şeması
src/engine.ts        İşlemleri projeye uygular (tek motor: ayrıştırıcı, Claude ve arayüz aynı yolu kullanır)
src/nlp/parser.ts    Yerel Türkçe komut ayrıştırıcı
src/shapes.ts        Şekil tanımları: parametreler, geometri, ölçü çizgileri, hacim
src/viewer.ts        three.js görünümü (etiketler CSS2DRenderer ile)
src/io.ts            Proje dosyası doğrulama, OBJ/MTL ve ZIP dışa aktarım
src/ui.ts, main.ts   Paneller, araç çubuğu, komut konsolu
server/api.ts        /api/status, /api/nl → Claude (API ya da claude -p; yapılandırılmış JSON çıktı)
server/bridge.ts     Claude Code köprüsü (/api/bridge) · scripts/p3d.ts köprü CLI'si
scripts/launch.ts    npm run dev / npm start açılış parametreleri
```

## Bilinen sınırlamalar

- Boolean işlemler (delik açma, kesme) yok; basit delikler için boru şekli kullanılabilir.
- Görünümde sürükleyerek taşıma (gizmo) yok; konum komutla ya da panelden girilir.
- Pah/yuvarlatma, metin ve vida dişi yok; dışa aktarım yalnızca OBJ.
- Claude modu API anahtarıyla henüz uçtan uca denenmedi (`claude-cli` yolu ve köprü denendi).

Tam liste, doğrulama durumu ve yol haritası: [`docs/STATUS.md`](docs/STATUS.md).

## Geliştiriciler ve yapay zekâ ajanları için

| Dosya | İçerik |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Mimari, değişmezler (koordinatlar, tek değişiklik yolu, Claude entegrasyonu), yeni işlem/şekil/ayrıştırıcı kalıbı ekleme adımları, test yazma |
| [`CLAUDE.md`](CLAUDE.md) | Claude Code için giriş noktası; `AGENTS.md` ve `docs/STATUS.md`'yi içe aktarır |
| [`docs/STATUS.md`](docs/STATUS.md) | Güncel durum: tamamlananlar, neyin nasıl doğrulandığı, bilinen sorunlar, öncelikli yol haritası |

Bir değişikliği bitirmeden önce `npm run typecheck` ve `npm test` temiz olmalı; bitirdiğinizde `docs/STATUS.md`'yi güncelleyin.
