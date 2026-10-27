import { extensionId } from './settings.js';
import { pluginName } from './pages.js';

/** A native drawer entry also gives hosts a discoverable way to open our panel. */
export function bindSettingsEntry(open: (button: HTMLButtonElement) => void, signal: AbortSignal): void {
  if (signal.aborted) return;
  const container = document.getElementById('extensions_settings') ?? document.getElementById('extensions_settings2');
  const id = `${extensionId}-settings`;
  if (!container || document.getElementById(id)) return;
  const entry = document.createElement('div');
  entry.id = id;
  entry.className = 'extension_container';
  entry.innerHTML = `<div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>${pluginName}</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></div>
    </div>
    <div class="inline-drawer-content">
      <p>管理生图接口、预设、角色锚定与图片历史。</p>
      <button type="button" class="menu_button">打开${pluginName}</button>
    </div>
  </div>`;
  const button = entry.querySelector<HTMLButtonElement>('button')!;
  button.addEventListener('click', () => open(button), { signal });
  container.append(entry);
  signal.addEventListener('abort', () => entry.remove(), { once: true });
}
