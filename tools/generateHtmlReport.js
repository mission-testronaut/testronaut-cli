import fs from 'fs';
import path from 'path';

export function generateHtmlReport(report, outputPath) {
  const { runId, startTime, endTime, missions = [], summary = {} } = report;
  const durationSec = ((new Date(endTime) - new Date(startTime)) / 1000).toFixed(2);

  // tiny helpers
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const badge = (status) =>
    status === 'passed' ? '✅ Passed' :
    status === 'failed' ? '❌ Failed' : (status || '—');

  const missionBlock = (m, idx) => {
    const mDurationSec = m.endTime && m.startTime
      ? ((m.endTime - m.startTime) / 1000).toFixed(2)
      : '—';

    const steps = Array.isArray(m.steps) ? m.steps : [];
    const stepItems = steps.map(step => {
      const events = Array.isArray(step.events) ? step.events : [];
      const imgTag = step.screenshotPath
        ? `<img src="${esc(step.screenshotPath)}" alt="screenshot turn ${esc(step.turn)}">`
        : '';
      return `
        <details class="step" ${/Mission Success|Passed/.test(step.result||'') ? '' : 'open'}>
          <summary>
            <span class="turn">Turn ${esc((step.turn ?? 0) + 1)}</span>
            <span class="step-result ${/✅/.test(step.result||'') ? 'ok' : 'bad'}">${esc(step.result || '')}</span>
            <span class="tokens">tokens: ${esc(step.tokensUsed ?? '—')} / total: ${esc(step.totalTokensUsed ?? '—')}</span>
          </summary>
          <pre class="events">${esc(events.join('\n')) || '(no events)'}</pre>
          ${imgTag}
        </details>
      `;
    }).join('');

    return `
      <details class="mission">
        <summary>
          <span class="name">${esc(m.missionName || path.basename(m.file || `mission_${idx+1}`))}</span>
          <span class="status ${m.status === 'passed' ? 'ok' : (m.status === 'failed' ? 'bad' : '')}">${badge(m.status)}</span>
          <span class="meta">steps: ${steps.length} • duration: ${mDurationSec}s • file: ${esc(m.file || '')}</span>
        </summary>
        <div class="steps">
          ${stepItems || '<div class="empty">No steps recorded.</div>'}
        </div>
      </details>
    `;
  };

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Testronaut Report – ${esc(runId)}</title>
  <style>
    :root {
      --ok: #16a34a;
      --bad: #dc2626;
      --muted: #6b7280;
      --bg: #f8fafc;
      --card: #ffffff;
      --border: #e5e7eb;
      --mono: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
    }
    body { margin:0; padding:24px; font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; background: var(--bg); color:#111827; }
    h1 { margin: 0 0 6px 0; font-size: 20px; }
    .run-meta { color: var(--muted); margin-bottom: 16px; }
    .summary { display:flex; gap:12px; margin: 12px 0 20px; }
    .pill { border:1px solid var(--border); background: var(--card); padding:6px 10px; border-radius:999px; font-size:12px; }
    .pill.ok { border-color: #bbf7d0; background:#ecfdf5; color: var(--ok); }
    .pill.bad { border-color: #fecaca; background:#fef2f2; color: var(--bad); }

    details { background: var(--card); border:1px solid var(--border); border-radius:10px; margin:10px 0; }
    summary { cursor:pointer; padding:12px 14px; display:flex; align-items:center; gap:12px; }
    .mission > summary { font-weight:600; }
    .name { flex:1; }
    .status.ok { color: var(--ok); }
    .status.bad { color: var(--bad); }
    .meta { color: var(--muted); font-size:12px; }

    .steps { padding: 0 14px 12px; }
    .step summary { background: #fafafa; border-bottom:1px solid var(--border); border-radius: 10px 10px 0 0; }
    .turn { font-weight:600; }
    .step-result.ok { color: var(--ok); }
    .step-result.bad { color: var(--bad); }
    .tokens { color: var(--muted); font-size:12px; margin-left:auto; }
    .events { background:#0b1020; color:#e5e7eb; padding:12px; border-radius:8px; margin:12px 0 0; font: 12px/1.4 var(--mono); max-height: 280px; overflow:auto; }
    img { display:block; max-width:100%; border:1px solid var(--border); border-radius:8px; margin-top:10px; }
    .empty { color: var(--muted); padding: 12px; }
  </style>
</head>
<body>
  <h1>🧑‍🚀 Testronaut Report</h1>
  <div class="run-meta">
    <div><strong>Run ID:</strong> ${esc(runId)}</div>
    <div><strong>Start:</strong> ${esc(startTime)}</div>
    <div><strong>End:</strong> ${esc(endTime)} • <strong>Duration:</strong> ${durationSec}s</div>
  </div>

  <div class="summary">
    <div class="pill">Missions: ${esc(summary.totalMissions ?? missions.length)}</div>
    <div class="pill ok">Passed: ${esc(summary.passed ?? missions.filter(m=>m.status==='passed').length)}</div>
    <div class="pill bad">Failed: ${esc(summary.failed ?? missions.filter(m=>m.status==='failed').length)}</div>
  </div>

  ${missions.map(missionBlock).join('')}

</body>
</html>
  `;

  const out = outputPath ?? path.resolve('missions/mission_reports', `${runId}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`📝 Report generated at: ${out}`);
  return out;
}
