/* ===================================================================
   시험 플래너 — app logic (안전성 강화 버전)
=================================================================== */

const STORAGE_KEY = 'exam-planner-data-v1';
const hasClaudeStorage = typeof window.storage !== 'undefined' && window.storage !== null;

const SYNC_URL = 'https://script.google.com/macros/s/AKfycbyPVkd25b6zpV87BSTQQtiJtPb7_W8WE62XaIXvQVvNZH0W_FveKHsqkkEkvCd8cocrxw/exec';
const SYNC_SECRET = '12345678'; 
const POLL_INTERVAL_MS = 20000; 
const SYNC_ENABLED = !!SYNC_URL && SYNC_SECRET !== 'REPLACE_WITH_YOUR_OWN_SECRET';

/* ---- 로컬 캐시 ---- */
async function loadLocalCache() {
  try {
    if (hasClaudeStorage) {
      const res = await window.storage.get(STORAGE_KEY, false);
      return res ? JSON.parse(res.value) : null;
    } else {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }
  } catch (e) {
    return null;
  }
}

async function saveLocalCache() {
  const payload = JSON.stringify({ subjects: state.subjects, tasks: state.tasks });
  try {
    if (hasClaudeStorage) {
      await window.storage.set(STORAGE_KEY, payload, false);
    } else {
      localStorage.setItem(STORAGE_KEY, payload);
    }
  } catch (e) {
    showToast('로컬 저장에 실패했어요.');
  }
}

/* ---- 원격 동기화 ---- */
function setSyncStatus(status) {
  const dot = document.getElementById('syncDot');
  const text = document.getElementById('syncText');
  if (!dot || !text) return;
  dot.className = 'sync-dot' + (status === 'synced' ? ' synced' : status === 'offline' ? ' offline' : status === 'syncing' ? ' syncing' : '');
  const labels = { synced: '동기화됨', offline: '오프라인', syncing: '동기화 중', local: '로컬 전용' };
  text.textContent = labels[status] || '로컬 전용';
}

async function fetchRemote() {
  if (!SYNC_ENABLED) return null;
  try {
    const url = `${SYNC_URL}?secret=${encodeURIComponent(SYNC_SECRET)}`;
    const res = await fetch(url, { method: 'GET' });
    const json = await res.json();
    if (!json.ok) return null;
    return json.data;
  } catch (e) {
    return null;
  }
}

async function pushRemote() {
  if (!SYNC_ENABLED) return;
  setSyncStatus('syncing');
  try {
    const res = await fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        secret: SYNC_SECRET,
        data: { subjects: state.subjects, tasks: state.tasks }
      })
    });
    const json = await res.json();
    if (!json.ok) throw new Error();
    setSyncStatus('synced');
  } catch (e) {
    setSyncStatus('offline');
  }
}

let pollTimer = null;
function startPolling() {
  if (!SYNC_ENABLED || pollTimer) return;
  pollTimer = setInterval(async () => {
    const remote = await fetchRemote();
    if (!remote) { setSyncStatus('offline'); return; }
    const incoming = JSON.stringify({ subjects: remote.subjects || [], tasks: remote.tasks || [] });
    const current = JSON.stringify({ subjects: state.subjects, tasks: state.tasks });
    if (incoming !== current) {
      state.subjects = remote.subjects || [];
      state.tasks = remote.tasks || [];
      if (!state.subjects.find(s => s.id === activeSubjectId)) {
        activeSubjectId = state.subjects[0]?.id || null;
      }
      await saveLocalCache();
      renderAll();
    }
    setSyncStatus('synced');
  }, POLL_INTERVAL_MS);
}

async function loadState() { return loadLocalCache(); }
async function saveState() {
  await saveLocalCache();
  if (SYNC_ENABLED) pushRemote(); 
}

/* ---------------- state ---------------- */
const SWATCHES = ['#8aa2ff', '#5fd79b', '#ffb15c', '#ff8fa3', '#7ad6ff', '#c792ea', '#ffd166', '#6bcf9f'];
let state = { subjects: [], tasks: [] };
let activeSubjectId = null;
let activeFilter = 'all';
let editingSubjectId = null; 
let dragTaskId = null;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const todayStr = () => new Date().toISOString().slice(0, 10);

function daysBetween(dateStr) {
  const today = new Date(todayStr() + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

/* ---------------- DOM Helpers ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let toastTimer = null;
function showToast(msg) {
  const toastEl = $('#toast');
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ---------------- computations ---------------- */
function tasksFor(subjectId) {
  return state.tasks.filter(t => t.subjectId === subjectId).sort((a, b) => a.order - b.order);
}
function subjectProgress(subjectId) {
  const ts = tasksFor(subjectId);
  if (ts.length === 0) return { done: 0, total: 0, pct: 0 };
  const done = ts.filter(t => t.done).length;
  return { done, total: ts.length, pct: Math.round((done / ts.length) * 100) };
}
function overallProgress() {
  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}
function ddayLabel(dateStr) {
  const d = daysBetween(dateStr);
  if (d === 0) return 'D-DAY';
  if (d > 0) return `D-${d}`;
  return `D+${Math.abs(d)}`;
}

/* ---------------- rendering ---------------- */
function renderAll() {
  try {
    renderOverview();
    renderSidebar();
    renderPanel();
  } catch (e) {
    console.error("렌더링 오류:", e);
  }
}

function renderOverview() {
  const { done, total, pct } = overallProgress();
  if ($('#overallPct')) $('#overallPct').innerHTML = `${pct}<small>%</small>`;
  if ($('#statDone')) $('#statDone').textContent = done;
  if ($('#statTodo')) $('#statTodo').textContent = total - done;
  if ($('#statSubjects')) $('#statSubjects').textContent = state.subjects.length;
  
  if ($('#ringFill')) {
    const circumference = 326.7;
    $('#ringFill').style.strokeDashoffset = String(circumference * (1 - pct / 100));
  }

  const upcoming = state.tasks
    .filter(t => !t.done && t.dueDate)
    .map(t => ({ ...t, diff: daysBetween(t.dueDate) }))
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 6);

  const dueListEl = $('#dueList');
  if (dueListEl) {
    dueListEl.innerHTML = '';
    if ($('#dueEmpty')) $('#dueEmpty').style.display = upcoming.length ? 'none' : 'block';

    upcoming.forEach(t => {
      const subj = state.subjects.find(s => s.id === t.subjectId);
      if (!subj) return;
      const li = document.createElement('li');
      li.className = 'due-item';
      const whenClass = t.diff < 0 ? 'overdue' : t.diff === 0 ? 'today' : 'soon';
      const whenText = t.diff < 0 ? `${Math.abs(t.diff)}일 지남` : t.diff === 0 ? '오늘' : `${t.diff}일 남음`;
      li.innerHTML = `
        <span class="dot" style="background:${subj.color}"></span>
        <span class="name">${escapeHtml(subj.name)}</span>
        <span class="title">${escapeHtml(t.title)}</span>
        <span class="when ${whenClass}">${whenText}</span>
      `;
      dueListEl.appendChild(li);
    });
  }
}

function renderSidebar() {
  const subjectListEl = $('#subjectList');
  if (!subjectListEl) return;
  subjectListEl.innerHTML = '';
  if ($('#subjectEmpty')) $('#subjectEmpty').style.display = state.subjects.length ? 'none' : 'block';

  state.subjects.forEach(subj => {
    const { done, total, pct } = subjectProgress(subj.id);
    const li = document.createElement('li');
    li.className = 'subject-item' + (subj.id === activeSubjectId ? ' active' : '');
    li.dataset.id = subj.id;

    let ddayHtml = '';
    if (subj.examDate) {
      ddayHtml = `<span class="subject-dday">${ddayLabel(subj.examDate)}</span>`;
    }

    li.innerHTML = `
      <div class="subject-row">
        <span class="subject-dot" style="background:${subj.color}"></span>
        <span class="subject-name">${escapeHtml(subj.name)}</span>
        ${ddayHtml}
      </div>
      <div class="subject-mini-bar"><div class="subject-mini-fill" style="width:${pct}%;background:${subj.color}"></div></div>
      <span class="subject-pct">${done}/${total} · ${pct}%</span>
    `;
    li.addEventListener('click', () => {
      activeSubjectId = subj.id;
      activeFilter = 'all';
      renderAll();
    });
    subjectListEl.appendChild(li);
  });
}

function renderPanel() {
  const subj = state.subjects.find(s => s.id === activeSubjectId);
  const panelEmptyEl = $('#panelEmpty');
  const panelContentEl = $('#panelContent');
  
  if (!subj) {
    if (panelEmptyEl) panelEmptyEl.hidden = false;
    if (panelContentEl) panelContentEl.hidden = true;
    return;
  }
  
  if (panelEmptyEl) panelEmptyEl.hidden = true;
  if (panelContentEl) panelContentEl.hidden = false;

  if ($('#curDot')) $('#curDot').style.background = subj.color;
  if ($('#curName')) $('#curName').textContent = subj.name;
  
  const curDday = $('#curDday');
  if (curDday) {
    if (subj.examDate) {
      curDday.hidden = false;
      curDday.textContent = ddayLabel(subj.examDate) + ' · ' + subj.examDate.replaceAll('-', '.');
    } else {
      curDday.hidden = true;
    }
  }

  const { done, total, pct } = subjectProgress(subj.id);
  if ($('#curBarFill')) {
    $('#curBarFill').style.width = pct + '%';
    $('#curBarFill').style.background = subj.color;
  }
  if ($('#curBarText')) $('#curBarText').textContent = `${done} / ${total} 완료`;

  renderTasks(subj);
}

function renderTasks(subj) {
  const taskListEl = $('#taskList');
  if (!taskListEl) return;

  let list = tasksFor(subj.id);
  if (activeFilter === 'active') list = list.filter(t => !t.done);
  if (activeFilter === 'done') list = list.filter(t => t.done);

  taskListEl.innerHTML = '';
  if ($('#taskEmpty')) {
    $('#taskEmpty').style.display = list.length ? 'none' : 'block';
    $('#taskEmpty').textContent = tasksFor(subj.id).length
      ? '해당 조건의 할 일이 없어요.'
      : '이 과목에 할 일이 없어요. 위에서 추가해보세요.';
  }

  const typeLabel = { study: '공부', assignment: '수행평가', etc: '기타' };

  list.forEach(t => {
    const li = document.createElement('li');
    li.className = 'task-item' + (t.done ? ' done' : '');
    li.draggable = true;
    li.dataset.id = t.id;

    let dueHtml = '';
    if (t.dueDate) {
      const diff = daysBetween(t.dueDate);
      let cls = '';
      let text = t.dueDate.replaceAll('-', '.');
      if (!t.done) {
        if (diff < 0) { cls = 'overdue'; text += ` (${Math.abs(diff)}일 지남)`; }
        else if (diff === 0) { cls = 'today'; text += ' (오늘)'; }
      }
      dueHtml = `<span class="task-due ${cls}">${text}</span>`;
    }

    li.innerHTML = `
      <button class="task-check" aria-label="완료 표시">
        <svg viewBox="0 0 24 24" width="12" height="12"><path d="M4 12.5l5 5L20 6" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="task-main">
        <span class="task-title">${escapeHtml(t.title)}</span>
        <div class="task-meta">
          <span class="task-type ${t.type}">${typeLabel[t.type] || '기타'}</span>
          ${dueHtml}
        </div>
      </div>
      <button class="task-del" aria-label="삭제">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    `;

    li.querySelector('.task-check').addEventListener('click', () => toggleTask(t.id));
    li.querySelector('.task-del').addEventListener('click', () => deleteTask(t.id));

    li.addEventListener('dragstart', () => { dragTaskId = t.id; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { li.classList.remove('dragging'); dragTaskId = null; });
    li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (dragTaskId && dragTaskId !== t.id) reorderTask(dragTaskId, t.id);
    });

    taskListEl.appendChild(li);
  });
}

/* ---------------- mutations ---------------- */
async function toggleTask(id) {
  const t = state.tasks.find(t => t.id === id);
  if (!t) return;
  t.done = !t.done;
  t.completedAt = t.done ? new Date().toISOString() : null;
  await saveState();
  renderAll();
}

async function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  await saveState();
  renderAll();
}

async function addTask({ title, type, dueDate }) {
  const siblings = tasksFor(activeSubjectId);
  const maxOrder = siblings.length ? Math.max(...siblings.map(t => t.order)) : -1;
  state.tasks.push({
    id: uid(), subjectId: activeSubjectId, title, type,
    dueDate: dueDate || null, done: false, order: maxOrder + 1,
    createdAt: new Date().toISOString(), completedAt: null
  });
  await saveState();
  renderAll();
}

async function reorderTask(draggedId, targetId) {
  const list = tasksFor(activeSubjectId);
  const fromIdx = list.findIndex(t => t.id === draggedId);
  const toIdx = list.findIndex(t => t.id === targetId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = list.splice(fromIdx, 1);
  list.splice(toIdx, 0, moved);
  list.forEach((t, i) => { t.order = i; });
  await saveState();
  renderAll();
}

async function addOrUpdateSubject({ name, color, examDate }) {
  if (editingSubjectId) {
    const s = state.subjects.find(s => s.id === editingSubjectId);
    if (s) { s.name = name; s.color = color; s.examDate = examDate || null; }
  } else {
    const s = { id: uid(), name, color, examDate: examDate || null, createdAt: new Date().toISOString() };
    state.subjects.push(s);
    activeSubjectId = s.id;
  }
  await saveState();
  renderAll();
}

async function deleteSubject(id) {
  state.subjects = state.subjects.filter(s => s.id !== id);
  state.tasks = state.tasks.filter(t => t.subjectId !== id);
  if (activeSubjectId === id) activeSubjectId = state.subjects[0]?.id || null;
  await saveState();
  renderAll();
}

/* ---------------- 과목 추가 모달 (핵심 수정 부분) ---------------- */
let selectedColor = SWATCHES[0];

function buildSwatches() {
  const swatchRow = $('#swatchRow');
  if (!swatchRow) return;
  swatchRow.innerHTML = '';
  SWATCHES.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (c === selectedColor ? ' selected' : '');
    sw.style.background = c;
    sw.addEventListener('click', () => {
      selectedColor = c;
      $$('.swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
    swatchRow.appendChild(sw);
  });
}

function openSubjectModal(subject) {
  editingSubjectId = subject ? subject.id : null;
  if ($('#subjectModalTitle')) $('#subjectModalTitle').textContent = subject ? '과목 수정' : '과목 추가';
  if ($('#subjectNameInput')) $('#subjectNameInput').value = subject ? subject.name : '';
  if ($('#subjectExamInput')) $('#subjectExamInput').value = subject ? (subject.examDate || '') : '';
  
  selectedColor = subject ? subject.color : SWATCHES[state.subjects.length % SWATCHES.length];
  buildSwatches();
  
  const modal = document.getElementById('subjectModalBackdrop');
  if (modal) {
    modal.hidden = false;
    setTimeout(() => { if ($('#subjectNameInput')) $('#subjectNameInput').focus(); }, 50);
  }
}

// 📌 확실하게 창을 닫아주는 함수
function closeSubjectModal() { 
  const modal = document.getElementById('subjectModalBackdrop');
  if (modal) modal.hidden = true; 
}

// 이벤트를 안전하게 연결하는 함수
function safeAddListener(id, eventType, callback) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(eventType, callback);
}

// 창 열기 이벤트
safeAddListener('addSubjectBtn', 'click', () => openSubjectModal(null));
safeAddListener('editSubjectBtn', 'click', () => {
  const subj = state.subjects.find(s => s.id === activeSubjectId);
  if (subj) openSubjectModal(subj);
});
safeAddListener('deleteSubjectBtn', 'click', () => {
  const subj = state.subjects.find(s => s.id === activeSubjectId);
  if (!subj) return;
  if (confirm(`'${subj.name}' 과목과 안의 할 일을 모두 삭제할까요?`)) deleteSubject(subj.id);
});

// 📌 창 닫기 이벤트 (취소 버튼 & 배경 클릭)
safeAddListener('subjectCancelBtn', 'click', closeSubjectModal);

const modalBg = document.getElementById('subjectModalBackdrop');
if (modalBg) {
  modalBg.addEventListener('click', (e) => { 
    if (e.target === modalBg) closeSubjectModal(); 
  });
}

// 📌 저장 버튼 처리 (무조건 창부터 닫도록 변경)
safeAddListener('subjectSaveBtn', 'click', async () => {
  const nameInput = document.getElementById('subjectNameInput');
  const examInput = document.getElementById('subjectExamInput');
  if (!nameInput) return;
  
  const name = nameInput.value.trim();
  if (!name) { showToast('과목 이름을 입력해주세요.'); return; }
  
  // 1. 데이터 처리 중 멈춰도 창은 닫히게끔 가장 먼저 닫기 실행!
  closeSubjectModal();
  
  // 2. 이후에 과목 저장 및 화면 새로고침
  await addOrUpdateSubject({ name, color: selectedColor, examDate: examInput ? examInput.value : '' });
  showToast(editingSubjectId ? '과목을 수정했어요.' : '과목을 추가했어요.');
});

/* ---------------- 할 일(Task) / 필터 이벤트 ---------------- */
const taskForm = document.getElementById('taskForm');
if (taskForm) {
  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeSubjectId) return;
    const titleInput = document.getElementById('taskTitle');
    const title = titleInput ? titleInput.value.trim() : '';
    if (!title) return;
    
    const type = $('#taskType') ? $('#taskType').value : 'etc';
    const dueDate = $('#taskDue') ? $('#taskDue').value : '';
    
    await addTask({ title, type, dueDate });
    
    if (titleInput) titleInput.value = '';
    if ($('#taskDue')) $('#taskDue').value = '';
    if (titleInput) titleInput.focus();
  });
}

$$('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeFilter = btn.dataset.filter;
    $$('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const subj = state.subjects.find(s => s.id === activeSubjectId);
    if (subj) renderTasks(subj);
  });
});

/* ---------------- 테마(다크/라이트) ---------------- */
const THEME_KEY = 'exam-planner-theme';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const iconSun = $('#iconSun');
  const iconMoon = $('#iconMoon');
  if (iconSun) iconSun.style.display = theme === 'dark' ? 'block' : 'none';
  if (iconMoon) iconMoon.style.display = theme === 'dark' ? 'none' : 'block';
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
}

safeAddListener('themeToggle', 'click', () => {
  const cur = document.documentElement.dataset.theme;
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

/* ---------------- 초기 실행 ---------------- */
async function init() {
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
  applyTheme(savedTheme);

  setSyncStatus(SYNC_ENABLED ? 'syncing' : 'local');

  const cached = await loadLocalCache();
  if (cached) {
    state.subjects = cached.subjects || [];
    state.tasks = cached.tasks || [];
    activeSubjectId = state.subjects[0]?.id || null;
    renderAll();
  }

  if (SYNC_ENABLED) {
    const remote = await fetchRemote();
    if (remote) {
      state.subjects = remote.subjects || [];
      state.tasks = remote.tasks || [];
      if (!state.subjects.find(s => s.id === activeSubjectId)) {
        activeSubjectId = state.subjects[0]?.id || null;
      }
      await saveLocalCache();
      renderAll();
      setSyncStatus('synced');
    } else {
      setSyncStatus('offline');
    }
    startPolling();
  } else if (!cached) {
    renderAll();
  }
}
init();
