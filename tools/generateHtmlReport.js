// generateHtmlReport.js
import fs from 'fs';
import path from 'path';

export function generateHtmlReport(report, outputPath) {
  const { runId, startTime, endTime, missions = [], summary = {}, llm = {} } = report;
  const durationSec =
    (startTime && endTime)
      ? ((new Date(endTime) - new Date(startTime)) / 1000).toFixed(2)
      : '—';

  // helpers
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;'); // for HTML attributes
  const badge = (status) =>
    status === 'passed' ? '✅ Passed' :
    status === 'failed' ? '❌ Failed' : (status || '—');

  const submissionBlock = (m) => {
    const mDurationSec =
      m.endTime && m.startTime
        ? ((m.endTime - m.startTime) / 1000).toFixed(2)
        : (typeof m.durationSeconds === 'number' ? m.durationSeconds.toFixed(2) : '—');

    const steps = Array.isArray(m.steps) ? m.steps : [];
    const stepItems = steps.map((step, idx) => {
      const events = Array.isArray(step.events) ? step.events : [];
      const ok = /✅|Passed|Mission Success/i.test(step.result || '');
      const imgTag = step.screenshotPath
        ? `<img src="${esc(step.screenshotPath)}" alt="screenshot turn ${esc(step.turn ?? idx)}">`
        : '';

      const plan = (typeof step.summary === 'string' && step.summary.trim())
        ? step.summary.trim()
        : '';
      const planSpan = plan
        ? `<span class="plan" title="${escAttr(plan)}">${esc(plan)}</span>`
        : '';

      return `
        <details class="step" ${ok ? '' : 'open'}>
          <summary>
            <span class="turn">Turn ${esc((step.turn ?? idx) + 1)}</span>
            ${planSpan}
            <span class="step-result ${ok ? 'ok' : 'bad'}">${esc(step.result || '—')}</span>
            <span class="tokens">tokens: ${esc(step.tokensUsed ?? '—')} / total: ${esc(step.totalTokensUsed ?? '—')}</span>
          </summary>
          <pre class="events">${esc(events.join('\n')) || '(no events)'}</pre>
          ${imgTag}
        </details>
      `;
    }).join('');

    const type = String(m.submissionType || 'mission').toLowerCase();
    const typeLabel = (type === 'premission' || type === 'postmission') ? type : 'mission';
    const prettyTitle = `${esc(m.missionName || 'Mission')} — ${typeLabel}${m.submissionName ? `: ${esc(m.submissionName)}` : ''}`;
    const statusClass = m.status === 'failed' ? 'bad' : (m.status === 'passed' ? 'ok' : '');

    return `
      <details class="mission-submission">
        <summary>
          <span class="name">${prettyTitle}</span>
          <span class="status ${statusClass}">${badge(m.status)}</span>
          <span class="meta">steps: ${steps.length} • duration: ${mDurationSec}s</span>
        </summary>
        <div class="steps">
          ${stepItems || '<div class="empty">No steps recorded.</div>'}
        </div>
      </details>
    `;
  };

  // group submissions by mission
  const grouped = missions.reduce((acc, m) => {
    const key = m.missionName || '(unnamed mission)';
    (acc[key] ||= []).push(m);
    return acc;
  }, {});

  const groupStatus = (subs) => subs.some(s => s.status === 'failed') ? 'failed' : 'passed';

  const missionGroupBlock = (missionName, subs) => {
    const status = groupStatus(subs);
    const totalSteps = subs.reduce((n, s) => n + (Array.isArray(s.steps) ? s.steps.length : 0), 0);
    const firstStart = Math.min(...subs.map(s => s.startTime || 0).filter(Boolean));
    const lastEnd    = Math.max(...subs.map(s => s.endTime || 0).filter(Boolean));
    const groupDur   = (firstStart && lastEnd) ? ((lastEnd - firstStart) / 1000).toFixed(2) : '—';

    // pre → mission → post
    const order = { premission: 0, mission: 1, postmission: 2 };
    subs.sort((a, b) =>
      (order[(a.submissionType || 'mission')] ?? 1) -
      (order[(b.submissionType || 'mission')] ?? 1)
    );

    return `
      <details class="mission-group">
        <summary>
          <span class="name">${esc(missionName)}</span>
          <span class="status ${status === 'failed' ? 'bad' : 'ok'}">${badge(status)}</span>
          <span class="meta">submissions: ${subs.length} • steps: ${totalSteps} • duration: ${groupDur}s</span>
        </summary>
        <div class="group-body">
          ${subs.map(submissionBlock).join('')}
        </div>
      </details>
    `;
  };

  const groupsHtml = Object.entries(grouped).map(([name, subs]) => missionGroupBlock(name, subs)).join('');

  // compute totals for chips if not provided
  const totals = Object.keys(grouped).reduce((acc, name) => {
    const st = groupStatus(grouped[name]);
    acc.total += 1;
    acc.passed += st === 'passed' ? 1 : 0;
    acc.failed += st === 'failed' ? 1 : 0;
    return acc;
  }, { total: 0, passed: 0, failed: 0 });

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Testronaut Report – ${esc(runId)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    /* ===== Brand + surface tokens (match splash/app) ===== */
    :root{
      --bg-top:#0b1022;
      --bg-mid:#0f172a;
      --bg-btm:#0b1022;

      --hairline:rgba(255,255,255,.12);
      --hairline-strong:rgba(255,255,255,.18);

      --text:rgba(255,255,255,.92);
      --text-muted:rgba(255,255,255,.65);

      --ok:#22c55e;     /* green-500 */
      --bad:#ef4444;    /* red-500 */

      --chip-ok-bg:rgba(34,197,94,.14);
      --chip-bad-bg:rgba(239,68,68,.16);
      --chip-border:rgba(255,255,255,.22);
      --chip-ok-border:rgba(34,197,94,.40);
      --chip-bad-border:rgba(239,68,68,.45);
    }

    /* ===== Base ===== */
    html,body{height:100%;}
    body{
      margin:0; padding:24px;
      font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Helvetica,Arial;
      background: linear-gradient(180deg,var(--bg-top) 0%,var(--bg-mid) 60%,var(--bg-btm) 100%);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    /* ===== Utilities ===== */
    .gradient-text{
      background: linear-gradient(90deg,#60a5fa,#a78bfa,#34d399);
      -webkit-background-clip:text; background-clip:text; color:transparent;
    }
    .glass{
      background: rgba(255,255,255,.05);
      border: 1px solid var(--hairline);
      border-radius:16px;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      box-shadow: 0 10px 30px rgba(59,130,246,.20);
    }

    /* ===== Header ===== */
    .header{ max-width:960px; margin:0 auto 16px; padding:16px 18px; }
    h1{ margin:0 0 6px; font-size:22px; font-weight:800; color:#fff; }
    .run-meta{ color:var(--text-muted); display:grid; gap:4px; }

    /* ===== Chips ===== */
    .summary{ display:flex; flex-wrap:wrap; gap:12px; margin:16px auto 20px; max-width:960px; }
    .pill{
      border:1px solid var(--chip-border);
      background: rgba(255,255,255,.06);
      padding:6px 12px; border-radius:999px; font-size:12px; color:var(--text);
      letter-spacing:.2px;
    }
    .pill.ok{ background: var(--chip-ok-bg); color: var(--ok); border-color: var(--chip-ok-border); font-weight:700; }
    .pill.bad{ background: var(--chip-bad-bg); color: var(--bad); border-color: var(--chip-bad-border); font-weight:700; }

    /* ===== Disclosure blocks ===== */
    details{ background: rgba(255,255,255,.05); border:1px solid var(--hairline); border-radius:16px; margin:10px 0; overflow:hidden; }
    summary{
      cursor:pointer; padding:14px 16px; display:flex; align-items:center; gap:12px;
      color:#fff; background: rgba(255,255,255,.04);
    }
    .mission-group > summary{ font-weight:800; font-size:15px; letter-spacing:.2px; }
    .mission-group > summary:hover{ background: rgba(255,255,255,.08); }

    .group-body{ padding:12px; display:grid; gap:10px; }

    .mission-submission > summary{
      font-weight:700; background: rgba(255,255,255,.06); border-top:1px solid var(--hairline);
    }
    .mission-submission > summary:hover{ background: rgba(255,255,255,.08); }

    .name{ flex:1; }
    .status.ok{ color: var(--ok); font-weight:700; }
    .status.bad{ color: var(--bad); font-weight:700; }
    .meta{ color: var(--text-muted); font-size:12px; }

    .steps{ padding: 0 12px 12px; }
    .step summary{
      background: rgba(255,255,255,.04);
      border:1px solid var(--hairline);
      border-radius:12px;
    }
    .step summary:hover{ background: rgba(255,255,255,.08); }

    .turn{ font-weight:700; }
    .plan{
      flex:1; color: var(--text-muted); font-size:12px;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .step-result.ok{ color: var(--ok); font-weight:700; }
    .step-result.bad{ color: var(--bad); font-weight:700; }
    .tokens{ color: var(--text-muted); font-size:12px; margin-left:auto; font-variant-numeric: tabular-nums; }

    .events{
      background: rgba(2,6,23,.9); /* near #020617 */
      color: rgba(255,255,255,.92);
      padding:12px; border-radius:12px; margin:12px 0 0;
      font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New";
      max-height:320px; overflow:auto; white-space:pre-wrap;
      border: 1px solid var(--hairline-strong);
    }

    img{
      display:block; max-width:100%;
      border:1px solid var(--hairline); border-radius:12px; margin-top:10px;
      background: rgba(0,0,0,.2);
    }

    /* container width */
    .container{ max-width:960px; margin:0 auto; }
    .empty{ color: var(--text-muted); padding:12px; }
  </style>
</head>
<body>
  <div class="header glass">
    <h1>🧑‍🚀 <span class="gradient-text">Testronaut Report</span></h1>
    <div class="run-meta">
      <div><strong>Run ID:</strong> ${esc(runId ?? '—')}</div>
      <div><strong>Start:</strong> ${esc(startTime ?? '—')}</div>
      <div><strong>End:</strong> ${esc(endTime ?? '—')} • <strong>Duration:</strong> ${durationSec}s</div>
      <div><strong>LLM:</strong> ${esc(llm.provider ?? '—')} • <strong>Model:</strong> ${esc(llm.model ?? '—')}</div>
    </div>
  </div>

  <div class="summary">
    <div class="pill">Missions: ${esc(summary.totalMissions ?? totals.total)}</div>
    <div class="pill ok">Passed: ${esc(summary.passed ?? totals.passed)}</div>
    <div class="pill bad">Failed: ${esc(summary.failed ?? totals.failed)}</div>
    <div class="pill">LLM: ${esc(llm.provider ?? '—')} • ${esc(llm.model ?? '')}</div>
  </div>

  <div class="container">
    ${groupsHtml || '<div class="glass empty">No missions recorded.</div>'}
  </div>
</body>
</html>`;

  const out = outputPath ?? path.resolve('missions/mission_reports', `${runId || 'report'}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`📝 Report generated at: ${out}`);
  return out;
}
