import assert from 'node:assert/strict';
import path from 'node:path';

/** Reuses the offline Tavern host from workflow-browser; no real key or upstream request. */
export async function testOpenAIImage26(page, panel, screenshots) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const pixel = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#678ab0'; context.fillRect(0, 0, 64, 64);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const calls = [];
  await page.route('https://image-mock.invalid/v1/**', async route => {
    const request = route.request();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (request.url().endsWith('/models')) {
      await route.fulfill({ json: { data: [{ id: 'gpt-image-2.6-flare' }, { id: 'gpt-image-2.6-sunburst' }, { id: 'custom-image' }] }, headers }); return;
    }
    assert.equal(request.url(), 'https://image-mock.invalid/v1/images/generations');
    assert.equal(request.method(), 'POST');
    calls.push(request.postDataJSON());
    await route.fulfill({ json: { data: [{ b64_json: pixel }] }, headers });
  });
  await page.route('https://api.openai.com/**', route => route.abort());
  await page.locator('.sidebar [data-page="image-api"]').click();
  await panel.locator('[data-action="switch-provider"][data-provider="openai"]').click();
  const model = panel.locator('[data-parameter="model"]'), complexity = panel.locator('[data-parameter="complexity"]');
  assert.equal(await model.inputValue(), ''); // Do not switch existing defaults to the new model.
  assert.equal(await complexity.inputValue(), 'default'); assert.equal(await complexity.isDisabled(), true);
  await model.fill('gpt-image-2.6-flare'); assert.equal(await complexity.isEnabled(), true);
  await complexity.selectOption('medium'); await panel.locator('[data-parameter="quality"]').selectOption('max');
  await model.fill('gpt-image-2.5-flare'); assert.equal(await complexity.isDisabled(), true);
  assert.equal(await complexity.inputValue(), 'medium');
  await model.fill('gpt-image-2.6-sunburst'); assert.equal(await complexity.isEnabled(), true);
  assert.match(await panel.locator('[data-complexity-hint]').innerText(), /官方默认高/);
  await panel.locator('[data-connection="channel"]').selectOption('custom');
  await panel.locator('[data-connection="url"]').fill('https://image-mock.invalid/v1');
  await panel.locator('[data-connection="key"]').fill('offline-test-not-a-real-key');
  assert.equal(await panel.locator('#witch-image-model-options option[value="gpt-image-2.6-sunburst"]').count(), 1);
  await panel.locator('[data-action="save-connection"]').click();
  await page.waitForFunction(() => document.querySelector('#tavern-image-plugin').shadowRoot.querySelector('[data-connection-status]').textContent.includes('已保存'));
  assert.equal(await complexity.isEnabled(), true); assert.equal(await complexity.inputValue(), 'medium');
  await panel.locator('[data-action="refresh-models"]').click();
  await page.waitForFunction(() => document.querySelector('#tavern-image-plugin').shadowRoot.querySelector('[data-model-list-status]').textContent.includes('已获取 3'));
  assert.equal(await model.inputValue(), 'gpt-image-2.6-sunburst');
  await panel.locator('[data-field="sizePreset"]').selectOption('square');
  await panel.locator('[data-field="positive"]').fill('offline fixture scene');
  await panel.locator('[data-action="generate"]').click();
  await page.waitForFunction(() => document.querySelector('#tavern-image-plugin').shadowRoot.querySelector('[data-generation-status]').textContent === '生成完成。');
  assert.deepEqual(calls[0], { model: 'gpt-image-2.6-sunburst', prompt: 'offline fixture scene', n: 1,
    size: '1024x1024', quality: 'max', output_format: 'png', complexity: 'medium' });
  assert.match(await panel.locator('[data-output] a').getAttribute('download'), /\.png$/);
  const roundTrip = await page.evaluate(async () => {
    const { loadImageHistoryPage, saveImageHistory } = await import('/dist/image-history.js');
    const { exportArchive, parseArchive, summarizeArchive } = await import('/dist/config-archive.js');
    const { createImageGallery } = await import('/dist/image-gallery.js');
    const entries = (await loadImageHistoryPage(null, null)).entries;
    const latest = entries.find(entry => entry.provider === 'openai');
    const parsed = parseArchive(await (await exportArchive('all', false, testContext)).text());
    const old = structuredClone(parsed); delete old.data.image.profiles.openai.openaiParameters.complexity;
    const missingDefault = parseArchive(JSON.stringify(old)).data.image.profiles.openai.openaiParameters.complexity;
    const invalid = structuredClone(parsed); invalid.data.image.profiles.openai.openaiParameters.complexity = 'auto';
    let invalidRejected = false; try { parseArchive(JSON.stringify(invalid)); } catch { invalidRejected = true; }
    const gallery = createImageGallery('offline', new AbortController().signal, async () => {});
    const url = URL.createObjectURL(latest.blob); gallery.setImages([{ entry: latest, url }], latest.id);
    const properties = gallery.element.querySelector('.wp-gallery-properties').textContent;
    const legacy = { ...latest, id: 'legacy-openai-test', markerKey: JSON.stringify(['unassigned', '', 'legacy']), parameters: { ...latest.parameters } };
    delete legacy.parameters.complexity; await saveImageHistory(legacy);
    const oldHistory = (await loadImageHistoryPage(null, null)).entries.find(entry => entry.id === legacy.id);
    gallery.close(); URL.revokeObjectURL(url);
    return { historyComplexity: latest.parameters.complexity, exportedComplexity: parsed.data.image.profiles.openai.openaiParameters.complexity,
      missingDefault, oldHistory: oldHistory.parameters.complexity, invalidRejected, properties,
      summary: summarizeArchive(parsed).find(row => row.title === 'GPT 生图 API').detail };
  });
  assert.equal(roundTrip.historyComplexity, 'medium'); assert.equal(roundTrip.exportedComplexity, 'medium');
  assert.equal(roundTrip.missingDefault, 'default'); assert.equal(roundTrip.oldHistory, 'default'); assert.equal(roundTrip.invalidRejected, true);
  assert.match(roundTrip.properties, /请求规划深度中 · medium/); assert.match(roundTrip.summary, /规划深度 中 · medium/);

  // Confirm default omission and old-model isolation through the real UI generation path.
  await complexity.selectOption('default');
  await panel.locator('[data-action="generate"]').click();
  await page.waitForFunction(() => document.querySelector('#tavern-image-plugin').shadowRoot.querySelector('[data-generation-status]').textContent === '生成完成。');
  assert.equal(Object.hasOwn(calls[1], 'complexity'), false);
  await complexity.selectOption('high'); await model.fill('gpt-image-2.5-flare');
  await panel.locator('[data-action="generate"]').click();
  await page.waitForFunction(() => document.querySelector('#tavern-image-plugin').shadowRoot.querySelector('[data-generation-status]').textContent === '生成完成。');
  assert.equal(Object.hasOwn(calls[2], 'complexity'), false);
  assert.equal(await complexity.inputValue(), 'high');
  await model.fill('gpt-image-2.6-flare');
  // Verify full configuration import restores the new parameter and the live editor cache.
  const archiveFile = await page.evaluate(async () => {
    const { exportArchive } = await import('/dist/config-archive.js');
    const value = JSON.parse(await (await exportArchive('all', false, testContext)).text());
    value.data.image.profiles.openai.openaiParameters.complexity = 'low'; return JSON.stringify(value);
  });
  await page.locator('.sidebar [data-page="preferences"]').click();
  await panel.locator('[data-transfer-file]').setInputFiles({ name: 'image-26-config.json', mimeType: 'application/json', buffer: Buffer.from(archiveFile) });
  await panel.locator('[data-transfer-action="confirm"]').waitFor();
  await panel.locator('[data-transfer-section="parameters"][data-transfer-mode="overwrite"]').click();
  await panel.locator('[data-transfer-action="confirm"]').click();
  await page.waitForFunction(() => document.querySelector('#tavern-image-plugin').shadowRoot.querySelector('[data-transfer-status]').textContent.includes('配置已导入'));
  await page.locator('.sidebar [data-page="image-api"]').click();
  assert.equal(await model.inputValue(), 'gpt-image-2.6-flare'); assert.equal(await complexity.inputValue(), 'low');
  assert.equal(await complexity.isEnabled(), true);
  await complexity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshots, 'gpt-image-26-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await complexity.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshots, 'gpt-image-26-mobile.png') });
  const geometry = await panel.locator('.content').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry));
  return { mockRequests: calls.length, ...roundTrip, geometry };
}
