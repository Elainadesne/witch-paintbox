import { deleteVibe, exportVibeBundle, loadVibes, needsEncoding, onVibesChanged, saveVibe, saveVibeNormalize, vibeFromImage, vibesFromFile, vibeSupport, VIBE_FREE_COUNT, VIBE_LIMIT, } from './vibe-transfer.js';
/**
 * 高级功能 · 氛围参考. Lives in its own host element so the image config page can redraw
 * freely; thumbnails are object URLs owned here and revoked on every redraw.
 */
export class VibePanel {
    state = null;
    error = '';
    notice = '';
    noticeError = false;
    host = null;
    model = '';
    urls = [];
    busy = false;
    stop = onVibesChanged(() => { if (!this.busy)
        void this.reload(); });
    mount(host, model) {
        this.host = host;
        this.model = model;
        if (this.state)
            this.render();
        else
            void this.reload();
        host.addEventListener('click', event => { void this.click(event); });
        host.addEventListener('change', event => { void this.change(event); });
        host.addEventListener('input', event => this.input(event));
    }
    setModel(model) {
        if (this.model === model)
            return;
        this.model = model;
        this.render();
    }
    destroy() {
        this.stop();
        this.revoke();
        this.host = null;
    }
    revoke() { for (const url of this.urls)
        URL.revokeObjectURL(url); this.urls = []; }
    async reload() {
        try {
            this.state = await loadVibes();
            this.error = '';
        }
        catch (error) {
            this.error = error.message;
        }
        this.render();
    }
    say(text, error = false) {
        this.notice = text;
        this.noticeError = error;
        const node = this.host?.querySelector('[data-vibe-status]');
        if (node) {
            node.textContent = text;
            node.classList.toggle('is-error', error);
        }
    }
    render() {
        const host = this.host;
        if (!host)
            return;
        this.revoke();
        host.replaceChildren();
        if (this.error) {
            const message = document.createElement('p');
            message.className = 'config-status is-error';
            message.textContent = this.error;
            host.append(message);
            return;
        }
        const state = this.state;
        if (!state) {
            const p = document.createElement('p');
            p.className = 'config-status';
            p.textContent = '正在读取氛围参考…';
            host.append(p);
            return;
        }
        const support = vibeSupport(this.model);
        const enabled = state.items.filter(item => item.enabled);
        const pending = support === 'encoded' ? enabled.filter(item => needsEncoding(item, this.model)).length : 0;
        const intro = document.createElement('p');
        intro.className = 'config-status vibe-intro';
        intro.textContent = support === 'unavailable'
            ? 'NAI 官方尚未为 V5 开放氛围参考，当前模型生图时会跳过这里的参考图。切到 V4 / V4.5 / V3 即可使用。'
            : support === 'raw'
                ? 'V3 直接发送原图，不需要编码。'
                : '普通图片在首次生图时编码一次（每张 2 Anlas），按模型和信息提取度缓存在本机；导入的 .naiv4vibe 自带编码时不再扣费。';
        if (support === 'unavailable')
            intro.classList.add('is-warning');
        const list = document.createElement('ul');
        list.className = 'vibe-list';
        list.toggleAttribute('data-disabled', support === 'unavailable');
        for (const item of state.items)
            list.append(this.row(item, support));
        if (!state.items.length) {
            const empty = document.createElement('li');
            empty.className = 'vibe-empty';
            empty.textContent = '还没有氛围图。上传一张喜欢的画，缇娅会照着它的笔触和色调落笔。';
            list.append(empty);
        }
        const actions = document.createElement('div');
        actions.className = 'vibe-actions';
        const full = state.items.length >= VIBE_LIMIT;
        actions.innerHTML = `
      <label class="text-button vibe-upload${full ? ' is-disabled' : ''}">添加图片<input type="file" data-vibe-add="image" accept="image/png,image/jpeg,image/webp" multiple hidden${full ? ' disabled' : ''}></label>
      <label class="text-button vibe-upload${full ? ' is-disabled' : ''}">导入 .naiv4vibe<input type="file" data-vibe-add="file" accept=".naiv4vibe,.naiv4vibeBundle,application/json" multiple hidden${full ? ' disabled' : ''}></label>
      <button type="button" class="text-button" data-vibe-action="export"${state.items.length ? '' : ' disabled'}>导出合集</button>`;
        const normalize = document.createElement('label');
        normalize.className = 'vibe-normalize';
        normalize.innerHTML = `<input type="checkbox" data-vibe-normalize${state.normalize ? ' checked' : ''}>强度总和超过 1 时自动归一化`;
        const summary = document.createElement('p');
        summary.className = 'config-status vibe-summary';
        const extra = Math.max(0, enabled.length - VIBE_FREE_COUNT) * 2;
        summary.textContent = `已启用 ${enabled.length} / ${VIBE_LIMIT} 张。${extra ? `超过 ${VIBE_FREE_COUNT} 张，每次生图额外约 ${extra} Anlas。` : `${VIBE_FREE_COUNT} 张以内不额外收费。`}${pending ? `下次生图需编码 ${pending} 张，约 ${pending * 2} Anlas。` : ''}`;
        if (extra || pending)
            summary.classList.add('is-warning');
        const status = document.createElement('p');
        status.className = 'config-status';
        status.dataset.vibeStatus = '';
        status.setAttribute('role', 'status');
        status.textContent = this.notice;
        status.classList.toggle('is-error', this.noticeError);
        host.append(intro, list, normalize, actions, summary, status);
    }
    row(item, support) {
        const row = document.createElement('li');
        row.className = 'vibe-item';
        row.dataset.vibeId = item.id;
        row.classList.toggle('is-off', !item.enabled);
        const picture = item.thumbnail ?? item.image;
        const thumb = document.createElement('div');
        thumb.className = 'vibe-thumb';
        if (picture) {
            const url = URL.createObjectURL(picture);
            this.urls.push(url);
            const image = document.createElement('img');
            image.src = url;
            image.alt = '';
            image.loading = 'lazy';
            thumb.append(image);
        }
        else
            thumb.textContent = '仅编码';
        const body = document.createElement('div');
        body.className = 'vibe-body';
        const head = document.createElement('div');
        head.className = 'vibe-head';
        const toggle = document.createElement('label');
        toggle.className = 'vibe-toggle';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = item.enabled;
        check.dataset.vibeField = 'enabled';
        const name = document.createElement('input');
        name.type = 'text';
        name.value = item.name;
        name.maxLength = 120;
        name.dataset.vibeField = 'name';
        name.setAttribute('aria-label', '氛围图名称');
        toggle.append(check);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'vibe-remove';
        remove.dataset.vibeAction = 'delete';
        remove.setAttribute('aria-label', `移除 ${item.name}`);
        remove.textContent = '×';
        head.append(toggle, name, remove);
        const slider = (field, label, title) => {
            const wrap = document.createElement('label');
            wrap.className = 'vibe-slider';
            wrap.title = title;
            const text = document.createElement('span');
            text.textContent = label;
            const range = document.createElement('input');
            range.type = 'range';
            range.min = '0.01';
            range.max = '1';
            range.step = '0.01';
            range.value = String(item[field]);
            range.dataset.vibeField = field;
            const value = document.createElement('output');
            value.textContent = item[field].toFixed(2);
            wrap.append(text, range, value);
            return wrap;
        };
        const tags = document.createElement('p');
        tags.className = 'vibe-tags';
        const cached = Object.keys(item.encodings).length;
        tags.textContent = [
            item.image ? '' : '无原图',
            support === 'encoded' ? needsEncoding(item, this.model) ? (item.image ? '待编码 · 2 Anlas' : '缺少此模型编码') : '已缓存编码' : '',
            cached ? `${cached} 个模型有编码` : '',
        ].filter(Boolean).join(' · ');
        body.append(head, slider('strength', '参考强度', '越高越贴近参考图的画风与构图；调整不需要重新编码。'), slider('informationExtracted', '信息提取度', '越低越只保留整体氛围；改动后需要重新编码（2 Anlas）。'), tags);
        row.append(thumb, body);
        return row;
    }
    find(target) {
        const id = target?.closest('[data-vibe-id]')?.dataset.vibeId;
        return this.state?.items.find(item => item.id === id);
    }
    async commit(item, redraw = true) {
        this.busy = true;
        try {
            await saveVibe(item);
            this.say('已保存。');
        }
        catch (error) {
            this.say(error.message, true);
        }
        finally {
            this.busy = false;
        }
        if (redraw)
            this.render();
    }
    input(event) {
        const field = event.target;
        if (!(field instanceof HTMLInputElement) || field.type !== 'range')
            return;
        const output = field.parentElement?.querySelector('output');
        if (output)
            output.textContent = Number(field.value).toFixed(2);
    }
    async change(event) {
        const field = event.target;
        if (!(field instanceof HTMLInputElement) || !this.state)
            return;
        if (field.dataset.vibeNormalize !== undefined) {
            this.state.normalize = field.checked;
            this.busy = true;
            try {
                await saveVibeNormalize(field.checked);
                this.say('已保存。');
            }
            catch (error) {
                this.say(error.message, true);
            }
            finally {
                this.busy = false;
            }
            return;
        }
        if (field.dataset.vibeAdd) {
            await this.add(field);
            return;
        }
        const item = this.find(field);
        const key = field.dataset.vibeField;
        if (!item || !key)
            return;
        if (key === 'enabled')
            item.enabled = field.checked;
        else if (key === 'name')
            item.name = field.value.trim().slice(0, 120) || item.name;
        else if (key === 'strength' || key === 'informationExtracted')
            item[key] = Number(field.value);
        await this.commit(item, key !== 'name');
    }
    async add(field) {
        const files = Array.from(field.files ?? []);
        field.value = '';
        if (!files.length || !this.state)
            return;
        const room = VIBE_LIMIT - this.state.items.length;
        const added = [];
        try {
            for (const file of files) {
                if (field.dataset.vibeAdd === 'image')
                    added.push(await vibeFromImage(file, file.name));
                else
                    added.push(...await vibesFromFile(await file.text()));
            }
            const accepted = added.slice(0, room);
            this.busy = true;
            for (const item of accepted)
                await saveVibe(item);
            this.busy = false;
            await this.reload();
            const encoded = accepted.filter(item => Object.keys(item.encodings).length).length;
            this.say(`已添加 ${accepted.length} 张${encoded ? `，其中 ${encoded} 张自带编码` : ''}。${added.length > accepted.length ? `超出 ${VIBE_LIMIT} 张上限，其余未添加。` : ''}`);
        }
        catch (error) {
            this.busy = false;
            this.say(error.message, true);
        }
    }
    async click(event) {
        const button = event.target?.closest('button[data-vibe-action]');
        if (!button || !this.state)
            return;
        if (button.dataset.vibeAction === 'delete') {
            const item = this.find(button);
            if (!item)
                return;
            this.busy = true;
            try {
                await deleteVibe(item.id);
            }
            catch (error) {
                this.say(error.message, true);
            }
            finally {
                this.busy = false;
            }
            await this.reload();
            this.say(`已移除“${item.name}”。`);
            return;
        }
        if (button.dataset.vibeAction === 'export') {
            const blob = await exportVibeBundle(this.state.items);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'witch-paintbox.naiv4vibeBundle';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            this.say('已导出合集，可在 NovelAI 官网或其他画匣导入。');
        }
    }
}
