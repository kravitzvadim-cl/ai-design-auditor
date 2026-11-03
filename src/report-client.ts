import type { Expectation, Finding, FindingStatus, Normalized } from './contracts.js';
import type { VisualData, VisualRun } from './report-model.js';

const data = JSON.parse(document.getElementById('audit-data')!.textContent!) as VisualData;
const visualOnly = data.report.baseline.scope === 'documented-visual';
const statuses: FindingStatus[] = ['pass', 'mismatch', 'unchecked', 'missing-guidance', 'ambiguous', 'proposed', 'deferred', 'not-applicable'];
const statusNames: Record<FindingStatus, string> = { pass: 'Match', mismatch: 'Mismatch', unchecked: 'Unchecked', 'missing-guidance': 'Missing guidance', ambiguous: 'Ambiguous', proposed: 'Proposed', deferred: 'Deferred', 'not-applicable': 'Not applicable' };
const ruleNames: Record<string, string> = { 'TYPE-DISPLAY': 'Display type', 'COLOR-BG': 'Page background', 'SPACE-GRID': 'Grid spacing', 'BORDER-SECTION': 'Section border', 'LAYOUT-RAIL': 'Sidebar width', 'COLOR-LABEL': 'Label color', 'COLOR-FAINT': 'Headline answer color', 'COLOR-INK': 'Main text color', 'COLOR-LEDE': 'Intro text color', 'COLOR-DESC': 'Description color', 'COLOR-RAIL': 'Sidebar background', 'COLOR-GHOST': 'Project number color', 'COLOR-STRONG-LINK': 'Link row border color', 'BORDER-LINK': 'Link row border thickness', 'LAYOUT-CONTENT-CAP': 'Content width', 'SHADOW-STRUCTURE': 'Container shadows' };
function byId<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}
function link(label: string, url: string, external = false): HTMLAnchorElement {
  const a = node('a', label); a.href = url;
  if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
}
const theme = byId<HTMLSelectElement>('theme'); const width = byId<HTMLSelectElement>('width');
const runSelect = byId<HTMLSelectElement>('run');
const filter = byId<HTMLSelectElement>('status'); const search = byId<HTMLInputElement>('search');
const image = byId<HTMLImageElement>('capture-image'); const canvas = byId('canvas'); const evidence = byId('evidence');
const highlight = byId('highlight'); const locate = byId<HTMLButtonElement>('locate'); const zoom = byId<HTMLButtonElement>('zoom');
let current: VisualRun = data.runs.find(run => run.viewport.width === 1440 && run.theme === 'dark') ?? data.runs[0]!;
let selected: Finding | undefined;
let visible: Finding[] = [];
let actualSize = false;
let imageFailed = false;
let imageReady = false;
const name = (finding: Finding): string => {
  if (ruleNames[finding.ruleId]) return ruleNames[finding.ruleId]!;
  const roles: Record<string, string> = { 'TYPE-DISPLAY': 'Display type', 'TYPE-PROJECT': 'Project name', 'TYPE-STAT': 'Large statistic', 'TYPE-H3': 'Method title', 'TYPE-SECTION': 'Section label', 'TYPE-LEDE': 'Intro paragraph', 'TYPE-DATA': 'Data text', 'TYPE-LABEL': 'Small label', 'TYPE-UI': 'Navigation and keys', 'TYPE-GIANT': 'Project number' };
  const role = Object.keys(roles).find(prefix => finding.ruleId.startsWith(prefix + '-'));
  const properties: Record<string, string> = { 'font-size': 'size', 'font-family': 'family', 'font-weight': 'weight', 'line-height': 'line height', 'letter-spacing': 'tracking', 'text-transform': 'case' };
  return role ? `${roles[role]} / ${properties[finding.property ?? ''] ?? finding.property ?? ''}` : finding.ruleId;
};
// Group text properties for the same documented role; retain every measurement.
const errorKey = (finding: Finding): string => finding.property === 'font-size' ? `${finding.ruleId}:${value(finding.actual)}` : finding.ruleId;
function errorGroups(items: Finding[]): Finding[][] {
  const groups = new Map<string, Finding[]>();
  for (const item of items.filter(item => item.status === 'mismatch' && item.source && item.expected && item.actual)) {
    const key = errorKey(item); groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const order = (item: Finding) => item.property === 'font-size' ? 0 : item.property === 'line-height' ? 1 : 2;
  return [...groups.values()].map(items => items.sort((a, b) => order(a) - order(b)));
}
function errorName(finding: Finding): string {
  if (finding.property === 'font-size') {
    if (finding.ruleId === 'TYPE-UI-FONT-SIZE') return finding.actual?.value === 14 ? 'Project details text is too small' : 'Link text is too large';
    return 'Section headings are too small';
  }
  return finding.property === 'color' ? 'Label text uses the wrong color' : name(finding);
}
function value(value: Normalized | null): string {
  if (!value) return 'Not evaluated';
  if (value.kind === 'px') return `${value.value} px`;
  if (value.kind === 'rgba') return value.value[3] === 1 ? '#' + value.value.slice(0, 3).map(channel => channel.toString(16).padStart(2, '0')).join('') : `rgba(${value.value.join(', ')})`;
  return String(value.value);
}
function declaration(exp: Expectation | null): string {
  if (!exp) return 'No established value';
  if (exp.kind === 'px') return `${exp.value}px`;
  if (exp.kind === 'max-px') return `at most ${exp.value}px`;
  if (exp.kind === 'number' || exp.kind === 'keyword' || exp.kind === 'font-family') return String(exp.value);
  if (exp.kind === 'font-relative') return `${exp.factor} × source font size ${declaration(exp.fontSize)}`;
  if (exp.kind === 'color') return typeof exp.value === 'string' ? exp.value : exp.value[current.theme];
  if (exp.kind === 'clamp-vw') return `clamp(${exp.min}px, ${exp.vw}vw, ${exp.max}px)`;
  return exp.expression;
}
function fillWidths(): void {
  width.replaceChildren();
  const widths = [...new Set(data.runs.filter(run => run.theme === theme.value).map(run => run.viewport.width))].sort((a, b) => a - b);
  for (const item of widths) { const option = node('option', `${item} px`); option.value = String(item); width.append(option); }
  width.value = widths.includes(current.viewport.width) ? String(current.viewport.width) : String(widths[0]);
}
function renderCoverage(): void {
  const report = data.report;
  byId('outcome').textContent = report.outcome === 'mismatches' ? (visualOnly ? 'Needs review' : 'Mismatches found') : report.outcome === 'incomplete' ? 'Incomplete - limited coverage' : 'Declared checks match';
  byId('outcome').classList.toggle('pass', report.outcome === 'checked-scope-pass'); byId('outcome').classList.toggle('mismatch', report.outcome === 'mismatches');
  byId('counts').textContent = visualOnly ? `${errorGroups(report.findings).length} design errors` : `${report.summary.counts.pass} matches · ${report.summary.counts.mismatch} mismatches · ${report.summary.counts['not-applicable']} not applicable`;
  byId('audit-meta').textContent = visualOnly ? `Text size and color · ${new Set(data.runs.map(run => run.theme)).size === 2 ? 'Light and dark' : current.theme} · ${new Set(data.runs.map(run => run.viewport.width)).size} screen widths` : `${data.runs.length} width/theme contexts · ${data.rules.length} rules · baseline ${report.baseline.version}`;
  byId('report-id').textContent = `Report ${report.id.slice(0, 12)}`;
  const synthetic = report.evidenceKind === 'synthetic';
  byId('evidence-kind').hidden = !synthetic;
  byId('evidence-kind').textContent = 'Synthetic fixture evidence. This is not a real portfolio audit.';
  const issues = data.runs.reduce((sum, run) => sum + (run.capture?.issues.length ?? 0) + (run.status === 'failed' ? 1 : 0), 0);
  const open = report.summary.counts.unchecked + report.summary.counts['missing-guidance'] + report.summary.counts.ambiguous + report.summary.counts.proposed;
  byId('coverage-label').textContent = visualOnly ? `Audit scope and saved design-system rules${open ? ` · ${open} checks could not be measured` : ''}` : `Scope and sources · ${report.baseline.coverage === 'partial' ? 'partial baseline' : 'declared rules only'} · ${open} unresolved findings · ${issues} capture diagnostics`;
  const body = byId('coverage-body'); body.replaceChildren();
  const scope = node('section'); scope.append(node('h2', 'Coverage limits'));
  const ul = node('ul'); for (const item of report.limitations) ul.append(node('li', item)); scope.append(ul);
  const counts = node('p', statuses.filter(status => !visualOnly || report.summary.counts[status] > 0).map(status => `${statusNames[status]}: ${report.summary.counts[status]}`).join(' · ')); if (!visualOnly) scope.append(counts); body.append(scope);
  const sources = node('section'); sources.append(node('h2', 'Saved rule sources'));
  for (const source of report.baseline.sources) {
    const p = node('p'); p.append(node('strong', source.id), node('br'), node('code', source.snapshot), node('br'));
    const local = data.sources.find(item => item.id === source.id); if (local) p.append(link('Open saved snapshot', local.file), node('br'));
    p.append(link('Open published source', source.url, true), node('br'), node('code', `SHA256 ${source.sha256}`)); sources.append(p);
  }
  sources.append(node('p', 'The saved snapshot is the audit authority. Opening a published source may show newer content.')); body.append(sources);
  const diagnostics = node('section'); diagnostics.append(node('h2', 'Capture diagnostics'));
  if (!issues) diagnostics.append(node('p', synthetic ? 'No browser capture in this fixture.' : 'No recorded capture diagnostics.'));
  for (const run of data.runs) {
    const messages = [...(run.capture?.issues ?? []), ...(run.reason ? [run.reason] : [])];
    if (messages.length) { const details = node('details'); details.append(node('summary', `${run.id} · ${messages.length} diagnostic(s)`)); const list = node('ul'); for (const message of messages) list.append(node('li', message)); details.append(list); diagnostics.append(details); }
  }
  body.append(diagnostics);
}
function renderDetails(): void {
  const details = byId('details'); details.replaceChildren();
  if (!selected) { details.append(node('p', visualOnly ? 'No design errors in this view. Choose another width/theme or clear the search.' : 'No findings match these filters. Change the status or search to continue.')); return; }
  const finding = selected; const left = node('div'); const title = node('div', '', 'selected-title');
  title.append(node('h2', visualOnly ? errorName(finding) : name(finding)), node('span', statusNames[finding.status], finding.status)); left.append(title);
  const selector = node('p', '', 'selector'); selector.append(node('code', finding.element ?? finding.selector ?? 'No element mapped'), node('br'), node('code', `${finding.property ?? 'No property mapped'} · ${finding.ruleId}`)); if (visualOnly) { const technical = node('details'); technical.append(node('summary', 'Rule and capture details'), selector); left.append(technical); } else left.append(selector);
  const source = node('p', '', 'source'); source.append(node('span', 'Declared rule: '), node('code', declaration(finding.expectation)), node('br'));
  if (finding.source) {
    const src = finding.source; const url = new URL(src.url); url.hash = src.anchor;
    source.append(link('Open published rule', url.href, true));
    const local = data.sources.find(item => item.id === src.id); if (local) source.append(link('Saved source snapshot', local.file));
    source.append(node('br'), node('span', `Source: ${src.id} / ${src.anchor}`));
  } else source.append(node('span', 'No established source attached.'));
  if (visualOnly) left.querySelector('details')!.append(source); else left.append(source); if (finding.recommendation) left.append(node('p', `Recommendation: ${finding.recommendation}`, 'explanation'));
  const right = node('div'); const values = node('dl', '', 'values');
  for (const [label, text] of [[visualOnly ? 'Design system' : 'Expected at this viewport', `${finding.expectation?.kind === 'max-px' ? '≤ ' : ''}${value(finding.expected)}`], [visualOnly ? 'On this page' : 'Measured result', value(finding.actual)], ['Captured raw value', finding.observedValue === null ? 'Not captured' : String(finding.observedValue)]]) {
    if (visualOnly && label === 'Captured raw value') continue;
    const row = node('div'); const measured = node('dd', text!);
    const color = label === 'Design system' ? finding.expected : label === 'On this page' ? finding.actual : null;
    if (visualOnly && color?.kind === 'rgba') { const swatch = node('span', '', 'value-swatch'); swatch.style.backgroundColor = `rgba(${color.value.join(',')})`; swatch.setAttribute('aria-hidden', 'true'); measured.prepend(swatch); }
    row.append(node('dt', label!), measured); values.append(row);
  }
  right.append(values); if (!visualOnly) right.append(node('p', finding.reason, 'explanation'));
  if (visualOnly) {
    const related = data.report.findings.filter(item => item.runId === current.id && item.status === 'mismatch' && errorKey(item) === errorKey(finding) && item.element === finding.element && item.id !== finding.id);
    if (related.length) {
      const extra = node('details'); extra.append(node('summary', 'Related text styles on this element'));
      for (const item of related) extra.append(node('p', `${item.property}: expected ${value(item.expected)}, measured ${value(item.actual)}`, 'explanation'));
      right.append(extra);
    }
  }
  const bounds = data.locations[finding.id];
  if (bounds && bounds.width > 0 && bounds.height > 0) (visualOnly ? left.querySelector('details')! : right).append(node('p', `Document position ${bounds.x.toFixed(2)}, ${bounds.y.toFixed(2)} px · bounds ${bounds.width.toFixed(2)} × ${bounds.height.toFixed(2)} px`, 'explanation'));
  else right.append(node('p', 'No measured bounds for this finding. Its screenshot location cannot be highlighted.', 'explanation'));
  details.append(left, right);
}
function drawHighlight(scroll = false): void {
  const bounds = selected && data.locations[selected.id]; const shot = current.capture?.screenshot;
  const available = !!bounds && bounds.width > 0 && bounds.height > 0 && !!shot && !!current.image && imageReady && !imageFailed;
  highlight.hidden = !available; locate.disabled = !available;
  if (!available || !bounds || !shot) return;
  highlight.style.left = `${bounds.x / shot.width * 100}%`; highlight.style.top = `${bounds.y / shot.height * 100}%`;
  highlight.style.width = `${bounds.width / shot.width * 100}%`; highlight.style.height = `${bounds.height / shot.height * 100}%`;
  highlight.classList.toggle('mismatch', selected!.status === 'mismatch'); highlight.classList.toggle('top-edge', bounds.y < 25);
  byId('highlight-label').textContent = visualOnly ? errorName(selected!) : selected!.element ?? selected!.ruleId;
  if (scroll) {
    const scale = image.clientWidth / shot.width;
    evidence.scrollTo({ top: Math.max(0, bounds.y * scale - 35), left: actualSize ? Math.max(0, bounds.x * scale - 25) : 0, behavior: 'instant' });
  }
}
function select(finding: Finding): void {
  const focus = document.activeElement?.getAttribute('data-focus-key');
  selected = finding; renderList(); renderDetails(); drawHighlight(true);
  if (focus) [...document.querySelectorAll<HTMLButtonElement>('[data-focus-key]')].find(item => item.dataset.focusKey === focus)?.focus({ preventScroll: true });
}
function renderList(): void {
  const container = byId('findings'); container.replaceChildren();
  byId('list-count').textContent = `${visible.length} of ${data.report.findings.filter(item => item.runId === current.id).length} findings in this capture`;
  if (visualOnly) {
    const groups = errorGroups(visible);
    byId('list-count').textContent = `${groups.length} design error${groups.length === 1 ? '' : 's'} in this view`;
    if (!groups.length) container.append(node('p', 'No design errors in this view.', 'quiet'));
    for (const findings of groups) {
      const first = findings[0]!; const active = findings.some(item => item.id === selected?.id);
      const button = node('button', '', 'finding'); button.type = 'button'; button.dataset.focusKey = `error-${errorKey(first)}`;
      button.setAttribute('aria-pressed', String(active)); button.setAttribute('aria-controls', 'details');
      button.append(node('strong', errorName(first)));
      const properties = visualOnly ? [`Expected ${value(first.expected)} · found ${value(first.actual)}`] : [...new Set(findings.map(item => item.property))];
      button.append(node('small', properties.join(', ')));
      button.addEventListener('click', () => select(first)); container.append(button);
      if (active) {
        const locations = [...new Map(findings.map(item => [item.element, findings.find(candidate => candidate.element === item.element)!])).values()];
        if (locations.length > 1) {
          const next = node('button', 'Next affected location'); next.type = 'button'; next.dataset.focusKey = `next-${errorKey(first)}`;
          next.addEventListener('click', () => select(locations[(locations.findIndex(item => item.element === selected?.element) + 1) % locations.length]!));
          container.append(next);
        }
      }
    }
    return;
  }
  if (!visible.length) { container.append(node('p', 'No matching findings.', 'quiet')); return; }
  const groups = new Map<string, Finding[]>();
  for (const finding of visible) groups.set(finding.ruleId, [...(groups.get(finding.ruleId) ?? []), finding]);
  const priority: Record<FindingStatus, number> = { mismatch: 0, unchecked: 1, ambiguous: 1, 'missing-guidance': 1, proposed: 2, pass: 3, deferred: 4, 'not-applicable': 5 };
  const rank = (items: Finding[]) => Math.min(...items.map(item => priority[item.status]));
  const ordered = [...groups.values()].sort((a, b) => rank(a) - rank(b) || Number(b[0]!.ruleId === 'TYPE-DISPLAY') - Number(a[0]!.ruleId === 'TYPE-DISPLAY'));
  for (const findings of ordered) {
    const first = findings[0]!; const active = findings.some(item => item.id === selected?.id);
    const button = node('button', '', 'finding'); button.type = 'button'; button.dataset.focusKey = `rule-${first.ruleId}`; button.setAttribute('aria-pressed', String(active)); button.setAttribute('aria-controls', 'details');
    const row = node('span', '', 'row'); row.append(node('strong', name(first)));
    const unique = [...new Set(findings.map(item => item.status))]; row.append(node('span', unique.length === 1 ? statusNames[first.status] : 'Mixed results', `state ${unique.length === 1 ? first.status : ''}`));
    button.append(row, node('small', `${first.property ?? first.ruleId} · ${findings.length} finding${findings.length === 1 ? '' : 's'}`));
    button.addEventListener('click', () => select(first)); container.append(button);
    if (active && findings.length > 1) {
      const instances = node('div', '', 'instances');
      for (const finding of findings) {
        const item = node('button', `${finding.element ?? finding.ruleId} · ${statusNames[finding.status]}`); item.type = 'button'; item.dataset.focusKey = finding.id; item.setAttribute('aria-pressed', String(selected?.id === finding.id)); item.addEventListener('click', () => select(finding)); instances.append(item);
      }
      container.append(instances);
    }
  }
  const active = container.querySelector<HTMLElement>('.instances button[aria-pressed=true]') ?? container.querySelector<HTMLElement>('.finding[aria-pressed=true]');
  if (active) {
    const box = active.getBoundingClientRect(); const frame = container.getBoundingClientRect();
    if (box.top < frame.top) container.scrollTop += box.top - frame.top;
    else if (box.bottom > frame.bottom) container.scrollTop += box.bottom - frame.bottom;
  }
}
function applyFilter(): void {
  const query = search.value.trim().toLowerCase();
  visible = data.report.findings.filter(finding => finding.runId === current.id && (visualOnly ? finding.status === 'mismatch' : (filter.value === 'all' || finding.status === filter.value)) && `${finding.ruleId} ${finding.selector} ${finding.element} ${finding.property} ${name(finding)}`.toLowerCase().includes(query));
  if (visualOnly) visible = errorGroups(visible).flat();
  if (!visible.some(item => item.id === selected?.id)) selected = visible.find(item => item.status === 'mismatch') ?? visible.find(item => item.ruleId === 'TYPE-DISPLAY') ?? visible[0];
  renderList(); renderDetails(); drawHighlight(true);
}
function changeRun(preserveRun = false): void {
  const candidates = data.runs.filter(run => run.theme === theme.value && run.viewport.width === Number(width.value));
  current = (preserveRun ? candidates.find(run => run.id === runSelect.value) : undefined) ?? candidates[0]!;
  runSelect.replaceChildren();
  for (const run of candidates) { const option = node('option', run.id); option.value = run.id; runSelect.append(option); }
  runSelect.value = current.id; byId('run-label').hidden = candidates.length < 2;
  imageReady = false; imageFailed = false; highlight.hidden = true; image.hidden = !current.image; byId('no-image').hidden = !!current.image;
  byId('no-image').textContent = current.reason ?? (data.report.evidenceKind === 'synthetic' ? 'Synthetic fixture: no verified browser screenshot.' : 'No screenshot was captured for this context.');
  zoom.disabled = !current.image; actualSize = false; zoom.textContent = 'Actual size'; zoom.setAttribute('aria-pressed', 'false'); canvas.classList.remove('actual');
  const shot = current.capture?.screenshot; canvas.style.setProperty('--image-width', `${shot?.width ?? current.viewport.width}px`);
  if (current.image) { image.alt = `${data.title}, ${current.theme} audited theme, ${current.viewport.width} px viewport`; image.src = current.image; }
  else image.removeAttribute('src');
  byId('image-status').textContent = `${current.theme} audited theme · viewport ${current.viewport.width} × ${current.viewport.height} px${current.image ? ' · Full-page capture, fit to width' : ' · No screenshot evidence'}`;
  byId('saved-evidence').textContent = shot ? `${current.pageUrl} · ${current.id} · ${shot.width} × ${shot.height} px · captured ${current.capture!.capturedAt} · ${current.capture!.browser}` : `${current.id} · ${current.pageUrl}`;
  evidence.scrollTo(0, 0); applyFilter();
}
image.addEventListener('load', () => { imageReady = true; imageFailed = false; image.hidden = false; byId('no-image').hidden = true; drawHighlight(true); });
image.addEventListener('error', () => { imageFailed = true; imageReady = false; image.hidden = true; byId('no-image').hidden = false; byId('no-image').textContent = 'Screenshot could not be loaded. Keep the report folder and its assets together, then reopen index.html.'; zoom.disabled = true; drawHighlight(); });
locate.addEventListener('click', () => drawHighlight(true));
zoom.addEventListener('click', () => { actualSize = !actualSize; canvas.classList.toggle('actual', actualSize); zoom.textContent = actualSize ? 'Fit width' : 'Actual size'; zoom.setAttribute('aria-pressed', String(actualSize)); byId('image-status').textContent = `${current.theme} audited theme · viewport ${current.viewport.width} × ${current.viewport.height} px · ${actualSize ? 'Actual pixel size' : 'Full-page capture, fit to width'}`; requestAnimationFrame(() => drawHighlight(true)); });
theme.addEventListener('change', () => { fillWidths(); changeRun(); }); width.addEventListener('change', () => changeRun()); runSelect.addEventListener('change', () => changeRun(true)); filter.addEventListener('change', applyFilter); search.addEventListener('input', applyFilter);
new ResizeObserver(() => drawHighlight()).observe(image);
for (const item of [...new Set(data.runs.map(run => run.theme))]) { const option = node('option', item === 'dark' ? 'Dark' : 'Light'); option.value = item; theme.append(option); }
theme.value = current.theme; fillWidths();
for (const status of statuses.filter(status => !visualOnly || data.report.summary.counts[status] > 0)) { const option = node('option', `${statusNames[status]} (${data.report.summary.counts[status]})`); option.value = status; filter.append(option); }
if (visualOnly && data.report.summary.counts.mismatch > 0) filter.value = 'mismatch';
if (visualOnly) {
  document.body.classList.add('documented-visual');
  const review = document.querySelector('.review')!;
  review.insertBefore(byId('details'), review.firstChild);
  byId<HTMLInputElement>('search').placeholder = 'Search design errors';
  document.querySelector<HTMLLabelElement>('label[for=search]')!.textContent = 'Find an error';
  filter.hidden = true;
  document.querySelector('.scope-note')!.textContent = 'Only documented visual design errors are listed. Repeated locations are grouped.';
  document.querySelector<HTMLLabelElement>('label[for=status]')!.hidden = true;
  document.querySelector('.index h2')!.textContent = 'Design errors';
}
renderCoverage(); changeRun();
