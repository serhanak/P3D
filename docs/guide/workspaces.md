# Çalışma alanları ve model dosyaları

## Çalışma alanı (ws)
- Bir P3D sunucusu (:5173) birden çok çalışma alanı barındırır. Kök `/` kullanıcının kişisel alanıdır; her proje kendi alanında
  çalışır: `http://localhost:5173/w/<ad>` (`p3d view` tarayıcıda açar).
- Her alanın kendi sekmesi, sahnesi ve otomatik kaydı vardır (kök: localStorage, diğerleri: IndexedDB). Komutlar yalnızca o
  alanın **en son bağlanan** sekmesine gider; alanda bağlı sekme yoksa komut 409 ile açılacak adresi söyler.
- Ad: 1–64 karakter; harf/rakam (Türkçe dahil), `_`, `-`, `.`.
- **Başka bir projenin alanına ya da köke işlem göndermeyin.**

## Alan seçimi
Öncelik: `--ws <ad>` > `P3D_WS` ortam değişkeni > çalışılan klasörden yukarı doğru aranan ilk `p3d.json` > kök.
Git Bash `/` yolunu çevirdiği için kökü açıkça seçmek gerekirse `--ws ""` yazın.

```json
// <proje>/p3d.json  (ya da alt klasörde, ör. tasarım başına bir tane)
{ "workspace": "canta-v2", "file": "model.p3d.json", "onAmbiguity": "ask-critical" }
```
- `file` p3d.json'ın klasörüne göredir; `open` / `save` dosya verilmezse bunu kullanır (yalnızca seçili ws p3d.json'ınki ise).
- `onAmbiguity`: `ask-critical` (varsayılan) | `assume` | `ask-all` — `p3d guide ambiguity`.

## Doğruluk kaynağı: dosya mı sekme mi
Modelin asıl kaynağı `.p3d.json` dosyası (ya da onu üreten betik); sekme canlı görüntüleme/düzenleme içindir. Bir anda biri
esastır, ikisi açık komutlarla aktarılır:
- `p3d open [dosya]` — dosyayı sekmeye yükler. **Geri alınabilir**: önceki içerik `p3d undo` ile döner.
- `p3d save [dosya]` — sekmedeki projeyi dosyaya yazar; sekmede dosya bağı kurulur.
- Sekmenin rozeti `<ws> · <dosya> ●` gösterir; ● kaydedilmemiş değişiklik demektir (`p3d status` de söyler).
- Tarayıcısız çalışma (sekme gerekmez): `p3d apply|check|measure|export --file model.p3d.json` — `p3d guide cli`.

## Başka oturumlarla birlikte
- İşe `p3d status` ile başlayın: alan, bağlı sekme, rev (her sahne değişikliğinde artar), parça sayısı, dosya bağı.
- `scene` çıktısının başındaki `rev` ve saat, sahnenin taze olduğunu gösterir.
- Model dosyalarını kullanıcı istemedikçe repoya commit'lemeyin.
