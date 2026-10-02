const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  orange: '\u001b[38;5;208m',
  cyan: '\u001b[38;5;81m',
  teal: '\u001b[38;5;43m',
  red: '\u001b[38;5;203m',
  cream: '\u001b[38;5;230m',
};

export function shouldUseColor(stream = process.stdout, env = process.env) {
  return Boolean(stream?.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb';
}

export function createTerminalUi({
  stream = process.stdout,
  color = shouldUseColor(stream),
  quiet = false,
} = {}) {
  const paint = (codes, value) => color ? `${codes}${value}${ANSI.reset}` : String(value);
  const write = value => {
    if (!quiet) stream.write(`${value}\n`);
  };
  const label = value => paint(`${ANSI.bold}${ANSI.orange}`, value.padEnd(10));

  return {
    banner({ version, provider, model, session }) {
      write(paint(`${ANSI.bold}${ANSI.cream}`, '🧑‍🚀 TESTRONAUT  /  MISSION RUNNER'));
      write(paint(ANSI.dim, `   v${version}  •  ${provider}/${model}  •  ${session}`));
      write(paint(ANSI.dim, '   ─────────────────────────────────────────'));
    },
    phase(name, message) {
      write(`${label(name.toUpperCase())}${paint(ANSI.cyan, message)}`);
    },
    mission(selected, file, tags = []) {
      const marker = selected ? paint(ANSI.teal, '●') : paint(ANSI.dim, '○');
      const tagText = tags.length ? paint(ANSI.dim, `  ${tags.map(tag => `#${tag}`).join(' ')}`) : '';
      write(`   ${marker} ${file}${tagText}`);
    },
    summary({ totalMissions = 0, passed = 0, failed = 0, reportPath }) {
      const status = failed === 0
        ? paint(`${ANSI.bold}${ANSI.teal}`, 'MISSION COMPLETE')
        : paint(`${ANSI.bold}${ANSI.red}`, 'MISSION NEEDS REVIEW');
      write('');
      write(`${label('COMPLETE')}${status}`);
      write(`   ${paint(ANSI.teal, `${passed} passed`)}  ${paint(failed ? ANSI.red : ANSI.dim, `${failed} failed`)}  ${paint(ANSI.dim, `${totalMissions} total`)}`);
      if (reportPath) write(paint(ANSI.dim, `   Report: ${reportPath}`));
    },
  };
}
