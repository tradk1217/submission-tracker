// IndexedDBの薄いラッパー。児童の氏名等はここ(端末内)にのみ保存する。
const DB_NAME = 'submissionTrackerDB';
const DB_VERSION = 2;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const t = event.target.transaction;

      let students, items, assignments, statuses, history;

      if (!db.objectStoreNames.contains('students')) {
        students = db.createObjectStore('students', { keyPath: 'id', autoIncrement: true });
        students.createIndex('number', 'number', { unique: true });
      } else {
        students = t.objectStore('students');
      }
      if (!db.objectStoreNames.contains('items')) {
        items = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
      } else {
        items = t.objectStore('items');
      }
      if (!db.objectStoreNames.contains('assignments')) {
        assignments = db.createObjectStore('assignments', { keyPath: 'id', autoIncrement: true });
        assignments.createIndex('date', 'date', { unique: false });
      } else {
        assignments = t.objectStore('assignments');
      }
      if (!db.objectStoreNames.contains('statuses')) {
        statuses = db.createObjectStore('statuses', { keyPath: 'key' });
        statuses.createIndex('studentId', 'studentId', { unique: false });
        statuses.createIndex('assignmentId', 'assignmentId', { unique: false });
      } else {
        statuses = t.objectStore('statuses');
      }
      if (!db.objectStoreNames.contains('history')) {
        history = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        history.createIndex('studentId', 'studentId', { unique: false });
        history.createIndex('assignmentId', 'assignmentId', { unique: false });
      } else {
        history = t.objectStore('history');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      // v2: クラウド同期用の索引(端末をまたいだ突き合わせに使う)
      if (event.oldVersion < 2) {
        if (!students.indexNames.contains('code')) students.createIndex('code', 'code', { unique: false });
        if (!history.indexNames.contains('fsId')) history.createIndex('fsId', 'fsId', { unique: false });
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
  async clear(store) {
    return tx([store], 'readwrite', t => reqToPromise(t.objectStore(store).clear()));
  },
  async putAll(store, values) {
    return tx([store], 'readwrite', t => {
      const os = t.objectStore(store);
      values.forEach(v => os.put(v));
    });
  },
};

export const ALL_STORES = ['students', 'items', 'assignments', 'statuses', 'history', 'meta'];

export async function getMeta(key, fallback) {
  const row = await DB.get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return DB.put('meta', { key, value });
}
