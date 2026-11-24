const checkInterval = 15 * 60 * 1000;
const retryInterval = 60 * 1000;
const initialMessage = '每次打开画匣会顺便看一眼当前分支有没有更新；点一下铃铛可以手动再查。';
export function updateNoticeView() {
    return `<span class="update-notice">
    <button type="button" class="update-bell" aria-label="检查插件更新" aria-describedby="image-plugin-update-status" aria-busy="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4M12 2V1"/></svg>
    </button>
    <span id="image-plugin-update-status" class="update-tooltip" role="tooltip">${initialMessage}</span>
  </span>`;
}
function installedFolder() {
    // Both hosts serve installed modules at this path, including renamed clones.
    const match = new URL(import.meta.url).pathname.match(/\/scripts\/extensions\/third-party\/([^/]+)\//);
    if (!match)
        return null;
    try {
        const folder = decodeURIComponent(match[1]);
        return folder && !/[\\/]/.test(folder) && folder !== '.' && folder !== '..' ? folder : null;
    }
    catch {
        return null;
    }
}
function isInstallation(value) {
    if (!value || typeof value !== 'object')
        return false;
    const entry = value;
    return typeof entry.name === 'string' && (entry.type === 'local' || entry.type === 'global');
}
function isVersion(value) {
    if (!value || typeof value !== 'object')
        return false;
    const version = value;
    return typeof version.currentBranchName === 'string' && typeof version.currentCommitHash === 'string'
        && typeof version.isUpToDate === 'boolean' && typeof version.remoteUrl === 'string';
}
async function readVersion(folder, signal) {
    const host = globalThis;
    const context = host.SillyTavern?.getContext();
    if (typeof context?.getRequestHeaders !== 'function')
        throw new Error('当前酒馆环境查不了插件更新，直接去扩展管理里看吧。');
    const headers = new Headers(context.getRequestHeaders());
    headers.set('Content-Type', 'application/json');
    const discovery = await fetch('/api/extensions/discover', { headers, signal });
    if (!discovery.ok)
        throw new Error('这会儿没读到扩展信息，过会儿再点铃铛试试，或者去酒馆扩展管理里看。');
    const entries = await discovery.json();
    const installation = Array.isArray(entries) ? entries.filter(isInstallation).find(entry => entry.name === `third-party/${folder}`) : undefined;
    if (!installation)
        throw new Error('没找着这个插件的安装记录，还是去酒馆扩展管理里检查更新吧。');
    // The host checks origin/<installed branch>; this never pulls or switches it.
    const response = await fetch('/api/extensions/version', {
        method: 'POST', headers, signal,
        body: JSON.stringify({ extensionName: folder, global: installation.type === 'global' }),
    });
    if (!response.ok)
        throw new Error('更新没查成，可能是连不上 Git 仓库，等会儿再点铃铛试试。');
    const version = await response.json();
    if (!isVersion(version))
        throw new Error('酒馆返回的版本信息不全，去扩展管理里直接检查吧。');
    return version;
}
export function bindUpdateNotice(root, signal) {
    const button = root.querySelector('.update-bell');
    const tooltip = root.querySelector('#image-plugin-update-status');
    const folder = installedFolder();
    let pending = false;
    let nextCheck = 0;
    function describe(message, available = false) {
        tooltip.textContent = message;
        button.setAttribute('aria-label', available ? '当前分支有更新，点击重新检查' : '检查插件更新');
        button.classList.toggle('has-update', available);
    }
    async function check(force = false) {
        if (signal.aborted || pending || (!force && Date.now() < nextCheck))
            return;
        if (!folder) {
            describe('当前加载方式认不出 Git 安装信息，去酒馆扩展管理里查更新吧。');
            return;
        }
        pending = true;
        button.setAttribute('aria-busy', 'true');
        tooltip.textContent = '正看看当前分支有没有新更新…';
        const request = new AbortController();
        const cancel = () => request.abort();
        signal.addEventListener('abort', cancel, { once: true });
        const timeout = window.setTimeout(cancel, 20_000);
        try {
            const version = await readVersion(folder, request.signal);
            if (signal.aborted)
                return;
            if (!version.currentBranchName.trim() || !version.currentCommitHash.trim() || !version.remoteUrl.trim()) {
                describe('这个安装版本没带 Git 分支信息，没法比对更新，去扩展管理里看一下吧。');
            }
            else {
                const branch = version.currentBranchName;
                const commit = version.currentCommitHash.slice(0, 8);
                describe(version.isUpToDate
                    ? `当前分支 ${branch}（${commit}）已经是最新的了，点铃铛可以重新检查。`
                    : `当前分支 ${branch} 有新版了（本机是 ${commit}）。去酒馆扩展管理里更新一下“魔女画匣”，然后刷新页面就行。`, !version.isUpToDate);
            }
            nextCheck = Date.now() + checkInterval;
        }
        catch (error) {
            if (!signal.aborted) {
                describe(request.signal.aborted ? '查更新等太久超时了，过会儿再点铃铛试试。'
                    : error instanceof Error ? error.message : '刚才查更新中途断了，过会儿再点铃铛试试。');
                nextCheck = Date.now() + retryInterval;
            }
        }
        finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', cancel);
            pending = false;
            button.setAttribute('aria-busy', 'false');
        }
    }
    button.addEventListener('click', () => { void check(true); }, { signal });
    return { check: () => { void check(); } };
}
