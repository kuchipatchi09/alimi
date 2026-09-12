/* ===================================================================
   시험 플래너 — app logic
   데이터는 이 브라우저에만 저장됩니다 (Claude 미리보기에서는 window.storage,
   GitHub Pages 등 실제 배포 환경에서는 localStorage를 자동으로 사용).
=================================================================== */

const STORAGE_KEY = 'exam-planner-data-v1';
const hasClaudeStorage = typeof window.storage !== 'undefined' && window.storage !== null;

// ↓↓↓ 여기 두 줄을 본인 배포 값으로 채우세요 ↓↓↓
const SYNC_URL = 'https://script.google.com/macros/s/AKfycbyPVkd25b6zpV87BSTQQtiJtPb7_W8WE62XaIXvQVvNZH0W_FveKHsqkkEkvCd8cocrxw/exec';
const SYNC_SECRET = '12345678'; 

// ↑↑↑ AppsScript.gs 상단의 SECRET 값을 그대로 여기 붙여넣으세요 ↑↑↑

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
    showToast('로컬 저장에 실패했어요. 브라우저 저장공간을 확인해주세요.');
  }
}

/* ---- 원격 동기화 (Google Apps Script) ---- */
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
    if (!json.ok) throw new Error(json.error || '동기화 오류');
    return json.data;
  } catch (e) {
    console.warn('원격 불러오기 실패:', e);
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
    if (!json.ok) throw new Error(json.error || '저장 오류');
    setSyncStatus('synced');
  } catch (e) {
    console.warn('원격 저장 실패:', e);
    setSyncStatus('offline');
    showToast('동기화에 실패했어요. 이 기기에는 저장됐어요.');
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

/* ---- 통합 인터페이스 ---- */
async function loadState() {
  return loadLocalCache();
}
async function saveState() {
  await saveLocalCache();
  if (SYNC_ENABLED) pushRemote(); 
}

/* ---------------- state ---------------- */
const SWATCHES = ['#8aa2ff', '#5fd79b', '#ffb15c', '#ff8fa3', '#7ad6ff', '#c792ea', '#ffd166', '#6bcf9f'];

let state = {
  subjects: [], 
  tasks: []     
};
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

/* ---------------- DOM refs ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const subjectListEl = $('#subjectList');
const subjectEmptyEl = $('#subjectEmpty');
const panelEmptyEl = $('#panelEmpty');
const panelContentEl = $('#panelContent');
const curDot = $('#curDot');
const curName = $('#curName');
const curDday = $('#curDday');
const curBarFill = $('#curBarFill');
const curBarText = $('#curBarText');
const taskListEl = $('#taskList');
const taskEmptyEl = $('#taskEmpty');
const toastEl = $('#toast');

/* ---------------- toast ---------------- */
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/* ---------------- computations ---------------- */
function tasksFor(subjectId) {
  return state.tasks
    .filter(t => t.subjectId === subjectId)
    .sort((a, b) => a.order - b.order);
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
  renderOverview();
  renderSidebar();
  renderPanel();
}

function renderOverview() {
  const { done, total, pct } = overallProgress();
  $('#overallPct').innerHTML = `${pct}<small>%</small>`;
  $('#statDone').textContent = done;
  $('#statTodo').textContent = total - done;
  $('#statSubjects').textContent = state.subjects.length;

  const circumference = 326.7;
  $('#ringFill').style.strokeDashoffset = String(circumference * (1 - pct / 100));

  const upcoming = state.tasks
    .filter(t => !t.done && t.dueDate)
    .map(t => ({ ...t, diff: daysBetween(t.dueDate) }))
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 6);

  const dueListEl = $('#dueList');
  dueListEl.innerHTML = '';
  $('#dueEmpty').style.display = upcoming.length ? 'none' : 'block';

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

function renderSidebar() {
  subjectListEl.innerHTML = '';
  subjectEmptyEl.style.display = state.subjects.length ? 'none' : 'block';

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
  if (!subj) {
    panelEmptyEl.hidden = false;
    panelContentEl.hidden = true;
    return;
  }
  panelEmptyEl.hidden = true;
  panelContentEl.hidden = false;

  curDot.style.background = subj.color;
  curName.textContent = subj.name;
  if (subj.examDate) {
    curDday.hidden = false;
    curDday.textContent = ddayLabel(subj.examDate) + ' · ' + subj.examDate.replaceAll('-', '.');
  } else {
    curDday.hidden = true;
  }

  const { done, total, pct } = subjectProgress(subj.id);
  curBarFill.style.width = pct + '%';
  curBarFill.style.background = subj.color;
  curBarText.textContent = `${done} / ${total} 완료`;

  renderTasks(subj);
}

function renderTasks(subj) {
  let list = tasksFor(subj.id);
  if (activeFilter === 'active') list = list.filter(t => !t.done);
  if (activeFilter === 'done') list = list.filter(t => t.done);

  taskListEl.innerHTML = '';
  taskEmptyEl.style.display = list.length ? 'none' : 'block';
  taskEmptyEl.textContent = tasksFor(subj.id).length
    ? '해당 조건의 할 일이 없어요.'
    : '이 과목에 할 일이 없어요. 위에서 추가해보세요.';

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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
    id: uid(),
    subjectId: activeSubjectId,
    title,
    type,
    dueDate: dueDate || null,
    done: false,
    order: maxOrder + 1,
    createdAt: new Date().toISOString(),
    completedAt: null
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

/* ---------------- subject modal ---------------- */
const subjectModal = $('#subjectModalBackdrop');
const subjectNameInput = $('#subjectNameInput');
const subjectExamInput = $('#subjectExamInput');
const swatchRow = $('#swatchRow');
let selectedColor = SWATCHES[0];

function buildSwatches() {
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
  $('#subjectModalTitle').textContent = subject ? '과목 수정' : '과목 추가';
  subjectNameInput.value = subject ? subject.name : '';
  subjectExamInput.value = subject ? (subject.examDate || '') : '';
  selectedColor = subject ? subject.color : SWATCHES[state.subjects.length % SWATCHES.length];
  buildSwatches();
  if(subjectModal) {
    subjectModal.hidden = false;
    setTimeout(() => subjectNameInput.focus(), 50);
  }
}

function closeSubjectModal() { 
  if(subjectModal) subjectModal.hidden = true; 
}

const addSubBtn = $('#addSubjectBtn');
if(addSubBtn) addSubBtn.addEventListener('click', () => openSubjectModal(null));

const editSubBtn = $('#editSubjectBtn');
if(editSubBtn) {
  editSubBtn.addEventListener('click', () => {
    const subj = state.subjects.find(s => s.id === activeSubjectId);
    if (subj) openSubjectModal(subj);
  });
}

const delSubBtn = $('#deleteSubjectBtn');
if(delSubBtn) {
  delSubBtn.addEventListener('click', () => {
    const subj = state.subjects.find(s => s.id === activeSubjectId);
    if (!subj) return;
    if (confirm(`'${subj.name}' 과목과 안의 할 일을 모두 삭제할까요?`)) deleteSubject(subj.id);
  });
}

const subCancelBtn = $('#subjectCancelBtn');
if(subCancelBtn) subCancelBtn.addEventListener('click', closeSubjectModal);

if(subjectModal) {
  subjectModal.addEventListener('click', (e) => { 
    if (e.target === subjectModal) closeSubjectModal(); 
  });
}

const subSaveBtn = $('#subjectSaveBtn');
if(subSaveBtn) {
  subSaveBtn.addEventListener('click', async () => {
    const name = subjectNameInput.value.trim();
    if (!name) { showToast('과목 이름을 입력해주세요.'); return; }
    await addOrUpdateSubject({ name, color: selectedColor, examDate: subjectExamInput.value });
    closeSubjectModal();
    showToast(editingSubjectId ? '과목을 수정했어요.' : '과목을 추가했어요.');
  });
}

/* ---------------- task form / filters ---------------- */
const taskForm = $('#taskForm');
if(taskForm) {
  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeSubjectId) return;
    const title = $('#taskTitle').value.trim();
    if (!title) return;
    const type = $('#taskType').value;
    const dueDate = $('#taskDue').value;
    await addTask({ title, type, dueDate });
    $('#taskTitle').value = '';
    $('#taskDue').value = '';
    $('#taskTitle').focus();
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

/* ---------------- theme ---------------- */
const THEME_KEY = 'exam-planner-theme';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const iconSun = $('#iconSun');
  const iconMoon = $('#iconMoon');
  if(iconSun) iconSun.style.display = theme === 'dark' ? 'block' : 'none';
  if(iconMoon) iconMoon.style.display = theme === 'dark' ? 'none' : 'block';
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
}

const themeToggle = $('#themeToggle');
if(themeToggle) {
  themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });
}

/* ---------------- init ---------------- */
async function init() {
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
  applyTheme(savedTheme);

  const syncIndicator = document.getElementById('syncIndicator');
  if (!SYNC_ENABLED && syncIndicator) {
    syncIndicator.title =
      'script.js 상단의 SYNC_URL / SYNC_SECRET을 설정하면 여러 기기 동기화가 켜져요.';
  }
  setSyncStatus(SYNC_ENABLED ? 'syncing' : 'local');

  // 1) 로컬 캐시로 먼저 즉시 렌더링
  const cached = await loadLocalCache();
  if (cached) {
    state.subjects = cached.subjects || [];
    state.tasks = cached.tasks || [];
    activeSubjectId = state.subjects[0]?.id || null;
    renderAll();
  }

  // 2) 원격 최신 데이터 덮어쓰기
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
