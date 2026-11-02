# Belirsizlik protokolü

Bir parça/model isteğini (iş tanımı, brief) işlemeden önce uygulanır; doğrudan kullanımda da, işi devralan bir alt ajanda da
aynıdır.

## 1. Ön kontrol (her zaman, iş başlamadan)
İş tanımını ve sahneyi okuyun (`p3d scene` ya da `--file`). Eksik, çelişkili ya da birden çok anlama gelen her noktayı
numaralayın ve sınıflandırın:

- **Kritik** — geometri, uyum ya da işlevi değiştirir: ölçü, tolerans/boşluk, geçme, hangi yüz/kenar, başka parçaya bağlantı,
  vida/delik standardı, dışa aktarım birimi/biçimi, hedef (baskı mı oyun mu).
- **Kozmetik** — sonucu bozmaz: renk, ad, pah/yuvarlatma yarıçapı, tabla yerleşimi, yüzey çözünürlüğü.

## 2. Mod
Proje varsayılanı `p3d.json` → `onAmbiguity`; istekte açıkça belirtilirse o geçerlidir (`--on-ambiguity`).

| Mod | Kritik | Kozmetik |
|---|---|---|
| `ask-critical` (varsayılan) | **Dur ve sor** (hiçbir şey çizmeden soru listesini döndürün) | Makul varsayımla devam |
| `assume` | Makul varsayımla devam | Makul varsayımla devam |
| `ask-all` | Dur ve sor | Dur ve sor |

Varsayım yaparken: değeri, gerekçeyi ve alternatifleri kaydedin; iş tanımındaki açık ifade her zaman çıkarımdan önce gelir.

## 3. İş ortasında çıkan çelişki
Sessizce bir yol seçmeyin.
- Soran modlarda: kısmi işi **ayrı** bir dosyaya/çalışma alanına yazın (var olanın üzerine yazmayın), durun ve sorun.
- `assume` modunda: iş tanımındaki açık ifadeyi uygulayın, durumu raporda "çelişki" olarak bildirin.

## 4. Rapor
Kısa bir özet + aşağıdaki yapı (alt ajanda JSON olarak):

```json
{
  "done": ["gövde 120×80×40 çizildi", "check temiz"],
  "assumptions": [{ "id": 1, "kind": "cosmetic", "chosen": "köşe pahı 1 mm", "alternatives": ["0,5 mm", "pahsız"] }],
  "questions": [{ "id": 2, "kind": "critical", "question": "M3 vida delikleri geçme mi kılavuz mu?", "options": ["3,2 mm geçme", "2,5 mm kılavuz"] }],
  "conflicts": [],
  "files": ["C:/…/model.p3d.json", "C:/…/iso.png"]
}
```

Kullanıcı soruları numarayla yanıtlayabilir ("2: 3,2 mm"); yanıt geldiğinde aynı bağlamda devam edin.
