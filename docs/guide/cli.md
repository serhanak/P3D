# `p3d` komutları

Her klasörden global `p3d` komutu (P3D deposunda bir kez `npm link`); depo içinde `npm run -s p3d -- <komut>` de olur.
Göreli dosya yolları komutun yazıldığı klasöre göre çözülür. Sunucu adresi `P3D_URL` (varsayılan http://localhost:5173).
Hata olursa çıkış kodu 1.

Çalışma alanı: `--ws <ad>` > `P3D_WS` > üst klasörlerdeki ilk `p3d.json` > kök (`p3d guide workspaces`).

## Sekme gerektirenler (sunucu çalışıyor, alanın sekmesi açık)
| Komut | Ne yapar |
|---|---|
| `status` | Sunucu, alan ve adresi, bağlı sekme, rev, parça sayısı, `p3d.json`, dosya bağı, diğer alanlar |
| `view` | Alanın adresini varsayılan tarayıcıda açar |
| `scene [--full] [--stale]` | Sahne özeti (parça, şekil, parametre, merkez, bbox, renk, grup); `--full` proje JSON'u (stdout yalnızca JSON) |
| `ops [--ops ops.json] [--label "metin"]` | İşlem listesini uygular (ya da stdin); tek geri-al adımı |
| `undo` · `redo` · `fit` | Geri al, yinele, görünümü sığdır |
| `open [dosya] [--force]` | Dosyayı sekmeye yükler (geri alınabilir). Sekmede kaydedilmemiş iş varsa `--force` ister |
| `save [dosya] [--force] [--embed]` | Sekmeyi dosyaya yazar (atomik). Başka dosyaya bağlı sekme / boş sekme / P3D olmayan dosya için korur |
| `snapshot [--views …] [--size 1000x750] [--dims] [--out klasör]` | PNG görüntüler; yolları basar |
| `import <dosya.stl\|obj\|3mf> [--name] [--role solid\|hole\|reference] [--color] [--max-tris 60000] [--keep-position]` | Ağ içe aktarır; dosya yolu parçada `src` olarak saklanır |

## Sekme ya da dosya (`--file m.p3d.json` ile tarayıcısız)
| Komut | Ne yapar |
|---|---|
| `scene --file m.p3d.json [--full]` | Dosyanın sahne özeti |
| `check [--file] [--profile print\|game] [--max-tris N]` | Z-fighting, boolean, boş delik; print: ince parça, tabla; game: üçgen bütçesi, bozuk üçgen |
| `measure [--file] [--parts a,b]` | Kutu, delikli hacim, birleşik hacim, PLA |
| `section --axis x\|y\|z --at v1,v2 [--parts] [--file m.p3d.json \| ağ.stl] [--tol 0.1]` | Kesit çokgenleri |
| `export <çıktı.stl\|3mf\|obj\|glb> [--file] [--parts a,b] [--merge] [--skeleton] [--units m\|mm] [--normals flat\|smooth]` | Dışa aktarım; GLB seçenekleri `p3d guide game` |
| `snapshot --file m.p3d.json [--views] [--size] [--out]` | Görünmez Chrome/Edge ile görüntü (sunucu gerekir; tarayıcı yolu `P3D_CHROME`); ~8 sn |

## Yalnızca dosya
| Komut | Ne yapar |
|---|---|
| `apply --file m.p3d.json [--ops ops.json \| stdin] [--out başka.p3d.json] [--force] [--dry-run] [--new] [--embed] [--label]` | İşlemleri dosyaya uygular; **bir hata varsa dosyayı yazmaz**. `--new` dosya yoksa boş projeyle başlar; `--out` mevcut başka bir dosyaysa `--force` ister |

## Diğer
| Komut | Ne yapar |
|---|---|
| `run <betik> [arg…]` | Betiği P3D'nin TypeScript desteğiyle çalıştırır; betikte `import { … } from 'p3d'` kurulumsuz çalışır (`p3d guide scripts`) |
| `guide [konu]` | Bu rehber; konu yoksa giriş ve konu listesi |
| `skill install` | Kullanıcı düzeyindeki Claude Code skill'ini (`~/.claude/skills/p3d`) kurar/günceller |

## Referans ağlar ve dosyalar
- `import` ettiğiniz ağın dosya yolu parçada saklanır. `save`/`apply` kaynağı varsa ağı **gömmez**, yolu proje dosyasına göre
  göreli yazar (`--embed` ile gömer). Böylece lisanslı/büyük referanslar model dosyasına girmez; dosya taşınırsa kaynak da
  taşınmalı.
- Ağ verisi ne gömülü ne kaynaktan bulunabilen bir dosya açılmaz (yer tutucu küp üretilmez).
- Dosyada gömülü gelen ağ `--embed` olmadan kaydedilse de gömülü kalır. Kaynak dosya içe aktarmadan sonra değişmişse açarken
  "kaynak dosya değişmiş" uyarısı çıkar (gömülü ağ varsa o kullanılır). `export` bir referans ağın kaynağının üzerine yazmaz.
- Okunamayan parça: `check` hata sayar (çıkış 1), `export`/`apply` yazmaz, `scene`/`measure` uyarıyı çıktıda gösterir.
