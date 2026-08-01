const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let session = null;
let state = {
  year: new Date().getFullYear(),
  rate: 5.00,
  brokers: [],
  cash: [],
  income: {},        // { "1": 6622, "2": ... } month -> amount
  categories: [],     // [{id, name, sort_order}]
  spending: {},       // { categoryId: { "1": 250, "2": ... } }
  notes: {},          // { categoryId: { "1": "note text", ... } }
  netWorth: []        // [{ snapshot_date, total_eur }, ...] ordered by date
};

let charts = { incomeExpense: null, netWorth: null, categoryBreakdown: null };
let lastSnapshotValue = null;
let openPopover = null;

const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const uid = () => session?.user?.id;

// ---------------- Auth ----------------

async function initAuth() {
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((_event, s) => {
    session = s;
    if (session) { document.getElementById('auth-screen').style.display = 'none'; document.getElementById('app-shell').style.display = 'flex'; loadAll(); }
    else { document.getElementById('auth-screen').style.display = 'flex'; document.getElementById('app-shell').style.display = 'none'; }
  });
  if (session) { document.getElementById('auth-screen').style.display = 'none'; document.getElementById('app-shell').style.display = 'flex'; loadAll(); }

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
    await sb.auth.signOut();
  });
}

// ---------------- Data load ----------------

async function loadAll() {
  await Promise.all([loadSettings(), loadBrokers(), loadCash(), loadIncome(), loadCategoriesAndSpending(), loadNetWorthSnapshots()]);
  renderAll();
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
      <td>${MONTHS[m-1]}</td>
      <td><input type="number" step="0.01" class="mono" data-month="${m}" value="${income || ''}" placeholder="0.00"/></td>
      <td class="mono muted-cell">${fmt(expenses)}</td>
      <td class="mono ${pl >= 0 ? 'pos' : 'neg'}">${fmt(pl)}</td>`;
    tr.querySelector('input').addEventListener('change', async (e) => {
      const val = parseFloat(e.target.value) || 0;
      state.income[m] = val;
      await sb.from('monthly_income').upsert({ user_id: uid(), year: state.year, month: m, income: val }, { onConflict: 'user_id,year,month' });
      renderSummary();
    });
    tbody.appendChild(tr);
  }
  const totalRow = document.createElement('tr');
  totalRow.className = 'total-row';
  const totalPL = totalIncome - totalExpenses;
  totalRow.innerHTML = `<td>Total</td><td class="mono">${fmt(totalIncome)}</td><td class="mono">${fmt(totalExpenses)}</td><td class="mono ${totalPL >= 0 ? 'pos' : 'neg'}">${fmt(totalPL)}</td>`;
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
      <td><input class="name-input" data-field="name" value="${b.name}"/></td>
      <td>
        <select data-field="currency" class="mono">
          <option value="RON" ${b.currency==='RON'?'selected':''}>RON</option>
          <option value="EUR" ${b.currency==='EUR'?'selected':''}>EUR</option>
        </select>
      </td>
      <td><input type="number" step="0.01" class="mono" data-field="investitie" value="${b.investitie}"/></td>
      <td><input type="number" step="0.01" class="mono" data-field="valoare_port" value="${b.valoare_port}"/></td>
      <td class="mono muted-cell">${fmt(evalEUR)}</td>
      <td class="mono ${randament >= 0 ? 'pos' : 'neg'}">${randament.toFixed(2)}%</td>
      <td class="mono ${pl >= 0 ? 'pos' : 'neg'}">${fmt(pl)}</td>
      <td class="mono ${plEUR >= 0 ? 'pos' : 'neg'}">${fmt(plEUR)}</td>
      <td class="row-actions"><button class="icon-btn" title="Remove">✕</button></td>`;

    tr.querySelectorAll('input,select').forEach(el => {
      el.addEventListener('change', async (e) => {
        const field = e.target.dataset.field;
        let val = e.target.value;
        if (field === 'investitie' || field === 'valoare_port') val = parseFloat(val) || 0;
        b[field] = val;
        await sb.from('brokers').update({ [field]: val, updated_at: new Date().toISOString() }).eq('id', b.id);
        renderPortfolio();
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
  totalRow.innerHTML = `<td colspan="4">Broker totals</td><td class="mono">${fmt(totalValEUR)}</td><td></td><td></td><td class="mono ${totalPLEUR>=0?'pos':'neg'}">${fmt(totalPLEUR)}</td><td></td>`;
  tbody.appendChild(totalRow);

  // Cash accounts
  const cashBody = document.getElementById('cash-tbody');
  cashBody.innerHTML = '';
  let totalCashEUR = 0;
  state.cash.forEach(c => {
    const eur = toEUR(c.amount, c.currency);
    totalCashEUR += eur;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="name-input" data-field="name" value="${c.name}"/></td>
      <td>
        <select data-field="currency" class="mono">
          <option value="RON" ${c.currency==='RON'?'selected':''}>RON</option>
          <option value="EUR" ${c.currency==='EUR'?'selected':''}>EUR</option>
        </select>
      </td>
      <td><input type="number" step="0.01" class="mono" data-field="amount" value="${c.amount}"/></td>
      <td class="mono muted-cell">${fmt(eur)}</td>
      <td class="row-actions"><button class="icon-btn" title="Remove">✕</button></td>`;
    tr.querySelectorAll('input,select').forEach(el => {
      el.addEventListener('change', async (e) => {
        const field = e.target.dataset.field;
        let val = e.target.value;
        if (field === 'amount') val = parseFloat(val) || 0;
        c[field] = val;
        await sb.from('cash_accounts').update({ [field]: val }).eq('id', c.id);
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

  // Grand totals
  const grandVal = totalValEUR + totalCashEUR;
  document.getElementById('grand-total-eur').textContent = fmt(grandVal);
  document.getElementById('grand-total-ron').textContent = fmt(grandVal * state.rate);
  document.getElementById('cash-total-eur').textContent = fmt(totalCashEUR);
  snapshotNetWorth(grandVal);
}

async function snapshotNetWorth(totalEUR) {
  // Avoid spamming writes: only save if the value actually changed since our last write.
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

function renderSpending() {
  const thead = document.getElementById('spending-thead-row');
  thead.innerHTML = '<th>Category</th>' + MONTHS.map(m => `<th>${m}</th>`).join('') + '<th class="row-actions"></th>';

  const tbody = document.getElementById('spending-tbody');
  tbody.innerHTML = '';

  state.categories.forEach(cat => {
    const tr = document.createElement('tr');
    let cells = `<td><input class="name-input" data-cat="${cat.id}" data-field="catname" value="${cat.name}"/></td>`;
    for (let m = 1; m <= 12; m++) {
      const v = state.spending[cat.id]?.[m] || '';
      const hasNote = !!(state.notes[cat.id]?.[m]);
      cells += `<td>
        <div class="cell-wrap">
          <input type="number" step="0.01" class="mono" data-cat="${cat.id}" data-month="${m}" value="${v}" placeholder="—"/>
          <button type="button" class="note-icon ${hasNote ? 'has-note' : ''}" data-cat="${cat.id}" data-month="${m}" title="${hasNote ? 'View/edit note' : 'Add note'}">${hasNote ? '●' : '+'}</button>
        </div>
      </td>`;
    }
    cells += `<td class="row-actions"><button class="icon-btn" title="Remove category">✕</button></td>`;
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
        await sb.from('spending_entries').upsert({ user_id: uid(), category_id: cat.id, year: state.year, month: m, amount: val }, { onConflict: 'user_id,category_id,year,month' });
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

  // Total row
  const totalRow = document.createElement('tr');
  totalRow.className = 'total-row';
  let totalCells = '<td>Total discretionary</td>';
  for (let m = 1; m <= 12; m++) totalCells += `<td class="mono">${fmt(categoryTotalForMonth(m))}</td>`;
  totalCells += '<td></td>';
  totalRow.innerHTML = totalCells;
  tbody.appendChild(totalRow);
}

// ---------------- Charts ----------------

const CHART_COLORS = ['#c9a15a', '#4fb88a', '#8891a6', '#d46a6a', '#6a8fd4', '#a86ad4', '#d4a86a', '#6ad4c0'];

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
        { label: 'Income', data: income, backgroundColor: '#c9a15a', borderRadius: 4, maxBarThickness: 18 },
        { label: 'Expenses', data: expenses, backgroundColor: '#d46a6a', borderRadius: 4, maxBarThickness: 18 }
      ]
    },
    options: chartBaseOptions({ stacked: false })
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
        borderColor: '#4fb88a',
        backgroundColor: 'rgba(79,184,138,0.12)',
        fill: true,
        tension: 0.3,
        pointRadius: points.length > 1 ? 2 : 4,
        pointBackgroundColor: '#4fb88a'
      }]
    },
    options: chartBaseOptions({})
  });
}

function renderCategoryBreakdownChart() {
  const ctx = document.getElementById('chart-category-breakdown');
  if (!ctx) return;
  const labels = state.categories.map(c => c.name);
  const data = state.categories.map(c => categoryYearTotal(c.id));
  if (charts.categoryBreakdown) charts.categoryBreakdown.destroy();
  charts.categoryBreakdown = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: CHART_COLORS, borderColor: '#1a2030', borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#8891a6', font: { size: 11 }, boxWidth: 10, padding: 10 } } }
    }
  });
}

function chartBaseOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#8891a6', font: { size: 11 }, boxWidth: 10 } } },
    scales: {
      x: { ticks: { color: '#8891a6', font: { size: 10 } }, grid: { color: 'rgba(42,50,68,0.5)' } },
      y: { ticks: { color: '#8891a6', font: { size: 10 } }, grid: { color: 'rgba(42,50,68,0.5)' } }
    }
  };
}

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
    <textarea placeholder="Add a note for this entry...">${existing}</textarea>
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
      { user_id: uid(), category_id: catId, year: state.year, month: month, note: val },
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

// ---------------- Year navigation ----------------

document.getElementById('year-prev').addEventListener('click', async () => { state.year--; await loadIncome(); await loadCategoriesAndSpending(); renderAll(); });
document.getElementById('year-next').addEventListener('click', async () => { state.year++; await loadIncome(); await loadCategoriesAndSpending(); renderAll(); });

// ---------------- Nav ----------------

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(item.dataset.view).classList.add('active');
  });
});

initAuth();