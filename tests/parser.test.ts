import { describe, expect, it } from 'vitest';
import { applyOps, partBox } from '../src/engine';
import { displayOpacity } from '../src/model';
import { parseCommand } from '../src/nlp/parser';
import { newProject, type Project } from '../src/types';

/** Komutu ayrıştırıp uygular; seçimi motorun dokunduğu son parçaya taşır (arayüzdeki gibi). */
function run(project: Project, text: string, selected: { id: string | null } = { id: null }) {
  const parsed = parseCommand(text, project, selected.id);
  const res = applyOps(project, parsed.ops, selected.id);
  if (res.lastPartId) selected.id = res.lastPartId;
  if (res.clearSelection) selected.id = null;
  return { parsed, res };
}

const byName = (p: Project, name: string) => p.parts.find((x) => x.name === name)!;
const bottom = (p: Project, name: string) => partBox(byName(p, name), p.settings.resolution).min.z;

describe('oluşturma', () => {
  it('AxBxC kutu ve isim', () => {
    const p = newProject();
    const { parsed, res } = run(p, '50x30x10 kutu oluştur adı taban olsun');
    expect(parsed.unrecognized).toEqual([]);
    expect(res.errors).toEqual([]);
    const t = byName(p, 'taban');
    expect(t.shape).toBe('box');
    expect(t.params).toEqual({ width: 50, depth: 30, height: 10 });
    expect(bottom(p, 'taban')).toBeCloseTo(0);
  });

  it('anahtar kelimeli silindir, renk ve isim', () => {
    const p = newProject();
    run(p, '20 mm çaplı 40 mm yüksekliğinde kırmızı silindir ekle adı mil');
    const m = byName(p, 'mil');
    expect(m.shape).toBe('cylinder');
    expect(m.params).toEqual({ diameter: 20, height: 40 });
    expect(m.color).toBe('#e53935');
  });

  it('iyelik biçimi: çapı 20 yüksekliği 40 olan silindir', () => {
    const p = newProject();
    const { parsed } = run(p, 'çapı 20 ve yüksekliği 40 olan bir silindir oluştur');
    expect(parsed.unrecognized).toEqual([]);
    expect(p.parts[0].params).toEqual({ diameter: 20, height: 40 });
    expect(p.parts[0].name).toBe('Silindir 1');
  });

  it('küp, altıgen prizma, adet', () => {
    const p = newProject();
    run(p, '15 mm küp ekle');
    expect(p.parts[0].params).toEqual({ width: 15, depth: 15, height: 15 });
    run(p, '20 çaplı 8 yüksekliğinde altıgen ekle adı somun');
    expect(byName(p, 'somun').params).toEqual({ sides: 6, diameter: 20, height: 8 });
    run(p, '3 tane 10 mm küre ekle');
    expect(p.parts.filter((x) => x.shape === 'sphere').length).toBe(3);
  });

  it('başka parçanın üstüne oluşturma', () => {
    const p = newProject();
    run(p, '60x60x5 plaka ekle adı taban');
    run(p, 'tabanın üstüne 10 çaplı 30 yüksekliğinde silindir ekle adı direk');
    expect(bottom(p, 'direk')).toBeCloseTo(5);
    expect(byName(p, 'direk').position.x).toBeCloseTo(byName(p, 'taban').position.x);
  });

  it('boru: iç çap ve dış çap', () => {
    const p = newProject();
    run(p, 'dış çapı 30 iç çapı 20 yüksekliği 15 olan boru oluştur adı burç');
    expect(byName(p, 'burç').params).toEqual({ outerDiameter: 30, innerDiameter: 20, height: 15 });
  });
});

describe('ölçü değiştirme', () => {
  const setup = () => {
    const p = newProject();
    run(p, '20 çaplı 40 yüksekliğinde silindir ekle adı mil');
    run(p, '50x30x10 kutu ekle adı taban');
    return p;
  };

  it('x parçasının çapını 10mm büyüt', () => {
    const p = setup();
    const { res } = run(p, 'mil parçasının çapını 10mm büyüt');
    expect(res.errors).toEqual([]);
    expect(byName(p, 'mil').params.diameter).toBe(30);
  });

  it('Türkçe ekler ve aksansız yazım', () => {
    const p = setup();
    run(p, 'milin yuksekligini 5 mm azalt');
    expect(byName(p, 'mil').params.height).toBe(35);
    expect(bottom(p, 'mil')).toBeCloseTo(0); // taban yerinde kalır
    run(p, "Mil'in çapını 30'a çıkar");
    expect(byName(p, 'mil').params.diameter).toBe(30);
    run(p, 'milin çapını %50 artır');
    expect(byName(p, 'mil').params.diameter).toBe(45);
    run(p, 'milin çapını yarıya indir');
    expect(byName(p, 'mil').params.diameter).toBe(22.5);
    run(p, 'milin çapını 2 katına çıkar');
    expect(byName(p, 'mil').params.diameter).toBe(45);
    run(p, 'milin yarıçapını 2,5 mm küçült');
    expect(byName(p, 'mil').params.diameter).toBe(40);
  });

  it('birden çok ölçü ve "ve" ile bağlı cümleler', () => {
    const p = setup();
    const { parsed } = run(p, 'tabanın genişliğini 80 derinliğini 40 yap ve yüksekliğini 2 mm artır');
    expect(parsed.unrecognized).toEqual([]);
    expect(byName(p, 'taban').params).toEqual({ width: 80, depth: 40, height: 12 });
  });

  it('bağlam: parça adı geçmeyen sonraki komut', () => {
    const p = setup();
    const sel = { id: null as string | null };
    run(p, 'milin çapını 10 mm büyüt', sel);
    run(p, 'yüksekliğini de 10 mm artır', sel);
    expect(byName(p, 'mil').params).toEqual({ diameter: 30, height: 50 });
  });

  it('şekle uymayan ölçü hata verir', () => {
    const p = setup();
    const { parsed } = run(p, 'tabanın çapını 10 mm büyüt');
    expect(parsed.errors.join(' ')).toMatch(/çap/);
  });

  it('negatif sonuç reddedilir', () => {
    const p = setup();
    const { res } = run(p, 'milin çapını 30 mm küçült');
    expect(res.errors.length).toBe(1);
    expect(byName(p, 'mil').params.diameter).toBe(20);
  });

  it('şekil kelimesiyle referans', () => {
    const p = setup();
    run(p, 'kutunun yüksekliğini 20 yap');
    expect(byName(p, 'taban').params.height).toBe(20);
    run(p, 'silindiri mavi yap');
    expect(byName(p, 'mil').color).toBe('#1e88e5');
  });
});

describe('konum, döndürme, düzen', () => {
  const setup = () => {
    const p = newProject();
    run(p, '20 çaplı 40 yüksekliğinde silindir ekle adı mil');
    run(p, '50x30x10 kutu ekle adı taban');
    return p;
  };

  it('üstüne koy / yere indir', () => {
    const p = setup();
    run(p, 'mili tabanın üstüne koy');
    expect(bottom(p, 'mil')).toBeCloseTo(10);
    run(p, 'mili yere indir');
    expect(bottom(p, 'mil')).toBeCloseTo(0);
  });

  it('göreli ve mutlak taşıma', () => {
    const p = setup();
    const x0 = byName(p, 'mil').position.x;
    run(p, 'mili x yönünde 20 mm taşı');
    expect(byName(p, 'mil').position.x).toBeCloseTo(x0 + 20);
    run(p, 'mili 15 mm yukarı taşı');
    expect(bottom(p, 'mil')).toBeCloseTo(15);
    run(p, 'mili x=10 y=-20 z=0 konumuna taşı');
    expect(byName(p, 'mil').position.x).toBe(10);
    expect(byName(p, 'mil').position.y).toBe(-20);
    expect(bottom(p, 'mil')).toBeCloseTo(0);
  });

  it('döndürme tabanı korur', () => {
    const p = setup();
    run(p, 'mili x ekseninde 90 derece döndür');
    expect(byName(p, 'mil').rotation.x).toBe(90);
    expect(bottom(p, 'mil')).toBeCloseTo(0);
    run(p, 'mili yatır');
    expect(byName(p, 'mil').rotation.x).toBe(180);
  });

  it('yanına koy', () => {
    const p = setup();
    run(p, 'mili tabanın sağına koy');
    const tb = partBox(byName(p, 'taban'), p.settings.resolution);
    const mb = partBox(byName(p, 'mil'), p.settings.resolution);
    expect(mb.min.x).toBeCloseTo(tb.max.x + 5);
  });
});

describe('diğer komutlar', () => {
  const setup = () => {
    const p = newProject();
    run(p, '20 çaplı 40 yüksekliğinde silindir ekle adı mil');
    run(p, '50x30x10 kutu ekle adı taban');
    return p;
  };

  it('yeniden adlandırma', () => {
    const p = setup();
    run(p, 'milin adını şaft yap');
    expect(p.parts.some((x) => x.name === 'şaft')).toBe(true);
    run(p, 'tabanı Alt Plaka olarak adlandır');
    expect(p.parts.some((x) => x.name === 'Alt Plaka')).toBe(true);
  });

  it('renk, gizle/göster, isim/ölçü görünürlüğü', () => {
    const p = setup();
    run(p, 'tabanı açık mavi yap');
    expect(byName(p, 'taban').color).not.toBe('#1e88e5');
    run(p, 'mili gizle');
    expect(byName(p, 'mil').visible).toBe(false);
    run(p, 'tümünü göster');
    expect(byName(p, 'mil').visible).toBe(true);
    run(p, 'isimleri gizle');
    expect(p.view.showNames).toBe(false);
    run(p, 'ölçüleri gizle');
    expect(p.view.showDimensions).toBe(false);
    run(p, 'ölçüleri göster');
    expect(p.view.showDimensions).toBe(true);
  });

  it('kopyala ve sil', () => {
    const p = setup();
    run(p, 'mili kopyala');
    expect(p.parts.length).toBe(3);
    expect(p.parts[2].name).toBe('mil kopya');
    run(p, 'mil kopya parçasını sil');
    expect(p.parts.length).toBe(2);
  });

  it('isim "milimetre" kelimesiyle karışmaz', () => {
    const p = setup();
    const { parsed } = run(p, 'tabanın yüksekliğini 5 milimetre artır');
    expect(parsed.ops).toHaveLength(1);
    expect(byName(p, 'taban').params.height).toBe(15);
  });

  it('özel komutlar ve anlaşılmayanlar', () => {
    const p = setup();
    expect(parseCommand('geri al', p, null).special).toBe('undo');
    expect(parseCommand('yardım', p, null).special).toBe('help');
    expect(parseCommand('dört ayaklı bir masa tasarla', p, null).unrecognized.length).toBe(1);
  });
});

describe('delik ve roller', () => {
  it('"tabana 5 mm çaplı delik aç" parçanın ortasından geçen delik oluşturur', () => {
    const p = newProject();
    run(p, '60x40x5 kutu oluştur adı taban olsun');
    run(p, 'tabana 5 mm çaplı delik aç');
    const hole = p.parts[1];
    expect(hole.role).toBe('hole');
    expect(hole.params.diameter).toBe(5);
    const tb = partBox(p.parts[0], 96);
    const hb = partBox(hole, 96);
    expect(hb.min.z).toBeLessThan(tb.min.z);
    expect(hb.max.z).toBeGreaterThan(tb.max.z);
    expect((hb.min.x + hb.max.x) / 2).toBeCloseTo((tb.min.x + tb.max.x) / 2, 3);
  });

  it('derinlik verilirse üst yüzeyden kör delik', () => {
    const p = newProject();
    run(p, '20 mm çaplı 30 mm yüksekliğinde silindir ekle adı mil');
    run(p, 'milin üstüne 3 mm çaplı 8 mm derinliğinde delik aç');
    const hb = partBox(p.parts[1], 96);
    expect(hb.max.z).toBeCloseTo(31, 3);
    expect(hb.min.z).toBeCloseTo(22, 3);
  });

  it('rol değiştirme ve delik görünürlüğü', () => {
    const p = newProject();
    run(p, '10x10x10 kutu oluştur adı k');
    run(p, 'k parçasını delik yap');
    expect(p.parts[0].role).toBe('hole');
    run(p, 'k parçasını katı yap');
    expect(p.parts[0].role).toBeUndefined();
    run(p, 'delikleri gizle');
    expect(p.view.showHoles).toBe(false);
  });

  it('çapsız delik komutu sorar', () => {
    const p = newProject();
    run(p, '10x10x10 kutu oluştur adı k');
    const r = parseCommand('k parçasına delik aç', p, null);
    expect(r.errors.join(' ')).toMatch(/çapı kaç mm/);
  });
});

describe('saydamlık', () => {
  const setup = () => {
    const p = newProject();
    run(p, '40x2x30 kutu oluştur adı cam');
    run(p, '20 mm çaplı 40 mm yüksekliğinde silindir ekle adı mil');
    return p;
  };

  it('"yarı saydam yap" = 0,5 · "%30 saydam" = 0,7 · "saydamlığını %40 yap" = 0,6 · "%70 opak" = 0,7', () => {
    const p = setup();
    const cases: [string, number][] = [
      ['camı yarı saydam yap', 0.5],
      ['camı %30 saydam yap', 0.7],
      ['camı yüzde 20 şeffaf yap', 0.8],
      ['camın saydamlığını %40 yap', 0.6],
      ['camın saydamlığını 0,3 yap', 0.7],
      ['camı %70 opak yap', 0.7],
      ['camın opaklığını 0.25 yap', 0.25],
      ['camı saydam yap', 0.5], // oran yoksa yarı saydam
    ];
    for (const [text, value] of cases) {
      const { parsed, res } = run(p, text);
      expect(parsed.unrecognized, text).toEqual([]);
      expect(res.errors, text).toEqual([]);
      expect(byName(p, 'cam').opacity, text).toBe(value);
    }
    expect(byName(p, 'mil').opacity).toBeUndefined();
  });

  it('"opak yap" ve "saydamlığı kaldır / sil" = 1: alan kalkar, parça silinmez ve taşınmaz', () => {
    const p = setup();
    for (const text of ['camı opak yap', 'camın saydamlığını kaldır', 'camın saydamlığını sil', 'cam saydam olmasın']) {
      run(p, 'camı yarı saydam yap');
      expect(byName(p, 'cam').opacity).toBe(0.5);
      const pos = { ...byName(p, 'cam').position };
      const { parsed } = run(p, text);
      expect(parsed.ops, text).toEqual([{ op: 'update', part: byName(p, 'cam').id, opacity: 1 }]);
      expect(byName(p, 'cam'), text).toBeDefined();
      expect('opacity' in byName(p, 'cam'), text).toBe(false);
      expect(byName(p, 'cam').position, text).toEqual(pos);
    }
    // saydamlık kelimesi yokken silme ve "kaldır" taşıması eskisi gibi
    run(p, 'mili 10 mm yukarı kaldır');
    expect(bottom(p, 'mil')).toBeCloseTo(10);
    run(p, 'mili sil');
    expect(p.parts.map((x) => x.name)).toEqual(['cam']);
  });

  it('bağlam, renk, tümü ve hatalı oran', () => {
    const p = setup();
    const sel = { id: byName(p, 'mil').id };
    run(p, 'yarı saydam yap', sel); // seçili parça
    expect(byName(p, 'mil').opacity).toBe(0.5);
    run(p, 'camı %60 saydam mavi yap');
    expect(byName(p, 'cam').opacity).toBe(0.4);
    expect(byName(p, 'cam').color).toBe('#1e88e5');
    run(p, 'tümünü opak yap');
    expect(p.parts.some((x) => 'opacity' in x)).toBe(false);
    const bad = parseCommand('camı %130 saydam yap', p, null);
    expect(bad.ops).toEqual([]);
    expect(bad.errors.join(' ')).toMatch(/saydamlık %0–100 arası olmalı/);
  });

  it('yüzdesiz sayı: 1 < N ≤ 100 yüzde, ≤ 1 kesir (saydamlık = 1 − opaklık), 100 üstü hata', () => {
    const p = setup();
    const cases: [string, number][] = [
      ['camı 30 saydam yap', 0.7],
      ['camı 0,3 saydam yap', 0.7],
      ['camın saydamlığı 0,3', 0.7],
      ['camı 70 opak yap', 0.7],
      ['camın saydamlığını 25 yap', 0.75],
    ];
    for (const [text, value] of cases) {
      const { parsed } = run(p, text);
      expect(parsed.errors, text).toEqual([]);
      expect(byName(p, 'cam').opacity, text).toBe(value);
    }
    for (const text of ['camı 130 saydam yap', 'camın saydamlığını 150 yap']) {
      const r = parseCommand(text, p, null);
      expect(r.ops, text).toEqual([]);
      expect(r.errors.join(' '), text).toMatch(/saydamlık %0–100 arası olmalı/);
    }
  });

  it('sonuç tamamen saydamsa işlem üretilmez: gizlemek için "gizle"', () => {
    const p = setup();
    run(p, 'camı yarı saydam yap');
    for (const text of ['camın saydamlığını 1 yap', 'camın saydamlığı 1', 'camı %100 saydam yap', 'camın opaklığını 0 yap', '%100 saydam küre ekle']) {
      const r = parseCommand(text, p, null);
      expect(r.ops, text).toEqual([]);
      expect(r.errors.join(' '), text).toContain("tamamen saydam parça görünmez olur; gizlemek için 'gizle' kullanın");
    }
    expect(byName(p, 'cam').opacity).toBe(0.5);
    expect(p.parts).toHaveLength(2);
  });

  it('referansı opak yap: referans tamamen opak olur (rol varsayılanı 0,35 yerine 1)', () => {
    const p = newProject();
    applyOps(p, [{ op: 'create', shape: 'box', name: 'referans', role: 'reference' }], null);
    expect(displayOpacity(byName(p, 'referans'))).toBe(0.35);
    const { res } = run(p, 'referansı opak yap');
    expect(res.errors).toEqual([]);
    expect(byName(p, 'referans').opacity).toBe(1);
    expect(displayOpacity(byName(p, 'referans'))).toBe(1);
    const q = newProject(); // ayrı proje: "referans" adlı parça yokken "referans yap" rol kalıbıdır
    run(q, '20x20x20 kutu oluştur adı model');
    run(q, 'modeli referans yap');
    expect(byName(q, 'model').role).toBe('reference');
    run(q, 'modeli opak yap');
    expect(displayOpacity(byName(q, 'model'))).toBe(1);
  });

  it('oluştururken: "yarı saydam küre ekle", oran ölçü sayılarına karışmaz', () => {
    const p = newProject();
    run(p, 'yarı saydam küre ekle adı balon');
    expect(byName(p, 'balon').opacity).toBe(0.5);
    run(p, '20 mm çaplı %30 saydam kırmızı silindir ekle adı far');
    const far = byName(p, 'far');
    expect(far.params).toEqual({ diameter: 20, height: 20 });
    expect(far.opacity).toBe(0.7);
    expect(far.color).toBe('#e53935');
    run(p, 'saydamlığı 40 olan 12 mm küre ekle adı top');
    expect(byName(p, 'top').params.diameter).toBe(12);
    expect(byName(p, 'top').opacity).toBe(0.6);
  });
});
