# İşlemler (Op) başvurusu

İşlemler bir JSON dizisi olarak gönderilir: sekmeye `p3d ops` (stdin ya da `--ops dosya.json`), dosyaya `p3d apply --file`.
Kaynak tanım: P3D deposunda `shared/ops.ts` → `Op`. Her liste tek geri-al adımıdır; hatalı işlem uygulanmaz, diğerleri uygulanır.

Ortak alanlar: `part` parça adı (ya da kimliği; birçok işlemde **grup adı** da olur), `position`/`near`/`pivot`/`offset`
`{x, y, z}` mm, `params` dizisi `[{name, value, mode?: 'set'|'add'|'mul'}]`. Koordinat kuralları: `p3d guide modeling`.
`opacity` (saydamlık, yalnızca görünüm/malzeme) ve `resolution` (parça başına yuvarlak yüzey segmenti): `p3d guide modeling` →
"Saydamlık" (saydamlık = 1 − opaklık) ve "Parça çözünürlüğü"; aralık dışı değer işlem hatasıdır.

| İşlem | Alanlar | Not |
|---|---|---|
| `create` | `shape`, `name?`, `params?`, `position?` (merkez; null = tablaya otomatik), `rotation?` (derece), `color?` (`#rrggbb`), `place_on?`, `geom?`, `role?` (`solid`/`hole`/`reference`), `cuts?`, `opacity?` (opaklık 0–1; null = opak; referans/delikte 1 = opak), `resolution?` (6–192; null/0 = proje ayarı; yuvarlak olmayan şekilde uyarıyla yok sayılır) | Yeni parça |
| `update` | `part`, `name?`, `params?` (mutlak), `position?`, `rotation?`, `color?`, `visible?`, `geom?`, `role?`, `cuts?` (`["*"]` = hepsi), `opacity?` (1 = opak), `resolution?` (0 = proje ayarı) | Önce tüm alanlar doğrulanır: hata varsa parça hiç değişmez. Konum verilmezse taban ve XY merkezi korunur (çözünürlük değişince merkez yerinde kalır). Grupta yalnızca `color`/`visible`/`opacity` |
| `move` | `part`, `dx`, `dy`, `dz` | Göreli; grup adıyla tüm üyeler |
| `set_position` | `part`, `x?`, `y?`, `z?` | **z tabandır**; yalnızca yerel/köprü |
| `rotate` | `part`, `axis` (`x`/`y`/`z`), `degrees` | Göreli; taban korunur. Grupta üyeler pivot etrafında döner |
| `scale` | `part`, `factor` | Tüm uzunluk parametreleri |
| `place_on` | `part`, `target` | Hedefin üstüne, ortalı |
| `place_beside` | `part`, `target`, `side` (`+x`/`-x`/`+y`/`-y`), `gap` | Aynı taban yüksekliği |
| `drop_to_bed` | `part` | Tablaya indir |
| `place_on_surface` | `part`, `target`, `near`, `offset?` | Yerel +Z yüzey normaline döner |
| `duplicate` | `part`, `new_name?`, `offset?`, `count?` | `count > 1`: offset birikerek (1×…count×), offset zorunlu. Grupta yeni grup |
| `delete` | `part` | Grup adıyla grup ve tüm üyeleri |
| `group` | `name`, `parts?` (üyeleri değiştirir; boş = değişmez), `pivot?` (null: yeni grupta üyelerin kutu merkezi) | Ad parça adlarından farklı olmalı; bir parça tek grupta |
| `ungroup` | `name` | Parçalar kalır |
| `set_pivot` | `group`, `pivot` | Dünya noktası (ör. teker göbeği) |
| `mirror` | `part` (parça ya da grup), `plane` (`x`/`y`/`z`), `at?` (null = 0), `name?` | Aynalanmış **kopya**; geometri de yansır. `hull` ~0,5 mm'ye kadar simetrik. Aynalanmış loft `mirrored` bayrağı taşır; geom'u yeniden yazmak bayrağı düşürür (aslını düzenleyip yeniden aynalayın) |
| `select` | `part` | Arayüz seçimi |
| `view` | `show_names?`, `show_dimensions?`, `show_holes?` | Görünüm anahtarları |
| `import_mesh` | `asset`, `name?`, `role?`, `color?`, `position?` | Yerel; normalde `p3d import dosya.stl` kullanın |
| `sketch_add` | `points` (`[{p, hIn?, hOut?}]`; dünya mm, tutamaçlar `p`'ye göreli; 1–1000), `name?` (""/yok = "Yol N"), `closed?`, `plane?` (`{axis, at}`; yoksa noktalardan), `note?` (≤ 200 karakter) | Eskiz yolu: niyet verisi, geometri üretmez (`p3d guide sketch`). Yalnızca yerel/köprü |
| `sketch_update` | `path` (eskiz adı ya da kimliği), `name?`, `closed?`, `plane?`, `points?` (tümü değişir), `note?` (`""` siler) | Verilmeyen alan değişmez; başka yolun adı hata. Yalnızca yerel/köprü |
| `sketch_move` | `path`, `indices?` (yok/boş = tüm noktalar), `dx`, `dy`, `dz` | Tutamaçlar noktayla gider; tüm yol taşınınca düzlem de kayar. Yalnızca yerel/köprü |
| `sketch_delete` | `path?` (yok/"" = tüm eskiz) | Yalnızca yerel/köprü; komutla: `p3d sketch --clear [ad]` |

## Örnekler
```json
[
  {"op":"create","shape":"box","name":"taban","params":[{"name":"width","value":80},{"name":"depth","value":50},{"name":"height","value":4}],"position":{"x":0,"y":0,"z":2}},
  {"op":"create","shape":"cylinder","name":"ayak","params":[{"name":"diameter","value":6},{"name":"height","value":20}],"position":{"x":-35,"y":-20,"z":-10}},
  {"op":"mirror","part":"ayak","plane":"x","at":0,"name":"ayak_2"},
  {"op":"group","name":"ön_ayaklar","parts":["ayak","ayak_2"],"pivot":null},
  {"op":"mirror","part":"ön_ayaklar","plane":"y","at":0,"name":"arka_ayaklar"},
  {"op":"create","shape":"cylinder","name":"vida_deliği","role":"hole","cuts":["taban"],"params":[{"name":"diameter","value":3.2},{"name":"height","value":6}],"position":{"x":0,"y":0,"z":2}},
  {"op":"create","shape":"sphere","name":"topuz","params":[{"name":"diameter","value":8}],"resolution":8,"opacity":0.5,"place_on":"taban"}
]
```
