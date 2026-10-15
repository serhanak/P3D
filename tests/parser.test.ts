import { describe, expect, it } from 'vitest';
import { applyOps, partBox } from '../src/engine';
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
