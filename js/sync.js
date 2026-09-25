// クラウド同期(Firestore)。児童の氏名・ふりがなは絶対に送信しない。
// 送るのは「コード」(js/util.js の generateCode で作るランダムな識別子)と、
// 提出物マスタ・今日の提出対象・提出状況・履歴のみ。
//
// 端末ごとにIndexedDBのオートインクリメントIDはバラバラになるため、
// 端末をまたいで同じ人・同じ課題だと分かるように、児童は"code"、
// 提出物・提出対象は"syncId"という共有の乱数キーで突き合わせる。
import { DB, getMeta, setMeta } from './db.js';

const FS_SDK = 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
const APP_SDK = 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
const AUTH_SDK = 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';

let fsApi = null;
let dbFs = null;
let authObj = null;
let unsubs = [];
let onChangeCallback = null;
let status = { enabled: false, connected: false, error: null, classroomId: null };

export function onSyncChange(cb) {
  onChangeCallback = cb;
}

export function getSyncState() {
  return status;
}

function notify() {
  if (onChangeCallback) onChangeCallback();
}

let signedIn = false;

async function ensureFirebase() {
  if (!fsApi) {
    const { firebaseConfig } = await import('./firebase-config.js');
    const [{ initializeApp }, fsMod, authMod] = await Promise.all([
      import(APP_SDK), import(FS_SDK), import(AUTH_SDK),
    ]);
    const app = initializeApp(firebaseConfig);
    dbFs = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentSingleTabManager() }),
    });
    fsApi = fsMod;
    authObj = authMod.getAuth(app);
  }
  if (!signedIn) {
    const { signInAnonymously } = await import(AUTH_SDK);
    await signInAnonymously(authObj);
    signedIn = true;
  }
}

export async function getClassroomId() {
  return getMeta('classroomId', null);
}

export async function isSyncEnabled() {
  return !!(await getClassroomId());
}

function generateClassroomId() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s.match(/.{1,4}/g).join('-');
}

export async function startNewClassroom() {
  const id = generateClassroomId();
  await setMeta('classroomId', id);
  await startSync();
  return id;
}

export async function joinClassroom(rawId) {
  const id = rawId.trim().toUpperCase();
  await setMeta('classroomId', id);
  await startSync();
}

export async function leaveClassroom() {
  stopSync();
  await setMeta('classroomId', null);
  status = { enabled: false, connected: false, error: null, classroomId: null };
  notify();
}

export function stopSync() {
  unsubs.forEach(u => { try { u(); } catch (e) {} });
  unsubs = [];
}

// ---------- 端末内IDとクラウド共有キーの突き合わせ ----------

async function localStudentIdByCode(code) {
  const rows = await DB.getAllByIndex('students', 'code', code);
  return rows.length ? rows[0].id : null;
}

async function localStudentCode(localId) {
  const s = await DB.get('students', localId);
  return s ? s.code : null;
}

async function localItemIdBySyncId(syncId) {
  const all = await DB.getAll('items');
  const hit = all.find(i => i.syncId === syncId);
  return hit ? hit.id : null;
}

async function localItemSyncId(localId) {
  const i = await DB.get('items', localId);
  return i ? i.syncId : null;
}

async function localAssignmentIdBySyncId(syncId) {
  const all = await DB.getAll('assignments');
  const hit = all.find(a => a.syncId === syncId);
  return hit ? hit.id : null;
}

async function localAssignmentSyncId(localId) {
  const a = await DB.get('assignments', localId);
  return a ? a.syncId : null;
}

// 受信済みだが対応するローカル行がまだ無いため紐付け保留になっているものを、
// items/assignmentsの受信のたびに再試行する。
async function reconcilePending() {
  const assignments = await DB.getAll('assignments');
  for (const a of assignments) {
    if (a._pendingItemSyncId) {
      const localItemId = await localItemIdBySyncId(a._pendingItemSyncId);
      if (localItemId) {
        delete a._pendingItemSyncId;
        a.itemId = localItemId;
        await DB.put('assignments', a);
      }
    }
  }
  const statuses = await DB.getAll('statuses');
  for (const s of statuses) {
    if (s._pendingAssignmentSyncId) {
      const localAssignmentId = await localAssignmentIdBySyncId(s._pendingAssignmentSyncId);
      if (localAssignmentId) {
        await DB.delete('statuses', s.key);
        delete s._pendingAssignmentSyncId;
        s.assignmentId = localAssignmentId;
        s.key = `${s.studentId}_${localAssignmentId}`;
        await DB.put('statuses', s);
      }
    }
  }
}

export async function startSync() {
  const classroomId = await getClassroomId();
  if (!classroomId) return;
  try {
    await ensureFirebase();
  } catch (err) {
    status = { enabled: true, connected: false, error: err.message, classroomId };
    notify();
    return;
  }
  stopSync();
  const { collection, onSnapshot } = fsApi;
  const base = ['classes', classroomId];
  const onErr = (err) => { status.error = err.message; notify(); };

  unsubs.push(onSnapshot(collection(dbFs, ...base, 'items'), async (snap) => {
    for (const change of snap.docChanges()) {
      const syncId = change.doc.id;
      const existingId = await localItemIdBySyncId(syncId);
      if (change.type === 'removed') {
        if (existingId) await DB.delete('items', existingId);
        continue;
      }
      const data = change.doc.data();
      if (existingId) {
        await DB.put('items', { ...data, id: existingId, syncId });
      } else {
        await DB.add('items', { ...data, syncId });
      }
    }
    await reconcilePending();
    notify();
  }, onErr));

  unsubs.push(onSnapshot(collection(dbFs, ...base, 'assignments'), async (snap) => {
    for (const change of snap.docChanges()) {
      const syncId = change.doc.id;
      const existingId = await localAssignmentIdBySyncId(syncId);
      if (change.type === 'removed') {
        if (existingId) await DB.delete('assignments', existingId);
        continue;
      }
      const data = change.doc.data();
      const localItemId = await localItemIdBySyncId(data.itemSyncId);
      const row = {
        date: data.date, deadline: data.deadline || null, syncId,
        itemId: localItemId,
        ...(localItemId ? {} : { _pendingItemSyncId: data.itemSyncId }),
      };
      if (existingId) await DB.put('assignments', { ...row, id: existingId });
      else await DB.add('assignments', row);
    }
    await reconcilePending();
    notify();
  }, onErr));

  unsubs.push(onSnapshot(collection(dbFs, ...base, 'statuses'), async (snap) => {
    for (const change of snap.docChanges()) {
      const data = change.doc.data();
      const localStudentId = await localStudentIdByCode(data.studentCode);
      if (!localStudentId) continue;
      const localAssignmentId = await localAssignmentIdBySyncId(data.assignmentSyncId);
      const key = `${localStudentId}_${localAssignmentId || data.assignmentSyncId}`;
      if (change.type === 'removed') {
        await DB.delete('statuses', key);
        continue;
      }
      const row = {
        key, studentId: localStudentId,
        assignmentId: localAssignmentId,
        status: data.status, plannedDate: data.plannedDate || null,
        updatedAt: data.updatedAt, updatedBy: data.updatedBy,
        ...(localAssignmentId ? {} : { _pendingAssignmentSyncId: data.assignmentSyncId }),
      };
      await DB.put('statuses', row);
    }
    notify();
  }, onErr));

  unsubs.push(onSnapshot(collection(dbFs, ...base, 'history'), async (snap) => {
    for (const change of snap.docChanges()) {
      if (change.type === 'removed') {
        const existing = await DB.getAllByIndex('history', 'fsId', change.doc.id);
        for (const e of existing) await DB.delete('history', e.id);
        continue;
      }
      const data = change.doc.data();
      const localStudentId = await localStudentIdByCode(data.studentCode);
      if (!localStudentId) continue;
      const localAssignmentId = await localAssignmentIdBySyncId(data.assignmentSyncId);
      const existing = await DB.getAllByIndex('history', 'fsId', change.doc.id);
      const row = {
        studentId: localStudentId, assignmentId: localAssignmentId,
        status: data.status, actor: data.actor, at: data.at, fsId: change.doc.id,
      };
      if (existing.length) await DB.put('history', { ...existing[0], ...row });
      else await DB.add('history', row);
    }
    notify();
  }, onErr));

  status = { enabled: true, connected: true, error: null, classroomId };
  notify();
}

// ---------- push (この端末での変更 → クラウド) ----------

async function withFs(fn) {
  const classroomId = await getClassroomId();
  if (!classroomId) return;
  try {
    await ensureFirebase();
    await fn(classroomId);
  } catch (err) {
    console.error('sync push failed', err);
  }
}

export function pushItem(localItem) {
  return withFs(async (classroomId) => {
    const { doc, setDoc } = fsApi;
    const { id, syncId, ...rest } = localItem;
    await setDoc(doc(dbFs, 'classes', classroomId, 'items', syncId), rest);
  });
}

export function deleteItemRemote(localItem) {
  return withFs(async (classroomId) => {
    if (!localItem || !localItem.syncId) return;
    const { doc, deleteDoc } = fsApi;
    await deleteDoc(doc(dbFs, 'classes', classroomId, 'items', localItem.syncId));
  });
}

export function pushAssignment(localAssignment, itemSyncId) {
  return withFs(async (classroomId) => {
    const { doc, setDoc } = fsApi;
    await setDoc(doc(dbFs, 'classes', classroomId, 'assignments', localAssignment.syncId), {
      date: localAssignment.date, deadline: localAssignment.deadline || null, itemSyncId,
    });
  });
}

export function deleteAssignmentRemote(localAssignment) {
  return withFs(async (classroomId) => {
    if (!localAssignment || !localAssignment.syncId) return;
    const { doc, deleteDoc } = fsApi;
    await deleteDoc(doc(dbFs, 'classes', classroomId, 'assignments', localAssignment.syncId));
  });
}

export function pushStatus(statusRow) {
  return withFs(async (classroomId) => {
    const code = await localStudentCode(statusRow.studentId);
    const assignmentSyncId = await localAssignmentSyncId(statusRow.assignmentId);
    if (!code || !assignmentSyncId) return;
    const { doc, setDoc } = fsApi;
    const docId = `${code}_${assignmentSyncId}`;
    await setDoc(doc(dbFs, 'classes', classroomId, 'statuses', docId), {
      studentCode: code, assignmentSyncId, status: statusRow.status,
      plannedDate: statusRow.plannedDate, updatedAt: statusRow.updatedAt, updatedBy: statusRow.updatedBy,
    });
  });
}

export function deleteStatusRemote(studentLocalId, assignmentLocalId) {
  return withFs(async (classroomId) => {
    const code = await localStudentCode(studentLocalId);
    const assignmentSyncId = await localAssignmentSyncId(assignmentLocalId);
    if (!code || !assignmentSyncId) return;
    const { doc, deleteDoc } = fsApi;
    await deleteDoc(doc(dbFs, 'classes', classroomId, 'statuses', `${code}_${assignmentSyncId}`));
  });
}

export function pushHistory(historyRow) {
  return withFs(async (classroomId) => {
    const code = await localStudentCode(historyRow.studentId);
    const assignmentSyncId = await localAssignmentSyncId(historyRow.assignmentId);
    if (!code || !assignmentSyncId) return;
    const { collection, addDoc } = fsApi;
    const docRef = await addDoc(collection(dbFs, 'classes', classroomId, 'history'), {
      studentCode: code, assignmentSyncId,
      status: historyRow.status, actor: historyRow.actor, at: historyRow.at,
    });
    if (historyRow.id) await DB.put('history', { ...historyRow, fsId: docRef.id });
  });
}
