import { DB, getMeta, setMeta, ALL_STORES } from './db.js';
import { todayStr, addDays, formatDateJp, formatDateTimeJp, deadlineState, rubyHtml, escapeHtml, parseCsv, downloadCsv } from './util.js';

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
  const meta = STATUS_META[status];
  return rubyHtml(meta.label, meta.kana);
}

function deadlineBadge(deadline) {
  const dl = deadlineState(deadline);
  if (!dl) return '';
  const cls = { over: 'dl-over', today: 'dl-today', soon: 'dl-soon', ok: 'dl-ok' }[dl.level];
  return `<span class="dl-badge ${cls}">${dl.label} ${formatDateTimeJp(deadline)}</span>`;
}

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

async function deleteStudentCascade(studentId) {
  const statuses = await DB.getAllByIndex('statuses', 'studentId', studentId);
  for (const s of statuses) await DB.delete('statuses', s.key);
  const history = await DB.getAllByIndex('history', 'studentId', studentId);
  for (const h of history) await DB.delete('history', h.id);
  await DB.delete('students', studentId);
}

async function deleteItemCascade(itemId) {
  const assignments = (await DB.getAll('assignments')).filter(a => a.itemId === itemId);
  for (const a of assignments) {
    const statuses = await DB.getAllByIndex('statuses', 'assignmentId', a.id);
    for (const s of statuses) await DB.delete('statuses', s.key);
    const history = await DB.getAllByIndex('history', 'assignmentId', a.id);
    for (const h of history) await DB.delete('history', h.id);
    await DB.delete('assignments', a.id);
  }
  await DB.delete('items', itemId);
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
      <p class="confirm-lead">${rubyHtml('この 番号で', 'このばんごうで')}</p>
      <div class="confirm-name">${student.number}${rubyHtml('番', 'ばん')} ${rubyHtml(student.name, student.kana)}</div>
      <p class="confirm-lead">${rubyHtml('間違いないですか？', 'まちがいないですか')}</p>
      <div class="confirm-buttons">
        <button class="big-btn yes" data-action="confirmStudent">${rubyHtml('はい', '')}</button>
        <button class="big-btn no" data-action="cancelStudent">${rubyHtml('違う', 'ちがう')}</button>
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
      <span class="item-status">${childLabel(st.status)}</span>
    </li>`;
  }).join('') : '<li class="empty-row">' + rubyHtml('今日はありません', 'きょうはありません') + '</li>';

  const redoHtml = redoRows.length ? redoRows.map(({ a, st }) => {
    const waiting = st.status === STATUS.RESUBMIT_WAIT;
    return `<li class="item-row ${waiting ? 'st-wait' : 'st-redo'}" data-action="${waiting ? 'redoInfo' : 'openRedoSheet'}" data-assignment="${a.id}">
      <span class="item-icon">${waiting ? '→' : '★'}</span>
      <span class="item-name">${rubyHtml(a.item.name, a.item.kana)}</span>
      <span class="item-status">${waiting ? childLabel(STATUS.RESUBMIT_WAIT) : rubyHtml('直してね', 'なおしてね')}</span>
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
      <div class="child-header">${student.number}${rubyHtml('番', 'ばん')} ${rubyHtml(student.name, student.kana)}${rubyHtml('さん', '')}</div>

      <section class="card">
        <h2>${rubyHtml('今出すもの', 'いまだすもの')}</h2>
        <ul class="item-list">${todayHtml}</ul>
      </section>

      <section class="card">
        <h2>${rubyHtml('直すもの', 'なおすもの')}</h2>
        <ul class="item-list">${redoHtml}</ul>
      </section>

      <section class="card">
        <h2>${rubyHtml('後で出すもの', 'あとでだすもの')}</h2>
        <ul class="item-list">${laterHtml}</ul>
      </section>

      <section class="card small">
        <h2>${rubyHtml('これまでの様子', 'これまでのようす')}</h2>
        <p>${rubyHtml('出せた', 'だせた')}　${submittedCount}${rubyHtml('回', 'かい')}</p>
        <p>${rubyHtml('忘れた', 'わすれた')}　${forgottenAssignments.size}${rubyHtml('回', 'かい')}</p>
      </section>

      <button class="finish-btn" data-action="finishChild">${rubyHtml('終わったら ここを押す', 'おわったら ここをおす')}</button>
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
      <button class="big-btn yes" data-action="setChildStatus" data-status="${STATUS.SUBMITTED}" data-assignment="${assignmentId}">${rubyHtml('出せた', 'だせた')}</button>
      <button class="big-btn" data-action="setChildStatus" data-status="${STATUS.IN_PROGRESS}" data-assignment="${assignmentId}">${rubyHtml('途中', 'とちゅう')}</button>
      <button class="big-btn" data-action="setChildStatus" data-status="${STATUS.FORGOTTEN}" data-assignment="${assignmentId}">${rubyHtml('忘れた', 'わすれた')}</button>
      <button class="big-btn plan" data-action="openPlanSheet" data-assignment="${assignmentId}">${rubyHtml('予定日を決める', 'よていびをきめる')}</button>
      <button class="big-btn cancel" data-action="closeModal">${rubyHtml('やめる', '')}</button>
    </div>
  `);
}

function openPlanSheet(assignmentId) {
  const today = todayStr();
  renderModal(`
    <h3>${rubyHtml('いつ出す？', '')}</h3>
    <div class="sheet-buttons">
      <button class="big-btn" data-action="setPlan" data-days="1" data-assignment="${assignmentId}">${rubyHtml('明日', 'あした')}</button>
      <button class="big-btn" data-action="setPlan" data-days="2" data-assignment="${assignmentId}">${rubyHtml('明後日', 'あさって')}</button>
      <button class="big-btn" data-action="setPlan" data-days="3" data-assignment="${assignmentId}">3${rubyHtml('日後', 'にちご')}</button>
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
    <h3>${rubyHtml('直して出す？', 'なおしてだす')}</h3>
    <div class="sheet-buttons">
      <button class="big-btn yes" data-action="resubmit" data-assignment="${assignmentId}">${rubyHtml('直して出した', 'なおしてだした')}</button>
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
  let submittedTotal = 0, targetTotal = 0;
  for (const a of allAssignments) {
    if (!a.item) continue;
    for (const s of students) {
      const st = await getStatus(s.id, a.id);
      if (st.status === STATUS.REDO || st.status === STATUS.RESUBMIT_WAIT) {
        redoCount++;
        if (!redoByStudent.has(s.id)) redoByStudent.set(s.id, { student: s, items: [] });
        redoByStudent.get(s.id).items.push({ a, st });
      }
      if (st.status !== STATUS.EXEMPT) {
        targetTotal++;
        if (st.status === STATUS.SUBMITTED) submittedTotal++;
      }
    }
  }
  const overallRate = targetTotal > 0 ? Math.round((submittedTotal / targetTotal) * 100) : null;

  const unsubmittedHtml = [...unsubmittedByStudent.values()].map(({ student, items }) => `
    <li class="t-row" data-action="openStudentQuick" data-id="${student.id}">
      <span class="t-num">${student.number}番</span>
      <span class="t-name">${escapeHtml(student.name)}</span>
      <span class="t-items">${items.map(i => escapeHtml(i.a.item.name) + (i.dl ? deadlineBadge(i.a.deadline) : '')).join('・')}</span>
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
        <div class="sum-card">学級の提出率 ${overallRate === null ? '－' : overallRate + '%'}</div>
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
      <button class="mini-btn" data-action="openStudentDetail" data-id="${s.id}">詳細</button>
      <button class="mini-btn" data-action="toggleStudentActive" data-id="${s.id}">${s.active === false ? '復帰' : '停止'}</button>
      <button class="mini-btn danger" data-action="deleteStudent" data-id="${s.id}" data-name="${escapeHtml(s.name)}">削除</button>
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
        <label class="mini-btn" style="display:inline-block;cursor:pointer;">
          CSVファイルを選ぶ
          <input type="file" id="studentCsvFile" accept=".csv,text/csv" style="display:none;">
        </label>
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
  document.getElementById('studentCsvFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCsv(text).slice(1);
      let count = 0;
      for (const r of rows) {
        const number = Number(r[0]);
        const name = (r[1] || '').trim();
        const kana = (r[2] || '').trim();
        if (!name || !Number.isFinite(number)) continue;
        await DB.add('students', { number, name, kana, active: true });
        count++;
      }
      showToast(`${count}件 取り込みました`);
      renderTeacherStudents();
    } catch (err) {
      alert('CSVの読み込みに失敗しました: ' + (err && err.message ? err.message : String(err)));
    }
  });
}

async function renderTeacherItems() {
  const items = await DB.getAll('items');
  const students = await getActiveStudents();
  const assignments = await DB.getAll('assignments');
  const rowsArr = [];
  for (const i of items) {
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
    <li class="t-row">
      <span class="t-name">${escapeHtml(i.name)}${i.active === false ? '（停止中）' : ''}</span>
      <span class="t-items">${i.hasDeadline ? '期限あり　' : ''}提出率 ${rate === null ? '－' : rate + '%'}</span>
      <button class="mini-btn" data-action="toggleItemActive" data-id="${i.id}">${i.active === false ? '復帰' : '停止'}</button>
      <button class="mini-btn danger" data-action="deleteItem" data-id="${i.id}" data-name="${escapeHtml(i.name)}">削除</button>
    </li>`);
  }
  const rows = rowsArr.join('') || '<li class="empty-row">未登録</li>';

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
      <section class="card">
        <h2>CSVで一括登録</h2>
        <p style="color:#666;font-size:0.9rem;">1行目は見出し、2行目以降に「提出物名,ふりがな,期限あり(1か0)」の順で入力してください（ふりがな・期限は省略可）。</p>
        <label class="mini-btn" style="display:inline-block;cursor:pointer;">
          CSVファイルを選ぶ
          <input type="file" id="itemCsvFile" accept=".csv,text/csv" style="display:none;">
        </label>
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
  document.getElementById('itemCsvFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCsv(text).slice(1);
      let count = 0;
      for (const r of rows) {
        const name = (r[0] || '').trim();
        const kana = (r[1] || '').trim();
        const hasDeadline = (r[2] || '').trim() === '1';
        if (!name) continue;
        await DB.add('items', { name, kana, hasDeadline, subject: '', memo: '', active: true });
        count++;
      }
      showToast(`${count}件 取り込みました`);
      renderTeacherItems();
    } catch (err) {
      alert('CSVの読み込みに失敗しました: ' + (err && err.message ? err.message : String(err)));
    }
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

  const rows = [['日時', '出席番号', '氏名', '提出物', '状態', '登録者']];
  for (const h of history) {
    const s = students[h.studentId];
    const a = assignments[h.assignmentId];
    const i = a ? items[a.itemId] : null;
    rows.push([
      formatDateTimeJp(h.at),
      s ? s.number : '',
      s ? s.name : '(削除済み)',
      i ? i.name : '(削除済み)',
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

  const header = ['出席番号', '氏名', ...validAssignments.map(a => a.item.name)];
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
    <h3>${escapeHtml(item.name)} ${deadlineBadge(assignment.deadline)}</h3>
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

async function openStudentDetail(studentId) {
  const student = await DB.get('students', studentId);
  const stats = await computeStudentStats(studentId);
  const assignmentMap = Object.fromEntries((await getAllAssignmentsWithItems()).map(a => [a.id, a]));

  const rowHtml = ({ a, st }) => `
    <li class="item-row ${STATUS_META[st.status].cls}">
      <span class="item-icon">${STATUS_META[st.status].icon}</span>
      <span class="item-name">${escapeHtml(a.item.name)}</span>
      <span class="item-status">${STATUS_META[st.status].label}${a.deadline ? deadlineBadge(a.deadline) : ''}</span>
    </li>`;

  const unresolvedHtml = stats.unresolved.map(rowHtml).join('') || '<li class="empty-row">なし</li>';
  const redoHtml = stats.redo.map(rowHtml).join('') || '<li class="empty-row">なし</li>';
  const plannedHtml = stats.planned.map(({ a, st }) => `
    <li class="item-row st-mid">
      <span class="item-icon">△</span>
      <span class="item-name">${escapeHtml(a.item.name)}</span>
      <span class="item-status">${formatDateJp(st.plannedDate)}まで</span>
    </li>`).join('') || '<li class="empty-row">なし</li>';

  const historyHtml = stats.history.slice(0, 30).map(h => {
    const a = assignmentMap[h.assignmentId];
    const name = a && a.item ? a.item.name : '(削除済み)';
    return `<li class="t-row"><span class="t-items">${formatDateTimeJp(h.at)}　${escapeHtml(name)}　${STATUS_META[h.status].label}${h.actor === 'teacher' ? '（先生が変更）' : ''}</span></li>`;
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
      goto('childPage');
      return;
    case 'cancelStudent':
      goto('childSelect');
      return;
    case 'finishChild':
      goto('childSelect');
      return;
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
      showToast('予定を知らせたよ');
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
    case 'openStudentDetail':
      openStudentDetail(Number(ds.id));
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
    case 'deleteStudent': {
      if (!confirm(`${ds.name}さんを削除します。提出履歴もすべて削除され、元に戻せません。よろしいですか？`)) return;
      await deleteStudentCascade(Number(ds.id));
      showToast('削除しました');
      renderTeacherStudents();
      return;
    }
    case 'deleteItem': {
      if (!confirm(`「${ds.name}」を削除します。関連する提出履歴もすべて削除され、元に戻せません。よろしいですか？`)) return;
      await deleteItemCascade(Number(ds.id));
      showToast('削除しました');
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
