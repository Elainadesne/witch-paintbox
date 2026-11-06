import assert from 'node:assert/strict';
import path from 'node:path';

/** Real editor, local libraries, IndexedDB and resolver; no model or image API calls. */
export async function testSharedOutfitPicker(page, panel, screenshots) {
  page.setDefaultTimeout(20000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.sidebar [data-page="features"]').click();
  await panel.locator('[data-anchor-tab="anchors"]').click();
  await panel.locator('[data-anchor-action="new"]').click();
  await panel.locator('[data-anchor-field="name"]').fill('莎莉');
  await panel.locator('[data-anchor-field="appearance"]').fill('blue hair, green eyes');
  await panel.locator('[data-anchor-action="add-outfit"]').click();
  await panel.locator('[data-outfit-field="name"]').fill('礼服');
  await panel.locator('[data-outfit-field="tags"]').fill('personal dress tags');
  await panel.locator('[data-anchor-action="toggle-shared-picker"]').click();
  assert.match(await panel.locator('[data-shared-picker-results]').innerText(), /还没有已保存的通用服装/);
  await panel.locator('[data-shared-picker-results] [data-anchor-tab="shared-outfits"]').click();
  await panel.locator('[data-anchor-action="new-shared"]').click();
  const travelTags = '{red coat}, 1.2::gold buttons::,\nboots';
  await panel.locator('[data-shared-outfit-field="name"]').fill('旅行装');
  await panel.locator('[data-shared-outfit-field="tags"]').fill(travelTags);
  await panel.locator('[data-anchor-action="save-shared"]').click();
  await page.waitForFunction(() => document.querySelector('#tavern-image-plugin').shadowRoot.querySelector('[data-anchor-status]').textContent.includes('通用服装已保存'));
  const fixture = await page.evaluate(async () => {
    const { loadSharedOutfits, replaceSharedOutfits } = await import('/dist/shared-outfit-store.js');
    const travel = loadSharedOutfits()[0];
    const extras = [{ id: 'shared-dress', name: '礼服', tags: 'global dress tags' },
      { id: 'reserved', name: '无服装', tags: 'reserved name' },
      ...Array.from({ length: 51 }, (_, i) => ({ id: `backup-${i}`, name: `备用${String(i).padStart(2, '0')}装`, tags: `cloth ${i}, <tag> & "quoted"` }))];
    await replaceSharedOutfits([travel, ...extras]); return { travelId: travel.id };
  });
  await panel.locator('[data-anchor-tab="anchors"]').click();
  assert.equal(await panel.locator('[data-anchor-field="name"]').inputValue(), '莎莉');
  assert.equal(await panel.locator('[data-anchor-field="appearance"]').inputValue(), 'blue hair, green eyes');
  assert.equal(await panel.locator('[data-shared-outfit-pick]').count(), 50);
  assert.equal(await panel.locator('[data-shared-outfit-pick="reserved"]').isDisabled(), true);
  assert.equal(await panel.locator('[data-shared-outfit-pick="shared-dress"]').isDisabled(), true);
  const search = panel.locator('[data-shared-outfit-search]'), add = panel.locator('[data-anchor-action="import-shared-outfits"]');
  await search.fill('备用50装'); await panel.locator('[data-shared-outfit-pick="backup-50"]').check();
  await search.fill('旅行'); await panel.locator(`[data-shared-outfit-pick="${fixture.travelId}"]`).check();
  await search.fill('不存在的服装'); assert.match(await panel.locator('[data-shared-picker-results]').innerText(), /没有找到/);
  assert.match(await add.innerText(), /2 套/);
  await search.fill('旅行'); assert.equal(await panel.locator(`[data-shared-outfit-pick="${fixture.travelId}"]`).isChecked(), true);
  await add.click();
  assert.equal(await panel.locator('[data-outfit]').count(), 3);
  assert.equal(await panel.locator('[data-anchor-field="selectedOutfitId"]').inputValue(), '');
  assert.equal(await panel.locator('[data-anchor-field="appearance"]').inputValue(), 'blue hair, green eyes');
  const beforeSave = await page.evaluate(async () => (await (await import('/dist/anchor-store.js')).loadAnchors()).length);
  assert.equal(beforeSave, 0);
  const travelOption = panel.locator('[data-anchor-field="selectedOutfitId"] option').filter({ hasText: '旅行装' });
  const roleTravelId = await travelOption.getAttribute('value');
  assert.notEqual(roleTravelId, fixture.travelId);
  await panel.locator('[data-anchor-field="selectedOutfitId"]').selectOption(roleTravelId);
  await panel.locator('[data-anchor-action="save"]').click();
  await page.waitForFunction(async () => (await (await import('/dist/anchor-store.js')).loadAnchors()).some(anchor => anchor.name === '莎莉'));
  const saved = await page.evaluate(async () => {
    const { loadAnchors } = await import('/dist/anchor-store.js');
    const { resolveAnchorPrompt } = await import('/dist/anchor-resolver.js');
    const { formatAnchorCatalog } = await import('/dist/anchor-catalog.js');
    const anchors = await loadAnchors(), anchor = anchors.find(item => item.name === '莎莉');
    return { ...anchor, expanded: resolveAnchorPrompt('@莎莉', anchors), catalog: formatAnchorCatalog(anchors, []) };
  });
  assert.equal(saved.outfits.find(item => item.name === '礼服').tags, 'personal dress tags');
  assert.equal(saved.outfits.find(item => item.name === '旅行装').tags, travelTags);
  assert.equal(saved.selectedOutfitId, roleTravelId);
  assert.ok(saved.expanded.includes(travelTags)); assert.ok(saved.catalog.includes('default = {red coat}'));
  assert.equal(new Set(saved.outfits.map(item => item.id)).size, 3);

  await panel.locator(`.anchor-character[data-anchor-id="${saved.id}"]`).click();
  await panel.locator('[data-anchor-action="toggle-shared-picker"]').click();
  assert.equal(await panel.locator(`[data-shared-outfit-pick="${fixture.travelId}"]`).isDisabled(), true);
  const travelDetails = panel.locator(`[data-outfit="${roleTravelId}"]`);
  assert.equal(await travelDetails.locator('[data-outfit-field="tags"]').inputValue(), travelTags);
  await page.evaluate(async travelId => {
    const { loadSharedOutfits, saveSharedOutfit } = await import('/dist/shared-outfit-store.js');
    const source = loadSharedOutfits().find(item => item.id === travelId);
    await saveSharedOutfit({ ...source, tags: 'updated global clothes' });
  }, fixture.travelId);
  assert.equal(await travelDetails.locator('[data-outfit-field="tags"]').inputValue(), travelTags);
  await travelDetails.locator('[data-outfit-field="tags"]').fill('personal travel clothes');
  await panel.locator('[data-anchor-action="save"]').click();
  await page.waitForFunction(async () => (await (await import('/dist/anchor-store.js')).loadAnchors()).some(anchor => anchor.outfits.some(item => item.tags === 'personal travel clothes')));
  assert.equal(await page.evaluate(async id => (await import('/dist/shared-outfit-store.js')).loadSharedOutfits().find(item => item.id === id).tags, fixture.travelId), 'updated global clothes');

  await panel.locator(`.anchor-character[data-anchor-id="${saved.id}"]`).click();
  await panel.locator('[data-anchor-action="toggle-shared-picker"]').click();
  await search.fill('备用00装'); await panel.locator('[data-shared-outfit-pick="backup-0"]').check();
  await page.evaluate(async () => { await (await import('/dist/shared-outfit-store.js')).deleteSharedOutfit('backup-0'); });
  assert.equal(await add.isDisabled(), true);
  // Simulate a library changed by another tab without a delivered storage notification.
  await search.fill('备用01装'); await panel.locator('[data-shared-outfit-pick="backup-1"]').check();
  await page.evaluate(() => {
    const key = 'witch-paintbox.shared-outfits.v1', source = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(source.filter(item => item.id !== 'backup-1')));
  });
  await add.click();
  assert.match(await panel.locator('[data-anchor-status]').innerText(), /通用服装库已变化/);
  assert.equal(await panel.locator('[data-outfit]').count(), 3);
  await search.fill('旅行'); await search.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshots, 'shared-outfit-picker-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await search.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshots, 'shared-outfit-picker-mobile.png') });
  const geometry = await panel.locator('.content').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry));
  return { imported: 2, totalRoleOutfits: 3, defaultOutfit: '旅行装', sourceIndependent: true,
    duplicateProtected: true, staleSelectionProtected: true, geometry };
}
