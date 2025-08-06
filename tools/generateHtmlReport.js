import fs from 'fs';

export function generateHtmlReport(report, outputPath) {
  const { runId, startTime, endTime, summary, missions } = report;

  const missionHtml = missions.map(m => {
    const status = m.status?.toUpperCase?.() || 'UNKNOWN';
    const missionName = m.missionName || 'Unnamed';
    const file = m.file || 'N/A';
    const steps = Array.isArray(m.steps) ? m.steps : [];

    return `
      <div class="mission ${status.toLowerCase()}">
        <h3>${file} - ${missionName} - <span>${status}</span></h3>
        <p><em>${m.startTime || 'N/A'} → ${m.endTime || 'N/A'}</em></p>
        <ul>
          ${steps.map(step => `
            <li>
              <strong>${step.tool}</strong> → ${step.output}
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }).join('');

  const html = `
    <html>
    <head>
      <style>
        body { font-family: sans-serif; padding: 20px; }
        .passed { background-color: #e6ffed; }
        .failed { background-color: #ffe6e6; }
        .unknown { background-color: #f9f9f9; }
        h3 span { font-weight: bold; }
        ul { margin-top: 0; }
      </style>
    </head>
    <body>
      <h1>🧑‍🚀 Testronaut Report</h1>
      <p><strong>Run ID:</strong> ${runId}</p>
      <p><strong>Start:</strong> ${startTime}</p>
      <p><strong>End:</strong> ${endTime}</p>
      <p><strong>Summary:</strong> ${summary.passed}/${summary.totalMissions} passed</p>
      ${missionHtml}
    </body>
    </html>
  `;

  fs.writeFileSync(outputPath, html);
  console.log(`📝 Report generated at: ${outputPath}`);
}
