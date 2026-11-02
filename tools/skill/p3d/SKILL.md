---
name: p3d
description: P3D ile 3D yazıcı parçası ya da düşük poligonlu oyun varlığı (GLB) tasarla, ölç, kontrol et ve dışa aktar. Kullanıcı bir parça, muhafaza, kutu, braket, kapak, araç/pist parçası çizdirmek; STL/3MF/OBJ/GLB üretmek; referans bir STL'den ölçerek model kurmak ya da bir .p3d.json modelini düzenlemek istediğinde kullan. Use for designing printable parts or low-poly game assets with the local P3D modeler.
---

# P3D

P3D bu makinede çalışan, Türkçe doğal dille parça modelleme aracıdır (depo: `C:\Users\serha\Projects\P3D`). Her klasörden
global `p3d` komutuyla kullanılır. **Bu dosya yalnızca giriş kapısıdır; ayrıntılar kurulu sürümle eşleşen rehberdedir.**

## Başlarken
1. `p3d status` → sunucu, çalışma alanı, bağlı sekme, `p3d.json`. Sunucu kapalıysa kullanıcıya P3D klasöründe `npm run dev`
   başlatmasını önerin (ya da arka planda: `npm --prefix C:/Users/serha/Projects/P3D run dev`).
2. **Önce rehberi okuyun:** `p3d guide` (iş akışı ve konu listesi), sonra işe göre `p3d guide <konu>`:
   `cli`, `ops`, `modeling`, `verify`, `ambiguity`, `workspaces`, `scripts`, `game`.
3. Çalışma alanı: proje kökünde `p3d.json` yoksa kullanıcıya sorup oluşturun:
   `{ "workspace": "<proje-adı>", "file": "<model>.p3d.json", "onAmbiguity": "ask-critical" }`. Kök alan (`/`) kullanıcının
   kişisel alanıdır; başka projeler kendi `/w/<ad>` alanında çalışır (`p3d view` tarayıcıda açar).

## Kurallar
- **Belirsizlik protokolü** (`p3d guide ambiguity`): çizmeye başlamadan kritik/kozmetik belirsizlikleri çıkarın; varsayılan
  `ask-critical` — kritikte durup sorun, kozmetikte varsayın ve raporlayın.
- **Model dosyada yaşar:** `p3d open` (dosya → sekme), `p3d save` (sekme → dosya); tarayıcısız `p3d apply|check|measure|export
  --file model.p3d.json`. Betikle üretim: `p3d run betik.mts` (`import { applyOps } from 'p3d'`).
- **Kör çizmeyin:** anlamlı her adımdan sonra `p3d snapshot --out <scratchpad>` ve görüntüye Read ile bakın; bitince
  `p3d check` temiz olsun (oyun için `--profile game`).
- Eğri/eğik yüzey: `extrude` / `revolve` / `loft` / `hull`; delik: `role: "hole"` + `cuts`. Ham mesh üretmeyin.
- Model dosyalarını kullanıcı istemedikçe repoya commit'lemeyin.
- Başka bir çalışma alanına (özellikle kök `/`) işlem göndermeyin; P3D'nin kaynak kodunu bu projeden değiştirmeyin — araçta
  eksik ya da hata görürseniz kullanıcıya bildirin.
- Sonucu kullanıcıya kısa özetleyin: ne çizildi, ölçüler, `check` sonucu, varsayımlar ve açık sorular.
