import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Metrics, RunReport, Trial } from './types.ts';

/** Public evidence omits raw execution diagnostics and private setup errors. */
export function sanitizeReport(report: RunReport): RunReport {
  return {
    ...report,
    stopReason: report.status === 'failed' ? 'The run failed. Inspect the private checkpoint and logs for details.' : report.stopReason,
    trials: report.trials.map(trial => ({ ...trial, diagnostics: [], reason: trial.status === 'invalid' ? 'Evaluation was invalid; details are in the private run logs.' : trial.reason })),
    verification: { ...report.verification, reason: report.verification.status === 'failed' ? 'Fresh verification failed. Inspect the private checkpoint and logs for details.' : report.verification.reason },
  };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function formatBytes(value: number): string {
  const bytes = finite(value);
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${Number((bytes / 1_000).toFixed(1))} kB`;
  return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
}

function formatDuration(value: number): string {
  const milliseconds = finite(value);
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder === 0 ? `${minutes} min` : `${minutes} min ${remainder} s`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date) + ' UTC';
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(command: string[]): string {
  return command.map(shellArgument).join(' ');
}

function reductionPercent(initial: Metrics, current: Metrics): number {
  const before = finite(initial.sourceBytes);
  const after = finite(current.sourceBytes);
  if (before === 0 || after >= before) return 0;
  return Math.round(((before - after) / before) * 100);
}

function runState(status: RunReport['status']): { label: string; tone: string } {
  const labels: Record<RunReport['status'], string> = {
    calibrating: 'Calibrating baseline',
    reducing: 'Reduction in progress',
    paused: 'Run paused',
    verifying: 'Fresh verification in progress',
    complete: 'Run complete',
    failed: 'Run failed',
  };
  const tone = status === 'complete' ? 'positive' : status === 'failed' ? 'negative' : 'attention';
  return { label: labels[status], tone };
}

function verificationState(report: RunReport): {
  title: string;
  tone: string;
  routeLabel: string;
} {
  if (report.verification.status === 'verified') {
    return { title: 'Fresh verification passed', tone: 'positive', routeLabel: 'Verified' };
  }
  if (report.verification.status === 'failed') {
    return { title: 'Fresh verification failed', tone: 'negative', routeLabel: 'Failed' };
  }
  return { title: 'Fresh verification pending', tone: 'attention', routeLabel: 'Pending' };
}

function metricPair(
  label: string,
  before: number,
  after: number,
  formatter: (value: number) => string = String,
): string {
  return `<div class="measure-pair">
    <dt>${escapeHtml(label)}</dt>
    <dd><span>${escapeHtml(formatter(before))}</span><span class="measure-arrow" aria-hidden="true">→</span><strong>${escapeHtml(formatter(after))}</strong></dd>
  </div>`;
}

function trialState(trial: Trial): 'accepted' | 'rejected' | 'invalid' {
  if (trial.accepted) return 'accepted';
  return trial.status === 'invalid' ? 'invalid' : 'rejected';
}

function renderTrial(trial: Trial): string {
  const state = trialState(trial);
  const pathList = trial.paths.length
    ? trial.paths.map((path) => `<code>${escapeHtml(path)}</code>`).join('<span aria-hidden="true"> · </span>')
    : '<span>Whole snapshot</span>';
  return `<article class="trial" data-trial-entry data-trial-state="${state}">
    <div class="trial-line">
      <span class="trial-index">${escapeHtml(trial.index)}</span>
      <div class="trial-main">
        <div class="trial-title-row">
          <h3>${escapeHtml(trial.description)}</h3>
          <span class="state-label state-${state}">${state}</span>
        </div>
        <p class="trial-paths">${pathList}</p>
      </div>
      <div class="trial-measure"><strong>${formatBytes(trial.after.sourceBytes)}</strong><span>${formatDuration(trial.durationMs)}</span></div>
    </div>
    <details class="trial-detail">
      <summary>Inspect decision</summary>
      <div class="trial-detail-grid">
        <div><span>Decision</span><strong>${escapeHtml(trial.reason)}</strong></div>
        <div><span>Failure observation</span><strong>${escapeHtml(trial.status)}</strong></div>
        <div><span>Confirmations</span><strong>${escapeHtml(trial.confirmations)}</strong></div>
        <div><span>Candidate</span><code>${escapeHtml(trial.candidateHash)}</code></div>
        <div><span>Source change</span><strong>${formatBytes(trial.before.sourceBytes)} → ${formatBytes(trial.after.sourceBytes)}</strong></div>
        <div><span>Files</span><strong>${escapeHtml(trial.before.files)} → ${escapeHtml(trial.after.files)}</strong></div>
      </div>
      <div class="diagnostics"><h4>Execution privacy</h4><p class="empty-note">Raw execution output is not embedded in this report.</p></div>
    </details>
  </article>`;
}

function renderFiles(report: RunReport): string {
  if (report.files.length === 0) return '<p class="empty-note" id="file-list">No retained files recorded.</p>';
  const largest = Math.max(1, ...report.files.map((file) => finite(file.bytes)));
  return `<ol class="file-list" id="file-list">
    ${report.files.map((file) => {
      const width = Math.max(2, Math.round((finite(file.bytes) / largest) * 100));
      return `<li data-file-entry>
        <div class="file-row"><code>${escapeHtml(file.path)}</code><span>${formatBytes(file.bytes)}</span></div>
        <span class="file-bar" style="--file-width:${width}%" aria-hidden="true"></span>
      </li>`;
    }).join('')}
  </ol>`;
}

function renderReview(report: RunReport): string {
  const findings = report.reviewFindings.map((finding) => `<li>
    <span class="finding-kind">${escapeHtml(finding.kind)}</span>
    <div><code>${escapeHtml(finding.path)}</code><p>${escapeHtml(finding.message)}</p></div>
  </li>`).join('');
  const warnings = report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  const excluded = report.excluded.map((item) => `<li><code>${escapeHtml(item.path)}</code><span>${escapeHtml(item.reason)}</span></li>`).join('');

  if (!findings && !warnings && !excluded) {
    return '<p class="empty-note">No review findings, warnings, or excluded paths recorded.</p>';
  }

  return `${findings ? `<h3>Review findings</h3><ul class="finding-list">${findings}</ul>` : ''}
    ${warnings ? `<h3>Warnings</h3><ul class="plain-list">${warnings}</ul>` : ''}
    ${excluded ? `<h3>Excluded from source inventory</h3><ul class="excluded-list">${excluded}</ul>` : ''}`;
}

function reportScript(): string {
  return `<script>
(() => {
  const trialSearch = document.querySelector('#trial-search');
  const trialEntries = [...document.querySelectorAll('[data-trial-entry]')];
  const trialButtons = [...document.querySelectorAll('[data-trial-filter]')];
  const trialCount = document.querySelector('#trial-count');

  const updateTrials = () => {
    const query = (trialSearch?.value || '').trim().toLocaleLowerCase();
    const enabled = new Set(trialButtons.filter((button) => button.getAttribute('aria-pressed') === 'true').map((button) => button.dataset.trialFilter));
    let visible = 0;
    for (const entry of trialEntries) {
      const matchesState = enabled.has(entry.dataset.trialState);
      const matchesQuery = !query || (entry.textContent || '').toLocaleLowerCase().includes(query);
      entry.hidden = !(matchesState && matchesQuery);
      if (!entry.hidden) visible += 1;
    }
    if (trialCount) trialCount.textContent = visible + (visible === 1 ? ' trial shown' : ' trials shown');
  };

  trialSearch?.addEventListener('input', updateTrials);
  for (const button of trialButtons) {
    button.addEventListener('click', () => {
      button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      updateTrials();
    });
  }
  updateTrials();

  const fileSearch = document.querySelector('#file-search');
  const fileEntries = [...document.querySelectorAll('[data-file-entry]')];
  const fileCount = document.querySelector('#file-count');
  const updateFiles = () => {
    const query = (fileSearch?.value || '').trim().toLocaleLowerCase();
    let visible = 0;
    for (const entry of fileEntries) {
      entry.hidden = Boolean(query) && !(entry.textContent || '').toLocaleLowerCase().includes(query);
      if (!entry.hidden) visible += 1;
    }
    if (fileCount) fileCount.textContent = visible + (visible === 1 ? ' file shown' : ' files shown');
  };
  fileSearch?.addEventListener('input', updateFiles);
  updateFiles();

  const copyButton = document.querySelector('[data-copy-command]');
  const copyStatus = document.querySelector('#copy-status');
  copyButton?.addEventListener('click', async () => {
    const command = copyButton.getAttribute('data-copy-command') || '';
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
        copied = true;
      }
    } catch {}
    if (!copied) {
      const field = document.createElement('textarea');
      field.value = command;
      field.setAttribute('readonly', '');
      field.className = 'copy-fallback';
      document.body.append(field);
      field.select();
      copied = document.execCommand('copy');
      field.remove();
    }
    if (copyStatus) copyStatus.textContent = copied ? 'Command copied.' : 'Copy failed. Select the command manually.';
  });
})();
</script>`;
}

export function renderReport(report: RunReport): string {
  report = sanitizeReport(report);
  const verification = verificationState(report);
  const state = runState(report.status);
  const command = shellCommand(report.command);
  const accepted = report.trials.filter((trial) => trial.accepted).length;
  const discarded = report.trials.filter((trial) => !trial.accepted).length;
  const invalid = report.trials.filter((trial) => trial.status === 'invalid').length;
  const percent = reductionPercent(report.initial, report.current);
  const noReduction = percent === 0 && report.initial.files <= report.current.files;
  const baselineRoute = !report.baseline
    ? 'Not recorded'
    : `${report.baseline.completed >= report.baseline.required ? 'Established' : 'Incomplete'} (${report.baseline.completed}/${report.baseline.required})`;
  const reductionRoute = report.trials.length === 0
    ? 'No trials'
    : report.status === 'reducing'
      ? 'In progress'
      : `${accepted} accepted`;
  const branchMarkup = discarded > 0
    ? `<p class="branch-summary"><span aria-hidden="true"></span><strong>${discarded}</strong> discarded branches</p>`
    : '<p class="branch-empty">No discarded trial branches</p>';
  const trials = report.trials.length
    ? report.trials.map(renderTrial).join('')
    : '<p class="empty-note">No trials recorded.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(report.name)} · Repro Surgeon evidence</title>
  <style>
    :root { color-scheme: light; --paper:#f4f0e5; --paper-deep:#e9e2d2; --ink:#17211e; --muted:#59625d; --line:#a8afa7; --line-strong:#59645e; --signal:#006a62; --signal-soft:#d6e6df; --danger:#923b2f; --danger-soft:#f0dcd4; --amber:#805c12; --amber-soft:#eee0b7; --white:#fffdf7; --radius:4px; --measure:74ch; }
    * { box-sizing:border-box; }
    html { background:var(--paper-deep); color:var(--ink); font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:16px; line-height:1.5; }
    body { margin:0; min-width:320px; }
    button,input,summary { font:inherit; }
    button { color:inherit; }
    code,.measure-pair dd,.trial-index,.state-label,.run-meta,.masthead,.route-node strong,.file-row span { font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace; }
    code { overflow-wrap:anywhere; }
    a { color:inherit; }
    [hidden] { display:none !important; }
    .skip-link { position:fixed; inset:8px auto auto 8px; z-index:20; padding:8px 12px; background:var(--ink); color:var(--white); transform:translateY(-160%); }
    .skip-link:focus { transform:none; }
    :focus-visible { outline:3px solid var(--signal); outline-offset:3px; }
    .sheet { width:min(1180px,calc(100% - 32px)); margin:24px auto 64px; background:var(--paper); border:1px solid var(--line-strong); box-shadow:0 18px 46px rgba(23,33,30,.13); }
    .masthead { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; padding:12px 28px; border-bottom:3px solid var(--ink); font-size:.72rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
    .masthead span:first-child { flex:0 0 auto; }
    .masthead span:last-child { min-width:0; text-align:right; overflow-wrap:anywhere; }
    .opening { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(300px,.8fr); border-bottom:1px solid var(--line-strong); }
    .opening-copy { padding:42px 44px 38px; }
    h1,h2,h3,h4,p { margin-top:0; }
    h1 { max-width:15ch; margin-bottom:16px; font-size:clamp(2.45rem,6vw,5.4rem); line-height:.94; letter-spacing:-.035em; font-weight:760; text-wrap:balance; }
    .lede { max-width:var(--measure); margin:0; color:var(--muted); font-size:1.03rem; }
    .verification { padding:38px 32px; background:var(--ink); color:var(--white); }
    .verification h2 { max-width:13ch; margin-bottom:18px; font-size:clamp(1.65rem,3vw,2.6rem); line-height:1.06; letter-spacing:-.025em; }
    .verification p { max-width:44ch; color:#dbe2de; }
    .verification .status-stamp { display:inline-flex; align-items:center; gap:9px; margin-bottom:26px; padding:5px 9px; border:1px solid currentColor; border-radius:999px; font:700 .75rem/1 ui-monospace,SFMono-Regular,monospace; letter-spacing:.04em; text-transform:uppercase; }
    .verification .status-stamp::before { content:""; width:9px; height:9px; border-radius:50%; background:currentColor; }
    .verification .tone-positive { color:#87ddc7; }
    .verification .tone-negative { color:#ff9c88; }
    .verification .tone-attention { color:#f2cf70; }
    .verification dl { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin:26px 0 0; }
    .verification dt { color:#aeb9b4; font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; }
    .verification dd { margin:3px 0 0; font-weight:700; }
    .evidence-route { padding:30px 44px 34px; border-bottom:1px solid var(--line-strong); }
    .route-track { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); position:relative; margin-top:2px; }
    .route-track::before { content:""; position:absolute; top:13px; left:16.6%; right:16.6%; height:2px; background:var(--line-strong); }
    .route-node { min-width:0; position:relative; z-index:1; text-align:center; }
    .route-node::before { content:""; display:block; width:20px; height:20px; margin:3px auto 10px; border:5px solid var(--paper); outline:2px solid var(--line-strong); border-radius:50%; background:var(--signal); }
    .route-node.route-pending::before { background:var(--amber-soft); }
    .route-node.route-failed::before { background:var(--danger); }
    .route-node span { display:block; color:var(--muted); font-size:.78rem; }
    .route-node strong,.route-node span { overflow-wrap:anywhere; }
    .route-node strong { font-size:.85rem; }
    .branch-summary { display:flex; justify-content:center; align-items:center; gap:5px; min-width:0; margin:6px 4px 0; color:var(--muted); font-size:.7rem; line-height:1.25; }
    .branch-summary span { flex:0 0 12px; width:12px; height:8px; border-left:1px solid var(--line-strong); border-bottom:1px solid var(--line-strong); transform:skewX(-28deg); }
    .branch-summary strong { color:var(--danger); font-size:inherit; }
    .branch-empty { margin:5px 0 0; color:var(--muted); font-size:.7rem; }
    .result { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr); border-bottom:1px solid var(--line-strong); }
    .result-main { padding:42px 44px; }
    .result h2,.section-heading h2,.review h2 { margin-bottom:18px; font-size:clamp(1.65rem,3vw,2.55rem); line-height:1.05; letter-spacing:-.025em; }
    .result-verdict { margin-bottom:30px; font-size:1rem; color:var(--muted); }
    .reduction-number { display:flex; align-items:baseline; gap:12px; margin:0 0 22px; }
    .reduction-number strong { font-size:clamp(3.6rem,8vw,7rem); line-height:.82; letter-spacing:-.04em; }
    .reduction-number span { font-weight:720; max-width:12ch; line-height:1.1; }
    .measure-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); border-top:1px solid var(--line); border-left:1px solid var(--line); margin:0; }
    .measure-pair { padding:14px 16px; border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
    .measure-pair dt { color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; }
    .measure-pair dd { display:flex; align-items:center; gap:8px; margin:5px 0 0; font-size:.9rem; }
    .measure-pair dd span:first-child { color:var(--muted); text-decoration:line-through; text-decoration-thickness:1px; }
    .measure-arrow { color:var(--signal); }
    .result-aside { padding:42px 32px; border-left:1px solid var(--line-strong); }
    .result-aside h3,.review h3 { margin:28px 0 10px; font-size:1rem; }
    .result-aside h3:first-child,.review h3:first-child { margin-top:0; }
    .command-line { display:flex; align-items:stretch; background:var(--white); border:1px solid var(--line-strong); }
    .command-line code { flex:1; padding:12px 14px; white-space:pre-wrap; }
    .copy-button { min-width:84px; min-height:44px; border:0; border-left:1px solid var(--line-strong); background:var(--signal); color:white; font-weight:750; cursor:pointer; }
    .copy-button:hover { background:#00564f; }
    .copy-status { min-height:1.5em; margin:6px 0 0; color:var(--muted); font-size:.78rem; }
    .oracle-grid { display:grid; gap:12px; }
    .oracle-grid div { border-top:1px solid var(--line); padding-top:9px; }
    .oracle-grid span { display:block; color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; }
    .oracle-grid strong,.oracle-grid code { display:block; margin-top:3px; }
    .section { padding:42px 44px 48px; border-bottom:1px solid var(--line-strong); }
    .section-heading { display:flex; align-items:end; justify-content:space-between; gap:20px; margin-bottom:22px; }
    .section-heading h2 { margin-bottom:0; }
    .section-heading p { max-width:48ch; margin-bottom:2px; color:var(--muted); }
    .controls { display:flex; flex-wrap:wrap; align-items:end; gap:10px; padding:14px 0 18px; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
    .search-field { flex:1 1 260px; }
    .search-field label { display:block; margin-bottom:5px; color:var(--muted); font-size:.78rem; font-weight:700; }
    .search-field input { width:100%; min-height:44px; padding:8px 11px; background:var(--white); border:1px solid var(--line-strong); border-radius:0; color:var(--ink); }
    .filter-group { display:flex; flex-wrap:wrap; gap:6px; }
    .filter-button { min-height:44px; padding:7px 11px; border:1px solid var(--line-strong); background:transparent; cursor:pointer; }
    .filter-button[aria-pressed="true"] { background:var(--ink); color:var(--white); }
    .count-status { min-width:104px; margin:0 0 10px; color:var(--muted); font-size:.78rem; text-align:right; }
    .trial-list { border-bottom:1px solid var(--line); }
    .trial { border-top:1px solid var(--line); }
    .trial-line { display:grid; grid-template-columns:42px minmax(0,1fr) 110px; align-items:start; gap:14px; padding:17px 0; }
    .trial-index { display:grid; place-items:center; width:34px; height:34px; border:1px solid var(--line-strong); font-weight:700; }
    .trial-title-row { display:flex; align-items:start; justify-content:space-between; gap:12px; }
    .trial-title-row h3 { margin:1px 0 4px; font-size:1rem; }
    .state-label { flex:none; padding:3px 7px; border:1px solid currentColor; border-radius:999px; font-size:.68rem; font-weight:800; text-transform:uppercase; }
    .state-accepted { color:var(--signal); }
    .state-rejected { color:var(--danger); }
    .state-invalid { color:var(--amber); }
    .trial-paths { margin:0; color:var(--muted); font-size:.8rem; }
    .trial-measure { text-align:right; }
    .trial-measure span { display:block; color:var(--muted); font-size:.75rem; }
    .trial-detail { margin:0 0 16px 56px; border:1px solid var(--line); background:var(--white); }
    .trial-detail summary { display:flex; align-items:center; min-height:44px; padding:9px 12px; cursor:pointer; font-weight:720; }
    .trial-detail[open] summary { border-bottom:1px solid var(--line); }
    .trial-detail-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); }
    .trial-detail-grid div { min-height:76px; padding:11px 12px; border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
    .trial-detail-grid div:nth-child(3n) { border-right:0; }
    .trial-detail-grid span { display:block; color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; }
    .trial-detail-grid strong,.trial-detail-grid code { display:block; margin-top:5px; font-size:.82rem; }
    .diagnostics { padding:12px; }
    .diagnostics h4 { margin-bottom:6px; }
    .files-layout { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(260px,.65fr); gap:40px; }
    .file-list { margin:0; padding:0; list-style:none; border-top:1px solid var(--line); }
    .file-list li { padding:11px 0; border-bottom:1px solid var(--line); }
    .file-row { display:flex; justify-content:space-between; gap:20px; font-size:.84rem; }
    .file-bar { display:block; width:var(--file-width); height:3px; margin-top:8px; background:var(--signal); }
    .run-meta { margin:0; }
    .run-meta div { display:grid; grid-template-columns:116px 1fr; gap:12px; padding:8px 0; border-bottom:1px solid var(--line); font-size:.78rem; }
    .run-meta dt { color:var(--muted); }
    .run-meta dd { margin:0; overflow-wrap:anywhere; }
    .review { padding:42px 44px 48px; }
    .finding-list,.excluded-list,.plain-list { margin:0; padding:0; list-style:none; }
    .finding-list li { display:grid; grid-template-columns:100px 1fr; gap:16px; padding:12px 0; border-top:1px solid var(--line); }
    .finding-kind { align-self:start; padding:3px 7px; background:var(--amber-soft); font:700 .7rem ui-monospace,SFMono-Regular,monospace; text-transform:uppercase; }
    .finding-list p { margin:3px 0 0; color:var(--muted); }
    .plain-list li,.excluded-list li { padding:9px 0; border-top:1px solid var(--line); }
    .excluded-list li { display:grid; grid-template-columns:minmax(160px,.55fr) 1fr; gap:18px; }
    .empty-note { padding:16px; border:1px dashed var(--line-strong); color:var(--muted); }
    .footer { display:flex; justify-content:space-between; gap:24px; padding:14px 28px; border-top:3px solid var(--ink); font-size:.74rem; color:var(--muted); }
    .copy-fallback { position:fixed; left:-9999px; top:0; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    @media (max-width:760px) {
      .sheet { width:100%; margin:0; border-width:0; box-shadow:none; }
      .masthead,.footer { padding-inline:18px; }
      .opening,.result,.files-layout { grid-template-columns:1fr; }
      .opening-copy,.verification,.evidence-route,.result-main,.result-aside,.section,.review { padding:30px 20px; }
      .result-aside { border-left:0; border-top:1px solid var(--line-strong); }
      .measure-list,.trial-detail-grid { grid-template-columns:1fr; }
      .trial-detail-grid div,.trial-detail-grid div:nth-child(3n) { border-right:0; }
      .section-heading { display:block; }
      .section-heading p { margin-top:8px; }
      .trial-line { grid-template-columns:34px minmax(0,1fr); gap:10px; }
      .trial-measure { grid-column:2; display:flex; gap:12px; text-align:left; }
      .trial-measure span { display:inline; }
      .trial-title-row { display:block; }
      .state-label { display:inline-block; margin-top:6px; }
      .trial-detail { margin-left:44px; }
      .excluded-list li { grid-template-columns:1fr; gap:4px; }
      .count-status { width:100%; text-align:left; }
    }
    @media (max-width:480px) {
      .route-node strong { font-size:.7rem; }
      .route-node span { font-size:.68rem; }
      .command-line { display:block; }
      .copy-button { width:100%; border-left:0; border-top:1px solid var(--line-strong); }
      .file-row { display:block; }
      .file-row span { display:block; margin-top:4px; }
      .run-meta div { grid-template-columns:1fr; gap:2px; }
      .footer { display:block; }
    }
    @media print {
      html,body { background:white; }
      .sheet { width:100%; margin:0; border:0; box-shadow:none; }
      .controls,.copy-button,.copy-status,.skip-link { display:none !important; }
      .trial[hidden],.file-list li[hidden] { display:block !important; }
      .trial-detail { break-inside:avoid; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to run evidence</a>
  <main class="sheet" id="main" data-surface="report">
    <header>
      <div class="masthead"><span>Repro Surgeon / run evidence</span><span>${escapeHtml(report.id)}</span></div>
      <div class="opening">
        <div class="opening-copy">
          <h1>${escapeHtml(report.name)}</h1>
          <p class="lede"><strong class="state-label state-${state.tone === 'negative' ? 'rejected' : state.tone === 'positive' ? 'accepted' : 'invalid'}">${escapeHtml(state.label)}</strong> ${escapeHtml(report.stopReason)}</p>
        </div>
        <section class="verification" id="verification" aria-labelledby="verification-title">
          <span class="status-stamp tone-${verification.tone}">${escapeHtml(report.verification.status)}</span>
          <h2 id="verification-title">${escapeHtml(verification.title)}</h2>
          <p>${escapeHtml(report.verification.reason)}</p>
          <dl>
            <div><dt>Fresh runs</dt><dd>${escapeHtml(report.verification.runs)}</dd></div>
            <div><dt>Snapshot</dt><dd><code>${escapeHtml(report.verification.snapshotHash)}</code></dd></div>
            <div><dt>Environment</dt><dd>${escapeHtml(report.verification.environment)}</dd></div>
            <div><dt>Created</dt><dd>${escapeHtml(formatDate(report.createdAt))}</dd></div>
          </dl>
        </section>
      </div>
    </header>

    <nav class="evidence-route" aria-label="Evidence path">
      <div class="route-track">
        <div class="route-node"><strong>Baseline</strong><span>${escapeHtml(baselineRoute)}</span></div>
        <div class="route-node"><strong>Reduction</strong><span>${escapeHtml(reductionRoute)}</span>${branchMarkup}</div>
        <div class="route-node route-${report.verification.status === 'verified' ? 'verified' : report.verification.status}"><strong>Fresh verification</strong><span>${escapeHtml(verification.routeLabel)}</span></div>
      </div>
    </nav>

    <section class="result" id="result" aria-labelledby="result-title">
      <div class="result-main">
        <h2 id="result-title">${noReduction ? 'No reduction accepted' : 'Reduced source, same configured failure'}</h2>
        <p class="result-verdict">${accepted} accepted ${accepted === 1 ? 'change' : 'changes'} from ${report.evaluations} evaluations in ${formatDuration(report.elapsedMs)}. ${discarded} discarded; ${invalid} invalid.</p>
        <p class="reduction-number"><strong>${percent}%</strong><span>less source by recorded bytes</span></p>
        <dl class="measure-list">
          ${metricPair('Source', report.initial.sourceBytes, report.current.sourceBytes, formatBytes)}
          ${metricPair('Files', report.initial.files, report.current.files)}
          ${metricPair('Total snapshot', report.initial.bytes, report.current.bytes, formatBytes)}
          ${metricPair('Dependencies', report.initial.dependencies, report.current.dependencies)}
        </dl>
      </div>
      <aside class="result-aside" aria-label="Failure contract">
        <h3>Reproduction command</h3>
        <div class="command-line"><code>${escapeHtml(command)}</code><button class="copy-button" type="button" data-copy-command="${escapeHtml(command)}">Copy</button></div>
        <p class="copy-status" id="copy-status" role="status" aria-live="polite"></p>
        <h3>Configured failure check</h3>
        <div class="oracle-grid">
          <div><span>Exact exit</span><strong>${escapeHtml(report.oracle.exitCode)}</strong></div>
          <div><span>Required output</span>${report.oracle.allOf.map((item) => `<code>${escapeHtml(item)}</code>`).join('')}</div>
          <div><span>Forbidden output</span>${report.oracle.noneOf.length ? report.oracle.noneOf.map((item) => `<code>${escapeHtml(item)}</code>`).join('') : '<strong>None configured</strong>'}</div>
        </div>
      </aside>
    </section>

    <section class="section" aria-labelledby="trials-title">
      <div class="section-heading"><h2 id="trials-title">Reduction decisions</h2><p>Search and filter recorded trials. Expand any decision to inspect its evidence summary.</p></div>
      <div class="controls" aria-label="Trial controls">
        <div class="search-field"><label for="trial-search">Search trials</label><input id="trial-search" type="search" placeholder="Path or decision" aria-controls="trial-list"></div>
        <div class="filter-group" aria-label="Trial states">
          <button class="filter-button" type="button" data-trial-filter="accepted" aria-pressed="true">Accepted</button>
          <button class="filter-button" type="button" data-trial-filter="rejected" aria-pressed="true">Rejected</button>
          <button class="filter-button" type="button" data-trial-filter="invalid" aria-pressed="true">Invalid</button>
        </div>
        <p class="count-status" id="trial-count" role="status" aria-live="polite">${report.trials.length} trials shown</p>
      </div>
      <div class="trial-list" id="trial-list">${trials}</div>
    </section>

    <section class="section" aria-labelledby="files-title">
      <div class="section-heading"><h2 id="files-title">Retained source</h2><p>Files remaining in the reduced snapshot. Byte bars compare retained file size within this run.</p></div>
      <div class="files-layout">
        <div>
          <div class="controls">
            <div class="search-field"><label for="file-search">Find a retained file</label><input id="file-search" type="search" placeholder="File path" aria-controls="file-list"></div>
            <p class="count-status" id="file-count" role="status" aria-live="polite">${report.files.length} files shown</p>
          </div>
          ${renderFiles(report)}
        </div>
        <aside aria-label="Run metadata">
          <dl class="run-meta">
            <div><dt>Adapter</dt><dd>${escapeHtml(report.adapter.name)} ${escapeHtml(report.adapter.version ?? 'version not recorded')}</dd></div>
            <div><dt>Router</dt><dd>${escapeHtml(report.adapter.router)}</dd></div>
            <div><dt>Runtime</dt><dd>${escapeHtml(report.runtime.node)} / npm ${escapeHtml(report.runtime.npm)}</dd></div>
            <div><dt>Host</dt><dd>${escapeHtml(report.runtime.platform)} / ${escapeHtml(report.runtime.arch)}</dd></div>
            <div><dt>Tool</dt><dd>${escapeHtml(report.runtime.tool)}</dd></div>
            <div><dt>Run ID</dt><dd>${escapeHtml(report.id)}</dd></div>
          </dl>
        </aside>
      </div>
    </section>

    <section class="review" aria-labelledby="review-title">
      <h2 id="review-title">Review before sharing</h2>
      ${renderReview(report)}
    </section>

    <footer class="footer"><span>Generated locally by Repro Surgeon. No source is published by this report.</span><span>${escapeHtml(report.id)}</span></footer>
  </main>
  ${reportScript()}
</body>
</html>`;
}

export async function writeReport(report: RunReport, directory: string): Promise<void> {
  report = sanitizeReport(report);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'report.html'), renderReport(report), 'utf8'),
    writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
  ]);
}
