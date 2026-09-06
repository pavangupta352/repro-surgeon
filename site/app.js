(() => {
  'use strict';
  const data = window.REPRO_RECORDING;
  const byId = id => document.getElementById(id);
  const command = `npx repro-surgeon@${data?.tool || "latest"} demo --out ./rounding-repro`;
  byId('demo-command').textContent = command;
  byId('copy').disabled = false;
  byId('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(command); byId('copy-status').textContent = 'Copied. Run it in your terminal from a directory outside the Repro Surgeon source checkout.'; }
    catch { const range = document.createRange(); range.selectNodeContents(byId('demo-command')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); byId('copy-status').textContent = 'Select and copy the highlighted command, then run it in your terminal.'; }
  });
  if (!data || !Array.isArray(data.accepted) || !data.final?.sourceBytes) {
    byId('terminal').textContent = 'The recording could not load. Open the full report below, or reload this page.';
    byId('playback-status').textContent = 'Recording unavailable.';
    document.querySelectorAll('[data-stage]').forEach(button => { button.disabled = true; });
    return;
  }
  const number = value => Number(value).toLocaleString('en');
  const buttons = [...document.querySelectorAll('[data-stage]')];
  let timer;
  let playing = false;
  function stop() { clearTimeout(timer); playing = false; byId('play').textContent = 'Replay recorded run'; }
  function show(stage, acceptedIndex = data.accepted.length - 1) {
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.stage === stage)));
    const trial = data.accepted[acceptedIndex];
    const current = stage === 'failure' ? data.initial : stage === 'verification' ? data.final : trial.after;
    byId('source-bytes').textContent = number(current.sourceBytes);
    byId('file-count').textContent = `${current.files} files`;
    byId('reduction-amount').textContent = current.sourceBytes < data.initial.sourceBytes ? `${Math.round((1 - current.sourceBytes / data.initial.sourceBytes) * 100)}% removed` : '';
    const removed = new Set();
    if (stage !== 'failure') for (const entry of data.accepted.slice(0, stage === 'verification' ? undefined : acceptedIndex + 1)) if (entry.kind === 'files') entry.paths.forEach(name => removed.add(name));
    byId('file-tree').replaceChildren(...data.originalFiles.map(name => { const li = document.createElement('li'); li.textContent = name; if (removed.has(name)) li.className = 'removed'; return li; }));
    byId('status').className = stage === 'verification' ? 'status positive' : 'status';
    if (stage === 'failure') {
      byId('stage-title').textContent = 'The application fails';
      byId('status').textContent = 'Expected failure';
      byId('stage-detail').textContent = 'The check catches a rounding error: line totals must round only once.';
      byId('terminal').textContent = `$ node check.mjs\n\n${data.failureExcerpt}`;
      byId('terminal-caption').textContent = `Actual baseline excerpt · ${data.baseline.completed}/${data.baseline.required} matching observations recorded.`;
      byId('playback-status').textContent = `${data.initial.files} files before reduction. Select a stage, or replay the recorded run.`;
    } else if (stage === 'reduction') {
      byId('stage-title').textContent = trial.kind === 'files' ? 'Remove unused files' : 'Trim the remaining source';
      byId('status').textContent = 'Failure preserved';
      byId('stage-detail').textContent = trial.description;
      byId('terminal').textContent = `Candidate ${trial.index}\n${trial.description}\n\n${number(trial.before.sourceBytes)} → ${number(trial.after.sourceBytes)} source bytes\n${trial.confirmations} matching executions · accepted`;
      byId('terminal-caption').textContent = 'Accepted decision from the recorded run. Rejected and invalid trials remain in the full report.';
      byId('playback-status').textContent = `Accepted change ${acceptedIndex + 1} of ${data.accepted.length}. Playback is condensed.`;
    } else {
      byId('stage-title').textContent = 'The export reproduces independently';
      byId('status').textContent = 'Fresh verification passed';
      byId('stage-detail').textContent = 'A fresh dependency installation and repeated checks confirm the exported source preserves the configured failure.';
      byId('terminal').textContent = `Export verification: ${data.verification.status}\n${data.verification.runs} fresh checks completed\n\n${number(data.initial.sourceBytes)} → ${number(data.final.sourceBytes)} source bytes\n${data.initial.files} → ${data.final.files} files\n\nStandalone verifier included in the download.`;
      byId('terminal-caption').textContent = 'Recorded verification summary. The original application command still fails as expected.';
      byId('playback-status').textContent = `Recorded with ${data.tool}, ${data.node} · ${data.evaluations} candidate evaluations. ${data.createdAt.slice(0, 10)}.`;
    }
  }
  buttons.forEach(button => button.addEventListener('click', () => { stop(); show(button.dataset.stage); }));
  byId('play').disabled = false;
  byId('play').addEventListener('click', () => {
    if (playing) { stop(); return; }
    playing = true; byId('play').textContent = 'Pause replay'; show('failure');
    let index = 0;
    const advance = () => {
      if (!playing) return;
      if (index < data.accepted.length) { show('reduction', index++); timer = setTimeout(advance, 550); }
      else { show('verification'); stop(); }
    };
    timer = setTimeout(advance, 1400);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  show('failure');
})();
