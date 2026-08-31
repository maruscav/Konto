const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let session = null;
let state = {
  year: new Date().getFullYear(),
  rate: 5.00,
  mobileSpendMonth: new Date().getMonth() + 1,
  brokers: [],
  cash: [],
  income: {},
  categories: [],
  spending: {},
  notes: {},
  netWorth: [],
  brokerSnapshots: [],
  webauthnCredentials: []
};

let charts = { incomeExpense: null, netWorth: null, categoryBreakdown: null, heroSparkline: null };
let lastSnapshotValue = null;
let lastBrokerSnapshot = {};
let openPopover = null;

let pensionChart = null;
let brokerHistoryChart = null;

const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const uid = () => session?.user?.id;
const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ---------------- Undo toast ----------------

function showUndoToast(message, undoFn) {
  const existing = document.querySelector('.undo-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'undo-toast';
  toast.innerHTML = `<span>${message}</span><button class="undo-btn" type="button">Undo</button>`;
  document.body.appendChild(toast);
  const remove = () => toast.remove();
  const timer = setTimeout(remove, 6000);
  toast.querySelector('.undo-btn').addEventListener('click', () => {
    clearTimeout(timer);
    undoFn();
    remove();
  });
}

// ---------------- Auth ----------------

async function initAuth() {
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((_event, s) => {
    session = s;
    if (session) { document.getElementById('auth-screen').style.display = 'none'; proceedAfterAuth(); }
    else { document.getElementById('auth-screen').style.display = 'flex'; document.getElementById('lock-screen').style.display = 'none'; document.getElementById('app-shell').style.display = 'none'; }
  });
  if (session) { document.getElementById('auth-screen').style.display = 'none'; await proceedAfterAuth(); }

  document.getElementById('google-signin-btn').addEventListener('click', async () => {
    const msg = document.getElementById('auth-msg');
    msg.textContent = "Redirecting to Google...";
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) msg.textContent = error.message;
  });

  document.getElementById('sign-out-btn').addEventListener('click', async () => {
    sessionStorage.removeItem('biometric-verified');
    await sb.auth.signOut();
  });

  document.getElementById('lock-now-btn').addEventListener('click', () => {
    if (!state.webauthnCredentials.length) { alert('Enroll this device in Settings first to enable locking.'); return; }
    sessionStorage.removeItem('biometric-verified');
    document.getElementById('app-shell').style.display = 'none';
    document.getElementById('lock-screen').style.display = 'flex';
  });

  document.getElementById('unlock-btn').addEventListener('click', unlockWithBiometric);
  document.getElementById('register-biometric-btn').addEventListener('click', registerBiometric);
}

async function proceedAfterAuth() {
  await loadWebauthnCredentials();
  const needsUnlock = state.webauthnCredentials.length > 0 && sessionStorage.getItem('biometric-verified') !== '1';
  if (needsUnlock) {
    document.getElementById('app-shell').style.display = 'none';
    document.getElementById('lock-screen').style.display = 'flex';
  } else {
    document.getElementById('lock-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
    loadAll();
  }
}

// ---------------- Biometric lock (WebAuthn) ----------------

function bufToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuf(b64url) {
  const pad = (4 - (b64url.length % 4)) % 4;
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes.buffer;
}

function webauthnSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

async function loadWebauthnCredentials() {
  if (!uid()) { state.webauthnCredentials = []; return; }
  const { data } = await sb.from('webauthn_credentials').select('*').eq('user_id', uid()).order('created_at');
  state.webauthnCredentials = data || [];
}

async function registerBiometric() {
  const msg = document.getElementById('biometric-msg');
  if (!webauthnSupported()) { msg.textContent = "This browser doesn't support Face ID / Touch ID / Windows Hello."; return; }
  msg.textContent = "Follow your device's prompt...";
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userIdBytes = new TextEncoder().encode(uid());
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Ledger' },
        user: { id: userIdBytes, name: session.user.email || 'user', displayName: session.user.email || 'User' },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000,
        attestation: 'none'
      }
    });
    if (!cred) { msg.textContent = "Enrollment was cancelled."; return; }
    const credentialId = bufToBase64url(cred.rawId);
    const label = (prompt('Name this device (e.g. "iPhone", "MacBook"):', navigator.platform || 'Device') || 'Device').slice(0, 60);
    await sb.from('webauthn_credentials').insert({ user_id: uid(), credential_id: credentialId, label });
    await loadWebauthnCredentials();
    renderBiometricSettings();
    msg.textContent = "Device enrolled.";
  } catch (err) {
    msg.textContent = err.message || "Enrollment failed.";
  }
}

async function deleteWebauthnCredential(id) {
  await sb.from('webauthn_credentials').delete().eq('id', id);
  state.webauthnCredentials = state.webauthnCredentials.filter(c => c.id !== id);
  renderBiometricSettings();
}

function renderBiometricSettings() {
  const list = document.getElementById('webauthn-device-list');
  if (!list) return;
  if (!state.webauthnCredentials.length) {
    list.innerHTML = '<div class="empty-state">No devices enrolled — the app opens straight in.</div>';
    return;
  }
  list.innerHTML = state.webauthnCredentials.map(c => `
    <div class="device-row">
      <div>
        <div class="device-name">${escapeHtml(c.label || 'Device')}</div>
        <div class="device-date">Enrolled ${new Date(c.created_at).toLocaleDateString()}</div>
      </div>
      <button class="icon-btn" data-id="${c.id}" title="Remove">✕</button>
    </div>`).join('');
  list.querySelectorAll('.icon-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteWebauthnCredential(btn.dataset.id));
  });
}

async function unlockWithBiometric() {
  const msg = document.getElementById('lock-msg');
  if (!webauthnSupported()) { msg.textContent = "This browser doesn't support biometric unlock."; return; }
  if (!state.webauthnCredentials.length) { msg.textContent = "No device enrolled yet."; return; }
  msg.textContent = "Follow your device's prompt...";
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const allowCredentials = state.webauthnCredentials.map(c => ({ id: base64urlToBuf(c.credential_id), type: 'public-key' }));
    const assertion = await navigator.credentials.get({
      publicKey: { challenge, allowCredentials, userVerification: 'required', timeout: 60000 }
    });
    if (assertion) {
      sessionStorage.setItem('biometric-verified', '1');
      document.getElementById('lock-screen').style.display = 'none';
      document.getElementById('app-shell').style.display = 'flex';
      loadAll();
    }
  } catch (err) {
    msg.textContent = "Verification failed or was cancelled.";
  }
}

// ---------------- Data load ----------------

async function loadAll() {
  await Promise.all([loadPension(), loadSettings(), loadBrokers(), loadCash(), loadIncome(), loadCategoriesAndSpending(), loadNetWorthSnapshots(), loadBrokerSnapshots(), loadDashboardData()]);
  renderAll();
}

async function loadPension() {
  const { data } = await sb.from('pension_entries').select('*').eq('user_id', uid()).order('transaction_date');
  state.pension = data || [];
}

async function loadSettings() {
  const { data } = await sb.from('settings').select('*').eq('user_id', uid()).maybeSingle();
  if (data) state.rate = Number(data.eur_ron_rate);
  else await sb.from('settings').upsert({ user_id: uid(), eur_ron_rate: state.rate });
}

async function loadBrokers() {
  const { data } = await sb.from('brokers').select('*').eq('user_id', uid()).order('sort_order');
  state.brokers = data || [];
}

async function loadCash() {
  const { data } = await sb.from('cash_accounts').select('*').eq('user_id', uid()).order('sort_order');
  state.cash = data || [];
}

async function loadIncome() {
  const { data } = await sb.from('monthly_income').select('*').eq('user_id', uid()).eq('year', state.year);
  state.income = {};
  (data || []).forEach(r => state.income[r.month] = Number(r.income));
}

async function loadCategoriesAndSpending() {
  const { data: cats } = await sb.from('spending_categories').select('*').eq('user_id', uid()).order('sort_order');
  state.categories = cats || [];
  const { data: entries } = await sb.from('spending_entries').select('*').eq('user_id', uid()).eq('year', state.year);
  state.spending = {};
  state.notes = {};
  state.categories.forEach(c => { state.spending[c.id] = {}; state.notes[c.id] = {}; });
  (entries || []).forEach(e => {
    if (!state.spending[e.category_id]) state.spending[e.category_id] = {};
    if (!state.notes[e.category_id]) state.notes[e.category_id] = {};
    state.spending[e.category_id][e.month] = Number(e.amount);
    if (e.note) state.notes[e.category_id][e.month] = e.note;
  });
}

async function loadNetWorthSnapshots() {
  const { data } = await sb.from('net_worth_snapshots').select('*').eq('user_id', uid()).order('snapshot_date');
  state.netWorth = data || [];
}

async function loadBrokerSnapshots() {
  const { data } = await sb.from('broker_snapshots').select('*').eq('user_id', uid()).order('snapshot_date');
  state.brokerSnapshots = data || [];
}

async function loadDashboardData() {
  const now = new Date();
  const curYear = now.getFullYear(), curMonth = now.getMonth() + 1;
  let prevYear = curYear, prevMonth = curMonth - 1;
  if (prevMonth === 0) { prevMonth = 12; prevYear -= 1; }
  const years = curYear === prevYear ? [curYear] : [curYear, prevYear];

  const { data: incomeRows } = await sb.from('monthly_income').select('*').eq('user_id', uid()).in('year', years);
  const { data: catRows } = await sb.from('spending_categories').select('*').eq('user_id', uid());
  const { data: entryRows } = await sb.from('spending_entries').select('*').eq('user_id', uid()).in('year', years);

  const curIncome = (incomeRows || []).find(r => r.year === curYear && r.month === curMonth)?.income || 0;
  const prevIncome = (incomeRows || []).find(r => r.year === prevYear && r.month === prevMonth)?.income || 0;

  const curByCat = {}, prevByCat = {};
  (catRows || []).forEach(c => { curByCat[c.id] = 0; prevByCat[c.id] = 0; });
  (entryRows || []).forEach(e => {
    if (e.year === curYear && e.month === curMonth) curByCat[e.category_id] = (curByCat[e.category_id] || 0) + Number(e.amount);
    if (e.year === prevYear && e.month === prevMonth) prevByCat[e.category_id] = (prevByCat[e.category_id] || 0) + Number(e.amount);
  });
  const curExpenses = Object.values(curByCat).reduce((a, b) => a + b, 0);

  const [{ data: recentSpend }, { data: recentCash }, { data: recentBrokers }, { data: recentIncome }] = await Promise.all([
    sb.from('spending_entries').select('*, spending_categories(name)').eq('user_id', uid()).order('updated_at', { ascending: false }).limit(6),
    sb.from('cash_accounts').select('*').eq('user_id', uid()).order('updated_at', { ascending: false }).limit(6),
    sb.from('brokers').select('*').eq('user_id', uid()).order('updated_at', { ascending: false }).limit(6),
    sb.from('monthly_income').select('*').eq('user_id', uid()).order('updated_at', { ascending: false }).limit(6)
  ]);

  const activity = [];
  (recentSpend || []).forEach(e => {
    if (Number(e.amount) === 0 && !e.note) return;
    activity.push({ icon: '💳', title: `${escapeHtml(e.spending_categories?.name || 'Spending')} — ${MONTHS[e.month - 1]} ${e.year}`, time: e.updated_at, amount: Number(e.amount) });
  });
  (recentCash || []).forEach(c => activity.push({ icon: '🏦', title: `${escapeHtml(c.name)} updated`, time: c.updated_at, amount: Number(c.amount) }));
  (recentBrokers || []).forEach(b => activity.push({ icon: '📈', title: `${escapeHtml(b.name)} updated`, time: b.updated_at, amount: Number(b.valoare_port) }));
  (recentIncome || []).forEach(i => activity.push({ icon: '💰', title: `Income — ${MONTHS[i.month - 1]} ${i.year}`, time: i.updated_at, amount: Number(i.income) }));
  activity.sort((a, b) => new Date(b.time) - new Date(a.time));

  state.dashboard = { curYear, curMonth, prevYear, prevMonth, curIncome, prevIncome, curByCat, prevByCat, curExpenses, categories: catRows || [], activity: activity.slice(0, 8) };
}

// ---------------- Derived values ----------------

function toEUR(amount, currency) {
  return currency === 'EUR' ? Number(amount) : Number(amount) / (state.rate || 1);
}

function categoryTotalForMonth(month) {
  return state.categories.reduce((sum, c) => sum + (state.spending[c.id]?.[month] || 0), 0);
}

function categoryYearTotal(catId) {
  let t = 0; for (let m = 1; m <= 12; m++) t += state.spending[catId]?.[m] || 0; return t;
}

// ---------------- Rendering ----------------

function renderAll() {
  renderYearLabels();
  renderRate();
  renderSummary();
  renderPortfolio();
  renderSpending();
  renderCharts();
  renderDashboard();
  renderBiometricSettings();
  renderPension();
}

function renderYearLabels() {
  document.querySelectorAll('.year-label').forEach(el => el.textContent = state.year);
}

function renderRate() {
  document.getElementById('rate-input').value = state.rate;
  document.getElementById('rate-input-settings').value = state.rate;
  document.getElementById('rate-input-display').textContent = state.rate;
}

function renderSummary() {
  const tbody = document.getElementById('summary-tbody');
  tbody.innerHTML = '';
  let totalIncome = 0, totalExpenses = 0;
  for (let m = 1; m <= 12; m++) {
    const income = state.income[m] || 0;
    const expenses = categoryTotalForMonth(m);
    const pl = income - expenses;
    totalIncome += income; totalExpenses += expenses;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Month">${MONTHS[m-1]}</td>
      <td data-label="Income"><input type="number" step="0.01" class="mono" data-month="${m}" value="${income || ''}" placeholder="0.00"/></td>
      <td class="mono muted-cell" data-label="Expenses">${fmt(expenses)}</td>
      <td class="mono ${pl >= 0 ? 'pos' : 'neg'}" data-label="P / L">${fmt(pl)}</td>`;
    tr.querySelector('input').addEventListener('change', async (e) => {
      const val = parseFloat(e.target.value) || 0;
      state.income[m] = val;
      await sb.from('monthly_income').upsert({ user_id: uid(), year: state.year, month: m, income: val, updated_at: new Date().toISOString() }, { onConflict: 'user_id,year,month' });
      renderSummary();
    });
    tbody.appendChild(tr);
  }
  const totalRow = document.createElement('tr');
  totalRow.className = 'total-row';
  const totalPL = totalIncome - totalExpenses;
  totalRow.innerHTML = `<td data-label="Month">Total</td><td class="mono" data-label="Income">${fmt(totalIncome)}</td><td class="mono" data-label="Expenses">${fmt(totalExpenses)}</td><td class="mono ${totalPL >= 0 ? 'pos' : 'neg'}" data-label="P / L">${fmt(totalPL)}</td>`;
  tbody.appendChild(totalRow);

  document.getElementById('stat-income').textContent = fmt(totalIncome);
  document.getElementById('stat-expenses').textContent = fmt(totalExpenses);
  const plStat = document.getElementById('stat-pl');
  plStat.textContent = fmt(totalPL);
  plStat.className = 'stat-value mono ' + (totalPL >= 0 ? 'pos' : 'neg');
}

function renderPortfolio() {
  const tbody = document.getElementById('brokers-tbody');
  tbody.innerHTML = '';
  let totalInvEUR = 0, totalValEUR = 0;

  state.brokers.forEach(b => {
    const pl = Number(b.valoare_port) - Number(b.investitie);
    const randament = Number(b.investitie) ? (pl / Number(b.investitie) * 100) : 0;
    const evalEUR = toEUR(b.valoare_port, b.currency);
    const plEUR = toEUR(pl, b.currency);
    totalInvEUR += toEUR(b.investitie, b.currency);
    totalValEUR += evalEUR;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Broker"><input class="name-input" data-field="name" value="${escapeHtml(b.name)}"/></td>
      <td data-label="Ccy">
        <select data-field="currency" class="mono">
          <option value="RON" ${b.currency==='RON'?'selected':''}>RON</option>
          <option value="EUR" ${b.currency==='EUR'?'selected':''}>EUR</option>
        </select>
      </td>
      <td data-label="Investitie"><input type="number" step="0.01" class="mono" data-field="investitie" value="${b.investitie}"/></td>
      <td class="col-highlight" data-label="Valoare port"><input type="number" step="0.01" class="mono" data-field="valoare_port" value="${b.valoare_port}"/></td>
      <td class="mono muted-cell" data-label="Eval (EUR)">${fmt(evalEUR)}</td>
      <td class="mono ${randament >= 0 ? 'pos' : 'neg'}" data-label="Randament %">${randament.toFixed(2)}%</td>
      <td class="mono ${pl >= 0 ? 'pos' : 'neg'}" data-label="P/L">${fmt(pl)}</td>
      <td class="mono ${plEUR >= 0 ? 'pos' : 'neg'}" data-label="P/L (EUR)">${fmt(plEUR)}</td>
      <td class="row-actions" data-label=""><button class="icon-btn" title="Remove">✕</button></td>`;

    tr.querySelectorAll('input,select').forEach(el => {
      el.addEventListener('change', async (e) => {
        const field = e.target.dataset.field;
        const oldVal = b[field];
        let val = e.target.value;
        if (field === 'investitie' || field === 'valoare_port') val = parseFloat(val) || 0;
        b[field] = val;
        await sb.from('brokers').update({ [field]: val, updated_at: new Date().toISOString() }).eq('id', b.id);
        renderPortfolio();
        if (field === 'investitie' || field === 'valoare_port') {
          const label = field === 'investitie' ? 'Investitie' : 'Valoare port';
          showUndoToast(`${b.name}: ${label} changed to ${fmt(val)}`, async () => {
            b[field] = oldVal;
            await sb.from('brokers').update({ [field]: oldVal, updated_at: new Date().toISOString() }).eq('id', b.id);
            renderPortfolio();
          });
        }
      });
    });
    tr.querySelector('.icon-btn').addEventListener('click', async () => {
      await sb.from('brokers').delete().eq('id', b.id);
      state.brokers = state.brokers.filter(x => x.id !== b.id);
      renderPortfolio();
    });
    tbody.appendChild(tr);
  });

  const totalPLEUR = totalValEUR - totalInvEUR;
  const totalRow = document.createElement('tr');
  totalRow.className = 'total-row';
  totalRow.innerHTML = `<td colspan="4" data-label="">Broker totals</td><td class="mono" data-label="Eval (EUR)">${fmt(totalValEUR)}</td><td data-label=""></td><td data-label=""></td><td class="mono ${totalPLEUR>=0?'pos':'neg'}" data-label="P/L (EUR)">${fmt(totalPLEUR)}</td><td data-label=""></td>`;
  tbody.appendChild(totalRow);

  const cashBody = document.getElementById('cash-tbody');
  cashBody.innerHTML = '';
  let totalCashEUR = 0;
  state.cash.forEach(c => {
    const eur = toEUR(c.amount, c.currency);
    totalCashEUR += eur;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Account"><input class="name-input" data-field="name" value="${escapeHtml(c.name)}"/></td>
      <td data-label="Ccy">
        <select data-field="currency" class="mono">
          <option value="RON" ${c.currency==='RON'?'selected':''}>RON</option>
          <option value="EUR" ${c.currency==='EUR'?'selected':''}>EUR</option>
        </select>
      </td>
      <td data-label="Amount"><input type="number" step="0.01" class="mono" data-field="amount" value="${c.amount}"/></td>
      <td class="mono muted-cell" data-label="Eval (EUR)">${fmt(eur)}</td>
      <td class="row-actions" data-label=""><button class="icon-btn" title="Remove">✕</button></td>`;
    tr.querySelectorAll('input,select').forEach(el => {
      el.addEventListener('change', async (e) => {
        const field = e.target.dataset.field;
        let val = e.target.value;
        if (field === 'amount') val = parseFloat(val) || 0;
        c[field] = val;
        await sb.from('cash_accounts').update({ [field]: val, updated_at: new Date().toISOString() }).eq('id', c.id);
        renderPortfolio();
      });
    });
    tr.querySelector('.icon-btn').addEventListener('click', async () => {
      await sb.from('cash_accounts').delete().eq('id', c.id);
      state.cash = state.cash.filter(x => x.id !== c.id);
      renderPortfolio();
    });
    cashBody.appendChild(tr);
  });

  const grandVal = totalValEUR + totalCashEUR;
  document.getElementById('grand-total-eur').textContent = fmt(grandVal);
  document.getElementById('grand-total-ron').textContent = fmt(grandVal * state.rate);
  document.getElementById('cash-total-eur').textContent = fmt(totalCashEUR);
  snapshotNetWorth(grandVal);
  snapshotBrokerHistory();
  renderDashboard();
}

async function snapshotNetWorth(totalEUR) {
  if (lastSnapshotValue !== null && Math.abs(lastSnapshotValue - totalEUR) < 0.005) return;
  lastSnapshotValue = totalEUR;
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await sb.from('net_worth_snapshots')
    .upsert({ user_id: uid(), snapshot_date: today, total_eur: totalEUR }, { onConflict: 'user_id,snapshot_date' })
    .select().single();
  if (data) {
    const idx = state.netWorth.findIndex(s => s.snapshot_date === today);
    if (idx >= 0) state.netWorth[idx] = data; else state.netWorth.push(data);
    renderNetWorthChart();
  }
}

// One row per broker per day — only writes when investitie or valoare_port
// actually changed since our last write, same "don't spam" guard as net worth.
async function snapshotBrokerHistory() {
  const today = new Date().toISOString().slice(0, 10);
  for (const b of state.brokers) {
    const key = `${b.investitie}|${b.valoare_port}|${b.currency}`;
    if (lastBrokerSnapshot[b.id] === key) continue;
    lastBrokerSnapshot[b.id] = key;
    const { data } = await sb.from('broker_snapshots')
      .upsert({
        user_id: uid(), broker_id: b.id, snapshot_date: today,
        currency: b.currency, investitie: b.investitie, valoare_port: b.valoare_port
      }, { onConflict: 'user_id,broker_id,snapshot_date' })
      .select().single();
    if (data) {
      const idx = state.brokerSnapshots.findIndex(s => s.broker_id === b.id && s.snapshot_date === today);
      if (idx >= 0) state.brokerSnapshots[idx] = data; else state.brokerSnapshots.push(data);
    }
  }
  renderBrokerHistoryChart();
}

function renderSpending() {
  renderQuickAddCategories();

  const thead = document.getElementById('spending-thead-row');
  thead.innerHTML = '<th data-col="name">Category</th>' + MONTHS.map((m, i) => `<th data-col="${i+1}">${m}</th>`).join('') + '<th class="row-actions" data-col="actions"></th>';

  const tbody = document.getElementById('spending-tbody');
  tbody.innerHTML = '';

  state.categories.forEach(cat => {
    const tr = document.createElement('tr');
    let cells = `<td data-col="name"><input class="name-input" data-cat="${cat.id}" data-field="catname" value="${escapeHtml(cat.name)}"/></td>`;
    for (let m = 1; m <= 12; m++) {
      const v = state.spending[cat.id]?.[m] || '';
      const hasNote = !!(state.notes[cat.id]?.[m]);
      cells += `<td data-col="${m}">
        <div class="cell-wrap">
          <input type="number" step="0.01" class="mono" data-cat="${cat.id}" data-month="${m}" value="${v}" placeholder="—"/>
          <button type="button" class="note-icon ${hasNote ? 'has-note' : ''}" data-cat="${cat.id}" data-month="${m}" title="${hasNote ? 'View/edit note' : 'Add note'}">${hasNote ? '●' : '+'}</button>
        </div>
      </td>`;
    }
    cells += `<td class="row-actions" data-col="actions"><button class="icon-btn" title="Remove category">✕</button></td>`;
    tr.innerHTML = cells;

    tr.querySelectorAll('.note-icon').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openNotePopover(btn, btn.dataset.cat, parseInt(btn.dataset.month));
      });
    });

    tr.querySelectorAll('input[data-month]').forEach(el => {
      el.addEventListener('change', async (e) => {
        const m = parseInt(e.target.dataset.month);
        const val = parseFloat(e.target.value) || 0;
        if (!state.spending[cat.id]) state.spending[cat.id] = {};
        state.spending[cat.id][m] = val;
        await sb.from('spending_entries').upsert({ user_id: uid(), category_id: cat.id, year: state.year, month: m, amount: val, updated_at: new Date().toISOString() }, { onConflict: 'user_id,category_id,year,month' });
        renderSpending();
        renderSummary();
      });
    });
    tr.querySelector('input[data-field="catname"]').addEventListener('change', async (e) => {
      cat.name = e.target.value;
      await sb.from('spending_categories').update({ name: cat.name }).eq('id', cat.id);
    });
    tr.querySelector('.icon-btn').addEventListener('click', async () => {
      await sb.from('spending_categories').delete().eq('id', cat.id);
      state.categories = state.categories.filter(x => x.id !== cat.id);
      delete state.spending[cat.id];
      renderSpending();
      renderSummary();
    });
    tbody.appendChild(tr);
  });

  const totalRow = document.createElement('tr');
  totalRow.className = 'total-row';
  let totalCells = '<td data-col="name">Total discretionary</td>';
  for (let m = 1; m <= 12; m++) totalCells += `<td class="mono" data-col="${m}">${fmt(categoryTotalForMonth(m))}</td>`;
  totalCells += '<td data-col="actions"></td>';
  totalRow.innerHTML = totalCells;
  tbody.appendChild(totalRow);

  applyMobileSpendingFilter();
}

// ---------------- Quick add spending ----------------

function renderQuickAddCategories() {
  const sel = document.getElementById('quick-add-category');
  if (!sel) return;
  const prevVal = sel.value;
  sel.innerHTML = state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (state.categories.some(c => c.id === prevVal)) sel.value = prevVal;
}

(function initQuickAddMonthSelect() {
  const sel = document.getElementById('quick-add-month');
  if (!sel) return;
  const curMonth = new Date().getMonth() + 1;
  sel.innerHTML = MONTHS.map((m, i) => `<option value="${i+1}" ${i+1===curMonth?'selected':''}>${m}</option>`).join('');
})();

document.getElementById('quick-add-btn')?.addEventListener('click', async () => {
  const catSel = document.getElementById('quick-add-category');
  const catId = catSel.value;
  const catName = catSel.options[catSel.selectedIndex]?.text || 'category';
  const month = parseInt(document.getElementById('quick-add-month').value);
  const amountInput = document.getElementById('quick-add-amount');
  const amount = parseFloat(amountInput.value);
  const noteInput = document.getElementById('quick-add-note');
  const noteText = noteInput.value.trim();
  const hint = document.getElementById('quick-add-hint');

  if (!catId) { hint.textContent = 'Add a category first (in the table below).'; return; }
  if (!amount || amount <= 0) { hint.textContent = 'Enter an amount greater than 0.'; return; }

  const existingAmount = state.spending[catId]?.[month] || 0;
  const newAmount = existingAmount + amount;
  const existingNote = state.notes[catId]?.[month] || '';
  const addition = noteText ? `+${fmt(amount)} ${noteText}` : `+${fmt(amount)}`;
  const newNote = existingNote ? `${existingNote}; ${addition}` : addition;

  if (!state.spending[catId]) state.spending[catId] = {};
  if (!state.notes[catId]) state.notes[catId] = {};
  state.spending[catId][month] = newAmount;
  state.notes[catId][month] = newNote;

  await sb.from('spending_entries').upsert({
    user_id: uid(), category_id: catId, year: state.year, month,
    amount: newAmount, note: newNote, updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,category_id,year,month' });

  hint.textContent = `Added ${fmt(amount)} to ${catName} (${MONTHS[month-1]}) — new total ${fmt(newAmount)}.`;
  amountInput.value = '';
  noteInput.value = '';
  setTimeout(() => { hint.textContent = ''; }, 4000);

  renderSpending();
  renderSummary();
  renderCharts();
  renderDashboard();
});

// ---------------- Mobile spending month filter ----------------

function applyMobileSpendingFilter() {
  const isMobile = window.innerWidth <= 640;
  document.querySelectorAll('#view-spending [data-col]').forEach(el => {
    const col = el.dataset.col;
    if (!isMobile || col === 'name' || col === 'actions') { el.style.display = ''; return; }
    el.style.display = (parseInt(col) === state.mobileSpendMonth) ? '' : 'none';
  });
  const label = document.getElementById('mobile-month-label');
  if (label) label.textContent = MONTHS[state.mobileSpendMonth - 1];
}

// ---------------- Dashboard ----------------

function renderDashboard() {
  if (!state.dashboard) return;
  const d = state.dashboard;

  let totalValEUR = 0;
  state.brokers.forEach(b => totalValEUR += toEUR(b.valoare_port, b.currency));
  let totalCashEUR = 0;
  state.cash.forEach(c => totalCashEUR += toEUR(c.amount, c.currency));
  const netWorth = totalValEUR + totalCashEUR;

  document.getElementById('hero-net-worth').textContent = fmt(netWorth);
  document.getElementById('hero-net-worth-ron').textContent = fmt(netWorth * state.rate) + ' RON';

  const pl = d.curIncome - d.curExpenses;
  document.getElementById('dash-income').textContent = fmt(d.curIncome);
  document.getElementById('dash-expenses').textContent = fmt(d.curExpenses);
  const plEl = document.getElementById('dash-pl');
  plEl.textContent = fmt(pl);
  plEl.className = 'stat-value mono ' + (pl >= 0 ? 'pos' : 'neg');

  document.getElementById('dash-month-label').textContent = `${MONTHS[d.curMonth - 1]} ${d.curYear}`;

  const trendList = document.getElementById('trending-list');
  const sorted = d.categories
    .map(c => ({ id: c.id, name: c.name, cur: d.curByCat[c.id] || 0, prev: d.prevByCat[c.id] || 0 }))
    .filter(c => c.cur > 0 || c.prev > 0)
    .sort((a, b) => b.cur - a.cur)
    .slice(0, 6);

  if (!sorted.length) {
    trendList.innerHTML = '<div class="empty-state">No spending logged yet this month.</div>';
  } else {
    trendList.innerHTML = sorted.map(c => {
      const delta = c.prev > 0 ? ((c.cur - c.prev) / c.prev * 100) : (c.cur > 0 ? 100 : 0);
      const dirClass = delta > 0.5 ? 'up' : (delta < -0.5 ? 'down' : '');
      const arrow = delta > 0.5 ? '▲' : (delta < -0.5 ? '▼' : '—');
      return `<div class="trend-row">
        <div class="trend-left">
          <span class="cat-dot" style="background:${colorForCategory(c.id)}"></span>
          <span class="trend-name">${escapeHtml(c.name)}</span>
        </div>
        <div class="trend-right">
          <div class="trend-amount">${fmt(c.cur)}</div>
          <div class="trend-delta ${dirClass}">${arrow} ${Math.abs(delta).toFixed(0)}%</div>
        </div>
      </div>`;
    }).join('');
  }

  const activityList = document.getElementById('activity-list');
  if (!d.activity.length) {
    activityList.innerHTML = '<div class="empty-state">No activity yet — start entering your numbers.</div>';
  } else {
    activityList.innerHTML = d.activity.map(a => `
      <div class="activity-row">
        <div class="activity-main">
          <div class="activity-icon">${a.icon}</div>
          <div class="activity-text">
            <div class="activity-title">${escapeHtml(a.title)}</div>
            <div class="activity-time">${timeAgo(a.time)}</div>
          </div>
        </div>
        <div class="trend-amount mono">${fmt(a.amount)}</div>
      </div>`).join('');
  }

  renderHeroSparkline();
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function renderHeroSparkline() {
  const ctx = document.getElementById('chart-hero-sparkline');
  if (!ctx) return;
  const points = state.netWorth;
  if (charts.heroSparkline) charts.heroSparkline.destroy();
  if (!points.length) { charts.heroSparkline = null; return; }
  charts.heroSparkline = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => p.snapshot_date),
      datasets: [{
        data: points.map(p => Number(p.total_eur)),
        borderColor: '#ffffff', backgroundColor: 'rgba(255,255,255,0.2)',
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } }
    }
  });
}

function renderPension() {
  const tbody = document.getElementById('pension-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = [...state.pension].sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));

  rows.forEach(p => {
    const diff = Number(p.activ_personal) - Number(p.valoare_neta);
    const diffPct = Number(p.valoare_neta) ? (diff / Number(p.valoare_neta) * 100) : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Transaction date"><input type="date" class="mono" data-field="transaction_date" value="${p.transaction_date}"/></td>
      <td data-label="Net value"><input type="number" step="0.01" class="mono" data-field="valoare_neta" value="${p.valoare_neta}"/></td>
      <td data-label="Personal assets"><input type="number" step="0.01" class="mono" data-field="activ_personal" value="${p.activ_personal}"/></td>
      <td class="mono ${diff >= 0 ? 'pos' : 'neg'}" data-label="Difference">${fmt(diff)}</td>
      <td class="mono ${diffPct >= 0 ? 'pos' : 'neg'}" data-label="Difference %">${diffPct.toFixed(2)}%</td>
      <td class="row-actions" data-label=""><button class="icon-btn" title="Remove">✕</button></td>`;

    tr.querySelectorAll('input').forEach(el => {
      el.addEventListener('change', async (e) => {
        const field = e.target.dataset.field;
        let val = e.target.value;
        if (field !== 'transaction_date') val = parseFloat(val) || 0;
        const oldVal = p[field];
        p[field] = val;
        const { error } = await sb.from('pension_entries').update({ [field]: val, updated_at: new Date().toISOString() }).eq('id', p.id);
        if (error) { p[field] = oldVal; alert('Could not save — check for a duplicate date.'); }
        renderPension();
      });
    });
    tr.querySelector('.icon-btn').addEventListener('click', async () => {
      await sb.from('pension_entries').delete().eq('id', p.id);
      state.pension = state.pension.filter(x => x.id !== p.id);
      renderPension();
    });
    tbody.appendChild(tr);
  });

  const latest = rows[0];
  if (latest) {
    document.getElementById('pension-latest-neta').textContent = fmt(latest.valoare_neta);
    document.getElementById('pension-latest-activ').textContent = fmt(latest.activ_personal);
    const diff = Number(latest.activ_personal) - Number(latest.valoare_neta);
    const diffPct = Number(latest.valoare_neta) ? (diff / Number(latest.valoare_neta) * 100) : 0;

    const diffEl = document.getElementById('pension-latest-diff');
    diffEl.textContent = fmt(diff);
    diffEl.className = 'stat-value mono ' + (diff >= 0 ? 'pos' : 'neg');

    const diffPctEl = document.getElementById('pension-latest-diff-pct');
    diffPctEl.textContent = diffPct.toFixed(2) + '%';
    diffPctEl.className = 'stat-value mono ' + (diffPct >= 0 ? 'pos' : 'neg');
  }

  renderPensionChart();
}

function renderPensionChart() {
  const ctx = document.getElementById('chart-pension');
  if (!ctx) return;
  const points = [...state.pension].sort((a, b) => new Date(a.transaction_date) - new Date(b.transaction_date));
  if (pensionChart) pensionChart.destroy();
  if (!points.length) { pensionChart = null; return; }
  pensionChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => p.transaction_date),
      datasets: [
        { label: 'Net value (RON)', data: points.map(p => Number(p.valoare_neta)), borderColor: '#4f7cff', backgroundColor: 'rgba(79,124,255,0.08)', fill: true, tension: 0.3, pointRadius: 2 },
        { label: 'Personal assets (RON)', data: points.map(p => Number(p.activ_personal)), borderColor: '#0f9d80', backgroundColor: 'rgba(15,157,128,0.08)', fill: true, tension: 0.3, pointRadius: 2 }
      ]
    },
    options: chartBaseOptions()
  });
}

// ---------------- Charts ----------------

const CHART_COLORS = ['#4f7cff', '#0f9d80', '#e6584f', '#f0a83c', '#9b6bf2', '#ec5fa3', '#2fb8c9', '#8a8f9c'];

function colorForCategory(catId) {
  let hash = 0;
  for (let i = 0; i < catId.length; i++) hash = (hash * 31 + catId.charCodeAt(i)) >>> 0;
  return CHART_COLORS[hash % CHART_COLORS.length];
}

function renderCharts() {
  renderIncomeExpenseChart();
  renderNetWorthChart();
  renderCategoryBreakdownChart();
}

function renderIncomeExpenseChart() {
  const ctx = document.getElementById('chart-income-expense');
  if (!ctx) return;
  const income = [], expenses = [];
  for (let m = 1; m <= 12; m++) { income.push(state.income[m] || 0); expenses.push(categoryTotalForMonth(m)); }
  if (charts.incomeExpense) charts.incomeExpense.destroy();
  charts.incomeExpense = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: MONTHS,
      datasets: [
        { label: 'Income', data: income, backgroundColor: '#0f9d80', borderRadius: 4, maxBarThickness: 18 },
        { label: 'Expenses', data: expenses, backgroundColor: '#e6584f', borderRadius: 4, maxBarThickness: 18 }
      ]
    },
    options: chartBaseOptions()
  });
}

function renderNetWorthChart() {
  const ctx = document.getElementById('chart-net-worth');
  if (!ctx) return;
  const points = state.netWorth;
  if (charts.netWorth) charts.netWorth.destroy();
  if (!points.length) {
    charts.netWorth = null;
    ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height);
    return;
  }
  charts.netWorth = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => p.snapshot_date),
      datasets: [{
        label: 'Net worth (EUR)',
        data: points.map(p => Number(p.total_eur)),
        borderColor: '#0f9d80',
        backgroundColor: 'rgba(15,157,128,0.10)',
        fill: true,
        tension: 0.3,
        pointRadius: points.length > 1 ? 2 : 4,
        pointBackgroundColor: '#0f9d80'
      }]
    },
    options: chartBaseOptions()
  });
}

function renderCategoryBreakdownChart() {
  const ctx = document.getElementById('chart-category-breakdown');
  if (!ctx) return;
  const labels = state.categories.map(c => c.name);
  const data = state.categories.map(c => categoryYearTotal(c.id));
  const colors = state.categories.map(c => colorForCategory(c.id));
  if (charts.categoryBreakdown) charts.categoryBreakdown.destroy();
  charts.categoryBreakdown = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: chartTextColor(), font: { size: 11 }, boxWidth: 10, padding: 10 } } }
    }
  });
}

// Two lines per broker: dashed = investitie, solid = valoare port, both in EUR
// at today's exchange rate (there's no historical FX rate stored, so past points
// use the current rate too — a known approximation).
function renderBrokerHistoryChart() {
  const ctx = document.getElementById('chart-broker-history');
  if (!ctx) return;
  if (brokerHistoryChart) brokerHistoryChart.destroy();
  if (!state.brokers.length || !state.brokerSnapshots.length) { brokerHistoryChart = null; return; }

  const dates = [...new Set(state.brokerSnapshots.map(s => s.snapshot_date))].sort();

  const datasets = [];
  state.brokers.forEach((b, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const snaps = state.brokerSnapshots.filter(s => s.broker_id === b.id);
    const investData = dates.map(d => { const s = snaps.find(x => x.snapshot_date === d); return s ? toEUR(s.investitie, s.currency) : null; });
    const valData = dates.map(d => { const s = snaps.find(x => x.snapshot_date === d); return s ? toEUR(s.valoare_port, s.currency) : null; });
    datasets.push({ label: `${b.name} — Investitie`, data: investData, borderColor: color, borderDash: [5, 4], backgroundColor: 'transparent', tension: 0.3, pointRadius: dates.length > 1 ? 1 : 4, spanGaps: true });
    datasets.push({ label: `${b.name} — Valoare port`, data: valData, borderColor: color, backgroundColor: 'transparent', tension: 0.3, pointRadius: dates.length > 1 ? 1 : 4, spanGaps: true });
  });

  brokerHistoryChart = new Chart(ctx, {
    type: 'line',
    data: { labels: dates, datasets },
    options: chartBaseOptions()
  });
}

function chartBaseOptions() {
  const textColor = chartTextColor();
  const gridColor = chartGridColor();
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: textColor, font: { size: 11 }, boxWidth: 10 } } },
    scales: {
      x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
      y: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } }
    }
  };
}

// ---------------- Theme ----------------

function chartTextColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#767c8c';
}
function chartGridColor() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.08)' : '#e6e8ef';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    btn.textContent = theme === 'dark' ? '☀️ Light mode' : '🌙 Dark mode';
  });
}

function initTheme() {
  const stored = localStorage.getItem('konto-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(stored || (prefersDark ? 'dark' : 'light'));
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('konto-theme', next);
  applyTheme(next);
  renderCharts();
  renderPensionChart();
  renderHeroSparkline();
  renderBrokerHistoryChart();
}

document.querySelectorAll('.theme-toggle-btn').forEach(btn => btn.addEventListener('click', toggleTheme));
initTheme();

// ---------------- Spending notes popover ----------------

function closeNotePopover() {
  if (openPopover) { openPopover.remove(); openPopover = null; }
}

function openNotePopover(anchor, catId, month) {
  if (openPopover) { const wasSameAnchor = openPopover.dataset.anchorFor === `${catId}-${month}`; closeNotePopover(); if (wasSameAnchor) return; }

  const existing = state.notes[catId]?.[month] || '';
  const pop = document.createElement('div');
  pop.className = 'note-popover';
  pop.dataset.anchorFor = `${catId}-${month}`;
  pop.innerHTML = `
    <textarea placeholder="Add a note for this entry...">${escapeHtml(existing)}</textarea>
    <div class="note-actions">
      <button class="note-close" type="button">Cancel</button>
      <button class="note-save" type="button">Save</button>
    </div>`;
  document.body.appendChild(pop);

  const rect = anchor.getBoundingClientRect();
  const popWidth = 220;
  let left = rect.left - popWidth + rect.width;
  if (left < 8) left = 8;
  if (left + popWidth > window.innerWidth - 8) left = window.innerWidth - popWidth - 8;
  pop.style.left = left + 'px';
  pop.style.top = (rect.bottom + 6) + 'px';

  const textarea = pop.querySelector('textarea');
  textarea.focus();

  pop.querySelector('.note-close').addEventListener('click', closeNotePopover);
  pop.querySelector('.note-save').addEventListener('click', async () => {
    const val = textarea.value.trim();
    if (!state.notes[catId]) state.notes[catId] = {};
    state.notes[catId][month] = val;
    await sb.from('spending_entries').upsert(
      { user_id: uid(), category_id: catId, year: state.year, month: month, note: val, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,category_id,year,month' }
    );
    closeNotePopover();
    renderSpending();
  });

  setTimeout(() => {
    document.addEventListener('click', function onOutside(e) {
      if (!pop.contains(e.target) && e.target !== anchor) { closeNotePopover(); document.removeEventListener('click', onOutside); }
    });
  }, 0);
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { closeNotePopover(); document.removeEventListener('keydown', onEsc); }
  });

  openPopover = pop;
}

// ---------------- Add row handlers ----------------

document.getElementById('add-broker-btn').addEventListener('click', async () => {
  const { data, error } = await sb.from('brokers').insert({ user_id: uid(), name: 'New broker', currency: 'RON', investitie: 0, valoare_port: 0, sort_order: state.brokers.length }).select().single();
  if (!error) { state.brokers.push(data); renderPortfolio(); }
});

document.getElementById('add-cash-btn').addEventListener('click', async () => {
  const { data, error } = await sb.from('cash_accounts').insert({ user_id: uid(), name: 'New account', currency: 'RON', amount: 0, sort_order: state.cash.length }).select().single();
  if (!error) { state.cash.push(data); renderPortfolio(); }
});

document.getElementById('add-category-btn').addEventListener('click', async () => {
  const { data, error } = await sb.from('spending_categories').insert({ user_id: uid(), name: 'New category', sort_order: state.categories.length }).select().single();
  if (!error) { state.categories.push(data); state.spending[data.id] = {}; renderSpending(); }
});

// ---------------- Settings ----------------

document.getElementById('save-rate-btn').addEventListener('click', async () => {
  const val = parseFloat(document.getElementById('rate-input-settings').value) || state.rate;
  state.rate = val;
  await sb.from('settings').upsert({ user_id: uid(), eur_ron_rate: val, updated_at: new Date().toISOString() });
  renderAll();
  const hint = document.getElementById('rate-save-hint');
  hint.textContent = 'Saved.'; setTimeout(() => hint.textContent = '', 1500);
});

document.getElementById('settings-lock-btn').addEventListener('click', () => {
  if (!state.webauthnCredentials.length) { alert('Enroll a device above first to enable locking.'); return; }
  sessionStorage.removeItem('biometric-verified');
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('lock-screen').style.display = 'flex';
});

document.getElementById('settings-signout-btn').addEventListener('click', async () => {
  sessionStorage.removeItem('biometric-verified');
  await sb.auth.signOut();
});

function renderDeleteAccountButton() {
  const flow = document.getElementById('delete-account-flow');
  flow.innerHTML = `<button class="add-row-btn" id="delete-account-btn" style="border-color:var(--loss); color:var(--loss);">Delete my account</button>`;
  document.getElementById('delete-account-btn').addEventListener('click', showDeleteConfirmUI);
}

function showDeleteConfirmUI() {
  const flow = document.getElementById('delete-account-flow');
  flow.innerHTML = `
    <p style="font-size:12.5px; color:var(--text); margin-bottom:8px;">
      Type <strong>DELETE</strong> to confirm — this removes all your data permanently and cannot be undone.
    </p>
    <input type="text" id="delete-confirm-input" class="confirm-input mono" placeholder="DELETE" style="margin-bottom:10px;"/>
    <div style="display:flex; gap:10px;">
      <button id="delete-confirm-btn" class="save-btn" style="background:var(--loss);">Permanently delete</button>
      <button id="delete-cancel-btn" class="add-row-btn">Cancel</button>
    </div>
    <p class="auth-msg" id="delete-msg"></p>`;
  document.getElementById('delete-cancel-btn').addEventListener('click', renderDeleteAccountButton);
  document.getElementById('delete-confirm-btn').addEventListener('click', async () => {
    const val = document.getElementById('delete-confirm-input').value.trim();
    const msg = document.getElementById('delete-msg');
    if (val !== 'DELETE') { msg.textContent = 'Type DELETE exactly (all caps) to confirm.'; return; }
    document.getElementById('delete-confirm-btn').disabled = true;
    document.getElementById('delete-cancel-btn').disabled = true;
    msg.textContent = 'Deleting your data...';
    await deleteAccount(msg);
  });
}

document.getElementById('delete-account-btn').addEventListener('click', showDeleteConfirmUI);

async function deleteAccount(msg) {
  try {
    const { error } = await sb.rpc('delete_user');
    if (error) throw error;
    if (msg) msg.textContent = 'Account deleted. Signing out...';
    sessionStorage.removeItem('biometric-verified');
    setTimeout(() => sb.auth.signOut(), 1200);
  } catch (err) {
    if (msg) msg.textContent = 'Something went wrong: ' + err.message;
  }
}

// ---------------- Year navigation ----------------

document.getElementById('year-prev').addEventListener('click', async () => { state.year--; await loadIncome(); await loadCategoriesAndSpending(); renderAll(); });
document.getElementById('year-next').addEventListener('click', async () => { state.year++; await loadIncome(); await loadCategoriesAndSpending(); renderAll(); });

// ---------------- Mobile spending month navigation ----------------

document.getElementById('mobile-month-prev').addEventListener('click', () => {
  state.mobileSpendMonth = state.mobileSpendMonth === 1 ? 12 : state.mobileSpendMonth - 1;
  applyMobileSpendingFilter();
});
document.getElementById('mobile-month-next').addEventListener('click', () => {
  state.mobileSpendMonth = state.mobileSpendMonth === 12 ? 1 : state.mobileSpendMonth + 1;
  applyMobileSpendingFilter();
});
window.addEventListener('resize', applyMobileSpendingFilter);

// ---------------- Nav ----------------

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', async () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(item.dataset.view).classList.add('active');
    if (item.dataset.view === 'view-summary') renderCharts();
    if (item.dataset.view === 'view-portfolio') renderBrokerHistoryChart();
    if (item.dataset.view === 'view-dashboard') { await loadDashboardData(); renderDashboard(); }
    if (item.dataset.view === 'view-pension') renderPensionChart();
  });
});

initAuth();

document.getElementById('add-pension-btn').addEventListener('click', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb.from('pension_entries').insert({ user_id: uid(), transaction_date: today, valoare_neta: 0, activ_personal: 0 }).select().single();
  if (!error) { state.pension.push(data); renderPension(); }
});