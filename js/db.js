// IndexedDBの薄いラッパー。外部通信は一切行わず、すべて端末内に保存する。
const DB_NAME = 'submissionTrackerDB';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('students')) {
        const s = db.createObjectStore('students', { keyPath: 'id', autoIncrement: true });
        s.createIndex('number', 'number', { unique: true });
      }
      if (!db.objectStoreNames.contains('items')) {
        db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('assignments')) {
        const a = db.createObjectStore('assignments', { keyPath: 'id', autoIncrement: true });
        a.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('statuses')) {
        const st = db.createObjectStore('statuses', { keyPath: 'key' });
        st.createIndex('studentId', 'studentId', { unique: false });
        st.createIndex('assignmentId', 'assignmentId', { unique: false });
      }
      if (!db.objectStoreNames.contains('history')) {
        const h = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        h.createIndex('studentId', 'studentId', { unique: false });
        h.createIndex('assignmentId', 'assignmentId', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked (another tab may be using an older version)'));
    setTimeout(() => reject(new Error('IndexedDB open timed out after 8s')), 8000);
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const result = fn(t);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const DB = {
  async add(store, value) {
    return tx([store], 'readwrite', t => reqToPromise(t.objectStore(store).add(value)));
  },
  async put(store, value) {
    return tx([store], 'readwrite', t => reqToPromise(t.objectStore(store).put(value)));
  },
  async get(store, key) {
    return tx([store], 'readonly', t => reqToPromise(t.objectStore(store).get(key)));
  },
  async delete(store, key) {
    return tx([store], 'readwrite', t => reqToPromise(t.objectStore(store).delete(key)));
  },
  async getAll(store) {
    return tx([store], 'readonly', t => reqToPromise(t.objectStore(store).getAll()));
  },
  async getAllByIndex(store, indexName, value) {
    return tx([store], 'readonly', t => reqToPromise(t.objectStore(store).index(indexName).getAll(value)));
  },
};

export async function getMeta(key, fallback) {
  const row = await DB.get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return DB.put('meta', { key, value });
}
