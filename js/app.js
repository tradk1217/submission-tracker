import { DB, getMeta, setMeta } from './db.js';
import { todayStr, addDays, formatDateJp, formatDateTimeJp, deadlineState, rubyHtml, escapeHtml } from './util.js';

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
  [STATUS.NOT_SUBMITTED]: { icon: '□', label: 'まだ', cls: 'st-none' },
  [STATUS.SUBMITTED]: { icon: '○', label: 'だせた', cls: 'st-ok' },
  [STATUS.IN_PROGRESS]: { icon: '△', label: 'とちゅう', cls: 'st-mid' },
  [STATUS.FORGOTTEN]: { icon: '×', label: 'わすれた', cls: 'st-bad' },
  [STATUS.REDO]: { icon: '★', label: 'なおし', cls: 'st-redo' },
  [STATUS.RESUBMIT_WAIT]: { icon: '→', label: 'かくにん中', cls: 'st-wait' },
  [STATUS.EXEMPT]: { icon: '–', label: 'めんじょ', cls: 'st-none' },
};

const app = document.getElementById('app');

const state = {
  screen: 'childSelect',
  studentId: null,
  pendingStudentId: null,
  modal: null,
  teacherTab: 'home',
  inactivityTimer: null,
};

async function ensureBootstrap() {
  const pin = await getMeta('pin', null);
  if (pin === null) await setMeta('pin', '0000');
}

function goto(screen, extra = {}) {
  Object.assign(state, { screen, modal: null }, extra);
  render();
}

function resetInactivityTimer() {
  if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
  if (state.screen === 'childPage' || state.screen === 'childConfirm') {
    state.inactivityTimer = setTimeout(() => {
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

// ---------- データ取得ヘルパー ----------

async function getActiveStudents() {
  const all = await DB.getAll('students');
  return all.filter(s => s.active !== false).sort((a, b) => a.number - b.number);
}

async function getActiveItems() {
  const all = await DB.getAll('items');
  return all.filter(i => i.active !== false);
}

async function getTodayAssignments() {
  const list = await DB.getAllByIndex('assignments', 'date', todayStr());
  const items = await DB.getAll('items');
  const itemMap = Object.fromEntries(items.map(i => [i.id, i]));
  return list.map(a => ({ ...a, item: itemMap[a.itemId] }));
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
  };
  await DB.put('statuses', row);
  await DB.add('history', { studentId, assignmentId, status, actor, at: row.updatedAt });
  return row;
}

// ---------- 児童モード ----------

async function renderChildSelect() {
  const students = await getActiveStudents();
  const panels = students.map(s => `
    <button class="num-btn" data-action="pickStudent" data-id="${s.id}">${s.number}</button>
  `).join('');
  app.innerHTML = `
    <div class="screen child-select">
      <h1 class="page-title">しゅっせきばんごうを おしてね</h1>
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
      <p class="confirm-lead">${rubyHtml('この ばんごうで', '')}</p>
      <div class="confirm-name">${student.number}ばん ${rubyHtml(student.name, student.kana)}</div>
      <p class="confirm-lead">${rubyHtml('まちがいないですか？', '')}</p>
      <div class="confirm-buttons">
        <button class="big-btn yes" data-action="confirmStudent">${rubyHtml('はい', '')}</button>
        <button class="big-btn no" data-action="cancelStudent">${rubyHtml('ちがう', '')}</button>
      </div>
    </div>
  `;
  resetInactivityTimer();
}

async function renderChildPage() {
  const student = await DB.get('students', state.studentId);
  if (!student) { goto('childSelect'); return; }

  const todayList = await getTodayAssignments();
  const todayRows = [];
  for (const a of todayList) {
    if (!a.item) continue;
    const st = await getStatus(student.id, a.id);
    if (st.status === STATUS.REDO || st.status === STATUS.RESUBMIT_WAIT) continue;
    todayRows.push({ a, st });
  }

  const allAssignments = await getAllAssignmentsWithItems();
  const redoRows = [];
  const laterRows = [];
  for (const a of allAssignments) {
    if (!a.item) continue;
    const st = await getStatus(student.id, a.id);
    if (st.status === STATUS.REDO || st.status === STATUS.RESUBMIT_WAIT) {
      redoRows.push({ a, st });
    } else if (st.plannedDate && st.status !== STATUS.SUBMITTED && st.status !== STATUS.EXEMPT) {
      laterRows.push({ a, st });
    }
  }

  const history = await getStudentStatuses(student.id);
  const submittedCount = history.filter(h => h.status === STATUS.SUBMITTED).length;
  const histAll = await DB.getAllByIndex('history', 'studentId', student.id);
  const forgottenAssignments = new Set(histAll.filter(h => h.status === STATUS.FORGOTTEN).map(h => h.assignmentId));

  const todayHtml = todayRows.length ? todayRows.map(({ a, st }) => {
    const meta = STATUS_META[st.status];
    const clickable = st.status !== STATUS.SUBMITTED && st.status !== STATUS.EXEMPT;
    return `<li class="item-row ${meta.cls}" ${clickable ? `data-action="openItemSheet" data-assignment="${a.id}"` : `data-action="alreadyDone"`}>
      <span class="item-icon">${meta.icon}</span>
      <span class="item-name">${rubyHtml(a.item.name, a.item.kana)}</span>
      <span class="item-status">${meta.label}</span>
    </li>`;
  }).join('') : '<li class="empty-row">今日はありません</li>';

  const redoHtml = redoRows.length ? redoRows.map(({ a, st }) => {
    const waiting = st.status === STATUS.RESUBMIT_WAIT;
    return `<li class="item-row ${waiting ? 'st-wait' : 'st-redo'}" data-action="${waiting ? 'redoInfo' : 'openRedoSheet'}" data-assignment="${a.id}">
      <span class="item-icon">${waiting ? '→' : '★'}</span>
      <span class="item-name">${rubyHtml(a.item.name, a.item.kana)}</span>
      <span class="item-status">${waiting ? 'かくにん中' : 'なおしてね'}</span>
    </li>`;
  }).join('') : '<li class="empty-row">ありません</li>';

  const laterHtml = laterRows.length ? laterRows.map(({ a, st }) => `
    <li class="item-row st-mid" data-action="openItemSheet" data-assignment="${a.id}">
      <span class="item-icon">△</span>
      <span class="item-name">${rubyHtml(a.item.name, a.item.kana)}</span>
      <span class="item-status">${formatDateJp(st.plannedDate)}まで</span>
    </li>`).join('') : '<li class="empty-row">ありません</li>';

  app.innerHTML = `
    <div class="screen child-page">
      <div class="child-header">${student.number}ばん ${rubyHtml(student.name, student.kana)}さん</div>

      <section class="card">
        <h2>${rubyHtml('いま出すもの', 'いまだすもの')}</h2>
        <ul class="item-list">${todayHtml}</ul>
      </section>

      <section class="card">
        <h2>なおすもの</h2>
        <ul class="item-list">${redoHtml}</ul>
      </section>

      <section class="card">
        <h2>${rubyHtml('あとで出すもの', 'あとでだすもの')}</h2>
        <ul class="item-list">${laterHtml}</ul>
      </section>

      <section class="card small">
        <h2>これまでのようす</h2>
        <p>${rubyHtml('出せた', 'だせた')}　${submittedCount}回</p>
        <p>わすれた　${forgottenAssignments.size}回</p>
      </section>

      <button class="finish-btn" data-action="finishChild">${rubyHtml('おわったら ここをおす', '')}</button>
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
  const el = document.getElementById('modalOverlay');
  if (el) el.remove();
}

function openItemSheet(assignmentId) {
  renderModal(`
    <h3>${rubyHtml('どうする？', '')}</h3>
    <div class="sheet-buttons">
      <button class="big-btn yes" data-action="setChildStatus" data-status="${STATUS.SUBMITTED}" data-assignment="${assignmentId}">${rubyHtml('だせた', '')}</button>
      <button class="big-btn" data-action="setChildStatus" data-status="${STATUS.IN_PROGRESS}" data-assignment="${assignmentId}">${rubyHtml('とちゅう', '')}</button>
      <button class="big-btn" data-action="setChildStatus" data-status="${STATUS.FORGOTTEN}" data-assignment="${assignmentId}">${rubyHtml('わすれた', '')}</button>
      <button class="big-btn plan" data-action="openPlanSheet" data-assignment="${assignmentId}">${rubyHtml('よていびをきめる', '')}</button>
      <button class="big-btn cancel" data-action="closeModal">${rubyHtml('やめる', '')}</button>
    </div>
  `);
}

function openPlanSheet(assignmentId) {
  const today = todayStr();
  renderModal(`
    <h3>${rubyHtml('いつ出す？', '')}</h3>
    <div class="sheet-buttons">
      <button class="big-btn" data-action="setPlan" data-days="1" data-assignment="${assignmentId}">${rubyHtml('あした', '')}</button>
      <button class="big-btn" data-action="setPlan" data-days="2" data-assignment="${assignmentId}">${rubyHtml('あさって', '')}</button>
      <button class="big-btn" data-action="setPlan" data-days="3" data-assignment="${assignmentId}">3日後</button>
      <button class="big-btn cancel" data-action="closeModal">${rubyHtml('やめる', '')}</button>
    </div>
  `);
}

function openDeadlineSheet(itemId) {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  const defaultVal = now.toISOString().slice(0, 16);
  renderModal(`
    <h3>期限を設定</h3>
    <input type="datetime-local" id="deadlineInput" value="${defaultVal}" class="deadline-input">
    <div class="sheet-buttons">
      <button class="big-btn yes" data-action="confirmDeadline" data-id="${itemId}">この日時で追加</button>
      <button class="big-btn" data-action="skipDeadline" data-id="${itemId}">期限なしで追加</button>
      <button class="big-btn cancel" data-action="closeModal">やめる</button>
    </div>
  `);
}

function openRedoSheet(assignmentId) {
  renderModal(`
    <h3>${rubyHtml('なおして出す？', '')}</h3>
    <div class="sheet-buttons">
      <button class="big-btn yes" data-action="resubmit" data-assignment="${assignmentId}">${rubyHtml('なおして出した', '')}</button>
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

async function renderTeacherHome() {
  const todayList = await getTodayAssignments();
  const students = await getActiveStudents();

  let unsubmittedCount = 0, redoCount = 0, overCount = 0;
  const unsubmittedByStudent = new Map();

  for (const a of todayList) {
    if (!a.item) continue;
    const dl = deadlineState(a.deadline);
    for (const s of students) {
      const st = await getStatus(s.id, a.id);
      if (![STATUS.SUBMITTED, STATUS.EXEMPT, STATUS.REDO, STATUS.RESUBMIT_WAIT].includes(st.status)) {
        unsubmittedCount++;
        if (!unsubmittedByStudent.has(s.id)) unsubmittedByStudent.set(s.id, { student: s, items: [] });
        unsubmittedByStudent.get(s.id).items.push({ a, st, dl });
        if (dl && dl.level === 'over') overCount++;
      }
    }
  }

  const allAssignments = await getAllAssignmentsWithItems();
  const redoByStudent = new Map();
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
    <li class="t-row" data-action="openStudentQuick" data-id="${student.id}">
      <span class="t-num">${student.number}番</span>
      <span class="t-name">${escapeHtml(student.name)}</span>
      <span class="t-items">${items.map(i => escapeHtml(i.a.item.name)).join('・')}</span>
    </li>`).join('') || '<li class="empty-row">未提出はありません</li>';

  const redoHtml = [...redoByStudent.values()].map(({ student, items }) => `
    <li class="t-row" data-action="openRedoQuick" data-id="${student.id}">
      <span class="t-num">${student.number}番</span>
      <span class="t-name">${escapeHtml(student.name)}</span>
      <span class="t-items">${items.map(i => `${escapeHtml(i.a.item.name)}(${STATUS_META[i.st.status].label})`).join('・')}</span>
    </li>`).join('') || '<li class="empty-row">ありません</li>';

  app.innerHTML = `
    <div class="screen teacher-home">
      ${teacherNav('home')}
      <h1>今日 ${formatDateJp(todayStr())}</h1>
      <div class="summary-cards">
        <div class="sum-card">提出物 ${todayList.filter(a => a.item).length}件</div>
        <div class="sum-card warn">未提出 ${unsubmittedCount}件</div>
        <div class="sum-card redo">直し ${redoCount}件</div>
        <div class="sum-card over">期限超過 ${overCount}件</div>
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
}

function teacherNav(active) {
  const tabs = [
    ['home', 'ホーム'],
    ['today', '今日の提出物'],
    ['items', '提出物マスタ'],
    ['students', '名簿'],
    ['settings', '設定'],
  ];
  return `<nav class="teacher-nav">
    ${tabs.map(([k, label]) => `<button class="nav-btn ${active === k ? 'active' : ''}" data-action="teacherTab" data-tab="${k}">${label}</button>`).join('')}
    <button class="nav-btn child" data-action="goChildSelect">児童画面へ</button>
  </nav>`;
}

async function renderTeacherStudents() {
  const students = (await DB.getAll('students')).sort((a, b) => a.number - b.number);
  const rows = students.map(s => `
    <li class="t-row">
      <span class="t-num">${s.number}番</span>
      <span class="t-name">${escapeHtml(s.name)}${s.active === false ? '（停止中）' : ''}</span>
      <button class="mini-btn" data-action="toggleStudentActive" data-id="${s.id}">${s.active === false ? '復帰' : '停止'}</button>
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
    </div>
  `;
  document.getElementById('addStudentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const number = Number(fd.get('number'));
    const name = String(fd.get('name')).trim();
    const kana = String(fd.get('kana') || '').trim();
    if (!name) return;
    await DB.add('students', { number, name, kana, active: true });
    renderTeacherStudents();
  });
}

async function renderTeacherItems() {
  const items = await DB.getAll('items');
  const rows = items.map(i => `
    <li class="t-row">
      <span class="t-name">${escapeHtml(i.name)}${i.active === false ? '（停止中）' : ''}</span>
      <span class="t-items">${i.hasDeadline ? '期限あり' : ''}</span>
      <button class="mini-btn" data-action="toggleItemActive" data-id="${i.id}">${i.active === false ? '復帰' : '停止'}</button>
    </li>`).join('') || '<li class="empty-row">未登録</li>';

  app.innerHTML = `
    <div class="screen teacher-page">
      ${teacherNav('items')}
      <h1>提出物マスタ</h1>
      <ul class="t-list">${rows}</ul>
      <section class="card">
        <h2>追加</h2>
        <form id="addItemForm" class="form-row">
          <input type="text" name="name" placeholder="提出物名" required>
          <input type="text" name="kana" placeholder="ふりがな（任意）">
          <label><input type="checkbox" name="hasDeadline"> 期限を設定できる</label>
          <button type="submit" class="mini-btn primary">追加</button>
        </form>
      </section>
    </div>
  `;
  document.getElementById('addItemForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name')).trim();
    const kana = String(fd.get('kana') || '').trim();
    const hasDeadline = !!fd.get('hasDeadline');
    if (!name) return;
    await DB.add('items', { name, kana, hasDeadline, subject: '', memo: '', active: true });
    renderTeacherItems();
  });
}

async function renderTeacherToday() {
  const items = await getActiveItems();
  const todayList = await getTodayAssignments();
  const assignedItemIds = new Set(todayList.map(a => a.itemId));

  const assignmentByItemId = Object.fromEntries(todayList.map(a => [a.itemId, a]));
  const rows = items.map(i => `
    <li class="t-row">
      <span class="t-name">${escapeHtml(i.name)}</span>
      ${assignedItemIds.has(i.id)
        ? `<button class="mini-btn" data-action="openItemRoster" data-assignment="${assignmentByItemId[i.id].id}">一人ひとりを確認</button>`
        : `<button class="mini-btn primary" data-action="addTodayAssignment" data-id="${i.id}" data-deadline="${i.hasDeadline ? '1' : '0'}">今日に追加</button>`}
    </li>`).join('') || '<li class="empty-row">提出物マスタがありません</li>';

  app.innerHTML = `
    <div class="screen teacher-page">
      ${teacherNav('today')}
      <h1>今日の提出物 (${formatDateJp(todayStr())})</h1>
      <ul class="t-list">${rows}</ul>
    </div>
  `;
}

async function renderTeacherSettings() {
  app.innerHTML = `
    <div class="screen teacher-page">
      ${teacherNav('settings')}
      <h1>設定</h1>
      <section class="card">
        <h2>PIN変更</h2>
        <form id="pinForm" class="form-row">
          <input type="text" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="新しいPIN（4桁）" required>
          <button type="submit" class="mini-btn primary">変更</button>
        </form>
      </section>
    </div>
  `;
  document.getElementById('pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const pin = String(fd.get('pin'));
    if (!/^\d{4}$/.test(pin)) return;
    await setMeta('pin', pin);
    showToast('PINを変更しました');
  });
}

function openStudentQuick(studentId) {
  getTodayAssignments().then(async todayList => {
    const student = await DB.get('students', studentId);
    const rowsHtml = [];
    for (const a of todayList) {
      if (!a.item) continue;
      const st = await getStatus(studentId, a.id);
      const isSubmitted = st.status === STATUS.SUBMITTED;
      rowsHtml.push(`
        <div class="quick-item">
          <div class="quick-item-name">${escapeHtml(a.item.name)}（${STATUS_META[st.status].label}）</div>
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

async function openItemRoster(assignmentId) {
  const assignment = await DB.get('assignments', assignmentId);
  const item = await DB.get('items', assignment.itemId);
  const students = await getActiveStudents();
  const rowsHtml = [];
  for (const s of students) {
    const st = await getStatus(s.id, assignmentId);
    const isSubmitted = st.status === STATUS.SUBMITTED;
    const isRedo = st.status === STATUS.REDO || st.status === STATUS.RESUBMIT_WAIT;
    rowsHtml.push(`
      <div class="quick-item">
        <div class="quick-item-name">${s.number}番 ${escapeHtml(s.name)}（${STATUS_META[st.status].label}）</div>
        <div class="quick-item-actions">
          ${isSubmitted ? `<button class="mini-btn" data-action="teacherSetStatus" data-status="${STATUS.REDO}" data-assignment="${assignmentId}" data-student="${s.id}">直しにする</button>` : ''}
          ${isRedo ? `<button class="mini-btn primary" data-action="teacherSetStatus" data-status="${STATUS.SUBMITTED}" data-assignment="${assignmentId}" data-student="${s.id}">確認OK</button>` : ''}
          ${!isSubmitted && !isRedo ? `
            <button class="mini-btn primary" data-action="teacherSetStatus" data-status="${STATUS.SUBMITTED}" data-assignment="${assignmentId}" data-student="${s.id}">提出済</button>
            <button class="mini-btn" data-action="teacherSetStatus" data-status="${STATUS.FORGOTTEN}" data-assignment="${assignmentId}" data-student="${s.id}">忘れ</button>
            <button class="mini-btn" data-action="teacherSetStatus" data-status="${STATUS.EXEMPT}" data-assignment="${assignmentId}" data-student="${s.id}">免除</button>
          ` : ''}
        </div>
      </div>`);
  }
  renderModal(`
    <h3>${escapeHtml(item.name)}</h3>
    ${rowsHtml.join('') || '<p>児童が登録されていません</p>'}
    <button class="big-btn cancel" data-action="closeModalRefreshToday">閉じる</button>
  `);
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
        <div class="quick-item-name">${escapeHtml(a.item.name)}（${STATUS_META[st.status].label}）</div>
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

// ---------- イベント処理 ----------

async function handleAction(action, ds) {
  switch (action) {
    case 'pickStudent':
      state.pendingStudentId = Number(ds.id);
      goto('childConfirm');
      return;
    case 'confirmStudent':
      state.studentId = state.pendingStudentId;
      goto('childPage');
      return;
    case 'cancelStudent':
      goto('childSelect');
      return;
    case 'finishChild':
      goto('childSelect');
      return;
    case 'alreadyDone':
      showToast('もうだしたよ！取り消しは先生に言ってね');
      return;
    case 'redoInfo':
      showToast('せんせいの確認を待っているよ');
      return;
    case 'openItemSheet':
      openItemSheet(Number(ds.assignment));
      return;
    case 'openPlanSheet':
      openPlanSheet(Number(ds.assignment));
      return;
    case 'openRedoSheet':
      openRedoSheet(Number(ds.assignment));
      return;
    case 'closeModal':
      closeModal();
      return;
    case 'setChildStatus': {
      await setStatus(state.studentId, Number(ds.assignment), ds.status, 'child');
      closeModal();
      showToast(ds.status === STATUS.SUBMITTED ? '提出できたよ！' : '登録したよ');
      renderChildPage();
      resetInactivityTimer();
      return;
    }
    case 'setPlan': {
      const days = Number(ds.days);
      const plannedDate = addDays(todayStr(), days);
      const cur = await getStatus(state.studentId, Number(ds.assignment));
      const status = cur.status === STATUS.NOT_SUBMITTED ? STATUS.IN_PROGRESS : cur.status;
      await setStatus(state.studentId, Number(ds.assignment), status, 'child', plannedDate);
      closeModal();
      showToast('よていをしらせたよ');
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
      openStudentQuick(Number(ds.id));
      return;
    case 'openRedoQuick':
      openRedoQuick(Number(ds.id));
      return;
    case 'openItemRoster':
      openItemRoster(Number(ds.assignment));
      return;
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
    case 'toggleStudentActive': {
      const st = await DB.get('students', Number(ds.id));
      st.active = st.active === false ? true : false;
      await DB.put('students', st);
      renderTeacherStudents();
      return;
    }
    case 'toggleItemActive': {
      const it = await DB.get('items', Number(ds.id));
      it.active = it.active === false ? true : false;
      await DB.put('items', it);
      renderTeacherItems();
      return;
    }
    case 'addTodayAssignment': {
      const itemId = Number(ds.id);
      if (ds.deadline === '1') {
        openDeadlineSheet(itemId);
        return;
      }
      await DB.add('assignments', { date: todayStr(), itemId, deadline: null });
      renderTeacherToday();
      return;
    }
    case 'confirmDeadline': {
      const itemId = Number(ds.id);
      const input = document.getElementById('deadlineInput');
      const deadline = input && input.value ? new Date(input.value).toISOString() : null;
      await DB.add('assignments', { date: todayStr(), itemId, deadline });
      closeModal();
      renderTeacherToday();
      return;
    }
    case 'skipDeadline': {
      const itemId = Number(ds.id);
      await DB.add('assignments', { date: todayStr(), itemId, deadline: null });
      closeModal();
      renderTeacherToday();
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
