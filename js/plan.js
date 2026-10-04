// js/plan.js: "Plan vs actual" for the Investments view.
// Load this file BEFORE app.js. It only uses app.js globals when its functions
// run (sb, uid, fmt, fmt0, fmtSigned, showUndoToast, chartBaseOptions), so the
// load order is safe.

const PLAN_MONTHS = 240; // 20 years
const plan = { settings: null, entries: {}, year: 1, yearTouched: false, chart: null };

const planIso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const planMonthlyRate = (annual) => Math.pow(1 + annual, 1 / 12) - 1;
const planEl = (id) => document.getElementById(id);

// ---------- Dates ----------

// Last day of plan month n (n = 1 is the month of start_date).
function planMonthDate(n) {
  const [y, m] = plan.settings.start_date.split('-').map(Number);
  return new Date(y, (m - 1) + n, 0);
}

function planLabel(n) {
  return planMonthDate(n).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ---------- Math (same formulas as the Excel tracker) ----------
// value(n) = value(n-1) * (1 + monthly rate) + monthly amount

function planExpected() {
  const s = plan.settings;
  const a = Number(s.monthly_amount);
  const r1 = planMonthlyRate(Number(s.return_sxr8));
  const r2 = planMonthlyRate(Number(s.return_vwce));
  const e1 = [Number(s.start_sxr8)];
  const e2 = [Number(s.start_vwce)];
  for (let n = 1; n <= PLAN_MONTHS; n++) {
    e1.push(e1[n - 1] * (1 + r1) + a);
    e2.push(e2[n - 1] * (1 + r2) + a);
  }
  return { e1, e2, a };
}

// Combined actual value of both funds after month n (n = 0 is the starting value).
// Returns null until both values are entered for that month.
function planActualTotal(n) {
  const s = plan.settings;
  if (n === 0) return Number(s.start_sxr8) + Number(s.start_vwce);
  const e = plan.entries[n];
  if (!e || e.actual_sxr8 == null || e.actual_vwce == null) return null;
  return Number(e.actual_sxr8) + Number(e.actual_vwce);
}

function planLatestMonth() {
  for (let n = PLAN_MONTHS; n >= 1; n--) {
    if (planActualTotal(n) !== null) return n;
  }
  return 0;
}

// ---------- Load / save ----------

async function loadPlan() {
  const [{ data: s }, { data: e }] = await Promise.all([
    sb.from('invest_plan_settings').select('*').eq('user_id', uid()).maybeSingle(),
    sb.from('invest_plan_entries').select('*').eq('user_id', uid())
  ]);
  plan.settings = s || null;
  plan.entries = {};
  (e || []).forEach((r) => { plan.entries[r.month_index] = r; });
  fillPlanForm();
}

function fillPlanForm() {
  const s = plan.settings;
  const today = new Date();
  const defaultStart = planIso(new Date(today.getFullYear(), today.getMonth() + 1, 0));
  planEl('plan-amount').value = s ? Number(s.monthly_amount) : 100;
  planEl('plan-ret-sxr8').value = s ? +(Number(s.return_sxr8) * 100).toFixed(2) : 7;
  planEl('plan-ret-vwce').value = s ? +(Number(s.return_vwce) * 100).toFixed(2) : 7;
  planEl('plan-start-sxr8').value = s ? Number(s.start_sxr8) : 0;
  planEl('plan-start-vwce').value = s ? Number(s.start_vwce) : 0;
  planEl('plan-start-date').value = s ? s.start_date : defaultStart;
}

planEl('plan-save-btn').addEventListener('click', async () => {
  const hint = planEl('plan-save-hint');
  const row = {
    user_id: uid(),
    monthly_amount: parseFloat(planEl('plan-amount').value),
    return_sxr8: parseFloat(planEl('plan-ret-sxr8').value) / 100,
    return_vwce: parseFloat(planEl('plan-ret-vwce').value) / 100,
    start_sxr8: parseFloat(planEl('plan-start-sxr8').value) || 0,
    start_vwce: parseFloat(planEl('plan-start-vwce').value) || 0,
    start_date: planEl('plan-start-date').value,
    updated_at: new Date().toISOString()
  };
  if (!(row.monthly_amount >= 0) || isNaN(row.return_sxr8) || isNaN(row.return_vwce) || !row.start_date) {
    hint.textContent = 'Enter an amount, both returns and a start date.';
    return;
  }
  const { error } = await sb.from('invest_plan_settings').upsert(row, { onConflict: 'user_id' });
  if (error) { hint.textContent = 'Could not save: ' + error.message; return; }
  plan.settings = row;
  hint.textContent = 'Saved.';
  setTimeout(() => { hint.textContent = ''; }, 1500);
  renderPlan();
});

// Saves one month. Returns nothing; re-renders on success, rolls back on error.
async function savePlanEntry(n, patch) {
  const prev = plan.entries[n] || { month_index: n, done: false, actual_sxr8: null, actual_vwce: null };
  const next = { ...prev, ...patch };
  // Entering both values ticks the month as done, unless the caller set done itself.
  if (patch.done === undefined && next.actual_sxr8 != null && next.actual_vwce != null) next.done = true;
  plan.entries[n] = next;
  const { error } = await sb.from('invest_plan_entries').upsert({
    user_id: uid(),
    month_index: n,
    done: next.done,
    actual_sxr8: next.actual_sxr8,
    actual_vwce: next.actual_vwce,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,month_index' });
  if (error) {
    plan.entries[n] = prev;
    alert('Could not save this month: ' + error.message);
  }
  renderPlan();
}

// ---------- Render ----------

function renderPlan() {
  if (!planEl('plan-card')) return;
  const s = plan.settings;
  planEl('plan-empty').style.display = s ? 'none' : '';
  planEl('plan-body').style.display = s ? '' : 'none';
  if (!s) {
    planEl('plan-settings').open = true;
    planEl('plan-progress').textContent = '';
    return;
  }

  const ex = planExpected();
  const startTotal = Number(s.start_sxr8) + Number(s.start_vwce);
  const doneCount = Object.values(plan.entries).filter((e) => e.done).length;
  planEl('plan-progress').textContent = `${doneCount} of ${PLAN_MONTHS} months done`;
  planEl('plan-rate-note').textContent =
    `· expected ${(planMonthlyRate(Number(s.return_sxr8)) * 100).toFixed(2)}% (SXR8) and ${(planMonthlyRate(Number(s.return_vwce)) * 100).toFixed(2)}% (VWCE) per month`;

  // Open the year that contains the first unfinished month, until the user navigates.
  if (!plan.yearTouched) {
    let first = 1;
    while (first <= PLAN_MONTHS && plan.entries[first]?.done) first++;
    plan.year = Math.min(Math.ceil(Math.min(first, PLAN_MONTHS) / 12), PLAN_MONTHS / 12);
  }

  renderPlanStats(ex, startTotal);
  renderPlanTable(ex);
  renderPlanChart(ex, startTotal);
}

function renderPlanStats(ex, startTotal) {
  const L = planLatestMonth();
  const at = L || 1;
  const expected = ex.e1[at] + ex.e2[at];
  planEl('plan-lbl-expected').textContent = `Expected, ${planLabel(at)}`;
  planEl('plan-stat-expected').textContent = fmt0(expected);

  const actualEl = planEl('plan-stat-actual');
  const diffEl = planEl('plan-stat-diff');
  const gainEl = planEl('plan-stat-gain');
  if (!L) {
    [actualEl, diffEl, gainEl].forEach((el) => { el.textContent = '-'; el.className = 'stat-value mono'; });
    return;
  }
  const actual = planActualTotal(L);
  const diff = actual - expected;
  const invested = startTotal + 2 * ex.a * L;
  const gain = actual - invested;
  actualEl.textContent = fmt0(actual);
  actualEl.className = 'stat-value mono';
  diffEl.textContent = fmtSigned(diff);
  diffEl.className = 'stat-value mono ' + (diff >= 0 ? 'pos' : 'neg');
  gainEl.textContent = fmtSigned(gain);
  gainEl.className = 'stat-value mono ' + (gain >= 0 ? 'pos' : 'neg');
}

function renderPlanTable(ex) {
  const tbody = planEl('plan-tbody');
  tbody.innerHTML = '';
  const from = (plan.year - 1) * 12 + 1;
  const to = plan.year * 12;
  planEl('plan-year-label').textContent = `Year ${plan.year} of ${PLAN_MONTHS / 12}`;

  for (let n = from; n <= to; n++) {
    const e = plan.entries[n] || {};
    const expected = ex.e1[n] + ex.e2[n];
    const tot = planActualTotal(n);
    const prevTot = planActualTotal(n - 1);
    const diff = tot === null ? null : tot - expected;
    // Monthly % of the combined portfolio, after taking out this month's contributions.
    const pct = tot !== null && prevTot ? ((tot - 2 * ex.a) / prevTot - 1) * 100 : null;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Month">${planLabel(n)}</td>
      <td data-label="Done"><input type="checkbox" data-n="${n}" data-field="done" ${e.done ? 'checked' : ''} aria-label="Done for ${planLabel(n)}"/></td>
      <td class="mono muted-cell" data-label="Expected">${fmt(expected)}</td>
      <td data-label="SXR8"><input type="number" step="0.01" class="mono" data-n="${n}" data-field="actual_sxr8" value="${e.actual_sxr8 ?? ''}" placeholder="-"/></td>
      <td data-label="VWCE"><input type="number" step="0.01" class="mono" data-n="${n}" data-field="actual_vwce" value="${e.actual_vwce ?? ''}" placeholder="-"/></td>
      <td class="mono ${pct === null ? 'muted-cell' : pct >= 0 ? 'pos' : 'neg'}" data-label="Monthly %">${pct === null ? '-' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'}</td>
      <td class="mono ${diff === null ? 'muted-cell' : diff >= 0 ? 'pos' : 'neg'}" data-label="Vs plan">${diff === null ? '-' : (diff >= 0 ? '+' : '') + fmt(diff)}</td>`;

    tr.querySelectorAll('input').forEach((el) => {
      el.addEventListener('change', async (ev) => {
        const field = ev.target.dataset.field;
        const old = plan.entries[n] || {};
        if (field === 'done') {
          await savePlanEntry(n, { done: ev.target.checked });
          return;
        }
        const raw = ev.target.value.trim();
        const val = raw === '' ? null : parseFloat(raw);
        const oldVal = old[field] ?? null;
        const oldDone = old.done ?? false;
        await savePlanEntry(n, { [field]: val });
        if (val !== null) {
          const name = field === 'actual_sxr8' ? 'SXR8' : 'VWCE';
          showUndoToast(`${planLabel(n)}: ${name} set to ${fmt(val)}`, async () => {
            await savePlanEntry(n, { [field]: oldVal, done: oldDone });
          });
        }
      });
    });
    tbody.appendChild(tr);
  }
}

function renderPlanChart(ex, startTotal) {
  const ctx = planEl('chart-plan');
  if (!ctx) return;
  if (plan.chart) plan.chart.destroy();

  const labels = ['Start'];
  const expected = [startTotal];
  const invested = [startTotal];
  const actual = [startTotal];
  for (let n = 1; n <= PLAN_MONTHS; n++) {
    labels.push(planLabel(n));
    expected.push(ex.e1[n] + ex.e2[n]);
    invested.push(startTotal + 2 * ex.a * n);
    actual.push(planActualTotal(n)); // null = not entered yet, drawn as a gap
  }

  const opts = chartBaseOptions();
  opts.scales.x.ticks.maxTicksLimit = 8;
  opts.scales.x.ticks.maxRotation = 0;
  opts.scales.y.ticks.callback = (v) => '€ ' + Math.round(v).toLocaleString('en-US');
  opts.interaction = { mode: 'index', intersect: false };
  opts.plugins.tooltip = {
    callbacks: { label: (c) => (c.parsed.y === null ? '' : `${c.dataset.label}: ${fmt0(c.parsed.y)}`) }
  };

  plan.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Total invested', data: invested, borderColor: '#f0a83c', borderDash: [2, 3], borderWidth: 1.5, pointRadius: 0, tension: 0 },
        { label: 'Expected', data: expected, borderColor: '#8a8f9c', borderDash: [6, 4], borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'Actual', data: actual, borderColor: '#4c86ff', backgroundColor: '#4c86ff', borderWidth: 2, pointRadius: 3, spanGaps: false, tension: 0.2 }
      ]
    },
    options: opts
  });
}

// ---------- Year navigation ----------

planEl('plan-year-prev').addEventListener('click', () => {
  plan.yearTouched = true;
  plan.year = Math.max(1, plan.year - 1);
  renderPlan();
});
planEl('plan-year-next').addEventListener('click', () => {
  plan.yearTouched = true;
  plan.year = Math.min(PLAN_MONTHS / 12, plan.year + 1);
  renderPlan();
});
