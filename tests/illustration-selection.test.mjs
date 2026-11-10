import assert from 'node:assert/strict';
import test from 'node:test';
import { imageTextRegions, textLines } from '../dist/image-text-regions.js';
import { applyImageInsertions, createImageInsertionPlan, createSelectedImageInsertionPlan,
  selectImageInsertionPoints } from '../dist/image-insertion.js';
import { buildIllustrationUnits, groupIllustrationLines, normalizeIllustrationItems } from '../dist/illustration-selection.js';
import { parseImageMarkers } from '../dist/image-markers.js';

const html = '<div class="scene">\n    <p>第一段场景文字。</p>\n    <p>第二段场景文字。</p>\n</div>\n<p>第三段场景文字。</p>';
const prepare = (text, excluded = []) => {
  const plan = createSelectedImageInsertionPlan(text, excluded);
  return { plan, units: buildIllustrationUnits(plan, 'manual', 3, excluded) };
};
const group = (value, first, last) => groupIllustrationLines(value.plan, value.units, first - 1, last - 1);
const row = (id) => ({ at: id, summary: '场景', prompt: 'test illustration' });

test('HTML-indented prose remains selectable in all existing grouping modes', () => {
  assert.equal(imageTextRegions(html).some(region => region.kind === 'code'), false);
  const { plan, units } = prepare(html);
  assert.ok(units[1].pointIds.length);
  assert.ok(units[2].pointIds.length);
  assert.equal(units[0].pointIds.length, 0);
  assert.equal(units[3].pointIds.length, 0);
  for (const mode of ['paragraph', 'lines', 'sentence']) {
    const values = buildIllustrationUnits(plan, mode);
    for (const text of ['第一段', '第二段', '第三段']) {
      assert.ok(values.some(unit => unit.text.includes(text) && unit.pointIds.length), `${mode}: ${text}`);
    }
  }
  assert.ok(createImageInsertionPlan(html).points.some(point => point.offset === html.indexOf('    <p>第二段')));
});

test('nested and multiline HTML containers handle quotes, tabs, case and closing boundaries', () => {
  const text = '<SECTION\n data-title="a > b">\n    <div>\n\t<p>正文。</p>\n    </div>\n    <div />\n</SECTION>\n    const realCode = 1;';
  const { units } = prepare(text);
  assert.ok(units[3].pointIds.length);
  assert.equal(units[7].blocked, true);
  assert.equal(units[7].pointIds.length, 0);
  const comments = imageTextRegions('<!-- <div> -->\n    stillCode();');
  assert.equal(comments.at(-1).kind, 'code');
});

test('standalone Markdown indentation, narrative-wrapper code and fenced HTML stay protected', () => {
  for (const text of ['    <p>code sample</p>\n', '\tcode();\n',
    '<now_plot>\n    code();\n</now_plot>', '<gametxt>\n\tcode();\n</gametxt>',
    '```html\n<div>\n    <p>sample</p>\n</div>\n```', '<div>\n```js\ncode();\n```\n</div>']) {
    const { units } = prepare(text);
    assert.ok(units.some(unit => unit.blocked), text);
    assert.ok(units.every(unit => !unit.pointIds.length), text);
  }
});

test('manual groups preserve exact source rows, blank lines, CRLF and inert markup', () => {
  const text = '\r\n<div>\r\n    <p>甲 &amp; $&。</p>\r\n\r\n</div>\r\n第二处场景。\r\n';
  const value = prepare(text);
  assert.deepEqual(value.units.map(unit => [unit.lineStart, unit.lineEnd]), [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]]);
  assert.equal(value.units.map(unit => unit.text).join(''), text);
  const selected = group(value, 3, 6);
  assert.equal(selected.text, text.slice(text.indexOf('    <p>')));
  assert.equal(selected.lineStart, 3);
  assert.equal(selected.lineEnd, 6);
  assert.deepEqual(group(value, 6, 3), selected);
  assert.equal(group(value, 3, 3).text, value.units[2].text);
  assert.equal(new Set(selected.pointIds).size, selected.pointIds.length);
  const offsets = selected.pointIds.map(id => value.plan.points.find(point => point.id === id).offset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  assert.ok(Object.isFrozen(selected) && Object.isFrozen(selected.pointIds));
});

test('manual endpoints must be selectable whole rows with valid indexes', () => {
  const value = prepare('<div>\n正文。\n\n</div>');
  for (const [first, last] of [[0, 1], [1, 2], [1, 3], [-1, 1], [1, 4], [1.5, 1], [NaN, 1], [1, Infinity]]) {
    assert.throws(() => groupIllustrationLines(value.plan, value.units, first, last), /首尾行/);
  }
  assert.deepEqual(prepare('').units, []);
});

test('protected code, image and opaque HTML rows cannot be included in manual groups', () => {
  for (const barrier of ['```js\ncode();\n```', '    code();', '含有 `code()` 的一行。',
    '<img>\n[原有配图]\nold prompt\n</img>', '<!-- hidden -->', '<![CDATA[hidden]]>', '<?hidden?>',
    ...['script', 'style', 'pre', 'code', 'textarea', 'title', 'a', 'button', 'select', 'option']
      .map(tag => `<${tag}>\nopaque content\n</${tag}>`)]) {
    const value = prepare(`前方正文。\n${barrier}\n后方正文。`);
    assert.ok(value.units.slice(1, -1).every(unit => unit.blocked && !unit.pointIds.length), barrier);
    assert.throws(() => group(value, 1, value.units.length), /跨过/, barrier);
    assert.ok(group(value, 1, 1).pointIds.length);
    assert.ok(group(value, value.units.length, value.units.length).pointIds.length);
  }
});

test('inline exclusions block their whole source row and folded exclusions remain barriers', () => {
  for (const block of ['<think>hidden</think>', '<nailong~>hidden</nailong~>', '<思考>hidden</思考>',
    '<think>one\n<think>nested</think>\ntwo</think>', '可见文字。<think>hidden</think>尾部文字。']) {
    const text = `第一行。\n${block}\n最后一行。`;
    const value = prepare(text, ['think', 'nailong~', '思考']);
    assert.ok(value.units.slice(1, -1).every(unit => unit.blocked && !unit.pointIds.length));
    assert.throws(() => group(value, 1, value.units.length), /跨过/);
    assert.equal(value.units.map(unit => unit.text).join(''), text);
  }
});

test('unclosed opaque HTML, attributes, images and code never yield manual points', () => {
  for (const barrier of ['<script>\nbody', '<!-- hidden', '<div title="unfinished\nbody', '<img>\n[image]\nprompt', '```\ncode', '`code']) {
    const value = prepare(`正文。\n${barrier}`);
    assert.ok(value.units.slice(1).every(unit => unit.blocked && !unit.pointIds.length), barrier);
  }
});

test('narrative bounds and existing insertion IDs remain intact', () => {
  const value = prepare('前言。\n<now_plot>\n<div>\n    <p>正文【插入点 P001】。</p>\n</div>\n</now_plot>\n尾注。');
  assert.equal(value.units[0].pointIds.length, 0);
  assert.equal(value.units.at(-1).pointIds.length, 0);
  assert.ok(value.units[3].pointIds.length);
  assert.ok(value.plan.points.every(point => point.id !== 'P001'));
});

test('line-number calculation handles CR, LF, no trailing newline and empty lines', () => {
  for (const eol of ['\r', '\n', '\r\n']) {
    const text = `甲。${eol}${eol}乙。`;
    const value = prepare(text);
    assert.equal(value.units.length, 3);
    assert.deepEqual(textLines(text).map(line => text.slice(line.start, line.end)), value.units.map(unit => unit.text));
    assert.equal(group(value, 1, 3).text, text);
    assert.deepEqual(value.units.map(unit => unit.lineStart), [1, 2, 3]);
  }
});

test('normalization preserves item order, sorts positions and rejects duplicate or overlapping ranges', () => {
  const value = prepare('第一处。另一句。\n第二处。\n第三处。');
  const selected = [group(value, 3, 3), group(value, 1, 1)];
  const normalized = normalizeIllustrationItems(value.plan, selected.map(unit => ({ pointIds: [...unit.pointIds].reverse() })));
  assert.deepEqual(normalized.map(unit => unit.pointIds), selected.map(unit => unit.pointIds));
  const ids = value.plan.points.map(point => point.id);
  for (const items of [[], [{ pointIds: [] }], [{ pointIds: ['missing'] }], [{ pointIds: [ids[0], ids[0]] }],
    [group(value, 1, 2), group(value, 2, 3)], [{ pointIds: [ids[0], ids[2]] }, { pointIds: [ids[1]] }]]) {
    assert.throws(() => normalizeIllustrationItems(value.plan, items));
  }
});

test('capacity counts existing image markers and allows exactly 64 total', () => {
  const existing = '<img>\n[原有图片]\nold prompt\n</img>\n';
  const value = prepare(existing + Array.from({ length: 64 }, (_, index) => `正文 ${index}。`).join('\n'));
  const rows = value.units.filter(unit => unit.pointIds.length);
  assert.equal(normalizeIllustrationItems(value.plan, rows.slice(0, 63)).length, 63);
  assert.throws(() => normalizeIllustrationItems(value.plan, rows), /64/);
  assert.equal(parseImageMarkers(value.plan.original).length, 1);
});

test('one manual range produces one image without rewriting any original characters', () => {
  const value = prepare(html);
  const items = normalizeIllustrationItems(value.plan, [group(value, 2, 3), group(value, 5, 5)]);
  const selectedPlan = selectImageInsertionPoints(value.plan, items.flatMap(item => item.pointIds));
  assert.equal(selectedPlan.original, html);
  const response = items.map(item => row(item.pointIds.at(-1)));
  const result = applyImageInsertions(selectedPlan, JSON.stringify(response), items);
  assert.equal(result.added.length, 2);
  let expected = html;
  for (const entry of [...response].sort((left, right) => selectedPlan.points.find(point => point.id === right.at).offset - selectedPlan.points.find(point => point.id === left.at).offset)) {
    const offset = selectedPlan.points.find(point => point.id === entry.at).offset;
    const prefix = /[\r\n]/.test(html[offset - 1]) ? '\n' : '\n\n';
    const insertion = `${prefix}<img>\n[${entry.summary}]\n${entry.prompt}\n</img>\n\n`;
    expected = expected.slice(0, offset) + insertion + expected.slice(offset);
  }
  assert.equal(result.text, expected);
  assert.throws(() => applyImageInsertions(selectedPlan, JSON.stringify(response.slice(0, 1)), items), /遗漏/);
  assert.throws(() => applyImageInsertions(selectedPlan, JSON.stringify([...response, row(items[0].pointIds[0])]), items), /多条/);
  const unselected = value.plan.points.find(point => !selectedPlan.points.includes(point));
  assert.throws(() => applyImageInsertions(value.plan, JSON.stringify([row(unselected.id)]), items), /未选择/);
  assert.equal(value.plan.original, html);
});
