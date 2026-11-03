# P3D — Doğal dille 3D yazıcı parçası tasarımı (MVP)

Tarayıcıda çalışan, parçaları **Türkçe komutlarla** oluşturup değiştirebildiğiniz basit bir 3D modelleme aracı.
Parçalar renkli ve isimlidir, ölçüler 3B görünümde gösterilir; serbest profiller (ekstrüzyon, döndürme, loft),
delikler ve içe aktarılan ağlarla çalışılabilir. Proje kaydedilip yüklenir ve 3D yazıcı için **3MF / STL / OBJ**
olarak dışa aktarılır.

## Kurulum ve çalıştırma

Gerekenler: Node 22+, git; görünmez görüntü alma (`p3d snapshot --file`) için Chrome, Chromium ya da Edge.

**Yeni bilgisayarda (bir kez):**

```bash
git clone https://github.com/serhanak/P3D.git && cd P3D
npm install
npm link             # global `p3d` komutu: her klasörden p3d status, p3d dev, p3d guide …
p3d skill install    # Claude Code kullanıcı skill'i → ~/.claude/skills/p3d (bu makinedeki P3D yolu yazılır)
p3d status           # sunucu, skill, çalışma alanı durumu
```

- Linux/macOS'ta npm'in global klasörü sistem dizinindeyse `npm link` sudo ister; nvm kullanın ya da
  `npm config set prefix ~/.npm-global` (ve `~/.npm-global/bin`'i PATH'e ekleyin).
- Tarayıcı bulunamazsa yolunu `P3D_CHROME` ile verin (ör. `export P3D_CHROME=/usr/bin/chromium`).
- Claude modu için `.env` (aşağıda) gerekiyorsa `cp .env.example .env`.

**P3D güncellenince:** `git pull && npm install`; skill kaynağı değiştiyse `p3d status` "Skill: GÜNCEL DEĞİL" der →
`p3d skill install`. Ayrıntılı kullanım kuralları (`p3d guide`) doğrudan depodan okunduğu için ayrıca kurulmaz.

**Çalıştırma:**

```bash
npm run dev          # http://localhost:5173 (yalnızca yerel ayrıştırıcı; API anahtarı varsa Claude da açık)
p3d dev              # aynısı, ama her klasörden (sunucu zaten çalışıyorsa söyler)
npm run dev:claude   # serbest komutlar bu bilgisayardaki Claude Code hesabınızla (bkz. Claude modu)
```

### Başka projelerden kullanım (Claude Code)

Başka bir depodaki Claude Code oturumu P3D'yi `p3d` komutuyla kullanır; kurulu skill (`p3d skill install`) oturuma
P3D'yi tanıtır ve `p3d guide`'a yönlendirir.

- Projenin kökünde `p3d.json`: `{"workspace": "<ad>", "file": "model.p3d.json", "onAmbiguity": "ask-critical"}`. Proje
  kendi çalışma alanında (`http://localhost:5173/w/<ad>`) çalışır; kök `/` sizin kişisel alanınızdır ve P3D dışından
  alan seçilmeden köke işlem gitmez.
- Tarayıcısız çalışma: `p3d apply|check|measure|export|snapshot --file model.p3d.json`; betikle üretim:
  `p3d run betik.mts` (betikte `import { applyOps, THREE } from 'p3d'`, kurulum gerekmez).
- Oyun varlıkları: `p3d export araba.glb [--skeleton]`, `p3d check --profile game` (`p3d guide game`).
- Kullanım rehberi: [`docs/guide/`](docs/guide/index.md) (`p3d guide [konu]`); tasarım kararları:
  [`docs/EXTERNAL-USE.md`](docs/EXTERNAL-USE.md).

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
- **Köprü**: açık sekme sahnesini sunucuya bildirir; terminaldeki Claude Code `p3d scene` ile
  sahneyi okur, `p3d ops` ile işlem gönderir (depo içinde `npm run -s p3d -- …` de olur). Değişiklikler sekmede canlı görünür, günlükte
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
| Dışa aktarım | **3MF** (renkli, parça başına nesne) · STL · OBJ · OBJ+MTL (ZIP) · her parça ayrı OBJ · seçili parça · **Birleştir** (örtüşen katılar tek gövde STL/3MF). Delikler uygulanmış son geometri çıkar |
| Delik açma | “tabana 5 mm çaplı delik aç”, “… 8 mm derinliğinde”; ya da herhangi bir parçanın **Rol**ünü *Delik* yapın: kesiştiği katılardan çıkarılır (manifold-3d). Panelde **Keser** alanıyla yalnızca belirli parçaları kesmesi sağlanır (`cuts`) |
| Serbest biçimler | **Ekstrüzyon** (2B profil + boşluklar; `frame` ile çerçeve/pervaz), **Döndürme** (profil eksen etrafında), **Loft** (kesitler arası yüzey; `smooth` ile pürüzsüz, `sharp` köşeler, uçta tek nokta). Panelde geometri JSON olarak düzenlenir |
| Tekne / gövde | **Tekne** (`hull`, endaze tablosu): istasyon başına omurga, küpeşte ve yarı genişlikler; yüzeyi uygulama üretir, küpeşte/taban/ayna keskin, uçlar sivrilir — tekne, kano, gövde |
| Yüzeye oturtma | `place_on_surface`: parça, başka bir parçanın (eğri) yüzeyine dik oturur — flanş, perçin, düğme |
| Ağ içe aktarma | **İçe aktar…** ile STL / OBJ / 3MF; katı, delik ya da yarı saydam **referans** olarak (gerekirse sadeleştirilir) |
| Gruplar, ayna, dizi | `group` (pivot = dönme merkezi), `mirror` (geometri de yansır), `duplicate` + `count` (sıra halinde kopyalar) |
| Oyun motoru (GLB) | **GLB** dışa aktarım (Y-yukarı/metre, düz ya da yumuşak normal, grup düğümleri; **GLB + iskelet** Unreal araç fiziği için), düşük poligon (6 segmentten), tabla 20 m'ye kadar |

Şekiller: kutu, silindir, boru (iç/dış çap), koni (kesik koni), küre, torus, prizma (altıgen vb.), ekstrüzyon,
döndürme, loft, tekne (endaze), mesh. Roller: katı (varsayılan), delik, referans (dışa aktarılmaz).
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
tabana 5 mm çaplı delik aç · milin üstüne 3 mm çaplı 8 mm derinliğinde delik aç
kutuyu delik yap · modeli referans yap · delikleri gizle
isimleri gizle · ölçüleri göster · geri al
```

Komut kutusuna `yardım` yazarak listeyi görebilirsiniz; ↑/↓ önceki komutları getirir.

### Örnek projeler

[`examples/`](examples/) klasöründe **Aç…** ile yüklenebilecek hazır projeler var; ör.
[`3dbenchy.p3d.json`](examples/3dbenchy.p3d.json) — 3DBenchy (CC0); orijinalden ölçülerek tamamen uygulamanın kendi
şekilleriyle kuruldu (tekne şekli, çerçeveli kapı/pencere, delikler, döndürme baca), hacmi orijinalden %1,9 farklı.
Nasıl çizildiği: [`examples/README.md`](examples/README.md).

### Terminalden yapay zekâ ile tasarım ve doğrulama

Köprü açıkken (`npm run dev` / `p3d dev`) Claude Code (ya da siz) terminalden çalışan sekmeyi okuyup değiştirebilir
(tam liste: `p3d guide cli`; çoğu komut `--file model.p3d.json` ile sekmesiz de çalışır):

```bash
p3d scene                       # parça listesi, kutular, roller
p3d ops < islemler.json         # işlem uygula (tek geri-al adımı)
p3d snapshot --views iso,front,top --out ./goruntu   # PNG görüntüler (dik izdüşüm + izometrik)
p3d measure                     # parça başına kutu ve delikli hacim, birleşik toplam hacim
p3d check                       # çakışan yüzeyler (z-fighting), boolean hataları, ince parça, tabla teması
p3d section --axis x --at -10,0,10        # sahnede kesit çokgenleri
p3d section --file ref.stl --axis z --at 5  # bir dosyada kesit (sahne gerekmez)
p3d import ref.stl --role reference --keep-position   # referans ağ
```

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
src/geom.ts          Ekstrüzyon / döndürme / loft: doğrulama ve kapalı ağ üretimi
src/csg.ts, model.ts Delik (boolean, manifold-3d), kesit; parçanın delikli son geometrisi
src/meshio.ts        STL / OBJ / 3MF okuma ve STL / 3MF yazma
src/viewer.ts        three.js görünümü (etiketler CSS2DRenderer ile), görüntü alma
src/io.ts            Proje dosyası doğrulama, OBJ/MTL, ZIP, dışa aktarım
src/ui.ts, main.ts   Paneller, araç çubuğu, komut konsolu
server/api.ts        /api/status, /api/nl → Claude (API ya da claude -p; yapılandırılmış JSON çıktı)
server/bridge.ts     Claude Code köprüsü (/api/bridge) · scripts/p3d.ts köprü CLI'si
scripts/launch.ts    npm run dev / npm start açılış parametreleri
```

## Bilinen sınırlamalar

- Görünümde sürükleyerek taşıma (gizmo) yok; konum komutla ya da panelden girilir.
- Keyfi kenarlarda yuvarlatma, metin ve vida dişi yok (pah, profil içinde çizilebilir).
- Claude modu API anahtarıyla henüz uçtan uca denenmedi (`claude-cli` yolu ve köprü denendi).

Tam liste, doğrulama durumu ve yol haritası: [`docs/STATUS.md`](docs/STATUS.md).

## Geliştiriciler ve yapay zekâ ajanları için

| Dosya | İçerik |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Mimari, değişmezler (koordinatlar, tek değişiklik yolu, Claude entegrasyonu), yeni işlem/şekil/ayrıştırıcı kalıbı ekleme adımları, test yazma |
| [`CLAUDE.md`](CLAUDE.md) | Claude Code için giriş noktası; `AGENTS.md` ve `docs/STATUS.md`'yi içe aktarır |
| [`docs/STATUS.md`](docs/STATUS.md) | Güncel durum: tamamlananlar, neyin nasıl doğrulandığı, bilinen sorunlar, öncelikli yol haritası |

Bir değişikliği bitirmeden önce `npm run typecheck` ve `npm test` temiz olmalı; bitirdiğinizde `docs/STATUS.md`'yi güncelleyin.
