# P3D'yi başka projelerden kullanmak — tasarım notu

> 2026-11-01. Kullanıcıyla ve paralel bir P3D oturumuyla (P3D-Fable) tartışılarak kararlaştırıldı. Uygulama durumu
> aşağıdaki adım listesinde; genel durum için [`STATUS.md`](STATUS.md).

## Amaç ve kısıtlar

- Bu makinedeki **başka klasörlerde çalışan Claude Code oturumları** P3D ile parça tasarlayabilsin, kontrol/ölçüm yapabilsin,
  dışa aktarabilsin. (Claude Desktop sohbeti kapsam dışı; gerekirse ileride MCP.)
- P3D aktif olarak geliştirilmeye devam ediyor; geliştirme diğer projelerdeki kullanımı bozmamalı. Bakım ve yeniden
  taşıma yükü düşük olmalı.
- Bilinen tüketiciler:
  - **VibroBal** (`C:\Users\serha\Projects\VibroBal\enclosure`): `gen.mjs` Op listesi üretir, `build.mts` P3D'nin iç
    modüllerini göreli yolla içe aktarıp check / çarpışma / baskı grubu STL'i yapar. Yaşanan tuzak: `scene` çıktısı eski
    ya da başka sekmeden gelebiliyor.
  - **Araba yarışı oyunu** (yakında): motor şimdilik Unreal, prototip/MVP düşük poligonlu, tarayıcı şart değil.

## İlkeler

1. **Dosya merkezli, sekme = görüntüleyici.** Modelin asıl kaynağı bir `.p3d.json` (ya da onu üreten betik); kontrol,
   ölçüm, işlem uygulama ve dışa aktarım Node'da, tarayıcısız çalışır. Sekme canlı görüntüleme/düzenleme içindir.
   Bir çalışma alanında doğruluk ya dosyadır (headless) ya sekmedir (köprü); ikisi `open` (dosya → sekme) ve
   `save` (sekme → dosya) açık komutlarıyla aktarılır, sessizce karıştırılmaz.
2. **Sözleşme küçük ve testli.** Tüketicilerin dayandığı yüzey: CLI komutları ve çıktı biçimi, Op JSON, `.p3d.json`
   biçimi ve `src/api.ts` dışa aktarımları. Ekleme serbest; kıran değişiklik `parseProject` göçü + sözleşme testi ister.
   İç modüller serbestçe değişir.
3. **Tüketiciler P3D'ye yalnızca `p3d` komutu ve `p3d` paket adıyla erişir**, asla `../../P3D/src/...` göreli yoluyla.
   Böylece kararlı kurulum ayrımı ileride tüketicilere görünmeden yapılabilir.
4. **Bilgi tek yerde.** Kullanım rehberi depoda (`docs/guide/`), `p3d guide` ile yazdırılır; kullanıcı düzeyindeki skill
   incedir ve rehbere yönlendirir; AGENTS.md aynı dosyalara bağlanır.

## Kararlar

| Konu | Karar |
|---|---|
| Çalışma alanı | `http://localhost:5173/w/<ad>`; kök `/` bugünkü gibi. Köprü sahneyi/sekmeleri ws'ye göre ayırır. CLI ws'yi `--ws` ya da çalışılan klasörden yukarı doğru aranan `p3d.json`'dan bulur (`{"workspace": "...", "file": "..."}`). |
| Sunucu tarafı ws dosyası / global kayıt defteri | **Yok** (üçüncü bir doğruluk kaynağı olurdu). Dosya yolu tüketicinin `p3d.json`'ında. |
| Sekmede otomatik kayıt | Kök `/` localStorage (geriye uyum); ws'ler IndexedDB (localStorage'ın ~5 MB kotası tüm ws'lerce paylaşılırdı). Dosya kaynaklı ws'de "kaydedilmemiş değişiklik" göstergesi. |
| Sunucu | Şimdilik tek sunucu, :5173. |
| Kararlı kurulum ayrımı (`~/.p3d/app` worktree :5173, geliştirme :5174, `p3d upgrade`) | **Ertelendi.** Tetikleyici: bir P3D geliştirme oturumunun yarım değişikliği başka bir oturumun işini ilk kez bozduğunda ya da oyun projesi başladığında (hangisi önce). |
| Skill | Kullanıcı düzeyinde ince skill (`~/.claude/skills/p3d`, ~40 satır) + `p3d guide [konu]`. |
| Ajan modu | Skill yetmezse kullanıcı düzeyinde `p3d-designer` alt ajanı. `claude -p` + `--resume` (B) ancak P3D'ye özgü bellek/süreklilik, paralel toplu üretim + maliyet izleme ya da dar izin kapsamı gerekirse. Açık oturuma SendMessage yalnızca ad hoc. |
| Model dosyaları tüketici repolarında | Repolar özel olduğu için genel olarak sorun değil, ama **şimdilik commit'lenmiyor**; her repo için ayrıca değerlendirilecek. |
| İçe aktarılan referans ağlar | Kalıcı dosyaya gömülmek yerine yolla anılabilmeli (ör. VibroBal `pc278/` üretici IP'si, git dışında). Biçim eki — 3. adımda tasarlanacak. |

## Belirsizlik protokolü (skill ve alt ajan ortak)

- **Ön kontrol her modda:** iş tanımı (brief) + sahne okunur; belirsizlikler numaralanır ve ayrılır:
  **kritik** (ölçü, tolerans, geçme/uyum, hangi yüz, bağlantı, dışa aktarım birimi/biçimi) ve **kozmetik** (renk, ad,
  pah, yerleşim, yüzey çözünürlüğü).
- **Modlar:** `ask-critical` (varsayılan: kritikte dur ve sor, kozmetikte varsay) · `assume` (hepsinde varsay, her
  varsayımı değer + alternatiflerle bildir) · `ask-all`. Proje varsayılanı `p3d.json`'da, çağrıda `--on-ambiguity` ile ezilir.
- **İş ortasında çelişki:** sessizce seçilmez. Soran modlarda kısmi iş ayrı dosyaya yazılıp durulur (üzerine yazılmaz);
  `assume`'da brief'teki açık ifade çıkarıma yeğlenir ve "çelişki" olarak raporlanır.
- **Rapor (JSON):** `assumptions[{id, kind, chosen, alternatives}]`, `questions[]`, `done[]`, `files[]`; yanıt "2: 5 mm".

## Oyun gereksinimleri (Unreal, düşük poligon)

- GLB (glTF 2.0) dışa aktarım: standart Y-yukarı / metre (Unreal içe aktarıcısı Z-yukarı / cm'ye çevirir), parça/grup
  başına düğüm, renk → baseColor, düz (flat) normal seçeneği.
- Yuvarlak yüzey çözünürlüğü alt sınırı 32 → düşük poligon için 6–16'ya inmeli.
- `check --profile print|game`: print = tabla teması, ince duvar; game = üçgen bütçesi, dejenere üçgen.
- Gruplama + pivot (teker göbek merkezinde döner), ayna, dizi (yol haritası 2 ve 7 öne çekilir).
- Unreal Chaos Vehicles gövde + teker kemikli **skeletal mesh** ister → "grup = kemik, ağırlık 1" katı iskelet dışa aktarımı
  (gerçek rig/animasyon değil). Godot/Unity'de gerekmez.
- **Kapsam dışı:** UV açma, doku, rig/animasyon, motora özel biçimler, P3D motorunun oyunun çalışma anında kütüphane
  olarak kullanılması (kütüphane yalnızca üretim betikleri için).
- Doğrulanacak: Unreal'in glTF içe aktarımında `UCX_` çarpışma ağı adlandırmasının çalışıp çalışmadığı (FBX'te kesin).

## Adımlar

1. [x] **CLI her klasörden:** `bin/p3d.mjs` + `npm link` → global `p3d`; göreli yollar çağıranın klasörüne göre
   (`npm run p3d` altında `INIT_CWD`). Başka klasörden `npm link p3d` + tsx ile içe aktarma denemesi.
   *Doğrulandı (2026-11-01):* `tests/cli.test.ts`; Git Bash + PowerShell'de başka klasörden `p3d`; ayrı klasörde
   `npm link p3d` sonrası `p3d/src/*.ts` P3D'nin tsx'iyle yüklendi, bağımlılıklar (three, manifold-3d, meshoptimizer)
   P3D'den çözüldü. Açık: tüketici betikleri tsx'i nereden alacak (tüketicide kurulu mu, `p3d run <betik>` mi) → 3. adım.
2. [x] **Eski sahne tuzağı:** sahneye revizyon sayacı + `at`; bağlı sekme yoksa `scene` eski sahneyi uyarıyla değil hatayla döner.
   *Yapıldı (2026-11-02, 4. adımla birlikte):* sekme kimliği, sekme başına sahne, PUT `seq`, `rev`, 409 + açılacak adres.
3. [x] **Tarayıcısız çekirdek:** `src/api.ts` + package.json `exports` (THREE'yi de yeniden dışa aktarır); `apply` /
   `check` / `measure` / `export` / `save` / `open` `--file`; referans ağların yolla anılması; `snapshot --file`
   (makinedeki Chrome'u görünmez açar); VibroBal'ın `p3d` paketine geçişi.
   *Yapıldı (2026-11-02):* tüketici betikleri `p3d run <betik>` ile çalışır; `p3d` adı bir Node çözümleme kancasıyla
   `src/api.ts`'ye gider (tüketicide npm link/tsx gerekmez). VibroBal `build.mts` geçirildi; çıktılar bayt bayt aynı.
4. [x] **Çalışma alanları:** `/w/<ad>`, ws'ye göre köprü, `--ws`, `p3d.json` keşfi, IndexedDB otomatik kayıt.
   *Yapıldı (2026-11-02):* ayrıca `status`/`view`/`open`/`save` (veri kaybı korumalı), bozuk kayıt yedeği, ikinci sekme
   salt okunur. Görünmez Chrome'da gerçek `/w/` sekmesiyle denendi.
5. [x] **Rehber + skill:** `docs/guide/*.md`, `p3d guide`, ince kullanıcı skill'i, belirsizlik protokolü; test: her Op
   tipi ve CLI komutu rehberde geçer. *Yapıldı (2026-11-02):* `p3d skill install` → `~/.claude/skills/p3d`; AGENTS.md
   modelleme/doğrulama kurallarını rehbere devretti, CLAUDE.md `modeling` ve `verify` sayfalarını içe aktarır.
6. [x] **Oyun:** GLB, düz normal, düşük çözünürlük sınırı, `check --profile game`, gruplama/pivot, ayna/dizi; Unreal'de
   kalınırsa katı iskelet dışa aktarımı. *Yapıldı (2026-11-02):* `p3d export x.glb [--skeleton]`; Unreal'e gerçek içe
   aktarım henüz denenmedi (STATUS.md → yol haritası 0).
