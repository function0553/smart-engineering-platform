/** Account-scoped local draft; metadata and original photo bytes commit atomically. */
export function createReportDraftStorage<T extends { photos: { base64: string }[] }>(key: string) {
  let connection: IDBDatabase | undefined;
  let opening: Promise<IDBDatabase> | undefined;
  let knownVersion = '';
  let knownPixels: string[] = [];
  function database() {
    if (connection) return Promise.resolve(connection);
    if (!opening) {
      const attempt = new Promise<IDBDatabase>((resolve, reject) => {
        if (!globalThis.indexedDB) { reject(new Error('本机不支持照片草稿存储')); return; }
        const request = indexedDB.open('smart-office-daily-report-drafts', 1);
        let settled = false;
        const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('本机照片草稿存储不可用')); } };
        const timer = setTimeout(fail, 5000);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('drafts');
          request.result.createObjectStore('photos');
        };
        request.onerror = fail;
        request.onblocked = fail;
        request.onsuccess = () => {
          if (settled) { request.result.close(); return; }
          settled = true; clearTimeout(timer); connection = request.result;
          connection.onversionchange = () => { connection?.close(); connection = undefined; opening = undefined; };
          resolve(connection);
        };
      });
      opening = attempt;
      // A temporary open failure must not poison every later recovery attempt.
      void attempt.catch(() => { if (opening === attempt) opening = undefined; });
    }
    return opening;
  }
  async function load(): Promise<T | null> {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['drafts', 'photos'], 'readonly');
      const metadata = transaction.objectStore('drafts').get(key);
      const photos = transaction.objectStore('photos').get(key);
      transaction.onabort = () => reject(transaction.error || new Error('本机草稿读取失败'));
      transaction.oncomplete = () => {
        const saved = metadata.result;
        if (!saved) { knownVersion = ''; knownPixels = []; resolve(null); return; }
        const pixels = photos.result;
        if (saved.schemaVersion !== 1 || !Array.isArray(saved.data?.photos) || !pixels || saved.photoVersion !== pixels.version || !Array.isArray(pixels.base64) || pixels.base64.length !== saved.data.photos.length || pixels.base64.some((value: unknown) => typeof value !== 'string')) {
          reject(new Error('本机照片草稿不完整，请导入填写数据恢复')); return;
        }
        knownVersion = pixels.version; knownPixels = pixels.base64;
        resolve({ ...saved.data, photos: saved.data.photos.map((photo: object, index: number) => ({ ...photo, base64: pixels.base64[index] })) } as T);
      };
    });
  }
  function write(db: IDBDatabase, report: T): Promise<void> {
    const base64 = report.photos.map(photo => photo.base64);
    const metadata = { ...report, photos: report.photos.map(({ base64: _pixels, ...photo }) => photo) };
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try { transaction = db.transaction(['drafts', 'photos'], 'readwrite', { durability: 'strict' }); }
      catch { transaction = db.transaction(['drafts', 'photos'], 'readwrite'); }
      let committedVersion = '';
      let writeError: unknown;
      const existing = transaction.objectStore('drafts').get(key);
      existing.onsuccess = () => {
        try {
        const unchanged = knownVersion && existing.result?.photoVersion === knownVersion && base64.length === knownPixels.length && base64.every((value, index) => value === knownPixels[index]);
        committedVersion = unchanged ? knownVersion : crypto.randomUUID();
        transaction.objectStore('drafts').put({ schemaVersion: 1, data: metadata, photoVersion: committedVersion }, key);
        if (!unchanged) transaction.objectStore('photos').put({ version: committedVersion, base64 }, key);
        } catch (error) { writeError = error; transaction.abort(); }
      };
      transaction.onabort = () => reject(writeError || transaction.error || new Error('本机草稿保存失败'));
      transaction.oncomplete = () => { knownVersion = committedVersion; knownPixels = base64; resolve(); };
    });
  }
  function save(report: T) { return connection ? write(connection, report) : database().then(db => write(db, report)); }
  return { load, save };
}
