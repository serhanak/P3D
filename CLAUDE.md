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
