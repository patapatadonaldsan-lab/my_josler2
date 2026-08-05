let initializeApp;
let browserLocalPersistence;
let getAuth;
let GoogleAuthProvider;
let onAuthStateChanged;
let setPersistence;
let signInWithPopup;
let signOut;
let doc;
let getDoc;
let getFirestore;
let serverTimestamp;
let setDoc;

const CLOUD_FORMAT = 'josler-case-manager-cloud';
const CLOUD_SCHEMA_VERSION = 1;
const SYNC_META_KEY = 'josler-cloud-sync-meta-v1';
const OWNER_KEY = 'josler-cloud-owner-v1';
const CLOUD_DOCUMENT_ID = 'joslerCaseManager';

const refs = {
  status: document.getElementById('cloudStatus'),
  account: document.getElementById('cloudAccount'),
  login: document.getElementById('cloudLoginButton'),
  logout: document.getElementById('cloudLogoutButton'),
  sync: document.getElementById('cloudSyncButton'),
  conflictDialog: document.getElementById('syncConflictDialog'),
  conflictSummary: document.getElementById('syncConflictSummary')
};

let auth = null;
let db = null;
let currentUser = null;
let syncPromise = null;
let pendingSync = false;
let debounceTimer = null;
let initialSyncComplete = false;
let firebaseInitPromise = null;
let firebaseConfig = null;

function setCloudStatus(text, state = '') {
  refs.status.textContent = `クラウド：${text}`;
  refs.status.dataset.state = state;
}

function hasValidConfig(config) {
  const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
  return config && required.every(key => {
    const value = String(config[key] || '').trim();
    return value && !value.includes('PASTE_YOUR');
  });
}

async function loadFirebaseSdk() {
  const [appModule, authModule, firestoreModule] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js')
  ]);
  ({ initializeApp } = appModule);
  ({ browserLocalPersistence, getAuth, GoogleAuthProvider, onAuthStateChanged, setPersistence, signInWithPopup, signOut } = authModule);
  ({ doc, getDoc, getFirestore, serverTimestamp, setDoc } = firestoreModule);
}

async function initializeFirebase() {
  if (auth) return;
  if (firebaseInitPromise) return firebaseInitPromise;
  if (!navigator.onLine) throw new Error('オフラインのためFirebaseへ接続できません。');

  firebaseInitPromise = (async () => {
    setCloudStatus('Firebase接続中…', 'syncing');
    await loadFirebaseSdk();
    const firebaseApp = initializeApp(firebaseConfig);
    auth = getAuth(firebaseApp);
    db = getFirestore(firebaseApp);
    await setPersistence(auth, browserLocalPersistence);

    onAuthStateChanged(auth, async user => {
      initialSyncComplete = false;
      updateAccountUi(user);
      if (!user) {
        setCloudStatus('未ログイン', 'idle');
        return;
      }
      if (!await verifyLocalOwner(user)) {
        await signOut(auth);
        return;
      }
      setCloudStatus('確認中…', 'syncing');
      await syncNow();
      initialSyncComplete = true;
      if (pendingSync) {
        pendingSync = false;
        await syncNow();
      }
    });
  })().catch(error => {
    firebaseInitPromise = null;
    throw error;
  });
  return firebaseInitPromise;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalState(rawState) {
  const normalized = window.JOSLER_APP.normalizeState(rawState);
  const cases = normalized.cases
    .map(item => ({
      id: item.id,
      hospitalId: item.hospitalId,
      specialtyId: item.specialtyId,
      groupId: item.groupId,
      diseaseId: item.diseaseId,
      status: item.status,
      date: item.date,
      note: item.note,
      surgeryReferral: item.surgeryReferral,
      autopsy: item.autopsy,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    version: 1,
    cases,
    settings: { maskIds: normalized.settings.maskIds !== false },
    meta: {
      createdAt: normalized.meta.createdAt,
      updatedAt: normalized.meta.updatedAt
    }
  };
}

async function stateHash(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalState(state)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function getSyncMeta(uid) {
  try {
    const all = JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}');
    return all[uid] || {};
  } catch {
    return {};
  }
}

function setSyncMeta(uid, patch) {
  try {
    const all = JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}');
    all[uid] = { ...(all[uid] || {}), ...patch };
    localStorage.setItem(SYNC_META_KEY, JSON.stringify(all));
  } catch (error) {
    console.warn('Cloud sync metadata could not be saved', error);
  }
}

function cloudRef(uid) {
  return doc(db, 'users', uid, 'apps', CLOUD_DOCUMENT_ID);
}

function caseCount(state) {
  return Array.isArray(state?.cases) ? state.cases.length : 0;
}

function formatDate(value) {
  if (!value) return '不明';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '不明' : date.toLocaleString('ja-JP');
}

function normalizeHospitalId(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/g, '');
}

function mergeStates(localState, cloudState) {
  const local = window.JOSLER_APP.normalizeState(localState);
  const cloud = window.JOSLER_APP.normalizeState(cloudState);
  const byRecordId = new Map();

  [...cloud.cases, ...local.cases].forEach(item => {
    const current = byRecordId.get(item.id);
    if (!current || String(item.updatedAt).localeCompare(String(current.updatedAt)) >= 0) {
      byRecordId.set(item.id, clone(item));
    }
  });

  // 同一症例IDが別レコードとして存在する場合は、更新日時が新しい方を残す。
  const byHospitalId = new Map();
  [...byRecordId.values()].forEach(item => {
    const key = normalizeHospitalId(item.hospitalId) || item.id;
    const current = byHospitalId.get(key);
    if (!current || String(item.updatedAt).localeCompare(String(current.updatedAt)) >= 0) {
      byHospitalId.set(key, item);
    }
  });

  const createdCandidates = [local.meta.createdAt, cloud.meta.createdAt].filter(Boolean).sort();
  return {
    version: 1,
    cases: [...byHospitalId.values()],
    settings: clone(local.settings),
    meta: {
      createdAt: createdCandidates[0] || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastBackupAt: local.meta.lastBackupAt || cloud.meta.lastBackupAt || null,
      lastSnapshotDate: local.meta.lastSnapshotDate || null
    }
  };
}

async function uploadState(state, uid) {
  const canonical = canonicalState(state);
  const hash = await stateHash(canonical);
  setCloudStatus('保存中…', 'syncing');
  await setDoc(cloudRef(uid), {
    format: CLOUD_FORMAT,
    schemaVersion: CLOUD_SCHEMA_VERSION,
    ownerUid: uid,
    state: canonical,
    dataHash: hash,
    clientUpdatedAt: canonical.meta.updatedAt,
    updatedAt: serverTimestamp()
  });
  setSyncMeta(uid, { lastHash: hash, lastSyncAt: new Date().toISOString() });
  setCloudStatus(`同期済み ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`, 'synced');
  return hash;
}

async function downloadState(remoteState, remoteHash, uid) {
  setCloudStatus('クラウドから読込中…', 'syncing');
  await window.JOSLER_APP.replaceState(remoteState, { reason: 'cloud-download' });
  const normalizedHash = remoteHash || await stateHash(remoteState);
  setSyncMeta(uid, { lastHash: normalizedHash, lastSyncAt: new Date().toISOString() });
  setCloudStatus(`同期済み ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`, 'synced');
}

function requestConflictChoice(localState, cloudState) {
  refs.conflictSummary.innerHTML = `
    <div><strong>この端末</strong><span>${caseCount(localState)}症例</span><small>更新：${formatDate(localState.meta?.updatedAt)}</small></div>
    <div><strong>クラウド</strong><span>${caseCount(cloudState)}症例</span><small>更新：${formatDate(cloudState.meta?.updatedAt)}</small></div>
  `;
  refs.conflictDialog.showModal();

  return new Promise(resolve => {
    const finish = choice => {
      refs.conflictDialog.querySelectorAll('[data-sync-choice]').forEach(button => { button.onclick = null; });
      if (refs.conflictDialog.open) refs.conflictDialog.close();
      resolve(choice);
    };
    refs.conflictDialog.querySelectorAll('[data-sync-choice]').forEach(button => {
      button.onclick = () => finish(button.dataset.syncChoice);
    });
    refs.conflictDialog.oncancel = event => {
      event.preventDefault();
      finish('cancel');
    };
  });
}

async function resolveConflict(localState, cloudState, remoteHash, uid) {
  setCloudStatus('競合あり', 'conflict');
  const choice = await requestConflictChoice(localState, cloudState);
  if (choice === 'cancel') {
    setCloudStatus('同期保留', 'conflict');
    return;
  }
  if (choice === 'cloud') {
    await downloadState(cloudState, remoteHash, uid);
    return;
  }
  if (choice === 'local') {
    await uploadState(localState, uid);
    return;
  }

  const merged = mergeStates(localState, cloudState);
  await window.JOSLER_APP.replaceState(merged, { reason: 'cloud-merge' });
  await uploadState(window.JOSLER_APP.getState(), uid);
}

async function performSync({ force = '' } = {}) {
  if (!currentUser) {
    setCloudStatus('未ログイン', 'idle');
    return;
  }
  if (!navigator.onLine) {
    pendingSync = true;
    setCloudStatus('オフライン・再接続待ち', 'offline');
    return;
  }

  const uid = currentUser.uid;
  const localState = window.JOSLER_APP.getState();
  const localHash = await stateHash(localState);
  const snapshot = await getDoc(cloudRef(uid));

  if (!snapshot.exists()) {
    await uploadState(localState, uid);
    return;
  }

  const remote = snapshot.data();
  if (remote.format !== CLOUD_FORMAT || !remote.state) {
    throw new Error('クラウドデータの形式が一致しません。');
  }
  if (remote.ownerUid && remote.ownerUid !== uid) {
    throw new Error('クラウドデータの所有者が一致しません。');
  }

  const cloudState = window.JOSLER_APP.normalizeState(remote.state);
  const remoteHash = remote.dataHash || await stateHash(cloudState);
  const lastHash = getSyncMeta(uid).lastHash || '';

  if (force === 'local') return uploadState(localState, uid);
  if (force === 'cloud') return downloadState(cloudState, remoteHash, uid);
  if (force === 'merge') {
    const merged = mergeStates(localState, cloudState);
    await window.JOSLER_APP.replaceState(merged, { reason: 'cloud-merge' });
    return uploadState(window.JOSLER_APP.getState(), uid);
  }

  if (localHash === remoteHash) {
    setSyncMeta(uid, { lastHash: localHash, lastSyncAt: new Date().toISOString() });
    setCloudStatus('同期済み', 'synced');
    return;
  }

  if (lastHash) {
    const localChanged = localHash !== lastHash;
    const cloudChanged = remoteHash !== lastHash;
    if (localChanged && !cloudChanged) return uploadState(localState, uid);
    if (!localChanged && cloudChanged) return downloadState(cloudState, remoteHash, uid);
    return resolveConflict(localState, cloudState, remoteHash, uid);
  }

  if (caseCount(localState) === 0 && caseCount(cloudState) > 0) {
    return downloadState(cloudState, remoteHash, uid);
  }
  if (caseCount(cloudState) === 0 && caseCount(localState) > 0) {
    return uploadState(localState, uid);
  }
  return resolveConflict(localState, cloudState, remoteHash, uid);
}

async function syncNow(options = {}) {
  if (syncPromise) {
    pendingSync = true;
    return syncPromise;
  }
  syncPromise = performSync(options)
    .catch(error => {
      console.error('Cloud sync failed', error);
      if (!navigator.onLine) {
        pendingSync = true;
        setCloudStatus('オフライン・再接続待ち', 'offline');
      } else if (String(error?.code || '').includes('permission-denied')) {
        setCloudStatus('権限エラー', 'error');
        alert('Firestoreのセキュリティルールにより保存が拒否されました。READMEのルール設定を確認してください。');
      } else {
        setCloudStatus('同期エラー', 'error');
        alert(`クラウド同期に失敗しました。\n${error?.message || error}`);
      }
    })
    .finally(async () => {
      syncPromise = null;
      if (pendingSync && currentUser && navigator.onLine) {
        pendingSync = false;
        await syncNow();
      }
    });
  return syncPromise;
}

function scheduleSync() {
  if (!currentUser || !initialSyncComplete) {
    pendingSync = true;
    return;
  }
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => syncNow(), 900);
}

function updateAccountUi(user) {
  currentUser = user;
  refs.account.hidden = !user;
  refs.logout.hidden = !user;
  refs.sync.hidden = !user;
  refs.login.hidden = Boolean(user);
  refs.account.textContent = user?.email || user?.displayName || '';
}

async function verifyLocalOwner(user) {
  const owner = localStorage.getItem(OWNER_KEY);
  const localState = window.JOSLER_APP.getState();
  if (!owner) {
    localStorage.setItem(OWNER_KEY, user.uid);
    return true;
  }
  if (owner === user.uid) return true;
  if (caseCount(localState) === 0) {
    localStorage.setItem(OWNER_KEY, user.uid);
    return true;
  }
  alert('この端末の症例データは別のGoogleアカウントに紐付いています。誤ったアカウントへの送信を防ぐため、ログインを解除します。元のGoogleアカウントでログインしてください。');
  return false;
}

async function login() {
  if (!firebaseConfig) {
    alert('Firebase設定が未完了です。firebase-config.jsを設定してGitHubへアップロードしてください。');
    return;
  }
  try {
    await initializeFirebase();
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error('Google login failed', error);
    if (error?.code === 'auth/unauthorized-domain') {
      alert('このGitHub PagesドメインがFirebase Authenticationで許可されていません。Firebaseコンソールの「Authentication」→「設定」→「承認済みドメイン」に、あなたのユーザー名.github.io を追加してください。');
    } else if (error?.code !== 'auth/popup-closed-by-user') {
      alert(`Googleログインに失敗しました。\n${error?.message || error}`);
    }
  }
}

async function logout() {
  if (!auth) return;
  await signOut(auth);
}

async function initializeCloud() {
  await window.JOSLER_APP.ready;
  refs.login.addEventListener('click', login);
  refs.logout.addEventListener('click', logout);
  refs.sync.addEventListener('click', () => syncNow());
  window.addEventListener('josler-local-state-changed', scheduleSync);
  window.addEventListener('online', async () => {
    if (firebaseConfig && !auth) {
      try { await initializeFirebase(); }
      catch (error) {
        console.error('Firebase reconnection failed', error);
        setCloudStatus('接続エラー', 'error');
      }
      return;
    }
    if (currentUser) {
      pendingSync = false;
      syncNow();
    }
  });
  window.addEventListener('offline', () => {
    if (currentUser) setCloudStatus('オフライン・再接続待ち', 'offline');
  });

  firebaseConfig = window.JOSLER_FIREBASE_CONFIG;
  if (!hasValidConfig(firebaseConfig)) {
    setCloudStatus('Firebase未設定', 'error');
    return;
  }

  if (!navigator.onLine) {
    setCloudStatus('オフライン・端末保存のみ', 'offline');
    return;
  }
  await initializeFirebase();
}

initializeCloud().catch(error => {
  console.error('Firebase initialization failed', error);
  setCloudStatus('初期化エラー', 'error');
  alert(`Firebaseの初期化に失敗しました。firebase-config.jsを確認してください。\n${error?.message || error}`);
});
