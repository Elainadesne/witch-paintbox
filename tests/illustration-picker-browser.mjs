import assert from 'node:assert/strict';
import path from 'node:path';
import { applyImageInsertions, createSelectedImageInsertionPlan, selectImageInsertionPoints } from '../dist/image-insertion.js';
import { buildIllustrationUnits, groupIllustrationLines, normalizeIllustrationItems } from '../dist/illustration-selection.js';

const original = [
  '<div class="scene">',
  '    <p>第一段场景文字。她推开窗，街上刚下过雨。</p>',
  '',
  '    <p>第二段场景文字。灯火照着石阶，窗台上放着一封尚未拆开的信。LongUnbrokenTextForWrapping0123456789。</p>',
  '    <p>第三段场景文字。她拿起信，走向门口。</p>',
  '</div>',
  '<think>',
  '    排除区原文：不参与选段，也不执行 HTML。',
  '</think>',
  '第四段场景文字。门外站着送信的人。',
  '```js',
  'window.__witchFixtureExecuted = true;',
  '```',
  '第五段场景文字。两人在街角交谈。',
  '<script>window.__witchFixtureExecuted = true;</script>',
  '第六段场景文字。远处的钟声响起。',
  '<img>',
  '[已有配图]',
  'existing test prompt',
  '</img>',
  '最后一段场景文字。天色渐渐明亮。',
''].join('\n');

export async function testIllustrationPicker(page, screenshots) {
  const settingsPanel = page.locator('#image-plugin-panel');
  if (await settingsPanel.isVisible()) await settingsPanel.locator('.close-button').click();
  const origin = new URL(page.url()).origin;
  const requests = [], saves = [], external = [];
  const guard = route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  };
  await page.route('**/*', guard);
  let responseRows = [];
  let changeDuringRequest = false;
  const modelRoute = async route => {
    requests.push(route.request().postDataJSON());
    if (changeDuringRequest) await page.evaluate(() => { testContext.chat[0].mes += '\nchanged during request'; });
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(responseRows) } }] } });
  };
  const saveRoute = async route => {
    saves.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  };
  await page.route('**/api/backends/chat-completions/generate', modelRoute);
  await page.route('**/api/chats/save', saveRoute);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async original => {
      const image = await import('/dist/image-settings.js');
      await image.saveImageSettings(image.defaultImageSettings());
      await image.switchImageProvider('novelai');
      const model = await import('/dist/model-settings.js');
      // Test-only fixture; all requests are intercepted, with no provider credentials.
      const settings = model.defaultModelSettings();
      Object.assign(settings, { mode: 'custom', url: 'https://fixture.invalid/v1', model: 'fixture-model',
        transport: 'nonstream', hideImageContext: false, enabledLayers: [],
        head: [{ id: 'fixture', name: 'fixture', role: 'system', enabled: true, content: 'test fixture' }],
        promptOrder: ['prompt:fixture', 'input'] });
      await model.saveModelSettings(settings);
      const preferences = await import('/dist/settings.js');
      preferences.saveExcludedTags(['think']);
      preferences.saveSettings(testContext, { ...preferences.currentPreferences(), autoProcessReplies: false, autoGenerateImages: false });
      testContext.getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
      testContext.characterId = 0;
      testContext.characters = [{ name: '测试角色', avatar: 'fixture.png', chat: 'test-chat' }];
      testContext.chat = [{ mes: original, name: '测试角色', is_user: false, swipe_id: 0, swipes: [original, 'other swipe'], send_date: '2026-11-10T12:00:00Z' }];
      const frontend = document.createElement('div');
      frontend.textContent = 'Existing frontend stays mounted';
      document.querySelector('#chat').append(frontend);
      window.testFrontend = frontend;
    }, original);
    const picker = page.locator('.illustration-picker');
    const open = async () => {
      await page.locator('.launcher').click();
      await page.locator('#witch-launcher-menu [data-select]').click();
      await picker.waitFor({ state: 'visible' });
    };
    const line = number => picker.locator(`[data-line-start="${number}"]`);
    const cart = picker.locator('.illustration-cart-item');
    const rangeStatus = picker.locator('[data-range-status]');
    const add = picker.locator('[data-add-range]');
    const clearRange = picker.locator('[data-clear-range]');
    const submit = picker.locator('[data-submit]');
    const refresh = async () => {
      await picker.locator('[data-refresh]').click();
      await picker.locator('[data-source]').filter({ hasText: '最新 AI 回复' }).waitFor();
      await picker.locator('[data-mode="lines"]:enabled').waitFor();
    };
    const selectRange = async (first, last, touch = false) => {
      await line(first)[touch ? 'tap' : 'click']();
      await line(last)[touch ? 'tap' : 'click']();
    };
    await open();
    await page.waitForFunction(() => document.querySelector('#tavern-image-plugin').shadowRoot
      .querySelector('.illustration-picker [data-source]').textContent !== '正在读取最新回复…');
    assert.match(await picker.locator('[data-source]').innerText(), /最新 AI 回复/, await picker.locator('[data-status]').innerText());
    await picker.locator('[data-mode="lines"]:enabled').click();
    await picker.getByLabel('文段分组方式').selectOption('manual');
    assert.equal(await line(2).evaluate(element => element.tagName), 'BUTTON');
    assert.equal(await line(1).evaluate(element => element.tagName), 'SPAN');
    assert.equal(await line(12).evaluate(element => element.tagName), 'SPAN');
    assert.equal(await page.evaluate(() => window.__witchFixtureExecuted), undefined);
    const heightBefore = await line(2).evaluate(element => element.getBoundingClientRect().height);
    await line(2).click();
    assert.match(await rangeStatus.innerText(), /首行：2.*末行待选/);
    assert.equal(await add.isDisabled(), true);
    assert.equal(await cart.count(), 0);
    await line(4).click();
    assert.match(await rangeStatus.innerText(), /第 2 至 4 行/);
    assert.equal(await picker.locator('.is-range').count(), 3);
    assert.equal(await cart.count(), 0);
    await page.screenshot({ path: path.join(screenshots, 'illustration-desktop-range.png') });
    await add.click();
    assert.equal(await cart.count(), 1);
    assert.match(await cart.first().innerText(), /第 2 至 4 行 · 一张/);
    assert.equal(await line(2).isDisabled(), true);
    assert.equal(await line(2).evaluate(element => element.getBoundingClientRect().height), heightBefore);
    assert.equal(await submit.isDisabled(), false);
    await page.screenshot({ path: path.join(screenshots, 'illustration-desktop-cart.png') });

    // An enclosing range overlaps even when neither endpoint was already selected.
    await picker.locator('[data-clear]').click();
    await selectRange(4, 4); await add.click();
    await selectRange(2, 5);
    assert.match(await rangeStatus.innerText(), /重叠/);
    assert.equal(await add.isDisabled(), true);
    assert.equal(await submit.isDisabled(), true);
    await clearRange.click();
    await cart.locator('[data-remove]').click();
    await selectRange(4, 2); await add.click();
    await picker.locator('[data-mode="sentence"]').click();
    assert.equal(await cart.count(), 1);
    await picker.locator('[data-mode="lines"]').click();
    await picker.getByLabel('文段分组方式').selectOption('5');
    assert.equal(await cart.count(), 1);
    assert.equal(await picker.locator('.illustration-manual-controls').isVisible(), false);
    await picker.getByLabel('文段分组方式').selectOption('manual');
    await line(14).click();
    assert.equal(await submit.isDisabled(), true);
    await refresh();
    assert.equal(await cart.count(), 0);
    assert.match(await rangeStatus.innerText(), /^首行待选$/);

    await selectRange(5, 10);
    assert.match(await rangeStatus.innerText(), /跨过/);
    assert.equal(await add.isDisabled(), true);
    await picker.locator('.illustration-excluded-block > summary').click();
    assert.equal(await line(8).locator('.illustration-line-number').innerText(), '8');
    assert.equal(await line(8).locator('.illustration-line-text').innerText(), '    排除区原文：不参与选段，也不执行 HTML。');
    await clearRange.click();
    await selectRange(10, 14);
    assert.match(await rangeStatus.innerText(), /跨过/);
    // A third click starts a fresh range; clearing does not alter the cart.
    await line(16).click();
    assert.match(await rangeStatus.innerText(), /首行：16/);
    await clearRange.click();
    await line(2).focus(); await page.keyboard.press('Enter');
    await line(4).focus(); await page.keyboard.press('Space');
    assert.equal(await add.isDisabled(), false);
    await picker.locator('[data-close]').click(); await open();
    assert.match(await rangeStatus.innerText(), /第 2 至 4 行/);
    await clearRange.click();

    const geometry = [];
    for (const [width, height] of [[390, 844], [360, 740], [320, 700], [844, 390]]) {
      await page.setViewportSize({ width, height });
      const drawer = picker.locator('.illustration-cart-drawer');
      if (width < 760 && await drawer.getAttribute('open') !== null) await drawer.locator(':scope > summary').tap();
      await selectRange(4, 2, true);
      assert.match(await rangeStatus.innerText(), /第 2 至 4 行/);
      const dimensions = await picker.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const reading = element.querySelector('.illustration-reading');
        const checked = [...element.querySelectorAll('.illustration-reading, .illustration-picker-toolbar, .illustration-picker-footer')];
        const actions = [...element.querySelectorAll('.illustration-manual-controls > *')].map(item => item.getBoundingClientRect());
        return { width: innerWidth, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: innerHeight,
          overflow: checked.some(item => item.scrollWidth > item.clientWidth + 1), readingHeight: reading.clientHeight,
          controlsOverlap: actions.some((a, i) => actions.slice(i + 1).some(b => Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1)) };
      });
      assert.ok(dimensions.left >= 0 && dimensions.right <= width + 1 && dimensions.top >= 0 && dimensions.bottom <= height + 1, JSON.stringify(dimensions));
      assert.equal(dimensions.overflow, false, JSON.stringify(dimensions));
      assert.equal(dimensions.controlsOverlap, false);
      assert.ok(dimensions.readingHeight >= 80);
      geometry.push(dimensions);
      await page.screenshot({ path: path.join(screenshots, `illustration-${width}x${height}.png`) });
      await clearRange.tap();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#tavern-image-plugin').evaluate(element => { element.dataset.theme = 'night'; });
    await selectRange(2, 4, true); await add.tap();
    assert.notEqual(await line(2).evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: path.join(screenshots, 'illustration-mobile-night.png') });

    // Submit through the real processor and compare with validated pure insertion output.
    await page.setViewportSize({ width: 1280, height: 900 });
    await selectRange(14, 14); await add.click();
    const plan = createSelectedImageInsertionPlan(original, ['think']);
    const units = buildIllustrationUnits(plan, 'manual', 3, ['think']);
    const items = normalizeIllustrationItems(plan, [groupIllustrationLines(plan, units, 1, 3), groupIllustrationLines(plan, units, 13, 13)]);
    responseRows = items.map(item => ({ at: item.pointIds.at(-1), summary: '测试场景', prompt: 'fixture illustration' }));
    const expected = applyImageInsertions(selectImageInsertionPoints(plan, items.flatMap(item => item.pointIds)), JSON.stringify(responseRows), items);
    await submit.click();
    await picker.locator('[data-status]').filter({ hasText: '已保存 2 处配图标记' }).waitFor();
    assert.equal(requests.length, 1); assert.equal(saves.length, 1);
    assert.equal(requests[0].model, 'fixture-model');
    assert.equal(requests[0].stream, false);
    const input = requests[0].messages.find(message => message.role === 'user').content;
    assert.ok(input.startsWith(selectImageInsertionPoints(plan, items.flatMap(item => item.pointIds)).text));
    assert.ok(input.includes('<指定插图位置锁定>'));
    assert.equal(requests[0].messages[0].content, 'test fixture');
    assert.equal(saves[0].chat[1].mes, expected.text);
    assert.deepEqual(saves[0].chat[1].swipes, [expected.text, 'other swipe']);
    assert.equal(saves[0].force, false);
    assert.equal(await page.evaluate(() => testContext.chat[0].mes), expected.text);
    assert.equal(await page.evaluate(() => testFrontend.isConnected && testFrontend.textContent === 'Existing frontend stays mounted'), true);
    assert.equal(await cart.count(), 0);

    const restore = async () => {
      await page.evaluate(original => {
        testContext.chat[0].mes = original; testContext.chat[0].swipe_id = 0; testContext.chat[0].swipes = [original, 'other swipe'];
      }, original);
      await refresh(); await selectRange(2, 4); await add.click();
    };
    for (const mutation of ['text', 'swipe']) {
      await restore();
      await page.evaluate(mutation => {
        if (mutation === 'text') testContext.chat[0].mes += '\nexternal edit';
        else testContext.chat[0].swipe_id = 1;
      }, mutation);
      await submit.click();
      await picker.locator('[data-status]').filter({ hasText: '已发生变化' }).waitFor();
      assert.equal(requests.length, 1); assert.equal(saves.length, 1);
      assert.equal(await cart.count(), 1);
    }
    await restore();
    responseRows = [responseRows[0]]; changeDuringRequest = true;
    await submit.click();
    await picker.locator('[data-status]').filter({ hasText: '已发生变化' }).waitFor();
    assert.equal(requests.length, 2); assert.equal(saves.length, 1);
    changeDuringRequest = false;
    await restore(); responseRows = [];
    await submit.click();
    await picker.locator('[data-status]').filter({ hasText: '遗漏' }).waitFor();
    assert.equal(requests.length, 3); assert.equal(saves.length, 1);
    assert.equal(await page.evaluate(() => testContext.chat[0].mes), original);
    assert.deepEqual(external, []);
    assert.equal(await page.evaluate(() => window.__witchFixtureExecuted), undefined);
    await picker.locator('[data-close]').click();
    return { geometry, modelRequests: requests.length, saves: saves.length, staleChecks: 3, externalRequests: external.length };
  } finally {
    await page.unroute('**/api/backends/chat-completions/generate', modelRoute);
    await page.unroute('**/api/chats/save', saveRoute);
    await page.unroute('**/*', guard);
  }
}
