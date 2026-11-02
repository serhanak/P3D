// Otomatik kayıt arka uçları (Store kullanır). Kök `/` localStorage'da kalır (anahtarlar ve biçim v0.2'den beri
// aynı; kullanıcı verisi orada). Çalışma alanları (`/w/<ad>`) IndexedDB'dedir: localStorage'ın ~5 MB kotası tüm
// çalışma alanlarınca paylaşılırdı. Ağ verisi (assets) proje anlık görüntülerine girmez, burada ayrıca saklanır.
//
// Okunamayan kayıt silinmez ve ilk düzenlemede ezilmez: `quarantine()` ham kaydı yedeğe taşır (kök:
// `p3d.autosave.v1.bozuk`, ws: IndexedDB'de `<ws>#bozuk`). Aynı çalışma alanı birden çok sekmede açıksa yalnızca
// ilk sekme kayıt yazar (`claimAutosave`).
import type { MeshAsset } from '../shared/ops';
import { registerAsset, usedAssets } from './assets';
import type { Project } from './types';

/** Kayıttan geri gelen durum: proje henüz doğrulanmamıştır (parseProject çağırana aittir). */
export interface AutosaveRecord {
  project: unknown;
  /** Sekmenin bağlı olduğu dosya (yalnızca gösterim). */
  file?: string;
  /** Son yükleme/kayıttan sonra değişiklik var mıydı. */
  dirty?: boolean;
  /** Kayıt var ama okunamadı (ör. bozuk JSON): neden. Çağıran `quarantine()` ile yedeğe taşımalı. */
  error?: string;
}

export interface AutosaveState {
  project: Project;
  file?: string;
  dirty: boolean;
}

export interface AutosaveBackend {
  /** Kaydı okur ve ağları depoya alır; kayıt yoksa null. Depolama kullanılamıyorsa Error fırlatır. */
  load(): Promise<AutosaveRecord | null>;
  /**
   * Okunamayan kaydı olduğu gibi yedeğe taşır (asıl kayıt boşalır); yedeğin yerini döndürür. Yedeklenemezse Error
   * fırlatır ve asıl kayda dokunmaz — çağıran o zaman otomatik kaydı kapatmalıdır.
   */
  quarantine(): Promise<string>;
  /** Durumu yazar (çağıran zamanlamayı yapar); sorunları `warn` ile bildirir. */
  save(s: AutosaveState, warn: (msg: string) => void): void;
}

// ---------------------------------------------------------------------------
// Kök: localStorage

export const AUTOSAVE_KEY = 'p3d.autosave.v1';
/** Mesh ağ verisi ayrı anahtarda: proje her değiştiğinde yeniden yazılmasın. */
export const ASSETS_KEY = 'p3d.autosave.assets.v1';
/** Dosya bağı (yalnızca bağ varken yazılır): {file, dirty}. Diğer iki anahtarın biçimine dokunmaz. */
export const META_KEY = 'p3d.autosave.meta.v1';
/** Okunamayan kök kaydının yedeği (dolu ise sonuna zaman damgası eklenir). */
export const CORRUPT_KEY = `${AUTOSAVE_KEY}.bozuk`;

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function localStorageBackend(storage: () => KeyValueStorage = () => localStorage): AutosaveBackend {
  let savedAssets = '';
  let savedMeta: string | null = null;
  return {
    async load() {
      try {
        const assets = JSON.parse(storage().getItem(ASSETS_KEY) ?? '{}') as Record<string, unknown>;
        for (const a of Object.values(assets)) registerAsset(a);
      } catch {
        // Bozuk ağ kaydı: mesh parçaları yer tutucu olarak görünür.
      }
      const raw = storage().getItem(AUTOSAVE_KEY);
      if (!raw) return null;
      let project: unknown;
      try {
        project = JSON.parse(raw);
      } catch (e) {
        return { project: undefined, error: `bozuk JSON: ${(e as Error).message}` };
      }
      try {
        const meta = JSON.parse(storage().getItem(META_KEY) ?? '{}') as Record<string, unknown>;
        if (typeof meta.file === 'string' && meta.file) return { project, file: meta.file, dirty: meta.dirty === true };
      } catch {
        // Bozuk dosya bağı: yok sayılır.
      }
      return { project };
    },
    async quarantine() {
      const s = storage();
      const raw = s.getItem(AUTOSAVE_KEY);
      if (raw === null) return '(kayıt yoktu)';
      const key = s.getItem(CORRUPT_KEY) === null ? CORRUPT_KEY : `${CORRUPT_KEY}.${Date.now()}`;
      s.setItem(key, raw); // kota dolu olabilir: hata çağırana gider, asıl kayıt yerinde kalır
      s.removeItem(AUTOSAVE_KEY);
      s.removeItem(META_KEY); // dosya bağı bozuk kayda aitti
      savedMeta = '';
      return `localStorage '${key}'`;
    },
    save(s, warn) {
      try {
        storage().setItem(AUTOSAVE_KEY, JSON.stringify(s.project));
      } catch {
        // Depolama kapalı/dolu olabilir; otomatik kayıt isteğe bağlıdır.
      }
      const meta = s.file ? JSON.stringify({ file: s.file, dirty: s.dirty }) : '';
      if (meta !== savedMeta) {
        try {
          if (meta) storage().setItem(META_KEY, meta);
          else storage().removeItem(META_KEY);
          savedMeta = meta;
        } catch {
          // Dosya bağı yalnızca gösterim içindir.
        }
      }
      const assets = usedAssets(s.project);
      const key = Object.keys(assets).sort().join(',');
      if (key === savedAssets) return;
      try {
        storage().setItem(ASSETS_KEY, JSON.stringify(assets));
        savedAssets = key;
      } catch {
        savedAssets = key;
        warn('İçe aktarılan ağ tarayıcının otomatik kaydına sığmadı; sayfa yenilenirse kaybolur. Projeyi Kaydet ile dosyaya kaydedin.');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Çalışma alanları: IndexedDB (veritabanı `p3d`, depo `autosave`, anahtar = çalışma alanı adı)

const IDB_NAME = 'p3d';
const IDB_STORE = 'autosave';
const IDB_TIMEOUT_MS = 8000;

interface IdbRecord {
  project: Project;
  assets: Record<string, MeshAsset>;
  file?: string;
  dirty?: boolean;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB isteği başarısız.'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB işlemi başarısız.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB işlemi iptal edildi.'));
  });
}

/** Okunamayan ws kaydının yedek anahtarı (ws adlarında '#' olamaz; gerçek bir ws ile çakışmaz). */
export const corruptIdbKey = (ws: string) => `${ws}#bozuk`;

export function indexedDbBackend(ws: string, idb: () => IDBFactory | undefined = () => globalThis.indexedDB): AutosaveBackend {
  let db: IDBDatabase | null = null;
  // Aynı türden hata için bir kez uyarılır; hata türü değişince yeniden.
  let warnedKind = '';
  const fail = (warn: (msg: string) => void, e: unknown) => {
    const err = e as { name?: string; message?: string } | null;
    const kind = err?.name || err?.message || String(e);
    if (kind === warnedKind) return;
    warnedKind = kind;
    warn(`'${ws}' çalışma alanı otomatik kaydedilemedi (IndexedDB: ${err?.message ?? e}). Projeyi dosyaya kaydedin.`);
  };
  return {
    async load() {
      const factory = idb();
      if (!factory) throw new Error('Bu tarayıcıda IndexedDB yok.');
      const open = factory.open(IDB_NAME, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(IDB_STORE)) open.result.createObjectStore(IDB_STORE);
      };
      // Açılış (main.ts üst düzey await) takılırsa sayfa boş kalmasın.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('IndexedDB yanıt vermedi')), IDB_TIMEOUT_MS);
      });
      let d: IDBDatabase | undefined;
      let rec: unknown;
      try {
        d = await Promise.race([request(open), timeout]);
        d.onversionchange = () => d?.close();
        rec = await Promise.race([request(d.transaction(IDB_STORE).objectStore(IDB_STORE).get(ws)), timeout]);
      } catch (e) {
        // Zaman aşımı/hata: açılmış ya da sonradan açılacak bağlantı kapatılır (sürüm yükseltmesini engellemesin).
        if (d) d.close();
        else open.onsuccess = () => open.result.close();
        throw e;
      } finally {
        clearTimeout(timer);
      }
      // Okuma başarılı olmadan yazma açılmaz: geçici bir hata kayıtlı projenin üzerine boş proje yazdırmasın.
      db = d;
      if (rec === undefined) return null;
      const r = rec as Partial<IdbRecord> | null;
      if (!r || typeof r !== 'object' || !r.project) return { project: r?.project, error: 'kayıtta proje yok' };
      for (const a of Object.values(r.assets ?? {})) {
        try {
          registerAsset(a);
        } catch {
          // Bozuk ağ: parça yer tutucu olarak görünür.
        }
      }
      return { project: r.project, ...(typeof r.file === 'string' && r.file ? { file: r.file } : {}), dirty: r.dirty === true };
    },
    async quarantine() {
      if (!db) throw new Error('IndexedDB açık değil.');
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const done = transactionDone(tx);
      const st = tx.objectStore(IDB_STORE);
      const raw = await request(st.get(ws));
      const taken = (await request(st.count(corruptIdbKey(ws)))) > 0;
      const key = taken ? `${corruptIdbKey(ws)}-${Date.now()}` : corruptIdbKey(ws);
      st.put(raw, key);
      st.delete(ws);
      await done;
      return `IndexedDB '${IDB_NAME}/${IDB_STORE}' → '${key}'`;
    },
    save(s, warn) {
      if (!db) return;
      const rec: IdbRecord = { project: s.project, assets: usedAssets(s.project), ...(s.file ? { file: s.file } : {}), dirty: s.dirty };
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(rec, ws);
        tx.onerror = () => fail(warn, tx.error);
        tx.onabort = () => fail(warn, tx.error);
      } catch (e) {
        fail(warn, e);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Aynı çalışma alanı birden çok sekmede

/** Sahiplik sorusu için BroadcastChannel yanıt bekleme süresi (navigator.locks yoksa). */
const CLAIM_WAIT_MS = 200;

/**
 * Bu sekme çalışma alanının otomatik kaydını yazabilir mi? Aynı ws başka bir sekmede zaten açıksa false: iki
 * sekmenin kayıtları birbirini ezmesin (son yazan kazanırdı). İlk sekme sahipliği kapanana kadar tutar.
 * `navigator.locks` (güvenli bağlam: localhost/https) varsa kilit, yoksa BroadcastChannel ile sorulur.
 */
export async function claimAutosave(ws: string): Promise<boolean> {
  const name = `p3d.autosave:${ws}`;
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks) {
    try {
      return await new Promise<boolean>((resolve, reject) => {
        locks
          .request(name, { ifAvailable: true }, (lock) => {
            resolve(lock !== null);
            // Kilit sekme kapanana kadar bırakılmaz.
            return lock ? new Promise<void>(() => {}) : undefined;
          })
          .catch(reject);
      });
    } catch {
      // Kilit kullanılamadı: BroadcastChannel'a düşülür.
    }
  }
  if (typeof BroadcastChannel === 'undefined') return true;
  const ch = new BroadcastChannel(name);
  let owner = true;
  // Kanal sekme kapanana kadar açık kalır: sonradan açılan sekmeler de bu sekmeyi görsün.
  ch.onmessage = (e: MessageEvent) => {
    if (e.data === 'kim-var') ch.postMessage('burada');
    else if (e.data === 'burada') owner = false;
  };
  ch.postMessage('kim-var');
  await new Promise((r) => setTimeout(r, CLAIM_WAIT_MS));
  return owner;
}
