'use strict';

(() => {
  const CATALOG = window.JOSLER_CATALOG || [];
  const TOTAL_REQUIREMENTS = { cases: 120, groups: 56, summaries: 29, surgery: 2, autopsy: 1 };
  const DB_NAME = 'josler-case-manager';
  const DB_VERSION = 1;
  const MIRROR_KEY = 'josler-case-manager-mirror-v1';
  const APP_FORMAT = 'josler-case-manager-backup';
  const ENCRYPTED_FORMAT = 'josler-case-manager-encrypted-backup';
  const STATUS_LABELS = { id: 'ID入力済み', registered: '症例登録完了', summary: '病歴要約完了' };

  const specialtyById = new Map();
  const groupById = new Map();
  const diseaseById = new Map();
  CATALOG.forEach(specialty => {
    specialtyById.set(specialty.id, specialty);
    specialty.groups.forEach(group => {
      groupById.set(group.id, { ...group, specialtyId: specialty.id });
      group.diseases.forEach(disease => {
        diseaseById.set(disease.id, { ...disease, groupId: group.id, specialtyId: specialty.id });
      });
    });
  });

  const $ = id => document.getElementById(id);
  const refs = {
    saveStatus: $('saveStatus'), installButton: $('installButton'), backupAlert: $('backupAlert'),
    overallMetrics: $('overallMetrics'), specialtySummary: $('specialtySummary'),
    openAddButton: $('openAddButton'), maskToggle: $('maskToggle'), dataMenuButton: $('dataMenuButton'),
    dataMenu: $('dataMenu'), exportEncryptedButton: $('exportEncryptedButton'), exportPlainButton: $('exportPlainButton'),
    exportCsvButton: $('exportCsvButton'), importInput: $('importInput'), resetButton: $('resetButton'),
    searchInput: $('searchInput'), specialtyFilter: $('specialtyFilter'), statusFilter: $('statusFilter'),
    catalogContainer: $('catalogContainer'), emptyState: $('emptyState'), caseDialog: $('caseDialog'),
    caseForm: $('caseForm'), dialogTitle: $('dialogTitle'), closeDialogButton: $('closeDialogButton'),
    cancelButton: $('cancelButton'), recordId: $('recordId'), caseSpecialty: $('caseSpecialty'),
    caseGroup: $('caseGroup'), caseDisease: $('caseDisease'), hospitalId: $('hospitalId'),
    caseDate: $('caseDate'), surgeryReferral: $('surgeryReferral'), autopsy: $('autopsy'),
    caseNote: $('caseNote'), formError: $('formError'), deleteCaseButton: $('deleteCaseButton'),
    caseColorPreview: $('caseColorPreview'), previewLabel: $('previewLabel'),
    passwordDialog: $('passwordDialog'), passwordForm: $('passwordForm'), passwordTitle: $('passwordTitle'),
    passwordDescription: $('passwordDescription'), backupPassword: $('backupPassword'),
    backupPasswordConfirm: $('backupPasswordConfirm'), passwordConfirmRow: $('passwordConfirmRow'),
    passwordError: $('passwordError'), passwordCancel: $('passwordCancel')
  };

  let dbPromise;
  let deferredInstallPrompt = null;
  let passwordResolver = null;
  let state = createEmptyState();
  let saveSequence = Promise.resolve();
  let resolveAppReady;
  const appReady = new Promise(resolve => { resolveAppReady = resolve; });

  function createEmptyState() {
    const now = new Date().toISOString();
    return {
      version: 1,
      cases: [],
      settings: { maskIds: true },
      meta: { createdAt: now, updatedAt: now, lastBackupAt: null, lastSnapshotDate: null }
    };
  }

  function normalizeState(value) {
    if (!value || typeof value !== 'object') return createEmptyState();
    const base = createEmptyState();
    const cases = Array.isArray(value.cases) ? value.cases.filter(isValidCase).map(item => ({
      id: String(item.id || randomId()),
      hospitalId: String(item.hospitalId || '').trim(),
      specialtyId: String(item.specialtyId),
      groupId: String(item.groupId),
      diseaseId: String(item.diseaseId),
      status: ['id', 'registered', 'summary'].includes(item.status) ? item.status : 'id',
      date: typeof item.date === 'string' ? item.date : '',
      note: typeof item.note === 'string' ? item.note.slice(0, 500) : '',
      surgeryReferral: Boolean(item.surgeryReferral),
      autopsy: Boolean(item.autopsy),
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || new Date().toISOString()
    })) : [];
    return {
      version: 1,
      cases,
      settings: { maskIds: value.settings?.maskIds !== false },
      meta: {
        createdAt: value.meta?.createdAt || base.meta.createdAt,
        updatedAt: value.meta?.updatedAt || base.meta.updatedAt,
        lastBackupAt: value.meta?.lastBackupAt || null,
        lastSnapshotDate: value.meta?.lastSnapshotDate || null
      }
    };
  }

  function isValidCase(item) {
    return item && typeof item === 'object' && item.hospitalId && specialtyById.has(String(item.specialtyId)) &&
      groupById.has(String(item.groupId)) && diseaseById.has(String(item.diseaseId));
  }

  function randomId() {
    return globalThis.crypto?.randomUUID?.() || `case-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB is unavailable'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function idbGet(storeName, key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result?.value ?? request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbPut(storeName, object) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(object);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDeleteOldSnapshots() {
    try {
      const db = await openDatabase();
      const snapshots = await new Promise((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readonly');
        const request = tx.objectStore('snapshots').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      const extra = snapshots.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(10);
      if (!extra.length) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readwrite');
        extra.forEach(item => tx.objectStore('snapshots').delete(item.id));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.warn('Snapshot cleanup failed', error);
    }
  }

  async function loadState() {
    let idbState = null;
    let mirrorState = null;
    try { idbState = await idbGet('kv', 'main'); } catch (error) { console.warn(error); }
    try { mirrorState = JSON.parse(localStorage.getItem(MIRROR_KEY) || 'null'); } catch (error) { console.warn(error); }
    const candidates = [idbState, mirrorState].filter(Boolean).map(normalizeState);
    if (!candidates.length) return createEmptyState();
    return candidates.sort((a, b) => String(b.meta.updatedAt).localeCompare(String(a.meta.updatedAt)))[0];
  }

  function queueSave({ snapshot = true, cloud = true } = {}) {
    const payload = JSON.parse(JSON.stringify(state));
    refs.saveStatus.textContent = '端末：保存中…';
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify(payload)); } catch (error) { console.warn(error); }
    saveSequence = saveSequence.then(async () => {
      try {
        await idbPut('kv', { key: 'main', value: payload });
        refs.saveStatus.textContent = `端末：保存済み ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
        if (snapshot) await maybeCreateDailySnapshot(payload);
        if (cloud) {
          window.dispatchEvent(new CustomEvent('josler-local-state-changed', {
            detail: { updatedAt: payload.meta.updatedAt }
          }));
        }
      } catch (error) {
        refs.saveStatus.textContent = '端末：保存エラー';
        console.error(error);
      }
    });
    return saveSequence;
  }

  async function maybeCreateDailySnapshot(payload) {
    const today = localDateString(new Date());
    if (payload.meta.lastSnapshotDate === today) return;
    payload.meta.lastSnapshotDate = today;
    state.meta.lastSnapshotDate = today;
    try {
      localStorage.setItem(MIRROR_KEY, JSON.stringify(state));
      await idbPut('snapshots', { id: `daily-${today}`, createdAt: new Date().toISOString(), reason: 'daily', value: payload });
      await idbPut('kv', { key: 'main', value: JSON.parse(JSON.stringify(state)) });
      await idbDeleteOldSnapshots();
    } catch (error) {
      console.warn('Daily snapshot failed', error);
    }
  }

  async function createSafetySnapshot(reason) {
    try {
      await idbPut('snapshots', {
        id: `${reason}-${Date.now()}`,
        createdAt: new Date().toISOString(),
        reason,
        value: JSON.parse(JSON.stringify(state))
      });
      await idbDeleteOldSnapshots();
    } catch (error) {
      console.warn('Safety snapshot failed', error);
    }
  }

  function touchState() { state.meta.updatedAt = new Date().toISOString(); }

  function computeStats() {
    const specialty = new Map(CATALOG.map(item => [item.id, { candidates: 0, registered: 0, summaries: 0, groups: new Set() }]));
    const overallGroups = new Set();
    let candidates = 0, registered = 0, summaries = 0, surgery = 0, autopsy = 0;
    state.cases.forEach(item => {
      const bucket = specialty.get(item.specialtyId);
      if (!bucket) return;
      if (item.status === 'id') {
        candidates += 1;
        bucket.candidates += 1;
        return;
      }
      registered += 1;
      bucket.registered += 1;
      overallGroups.add(item.groupId);
      bucket.groups.add(item.groupId);
      if (item.status === 'summary') {
        summaries += 1;
        bucket.summaries += 1;
      }
      if (item.surgeryReferral) surgery += 1;
      if (item.autopsy) autopsy += 1;
    });
    return { candidates, registered, summaries, groups: overallGroups.size, surgery, autopsy, specialty };
  }

  function renderAll() {
    renderDashboard();
    renderCatalog();
    renderBackupAlert();
    refs.maskToggle.textContent = state.settings.maskIds ? 'IDを表示' : 'IDを隠す';
  }

  function renderDashboard() {
    const stats = computeStats();
    refs.overallMetrics.innerHTML = '';
    const metrics = [
      { label: '症例登録', value: stats.registered, goal: TOTAL_REQUIREMENTS.cases, caption: `候補 ${stats.candidates}件は未加算` },
      { label: '疾患群', value: stats.groups, goal: TOTAL_REQUIREMENTS.groups, caption: '登録完了症例がある疾患群' },
      { label: '病歴要約', value: stats.summaries, goal: TOTAL_REQUIREMENTS.summaries, caption: '病歴要約完了の症例' },
      { label: '外科紹介', value: stats.surgery, goal: TOTAL_REQUIREMENTS.surgery, caption: '登録完了以上のみ集計' },
      { label: '剖検', value: stats.autopsy, goal: TOTAL_REQUIREMENTS.autopsy, caption: '登録完了以上のみ集計' }
    ];
    metrics.forEach(metric => {
      const node = $('metricTemplate').content.firstElementChild.cloneNode(true);
      node.querySelector('.metric-label').textContent = metric.label;
      node.querySelector('.metric-value').textContent = `${metric.value} / ${metric.goal}`;
      node.querySelector('.progress-track span').style.width = `${Math.min(100, metric.value / metric.goal * 100)}%`;
      node.querySelector('.metric-caption').textContent = metric.caption;
      refs.overallMetrics.appendChild(node);
    });

    refs.specialtySummary.innerHTML = CATALOG.map(item => {
      const bucket = stats.specialty.get(item.id);
      const req = item.requirements;
      const caseMet = bucket.registered >= req.cases;
      const groupMet = bucket.groups.size >= req.groups;
      const summaryMet = bucket.summaries >= req.summaries;
      return `<article class="specialty-progress">
        <h3>${escapeHtml(item.name)}</h3>
        <p class="${caseMet ? 'requirement-met' : ''}">症例 <strong>${bucket.registered} / ${req.cases}</strong></p>
        <p class="${groupMet ? 'requirement-met' : ''}">疾患群 <strong>${bucket.groups.size} / ${req.groups}</strong></p>
        <p class="${summaryMet ? 'requirement-met' : ''}">病歴要約 <strong>${bucket.summaries} / ${req.summaries}</strong></p>
      </article>`;
    }).join('');
  }

  function renderBackupAlert() {
    if (!state.cases.length) {
      refs.backupAlert.hidden = true;
      return;
    }
    const last = state.meta.lastBackupAt ? new Date(state.meta.lastBackupAt) : null;
    const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : Infinity;
    if (days < 7) {
      refs.backupAlert.hidden = true;
      return;
    }
    refs.backupAlert.hidden = false;
    refs.backupAlert.textContent = last
      ? `最終バックアップから${days}日経過しています。端末故障に備え、暗号化バックアップを保存してください。`
      : 'バックアップがまだ作成されていません。症例データ消失に備え、暗号化バックアップを保存してください。';
  }

  function renderCatalog() {
    const openKeys = new Set([...refs.catalogContainer.querySelectorAll('details[open]')].map(node => node.dataset.key));
    const query = normalizeSearch(refs.searchInput.value);
    const specialtyFilter = refs.specialtyFilter.value;
    const statusFilter = refs.statusFilter.value;
    const hasActiveFilter = Boolean(query) || specialtyFilter !== 'all' || statusFilter !== 'all';
    const statsByGroup = new Map();
    state.cases.forEach(item => {
      const bucket = statsByGroup.get(item.groupId) || { id: 0, registered: 0, summary: 0 };
      bucket[item.status] += 1;
      statsByGroup.set(item.groupId, bucket);
    });

    const html = [];
    CATALOG.forEach((specialty, specialtyIndex) => {
      if (specialtyFilter !== 'all' && specialty.id !== specialtyFilter) return;
      const groupHtml = [];
      specialty.groups.forEach(group => {
        const diseaseHtml = [];
        group.diseases.forEach(disease => {
          const allCases = state.cases.filter(item => item.diseaseId === disease.id);
          let visibleCases = allCases.filter(item => statusFilter === 'all' || item.status === statusFilter);
          const staticText = normalizeSearch(`${specialty.name} ${group.title} ${disease.name}`);
          if (query) {
            if (!staticText.includes(query)) {
              visibleCases = visibleCases.filter(item => normalizeSearch(`${item.hospitalId} ${item.note}`).includes(query));
              if (!visibleCases.length) return;
            }
          } else if (statusFilter !== 'all' && !visibleCases.length) {
            return;
          }
          const cards = visibleCases.map(renderCaseCard).join('');
          diseaseHtml.push(`<div class="disease-row">
            <div class="disease-head">
              <p class="disease-name">${escapeHtml(disease.name)}</p>
              <button class="small-button" type="button" data-add-case="${disease.id}">＋ 症例</button>
            </div>
            ${cards ? `<div class="case-list">${cards}</div>` : ''}
          </div>`);
        });
        if (!diseaseHtml.length) return;
        const counts = statsByGroup.get(group.id) || { id: 0, registered: 0, summary: 0 };
        groupHtml.push(`<details class="group-block" data-key="${group.id}" ${hasActiveFilter || openKeys.has(group.id) ? 'open' : ''}>
          <summary>
            <div class="summary-main"><span>${escapeHtml(group.title)}</span><small>${group.diseases.length}項目</small></div>
            <div class="summary-badges">
              ${counts.id ? `<span class="badge candidate">${counts.id}</span>` : ''}
              ${counts.registered ? `<span class="badge registered">${counts.registered}</span>` : ''}
              ${counts.summary ? `<span class="badge summary">${counts.summary}</span>` : ''}
            </div>
          </summary>
          <div class="disease-list">${diseaseHtml.join('')}</div>
        </details>`);
      });
      if (!groupHtml.length) return;
      const specialtyCases = state.cases.filter(item => item.specialtyId === specialty.id);
      const counts = { id: 0, registered: 0, summary: 0 };
      specialtyCases.forEach(item => counts[item.status] += 1);
      const shouldOpen = hasActiveFilter || openKeys.has(specialty.id) || (!openKeys.size && specialtyIndex === 0);
      html.push(`<details class="specialty-block" data-key="${specialty.id}" ${shouldOpen ? 'open' : ''}>
        <summary>
          <div class="summary-main"><span>${escapeHtml(specialty.name)}</span><small>疾患群 ${specialty.groups.length} ／ 必要 ${specialty.requirements.groups}</small></div>
          <div class="summary-badges">
            ${counts.id ? `<span class="badge candidate">${counts.id}</span>` : ''}
            ${counts.registered ? `<span class="badge registered">${counts.registered}</span>` : ''}
            ${counts.summary ? `<span class="badge summary">${counts.summary}</span>` : ''}
          </div>
        </summary>
        ${groupHtml.join('')}
      </details>`);
    });
    refs.catalogContainer.innerHTML = html.join('');
    refs.emptyState.hidden = Boolean(html.length);
  }

  function renderCaseCard(item) {
    const flags = [item.surgeryReferral ? '外科' : '', item.autopsy ? '剖検' : ''].filter(Boolean);
    const maskedId = state.settings.maskIds ? maskId(item.hospitalId) : item.hospitalId;
    return `<button type="button" class="case-card status-${item.status}" data-edit-case="${item.id}">
      <span class="case-id">${escapeHtml(maskedId)}</span>
      <span class="case-flags">${flags.map(flag => `<span class="case-flag">${flag}</span>`).join('')}</span>
      <span class="case-meta">${STATUS_LABELS[item.status]}${item.date ? `・${escapeHtml(item.date)}` : ''}</span>
    </button>`;
  }

  function populateStaticSelects() {
    refs.specialtyFilter.insertAdjacentHTML('beforeend', CATALOG.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join(''));
    refs.caseSpecialty.innerHTML = CATALOG.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
    populateGroupSelect(CATALOG[0]?.id);
  }

  function populateGroupSelect(specialtyId, selectedGroupId = '') {
    const specialty = specialtyById.get(specialtyId) || CATALOG[0];
    refs.caseGroup.innerHTML = specialty.groups.map(group => `<option value="${group.id}">${escapeHtml(group.title)}</option>`).join('');
    if (selectedGroupId && specialty.groups.some(group => group.id === selectedGroupId)) refs.caseGroup.value = selectedGroupId;
    populateDiseaseSelect(refs.caseGroup.value);
  }

  function populateDiseaseSelect(groupId, selectedDiseaseId = '') {
    const group = groupById.get(groupId);
    refs.caseDisease.innerHTML = (group?.diseases || []).map(disease => `<option value="${disease.id}">${escapeHtml(disease.name)}</option>`).join('');
    if (selectedDiseaseId && group?.diseases.some(disease => disease.id === selectedDiseaseId)) refs.caseDisease.value = selectedDiseaseId;
  }

  function openCaseDialog({ record = null, diseaseId = '' } = {}) {
    refs.caseForm.reset();
    refs.formError.textContent = '';
    refs.recordId.value = record?.id || '';
    refs.dialogTitle.textContent = record ? '症例を編集' : '症例を追加';
    refs.deleteCaseButton.hidden = !record;
    const selectedDisease = diseaseId ? diseaseById.get(diseaseId) : null;
    const specialtyId = record?.specialtyId || selectedDisease?.specialtyId || CATALOG[0]?.id;
    const groupId = record?.groupId || selectedDisease?.groupId || specialtyById.get(specialtyId)?.groups[0]?.id;
    const finalDiseaseId = record?.diseaseId || selectedDisease?.id || groupById.get(groupId)?.diseases[0]?.id;
    refs.caseSpecialty.value = specialtyId;
    populateGroupSelect(specialtyId, groupId);
    populateDiseaseSelect(groupId, finalDiseaseId);
    refs.hospitalId.value = record?.hospitalId || '';
    refs.caseDate.value = record?.date || localDateString(new Date());
    refs.caseNote.value = record?.note || '';
    refs.surgeryReferral.checked = Boolean(record?.surgeryReferral);
    refs.autopsy.checked = Boolean(record?.autopsy);
    const status = record?.status || 'id';
    const radio = refs.caseForm.querySelector(`input[name="caseStatus"][value="${status}"]`);
    if (radio) radio.checked = true;
    updateCasePreview();
    refs.caseDialog.showModal();
    setTimeout(() => refs.hospitalId.focus(), 50);
  }

  function closeCaseDialog() { if (refs.caseDialog.open) refs.caseDialog.close(); }

  function updateCasePreview() {
    const hasId = Boolean(refs.hospitalId.value.trim());
    const status = refs.caseForm.querySelector('input[name="caseStatus"]:checked')?.value || 'id';
    const previewStatus = hasId ? status : 'empty';
    refs.caseColorPreview.className = `case-preview status-${previewStatus}`;
    refs.previewLabel.textContent = hasId ? STATUS_LABELS[status] : '未入力';
  }

  async function saveCaseFromForm(event) {
    event.preventDefault();
    refs.formError.textContent = '';
    const hospitalId = refs.hospitalId.value.trim();
    const specialtyId = refs.caseSpecialty.value;
    const groupId = refs.caseGroup.value;
    const diseaseId = refs.caseDisease.value;
    if (!hospitalId || !specialtyById.has(specialtyId) || !groupById.has(groupId) || !diseaseById.has(diseaseId)) {
      refs.formError.textContent = '症例ID・分野・疾患を確認してください。';
      return;
    }
    const recordId = refs.recordId.value;
    const duplicates = state.cases.filter(item => item.id !== recordId && normalizeId(item.hospitalId) === normalizeId(hospitalId));
    if (duplicates.length && !window.confirm(`同じ症例IDが${duplicates.length}件あります。重複登録の可能性がありますが、保存しますか？`)) return;
    const now = new Date().toISOString();
    const previous = state.cases.find(item => item.id === recordId);
    const next = {
      id: recordId || randomId(), hospitalId, specialtyId, groupId, diseaseId,
      status: refs.caseForm.querySelector('input[name="caseStatus"]:checked')?.value || 'id',
      date: refs.caseDate.value || '', note: refs.caseNote.value.trim(),
      surgeryReferral: refs.surgeryReferral.checked, autopsy: refs.autopsy.checked,
      createdAt: previous?.createdAt || now, updatedAt: now
    };
    if (previous) state.cases = state.cases.map(item => item.id === previous.id ? next : item);
    else state.cases.push(next);
    touchState();
    closeCaseDialog();
    renderAll();
    await queueSave();
  }

  async function deleteCurrentCase() {
    const id = refs.recordId.value;
    const record = state.cases.find(item => item.id === id);
    if (!record) return;
    if (!window.confirm(`症例ID「${record.hospitalId}」を削除しますか？`)) return;
    await createSafetySnapshot('before-delete');
    state.cases = state.cases.filter(item => item.id !== id);
    touchState();
    closeCaseDialog();
    renderAll();
    await queueSave({ snapshot: false });
  }

  function maskId(value) {
    const chars = [...String(value)];
    if (chars.length <= 3) return '●'.repeat(chars.length);
    return `${'●'.repeat(Math.min(8, chars.length - 3))}${chars.slice(-3).join('')}`;
  }

  function normalizeId(value) { return String(value).trim().toLocaleLowerCase('ja-JP').replace(/\s+/g, ''); }
  function normalizeSearch(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/g, ' ').trim(); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
  function localDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function downloadBlob(content, filename, type = 'application/json') {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function buildBackupPayload() {
    return { format: APP_FORMAT, version: 1, exportedAt: new Date().toISOString(), sourceWorkbook: '20250504改訂版', state: JSON.parse(JSON.stringify(state)) };
  }

  async function exportPlainBackup() {
    if (!window.confirm('通常バックアップには症例IDが平文で含まれます。安全な保存先へ保存しますか？')) return;
    const payload = buildBackupPayload();
    downloadBlob(JSON.stringify(payload, null, 2), `JOSLER_backup_${fileTimestamp()}.json`);
    state.meta.lastBackupAt = new Date().toISOString();
    touchState();
    renderBackupAlert();
    await queueSave({ snapshot: false });
  }

  async function exportEncryptedBackup() {
    if (!globalThis.crypto?.subtle) {
      alert('このブラウザでは暗号化機能を利用できません。通常バックアップを使用してください。');
      return;
    }
    const password = await requestPassword({ confirm: true, title: '暗号化バックアップ', description: '8文字以上のパスワードを設定してください。忘れると復元できません。' });
    if (!password) return;
    try {
      const encrypted = await encryptObject(buildBackupPayload(), password);
      downloadBlob(JSON.stringify(encrypted, null, 2), `JOSLER_backup_${fileTimestamp()}.josler`);
      state.meta.lastBackupAt = new Date().toISOString();
      touchState();
      renderBackupAlert();
      await queueSave({ snapshot: false });
    } catch (error) {
      console.error(error);
      alert('暗号化バックアップを作成できませんでした。');
    }
  }

  function exportCsv() {
    const rows = [['症例ID', '状態', '経験日', '分野', '疾患群', '疾患', '外科紹介', '剖検', 'メモ', '更新日時']];
    state.cases.forEach(item => {
      const specialty = specialtyById.get(item.specialtyId);
      const group = groupById.get(item.groupId);
      const disease = diseaseById.get(item.diseaseId);
      rows.push([item.hospitalId, STATUS_LABELS[item.status], item.date, specialty?.name || '', group?.title || '', disease?.name || '', item.surgeryReferral ? '1' : '0', item.autopsy ? '1' : '0', item.note, item.updatedAt]);
    });
    const csv = '\uFEFF' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
    downloadBlob(csv, `JOSLER_cases_${fileTimestamp()}.csv`, 'text/csv;charset=utf-8');
  }

  function csvEscape(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
  function fileTimestamp() { return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19); }

  async function encryptObject(object, password) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(object)));
    return {
      format: ENCRYPTED_FORMAT, version: 1, exportedAt: new Date().toISOString(),
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 250000, salt: bytesToBase64(salt) },
      cipher: { name: 'AES-GCM', iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) }
    };
  }

  async function decryptObject(payload, password) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const salt = base64ToBytes(payload.kdf.salt);
    const iv = base64ToBytes(payload.cipher.iv);
    const data = base64ToBytes(payload.cipher.data);
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: Number(payload.kdf.iterations) || 250000, hash: payload.kdf.hash || 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.parse(decoder.decode(plaintext));
  }

  function bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  function requestPassword({ confirm, title, description }) {
    refs.passwordTitle.textContent = title;
    refs.passwordDescription.textContent = description;
    refs.passwordConfirmRow.hidden = !confirm;
    refs.backupPassword.value = '';
    refs.backupPasswordConfirm.value = '';
    refs.passwordError.textContent = '';
    refs.passwordDialog.showModal();
    setTimeout(() => refs.backupPassword.focus(), 50);
    return new Promise(resolve => { passwordResolver = { resolve, confirm }; });
  }

  function resolvePassword(value) {
    passwordResolver?.resolve(value);
    passwordResolver = null;
    if (refs.passwordDialog.open) refs.passwordDialog.close();
  }

  async function importBackupFile(file) {
    if (!file) return;
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch { alert('バックアップファイルを読み取れませんでした。'); return; }
    try {
      if (parsed.format === ENCRYPTED_FORMAT) {
        const password = await requestPassword({ confirm: false, title: 'バックアップを復号', description: '作成時に設定したパスワードを入力してください。' });
        if (!password) return;
        parsed = await decryptObject(parsed, password);
      }
      if (parsed.format !== APP_FORMAT || !parsed.state) throw new Error('Invalid backup format');
      const imported = normalizeState(parsed.state);
      if (!window.confirm(`バックアップから${imported.cases.length}件を復元します。現在のデータは安全スナップショットへ退避されます。続行しますか？`)) return;
      await createSafetySnapshot('before-import');
      state = imported;
      touchState();
      renderAll();
      await queueSave({ snapshot: false });
      alert('バックアップを復元しました。');
    } catch (error) {
      console.error(error);
      alert('復元できませんでした。パスワードまたはファイル形式を確認してください。');
    } finally {
      refs.importInput.value = '';
    }
  }

  async function resetAllData() {
    if (!state.cases.length) return;
    if (!window.confirm('全症例データを初期化します。事前にバックアップを保存したことを確認してください。')) return;
    const phrase = window.prompt('確認のため「初期化」と入力してください。');
    if (phrase !== '初期化') return;
    await createSafetySnapshot('before-reset');
    const settings = state.settings;
    state = createEmptyState();
    state.settings = settings;
    touchState();
    renderAll();
    await queueSave({ snapshot: false });
  }

  async function replaceStateFromExternal(value, { reason = 'cloud-download', markUpdated = false } = {}) {
    await createSafetySnapshot(`before-${reason}`);
    const localOnlyMeta = { lastBackupAt: state.meta.lastBackupAt, lastSnapshotDate: state.meta.lastSnapshotDate };
    state = normalizeState(value);
    if (reason.startsWith('cloud-')) {
      state.meta.lastBackupAt = localOnlyMeta.lastBackupAt;
      state.meta.lastSnapshotDate = localOnlyMeta.lastSnapshotDate;
    }
    if (markUpdated) touchState();
    renderAll();
    await queueSave({ snapshot: false, cloud: false });
    return JSON.parse(JSON.stringify(state));
  }

  function getStateSnapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  window.JOSLER_APP = {
    ready: appReady,
    getState: getStateSnapshot,
    replaceState: replaceStateFromExternal,
    normalizeState: value => normalizeState(value),
    createSafetySnapshot,
    requestCloudSave: () => window.dispatchEvent(new CustomEvent('josler-local-state-changed', { detail: { manual: true } }))
  };

  function bindEvents() {
    refs.openAddButton.addEventListener('click', () => openCaseDialog());
    refs.closeDialogButton.addEventListener('click', closeCaseDialog);
    refs.cancelButton.addEventListener('click', closeCaseDialog);
    refs.caseForm.addEventListener('submit', saveCaseFromForm);
    refs.deleteCaseButton.addEventListener('click', deleteCurrentCase);
    refs.caseSpecialty.addEventListener('change', () => populateGroupSelect(refs.caseSpecialty.value));
    refs.caseGroup.addEventListener('change', () => populateDiseaseSelect(refs.caseGroup.value));
    refs.hospitalId.addEventListener('input', updateCasePreview);
    refs.caseForm.querySelectorAll('input[name="caseStatus"]').forEach(input => input.addEventListener('change', updateCasePreview));
    refs.catalogContainer.addEventListener('click', event => {
      const addButton = event.target.closest('[data-add-case]');
      if (addButton) return openCaseDialog({ diseaseId: addButton.dataset.addCase });
      const editButton = event.target.closest('[data-edit-case]');
      if (editButton) {
        const record = state.cases.find(item => item.id === editButton.dataset.editCase);
        if (record) openCaseDialog({ record });
      }
    });
    let searchTimer;
    refs.searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderCatalog, 120); });
    refs.specialtyFilter.addEventListener('change', renderCatalog);
    refs.statusFilter.addEventListener('change', renderCatalog);
    refs.maskToggle.addEventListener('click', async () => {
      state.settings.maskIds = !state.settings.maskIds;
      touchState();
      renderAll();
      await queueSave({ snapshot: false });
    });
    refs.dataMenuButton.addEventListener('click', () => {
      refs.dataMenu.hidden = !refs.dataMenu.hidden;
      refs.dataMenuButton.setAttribute('aria-expanded', String(!refs.dataMenu.hidden));
    });
    refs.exportEncryptedButton.addEventListener('click', exportEncryptedBackup);
    refs.exportPlainButton.addEventListener('click', exportPlainBackup);
    refs.exportCsvButton.addEventListener('click', exportCsv);
    refs.importInput.addEventListener('change', event => importBackupFile(event.target.files?.[0]));
    refs.resetButton.addEventListener('click', resetAllData);
    refs.passwordForm.addEventListener('submit', event => {
      event.preventDefault();
      const password = refs.backupPassword.value;
      const confirmation = refs.backupPasswordConfirm.value;
      if (password.length < 8) { refs.passwordError.textContent = '8文字以上で入力してください。'; return; }
      if (passwordResolver?.confirm && password !== confirmation) { refs.passwordError.textContent = '確認入力が一致しません。'; return; }
      resolvePassword(password);
    });
    refs.passwordCancel.addEventListener('click', () => resolvePassword(null));
    refs.passwordDialog.addEventListener('cancel', event => { event.preventDefault(); resolvePassword(null); });
    refs.caseDialog.addEventListener('cancel', event => { event.preventDefault(); closeCaseDialog(); });
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault(); deferredInstallPrompt = event; refs.installButton.hidden = false;
    });
    refs.installButton.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      refs.installButton.hidden = true;
    });
  }

  async function initialize() {
    populateStaticSelects();
    bindEvents();
    state = await loadState();
    renderAll();
    refs.saveStatus.textContent = navigator.onLine ? '端末：保存済み' : '端末：オフライン保存済み';
    window.addEventListener('online', () => { refs.saveStatus.textContent = '端末：保存済み'; });
    window.addEventListener('offline', () => { refs.saveStatus.textContent = '端末：オフライン保存済み'; });
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./service-worker.js').catch(error => console.warn('Service worker registration failed', error));
    }
    resolveAppReady(getStateSnapshot());
    window.dispatchEvent(new CustomEvent('josler-app-ready'));
  }

  initialize().catch(error => {
    console.error(error);
    refs.saveStatus.textContent = '端末：初期化エラー';
    alert('アプリを初期化できませんでした。ブラウザを再読み込みしてください。');
  });
})();
