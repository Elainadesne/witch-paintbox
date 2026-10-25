interface ExtensionInstallation {
  name: string;
  type: 'local' | 'global';
}

interface ExtensionVersion {
  currentBranchName: string;
  currentCommitHash: string;
  isUpToDate: boolean;
  remoteUrl: string;
}

const checkInterval = 15 * 60 * 1000;
const retryInterval = 60 * 1000;
const initialMessage = '打开画匣时检查当前安装分支的更新；点击铃铛可重新检查。';

export function updateNoticeView(): string {
  return `<span class="update-notice">
    <button type="button" class="update-bell" aria-label="检查插件更新" aria-describedby="image-plugin-update-status" aria-busy="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4M12 2V1"/></svg>
    </button>
    <span id="image-plugin-update-status" class="update-tooltip" role="tooltip">${initialMessage}</span>
  </span>`;
}

function installedFolder(): string | null {
  // Both hosts serve installed modules at this path, including renamed clones.
  const match = new URL(import.meta.url).pathname.match(/\/scripts\/extensions\/third-party\/([^/]+)\//);
  if (!match) return null;
  try {
    const folder = decodeURIComponent(match[1]);
    return folder && !/[\\/]/.test(folder) && folder !== '.' && folder !== '..' ? folder : null;
  } catch { return null; }
}

function isInstallation(value: unknown): value is ExtensionInstallation {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<ExtensionInstallation>;
  return typeof entry.name === 'string' && (entry.type === 'local' || entry.type === 'global');
}

function isVersion(value: unknown): value is ExtensionVersion {
  if (!value || typeof value !== 'object') return false;
  const version = value as Partial<ExtensionVersion>;
  return typeof version.currentBranchName === 'string' && typeof version.currentCommitHash === 'string'
    && typeof version.isUpToDate === 'boolean' && typeof version.remoteUrl === 'string';
}

async function readVersion(folder: string, signal: AbortSignal): Promise<ExtensionVersion> {
  const host = globalThis as typeof globalThis & {
    SillyTavern?: { getContext(): { getRequestHeaders?: () => HeadersInit } };
  };
  const context = host.SillyTavern?.getContext();
  if (typeof context?.getRequestHeaders !== 'function') throw new Error('宿主暂不支持更新检查。请在酒馆扩展管理中检查更新。');
  const headers = new Headers(context.getRequestHeaders());
  headers.set('Content-Type', 'application/json');
  const discovery = await fetch('/api/extensions/discover', { headers, signal });
  if (!discovery.ok) throw new Error('暂时无法读取扩展信息。请稍后点击铃铛重试，或在酒馆扩展管理中检查。');
  const entries: unknown = await discovery.json();
  const installation = Array.isArray(entries) ? entries.filter(isInstallation).find(entry => entry.name === `third-party/${folder}`) : undefined;
  if (!installation) throw new Error('未找到当前插件的安装信息。请在酒馆扩展管理中检查更新。');

  // The host checks origin/<installed branch>; this never pulls or switches it.
  const response = await fetch('/api/extensions/version', {
    method: 'POST', headers, signal,
    body: JSON.stringify({ extensionName: folder, global: installation.type === 'global' }),
  });
  if (!response.ok) throw new Error('更新检查未完成，可能暂时无法连接 Git 仓库。请稍后点击铃铛重试。');
  const version: unknown = await response.json();
  if (!isVersion(version)) throw new Error('宿主未返回完整的版本信息。请在酒馆扩展管理中检查更新。');
  return version;
}

export function bindUpdateNotice(root: ShadowRoot, signal: AbortSignal): { check(): void } {
  const button = root.querySelector<HTMLButtonElement>('.update-bell')!;
  const tooltip = root.querySelector<HTMLElement>('#image-plugin-update-status')!;
  const folder = installedFolder();
  let pending = false;
  let nextCheck = 0;

  function describe(message: string, available = false) {
    tooltip.textContent = message;
    button.setAttribute('aria-label', available ? '当前分支有更新，点击重新检查' : '检查插件更新');
    button.classList.toggle('has-update', available);
  }

  async function check(force = false): Promise<void> {
    if (signal.aborted || pending || (!force && Date.now() < nextCheck)) return;
    if (!folder) {
      describe('当前加载位置无法识别 Git 安装信息。请在酒馆扩展管理中检查更新。');
      return;
    }
    pending = true;
    button.setAttribute('aria-busy', 'true');
    tooltip.textContent = '正在检查当前安装分支的更新…';
    const request = new AbortController();
    const cancel = () => request.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = window.setTimeout(cancel, 20_000);
    try {
      const version = await readVersion(folder, request.signal);
      if (signal.aborted) return;
      if (!version.currentBranchName.trim() || !version.currentCommitHash.trim() || !version.remoteUrl.trim()) {
        describe('当前安装没有可用的 Git 分支信息，无法判断更新。请在酒馆扩展管理中查看。');
      } else {
        const branch = version.currentBranchName;
        const commit = version.currentCommitHash.slice(0, 8);
        describe(version.isUpToDate
          ? `当前分支 ${branch}（${commit}）暂无可用更新。点击铃铛可重新检查。`
          : `当前分支 ${branch} 有更新，本机提交 ${commit}。请在酒馆扩展管理中更新“魔女画匣”，完成后刷新页面。`, !version.isUpToDate);
      }
      nextCheck = Date.now() + checkInterval;
    } catch (error) {
      if (!signal.aborted) {
        describe(request.signal.aborted ? '更新检查超时，请稍后点击铃铛重试。'
          : error instanceof Error ? error.message : '更新检查未完成，请稍后点击铃铛重试。');
        nextCheck = Date.now() + retryInterval;
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      pending = false;
      button.setAttribute('aria-busy', 'false');
    }
  }

  button.addEventListener('click', () => { void check(true); }, { signal });
  return { check: () => { void check(); } };
}
