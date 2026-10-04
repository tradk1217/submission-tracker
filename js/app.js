import { DB, getMeta, setMeta, ALL_STORES } from './db.js';
import { todayStr, addDays, japaneseHolidays, formatDateJp, formatDateTimeJp, deadlineState, rubyHtml, escapeHtml, parseCsv, downloadCsv, toCsv, generateCode, uid, attachFuriganaAutofill } from './util.js';
import * as Sync from './sync.js';

const STATUS = {
  NOT_SUBMITTED: 'not_submitted',
  SUBMITTED: 'submitted',
  IN_PROGRESS: 'in_progress',
  FORGOTTEN: 'forgotten',
  REDO: 'redo',
  RESUBMIT_WAIT: 'resubmit_wait',
  EXEMPT: 'exempt',
};

const STATUS_META = {
  [STATUS.NOT_SUBMITTED]: { icon: '□', label: 'まだ', kana: '', cls: 'st-none' },
  [STATUS.SUBMITTED]: { icon: '○', label: '出せた', kana: 'だせた', cls: 'st-ok' },
  [STATUS.IN_PROGRESS]: { icon: '△', label: '途中', kana: 'とちゅう', cls: 'st-mid' },
  [STATUS.FORGOTTEN]: { icon: '×', label: '忘れた', kana: 'わすれた', cls: 'st-bad' },
  [STATUS.REDO]: { icon: '★', label: '直し', kana: 'なおし', cls: 'st-redo' },
  [STATUS.RESUBMIT_WAIT]: { icon: '→', label: '確認中', kana: 'かくにんちゅう', cls: 'st-wait' },
  [STATUS.EXEMPT]: { icon: '–', label: '免除', kana: 'めんじょ', cls: 'st-none' },
};

function childLabel(status) {
  switch (status) {
    case STATUS.NOT_SUBMITTED: return 'まだ';
    case STATUS.SUBMITTED: return rubyHtml('出', 'だ') + 'せた';
    case STATUS.IN_PROGRESS: return rubyHtml('途中', 'とちゅう');
    case STATUS.FORGOTTEN: return rubyHtml('忘', 'わす') + 'れた';
    case STATUS.REDO: return rubyHtml('直', 'なお') + 'し';
    case STATUS.RESUBMIT_WAIT: return rubyHtml('確認中', 'かくにんちゅう');
    case STATUS.EXEMPT: return rubyHtml('免除', 'めんじょ');
    default: return STATUS_META[status].label;
  }
}

function itemNameHtml(a) {
  const detail = a.detail ? `　${escapeHtml(a.detail)}` : '';
  return rubyHtml(a.item.name, a.item.kana) + detail;
}

function itemNamePlain(a) {
  return escapeHtml(a.item.name) + (a.detail ? `　${escapeHtml(a.detail)}` : '');
}

// コメントに「欠席」が入っていて、まだ出していない状態の人は、未提出に数えない。
function isAbsent(status, comment) {
  const notDone = status === STATUS.NOT_SUBMITTED || status === STATUS.IN_PROGRESS || status === STATUS.FORGOTTEN;
  return notDone && !!comment && comment.includes('欠席');
}

function deadlineBadge(deadline) {
  const dl = deadlineState(deadline);
  if (!dl) return '';
  const cls = { over: 'dl-over', today: 'dl-today', soon: 'dl-soon', ok: 'dl-ok' }[dl.level];
  const note = { over: '・過ぎています', today: '・今日まで', soon: '・もうすぐ', ok: '' }[dl.level];
  return `<span class="dl-badge ${cls}">提出期限 ${formatDateTimeJp(deadline)}${note}</span>`;
}

const app = document.getElementById('app');

const state = {
  screen: 'childSelect',
  studentId: null,
  pendingStudentId: null,
  modal: null,
  teacherTab: 'home',
  inactivityTimer: null,
  pending: new Map(), // assignmentId -> {status, plannedDate} 「登録する」で確定させるまでの仮の選択
};

let pendingJoinCode = null;

function effectiveStatus(assignmentId, dbStatus) {
  return state.pending.has(assignmentId) ? state.pending.get(assignmentId).status : dbStatus;
}

async function commitPending() {
  for (const [assignmentId, p] of state.pending) {
    await setStatus(state.studentId, assignmentId, p.status, 'child', p.plannedDate);
  }
  state.pending.clear();
}

async function ensureBootstrap() {
  const pin = await getMeta('pin', null);
  if (pin === null) await setMeta('pin', '0000');
  // 既存データ（コード未設定の児童）への後方互換
  const students = await DB.getAll('students');
  for (const s of students) {
    if (!s.code) {
      s.code = generateCode();
      await DB.put('students', s);
    }
  }
}

function goto(screen, extra = {}) {
  Object.assign(state, { screen, modal: null }, extra);
  render();
}

function resetInactivityTimer() {
  if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
  if (state.screen === 'childPage' || state.screen === 'childConfirm') {
    state.inactivityTimer = setTimeout(async () => {
      await commitPending();
      goto('childSelect');
    }, 20000);
  }
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 1600);
}

function showCelebration() {
  const el = document.createElement('div');
  el.className = 'celebration-overlay';
  el.innerHTML = `<div class="celebration-box">🎉<br>${rubyHtml('全部', 'ぜんぶ')}${rubyHtml('出', 'だ')}せたね！<br>えらい！</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  el.addEventListener('click', () => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 2400);
}

// ---------- データ取得ヘルパー ----------

async function getActiveStudents() {
  const all = await DB.getAll('students');
  return all.filter(s => s.active !== false).sort((a, b) => a.number - b.number);
}

function itemOrderKey(i) {
  return i.order ?? i.id;
}

function sortItems(list) {
  return list.slice().sort((a, b) => itemOrderKey(a) - itemOrderKey(b) || a.id - b.id);
}

async function getActiveItems() {
  const all = await DB.getAll('items');
  return sortItems(all.filter(i => i.active !== false));
}

async function moveItem(itemId, dir) {
  const all = sortItems(await DB.getAll('items'));
  const idx = all.findIndex(i => i.id === itemId);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= all.length) return;
  const before = new Map(all.map(i => [i.id, i.order]));
  all.forEach((it, k) => { it.order = k; });
  [all[idx].order, all[j].order] = [all[j].order, all[idx].order];
  for (const it of all) {
    if (it.order === before.get(it.id)) continue;
    await DB.put('items', it);
    Sync.pushItem(it);
  }
}

async function getAssignmentsForDate(date) {
  const list = await DB.getAllByIndex('assignments', 'date', date);
  const items = await DB.getAll('items');
  const itemMap = Object.fromEntries(items.map(i => [i.id, i]));
  return list.map(a => ({ ...a, item: itemMap[a.itemId] }));
}

async function getTodayAssignments() {
  return getAssignmentsForDate(todayStr());
}

async function getAllAssignmentsWithItems() {
  const list = await DB.getAll('assignments');
  const items = await DB.getAll('items');
  const itemMap = Object.fromEntries(items.map(i => [i.id, i]));
  return list.map(a => ({ ...a, item: itemMap[a.itemId] }));
}

async function getStatus(studentId, assignmentId) {
  const key = `${studentId}_${assignmentId}`;
  return (await DB.get('statuses', key)) || {
    key, studentId, assignmentId, status: STATUS.NOT_SUBMITTED, plannedDate: null, updatedAt: null, updatedBy: null,
  };
}

async function getStudentStatuses(studentId) {
  return DB.getAllByIndex('statuses', 'studentId', studentId);
}

async function setStatus(studentId, assignmentId, status, actor, plannedDate) {
  const key = `${studentId}_${assignmentId}`;
  const existing = await DB.get('statuses', key);
  const row = {
    key, studentId, assignmentId, status,
    plannedDate: status === STATUS.SUBMITTED ? null : (plannedDate !== undefined ? plannedDate : (existing ? existing.plannedDate : null)),
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
    ...(existing && existing.comment ? { comment: existing.comment } : {}),
  };
  await DB.put('statuses', row);
  const fsId = uid();
  const historyId = await DB.add('history', { studentId, assignmentId, status, actor, at: row.updatedAt, fsId });
  Sync.pushStatus(row);
  Sync.pushHistory({ id: historyId, fsId, studentId, assignmentId, status, actor, at: row.updatedAt });
  return row;
}

async function deleteStudentCascade(studentId) {
  const statuses = await DB.getAllByIndex('statuses', 'studentId', studentId);
  for (const s of statuses) {
    await DB.delete('statuses', s.key);
    Sync.deleteStatusRemote(studentId, s.assignmentId);
  }
  const history = await DB.getAllByIndex('history', 'studentId', studentId);
  for (const h of history) await DB.delete('history', h.id);
  await DB.delete('students', studentId);
}

async function studentNameExists(name, excludeId = null) {
  const all = await DB.getAll('students');
  return all.some(s => s.name === name && s.id !== excludeId);
}

async function itemNameExists(name, excludeId = null) {
  const all = await DB.getAll('items');
  return all.some(i => i.name === name && i.id !== excludeId);
}

async function addItemLocal(data) {
  const syncId = uid();
  const existing = await DB.getAll('items');
  const order = existing.reduce((m, i) => Math.max(m, itemOrderKey(i)), 0) + 1;
  const row = { ...data, order, syncId };
  const id = await DB.add('items', row);
  Sync.pushItem({ ...row, id });
  return id;
}

async function addAssignmentLocal(data) {
  const syncId = uid();
  const id = await DB.add('assignments', { ...data, syncId });
  const item = await DB.get('items', data.itemId);
  Sync.pushAssignment({ ...data, id, syncId }, item ? item.syncId : null);
  return id;
}

async function deleteItemCascade(itemId) {
  const item = await DB.get('items', itemId);
  const assignments = (await DB.getAll('assignments')).filter(a => a.itemId === itemId);
  for (const a of assignments) {
    const statuses = await DB.getAllByIndex('statuses', 'assignmentId', a.id);
    for (const s of statuses) {
      await DB.delete('statuses', s.key);
      Sync.deleteStatusRemote(s.studentId, a.id);
    }
    const history = await DB.getAllByIndex('history', 'assignmentId', a.id);
    for (const h of history) await DB.delete('history', h.id);
    await DB.delete('assignments', a.id);
    Sync.deleteAssignmentRemote(a);
  }
  await DB.delete('items', itemId);
  Sync.deleteItemRemote(item);
}

// ---------- 児童モード ----------

async function renderChildSelect() {
  const students = await getActiveStudents();
  const panels = students.map(s => `
    <button class="num-btn" data-action="pickStudent" data-id="${s.id}">${s.number}</button>
  `).join('');
  app.innerHTML = `
    <div class="screen child-select">
      <h1 class="page-title">${rubyHtml('出席番号', 'しゅっせきばんごう')}を ${rubyHtml('押', 'お')}してね</h1>
      <div class="num-grid">${panels || '<p class="empty">児童が登録されていません</p>'}</div>
      <button class="teacher-link" data-action="goTeacherPin">教師用</button>
    </div>
  `;
}

async function renderChildConfirm() {
  const student = await DB.get('students', state.pendingStudentId);
  if (!student) { goto('childSelect'); return; }
  app.innerHTML = `
    <div class="screen child-confirm">
      <p class="confirm-lead">この${rubyHtml('番号', 'ばんごう')}で</p>
      <div class="confirm-name">${student.number}${rubyHtml('番', 'ばん')} ${rubyHtml(student.name, student.kana)}</div>
      <p class="confirm-lead">${rubyHtml('間違', 'まちが')}いないですか？</p>
      <div class="confirm-buttons">
        <button class="big-btn yes" data-action="confirmStudent">${rubyHtml('はい', '')}</button>
        <button class="big-btn no" data-action="cancelStudent">${rubyHtml('違', 'ちが')}う</button>
      </div>
    </div>
  `;
  resetInactivityTimer();
}

// 児童画面の「今出すもの／直すもの／後で出すもの」の振り分け。
// finishChild・markAllSubmittedからも同じ基準を使うために共通化している。
async function getChildRows(studentId) {
  const today = todayStr();
  const allAssignments = await getAllAssignmentsWithItems();
  const todayRows = [];
  const redoRows = [];
  const laterRows = [];
  for (const a of allAssignments) {
    if (!a.item) continue;
    const st = await getStatus(studentId, a.id);
    const eff = effectiveStatus(a.id, st.status);
    if (eff === STATUS.REDO || eff === STATUS.RESUBMIT_WAIT) {
      redoRows.push({ a, st });
      continue;
    }
    if (eff === STATUS.SUBMITTED || eff === STATUS.EXEMPT) continue;
    if (st.plannedDate && eff !== STATUS.NOT_SUBMITTED) {
      laterRows.push({ a, st });
      continue;
    }
    // 未着手（未提出のまま放置）は、今日の分に加えて過去の分も出し続ける（先送りされないように）。
    if (a.date <= today) {
      todayRows.push({ a, st, eff, overdue: a.date < today });
    }
  }
  return { todayRows, redoRows, laterRows };
}

async function renderChildPage() {
  const student = await DB.get('students', state.studentId);
  if (!student) { goto('childSelect'); return; }

  const { todayRows, redoRows, laterRows } = await getChildRows(student.id);

  const history = await getStudentStatuses(student.id);
  const submittedCount = history.filter(h => h.status === STATUS.SUBMITTED).length;
  const histAll = await DB.getAllByIndex('history', 'studentId', student.id);
  const forgottenAssignments = new Set(histAll.filter(h => h.status === STATUS.FORGOTTEN).map(h => h.assignmentId));

  const hasUntouched = todayRows.some(({ a, eff }) => eff === STATUS.NOT_SUBMITTED);
  const todayHtml = todayRows.length ? todayRows.map(({ a, eff, overdue }) => {
    const meta = STATUS_META[eff];
    const isPending = state.pending.has(a.id);
    const clickable = isPending || (eff !== STATUS.SUBMITTED && eff !== STATUS.EXEMPT);
    const dateNote = overdue ? `<span class="dl-badge dl-over">${formatDateJp(a.date)}の${rubyHtml('分', 'ぶん')}</span>` : '';
    return `<li class="item-row ${meta.cls}" ${clickable ? `data-action="openItemSheet" data-assignment="${a.id}"` : `data-action="alreadyDone"`}>
      <span class="item-icon">${meta.icon}</span>
      <span class="item-name">${itemNameHtml(a)}${dateNote}</span>
      <span class="item-status">${childLabel(eff)}</span>
    </li>`;
  }).join('') : `<li class="empty-row">${rubyHtml('今日', 'きょう')}はありません</li>`;
  const bulkButtonHtml = hasUntouched
    ? `<button class="mini-btn primary" data-action="markAllSubmitted" style="margin-bottom:10px;">${rubyHtml('全部', 'ぜんぶ')}${rubyHtml('出', 'だ')}せた</button>`
    : '';

  const redoHtml = redoRows.length ? redoRows.map(({ a, st }) => {
    const waiting = st.status === STATUS.RESUBMIT_WAIT;
    return `<li class="item-row ${waiting ? 'st-wait' : 'st-redo'}" data-action="${waiting ? 'redoInfo' : 'openRedoSheet'}" data-assignment="${a.id}">
      <span class="item-icon">${waiting ? '→' : '★'}</span>
      <span class="item-name">${itemNameHtml(a)}${st.comment ? `<span class="item-comment">${rubyHtml('先生', 'せんせい')}から：${escapeHtml(st.comment)}</span>` : ''}</span>
      <span class="item-status">${waiting ? childLabel(STATUS.RESUBMIT_WAIT) : rubyHtml('直', 'なお') + 'してね'}</span>
    </li>`;
  }).join('') : '<li class="empty-row">ありません</li>';

  const laterHtml = laterRows.length ? laterRows.map(({ a, st }) => `
    <li class="item-row st-mid" data-action="openItemSheet" data-assignment="${a.id}">
      <span class="item-icon">△</span>
      <span class="item-name">${itemNameHtml(a)}</span>
      <span class="item-status">${formatDateTimeJp(st.plannedDate)}まで</span>
    </li>`).join('') : '<li class="empty-row">ありません</li>';

  app.innerHTML = `
    <div class="screen child-page">
      <div class="child-header">${student.number}${rubyHtml('番', 'ばん')} ${rubyHtml(student.name, student.kana)}${rubyHtml('さん', '')}</div>

      <section class="card">
        <h2>${rubyHtml('今', 'いま')}${rubyHtml('出', 'だ')}すもの</h2>
        ${bulkButtonHtml}
        <ul class="item-list">${todayHtml}</ul>
      </section>

      <section class="card">
        <h2>${rubyHtml('直', 'なお')}すもの</h2>
        <ul class="item-list">${redoHtml}</ul>
      </section>

      <section class="card">
        <h2>${rubyHtml('後', 'あと')}で${rubyHtml('出', 'だ')}すもの</h2>
        <ul class="item-list">${laterHtml}</ul>
      </section>

      <section class="card small">
        <h2>これまでの${rubyHtml('様子', 'ようす')}</h2>
        <p>${rubyHtml('出', 'だ')}せた　${submittedCount}${rubyHtml('回', 'かい')}</p>
        <p>${rubyHtml('忘', 'わす')}れた　${forgottenAssignments.size}${rubyHtml('回', 'かい')}</p>
      </section>

      <button class="finish-btn" data-action="finishChild">${rubyHtml('登録', 'とうろく')}する</button>
    </div>
  `;
  resetInactivityTimer();
}

function renderModal(html) {
  closeModal();
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.id = 'modalOverlay';
  wrap.innerHTML = `<div class="modal-box">${html}</div>`;
  document.body.appendChild(wrap);
}

function closeModal() {
  stopQrScanner();
  const el = document.getElementById('modalOverlay');
  if (el) el.remove();
}

async function openConfirmSheet(untouched) {
  const allAssignments = await getAllAssignmentsWithItems();
  const assignmentMap = Object.fromEntries(allAssignments.map(a => [a.id, a]));
  const rows = [...state.pending.entries()];
  const pendingHtml = rows.length
    ? rows.map(([id, p]) => {
      const a = assignmentMap[id];
      return `<li>${a ? escapeHtml(a.item.name) : ''}：${childLabel(p.status)}</li>`;
    }).join('')
    : `<li>${rubyHtml('変更', 'へんこう')}なし</li>`;
  const untouchedHtml = untouched.length
    ? `<p style="color:var(--bad);">${rubyHtml('まだ確認', 'まだかくにん')}していません：${untouched.map(a => escapeHtml(a.item.name)).join('・')}</p>`
    : '';
  renderModal(`
    <h3>${rubyHtml('登録', 'とうろく')}の${rubyHtml('確認', 'かくにん')}</h3>
    <ul style="text-align:left;">${pendingHtml}</ul>
    ${untouchedHtml}
    <div class="sheet-buttons">
      <button class="big-btn cancel" data-action="closeModal">${rubyHtml('もどる', '')}</button>
      <button class="big-btn yes" data-action="confirmRegister">これで${rubyHtml('登録', 'とうろく')}する</button>
    </div>
  `);
}

async function openItemSheet(assignmentId) {
  const st = await getStatus(state.studentId, assignmentId);
  const eff = effectiveStatus(assignmentId, st.status);
  const forgottenLabel = eff === STATUS.FORGOTTEN
    ? `${rubyHtml('予定日', 'よていび')}を${rubyHtml('決', 'き')}め${rubyHtml('直', 'なお')}す`
    : `${rubyHtml('忘', 'わす')}れた`;
  renderModal(`
    <h3>${rubyHtml('どうする？', '')}</h3>
    <div class="sheet-buttons">
      <button class="big-btn yes" data-action="setChildStatus" data-status="${STATUS.SUBMITTED}" data-assignment="${assignmentId}">${rubyHtml('出', 'だ')}せた</button>
      <button class="big-btn" data-action="openPlanSheet" data-status="${STATUS.IN_PROGRESS}" data-assignment="${assignmentId}">${rubyHtml('途中', 'とちゅう')}</button>
      <button class="big-btn" data-action="openPlanSheet" data-status="${STATUS.FORGOTTEN}" data-assignment="${assignmentId}">${forgottenLabel}</button>
      <button class="big-btn cancel" data-action="closeModal">${rubyHtml('やめる', '')}</button>
    </div>
  `);
}

// 土日・登録済みの休業日（祝日など）を「いつ出す」の選択肢から外すための仕組み。
async function getHolidays() {
  const list = await getMeta('holidays', []);
  return Array.isArray(list) ? list : [];
}

// 1日だけの登録と期間（date〜end）の登録を、日付ごとの集合にほどいて返す。
async function getHolidaySet() {
  const set = new Set();
  if (await getMeta('autoHolidays', true) !== false) {
    const thisYear = new Date().getFullYear();
    for (let y = thisYear - 1; y <= thisYear + 3; y++) {
      for (const k of japaneseHolidays(y).keys()) set.add(k);
    }
  }
  for (const h of await getHolidays()) {
    let d = h.date;
    const end = h.end && h.end > h.date ? h.end : h.date;
    for (let guard = 0; d <= end && guard < 400; guard++) {
      set.add(d);
      d = addDays(d, 1);
    }
  }
  return set;
}

function isSchoolDay(dateStr, holidaySet) {
  const wd = new Date(dateStr + 'T00:00:00').getDay();
  if (wd === 0 || wd === 6) return false;
  return !holidaySet.has(dateStr);
}

// fromDateStrを含めて、学校がある日をcount件、日付が早い順に集める。
function nextSchoolDays(fromDateStr, count, holidaySet) {
  const results = [];
  let d = fromDateStr;
  let offset = 0;
  let guard = 0;
  while (results.length < count && guard < 60) {
    if (isSchoolDay(d, holidaySet)) results.push({ date: d, offset });
    d = addDays(d, 1);
    offset++;
    guard++;
  }
  return results;
}

async function openPlanSheet(assignmentId, targetStatus) {
  const weekdayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const labels = { 0: ['今日中', 'きょうじゅう'], 1: ['明日', 'あした'], 2: ['明後日', 'あさって'] };
  const holidaySet = await getHolidaySet();
  const candidates = nextSchoolDays(todayStr(), 3, holidaySet);
  const buttons = candidates.map(({ date, offset }) => {
    const wd = weekdayNames[new Date(date + 'T00:00:00').getDay()];
    const label = labels[offset] ? rubyHtml(labels[offset][0], labels[offset][1]) + '　' : '';
    return `<button class="big-btn" data-action="pickPlanDate" data-date="${date}" data-status="${targetStatus}" data-assignment="${assignmentId}">${label}${formatDateJp(date)}(${wd})</button>`;
  }).join('');
  renderModal(`
    <h3>いつ${rubyHtml('出', 'だ')}す？</h3>
    <div class="sheet-buttons">
      ${buttons}
      <button class="big-btn" data-action="openPlanCustomDate" data-status="${targetStatus}" data-assignment="${assignmentId}">${rubyHtml('自分', 'じぶん')}で${rubyHtml('選', 'えら')}ぶ</button>
      <button class="big-btn cancel" data-action="closeModal">${rubyHtml('やめる', '')}</button>
    </div>
  `);
}

async function openPlanCustomDate(assignmentId, targetStatus) {
  const holidaySet = await getHolidaySet();
  const [minDate] = nextSchoolDays(todayStr(), 1, holidaySet).map(c => c.date);
  renderModal(`
    <h3>${rubyHtml('日付', 'ひづけ')}を${rubyHtml('選', 'えら')}ぶ</h3>
    <input type="date" id="customPlanDate" min="${minDate}" value="${minDate}" class="deadline-input">
    <p style="color:#666;font-size:0.85rem;">土日・お休みの日は選べません。</p>
    <div class="sheet-buttons">
      <button class="big-btn yes" data-action="pickPlanDateCustom" data-status="${targetStatus}" data-assignment="${assignmentId}">${rubyHtml('次', 'つぎ')}へ</button>
      <button class="big-btn cancel" data-action="closeModal">${rubyHtml('やめる', '')}</button>
    </div>
  `);
}

const DEFAULT_TIME_PRESETS = [
  { time: '08:10', label: '朝の会まで', kana: 'あさのかいまで' },
  { time: '10:30', label: '3時間目が始まるまで', kana: 'さんじかんめがはじまるまで' },
  { time: '13:15', label: '5時間目が始まるまで', kana: 'ごじかんめがはじまるまで' },
  { time: '15:00', label: '帰るまで', kana: 'かえるまで' },
  { time: '16:30', label: '放課後', kana: 'ほうかご' },
];

async function getTimePresets() {
  const presets = await getMeta('timePresets', null);
  return (Array.isArray(presets) && presets.length) ? presets : DEFAULT_TIME_PRESETS;
}

async function openPlanTimeSheet(assignmentId, targetStatus, dateStr) {
  const weekdayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const wd = weekdayNames[new Date(dateStr + 'T00:00:00').getDay()];
  const presets = await getTimePresets();
  const buttons = presets.map(p =>
    `<button class="big-btn" data-action="setPlan" data-date="${dateStr}" data-time="${p.time}" data-status="${targetStatus}" data-assignment="${assignmentId}">${rubyHtml(p.label, p.kana)}</button>`
  ).join('');
  renderModal(`
    <h3>${formatDateJp(dateStr)}(${wd}) ${rubyHtml('何時', 'なんじ')}まで？</h3>
    <div class="sheet-buttons">
      ${buttons}
      <button class="big-btn cancel" data-action="closeModal">${rubyHtml('やめる', '')}</button>
    </div>
  `);
}

function localDateTimeToIso(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}

function suggestDeadlineDefaults() {
  const now = new Date();
  const minVal = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  // きりのいい時刻(30分単位)で、今から3時間後をデフォルトに
  const def = new Date(now.getTime() + 3 * 3600000);
  def.setMinutes(Math.ceil(def.getMinutes() / 30) * 30, 0, 0);
  const defaultVal = new Date(def.getTime() - def.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return { minVal, defaultVal };
}

function openRedoSheet(assignmentId) {
  renderModal(`
    <h3>${rubyHtml('直', 'なお')}して${rubyHtml('出', 'だ')}す？</h3>
    <div class="sheet-buttons">
      <button class="big-btn yes" data-action="resubmit" data-assignment="${assignmentId}">${rubyHtml('直', 'なお')}して${rubyHtml('出', 'だ')}した</button>
      <button class="big-btn cancel" data-action="closeModal">${rubyHtml('やめる', '')}</button>
    </div>
  `);
}

// ---------- 教師モード ----------

async function renderTeacherPin() {
  app.innerHTML = `
    <div class="screen teacher-pin">
      <h1>教師用 PIN</h1>
      <div class="pin-display" id="pinDisplay"></div>
      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key-btn" data-action="pinDigit" data-d="${n}">${n}</button>`).join('')}
        <button class="key-btn" data-action="pinClear">C</button>
        <button class="key-btn" data-action="pinDigit" data-d="0">0</button>
        <button class="key-btn" data-action="pinBack">←</button>
      </div>
      <button class="teacher-link" data-action="goChildSelect">児童画面に戻る</button>
    </div>
  `;
  state.pinInput = '';
  updatePinDisplay();
}

function updatePinDisplay() {
  const el = document.getElementById('pinDisplay');
  if (el) el.textContent = '●'.repeat(state.pinInput.length) + '–'.repeat(Math.max(0, 4 - state.pinInput.length));
}

let teacherHomeDate = null;

async function renderTeacherHome() {
  const targetDate = teacherHomeDate || todayStr();
  const isToday = targetDate === todayStr();
  const dateList = await getAssignmentsForDate(targetDate);
  const students = await getActiveStudents();
  const allAssignments = await getAllAssignmentsWithItems();

  let unsubmittedCount = 0, overCount = 0, confirmedCount = 0, targetCount = 0;
  const unsubmittedByStudent = new Map();

  for (const a of dateList) {
    if (!a.item) continue;
    const dl = deadlineState(a.deadline);
    for (const s of students) {
      const st = await getStatus(s.id, a.id);
      if (st.status === STATUS.EXEMPT || isAbsent(st.status, st.comment)) continue;
      targetCount++;
      if (st.status === STATUS.SUBMITTED) confirmedCount++;
      if (![STATUS.SUBMITTED, STATUS.REDO, STATUS.RESUBMIT_WAIT].includes(st.status)) {
        unsubmittedCount++;
        if (!unsubmittedByStudent.has(s.id)) unsubmittedByStudent.set(s.id, { student: s, items: [] });
        unsubmittedByStudent.get(s.id).items.push({ a, st, dl });
        if (dl && dl.level === 'over') overCount++;
      }
    }
  }

  // 未着手のまま放置された過去分は、今日の画面でも見落とさないよう繰り越して表示する。
  if (isToday) {
    for (const a of allAssignments) {
      if (!a.item || a.date >= targetDate) continue;
      const dl = deadlineState(a.deadline);
      for (const s of students) {
        const st = await getStatus(s.id, a.id);
        if (st.status !== STATUS.NOT_SUBMITTED || st.plannedDate || isAbsent(st.status, st.comment)) continue;
        targetCount++;
        unsubmittedCount++;
        if (!unsubmittedByStudent.has(s.id)) unsubmittedByStudent.set(s.id, { student: s, items: [] });
        unsubmittedByStudent.get(s.id).items.push({ a, st, dl, carried: true });
        if (dl && dl.level === 'over') overCount++;
      }
    }
  }

  const redoByStudent = new Map();
  let redoCount = 0;
  for (const a of allAssignments) {
    if (!a.item) continue;
    for (const s of students) {
      const st = await getStatus(s.id, a.id);
      if (st.status === STATUS.REDO || st.status === STATUS.RESUBMIT_WAIT) {
        redoCount++;
        if (!redoByStudent.has(s.id)) redoByStudent.set(s.id, { student: s, items: [] });
        redoByStudent.get(s.id).items.push({ a, st });
      }
    }
  }

  const unsubmittedHtml = [...unsubmittedByStudent.values()].map(({ student, items }) => `
    <li class="t-row" data-action="openStudentQuick" data-id="${student.id}" data-date="${targetDate}">
      <span class="t-num">${student.number}番</span>
      <span class="t-name">${escapeHtml(student.name)}</span>
      <span class="t-items">${items.map(i => itemNamePlain(i.a) + (i.carried ? `<span class="dl-badge dl-over">${formatDateJp(i.a.date)}の分</span>` : '') + (i.dl ? deadlineBadge(i.a.deadline) : '')).join('・')}</span>
    </li>`).join('') || '<li class="empty-row">未提出はありません</li>';

  const redoHtml = [...redoByStudent.values()].map(({ student, items }) => `
    <li class="t-row" data-action="openRedoQuick" data-id="${student.id}">
      <span class="t-num">${student.number}番</span>
      <span class="t-name">${escapeHtml(student.name)}</span>
      <span class="t-items">${items.map(i => `${itemNamePlain(i.a)}(${STATUS_META[i.st.status].label})`).join('・')}</span>
    </li>`).join('') || '<li class="empty-row">ありません</li>';

  app.innerHTML = `
    <div class="screen teacher-home">
      ${teacherNav('home')}
      <div class="day-nav">
        <button class="mini-btn" id="homePrevBtn" type="button">◀ 前の日</button>
        <strong class="day-title">${formatDateJp(targetDate)}（${['日', '月', '火', '水', '木', '金', '土'][new Date(targetDate + 'T00:00:00').getDay()]}）${isToday ? '＝今日' : ''}</strong>
        <button class="mini-btn" id="homeNextBtn" type="button">次の日 ▶</button>
      </div>
      <div class="form-row" style="margin:0 0 16px;justify-content:center;">
        <input type="date" id="homeDateInput" value="${targetDate}">
        <button class="mini-btn" id="homeGotoTodayBtn" type="button">今日にする</button>
      </div>
      <div class="summary-cards">
        <div class="sum-card">確認できた ${confirmedCount}/${targetCount}件</div>
        <div class="sum-card warn">未提出 ${unsubmittedCount}件</div>
        <div class="sum-card redo">直し ${redoCount}件</div>
        <div class="sum-card over">提出期限を過ぎた ${overCount}件</div>
      </div>
      <section class="card">
        <h2>未提出一覧</h2>
        <ul class="t-list">${unsubmittedHtml}</ul>
      </section>
      <section class="card">
        <h2>直し・再提出待ち</h2>
        <ul class="t-list">${redoHtml}</ul>
      </section>
    </div>
  `;
  document.getElementById('homePrevBtn').addEventListener('click', () => {
    teacherHomeDate = addDays(targetDate, -1);
    renderTeacherHome();
  });
  document.getElementById('homeNextBtn').addEventListener('click', () => {
    teacherHomeDate = addDays(targetDate, 1);
    renderTeacherHome();
  });
  document.getElementById('homeDateInput').addEventListener('change', (e) => {
    teacherHomeDate = e.target.value || todayStr();
    renderTeacherHome();
  });
  document.getElementById('homeGotoTodayBtn').addEventListener('click', () => {
    teacherHomeDate = todayStr();
    renderTeacherHome();
  });
}

function teacherNav(active) {
  const tabs = [
    ['home', 'ホーム'],
    ['today', '提出物'],
    ['students', '名簿'],
    ['settings', '設定'],
  ];
  return `<nav class="teacher-nav">
    ${tabs.map(([k, label]) => `<button class="nav-btn ${active === k ? 'active' : ''}" data-action="teacherTab" data-tab="${k}">${label}</button>`).join('')}
    <button class="nav-btn child" data-action="goChildSelect">児童画面へ</button>
  </nav>`;
}

// 「提出物」タブの中の切り替え（日ごとの登録／提出物の一覧・追加）
function itemsSubNav(active) {
  const tabs = [['today', '日ごとの登録'], ['items', '提出物の一覧・追加']];
  return `<div class="sub-nav">${tabs.map(([k, label]) =>
    `<button class="sub-nav-btn ${active === k ? 'active' : ''}" data-action="teacherTab" data-tab="${k}">${label}</button>`).join('')}</div>`;
}

async function renderTeacherStudents() {
  const students = (await DB.getAll('students')).sort((a, b) => a.number - b.number);
  const rows = students.map(s => `
    <li class="t-row compact">
      <span class="t-num">${s.number}番</span>
      <span class="t-name">${rubyHtml(s.name, s.kana)}${s.active === false ? '（停止中）' : ''}</span>
      <button class="mini-btn" data-action="openStudentActions" data-id="${s.id}">操作</button>
    </li>`).join('') || '<li class="empty-row">未登録</li>';

  app.innerHTML = `
    <div class="screen teacher-page">
      ${teacherNav('students')}
      <h1>名簿</h1>
      <ul class="t-list">${rows}</ul>
      <section class="card">
        <h2>追加</h2>
        <form id="addStudentForm" class="form-row">
          <input type="number" min="1" name="number" placeholder="出席番号" required>
          <input type="text" name="name" placeholder="氏名" required>
          <input type="text" name="kana" placeholder="ふりがな（任意）">
          <button type="submit" class="mini-btn primary">追加</button>
        </form>
      </section>
      <section class="card">
        <h2>CSVで一括登録</h2>
        <p style="color:#666;font-size:0.9rem;">1行目は見出し、2行目以降に「出席番号,氏名,ふりがな」の順で入力してください（ふりがなは省略可）。</p>
        <button class="mini-btn" id="downloadStudentTemplateBtn">テンプレートをダウンロード</button>
        <label class="mini-btn" style="display:inline-block;cursor:pointer;">
          CSVファイルを選ぶ
          <input type="file" id="studentCsvFile" accept=".csv,text/csv" style="display:none;">
        </label>
      </section>
      <section class="card">
        <h2>他の端末に名簿を揃える</h2>
        <p style="color:#666;font-size:0.9rem;">この端末の名簿（氏名＋コード）をCSVで書き出し、他の端末（iPhoneなど）で読み込むと、同じ児童に同じコードが割り当てられます。クラウド同期はこのコードを使って行うため、全端末でコードを揃えてください。このファイルには氏名が含まれるので、他人に渡さないでください。</p>
        <button class="mini-btn" id="exportStudentCodeCsvBtn">名簿（コード付き）を書き出す</button>
        <button class="mini-btn" id="showRosterQrBtn">QRコードで表示</button>
        <div style="margin-top:8px;">
          <label class="mini-btn" style="display:inline-block;cursor:pointer;">
            名簿（コード付き）を読み込む
            <input type="file" id="studentCodeCsvFile" accept=".csv,text/csv" style="display:none;">
          </label>
          <button class="mini-btn" id="scanRosterQrBtn">QRコードを読み取る</button>
        </div>
      </section>
    </div>
  `;
  attachFuriganaAutofill(document.querySelector('#addStudentForm [name=name]'), document.querySelector('#addStudentForm [name=kana]'));
  document.getElementById('addStudentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const number = Number(fd.get('number'));
    const name = String(fd.get('name')).trim();
    const kana = String(fd.get('kana') || '').trim();
    if (!name) return;
    if (await studentNameExists(name)) {
      alert(`「${name}」という名前はすでに登録されています。`);
      return;
    }
    await DB.add('students', { number, name, kana, code: generateCode(), active: true });
    renderTeacherStudents();
  });
  document.getElementById('downloadStudentTemplateBtn').addEventListener('click', () => {
    downloadCsv('名簿テンプレート.csv', [['出席番号', '氏名', 'ふりがな'], [1, '山田太郎', 'やまだたろう']]);
  });
  document.getElementById('studentCsvFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCsv(text).slice(1);
      const existingNames = new Set((await DB.getAll('students')).map(s => s.name));
      let count = 0, skipped = 0;
      for (const r of rows) {
        const number = Number(r[0]);
        const name = (r[1] || '').trim();
        const kana = (r[2] || '').trim();
        if (!name || !Number.isFinite(number)) continue;
        if (existingNames.has(name)) { skipped++; continue; }
        await DB.add('students', { number, name, kana, code: generateCode(), active: true });
        existingNames.add(name);
        count++;
      }
      showToast(`${count}件 取り込みました${skipped ? `（重複のため${skipped}件スキップ）` : ''}`);
      renderTeacherStudents();
    } catch (err) {
      alert('CSVの読み込みに失敗しました: ' + (err && err.message ? err.message : String(err)));
    }
  });
  document.getElementById('exportStudentCodeCsvBtn').addEventListener('click', async () => {
    const rows = await rosterCodeRows();
    downloadCsv(`名簿コード付き_${todayStr()}.csv`, rows);
  });
  document.getElementById('showRosterQrBtn').addEventListener('click', async () => {
    const rows = await rosterCodeRows();
    showRosterQr(rows);
  });
  document.getElementById('scanRosterQrBtn').addEventListener('click', () => {
    openRosterQrScanner();
  });
  document.getElementById('studentCodeCsvFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCsv(text).slice(1);
      const existingNames = new Set((await DB.getAll('students')).map(s => s.name));
      let count = 0, skipped = 0;
      for (const r of rows) {
        const number = Number(r[0]);
        const name = (r[1] || '').trim();
        const kana = (r[2] || '').trim();
        const code = (r[3] || '').trim();
        if (!name || !Number.isFinite(number) || !code) continue;
        if (existingNames.has(name)) { skipped++; continue; }
        await DB.add('students', { number, name, kana, code, active: true });
        existingNames.add(name);
        count++;
      }
      showToast(`${count}件 取り込みました${skipped ? `（重複のため${skipped}件スキップ）` : ''}`);
      renderTeacherStudents();
    } catch (err) {
      alert('CSVの読み込みに失敗しました: ' + (err && err.message ? err.message : String(err)));
    }
  });
}

async function openItemActions(itemId, name) {
  const i = await DB.get('items', itemId);
  renderModal(`
    <h3>${escapeHtml(name)}</h3>
    <div class="sheet-buttons">
      <button class="big-btn" data-action="toggleItemActive" data-id="${i.id}">${i.active === false ? '復帰させる' : '停止する'}</button>
      <button class="big-btn cancel" data-action="deleteItem" data-id="${i.id}" data-name="${escapeHtml(name)}">削除する</button>
      <button class="big-btn cancel" data-action="closeModal">閉じる</button>
    </div>
  `);
}

async function renderTeacherItems() {
  const items = sortItems(await DB.getAll('items'));
  const students = await getActiveStudents();
  const assignments = await DB.getAll('assignments');
  const rowsArr = [];
  for (const [idx, i] of items.entries()) {
    const itemAssignments = assignments.filter(a => a.itemId === i.id);
    let submitted = 0, target = 0;
    for (const a of itemAssignments) {
      for (const s of students) {
        const st = await getStatus(s.id, a.id);
        if (st.status !== STATUS.EXEMPT) {
          target++;
          if (st.status === STATUS.SUBMITTED) submitted++;
        }
      }
    }
    const rate = target > 0 ? Math.round((submitted / target) * 100) : null;
    rowsArr.push(`
    <li class="t-row compact">
      <span class="t-name">${escapeHtml(i.name)}${i.active === false ? '（停止中）' : ''}</span>
      <span class="t-items">${rate === null ? '－' : rate + '%'}</span>
      <button class="mini-btn" data-action="moveItem" data-id="${i.id}" data-dir="-1" ${idx === 0 ? 'disabled' : ''} aria-label="上へ">▲</button>
      <button class="mini-btn" data-action="moveItem" data-id="${i.id}" data-dir="1" ${idx === items.length - 1 ? 'disabled' : ''} aria-label="下へ">▼</button>
      <button class="mini-btn" data-action="openItemActions" data-id="${i.id}" data-name="${escapeHtml(i.name)}">操作</button>
    </li>`);
  }
  const rows = rowsArr.join('') || '<li class="empty-row">未登録</li>';

  app.innerHTML = `
    <div class="screen teacher-page">
      ${teacherNav('today')}
      ${itemsSubNav('items')}
      <h1>提出物の一覧・追加</h1>
      <ul class="t-list">${rows}</ul>
      <section class="card">
        <h2>追加</h2>
        <form id="addItemForm" class="form-row">
          <input type="text" name="name" placeholder="提出物名" required>
          <input type="text" name="kana" placeholder="ふりがな（任意）">
          <button type="submit" class="mini-btn primary">追加</button>
        </form>
      </section>
      <section class="card">
        <h2>CSVで一括登録</h2>
        <p style="color:#666;font-size:0.9rem;">1行目は見出し、2行目以降に「提出物名,ふりがな」の順で入力してください（ふりがなは省略可）。</p>
        <button class="mini-btn" id="downloadItemTemplateBtn">テンプレートをダウンロード</button>
        <label class="mini-btn" style="display:inline-block;cursor:pointer;">
          CSVファイルを選ぶ
          <input type="file" id="itemCsvFile" accept=".csv,text/csv" style="display:none;">
        </label>
      </section>
    </div>
  `;
  attachFuriganaAutofill(document.querySelector('#addItemForm [name=name]'), document.querySelector('#addItemForm [name=kana]'));
  document.getElementById('addItemForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name')).trim();
    const kana = String(fd.get('kana') || '').trim();
    if (!name) return;
    if (await itemNameExists(name)) {
      alert(`「${name}」という提出物名はすでに登録されています。`);
      return;
    }
    await addItemLocal({ name, kana, subject: '', memo: '', active: true });
    renderTeacherItems();
  });
  document.getElementById('downloadItemTemplateBtn').addEventListener('click', () => {
    downloadCsv('提出物テンプレート.csv', [['提出物名', 'ふりがな'], ['漢字ドリル', 'かんじどりる']]);
  });
  document.getElementById('itemCsvFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCsv(text).slice(1);
      const existingNames = new Set((await DB.getAll('items')).map(i => i.name));
      let count = 0, skipped = 0;
      for (const r of rows) {
        const name = (r[0] || '').trim();
        const kana = (r[1] || '').trim();
        if (!name) continue;
        if (existingNames.has(name)) { skipped++; continue; }
        await addItemLocal({ name, kana, subject: '', memo: '', active: true });
        existingNames.add(name);
        count++;
      }
      showToast(`${count}件 取り込みました${skipped ? `（重複のため${skipped}件スキップ）` : ''}`);
      renderTeacherItems();
    } catch (err) {
      alert('CSVの読み込みに失敗しました: ' + (err && err.message ? err.message : String(err)));
    }
  });
}

let teacherTodayDate = null;
let teacherCalMonth = null;
let teacherBulkOpen = false;
let teacherCopyMode = false;
const teacherCopyTargets = new Set();

function selectTeacherDate(dateStr) {
  teacherTodayDate = dateStr;
  teacherCalMonth = dateStr.slice(0, 7);
  teacherBulkOpen = false;
  teacherCopyMode = false;
  teacherCopyTargets.clear();
  renderTeacherToday();
}

// 画面の位置を保ったまま再描画する（連続して登録するとき、上に戻されないように）。
async function rerenderTodayKeepScroll() {
  const y = window.scrollY;
  await renderTeacherToday();
  window.scrollTo(0, y);
}

function shiftedSchoolDate(dateStr, dir, holidaySet) {
  let d = dateStr;
  for (let guard = 0; guard < 400; guard++) {
    d = addDays(d, dir);
    if (isSchoolDay(d, holidaySet)) return d;
  }
  return dateStr;
}

// fromDate以降の登録を、すべて1つ次（dir=1）／1つ前（dir=-1）の登校日へ動かす。
// 提出状況・コメントは提出物に付いているので、そのまま一緒に動く。
async function shiftAssignments(fromDate, dir) {
  const holidaySet = await getHolidaySet();
  const all = await DB.getAll('assignments');
  const targets = all.filter(a => a.date >= fromDate)
    .sort((a, b) => (dir > 0 ? -1 : 1) * (a.date.localeCompare(b.date) || a.id - b.id));
  const occupied = new Set(all.map(a => `${a.date}_${a.itemId}`));
  let moved = 0, skipped = 0;
  for (const a of targets) {
    const nd = shiftedSchoolDate(a.date, dir, holidaySet);
    if (nd === a.date) continue;
    const newKey = `${nd}_${a.itemId}`;
    if (occupied.has(newKey)) { skipped++; continue; }
    occupied.delete(`${a.date}_${a.itemId}`);
    occupied.add(newKey);
    a.date = nd;
    await DB.put('assignments', a);
    const item = await DB.get('items', a.itemId);
    Sync.pushAssignment(a, item ? item.syncId : null);
    moved++;
  }
  return { moved, skipped };
}

async function copyAssignments(fromDate, toDates) {
  const src = (await getAssignmentsForDate(fromDate)).filter(a => a.item && a.item.active !== false);
  const existing = new Set((await DB.getAll('assignments')).map(a => `${a.date}_${a.itemId}`));
  let count = 0;
  for (const d of toDates) {
    for (const a of src) {
      if (existing.has(`${d}_${a.itemId}`)) continue;
      await addAssignmentLocal({ date: d, itemId: a.itemId, deadline: null, detail: a.detail || '' });
      existing.add(`${d}_${a.itemId}`);
      count++;
    }
  }
  return count;
}

function shiftMonthKey(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function mondayOf(dateStr) {
  const wd = new Date(dateStr + 'T00:00:00').getDay();
  return addDays(dateStr, wd === 0 ? -6 : 1 - wd);
}

function buildCalendarHtml(monthKey, selectedDate, countByDate, holidaySet, copyTargets) {
  const [y, m] = monthKey.split('-').map(Number);
  const startOffset = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = todayStr();
  const heads = ['日', '月', '火', '水', '木', '金', '土']
    .map((n, i) => `<div class="cal-head ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${n}</div>`).join('');
  let cells = '';
  for (let i = 0; i < startOffset; i++) cells += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cnt = countByDate[ds] || 0;
    const cls = ['cal-cell'];
    if (!isSchoolDay(ds, holidaySet)) cls.push('off');
    if (ds === selectedDate) cls.push('selected');
    if (copyTargets && copyTargets.has(ds)) cls.push('copy-target');
    if (ds === today) cls.push('today');
    cells += `<button type="button" class="${cls.join(' ')}" data-cal-date="${ds}"><span class="cal-num">${d}</span>${cnt ? `<span class="cal-count">${cnt}</span>` : ''}</button>`;
  }
  return heads + cells;
}

async function saveTemplateMatrix() {
  const t = await getMeta('weeklyTemplates', {});
  for (let wd = 1; wd <= 5; wd++) {
    t[wd] = [...document.querySelectorAll(`.tmpl-cell[data-wd="${wd}"]:checked`)].map(el => Number(el.dataset.item));
  }
  await setMeta('weeklyTemplates', t);
  return t;
}

async function renderTeacherToday() {
  const targetDate = teacherTodayDate || todayStr();
  const monthKey = teacherCalMonth || targetDate.slice(0, 7);
  const isToday = targetDate === todayStr();
  const items = await getActiveItems();
  const allAssignments = await DB.getAll('assignments');
  const holidaySet = await getHolidaySet();
  const dateList = await getAssignmentsForDate(targetDate);
  const assignedItemIds = new Set(dateList.map(a => a.itemId));
  const assignmentByItemId = Object.fromEntries(dateList.map(a => [a.itemId, a]));

  const countByDate = {};
  for (const a of allAssignments) countByDate[a.date] = (countByDate[a.date] || 0) + 1;
  const laterAssignments = allAssignments.filter(a => a.date >= targetDate);
  const laterCount = laterAssignments.length;
  const laterDayCount = new Set(laterAssignments.map(a => a.date)).size;

  const weekday = new Date(targetDate + 'T00:00:00').getDay();
  const weekdayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const templates = await getMeta('weeklyTemplates', {});

  // 登録済みのものを上に、未登録を下に並べる（それぞれ提出物の並び順のまま）。
  const orderedItems = [...items].sort((a, b) => (assignedItemIds.has(b.id) ? 1 : 0) - (assignedItemIds.has(a.id) ? 1 : 0));
  const tiles = orderedItems.map(i => {
    const a = assignmentByItemId[i.id];
    if (a) {
      return `<button type="button" class="item-tile on" data-action="openAssignmentMenu" data-assignment="${a.id}">
        <span class="tile-mark">✓</span>
        <span class="tile-name">${escapeHtml(i.name)}</span>
        ${a.detail ? `<span class="tile-detail">${escapeHtml(a.detail)}</span>` : ''}
        ${a.deadline ? deadlineBadge(a.deadline) : ''}
      </button>`;
    }
    return `<button type="button" class="item-tile" data-tile-add="${i.id}">
      <span class="tile-mark">＋</span>
      <span class="tile-name">${escapeHtml(i.name)}</span>
    </button>`;
  }).join('') || '<p class="empty-row">提出物がありません。「提出物の一覧・追加」から追加してください。</p>';

  // 連絡帳は「次に提出物を集める日」に出すものを書くので、次の登校日の分から作る。
  const [nextSchool] = nextSchoolDays(addDays(targetDate, 1), 1, holidaySet);
  const draftDate = nextSchool ? nextSchool.date : addDays(targetDate, 1);
  const draftWd = weekdayNames[new Date(draftDate + 'T00:00:00').getDay()];
  const draftList = await getAssignmentsForDate(draftDate);
  const draftText = draftList.filter(a => a.item)
    .sort((x, y) => itemOrderKey(x.item) - itemOrderKey(y.item))
    .map((a, idx) => (idx === 0 ? '宿　' : '　　') + a.item.name + (a.detail ? '　' + a.detail : ''))
    .join('\n');

  const [calY, calM] = monthKey.split('-').map(Number);
  const offNote = isSchoolDay(targetDate, holidaySet)
    ? ''
    : '<p style="color:var(--muted);font-size:0.9rem;margin:6px 0;">この日は土日・お休みの日です。</p>';

  const tmplRows = items.map(i => `
    <tr>
      <td class="tmpl-name">${escapeHtml(i.name)}</td>
      ${[1, 2, 3, 4, 5].map(wd => `<td><input type="checkbox" class="tmpl-cell" data-item="${i.id}" data-wd="${wd}" ${(templates[wd] || []).includes(i.id) ? 'checked' : ''}></td>`).join('')}
    </tr>`).join('');
  const tmplTable = items.length
    ? `<div class="tmpl-scroll"><table class="tmpl-table">
        <thead><tr><th></th>${['月', '火', '水', '木', '金'].map(n => `<th>${n}</th>`).join('')}</tr></thead>
        <tbody>${tmplRows}</tbody>
      </table></div>`
    : '<p class="empty-row">提出物がありません。「提出物の一覧・追加」から追加してください。</p>';

  app.innerHTML = `
    <div class="screen teacher-page">
      ${teacherNav('today')}
      ${itemsSubNav('today')}
      <h1>日ごとの登録</h1>

      <section class="card">
        <div class="cal-nav">
          <button class="mini-btn" id="calPrev" type="button">◀</button>
          <strong>${calY}年${calM}月</strong>
          <button class="mini-btn" id="calNext" type="button">▶</button>
        </div>
        ${teacherCopyMode ? `<div class="copy-banner">
          <strong>${formatDateJp(targetDate)}の内容をコピーする日を、タップして選んでください</strong>（${teacherCopyTargets.size}日 選択中）
          <div style="margin-top:8px;">
            <button class="mini-btn primary" id="copyRunBtn" type="button" ${teacherCopyTargets.size ? '' : 'disabled'}>選んだ日にコピー</button>
            <button class="mini-btn" id="copyCancelBtn" type="button">やめる</button>
          </div>
        </div>` : ''}
        <div class="cal-grid">${buildCalendarHtml(monthKey, targetDate, countByDate, holidaySet, teacherCopyMode ? teacherCopyTargets : null)}</div>
        <p class="cal-legend">日付をタップするとその日の登録画面になります。数字は登録済みの提出物の数、グレーは土日・お休みの日です。</p>
      </section>

      <section class="card">
        <div class="day-nav">
          <button class="mini-btn" id="dayPrev" type="button">◀ 前の日</button>
          <strong class="day-title">${formatDateJp(targetDate)}（${weekdayNames[weekday]}）${isToday ? '＝今日' : ''}</strong>
          <button class="mini-btn" id="dayNext" type="button">次の日 ▶</button>
        </div>
        <div class="form-row" style="margin:10px 0;justify-content:center;">
          <input type="date" id="targetDateInput" value="${targetDate}">
          <button class="mini-btn" id="gotoTodayBtn" type="button">今日にする</button>
        </div>
        ${offNote}
        <p class="cal-legend" style="margin:0 0 8px;">タップで登録できます（＋の提出物をタップ）。登録した提出物（緑）をタップすると、詳細（ページ・番号）や提出期限の入力、取り消しができます。</p>
        <div class="tile-grid">${tiles}</div>
        <div class="tile-tools">
          <button class="mini-btn" id="copyPrevBtn" type="button">前の登録日と同じにする</button>
          <button class="mini-btn" id="applyTemplateBtn" type="button">${weekdayNames[weekday]}曜日のテンプレートを入れる</button>
          <button class="mini-btn" id="copyModeBtn" type="button" ${dateList.length ? '' : 'disabled'}>この日の内容を他の日にコピー</button>
        </div>
        <div class="tile-tools" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);align-items:center;">
          <span style="font-size:0.85rem;color:var(--muted);">予定がずれたとき：</span>
          <button class="mini-btn" id="shiftLaterBtn" type="button" ${laterCount ? '' : 'disabled'}>この日以降をまとめて1日遅らせる</button>
          <button class="mini-btn" id="shiftEarlierBtn" type="button" ${laterCount ? '' : 'disabled'}>この日以降をまとめて1日早める</button>
        </div>
      </section>

      <section class="card">
        <h2>連絡帳の下書き（${formatDateJp(targetDate)}の宿題）</h2>
        ${draftText
          ? `<p style="color:#666;font-size:0.9rem;">次の登校日 ${formatDateJp(draftDate)}（${draftWd}）に集める提出物から作った文面です。必要なら直してから、コピーしてクラスルームに貼り付けてください。</p>
        <textarea id="draftText" rows="${Math.max(3, draftText.split('\n').length + 1)}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:1rem;font-family:inherit;user-select:text;-webkit-user-select:text;">${escapeHtml(draftText)}</textarea>
        <button class="mini-btn primary" id="copyDraftBtn" type="button" style="margin-top:8px;">コピー</button>`
          : `<p class="empty-row">次の登校日 ${formatDateJp(draftDate)}（${draftWd}）に集める提出物が、まだ登録されていません。カレンダーでその日を選んで登録してください。</p>`}
      </section>

      <details class="card" id="bulkDetails" ${teacherBulkOpen ? 'open' : ''}>
        <summary style="font-weight:bold;font-size:1.1rem;cursor:pointer;">まとめて登録（曜日テンプレート・期間）</summary>
        <p style="color:#666;font-size:0.9rem;">① 曜日ごとに、いつも出す提出物にチェックを入れます。② 期間を選んで「保存して期間に適用」を押すと、その期間の毎日に一度に登録されます。土日・お休みの日は自動で飛ばし、登録済みのものは重複しません。詳細（ページなど）は、あとから各日で「編集」できます。</p>
        <h3 style="font-size:1rem;margin:12px 0 6px;">① 曜日ごとのテンプレート</h3>
        ${tmplTable}
        <h3 style="font-size:1rem;margin:14px 0 6px;">② 期間</h3>
        <div class="form-row" style="margin-bottom:8px;">
          <input type="date" id="bulkStart" value="${targetDate}">
          <span>〜</span>
          <input type="date" id="bulkEnd" value="${addDays(targetDate, 6)}">
        </div>
        <div style="margin-bottom:12px;">
          <button class="mini-btn" id="rangeThisWeekBtn" type="button">今週</button>
          <button class="mini-btn" id="rangeNextWeekBtn" type="button">来週</button>
          <button class="mini-btn" id="rangeMonthBtn" type="button">${calM}月ぜんぶ</button>
        </div>
        <button class="mini-btn" id="saveTmplBtn" type="button">テンプレートだけ保存</button>
        <button class="mini-btn primary" id="bulkApplyBtn" type="button">保存して期間に適用</button>
      </details>
    </div>
  `;

  app.querySelectorAll('[data-cal-date]').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.calDate;
      if (!teacherCopyMode) { selectTeacherDate(d); return; }
      if (d === targetDate) return;
      if (teacherCopyTargets.has(d)) teacherCopyTargets.delete(d); else teacherCopyTargets.add(d);
      renderTeacherToday();
    });
  });
  document.getElementById('calPrev').addEventListener('click', () => {
    teacherCalMonth = shiftMonthKey(monthKey, -1);
    renderTeacherToday();
  });
  document.getElementById('calNext').addEventListener('click', () => {
    teacherCalMonth = shiftMonthKey(monthKey, 1);
    renderTeacherToday();
  });
  document.getElementById('dayPrev').addEventListener('click', () => selectTeacherDate(addDays(targetDate, -1)));
  document.getElementById('dayNext').addEventListener('click', () => selectTeacherDate(addDays(targetDate, 1)));
  document.getElementById('targetDateInput').addEventListener('change', (e) => {
    selectTeacherDate(e.target.value || todayStr());
  });
  document.getElementById('gotoTodayBtn').addEventListener('click', () => selectTeacherDate(todayStr()));
  const copyDraftBtn = document.getElementById('copyDraftBtn');
  if (copyDraftBtn) {
    copyDraftBtn.addEventListener('click', async () => {
      const ta = document.getElementById('draftText');
      try {
        await navigator.clipboard.writeText(ta.value);
      } catch (err) {
        ta.select();
        if (!document.execCommand('copy')) {
          alert('コピーできませんでした。文面を長押ししてコピーしてください。');
          return;
        }
      }
      showToast('コピーしました');
    });
  }
  app.querySelectorAll('[data-tile-add]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const itemId = Number(btn.dataset.tileAdd);
      const already = (await getAssignmentsForDate(targetDate)).some(a => a.itemId === itemId);
      if (!already) await addAssignmentLocal({ date: targetDate, itemId, deadline: null, detail: '' });
      await rerenderTodayKeepScroll();
    });
  });
  document.getElementById('copyPrevBtn').addEventListener('click', async () => {
    const prevDates = [...new Set(allAssignments.map(a => a.date))].filter(d => d < targetDate).sort();
    const prev = prevDates[prevDates.length - 1];
    if (!prev) { showToast('これより前に登録した日がありません'); return; }
    const n = await copyAssignments(prev, [targetDate]);
    showToast(n ? `${formatDateJp(prev)}と同じ ${n}件を登録しました` : '追加するものはありません（登録済みです）');
    await rerenderTodayKeepScroll();
  });
  document.getElementById('applyTemplateBtn').addEventListener('click', async () => {
    const activeIds = new Set(items.map(i => i.id));
    let n = 0;
    for (const id of (templates[weekday] || [])) {
      if (!activeIds.has(id) || assignedItemIds.has(id)) continue;
      await addAssignmentLocal({ date: targetDate, itemId: id, deadline: null, detail: '' });
      n++;
    }
    showToast((templates[weekday] || []).length
      ? (n ? `${n}件 登録しました` : '追加するものはありません（登録済みです）')
      : `${weekdayNames[weekday]}曜日のテンプレートが未設定です（下の「まとめて登録」で設定できます）`);
    await rerenderTodayKeepScroll();
  });
  const runShift = async (dir) => {
    const word = dir > 0 ? '遅らせ' : '早め';
    if (!confirm(`${formatDateJp(targetDate)}以降に登録されている${laterDayCount}日分・${laterCount}件を、それぞれ1つ${dir > 0 ? '後' : '前'}の登校日（土日・お休みの日は飛ばします）に${word}ます。提出状況やコメントも一緒に動きます。よろしいですか？`)) return;
    const { moved, skipped } = await shiftAssignments(targetDate, dir);
    showToast(`${moved}件を${dir > 0 ? '1日遅らせ' : '1日早め'}ました${skipped ? `（同じ提出物がすでにある${skipped}件は動かしていません）` : ''}`);
    await rerenderTodayKeepScroll();
  };
  document.getElementById('shiftLaterBtn').addEventListener('click', () => runShift(1));
  document.getElementById('shiftEarlierBtn').addEventListener('click', () => runShift(-1));
  document.getElementById('copyModeBtn').addEventListener('click', () => {
    teacherCopyMode = true;
    teacherCopyTargets.clear();
    window.scrollTo(0, 0);
    renderTeacherToday();
  });
  const copyRunBtn = document.getElementById('copyRunBtn');
  if (copyRunBtn) {
    copyRunBtn.addEventListener('click', async () => {
      const targets = [...teacherCopyTargets].sort();
      const n = await copyAssignments(targetDate, targets);
      teacherCopyMode = false;
      teacherCopyTargets.clear();
      showToast(n ? `${targets.length}日に、${n}件 コピーしました` : 'コピーするものはありません（登録済みです）');
      renderTeacherToday();
    });
    document.getElementById('copyCancelBtn').addEventListener('click', () => {
      teacherCopyMode = false;
      teacherCopyTargets.clear();
      renderTeacherToday();
    });
  }

  const setRange = (start, end) => {
    document.getElementById('bulkStart').value = start;
    document.getElementById('bulkEnd').value = end;
  };
  document.getElementById('rangeThisWeekBtn').addEventListener('click', () => {
    const mon = mondayOf(todayStr());
    setRange(mon, addDays(mon, 4));
  });
  document.getElementById('rangeNextWeekBtn').addEventListener('click', () => {
    const mon = addDays(mondayOf(todayStr()), 7);
    setRange(mon, addDays(mon, 4));
  });
  document.getElementById('rangeMonthBtn').addEventListener('click', () => {
    const last = String(new Date(calY, calM, 0).getDate()).padStart(2, '0');
    setRange(`${monthKey}-01`, `${monthKey}-${last}`);
  });
  document.getElementById('saveTmplBtn').addEventListener('click', async () => {
    await saveTemplateMatrix();
    showToast('テンプレートを保存しました');
  });
  document.getElementById('bulkApplyBtn').addEventListener('click', async () => {
    const start = document.getElementById('bulkStart').value;
    const end = document.getElementById('bulkEnd').value;
    if (!start || !end || start > end) {
      alert('開始日と終了日を正しく選んでください。');
      return;
    }
    const tmpl = await saveTemplateMatrix();
    const activeIds = new Set(items.map(i => i.id));
    const existing = new Set((await DB.getAll('assignments')).map(a => `${a.date}_${a.itemId}`));
    const plan = [];
    let d = start;
    for (let guard = 0; d <= end && guard < 366; guard++) {
      if (isSchoolDay(d, holidaySet)) {
        const wd = new Date(d + 'T00:00:00').getDay();
        for (const id of (tmpl[wd] || [])) {
          if (activeIds.has(id) && !existing.has(`${d}_${id}`)) plan.push({ date: d, itemId: id });
        }
      }
      d = addDays(d, 1);
    }
    teacherBulkOpen = true;
    if (!plan.length) {
      showToast('テンプレートを保存しました');
      alert('追加できるものがありませんでした。曜日ごとのテンプレートにチェックがないか、期間内はすでにすべて登録済みです。');
      renderTeacherToday();
      return;
    }
    const dayCount = new Set(plan.map(p => p.date)).size;
    if (!confirm(`${formatDateJp(start)}〜${formatDateJp(end)}の${dayCount}日分、合計${plan.length}件を追加します。よろしいですか？`)) {
      renderTeacherToday();
      return;
    }
    for (const p of plan) await addAssignmentLocal({ date: p.date, itemId: p.itemId, deadline: null, detail: '' });
    showToast(`${dayCount}日分・${plan.length}件 追加しました`);
    renderTeacherToday();
  });
}

function openAssignmentEditSheet(assignment, itemName) {
  const { minVal, defaultVal } = suggestDeadlineDefaults();
  const currentVal = assignment.deadline
    ? new Date(new Date(assignment.deadline).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : '';
  renderModal(`
    <h3>${escapeHtml(itemName)} を編集</h3>
    <div style="text-align:left;">
      <label style="display:block;margin:10px 0 4px;">詳細（例：12ページ、3番）</label>
      <input type="text" id="editDetailInput" value="${escapeHtml(assignment.detail || '')}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;">
      <div style="margin-top:6px;">
        <button type="button" class="mini-btn" data-action="appendDetailWord" data-for="editDetailInput" data-word="ページ">ページ</button>
        <button type="button" class="mini-btn" data-action="appendDetailWord" data-for="editDetailInput" data-word="番">番</button>
      </div>
      <label style="display:block;margin:14px 0 4px;">提出期限（この日時までに出してもらう）</label>
      <input type="datetime-local" id="editDeadlineInput" value="${currentVal}" min="${minVal}" placeholder="${defaultVal}" class="deadline-input">
      <label style="display:flex;align-items:center;gap:6px;margin-top:8px;">
        <input type="checkbox" id="editDeadlineClear" ${assignment.deadline ? '' : 'checked'}>
        <span>提出期限を決めない</span>
      </label>
      <p style="color:#666;font-size:0.85rem;margin:6px 0 0;">決めた場合、この日時を過ぎても出していない児童は、ホームの「提出期限を過ぎた」に数えられます。児童が自分で選ぶ「いつ出すか」の予定とは別のものです。</p>
    </div>
    <div class="sheet-buttons">
      <button class="big-btn yes" data-action="saveAssignmentEdit" data-assignment="${assignment.id}">保存</button>
      <button class="big-btn cancel" data-action="closeModal">やめる</button>
    </div>
  `);
}

async function removeAssignmentCascade(assignmentId) {
  const statuses = await DB.getAllByIndex('statuses', 'assignmentId', assignmentId);
  for (const s of statuses) {
    await DB.delete('statuses', s.key);
    Sync.deleteStatusRemote(s.studentId, assignmentId);
  }
  const history = await DB.getAllByIndex('history', 'assignmentId', assignmentId);
  for (const h of history) await DB.delete('history', h.id);
  const assignment = await DB.get('assignments', assignmentId);
  await DB.delete('assignments', assignmentId);
  Sync.deleteAssignmentRemote(assignment);
}

async function renderTimePresetCard() {
  const card = document.getElementById('timePresetCard');
  if (!card) return;
  const presets = await getTimePresets();
  card.innerHTML = `
    <h2>提出時刻の選択肢</h2>
    <p style="color:#666;font-size:0.9rem;">児童が「いつまでに出す」を選ぶときの選択肢です。学校の時程に合わせて自由に編集してください（変更するとすぐに反映されます）。</p>
    <div id="timePresetList">
      ${presets.map((p, i) => `
        <div class="form-row" style="margin-bottom:8px;align-items:center;" data-index="${i}">
          <input type="time" class="tp-time" value="${escapeHtml(p.time)}" style="padding:8px;border:1px solid var(--border);border-radius:8px;">
          <input type="text" class="tp-label" value="${escapeHtml(p.label)}" placeholder="表示名（例：朝の会まで）" style="flex:1;min-width:140px;padding:8px;border:1px solid var(--border);border-radius:8px;">
          <input type="text" class="tp-kana" value="${escapeHtml(p.kana || '')}" placeholder="ふりがな（任意）" style="width:120px;padding:8px;border:1px solid var(--border);border-radius:8px;">
          <button class="mini-btn danger" data-action="removeTimePreset" data-index="${i}" type="button">削除</button>
        </div>
      `).join('') || '<p class="empty-row">選択肢がありません。追加してください。</p>'}
    </div>
    <button class="mini-btn" id="addTimePresetBtn" type="button">＋ 選択肢を追加</button>
    <button class="mini-btn" id="resetTimePresetsBtn" type="button">初期設定に戻す</button>
  `;
  card.querySelectorAll('.tp-time, .tp-label, .tp-kana').forEach(input => {
    input.addEventListener('change', async () => {
      const row = input.closest('[data-index]');
      const i = Number(row.dataset.index);
      const nameInput = row.querySelector('.tp-label');
      const kanaInput = row.querySelector('.tp-kana');
      presets[i] = {
        time: row.querySelector('.tp-time').value || '23:59',
        label: nameInput.value.trim(),
        kana: kanaInput.value.trim(),
      };
      await setMeta('timePresets', presets);
    });
  });
  card.querySelectorAll('[data-action="removeTimePreset"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.index);
      presets.splice(i, 1);
      await setMeta('timePresets', presets);
      renderTimePresetCard();
    });
  });
  document.getElementById('addTimePresetBtn').addEventListener('click', async () => {
    presets.push({ time: '15:00', label: '', kana: '' });
    await setMeta('timePresets', presets);
    renderTimePresetCard();
  });
  document.getElementById('resetTimePresetsBtn').addEventListener('click', async () => {
    if (!confirm('提出時刻の選択肢を初期設定に戻します。よろしいですか？')) return;
    await setMeta('timePresets', null);
    renderTimePresetCard();
  });
}

async function renderHolidayCard() {
  const card = document.getElementById('holidayCard');
  if (!card) return;
  const holidays = (await getHolidays()).slice().sort((a, b) => a.date.localeCompare(b.date));
  const autoHolidays = await getMeta('autoHolidays', true) !== false;
  const today = todayStr();
  const limit = addDays(today, 366);
  const upcomingHolidays = [];
  for (let y = new Date().getFullYear(); y <= new Date().getFullYear() + 1; y++) {
    for (const [d, name] of japaneseHolidays(y)) if (d >= today && d <= limit) upcomingHolidays.push([d, name]);
  }
  upcomingHolidays.sort((a, b) => a[0].localeCompare(b[0]));
  card.innerHTML = `
    <h2>お休みの日（祝日・学校行事など）</h2>
    <p style="color:#666;font-size:0.9rem;">土日と、国民の祝日（振替休日を含む）は自動的にお休みになり、児童の「いつ出す」の選択肢から外れ、カレンダーでもグレーになります。夏休み・学校行事の振替休業日など、それ以外のお休みの日は下から登録してください。期間でまとめて登録することもできます。</p>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <input type="checkbox" id="autoHolidayCheck" ${autoHolidays ? 'checked' : ''}>
      <span>国民の祝日を自動でお休みにする</span>
    </label>
    <details style="margin-bottom:12px;">
      <summary style="cursor:pointer;color:#2b6cb0;">自動でお休みになる祝日を見る（これから1年分）</summary>
      <ul class="t-list">${upcomingHolidays.map(([d, name]) => `<li class="t-row"><span class="t-name">${formatDateJp(d)}（${['日', '月', '火', '水', '木', '金', '土'][new Date(d + 'T00:00:00').getDay()]}）　${escapeHtml(name)}</span></li>`).join('')}</ul>
    </details>
    <h3 style="font-size:1rem;margin:12px 0 6px;">それ以外のお休みの日を追加</h3>
    <div class="form-row" style="margin-bottom:6px;align-items:center;">
      <input type="date" id="newHolidayDate" style="padding:8px;border:1px solid var(--border);border-radius:8px;">
      <span>〜</span>
      <input type="date" id="newHolidayEnd" style="padding:8px;border:1px solid var(--border);border-radius:8px;">
    </div>
    <p style="color:#666;font-size:0.8rem;margin:0 0 8px;">1日だけの場合は、右側（終わりの日）は空のままで大丈夫です。</p>
    <div class="form-row" style="margin-bottom:12px;">
      <input type="text" id="newHolidayLabel" placeholder="名前（任意・例：夏休み）" style="flex:1;min-width:120px;padding:8px;border:1px solid var(--border);border-radius:8px;">
      <button class="mini-btn primary" id="addHolidayBtn" type="button">追加</button>
    </div>
    <ul class="t-list" id="holidayList">
      ${holidays.map(h => `
        <li class="t-row">
          <span class="t-name">${formatDateJp(h.date)}${h.end && h.end > h.date ? '〜' + formatDateJp(h.end) : ''}${h.label ? '　' + escapeHtml(h.label) : ''}</span>
          <button class="mini-btn danger" data-action="removeHoliday" data-date="${escapeHtml(h.date)}" data-end="${escapeHtml(h.end || '')}" type="button">削除</button>
        </li>
      `).join('') || '<li class="empty-row">登録されていません</li>'}
    </ul>
  `;
  document.getElementById('autoHolidayCheck').addEventListener('change', async (e) => {
    await setMeta('autoHolidays', e.target.checked);
    showToast(e.target.checked ? '祝日を自動でお休みにします' : '祝日の自動設定をやめました');
  });
  document.getElementById('addHolidayBtn').addEventListener('click', async () => {
    const dateVal = document.getElementById('newHolidayDate').value;
    const endVal = document.getElementById('newHolidayEnd').value;
    if (!dateVal) {
      alert('はじめの日を選んでください。');
      return;
    }
    if (endVal && endVal < dateVal) {
      alert('終わりの日は、はじめの日より後の日を選んでください。');
      return;
    }
    const label = document.getElementById('newHolidayLabel').value.trim();
    const end = endVal && endVal > dateVal ? endVal : '';
    const next = holidays.filter(h => !(h.date === dateVal && (h.end || '') === end));
    next.push(end ? { date: dateVal, end, label } : { date: dateVal, label });
    await setMeta('holidays', next);
    renderHolidayCard();
  });
  card.querySelectorAll('[data-action="removeHoliday"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const next = holidays.filter(h => !(h.date === btn.dataset.date && (h.end || '') === btn.dataset.end));
      await setMeta('holidays', next);
      renderHolidayCard();
    });
  });
}

async function renderTeacherSettings() {
  const classroomId = await Sync.getClassroomId();
  const syncState = Sync.getSyncState();
  const joinCodeToShow = pendingJoinCode;
  pendingJoinCode = null;
  app.innerHTML = `
    <div class="screen teacher-page">
      ${teacherNav('settings')}
      <h1>設定</h1>
      <section class="card">
        <h2>クラウド同期（複数端末をリアルタイムで揃える）</h2>
        <p style="color:#666;font-size:0.9rem;">児童の氏名・ふりがなは送信されません。送られるのはランダムなコードと、提出物・提出状況・先生のコメントのみです（コメントに児童の氏名は書かないでください）。同期コードは合言葉のようなものなので、他人に教えないでください。</p>
        ${classroomId ? `
          <p>同期コード：<strong style="font-family:monospace;font-size:1.1rem;">${escapeHtml(classroomId)}</strong>　<button class="mini-btn" id="copyClassroomIdBtn" type="button">コピー</button>　${syncState.connected ? '<span style="color:var(--ok);">● 接続中</span>' : '<span style="color:var(--muted);">○ 未接続</span>'}</p>
          <p style="color:#666;font-size:0.85rem;">他の端末では、名簿画面で先に「名簿（コード付き）」を取り込んでから、この同期コードを入力するか、QRコードを読み取って参加してください。</p>
          <button class="mini-btn" id="showQrBtn">QRコードを表示</button>
          <button class="mini-btn danger" id="leaveSyncBtn">同期をやめる</button>
        ` : `
          <p>まだ同期は設定されていません。</p>
          <button class="mini-btn primary" id="startSyncBtn">この端末を最初の端末にして同期を始める</button>
          <div class="form-row" style="margin-top:10px;">
            <input type="text" id="joinCodeInput" placeholder="他の端末の同期コードを入力" value="${escapeHtml(joinCodeToShow || '')}">
            <button class="mini-btn" id="joinSyncBtn">参加する</button>
            <button class="mini-btn" id="scanSyncQrBtn">QRコードを読み取る</button>
          </div>
        `}
      </section>
      <section class="card">
        <h2>PIN変更</h2>
        <form id="pinForm" class="form-row">
          <input type="text" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="新しいPIN（4桁）" required>
          <button type="submit" class="mini-btn primary">変更</button>
        </form>
      </section>
      <section class="card" id="timePresetCard"></section>
      <section class="card" id="holidayCard"></section>
      <section class="card">
        <h2>バックアップ（他の端末に移す）</h2>
        <p style="color:#666;font-size:0.9rem;">データは各端末に個別に保存されています。他の端末（iPhoneなど）でも同じ内容を見られるようにするには、この端末で書き出したファイルを、もう一方の端末で読み込んでください。児童の氏名を含みます。読み込むと今の端末のデータは上書きされます。</p>
        <button class="mini-btn primary" id="exportBtn">バックアップを書き出す</button>
        <div style="margin-top:10px;">
          <label class="mini-btn" style="display:inline-block;cursor:pointer;">
            バックアップを読み込む
            <input type="file" id="importFile" accept="application/json" style="display:none;">
          </label>
        </div>
      </section>
      <section class="card">
        <h2>CSV出力（パソコンで確認）</h2>
        <p style="color:#666;font-size:0.9rem;">Excel等で開ける形式で書き出します。児童の氏名を含みます。</p>
        <button class="mini-btn" id="exportHistoryCsvBtn">すべての提出履歴をCSVで出力</button>
        <div style="margin-top:8px;">
          <button class="mini-btn" id="exportTodayCsvBtn">今日の状況をCSVで出力</button>
        </div>
      </section>
      <section class="card">
        <h2>年度更新</h2>
        <p style="color:#666;font-size:0.9rem;">新しい年度・学級を始めるときに使います。必ず先にバックアップを書き出して保存してから行ってください。実行すると、名簿・提出物・提出記録がすべて消え、まっさらな状態から登録し直せます（バックアップファイルを開けば、過去の年度の記録はいつでも見返せます）。</p>
        <button class="mini-btn danger" id="resetYearBtn">今のデータを消して新しい年度を始める</button>
      </section>
    </div>
  `;
  await renderTimePresetCard();
  await renderHolidayCard();
  const showQrBtn = document.getElementById('showQrBtn');
  if (showQrBtn) {
    showQrBtn.addEventListener('click', () => showJoinQr(classroomId));
  }
  const copyClassroomIdBtn = document.getElementById('copyClassroomIdBtn');
  if (copyClassroomIdBtn) {
    copyClassroomIdBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(classroomId);
        showToast('コピーしました');
      } catch (err) {
        alert('コピーできませんでした。長押しして手動でコピーしてください。');
      }
    });
  }
  const startSyncBtn = document.getElementById('startSyncBtn');
  if (startSyncBtn) {
    startSyncBtn.addEventListener('click', async () => {
      const id = await Sync.startNewClassroom();
      showToast('同期を開始しました');
      renderTeacherSettings();
    });
  }
  const joinSyncBtn = document.getElementById('joinSyncBtn');
  if (joinSyncBtn) {
    joinSyncBtn.addEventListener('click', async () => {
      const code = document.getElementById('joinCodeInput').value.trim();
      if (!code) return;
      await Sync.joinClassroom(code);
      showToast('参加しました');
      renderTeacherSettings();
    });
  }
  const scanSyncQrBtn = document.getElementById('scanSyncQrBtn');
  if (scanSyncQrBtn) {
    scanSyncQrBtn.addEventListener('click', () => openQrScanner(handleScannedJoinCode));
  }
  const leaveSyncBtn = document.getElementById('leaveSyncBtn');
  if (leaveSyncBtn) {
    leaveSyncBtn.addEventListener('click', async () => {
      if (!confirm('同期をやめます。この端末はクラウドから切り離されますが、今のデータはそのまま残ります。よろしいですか？')) return;
      await Sync.leaveClassroom();
      showToast('同期をやめました');
      renderTeacherSettings();
    });
  }
  document.getElementById('pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const pin = String(fd.get('pin'));
    if (!/^\d{4}$/.test(pin)) return;
    await setMeta('pin', pin);
    showToast('PINを変更しました');
  });
  document.getElementById('exportBtn').addEventListener('click', exportBackup);
  document.getElementById('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('今のこの端末のデータはすべて、読み込むファイルの内容で上書きされます。よろしいですか？')) {
      e.target.value = '';
      return;
    }
    try {
      await importBackup(file);
      showToast('読み込みました');
      renderTeacherSettings();
    } catch (err) {
      alert('読み込みに失敗しました: ' + (err && err.message ? err.message : String(err)));
    }
  });
  document.getElementById('exportHistoryCsvBtn').addEventListener('click', exportHistoryCsv);
  document.getElementById('exportTodayCsvBtn').addEventListener('click', exportTodayMatrixCsv);
  document.getElementById('resetYearBtn').addEventListener('click', async () => {
    if (!confirm('バックアップは書き出し済みですか？\nこの操作を行うと、今の名簿・提出物・提出記録がすべて消えます。元には戻せません。よろしいですか？')) return;
    if (!confirm('本当によろしいですか？もう一度確認します。')) return;
    if (await Sync.isSyncEnabled()) {
      if (!confirm('クラウド同期が有効です。同期している他の端末にも影響します（同期をやめてからリセットする場合は「キャンセル」を押し、先に設定から同期をやめてください）。このまま同期をやめてリセットしますか？')) return;
      await Sync.leaveClassroom();
    }
    for (const store of ['students', 'items', 'assignments', 'statuses', 'history']) {
      await DB.clear(store);
    }
    showToast('新しい年度を開始しました');
    renderTeacherStudents();
  });
}

async function exportHistoryCsv() {
  const students = Object.fromEntries((await DB.getAll('students')).map(s => [s.id, s]));
  const assignments = Object.fromEntries((await DB.getAll('assignments')).map(a => [a.id, a]));
  const items = Object.fromEntries((await DB.getAll('items')).map(i => [i.id, i]));
  const history = (await DB.getAll('history')).sort((a, b) => new Date(a.at) - new Date(b.at));

  const rows = [['日時', '出席番号', '氏名', '提出物', '詳細', '状態', '登録者']];
  for (const h of history) {
    const s = students[h.studentId];
    const a = assignments[h.assignmentId];
    const i = a ? items[a.itemId] : null;
    rows.push([
      formatDateTimeJp(h.at),
      s ? s.number : '',
      s ? s.name : '(削除済み)',
      i ? i.name : '(削除済み)',
      a ? (a.detail || '') : '',
      STATUS_META[h.status] ? STATUS_META[h.status].label : h.status,
      h.actor === 'teacher' ? '先生' : '児童',
    ]);
  }
  downloadCsv(`提出履歴_${todayStr()}.csv`, rows);
}

async function exportTodayMatrixCsv() {
  const students = await getActiveStudents();
  const todayList = await getTodayAssignments();
  const validAssignments = todayList.filter(a => a.item);

  const header = ['出席番号', '氏名', ...validAssignments.map(a => a.item.name + (a.detail ? `(${a.detail})` : ''))];
  const rows = [header];
  for (const s of students) {
    const row = [s.number, s.name];
    for (const a of validAssignments) {
      const st = await getStatus(s.id, a.id);
      row.push(STATUS_META[st.status].icon);
    }
    rows.push(row);
  }
  downloadCsv(`今日の提出状況_${todayStr()}.csv`, rows);
}

let qrLibPromise = null;
function loadQrLib() {
  if (window.QRCode && window.QRCode.toCanvas) return Promise.resolve();
  if (qrLibPromise) return qrLibPromise;
  qrLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('QRコードの読み込みに失敗しました（インターネット接続が必要です）'));
    document.head.appendChild(s);
  });
  return qrLibPromise;
}

async function renderQrInto(holderEl, text, errorCorrectionLevel) {
  await loadQrLib();
  const canvas = document.createElement('canvas');
  holderEl.innerHTML = '';
  holderEl.appendChild(canvas);
  await new Promise((resolve, reject) => {
    window.QRCode.toCanvas(canvas, text, { width: 260, margin: 2, errorCorrectionLevel: errorCorrectionLevel || 'M' }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function showJoinQr(classroomId) {
  const url = `${location.origin}${location.pathname}?join=${encodeURIComponent(classroomId)}`;
  renderModal(`
    <h3>QRコード</h3>
    <p style="color:#666;font-size:0.9rem;">他の端末のカメラでこのQRコードを読み取ると、参加画面が開きます（PINの入力は別途必要です）。</p>
    <div id="qrHolder" style="display:flex;justify-content:center;margin:16px 0;"></div>
    <button class="big-btn cancel" data-action="closeModal">閉じる</button>
  `);
  try {
    await renderQrInto(document.getElementById('qrHolder'), url);
  } catch (err) {
    document.getElementById('qrHolder').textContent = err.message;
  }
}

let jsQrLibPromise = null;
function loadJsQrLib() {
  if (window.jsQR) return Promise.resolve();
  if (jsQrLibPromise) return jsQrLibPromise;
  jsQrLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('カメラ読み取り機能の読み込みに失敗しました（インターネット接続が必要です）'));
    document.head.appendChild(s);
  });
  return jsQrLibPromise;
}

async function rosterCodeRows() {
  const list = (await DB.getAll('students')).sort((a, b) => a.number - b.number);
  const rows = [['出席番号', '氏名', 'ふりがな', 'コード']];
  for (const s of list) rows.push([s.number, s.name, s.kana || '', s.code || '']);
  return rows;
}

async function showRosterQr(rows) {
  const csv = toCsv(rows);
  const byteLen = new TextEncoder().encode(csv).length;
  renderModal(`
    <h3>名簿のQRコード</h3>
    <p style="color:#666;font-size:0.9rem;">他の端末で「QRコードを読み取る」を開いてこれを映すと、名簿（氏名・ふりがな・コード）をまとめて取り込めます。氏名が含まれるので、他人に見せないでください。</p>
    ${byteLen > 2200 ? '<p style="color:var(--bad);font-size:0.9rem;">人数が多く、QRコードでは読み取れない可能性があります。うまくいかない場合はCSVファイルでの受け渡しをお使いください。</p>' : ''}
    <div id="qrHolder" style="display:flex;justify-content:center;margin:16px 0;"></div>
    <button class="big-btn cancel" data-action="closeModal">閉じる</button>
  `);
  try {
    await renderQrInto(document.getElementById('qrHolder'), csv, 'L');
  } catch (err) {
    document.getElementById('qrHolder').textContent = 'QRコードを作れませんでした：' + err.message;
  }
}

let qrScanStream = null;
let qrScanRAF = null;

function stopQrScanner() {
  if (qrScanRAF) cancelAnimationFrame(qrScanRAF);
  qrScanRAF = null;
  if (qrScanStream) {
    qrScanStream.getTracks().forEach(t => t.stop());
    qrScanStream = null;
  }
}

async function openQrScanner(onDecode, title) {
  renderModal(`
    <h3>${title || 'QRコードを読み取る'}</h3>
    <p style="color:#666;font-size:0.9rem;">相手の端末に表示したQRコードをカメラに映してください。</p>
    <video id="qrVideo" playsinline muted style="width:100%;border-radius:12px;background:#000;"></video>
    <canvas id="qrCanvas" style="display:none;"></canvas>
    <p id="qrScanStatus" style="color:#666;min-height:1.2em;"></p>
    <button class="big-btn cancel" data-action="closeModal">やめる</button>
  `);
  try {
    await loadJsQrLib();
    const video = document.getElementById('qrVideo');
    qrScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = qrScanStream;
    await video.play();
    const canvas = document.getElementById('qrCanvas');
    const ctx = canvas.getContext('2d');
    const tick = () => {
      if (!document.getElementById('qrVideo')) return; // モーダルが閉じられた
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          stopQrScanner();
          closeModal();
          onDecode(code.data);
          return;
        }
      }
      qrScanRAF = requestAnimationFrame(tick);
    };
    qrScanRAF = requestAnimationFrame(tick);
  } catch (err) {
    const statusEl = document.getElementById('qrScanStatus');
    if (statusEl) statusEl.textContent = 'カメラを使えませんでした: ' + err.message;
  }
}

function openRosterQrScanner() {
  return openQrScanner(handleScannedRosterCsv, 'QRコードを読み取る');
}

async function handleScannedRosterCsv(text) {
  try {
    const rows = parseCsv(text).slice(1);
    const existingNames = new Set((await DB.getAll('students')).map(s => s.name));
    let count = 0, skipped = 0;
    for (const r of rows) {
      const number = Number(r[0]);
      const name = (r[1] || '').trim();
      const kana = (r[2] || '').trim();
      const code = (r[3] || '').trim();
      if (!name || !Number.isFinite(number) || !code) continue;
      if (existingNames.has(name)) { skipped++; continue; }
      await DB.add('students', { number, name, kana, code, active: true });
      existingNames.add(name);
      count++;
    }
    showToast(`${count}件 取り込みました${skipped ? `（重複のため${skipped}件スキップ）` : ''}`);
    renderTeacherStudents();
  } catch (err) {
    alert('QRコードの内容を読み込めませんでした: ' + (err && err.message ? err.message : String(err)));
  }
}

async function handleScannedJoinCode(text) {
  try {
    let code = text.trim();
    const urlMatch = code.match(/[?&]join=([^&]+)/);
    if (urlMatch) code = decodeURIComponent(urlMatch[1]);
    if (!code) throw new Error('同期コードが見つかりませんでした');
    await Sync.joinClassroom(code);
    showToast('参加しました');
    renderTeacherSettings();
  } catch (err) {
    alert('QRコードの内容を読み込めませんでした: ' + (err && err.message ? err.message : String(err)));
  }
}

async function exportBackup() {
  const data = {};
  for (const store of ALL_STORES) {
    data[store] = await DB.getAll(store);
  }
  const payload = { app: 'submission-tracker', version: 1, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `submission-tracker-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importBackup(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  if (!payload || payload.app !== 'submission-tracker' || !payload.data) {
    throw new Error('このアプリのバックアップファイルではありません');
  }
  for (const store of ALL_STORES) {
    await DB.clear(store);
    const rows = payload.data[store];
    if (Array.isArray(rows) && rows.length) {
      await DB.putAll(store, rows);
    }
  }
}

function openStudentQuick(studentId, date) {
  const targetDate = date || todayStr();
  getAssignmentsForDate(targetDate).then(async dateList => {
    const student = await DB.get('students', studentId);
    let items = dateList.map(a => ({ a, carried: false }));
    if (targetDate === todayStr()) {
      const all = await getAllAssignmentsWithItems();
      for (const a of all) {
        if (!a.item || a.date >= targetDate) continue;
        const st = await getStatus(studentId, a.id);
        if (st.status === STATUS.NOT_SUBMITTED && !st.plannedDate) items.push({ a, carried: true });
      }
    }
    const rowsHtml = [];
    for (const { a, carried } of items) {
      if (!a.item) continue;
      const st = await getStatus(studentId, a.id);
      const isSubmitted = st.status === STATUS.SUBMITTED;
      rowsHtml.push(`
        <div class="quick-item">
          <div class="quick-item-name">${itemNamePlain(a)}${carried ? `<span class="dl-badge dl-over">${formatDateJp(a.date)}の分</span>` : ''}（${STATUS_META[st.status].label}）</div>
          ${st.comment ? `<div class="quick-comment">✎ ${escapeHtml(st.comment)}</div>` : ''}
          <div class="quick-item-actions">
            ${isSubmitted
              ? `<button class="mini-btn" data-action="teacherSetStatus" data-status="${STATUS.REDO}" data-assignment="${a.id}" data-student="${studentId}">直しにする</button>
                 <button class="mini-btn" data-action="teacherSetStatus" data-status="${STATUS.NOT_SUBMITTED}" data-assignment="${a.id}" data-student="${studentId}">取り消す</button>`
              : `<button class="mini-btn primary" data-action="teacherSetStatus" data-status="${STATUS.SUBMITTED}" data-assignment="${a.id}" data-student="${studentId}">提出済</button>
                 <button class="mini-btn" data-action="teacherSetStatus" data-status="${STATUS.IN_PROGRESS}" data-assignment="${a.id}" data-student="${studentId}">途中</button>
                 <button class="mini-btn" data-action="teacherSetStatus" data-status="${STATUS.FORGOTTEN}" data-assignment="${a.id}" data-student="${studentId}">忘れ</button>
                 <button class="mini-btn" data-action="teacherSetStatus" data-status="${STATUS.EXEMPT}" data-assignment="${a.id}" data-student="${studentId}">免除</button>`}
          </div>
        </div>`);
    }
    renderModal(`
      <h3>${student.number}番 ${escapeHtml(student.name)}さん</h3>
      ${rowsHtml.join('') || '<p>本日の提出物はありません</p>'}
      <button class="big-btn cancel" data-action="closeModalRefreshHome">閉じる</button>
    `);
  });
}

const ROSTER_BRUSHES = [
  { status: STATUS.SUBMITTED, label: '出せた' },
  { status: STATUS.REDO, label: '直し' },
  { status: STATUS.EXEMPT, label: '免除' },
  { status: STATUS.FORGOTTEN, label: '忘れた' },
  { status: STATUS.IN_PROGRESS, label: '途中' },
  { status: STATUS.NOT_SUBMITTED, label: 'まだ（取り消す）' },
  { status: 'comment', label: 'コメント' },
];

// 提出状況の一括登録モーダルの状態。タップするたびに即保存し、画面だけを部分的に更新する。
const rosterState = { assignmentId: null, students: [], statuses: {}, comments: {}, brush: STATUS.SUBMITTED };

const COMMENT_TEMPLATES = ['欠席', 'ページがない', '名前がない', '日づけがない', '字をていねいに', 'やり直し'];

async function saveStudentComment(studentId, assignmentId, text) {
  const st = await getStatus(studentId, assignmentId);
  if (text) st.comment = text; else delete st.comment;
  if (!text && st.status === STATUS.NOT_SUBMITTED && !st.updatedAt) {
    await DB.delete('statuses', st.key);
    Sync.deleteStatusRemote(studentId, assignmentId);
  } else {
    await DB.put('statuses', st);
    Sync.pushStatus(st);
  }
}

function paintRoster() {
  const grid = document.getElementById('rosterGrid');
  if (!grid) return;
  let absentCount = 0;
  grid.innerHTML = rosterState.students.map(s => {
    const status = rosterState.statuses[s.id];
    const meta = STATUS_META[status];
    const comment = rosterState.comments[s.id];
    const absent = isAbsent(status, comment);
    if (absent) absentCount++;
    return `<button type="button" class="roster-tile ${meta.cls}" data-action="rosterTile" data-student="${s.id}">
      <span class="rt-num">${s.number}${comment ? '<span class="rt-note">✎</span>' : ''}</span>
      <span class="rt-name">${escapeHtml(s.name)}</span>
      <span class="rt-status">${absent ? '– 欠席' : `${meta.icon} ${meta.label}`}</span>
      ${comment ? `<span class="rt-comment">${escapeHtml(comment)}</span>` : ''}
    </button>`;
  }).join('') || '<p>児童が登録されていません</p>';
  const c = {};
  for (const st of Object.values(rosterState.statuses)) c[st] = (c[st] || 0) + 1;
  const exempt = c[STATUS.EXEMPT] || 0;
  const total = Object.keys(rosterState.statuses).length - exempt - absentCount;
  const notYet = (c[STATUS.NOT_SUBMITTED] || 0) + (c[STATUS.FORGOTTEN] || 0) + (c[STATUS.IN_PROGRESS] || 0) - absentCount;
  const redo = (c[STATUS.REDO] || 0) + (c[STATUS.RESUBMIT_WAIT] || 0);
  const counts = document.getElementById('rosterCounts');
  if (counts) counts.textContent = `出せた ${c[STATUS.SUBMITTED] || 0}／${total}人　まだ ${notYet}人　直し ${redo}人　免除 ${exempt}人　欠席 ${absentCount}人`;
  document.querySelectorAll('.brush-btn').forEach(b => b.classList.toggle('active', b.dataset.brush === rosterState.brush));
  const panel = document.getElementById('rosterCommentPanel');
  if (panel) panel.style.display = rosterState.brush === 'comment' ? 'block' : 'none';
}

async function openItemRoster(assignmentId) {
  const assignment = await DB.get('assignments', assignmentId);
  const item = await DB.get('items', assignment.itemId);
  const students = await getActiveStudents();
  rosterState.assignmentId = assignmentId;
  rosterState.students = students;
  rosterState.statuses = {};
  rosterState.comments = {};
  for (const s of students) {
    const st = await getStatus(s.id, assignmentId);
    rosterState.statuses[s.id] = st.status;
    if (st.comment) rosterState.comments[s.id] = st.comment;
  }
  renderModal(`
    <h3>${escapeHtml(item.name)}${assignment.detail ? '　' + escapeHtml(assignment.detail) : ''} ${deadlineBadge(assignment.deadline)}</h3>
    <p class="cal-legend" style="margin:0 0 8px;text-align:left;">① 下から、つけたい状態を選びます。② 児童をタップすると、その状態になります。続けて何人でもタップできます。</p>
    <div class="brush-bar">${ROSTER_BRUSHES.map(b => `<button type="button" class="brush-btn" data-action="rosterBrush" data-brush="${b.status}">${b.label}</button>`).join('')}</div>
    <div id="rosterCommentPanel" class="comment-panel" style="display:none;">
      <textarea id="rosterCommentText" rows="2" placeholder="つけたいコメントを入力（または下のボタン）" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;font-size:1rem;font-family:inherit;user-select:text;-webkit-user-select:text;"></textarea>
      <div style="margin-top:6px;">
        ${COMMENT_TEMPLATES.map(w => `<button type="button" class="mini-btn" data-action="appendCommentWord" data-word="${w}">${w}</button>`).join('')}
        <button type="button" class="mini-btn" data-action="clearCommentText">入力を消す</button>
      </div>
      <p style="color:#666;font-size:0.8rem;margin:6px 0 0;text-align:left;">この状態で児童をタップすると、上のコメントが付きます（何人でも続けて付けられます）。同じコメントの人をもう一度タップすると、コメントが消えます。入力を空にしてタップしても消えます。児童画面では、「直すもの」の児童にだけ表示されます。クラウド同期をしているときは、他の端末にも共有されます（コメントに児童の氏名は書かないでください）。</p>
    </div>
    <button type="button" class="mini-btn" data-action="rosterAllSubmitted" style="margin:8px 0;">まだの人を全員「出せた」にする</button>
    <p id="rosterCounts" class="roster-counts"></p>
    <div id="rosterGrid" class="roster-grid"></div>
    <button class="big-btn cancel" data-action="closeModalRefreshToday" style="margin-top:12px;">閉じる</button>
  `);
  paintRoster();
}

async function openRedoQuick(studentId) {
  const student = await DB.get('students', studentId);
  const allAssignments = await getAllAssignmentsWithItems();
  const rowsHtml = [];
  for (const a of allAssignments) {
    if (!a.item) continue;
    const st = await getStatus(studentId, a.id);
    if (st.status !== STATUS.REDO && st.status !== STATUS.RESUBMIT_WAIT) continue;
    rowsHtml.push(`
      <div class="quick-item">
        <div class="quick-item-name">${itemNamePlain(a)}（${STATUS_META[st.status].label}）</div>
        ${st.comment ? `<div class="quick-comment">✎ ${escapeHtml(st.comment)}</div>` : ''}
        <div class="quick-item-actions">
          <button class="mini-btn primary" data-action="teacherSetStatus" data-status="${STATUS.SUBMITTED}" data-assignment="${a.id}" data-student="${studentId}">確認OK（提出済に）</button>
          <button class="mini-btn" data-action="teacherSetStatus" data-status="${STATUS.REDO}" data-assignment="${a.id}" data-student="${studentId}">直しに戻す</button>
        </div>
      </div>`);
  }
  renderModal(`
    <h3>${student.number}番 ${escapeHtml(student.name)}さん</h3>
    ${rowsHtml.join('') || '<p>対象なし</p>'}
    <button class="big-btn cancel" data-action="closeModalRefreshHome">閉じる</button>
  `);
}

async function computeStudentStats(studentId) {
  const allAssignments = await getAllAssignmentsWithItems();
  const unresolved = [];
  const redo = [];
  const planned = [];
  let submittedCount = 0;
  let lateCount = 0;
  const totalCount = allAssignments.filter(a => a.item).length;
  const forgottenSet = new Set();

  for (const a of allAssignments) {
    if (!a.item) continue;
    const st = await getStatus(studentId, a.id);
    if (st.status === STATUS.SUBMITTED) {
      submittedCount++;
      if (a.deadline && st.updatedAt && new Date(st.updatedAt) > new Date(a.deadline)) lateCount++;
    } else if (st.status === STATUS.REDO || st.status === STATUS.RESUBMIT_WAIT) {
      redo.push({ a, st });
    } else if (st.plannedDate) {
      planned.push({ a, st });
    } else if (st.status !== STATUS.EXEMPT) {
      unresolved.push({ a, st });
    }
  }

  const history = (await DB.getAllByIndex('history', 'studentId', studentId)).sort((x, y) => new Date(y.at) - new Date(x.at));
  for (const h of history) if (h.status === STATUS.FORGOTTEN) forgottenSet.add(h.assignmentId);

  const rate = totalCount > 0 ? Math.round((submittedCount / totalCount) * 100) : null;
  return { unresolved, redo, planned, history, submittedCount, totalCount, lateCount, forgottenCount: forgottenSet.size, rate };
}

async function openStudentActions(studentId) {
  const s = await DB.get('students', studentId);
  renderModal(`
    <h3>${s.number}番 ${escapeHtml(s.name)}さん</h3>
    <p style="color:#666;">ふりがな：${s.kana ? escapeHtml(s.kana) : '（未設定）'}</p>
    <p style="color:#666;">コード：<span style="font-family:monospace;">${escapeHtml(s.code || '－')}</span></p>
    <div class="sheet-buttons">
      <button class="big-btn" data-action="openEditStudentSheet" data-id="${s.id}">編集する</button>
      <button class="big-btn" data-action="openStudentDetail" data-id="${s.id}">詳細を見る</button>
      <button class="big-btn" data-action="toggleStudentActive" data-id="${s.id}">${s.active === false ? '復帰させる' : '停止する'}</button>
      <button class="big-btn cancel" data-action="deleteStudent" data-id="${s.id}" data-name="${escapeHtml(s.name)}">削除する</button>
      <button class="big-btn cancel" data-action="closeModal">閉じる</button>
    </div>
  `);
}

function openEditStudentSheet(s) {
  renderModal(`
    <h3>${escapeHtml(s.name)}さんを編集</h3>
    <div style="text-align:left;">
      <label style="display:block;margin:10px 0 4px;">出席番号</label>
      <input type="number" id="editStudentNumber" value="${s.number}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;">
      <label style="display:block;margin:10px 0 4px;">氏名</label>
      <input type="text" id="editStudentName" value="${escapeHtml(s.name)}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;">
      <label style="display:block;margin:10px 0 4px;">ふりがな</label>
      <input type="text" id="editStudentKana" value="${escapeHtml(s.kana || '')}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;">
    </div>
    <div class="sheet-buttons">
      <button class="big-btn yes" data-action="saveStudentEdit" data-id="${s.id}">保存</button>
      <button class="big-btn cancel" data-action="closeModal">やめる</button>
    </div>
  `);
}

async function openStudentDetail(studentId) {
  const student = await DB.get('students', studentId);
  const stats = await computeStudentStats(studentId);
  const assignmentMap = Object.fromEntries((await getAllAssignmentsWithItems()).map(a => [a.id, a]));

  const rowHtml = ({ a, st }) => `
    <li class="item-row ${STATUS_META[st.status].cls}">
      <span class="item-icon">${STATUS_META[st.status].icon}</span>
      <span class="item-name">${itemNamePlain(a)}</span>
      <span class="item-status">${STATUS_META[st.status].label}${a.deadline ? deadlineBadge(a.deadline) : ''}</span>
    </li>`;

  const unresolvedHtml = stats.unresolved.map(rowHtml).join('') || '<li class="empty-row">なし</li>';
  const redoHtml = stats.redo.map(rowHtml).join('') || '<li class="empty-row">なし</li>';
  const plannedHtml = stats.planned.map(({ a, st }) => `
    <li class="item-row st-mid">
      <span class="item-icon">△</span>
      <span class="item-name">${itemNamePlain(a)}</span>
      <span class="item-status">${formatDateTimeJp(st.plannedDate)}まで</span>
    </li>`).join('') || '<li class="empty-row">なし</li>';

  const historyHtml = stats.history.slice(0, 30).map(h => {
    const a = assignmentMap[h.assignmentId];
    const name = a && a.item ? itemNamePlain(a) : '(削除済み)';
    return `<li class="t-row"><span class="t-items">${formatDateTimeJp(h.at)}　${name}　${STATUS_META[h.status].label}${h.actor === 'teacher' ? '（先生が変更）' : ''}</span></li>`;
  }).join('') || '<li class="empty-row">履歴なし</li>';

  renderModal(`
    <h3>${student.number}番 ${escapeHtml(student.name)}さん</h3>
    <div style="text-align:left;max-height:65vh;overflow-y:auto;">
      <h4>現在の未提出</h4>
      <ul class="item-list">${unresolvedHtml}</ul>
      <h4>直し・再提出待ち</h4>
      <ul class="item-list">${redoHtml}</ul>
      <h4>提出予定</h4>
      <ul class="item-list">${plannedHtml}</ul>
      <h4>提出率</h4>
      <p>${stats.rate === null ? '対象なし' : `${stats.rate}%（${stats.submittedCount}/${stats.totalCount}）`}</p>
      <p>忘れ ${stats.forgottenCount}回　遅れ ${stats.lateCount}回</p>
      <h4>履歴（新しい順・最大30件）</h4>
      <ul class="t-list">${historyHtml}</ul>
    </div>
    <button class="big-btn cancel" data-action="closeModal">閉じる</button>
  `);
}

// ---------- イベント処理 ----------

async function handleAction(action, ds) {
  switch (action) {
    case 'pickStudent':
      state.pendingStudentId = Number(ds.id);
      goto('childConfirm');
      return;
    case 'confirmStudent':
      state.studentId = state.pendingStudentId;
      state.pending = new Map();
      goto('childPage');
      return;
    case 'cancelStudent':
      goto('childSelect');
      return;
    case 'finishChild': {
      const { todayRows } = await getChildRows(state.studentId);
      const untouched = todayRows.filter(({ eff }) => eff === STATUS.NOT_SUBMITTED).map(({ a }) => a);
      if (state.pending.size === 0 && untouched.length === 0) {
        goto('childSelect');
        return;
      }
      openConfirmSheet(untouched);
      return;
    }
    case 'confirmRegister': {
      const studentId = state.studentId;
      const { todayRows: beforeRows } = await getChildRows(studentId);
      const assignmentIds = beforeRows.map(({ a }) => a.id);
      await commitPending();
      closeModal();
      let allDone = assignmentIds.length > 0;
      for (const id of assignmentIds) {
        const st = await getStatus(studentId, id);
        if (st.status !== STATUS.SUBMITTED && st.status !== STATUS.EXEMPT) { allDone = false; break; }
      }
      if (allDone) showCelebration(); else showToast('登録したよ！');
      goto('childSelect');
      return;
    }
    case 'alreadyDone':
      showToast('もう出したよ！取り消しは先生に言ってね');
      return;
    case 'redoInfo':
      showToast('先生の確認を待っているよ');
      return;
    case 'openItemSheet':
      openItemSheet(Number(ds.assignment));
      return;
    case 'openPlanSheet':
      await openPlanSheet(Number(ds.assignment), ds.status || STATUS.FORGOTTEN);
      return;
    case 'openRedoSheet':
      openRedoSheet(Number(ds.assignment));
      return;
    case 'closeModal':
      closeModal();
      return;
    case 'setChildStatus': {
      const assignmentId = Number(ds.assignment);
      state.pending.set(assignmentId, { status: ds.status, plannedDate: null });
      closeModal();
      renderChildPage();
      resetInactivityTimer();
      return;
    }
    case 'markAllSubmitted': {
      const { todayRows } = await getChildRows(state.studentId);
      for (const { a, eff } of todayRows) {
        if (eff === STATUS.NOT_SUBMITTED) {
          state.pending.set(a.id, { status: STATUS.SUBMITTED, plannedDate: null });
        }
      }
      renderChildPage();
      resetInactivityTimer();
      return;
    }
    case 'pickPlanDate': {
      await openPlanTimeSheet(Number(ds.assignment), ds.status, ds.date);
      return;
    }
    case 'openPlanCustomDate': {
      await openPlanCustomDate(Number(ds.assignment), ds.status);
      return;
    }
    case 'pickPlanDateCustom': {
      const dateVal = document.getElementById('customPlanDate').value;
      if (!dateVal) return;
      const holidaySet = await getHolidaySet();
      if (!isSchoolDay(dateVal, holidaySet)) {
        alert('土日やお休みの日は選べません。学校がある日を選んでください。');
        return;
      }
      await openPlanTimeSheet(Number(ds.assignment), ds.status, dateVal);
      return;
    }
    case 'setPlan': {
      const assignmentId = Number(ds.assignment);
      const timeVal = ds.time || '23:59';
      const plannedDate = localDateTimeToIso(ds.date, timeVal);
      const status = ds.status || STATUS.FORGOTTEN;
      state.pending.set(assignmentId, { status, plannedDate });
      closeModal();
      renderChildPage();
      resetInactivityTimer();
      return;
    }
    case 'resubmit': {
      await setStatus(state.studentId, Number(ds.assignment), STATUS.RESUBMIT_WAIT, 'child');
      closeModal();
      showToast('先生に伝えたよ');
      renderChildPage();
      resetInactivityTimer();
      return;
    }
    case 'goTeacherPin':
      goto('teacherPin');
      return;
    case 'goChildSelect':
      goto('childSelect');
      return;
    case 'pinDigit':
      if (!state.pinInput) state.pinInput = '';
      if (state.pinInput.length < 4) state.pinInput += ds.d;
      updatePinDisplay();
      if (state.pinInput.length === 4) {
        const pin = await getMeta('pin', '0000');
        if (state.pinInput === pin) {
          goto('teacherHome');
        } else {
          showToast('PINが違います');
          state.pinInput = '';
          updatePinDisplay();
        }
      }
      return;
    case 'pinClear':
      state.pinInput = '';
      updatePinDisplay();
      return;
    case 'pinBack':
      state.pinInput = (state.pinInput || '').slice(0, -1);
      updatePinDisplay();
      return;
    case 'teacherTab':
      state.teacherTab = ds.tab;
      renderTeacherByTab();
      return;
    case 'openStudentQuick':
      openStudentQuick(Number(ds.id), ds.date);
      return;
    case 'openRedoQuick':
      openRedoQuick(Number(ds.id));
      return;
    case 'openStudentDetail':
      openStudentDetail(Number(ds.id));
      return;
    case 'openItemRoster':
      openItemRoster(Number(ds.assignment));
      return;
    case 'editAssignment': {
      const a = await DB.get('assignments', Number(ds.assignment));
      const item = await DB.get('items', a.itemId);
      openAssignmentEditSheet(a, item ? item.name : '');
      return;
    }
    case 'saveAssignmentEdit': {
      const a = await DB.get('assignments', Number(ds.assignment));
      const detail = document.getElementById('editDetailInput').value.trim();
      const clearDeadline = document.getElementById('editDeadlineClear').checked;
      const deadlineInput = clearDeadline ? '' : document.getElementById('editDeadlineInput').value;
      if (deadlineInput && new Date(deadlineInput) < new Date()) {
        alert('今より前の時刻は設定できません');
        return;
      }
      a.detail = detail;
      a.deadline = deadlineInput ? new Date(deadlineInput).toISOString() : null;
      await DB.put('assignments', a);
      const item = await DB.get('items', a.itemId);
      Sync.pushAssignment(a, item ? item.syncId : null);
      closeModal();
      showToast('変更しました');
      renderTeacherToday();
      return;
    }
    case 'removeTodayAssignment': {
      if (!confirm(`「${ds.name}」をこの日の提出物から外します。この提出物についてのこれまでの記録も削除されます。よろしいですか？`)) return;
      await removeAssignmentCascade(Number(ds.assignment));
      closeModal();
      showToast('外しました');
      await rerenderTodayKeepScroll();
      return;
    }
    case 'closeModalRefreshHome':
      closeModal();
      renderTeacherHome();
      return;
    case 'closeModalRefreshToday':
      closeModal();
      renderTeacherToday();
      return;
    case 'teacherSetStatus':
      await setStatus(Number(ds.student), Number(ds.assignment), ds.status, 'teacher');
      showToast('変更しました');
      if (state.teacherTab === 'today') {
        openItemRoster(Number(ds.assignment));
      } else {
        closeModal();
        renderTeacherHome();
      }
      return;
    case 'openStudentActions':
      openStudentActions(Number(ds.id));
      return;
    case 'openEditStudentSheet': {
      const s = await DB.get('students', Number(ds.id));
      openEditStudentSheet(s);
      return;
    }
    case 'appendDetailWord': {
      const input = document.getElementById(ds.for);
      if (!input) return;
      if (!input.value.endsWith(ds.word)) input.value += ds.word;
      input.focus();
      return;
    }
    case 'saveStudentEdit': {
      const s = await DB.get('students', Number(ds.id));
      const number = Number(document.getElementById('editStudentNumber').value);
      const name = document.getElementById('editStudentName').value.trim();
      const kana = document.getElementById('editStudentKana').value.trim();
      if (!name || !Number.isFinite(number)) return;
      if (await studentNameExists(name, s.id)) {
        alert(`「${name}」という名前はすでに登録されています。`);
        return;
      }
      s.number = number;
      s.name = name;
      s.kana = kana;
      await DB.put('students', s);
      closeModal();
      showToast('変更しました');
      renderTeacherStudents();
      return;
    }
    case 'toggleStudentActive': {
      const st = await DB.get('students', Number(ds.id));
      st.active = st.active === false ? true : false;
      await DB.put('students', st);
      closeModal();
      renderTeacherStudents();
      return;
    }
    case 'openItemActions':
      openItemActions(Number(ds.id), ds.name);
      return;
    case 'rosterBrush':
      rosterState.brush = ds.brush;
      paintRoster();
      return;
    case 'rosterTile': {
      const studentId = Number(ds.student);
      const status = rosterState.brush;
      if (status === 'comment') {
        const text = document.getElementById('rosterCommentText').value.trim();
        const next = text && rosterState.comments[studentId] === text ? '' : text;
        if (next) rosterState.comments[studentId] = next; else delete rosterState.comments[studentId];
        paintRoster();
        await saveStudentComment(studentId, rosterState.assignmentId, next);
        return;
      }
      if (rosterState.statuses[studentId] === status) return;
      rosterState.statuses[studentId] = status;
      paintRoster();
      await setStatus(studentId, rosterState.assignmentId, status, 'teacher', status === STATUS.NOT_SUBMITTED ? null : undefined);
      return;
    }
    case 'appendCommentWord': {
      const input = document.getElementById('rosterCommentText');
      if (!input) return;
      input.value = input.value.trim() ? `${input.value.trim()}、${ds.word}` : ds.word;
      return;
    }
    case 'clearCommentText': {
      const input = document.getElementById('rosterCommentText');
      if (input) input.value = '';
      return;
    }
    case 'rosterAllSubmitted': {
      const targets = rosterState.students.filter(s =>
        rosterState.statuses[s.id] === STATUS.NOT_SUBMITTED && !isAbsent(rosterState.statuses[s.id], rosterState.comments[s.id]));
      if (!targets.length) { showToast('「まだ」の人はいません（欠席の人は除きます）'); return; }
      if (!confirm(`「まだ」の${targets.length}人を、全員「出せた」にします。よろしいですか？`)) return;
      for (const s of targets) rosterState.statuses[s.id] = STATUS.SUBMITTED;
      paintRoster();
      for (const s of targets) await setStatus(s.id, rosterState.assignmentId, STATUS.SUBMITTED, 'teacher');
      showToast(`${targets.length}人を「出せた」にしました`);
      return;
    }
    case 'moveItem':
      await moveItem(Number(ds.id), Number(ds.dir));
      renderTeacherItems();
      return;
    case 'openAssignmentMenu': {
      const a = await DB.get('assignments', Number(ds.assignment));
      const item = a ? await DB.get('items', a.itemId) : null;
      if (!item) return;
      renderModal(`
        <h3>${escapeHtml(item.name)}${a.detail ? '　' + escapeHtml(a.detail) : ''}</h3>
        <div class="sheet-buttons">
          <button class="big-btn" data-action="editAssignment" data-assignment="${a.id}">詳細（ページ・番号）・提出期限を入れる</button>
          <button class="big-btn" data-action="openItemRoster" data-assignment="${a.id}">一人ひとりの提出を確認</button>
          <button class="big-btn cancel" data-action="removeTodayAssignment" data-assignment="${a.id}" data-name="${escapeHtml(item.name)}">この日の提出物から外す</button>
          <button class="big-btn cancel" data-action="closeModal">閉じる</button>
        </div>
      `);
      return;
    }
    case 'toggleItemActive': {
      const it = await DB.get('items', Number(ds.id));
      it.active = it.active === false ? true : false;
      await DB.put('items', it);
      Sync.pushItem(it);
      closeModal();
      renderTeacherItems();
      return;
    }
    case 'deleteStudent': {
      if (!confirm(`${ds.name}さんを削除します。提出履歴もすべて削除され、元に戻せません。よろしいですか？`)) return;
      await deleteStudentCascade(Number(ds.id));
      closeModal();
      showToast('削除しました');
      renderTeacherStudents();
      return;
    }
    case 'deleteItem': {
      if (!confirm(`「${ds.name}」を削除します。関連する提出履歴もすべて削除され、元に戻せません。よろしいですか？`)) return;
      await deleteItemCascade(Number(ds.id));
      closeModal();
      showToast('削除しました');
      renderTeacherItems();
      return;
    }
  }
}

function renderTeacherByTab() {
  const map = {
    home: renderTeacherHome,
    today: renderTeacherToday,
    items: renderTeacherItems,
    students: renderTeacherStudents,
    settings: renderTeacherSettings,
  };
  (map[state.teacherTab] || renderTeacherHome)();
}

document.body.addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') { closeModal(); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  handleAction(el.dataset.action, el.dataset);
});

['click', 'touchstart'].forEach(evt => {
  document.body.addEventListener(evt, resetInactivityTimer, { passive: true });
});

async function render() {
  switch (state.screen) {
    case 'childSelect': return renderChildSelect();
    case 'childConfirm': return renderChildConfirm();
    case 'childPage': return renderChildPage();
    case 'teacherPin': return renderTeacherPin();
    case 'teacherHome': return renderTeacherByTab();
    default: return renderChildSelect();
  }
}

async function main() {
  try {
    await ensureBootstrap();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    Sync.onSyncChange(() => render());
    if (await Sync.isSyncEnabled()) Sync.startSync();

    const joinParam = new URLSearchParams(location.search).get('join');
    if (joinParam && !(await Sync.isSyncEnabled())) {
      pendingJoinCode = joinParam;
      state.teacherTab = 'settings';
      history.replaceState(null, '', location.pathname);
      goto('teacherPin');
      return;
    }
    await render();
  } catch (err) {
    app.innerHTML = `
      <div style="padding:24px;text-align:center;">
        <h2 style="color:#cf222e;">起動できませんでした</h2>
        <p style="color:#555;">${escapeHtml(err && err.message ? err.message : String(err))}</p>
        <button style="margin-top:16px;padding:12px 20px;font-size:1rem;" onclick="location.reload()">再読み込み</button>
      </div>
    `;
  }
}

main();
