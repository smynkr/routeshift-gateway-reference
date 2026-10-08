import { comparePolicies, evaluate, validatePolicy, validateRequest } from '/dist/index.js';

const byId = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Workbench element not found: ${id}`);
  return element;
};

const baselineEditor = byId('baseline-policy');
const candidateEditor = byId('candidate-policy');
const requestEditor = byId('request-json');
const scenarioSelect = byId('scenario-select');
const statusLine = byId('run-status');
const errorPanel = byId('error-panel');
const results = byId('results');
const resultSummary = byId('result-summary');
const resultContent = byId('result-content');
const actionButtons = [
  byId('evaluate-baseline'),
  byId('evaluate-candidate'),
  byId('compare-policies'),
];
const editors = [baselineEditor, candidateEditor, requestEditor];

const scenarioNames = new Map([
  ['default', 'Example request'],
  ['1', 'Request 1 · small request'],
  ['2', 'Request 2 · code-review model'],
  ['3', 'Request 3 · restricted tag'],
  ['4', 'Request 4 · capacity fallback'],
  ['5', 'Request 5 · default capacity block'],
]);

const fixtureBundle = loadFixtureBundle();
let fixtureLoadId = 0;

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatValue(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  const formatted = JSON.stringify(value);
  return formatted === undefined ? String(value) : formatted;
}

function describeError(error) {
  if (Array.isArray(error?.issues)) {
    return error.issues
      .map((issue) => {
        const path = issue.path || '$';
        const code = issue.code ? ` [${issue.code}]` : '';
        return `${path}${code}: ${issue.message}`;
      })
      .join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

async function readJsonAsset(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
  return response.json();
}

async function readTextAsset(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
  return response.text();
}

async function loadFixtureBundle() {
  const [baseline, candidate, request, requestLines] = await Promise.all([
    readJsonAsset('/examples/baseline.json'),
    readJsonAsset('/examples/candidate.json'),
    readJsonAsset('/examples/request.json'),
    readTextAsset('/examples/requests.jsonl'),
  ]);
  const requests = [];
  const lines = requestLines.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      requests.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid synthetic request fixture at requests.jsonl line ${index + 1}: ${describeError(error)}`);
    }
  }
  return { baseline, candidate, request, requests };
}

function setBusy(isBusy) {
  scenarioSelect.disabled = isBusy;
  for (const editor of editors) editor.disabled = isBusy;
  for (const button of actionButtons) button.disabled = isBusy;
}

function clearResult() {
  results.hidden = true;
  resultSummary.textContent = '';
  resultContent.replaceChildren();
  errorPanel.hidden = true;
  errorPanel.textContent = '';
}

function setStatus(message) {
  statusLine.textContent = message;
}

function invalidateResults(message) {
  fixtureLoadId += 1;
  clearResult();
  setStatus(message);
}

function showError(message) {
  clearResult();
  errorPanel.textContent = message;
  errorPanel.hidden = false;
  setStatus('Run failed. Correct the input and run again.');
}

function replaceEditorContent(baseline, candidate, request) {
  baselineEditor.value = JSON.stringify(baseline, null, 2);
  candidateEditor.value = JSON.stringify(candidate, null, 2);
  requestEditor.value = JSON.stringify(request, null, 2);
  for (const editor of editors) editor.removeAttribute('aria-invalid');
}

async function loadScenario(key) {
  const currentLoadId = ++fixtureLoadId;
  clearResult();
  setBusy(true);
  setStatus(`Loading ${scenarioNames.get(key) ?? 'synthetic scenario'}…`);

  try {
    const fixtures = await fixtureBundle;
    if (currentLoadId !== fixtureLoadId) return;

    let request = fixtures.request;
    if (key !== 'default') {
      const requestIndex = Number(key) - 1;
      request = fixtures.requests[requestIndex];
      if (request === undefined) {
        throw new Error(`No request fixture is available for scenario ${key}.`);
      }
    }

    replaceEditorContent(fixtures.baseline, fixtures.candidate, request);
    setStatus(`Loaded ${scenarioNames.get(key) ?? 'synthetic scenario'}. All inputs are editable; running the engine makes no provider calls.`);
  } catch (error) {
    if (currentLoadId === fixtureLoadId) {
      showError(`Unable to load local synthetic fixtures. You can still enter policy and request JSON manually.\n\n${describeError(error)}`);
    }
  } finally {
    if (currentLoadId === fixtureLoadId) setBusy(false);
  }
}

function parseAndValidate(editor, label, validator) {
  let value;
  try {
    value = JSON.parse(editor.value);
  } catch (error) {
    editor.setAttribute('aria-invalid', 'true');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`);
  }

  try {
    const validated = validator(value);
    editor.removeAttribute('aria-invalid');
    return validated;
  } catch (error) {
    editor.setAttribute('aria-invalid', 'true');
    throw new Error(`${label} failed validation:\n${describeError(error)}`);
  }
}

function appendField(list, label, value) {
  const pair = createElement('div', 'decision-field');
  pair.append(createElement('dt', '', label));
  pair.append(createElement('dd', '', value));
  list.append(pair);
}

function renderDecisionOverview(decision) {
  const overview = createElement('dl', 'decision-overview');
  appendField(overview, 'Policy', `${decision.policy.id} · revision ${decision.policy.revision}`);
  appendField(overview, 'Outcome', decision.outcome);
  appendField(overview, 'Selected by', decision.ruleId === null ? 'Default action' : `Rule ${decision.ruleId}`);
  appendField(overview, 'Reason', decision.reason);
  appendField(overview, 'Target', decision.target ? `${decision.target.provider} / ${decision.target.model}` : '—');
  appendField(overview, 'Final tags', Array.isArray(decision.tags) && decision.tags.length ? decision.tags.join(', ') : 'None');
  return overview;
}

const statusClasses = {
  disabled: 'trace-chip-muted',
  unmatched: 'trace-chip-muted',
  tagged: 'trace-chip-tagged',
  capacity_exceeded: 'trace-chip-warning',
  selected: 'trace-chip-selected',
  blocked: 'trace-chip-blocked',
  not_evaluated: 'trace-chip-muted',
};

function renderConditionEvidence(condition) {
  const item = createElement('article', 'condition-evidence');
  const outcome = condition.passed ? 'Matched' : 'Did not match';
  const matchClass = condition.passed ? 'condition-result condition-result-pass' : 'condition-result condition-result-fail';
  const header = createElement('div', 'condition-heading');
  header.append(createElement('strong', 'condition-field', condition.field));
  header.append(createElement('span', matchClass, outcome));
  item.append(header);

  const values = createElement('dl', 'condition-values');
  const expected = createElement('div', 'condition-value');
  expected.append(createElement('dt', '', 'Expected'));
  expected.append(createElement('dd', 'condition-code', formatValue(condition.expected)));
  const actual = createElement('div', 'condition-value');
  actual.append(createElement('dt', '', 'Actual'));
  actual.append(createElement('dd', 'condition-code', formatValue(condition.actual)));
  values.append(expected, actual);
  item.append(values);
  return item;
}

function renderTrace(entries) {
  const traceSection = createElement('section', 'trace-section');
  traceSection.append(createElement('h4', 'subsection-title', 'Rule trace'));
  traceSection.append(createElement('p', 'trace-note', 'Rules are shown in engine evaluation order. Condition results are per-predicate evidence, not a universal rule verdict: models and modelPattern selectors are OR-combined. Use each rule’s trace status for its overall state.'));

  if (!Array.isArray(entries) || entries.length === 0) {
    traceSection.append(createElement('p', 'empty-trace', 'The engine returned no rule trace entries.'));
    return traceSection;
  }

  const list = createElement('ol', 'trace-list');
  for (const entry of entries) {
    const item = createElement('li', 'trace-entry');
    const header = createElement('div', 'trace-entry-heading');
    const ruleLabel = entry.ruleId === null ? 'Default action' : `Rule ${entry.ruleId}`;
    header.append(createElement('h5', 'trace-rule-name', `Priority ${entry.priority} · ${ruleLabel}`));
    const statusClass = statusClasses[entry.status] ?? 'trace-chip-muted';
    header.append(createElement('span', `trace-chip ${statusClass}`, entry.status));
    item.append(header);
    item.append(createElement('p', 'trace-reason', entry.reason));

    if (entry.target) {
      item.append(createElement('p', 'trace-target', `Target: ${entry.target.provider} / ${entry.target.model}`));
    }
    if (Array.isArray(entry.addedTags) && entry.addedTags.length > 0) {
      item.append(createElement('p', 'trace-added-tags', `Added tags: ${entry.addedTags.join(', ')}`));
    }

    if (Array.isArray(entry.conditions) && entry.conditions.length > 0) {
      const evidence = createElement('div', 'condition-list');
      for (const condition of entry.conditions) evidence.append(renderConditionEvidence(condition));
      item.append(evidence);
    } else {
      item.append(createElement('p', 'no-conditions', 'No condition evidence for this trace entry.'));
    }
    list.append(item);
  }
  traceSection.append(list);
  return traceSection;
}

function renderDecisionPanel(label, decision) {
  const panel = createElement('article', 'decision-panel');
  const heading = createElement('div', 'decision-panel-heading');
  const title = createElement('h3', '', label);
  const outcomeClass = decision.outcome === 'route' ? 'outcome-chip outcome-route' : 'outcome-chip outcome-block';
  heading.append(title, createElement('span', outcomeClass, decision.outcome));
  panel.append(heading);
  panel.append(renderDecisionOverview(decision));
  panel.append(renderTrace(decision.trace));
  return panel;
}

function renderJsonDetails(summary, value) {
  const details = createElement('details', 'json-details');
  details.open = true;
  details.append(createElement('summary', '', summary));
  const pre = createElement('pre', 'json-output', JSON.stringify(value, null, 2));
  details.append(pre);
  return details;
}

function displayResult(summary, content) {
  resultSummary.textContent = summary;
  resultContent.replaceChildren(content);
  errorPanel.hidden = true;
  errorPanel.textContent = '';
  results.hidden = false;
  setStatus('Evaluation complete. The result reflects only the current local inputs.');
}

function runEvaluation(policyEditor, policyLabel, resultLabel) {
  clearResult();
  setStatus('Evaluating current inputs…');
  try {
    const policy = parseAndValidate(policyEditor, policyLabel, validatePolicy);
    const request = parseAndValidate(requestEditor, 'Request', validateRequest);
    const decision = evaluate(policy, request);
    const content = createElement('div', 'decision-grid');
    content.append(renderDecisionPanel(resultLabel, decision));
    content.append(renderJsonDetails('Complete decision JSON', decision));
    displayResult(`${decision.outcome === 'route' ? 'Route selected' : 'Request blocked'} · ${decision.reason}`, content);
  } catch (error) {
    showError(describeError(error));
  }
}

function runComparison() {
  clearResult();
  setStatus('Comparing current inputs…');
  try {
    const before = parseAndValidate(baselineEditor, 'Baseline policy', validatePolicy);
    const after = parseAndValidate(candidateEditor, 'Candidate policy', validatePolicy);
    const request = parseAndValidate(requestEditor, 'Request', validateRequest);
    const comparison = comparePolicies(before, after, request);
    const tracesDiffer = JSON.stringify(comparison.before.trace) !== JSON.stringify(comparison.after.trace);
    let summary;
    if (comparison.changed) {
      summary = 'Decision changed · compare both outcomes and traces below.';
    } else if (tracesDiffer) {
      summary = 'Decision unchanged · trace-only differences are excluded from the changed flag.';
    } else {
      summary = 'Decision and trace unchanged for these inputs.';
    }

    const content = createElement('div', 'comparison-content');
    const panels = createElement('div', 'decision-grid');
    panels.append(renderDecisionPanel('Baseline result', comparison.before));
    panels.append(renderDecisionPanel('Candidate result', comparison.after));
    content.append(panels);
    content.append(renderJsonDetails('Complete comparison JSON · both decisions and traces', comparison));
    displayResult(summary, content);
  } catch (error) {
    showError(describeError(error));
  }
}

for (const [index, editor] of editors.entries()) {
  const labels = ['Baseline policy', 'Candidate policy', 'Request'];
  editor.addEventListener('input', () => {
    editor.removeAttribute('aria-invalid');
    invalidateResults(`${labels[index]} edited. Previous result cleared; run again.`);
  });
}

scenarioSelect.addEventListener('change', () => {
  void loadScenario(scenarioSelect.value);
});
byId('evaluate-baseline').addEventListener('click', () => runEvaluation(baselineEditor, 'Baseline policy', 'Baseline decision'));
byId('evaluate-candidate').addEventListener('click', () => runEvaluation(candidateEditor, 'Candidate policy', 'Candidate decision'));
byId('compare-policies').addEventListener('click', runComparison);

void loadScenario(scenarioSelect.value);
