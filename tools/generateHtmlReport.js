/**
 * generateHtmlReport.js
 * ---------------------
 * Purpose:
 *   Render a Testronaut run summary into a single, self-contained HTML file.
 *
 * Responsibilities:
 *   - Escape and format mission/step data into a readable report.
 *   - Group submissions by mission and surface per-step metadata (tokens, retries).
 *   - Write the HTML to disk at the provided output path (or a default location).
 *
 * Related tests:
 *   tests/toolsTests/generateHtmlReport.test.js
 *
 * Used by:
 *   - CLI report generation and upload flows.
 */
import fs from 'fs';
import path from 'path';
import { normalizeTags } from '../core/tags.js';

/**
 * Render and write a Testronaut run report to disk.
 *
 * @param {object} report - normalized run JSON (runId, missions, summary, llm, etc.)
 * @param {string} [outputPath] - optional absolute/relative path for the HTML file
 * @returns {string} absolute path to the written HTML file
 */
export function generateHtmlReport(report, outputPath) {
  const { runId, startTime, endTime, missions = [], summary = {}, llm = {}, cli = {} } = report;
  const reportTags = normalizeTags(report.tags ?? missions.flatMap(m => m.submissionType === 'mission' ? (m.tags ?? []) : []));
  const durationSec =
    (startTime && endTime)
      ? ((new Date(endTime) - new Date(startTime)) / 1000).toFixed(2)
      : '—';

  // Escaping helpers for text and HTML attributes
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const badge = (status) =>
    status === 'passed' ? '✅ Passed' :
    status === 'failed' ? '❌ Failed' : (status || '—');
  const providerKey = String(llm.provider ?? '').trim().toLowerCase() === 'claude'
    ? 'anthropic'
    : String(llm.provider ?? '').trim().toLowerCase();
  const provider = {
    openai: { name: 'OpenAI', logo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>' },
    anthropic: { name: 'Anthropic', logo: '<img src="data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8dGl0bGU+Q2xhdWRlPC90aXRsZT4KICA8cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjRDk3NzU3Ii8+CiAgPHBhdGggZmlsbD0iI2ZmZiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMyAzKSBzY2FsZSguNzUpIiBkPSJNNC43MDkgMTUuOTU1bDQuNzItMi42NDcuMDgtLjIzLS4wOC0uMTI4SDkuMmwtLjc5LS4wNDgtMi42OTgtLjA3My0yLjMzOS0uMDk3LTIuMjY2LS4xMjItLjU3MS0uMTIxTDAgMTEuNzg0bC4wNTUtLjM1Mi40OC0uMzIxLjY4Ni4wNiAxLjUyLjEwMyAyLjI3OC4xNTggMS42NTIuMDk3IDIuNDQ5LjI1NWguMzg5bC4wNTUtLjE1Ny0uMTM0LS4wOTgtLjEwMy0uMDk3LTIuMzU4LTEuNTk2LTIuNTUyLTEuNjg4LTEuMzM2LS45NzItLjcyNC0uNDkxLS4zNjQtLjQ2Mi0uMTU4LTEuMDA4LjY1Ni0uNzIyLjg4MS4wNi4yMjUuMDYxLjg5My42ODYgMS45MDggMS40NzYgMi40OTEgMS44MzMuMzY1LjMwNC4xNDUtLjEwMy4wMTktLjA3My0uMTY0LS4yNzQtMS4zNTUtMi40NDYtMS40NDYtMi40OS0uNjQ0LTEuMDMyLS4xNy0uNjE5YTIuOTcgMi45NyAwIDAxLS4xMDQtLjcyOUw2LjI4My4xMzQgNi42OTYgMGwuOTk2LjEzNC40Mi4zNjQuNjIgMS40MTQgMS4wMDIgMi4yMjkgMS41NTUgMy4wMy40NTYuODk4LjI0My44MzIuMDkxLjI1NWguMTU4VjkuMDFsLjEyOC0xLjcwNi4yMzctMi4wOTUuMjMtMi42OTUuMDgtLjc2LjM3Ni0uOTEuNzQ3LS40OTIuNTg0LjI4LjQ4LjY4NS0uMDY3LjQ0NC0uMjg2IDEuODUxLS41NTkgMi45MDMtLjM2NCAxLjk0MmguMjEybC4yNDMtLjI0Mi45ODUtMS4zMDYgMS42NTItMi4wNjQuNzMtLjgyLjg1LS45MDQuNTQ3LS40MzFoMS4wMzNsLjc2IDEuMTI5LS4zNCAxLjE2Ni0xLjA2NCAxLjM0Ny0uODgxIDEuMTQyLTEuMjY0IDEuNy0uNzkgMS4zNi4wNzMuMTEuMTg4LS4wMiAyLjg1Ni0uNjA2IDEuNTQzLS4yOCAxLjg0MS0uMzE1LjgzMy4zODguMDkxLjM5NS0uMzI4LjgwNy0xLjk2OS40ODYtMi4zMDkuNDYyLTMuNDM5LjgxMy0uMDQyLjAzLjA0OS4wNjEgMS41NDkuMTQ2LjY2Mi4wMzZoMS42MjJsMy4wMi4yMjUuNzkuNTIyLjQ3NC42MzgtLjA3OS40ODUtMS4yMTUuNjItMS42NC0uMzg5LTMuODI5LS45MS0xLjMxMi0uMzI5aC0uMTgydi4xMWwxLjA5MyAxLjA2OCAyLjAwNiAxLjgxIDIuNTA5IDIuMzMuMTI3LjU3OC0uMzIyLjQ1NS0uMzQtLjA0OS0yLjIwNS0xLjY1Ny0uODUxLS43NDctMS45MjYtMS42MmgtLjEyOHYuMTdsLjQ0NC42NDkgMi4zNDUgMy41MjEuMTIyIDEuMDgtLjE3LjM1My0uNjA4LjIxMy0uNjY4LS4xMjItMS4zNzQtMS45MjUtMS40MTUtMi4xNjctMS4xNDMtMS45NDMtLjE0LjA4LS42NzQgNy4yNTQtLjMxNi4zNy0uNzI5LjI4LS42MDctLjQ2MS0uMzIyLS43NDcuMzIyLTEuNDc2LjM4OS0xLjkyNC4zMTUtMS41My4yODYtMS45LjE3LS42MzItLjAxMi0uMDQyLS4xNC4wMTgtMS40MzQgMS45NjctMi4xOCAyLjk0NS0xLjcyNiAxLjg0NS0uNDE0LjE2NC0uNzE3LS4zNy4wNjctLjY2Mi40MDEtLjU4OSAyLjM4OC0zLjAzNiAxLjQ0LTEuODgyLjkzLTEuMDg2LS4wMDYtLjE1OGgtLjA1NUw0LjEzMiAxOC41NmwtMS4xMy4xNDYtLjQ4Ny0uNDU2LjA2MS0uNzQ2LjIzMS0uMjQzIDEuOTA4LTEuMzEyLS4wMDYuMDA2eiIvPgo8L3N2Zz4K" alt="" />' },
  }[providerKey] ?? { name: llm.provider || 'Unknown provider', logo: '' };
  const tagPalette = [
    ['#60a5fa', 'rgba(96,165,250,.18)'], ['#a78bfa', 'rgba(167,139,250,.18)'],
    ['#34d399', 'rgba(52,211,153,.18)'], ['#f472b6', 'rgba(244,114,182,.18)'],
    ['#fbbf24', 'rgba(251,191,36,.18)'], ['#22d3ee', 'rgba(34,211,238,.18)'],
  ];
  const tagStyle = (tag) => {
    const index = [...tag].reduce((sum, char) => sum + char.charCodeAt(0), 0) % tagPalette.length;
    const [color, background] = tagPalette[index];
    return `color:${color};background:${background};border-color:${color}66`;
  };

  const submissionBlock = (m) => {
    const mDurationSec =
      m.endTime && m.startTime
        ? ((m.endTime - m.startTime) / 1000).toFixed(2)
        : (typeof m.durationSeconds === 'number' ? m.durationSeconds.toFixed(2) : '—');

    const steps = Array.isArray(m.steps) ? m.steps : [];
    const stepItems = steps.map((step, idx) => {
      const events = Array.isArray(step.events) ? step.events : [];
      const ok = /✅|Passed|Mission Success/i.test(step.result || '');
      const resultRaw = step.result || '—';
      const resultTooltip = resultRaw.includes('⚠️ Turn Issues')
        ? 'Turn had tool/action issues (e.g., selector/timeouts). It may not indicate a product bug.'
        : '';
      const retryAttempt = step.retryAttempt || 1; // includes initial
      const retryLimit = step.retryLimit; // number of retries allowed (excludes initial)
      const retryNumber = retryAttempt - 1;
      const retryTotal = Number.isFinite(retryLimit) ? retryLimit : Math.max(retryNumber, 0);
      const attemptLabel = retryNumber > 0
        ? ` (re-attempt ${retryNumber}/${retryTotal || retryNumber})`
        : '';
      const humanInput = step.humanInput?.requested
        ? `<span class="hitl" title="Human-in-the-loop input: ${esc(step.humanInput.status || 'requested')}">👤 Human in-the-loop</span>`
        : '';
      const imgTag = step.screenshotPath
        ? `<img src="${esc(step.screenshotPath)}" alt="screenshot turn ${esc(step.turn ?? idx)}">`
        : '';

      const plan = (typeof step.summary === 'string' && step.summary.trim())
        ? step.summary.trim()
        : '';
      const planSpan = plan
        ? `<span class="plan" title="${esc(plan)}">${esc(plan)}</span>`
        : '';

      return `
        <details class="step" ${ok ? '' : 'open'}>
          <summary>
            <span class="turn">Turn ${esc((step.turn ?? idx) + 1)}${esc(attemptLabel)}</span>
            ${humanInput}
            ${planSpan}
            <span class="step-result ${ok ? 'ok' : 'bad'}" ${resultTooltip ? `title="${esc(resultTooltip)}"` : ''}>${esc(resultRaw)}</span>
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
          <span class="toolbar">
            <button class="btn-mini toggle" data-scope="submission" aria-label="Expand">▼</button>
          </span>
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
    const startTimes = subs.map(s => s.startTime || 0).filter(Boolean);
    const endTimes = subs.map(s => s.endTime || 0).filter(Boolean);
    const firstStart = startTimes.length ? Math.min(...startTimes) : null;
    const lastEnd = endTimes.length ? Math.max(...endTimes) : null;
    const groupDur = (firstStart != null && lastEnd != null) ? ((lastEnd - firstStart) / 1000).toFixed(2) : '—';
    const tags = normalizeTags(subs.flatMap(s => s.submissionType === 'mission' ? (s.tags ?? []) : []));
    const sourceFiles = [...new Set(subs.map(s => s.file).filter(Boolean))];

    // pre → mission → post
    const order = { premission: 0, mission: 1, postmission: 2 };
    subs.sort((a, b) =>
      (order[(a.submissionType || 'mission')] ?? 1) -
      (order[(b.submissionType || 'mission')] ?? 1)
    );

    return `
      <details class="mission-group" data-tags="${esc(tags.join(','))}">
        <summary>
          <span class="name">${esc(missionName)}</span>
          <span class="mission-tags">${tags.map(tag => `<span class="tag-small" style="${tagStyle(tag)}">${esc(tag)}</span>`).join('')}</span>
          <span class="status ${status === 'failed' ? 'bad' : 'ok'}">${badge(status)}</span>
          <span class="meta">${sourceFiles.length ? `${sourceFiles.map(esc).join(', ')} • ` : ''}submissions: ${subs.length} • steps: ${totalSteps} • duration: ${groupDur}s</span>
          <span class="toolbar">
            <button class="btn-mini toggle" data-scope="mission" aria-label="Expand">▼</button>
          </span>
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
    .provider-meta{ display:inline-flex; align-items:center; gap:7px; }
    .provider-logo{ width:20px; height:20px; color:var(--text); flex:none; }
    .provider-logo img,.provider-logo svg{ display:block; width:20px; height:20px; border:0; border-radius:0; margin:0; background:transparent; }

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
    .tag-filter{max-width:928px;margin:0 auto 20px;padding:18px 16px;background:rgba(2,6,23,.30);}
    .tag-filter-heading{display:flex;align-items:center;gap:7px;margin-bottom:12px;flex-wrap:wrap;}
    .tag-filter-title{font-size:14px;color:var(--text);font-weight:800;}
    .info{display:inline-grid;place-items:center;width:17px;height:17px;border:1px solid var(--chip-border);border-radius:50%;font-size:11px;color:var(--text-muted);cursor:help;}
    .match-count{margin-left:auto;color:var(--text-muted);font-size:12px;}
    .tag-buttons,.mission-tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
    .tag-button,.tag-small{border:1px solid var(--chip-border);background:rgba(255,255,255,.06);color:var(--text);border-radius:999px;padding:5px 10px;font-size:11px;font-weight:700;}
    .tag-button{cursor:pointer;transition:transform .15s ease,background .15s ease}.tag-button:hover{transform:translateY(-1px);background:rgba(255,255,255,.11)}.tag-button.active{box-shadow:0 0 0 2px rgba(96,165,250,.38);}
    .filter-controls{display:flex;gap:16px;align-items:center;margin-top:14px;font-size:12px;color:var(--text-muted);flex-wrap:wrap;}
    .filter-controls select{color:var(--text);background:#111a31;border:1px solid var(--chip-border);border-radius:8px;padding:6px 24px 6px 8px;}
    .show-control{cursor:help;display:flex;align-items:center;gap:5px;}
    .filter-empty{max-width:928px;margin:12px auto;padding:28px 16px;text-align:center;border:1px dashed var(--hairline-strong);border-radius:16px;color:var(--text-muted);}
    .filter-empty strong{display:block;color:var(--text);font-size:18px;margin-bottom:6px;}
    .mission-group.nonmatching{opacity:.45;}
    @media(max-width:640px){.match-count{width:100%;margin-left:0}.tag-filter{padding:14px 12px}.meta{display:none}}

    /* ===== Disclosure blocks ===== */
    details{ background: rgba(255,255,255,.05); border:1px solid var(--hairline); border-radius:16px; margin:10px 0; overflow:hidden; }
    summary{
      cursor:pointer; padding:14px 16px; display:flex; align-items:center; gap:12px;
      color:#fff; background: rgba(255,255,255,.04);
    }
    .mission-group > summary{ font-weight:800; font-size:15px; letter-spacing:.2px; }
    .mission-group > summary:hover{ background: rgba(255,255,255,.08); }

    .group-body{ padding:12px; display:grid; gap:10px; }
    // .toolbar{display:flex; gap:8px; margin-left:auto;}
    // .btn-mini{
    //   font-size:11px; padding:4px 8px; border-radius:8px;
    //   background: rgba(255,255,255,.06); color: var(--text);
    //   border:1px solid var(--hairline); cursor:pointer;
    // }
    // .btn-mini:hover{ background: rgba(255,255,255,.10); }

    .toolbar{display:flex; gap:8px; margin-left:auto;}
    .btn-mini{
      font-size:12px; padding:2px 8px; border-radius:8px;
      background: rgba(255,255,255,.06); color: var(--text);
      border:1px solid var(--hairline); cursor:pointer; line-height:1.2;
      width:28px; text-align:center;
    }
    .btn-mini:hover{ background: rgba(255,255,255,.10); }

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
    .hitl{
      color:#fbbf24; border:1px solid rgba(251,191,36,.45);
      background:rgba(251,191,36,.12); border-radius:999px;
      padding:2px 8px; font-size:12px; font-weight:700;
    }
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
      <div class="provider-meta"><span class="provider-logo" title="${esc(provider.name)}" aria-label="${esc(provider.name)}">${provider.logo}</span><strong>${esc(llm.model ?? '—')}</strong></div>
      <div><strong>Run ID:</strong> ${esc(runId ?? '—')}</div>
      <div><strong>Start:</strong> ${esc(startTime ?? '—')}</div>
      <div><strong>End:</strong> ${esc(endTime ?? '—')}</div>
      <div><strong>Duration:</strong> ${durationSec}s</div>
      <div><strong>CLI version:</strong> ${esc(cli.version ?? '—')}</div>
    </div>
  </div>

  <div class="summary">
    <div class="pill">Missions: ${esc(summary.totalMissions ?? totals.total)}</div>
    <div class="pill ok">Passed: ${esc(summary.passed ?? totals.passed)}</div>
    <div class="pill bad">Failed: ${esc(summary.failed ?? totals.failed)}</div>
  </div>

  <div class="tag-filter glass">
    <div class="tag-filter-heading">
      <span class="tag-filter-title">Filter missions by tag</span>
      <span class="info" title="Select one or more tags to focus the report. Match Any uses OR; Match All requires every selected tag.">i</span>
      <span class="match-count" id="match-count">${totals.total} of ${totals.total} missions match</span>
    </div>
    <div class="tag-buttons">
      ${reportTags.map(tag => `<button type="button" class="tag-button" data-tag="${esc(tag)}" style="${tagStyle(tag)}">${esc(tag)}</button>`).join('')}
      <button type="button" class="tag-button" data-tag="untagged">untagged</button>
    </div>
    <div class="filter-controls">
      <label>Match <select id="tag-match"><option value="any">any</option><option value="all">all</option></select></label>
      <label class="show-control" title="Keep missions that do not match visible in a muted style instead of hiding them."><input id="show-nonmatching" type="checkbox"> Show nonmatching missions <span class="info">i</span></label>
      <button type="button" id="clear-tags" class="tag-button" hidden>Clear filters</button>
    </div>
  </div>

  <div class="container">
    ${groupsHtml || '<div class="glass empty">No missions recorded.</div>'}
  </div>
  <div class="filter-empty" id="filter-empty" hidden>
    <strong>No missions match these tags</strong>
    Try removing a tag, switching to “Any,” or showing nonmatching missions.
  </div>
  <script>
  (function () {
    var selectedTags = [];
    function applyTagFilter() {
      var match = document.getElementById('tag-match');
      var show = document.getElementById('show-nonmatching');
      var matchedCount = 0;
      var totalCount = 0;
      document.querySelectorAll('.mission-group').forEach(function (group) {
        totalCount += 1;
        var tags = (group.getAttribute('data-tags') || '').split(',').filter(Boolean);
        var test = function (tag) { return tag === 'untagged' ? tags.length === 0 : tags.indexOf(tag) >= 0; };
        var matches = !selectedTags.length || ((match && match.value === 'all') ? selectedTags.every(test) : selectedTags.some(test));
        if (matches) matchedCount += 1;
        group.hidden = !matches && !(show && show.checked);
        group.classList.toggle('nonmatching', !matches);
      });
      var count = document.getElementById('match-count');
      var empty = document.getElementById('filter-empty');
      var clear = document.getElementById('clear-tags');
      if (count) count.textContent = matchedCount + ' of ' + totalCount + ' missions match';
      if (empty) empty.hidden = matchedCount !== 0 || !selectedTags.length || !!(show && show.checked);
      if (clear) clear.hidden = selectedTags.length === 0;
    }
    document.querySelectorAll('.tag-button[data-tag]').forEach(function (button) {
      button.addEventListener('click', function () {
        var tag = button.getAttribute('data-tag');
        var idx = selectedTags.indexOf(tag);
        if (idx >= 0) selectedTags.splice(idx, 1); else selectedTags.push(tag);
        button.classList.toggle('active', idx < 0);
        applyTagFilter();
      });
    });
    var tagMatch = document.getElementById('tag-match');
    var showNonmatching = document.getElementById('show-nonmatching');
    var clearTags = document.getElementById('clear-tags');
    if (tagMatch) tagMatch.addEventListener('change', applyTagFilter);
    if (showNonmatching) showNonmatching.addEventListener('change', applyTagFilter);
    if (clearTags) clearTags.addEventListener('click', function () {
      selectedTags = [];
      document.querySelectorAll('.tag-button[data-tag]').forEach(function (button) { button.classList.remove('active'); });
      applyTagFilter();
    });
    applyTagFilter();
    function setOpenAll(root, selector, open) {
      root.querySelectorAll(selector).forEach(function (el) {
        if (el && 'open' in el) el.open = open;
      });
    }
    function areAllOpen(root, selector) {
      var list = root.querySelectorAll(selector);
      if (!list.length) return false;
      for (var i=0;i<list.length;i++) { if (!list[i].open) return false; }
      return true;
    }
    function refreshBtn(btn) {
      var scope = btn.getAttribute('data-scope');
      var root = btn.closest(scope === 'mission' ? '.mission-group' : '.mission-submission');
      if (!root) return;
      var allOpen = scope === 'mission'
        ? (areAllOpen(root, '.mission-submission') && areAllOpen(root, '.mission-submission .step'))
        : areAllOpen(root, '.step');
      btn.textContent = allOpen ? '▲' : '▼';
      btn.setAttribute('aria-label', allOpen ? 'Collapse' : 'Expand');
      btn.dataset.open = allOpen ? 'true' : 'false';
    }

    // Click handler (single toggle)
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('button.toggle');
      if (!btn) return;
      e.preventDefault(); e.stopPropagation();

      var scope = btn.getAttribute('data-scope');
      var root = btn.closest(scope === 'mission' ? '.mission-group' : '.mission-submission');
      if (!root) return;

      var currentlyOpen = btn.dataset.open === 'true';
      var nextOpen = !currentlyOpen;

      if (scope === 'mission') {
        root.open = true; // ensure visible
        setOpenAll(root, '.mission-submission', nextOpen);
        setOpenAll(root, '.mission-submission .step', nextOpen);
      } else {
        root.open = true;
        setOpenAll(root, '.step', nextOpen);
      }
      refreshBtn(btn);
    }, true);

    // Keep arrows in sync if user toggles details manually
    document.addEventListener('toggle', function () {
      document.querySelectorAll('button.toggle').forEach(refreshBtn);
    }, true);

    // Initial refresh
    document.querySelectorAll('button.toggle').forEach(refreshBtn);
  })();
  </script>


</body>
</html>`;

  const out = outputPath ?? path.resolve('missions/mission_reports', `${runId || 'report'}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`📝 Report generated at: ${out}`);
  return out;
}
