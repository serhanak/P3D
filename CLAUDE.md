# CLAUDE.md

Bu projenin ajan rehberi `AGENTS.md`'dedir (Claude Code ve diğer araçlar için ortak); güncel durum ve yol
haritası `docs/STATUS.md`'dedir. İkisini de içe aktarıyoruz:

@AGENTS.md
@docs/STATUS.md

## Claude Code'a özel notlar

- Kullanıcıya Türkçe yanıt verin.
- Bir özelliği bitirdiğinizde `docs/STATUS.md`'yi güncelleyin (yapılanlar, doğrulama durumu, bilinen sorunlar).
- Claude API kodunu değiştirmeden önce `claude-api` becerisini yükleyin; model kimlikleri ve parametreler
  sık değişir, bellekten yazmayın.
- Arayüzü doğrulamak için `npm run dev` arka planda çalıştırılıp tarayıcıda (Claude in Chrome) kontrol edilebilir.
- Kullanıcı bu oturumda bir parça/model tarif ederse ("tabana 4 ayak ekle") kodu değiştirmeyin; AGENTS.md →
  "Kullanıcıyla terminalden tasarlamak" bölümündeki köprüyle (`npm run -s p3d -- scene` / `ops`) açık sekmeye
  işlem gönderin. Önce sahneyi okuyun, ölçüleri bbox'tan hesaplayın, sonucu kısaca Türkçe özetleyin.
- Kör çizmeyin: anlamlı her adımdan sonra `npm run -s p3d -- snapshot --out <scratchpad>` ile görüntü alıp Read
  ile bakın, gerekirse `measure` / `section` ile ölçün. Bir nesneyi orijinaline yakın çizmeniz istenirse referans
  ağı `import --role reference --keep-position` ile alıp `section --file` ile ölçerek çizin (bkz. examples/README.md).
- Eğri/eğik yüzeyleri ilkel şekillerle basamaklamayın; `extrude` / `revolve` / `loft` ve `role: "hole"` kullanın.
- Bir model bittiğinde `npm run -s p3d -- check` çalıştırın; çakışan yüzey (z-fighting) kalmasın. Delikleri `cuts` ile
  hedef parçaya bağlayın.
- Windows'ta `TaskStop` arka plandaki `npm run dev`'in alt node sürecini kapatmayabilir; port meşgul kalırsa
  `Get-NetTCPConnection -LocalPort 5173` ile süreci bulup kapatın.

## Alt ajanlar (`.claude/agents/`)

Ana oturumun bağlamını temiz tutmak için hacimli ve iyi tanımlı işleri devredin; kısa işleri (birkaç araç çağrısı)
kendiniz yapın.

| Ajan | Model | Ne zaman |
|---|---|---|
| `p3d-measurer` | haiku (yorum gerekirse `model: sonnet`) | Referans ağdan/sahneden kesit, kutu, hacim, endaze tablosu; ham döküm yerine ölçü tablosu döner |
| `p3d-implementer` | opus | Kapsamı belli özellik/düzeltme + test; değişen dosya özeti döner |
| `p3d-verifier` | sonnet | Model sonrası `check` + `measure` + `snapshot`, kod sonrası typecheck/test/build; kısa hüküm döner |
| `p3d-reviewer` | sonnet | Commit öncesi diff incelemesi; bulgular önem sırasıyla |

- **Sahneyi yalnızca ana oturum değiştirir.** Köprü tek sekmeye bağlıdır; alt ajanlar `ops`/`undo`/`redo`/`fit`/`import`
  çalıştırmaz (tanımlarında yasak). Salt okunur komutlar (`scene`, `snapshot`, `measure`, `section`, `check`) paralel olabilir.
- Görsel "yeterince iyi mi" kararı ve kullanıcı geri bildirimine göre yön değişikliği ana oturumdadır: doğrulayıcının
  "BAK:" diye işaretlediği görüntüleri kendiniz Read ile açın.
- Brief kendi kendine yetmeli: amaç, dosya yolları (referans STL, çıktı klasörü = scratchpad), kabul ölçütü, zaten
  denenip elenenler. İnceleyiciye kendi sonucunuzu değil neyin neden değiştiğini verin.
- Birbirinden bağımsız ölçüm/doğrulama işlerini tek mesajda paralel başlatın; aynı dosyalara yazacak iki uygulayıcıyı
  aynı anda çalıştırmayın (gerekirse `isolation: "worktree"`).
- Commit ve push ana oturumdadır; alt ajanlar commit atmaz.
