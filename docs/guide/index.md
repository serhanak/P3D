# P3D kullanım rehberi

P3D, 3D yazıcı parçası (ve düşük poligonlu oyun varlığı) modelleyen bir araçtır: parçalar renkli ve isimli şekillerdir
(kutu, silindir, ekstrüzyon, döndürme, loft, tekne…), delikler boolean ile çıkarılır, sonuç STL/3MF/OBJ/GLB olarak
dışa aktarılır. Bu makinede `p3d` komutuyla her klasörden kullanılır; tarayıcıdaki uygulama canlı görüntüleme/düzenleme içindir.

## İş akışı
1. **Durum:** `p3d status` — sunucu, çalışma alanı, bağlı sekme, `p3d.json`. Sunucu kapalıysa P3D klasöründe `npm run dev`.
2. **Alan ve dosya:** projenizin kökünde `p3d.json` (`{"workspace": "...", "file": "model.p3d.json"}`); alanı `p3d view` ile açın,
   var olan modeli `p3d open` ile yükleyin (`workspaces`).
3. **Belirsizlik ön kontrolü:** çizmeden önce kritik/kozmetik belirsizlikleri çıkarın (`ambiguity`).
4. **Ölçüyü sahneden alın:** `p3d scene` (bbox'lar), gerekirse `section` / `measure`.
5. **Çizin:** `p3d ops` (sekme) ya da `p3d apply --file` (dosya) ya da `p3d run betik.mts` (betik) — işlemler: `ops`,
   kurallar: `modeling`.
6. **Görün ve ölçün:** her anlamlı adımdan sonra `p3d snapshot --out <geçici klasör>` + görüntüye bakın; `measure`, `check`
   (`verify`).
7. **Kaydedin / dışa aktarın:** `p3d save`, `p3d export parca.stl|3mf|glb` (oyun: `game`).
8. **Özetleyin:** ne çizildi, ölçüler, `check` sonucu, varsayımlar ve açık sorular.

## Konular (`p3d guide <konu>`)
| Konu | İçerik |
|---|---|
| `cli` | Tüm komutlar ve bayrakları |
| `ops` | İşlem (Op) başvurusu ve örnekler |
| `modeling` | Koordinatlar, şekiller, serbest biçimler, delikler, z-fighting, referanstan çizme |
| `verify` | Doğrulama döngüsü: snapshot, measure, check, section |
| `ambiguity` | Belirsizlik protokolü ve rapor biçimi |
| `workspaces` | Çalışma alanları, `p3d.json`, open/save, birden çok oturum |
| `scripts` | `p3d run` ve `import from 'p3d'` ile betikle üretim |
| `game` | GLB, Unreal, düşük poligon, gruplar/pivot, ayna |

## Temel kurallar
- Kör çizmeyin; bitince `check` temiz olsun.
- Başka bir çalışma alanına (özellikle kök `/`) işlem göndermeyin.
- Model dosyalarını kullanıcı istemedikçe repoya commit'lemeyin.
- P3D'de eksik ya da hata görürseniz P3D'yi bu projeden değiştirmeyin; kullanıcıya bildirin.
