import assert from 'node:assert/strict';
import { testSharedOutfitPicker } from './shared-outfit-picker-browser.mjs';
import { testOpenAIImage26 } from './openai-image-26-browser.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Set WITCH_PLAYWRIGHT to a locally installed Playwright module; no extra runtime dependency.
const { chromium } = await import(process.env.WITCH_PLAYWRIGHT || 'playwright');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const screenshots = process.env.WITCH_SCREENSHOTS || '/tmp/witch-image-workflow-preview';
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html lang="zh-CN"><body style="margin:0;background:#eee"><div id="extensions_settings"></div><div id="chat"></div><script type="module" src="/dist/index.js"></script></body></html>'); return;
  }
  if (pathname === '/scripts/extensions/regex/engine.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end('export const SCRIPT_TYPES={GLOBAL:0},regex_placement={USER_INPUT:1,AI_OUTPUT:2};export function getScriptsByType(){return []};export async function saveScriptsByType(){};export function getRegexedString(t){return t}'); return;
  }
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}/`)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') console.error('browser:', message.text()); });
  page.on('pageerror', error => { errors.push(error.message); console.error('pageerror:', error.message); });
  await page.addInitScript(() => {
    const events = new Map();
    const eventSource = {
      on(name, fn) { const items = events.get(name) || []; items.push(fn); events.set(name, items); },
      removeListener(name, fn) { events.set(name, (events.get(name) || []).filter(item => item !== fn)); },
      makeLast(name, fn) { this.removeListener(name, fn); this.on(name, fn); },
    };
    const names = ['GENERATION_STARTED', 'MESSAGE_RECEIVED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SENT', 'CHARACTER_MESSAGE_RENDERED'];
    window.testContext = {
      extensionSettings: {}, chat: [], chatMetadata: {}, characters: [], groups: [],
      eventSource, eventTypes: Object.fromEntries(names.map(name => [name, name])),
      getRequestHeaders: () => ({}), getCurrentChatId: () => 'test-chat', saveSettingsDebounced() {},
    };
    window.SillyTavern = { getContext: () => window.testContext };
    window.$ = ready => ready();
    // Keep the smoke test focused on settings rather than GPU pet resources.
    window.createImageBitmap = undefined;
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  if (process.env.WITCH_BROWSER_CASE === 'shared-outfits') {
    await page.getByRole('button', { name: '打开魔女画匣', exact: true }).click();
    const panel = page.locator('#image-plugin-panel'); await panel.waitFor({ state: 'visible' });
    await mkdir(screenshots, { recursive: true });
    const outfits = await testSharedOutfitPicker(page, panel, screenshots);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', outfits, screenshots }, null, 2));
  } else {
    await page.getByRole('button', { name: '打开魔女画匣', exact: true }).click();
    const panel = page.locator('#image-plugin-panel');
    await panel.waitFor({ state: 'visible' });
    await page.locator('.sidebar [data-page="image-workflow"]').click();
    const preferenceBranch = page.locator('.sidebar > .nav-branch:has(> [data-page="preferences"])');
    assert.equal(await preferenceBranch.locator('.nav-children [data-page="image-workflow"]').count(), 1);
    assert.equal(await page.locator('.sidebar > .nav-branch > .nav-item').count(), 5);
    assert.equal(await preferenceBranch.locator('[data-page="image-workflow"]').getAttribute('aria-current'), 'page');
    assert.equal(await preferenceBranch.locator(':scope > [data-page="preferences"]').getAttribute('aria-current'), null);
    assert.equal(await panel.locator('[name="imageConcurrency"]').inputValue(), '1');
    await panel.locator('[name="autoProcessReplies"]').check();
    await panel.locator('[name="autoGenerateImages"]').check();
    await panel.locator('[name="imageConcurrency"]').selectOption('3');
    await panel.locator('[name="autoImageDelay"]').fill('0.5');
    await panel.locator('[name="autoImageDelay"]').dispatchEvent('change');
    assert.match(await panel.locator('[data-workflow-status]').innerText(), /正文完成 → 模型写 Tag → 自动生成图片/);
    assert.deepEqual(await page.evaluate(() => {
      const s = testContext.extensionSettings['tavern-image-plugin'];
      return [s.autoProcessReplies, s.autoGenerateImages, s.imageConcurrency, s.autoImageDelay];
    }), [true, true, 3, 0.5]);
    // The old preference reset must no longer switch off automatic image settings.
    await page.locator('.sidebar [data-page="preferences"]').click();
    assert.equal(await panel.locator('[name="autoProcessReplies"]').count(), 0);
    await panel.locator('[data-action="reset-preferences"]').click();
    await page.locator('.sidebar [data-page="image-workflow"]').click();
    assert.equal(await panel.locator('[name="imageConcurrency"]').inputValue(), '3');
    assert.equal(await panel.locator('[name="autoProcessReplies"]').isChecked(), true);

    // Exercise the real export/parser/import path, including old files without the new field.
    const archiveResult = await page.evaluate(async () => {
      const archive = await import('/dist/config-archive.js');
      const text = await (await archive.exportArchive('all', false, testContext)).text();
      const exported = archive.parseArchive(text);
      const summary = archive.summarizeArchive(exported).at(-1).detail;
      const old = JSON.parse(text); delete old.data.preferences.imageConcurrency;
      const legacyLimit = archive.parseArchive(JSON.stringify(old)).data.preferences.imageConcurrency;
      const bad = JSON.parse(text); bad.data.preferences.imageConcurrency = 99;
      let invalidRejected = false;
      try { archive.parseArchive(JSON.stringify(bad)); } catch { invalidRejected = true; }
      return { exportedLimit: JSON.parse(text).data.preferences.imageConcurrency, legacyLimit, invalidRejected, summary };
    });
    assert.equal(archiveResult.exportedLimit, 3); assert.equal(archiveResult.legacyLimit, 1);
    assert.equal(archiveResult.invalidRejected, true);
    assert.match(archiveResult.summary, /最大同时生图数：3 张/);
    // Importing through the file picker checks both saved values and the live queue configuration.
    await page.locator('.sidebar [data-page="preferences"]').click();
    const archiveFile = await page.evaluate(async () => {
      const { exportArchive } = await import('/dist/config-archive.js');
      const value = JSON.parse(await (await exportArchive('all', false, testContext)).text());
      value.data.preferences.imageConcurrency = 4;
      return JSON.stringify(value);
    });
    await panel.locator('[data-transfer-file]').setInputFiles({ name: 'workflow-config.json', mimeType: 'application/json', buffer: Buffer.from(archiveFile) });
    await panel.locator('[data-transfer-action="confirm"]').waitFor();
    const importControls = await panel.locator('[data-config-transfer]').innerText();
    assert.match(importControls, /最大同时生图数：4 张/);
    await panel.locator('[data-transfer-section="preferences"][data-transfer-mode="overwrite"]').click();
    await panel.locator('[data-transfer-action="confirm"]').click();
    await page.waitForFunction(() => document.querySelector('#tavern-image-plugin').shadowRoot.querySelector('[data-transfer-status]').textContent.includes('配置已导入'));
    await page.locator('.sidebar [data-page="image-workflow"]').click();
    assert.equal(await panel.locator('[name="imageConcurrency"]').inputValue(), '4');
    const importedQueueLimit = await page.evaluate(async () => {
      const { onImageQueueChanged } = await import('/dist/image-queue.js');
      let limit; const stop = onImageQueueChanged(state => { limit = state.limit; }); stop(); return limit;
    });
    assert.equal(importedQueueLimit, 4);
    await mkdir(screenshots, { recursive: true });
    await panel.locator('.close-button').click();
    await page.reload();
    await page.getByRole('button', { name: '打开魔女画匣', exact: true }).click();
    await page.locator('.sidebar [data-page="image-workflow"]').click();
    await panel.locator('[name="autoProcessReplies"]').check();
    await panel.locator('[name="autoGenerateImages"]').check();
    await panel.locator('[name="imageConcurrency"]').selectOption('3');
    await page.screenshot({ path: path.join(screenshots, 'desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(screenshots, 'mobile.png') });
    const geometry = await panel.evaluate(element => {
      const content = element.querySelector('.content'), sidebar = element.querySelector('.sidebar');
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: innerWidth, contentWidth: content.clientWidth, contentScroll: content.scrollWidth,
        navFits: [...sidebar.querySelectorAll('.nav-item')].every(item => item.scrollWidth <= item.clientWidth), navCount: sidebar.querySelectorAll('.nav-item').length, primaryCount: sidebar.querySelectorAll(':scope > .nav-branch > .nav-item').length,
        childBelowParent: sidebar.querySelector('[data-page="image-workflow"]').getBoundingClientRect().top >= sidebar.querySelector('[data-page="preferences"]').getBoundingClientRect().bottom };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width);
    assert.ok(geometry.contentScroll <= geometry.contentWidth + 1, JSON.stringify(geometry));
    assert.equal(geometry.navFits, true); assert.equal(geometry.navCount, 6); assert.equal(geometry.primaryCount, 5); assert.equal(geometry.childBelowParent, true);
    await panel.locator('[data-action="reset-image-workflow"]').click();
    assert.equal(await panel.locator('[name="imageConcurrency"]').inputValue(), '1');
    assert.equal(await panel.locator('[name="autoProcessReplies"]').isChecked(), false);
    assert.equal(await panel.locator('[name="autoGenerateImages"]').isChecked(), false);
    const image26 = await testOpenAIImage26(page, panel, screenshots);
    const outfits = await testSharedOutfitPicker(page, panel, screenshots);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', archiveResult, importedQueueLimit, geometry, image26, outfits, screenshots }, null, 2));
  }
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
