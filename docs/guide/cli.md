# `p3d` komutları

Her klasörden global `p3d` komutu (P3D deposunda bir kez `npm link`); depo içinde `npm run -s p3d -- <komut>` de olur.
Göreli dosya yolları komutun yazıldığı klasöre göre çözülür. Sunucu adresi `P3D_URL` (varsayılan http://localhost:5173).
Hata olursa çıkış kodu 1. Komut yardımı: `p3d <komut> --help` (ya da `-h`, `p3d help <komut>`); sunucu ve sekme gerektirmez.

Çalışma alanı: `--ws <ad>` > `P3D_WS` > üst klasörlerdeki ilk `p3d.json` > kök (`p3d guide workspaces`).

## Sekme gerektirenler (sunucu çalışıyor, alanın sekmesi açık)
| Komut | Ne yapar |
|---|---|
| `status` | Sunucu, kurulu skill güncel mi, alan ve adresi, bağlı sekme, rev, parça sayısı, `p3d.json`, dosya bağı, diğer alanlar |
| `view` | Alanın adresini varsayılan tarayıcıda açar |
| `scene [--full] [--stale]` | Sahne özeti (parça, şekil, parametre, merkez, bbox, renk, grup, ayarlıysa `opaklık=` ve `çözünürlük=`; bbox şeklin kesimsiz kutusu); `--full` proje JSON'u (stdout yalnızca JSON) |
| `ops [--ops ops.json] [--label "metin"]` | İşlem listesini uygular (ya da stdin); tek geri-al adımı |
| `undo` · `redo` · `fit` | Geri al, yinele, görünümü sığdır |
| `open [dosya] [--force]` | Dosyayı sekmeye yükler (geri alınabilir). Sekmede kaydedilmemiş iş varsa `--force` ister |
| `save [dosya] [--force] [--embed]` | Sekmeyi dosyaya yazar (atomik). Başka dosyaya bağlı sekme / boş sekme / P3D olmayan dosya için korur |
| `snapshot [--views …] [--size 1000x750] [--dims] [--out klasör] [--style shaded\|wire\|xray] [--projection perspective\|ortho] [--eye x,y,z] [--target x,y,z] [--fov 50] [--eye-height 1000] [--parts a,b \| --focus a,b]` | PNG görüntüler; yolları basar. Kenar 200–4096 piksel: uzun kenar aşarsa iki kenar orantılı küçültülür ve uyarılır; bilinmeyen görünüm ya da biçim hata. Perspektif: `--eye` → `camera.png` (verilen konumdan `--target`'a, yoksa kutu merkezine), `--eye-height` ya da `--views eye` → `eye.png` (göz hizası). `--style`: `shaded` gölgeli (varsayılan; sekmedeki biçimden bağımsız), `wire` tel kafes (her üçgen kenarı, arkadakiler gizli), `xray` X-ışını (arkadakiler dahil tüm kenarlar, parça renginde). `--projection ortho`: `iso` ve `camera` da dik izdüşüm (varsayılan `perspective`: iso perspektif, dik görünümler orto); `eye` ve `--fov` ile hata; ortoda `camera`'da `--target` yalnızca bakış yönünü verir, çerçeve görünür kutuya oturur. **Odak:** `--parts a,b` yalnızca bu parçaları çizer ve kadraja alır (diğerleri, delikler ve eskiz gizli; montajın içindeki parça da görünür); `--focus a,b` kadrajı bunlara daraltır, diğer parçalar bağlam olarak çizilir (önde kalan parça örtebilir). Adlar parça ya da grup adıdır (büyük/küçük harf ve aksan duyarsız; grup tüm görünür üyeleri); bulunamayan ad hata; ikisi birlikte verilmez. Basılan kutu satırı seçimin kutusudur |
| `import <dosya.stl\|obj\|3mf\|glb> [--name] [--role solid\|hole\|reference] [--color] [--max-tris N] [--keep-position]` | Ağ içe aktarır; dosya yolu parçada `src` olarak saklanır. `--max-tris` varsayılanı GLB'de 1 000 000 (oyun varlığının üçgen topolojisi korunur), STL/OBJ/3MF'te 60 000 |

## Sekme ya da dosya (`--file m.p3d.json` ile tarayıcısız)
`scene`, `snapshot`, `measure`, `check`, `section` ve `sketch` (yalnızca listeleme; ağda eskiz yoktur) `--file` ile bir **ağ dosyası** da alır (`.glb`, `.stl`, `.obj`, `.3mf`; `.gltf`
metin biçimi desteklenmez): bellekte tek ağ parçalı bir proje kurulur (ad = dosya adı, parça dosyadaki yerinde, sınır `import` ile
aynı varsayılan; `section` ham üçgenleri okur). İçe aktarma gerekmez; ağ dosyasına hiçbir şey yazılmaz: `apply`, `export` ve
`sketch --clear` ağ dosyasını reddeder. `scene --full --file ağ.glb` proje JSON'unu kaynak yolu (`src`) **mutlak** yazarak basar (çıktı
başka klasöre kaydedilebilir). GLB eksen/birim dönüşümü `export`'un tersidir (Y yukarı, metre → Z yukarı, mm). Draco/meshopt
sıkıştırmalı, nicemlenmiş konumlu, seyrek erişimcili ya da harici tamponlu GLB okunmaz (açıklayıcı hata); `EXT_mesh_gpu_instancing`
örnekleri ayrı kopyalar olarak okunur.

| Komut | Ne yapar |
|---|---|
| `scene --file m.p3d.json\|ağ.glb [--full]` | Dosyanın sahne özeti (ağda üçgen sayısı ve kutu) |
| `check [--file] [--profile print\|game] [--max-tris N] [--cull-hidden]` | Z-fighting, boolean, boş delik; print: ince parça, tabla; game: üçgen bütçesi, bozuk üçgen. `--cull-hidden` (yalnızca game): bütçe gizli üçgenler atılmış sayıyla (`export --cull-hidden` çıktısı); verilmezse bütçe aşımında atılabilecek gizli üçgen sayısı söylenir |
| `measure [--file] [--parts a,b]` | Delikler çıkarılmış kutu ve hacim, birleşik hacim, PLA (kaplamalar varsayılan kümede yok; `--parts` ile hacim 0) |
| `section --axis x\|y\|z --at v1,v2 [--parts] [--file m.p3d.json \| ağ.stl\|glb] [--tol 0.1]` | Kesit çokgenleri (kaplamalar kalınlıksız: varsayılan kümede yok, `--parts` ile "kesit yok" notu) |
| `export <çıktı.stl\|3mf\|obj\|glb> [--file] [--parts a,b] [--merge] [--skeleton] [--units m\|mm] [--normals flat\|smooth] [--cull-hidden]` | Dışa aktarım; GLB seçenekleri (`--cull-hidden`: hiç görünmeyen iç yüzleri at) `p3d guide game`. Kaplamalar (`decal`) GLB/OBJ'ye girer, STL/3MF'te uyarıyla atlanır |
| `sketch [--file] [--json] [--sample 8]` · `sketch --clear [ad] [--file] [--label]` | Kullanıcının ekranda çizdiği eskiz yollarını listeler (tür, nokta, düzlem, kutu, not; `--json` sahne özetindeki gibi, stdout yalnızca JSON) / adı verilen yolu ya da (ad yoksa) tüm eskizi siler; dosyada hata varsa yazmaz (`p3d guide sketch`) |
| `snapshot --file m.p3d.json\|ağ.glb [--views] [--size] [--style] [--projection] [--out] [--eye …]` | Görünmez Chrome/Edge ile görüntü (tarayıcı yolu `P3D_CHROME`); çalışan P3D sunucusu varsa onu kullanır, yoksa komutun süreci içinde geçici sunucu açıp kapatır (`not:` satırı); ~3–8 sn. Betikte aynısı: `snapshot()` (`p3d guide scripts`). Oyun varlığının üçgenleri: `snapshot --file araba.glb --style wire` |

## Yalnızca dosya
| Komut | Ne yapar |
|---|---|
| `apply --file m.p3d.json [--ops ops.json \| stdin] [--out başka.p3d.json] [--force] [--dry-run] [--new] [--embed] [--label]` | İşlemleri dosyaya uygular; **bir hata varsa dosyayı yazmaz**. `--new` dosya yoksa boş projeyle başlar; `--out` mevcut başka bir dosyaysa `--force` ister |

## Diğer
| Komut | Ne yapar |
|---|---|
| `run <betik> [arg…]` | Betiği P3D'nin TypeScript desteğiyle çalıştırır; betikte `import { … } from 'p3d'` kurulumsuz çalışır (`p3d guide scripts`) |
| `dev [--port N …] [--detach]` | P3D sunucusunu (`npm run dev`) hangi klasörden çağrılırsa çağrılsın P3D deposunda başlatır; zaten çalışıyorsa söyler. Ön planda uzun süre çalışır (Claude Code'da arka planda başlatın; çıktısı boruya bağlanırsa — `\| head` — boru kapanınca sunucu da kapanır). `--detach`: terminalden bağımsız başlatır, `/api/status` yanıt verince döner (~3 sn); çıktı geçici klasörde `p3d-dev-<port>.log`, PID `p3d-dev-<port>.json`; oturum kapansa da çalışır, `p3d stop` ile durdurun |
| `stop [--port N]` | Portta (varsayılan `P3D_URL`'nin portu, 5173) çalışan P3D sunucusunu durdurur: ayrık başlatılanın süreç ağacı ve portu dinleyen süreç (ön planda başlatılan, yetim kalan `npm run dev` alt süreci; Windows `taskkill /T`). Yalnızca `/api/status`'ü P3D gibi yanıtlayan sunucu durdurulur; sunucu yoksa söyler (çıkış 0) |
| `guide [konu]` | Bu rehber; konu yoksa giriş ve konu listesi |
| `skill install` | Kullanıcı düzeyindeki Claude Code skill'ini (`~/.claude/skills/p3d`) kurar/günceller; içine bu makinedeki P3D yolunu yazar. P3D güncellenip skill kaynağı değişince yeniden çalıştırın (`status` uyarır) |

## Referans ağlar ve dosyalar
- `import` ettiğiniz ağın dosya yolu parçada saklanır. `save`/`apply` kaynağı varsa ağı **gömmez**, yolu proje dosyasına göre
  göreli yazar (`--embed` ile gömer). Böylece lisanslı/büyük referanslar model dosyasına girmez; dosya taşınırsa kaynak da
  taşınmalı.
- Ağ verisi ne gömülü ne kaynaktan bulunabilen bir dosya açılmaz (yer tutucu küp üretilmez).
- Dosyada gömülü gelen ağ `--embed` olmadan kaydedilse de gömülü kalır. Kaynak dosya içe aktarmadan sonra değişmişse açarken
  "kaynak dosya değişmiş" uyarısı çıkar (gömülü ağ varsa o kullanılır). `export` bir referans ağın kaynağının üzerine yazmaz.
- Okunamayan parça: `check` hata sayar (çıkış 1), `export`/`apply` yazmaz, `scene`/`measure` uyarıyı çıktıda gösterir.
