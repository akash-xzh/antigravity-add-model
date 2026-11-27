/** Custom-model UI, appended to the vendor preload. Sandboxed preloads require Electron only. */
import { ipcRenderer } from 'electron';

interface CustomModelEntry {
  name: string;
  displayName?: string;
  description?: string;
  provider: string;
  providerName?: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  apiFormat?: string;
  enabled?: boolean;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  [key: string]: unknown;
}
interface ProviderPreset {
  id: string;
  label: string;
  defaultUrl: string;
  apiFormat: string;
  keyRequired: boolean;
}
interface ModelChoice {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
}
interface ActionResult {
  success: boolean;
  error?: string;
  message?: string;
  count?: number;
  status?: number;
}
interface DiscoveryResult extends ActionResult {
  models?: ModelChoice[];
}
interface DiagnosticsSnapshot extends ActionResult {
  active: number;
  summary: Record<string, number>;
  recentModels: string[];
  requests: {
    model: string;
    provider: string;
    timestamp: number;
    outcome: string;
    status?: number;
    latencyMs: number;
    stream: boolean;
    kind: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  }[];
}
interface GatewayConfig {
  url: string;
  token: string;
  dashboardUrl: string;
}
interface GoogleAccountEntry {
  id: string;
  label?: string;
  email?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  project?: string;
  authMode?: 'custom' | 'antigravity';
  cloudCodeEndpoint?: string;
  enabled?: boolean;
}
interface QuotaBucket {
  id: string;
  displayName?: string;
  groupName?: string;
  remainingFraction?: number;
  resetTime?: string;
  window?: string;
  description?: string;
  disabled?: boolean;
}
interface AccountQuota {
  buckets: QuotaBucket[];
  groups?: { name?: string; displayName?: string; description?: string; buckets?: QuotaBucket[] }[];
  planTier?: string;
  email?: string;
}
const storageAPI = {
  getCustomModels: (): Promise<CustomModelEntry[]> => ipcRenderer.invoke('storage:get-custom-models'),
  saveCustomModel: (model: CustomModelEntry): Promise<ActionResult> =>
    ipcRenderer.invoke('storage:save-custom-model', model),
  deleteCustomModel: (name: string): Promise<ActionResult> => ipcRenderer.invoke('storage:delete-custom-model', name),
  testModelConnection: (model: Partial<CustomModelEntry>): Promise<ActionResult> =>
    ipcRenderer.invoke('storage:test-model-connection', model),
  testModelGeneration: (model: Partial<CustomModelEntry>): Promise<ActionResult> =>
    ipcRenderer.invoke('storage:test-model-generation', model),
  getPresets: (): Promise<ProviderPreset[]> => ipcRenderer.invoke('storage:get-provider-presets'),
  discoverModels: (params: Partial<CustomModelEntry>): Promise<DiscoveryResult> =>
    ipcRenderer.invoke('storage:discover-models', params),
  detectModelCapabilities: async (
    modelIds: string[],
  ): Promise<
    Record<
      string,
      {
        contextWindow?: number;
        maxOutputTokens?: number;
        supportsVision?: boolean;
        supportsThinking?: boolean;
        reasoningEffort?: CustomModelEntry['reasoningEffort'];
        supportedEfforts?: Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>;
      }
    >
  > => {
    try {
      const res = (await ipcRenderer.invoke('storage:detect-model-capabilities', modelIds)) as
        | { success?: boolean; capabilities?: Record<string, Record<string, unknown>> }
        | undefined;
      return (res?.capabilities as Record<string, never>) || {};
    } catch {
      return {};
    }
  },
  getModelHealth: (): Promise<
    Record<
      string,
      {
        status: 'healthy' | 'slow' | 'unhealthy' | 'cooldown';
        error?: string;
        latencyMs?: number;
        checkedAt: number;
      }
    >
  > => ipcRenderer.invoke('storage:get-model-health'),
  checkModelHealth: (
    name?: string,
  ): Promise<
    Record<
      string,
      {
        status: 'healthy' | 'slow' | 'unhealthy' | 'cooldown';
        error?: string;
        latencyMs?: number;
        checkedAt: number;
      }
    >
  > => ipcRenderer.invoke('storage:check-model-health', name),
  getDisplaySettings: (): Promise<{ showStatusEmoji: boolean }> =>
    ipcRenderer.invoke('storage:get-display-settings'),
  saveDisplaySettings: (settings: { showStatusEmoji: boolean }): Promise<ActionResult> =>
    ipcRenderer.invoke('storage:save-display-settings', settings),
};

window.addEventListener('DOMContentLoaded', () => {
  let modelList: CustomModelEntry[] = [];
  let renderVersion = 0;
  let lastRenderedSnapshot = '';
  let listPollTimer: ReturnType<typeof setInterval> | undefined;
  let searchTerm = '';
  type ModelFilter = 'all' | 'enabled' | 'disabled' | 'unhealthy';
  let filterMode: ModelFilter = 'all';
  let selectedProviderKey = '';
  let rightPaneMode: 'detail' | 'template-picker' = 'detail';
  let apiKeyVisible = false;
  let providersTabActive = false;
  let providerToast: { text: string; type: 'pending' | 'success' | 'failure' } | null = null;
  let providerToastTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelModalOperation: (() => void) | undefined;
  const requireSuccess = (result: ActionResult): ActionResult => {
    if (!result?.success) throw new Error(result?.error || 'The operation could not be completed.');
    return result;
  };
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function setStatus(target: HTMLElement, text: string, error = false): void {
    target.textContent = text;
    target.className = `agy-status${error ? ' agy-error' : ''}`;
  }
  function statusNode(): HTMLElement {
    const node = element('div', 'agy-status');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    return node;
  }
  function button(
    label: string,
    action: () => void | Promise<void>,
    status?: HTMLElement,
    primary = false,
  ): HTMLButtonElement {
    const node = element('button', `agy-btn${primary ? ' agy-primary' : ''}`, label);
    node.type = 'button';
    node.addEventListener('click', async () => {
      // Fleet saves read and replace complete model records. Other settings
      // actions must not submit an older record while that transaction is pending.
      if (node.disabled || fleetBusy) return;
      node.disabled = true;
      try {
        await action();
      } catch (error) {
        const target = status || document.getElementById('agy-main-status');
        if (target) setStatus(target, error instanceof Error ? error.message : String(error), true);
      } finally {
        node.disabled = false;
      }
    });
    return node;
  }
  function field(parent: HTMLElement, title: string, id: string, value = '', type = 'text'): HTMLInputElement {
    const label = element('label', 'agy-field');
    label.htmlFor = id;
    label.append(element('span', '', title));
    const input = element('input');
    input.id = id;
    input.type = type;
    input.value = value;
    input.autocomplete = 'off';
    label.append(input);
    parent.append(label);
    return input;
  }
  function selectField(
    parent: HTMLElement,
    title: string,
    id: string,
    options: [string, string][],
    value: string,
  ): HTMLSelectElement {
    const label = element('label', 'agy-field');
    label.htmlFor = id;
    label.append(element('span', '', title));
    const select = element('select');
    select.id = id;
    for (const [key, caption] of options) {
      const option = element('option', '', caption);
      option.value = key;
      select.append(option);
    }
    select.value = value;
    label.append(select);
    parent.append(label);
    return select;
  }
  function jsonField(parent: HTMLElement, title: string, id: string, value: unknown): HTMLTextAreaElement {
    const label = element('label', 'agy-field');
    label.htmlFor = id;
    label.append(element('span', '', title));
    const input = element('textarea');
    input.id = id;
    input.rows = 3;
    input.spellcheck = false;
    input.value = value ? JSON.stringify(value, null, 2) : '';
    input.placeholder = '{}';
    label.append(input);
    parent.append(label);
    return input;
  }
  function textAreaField(
    parent: HTMLElement,
    title: string,
    id: string,
    value: unknown,
    placeholder: string,
  ): HTMLTextAreaElement {
    const label = element('label', 'agy-field');
    label.htmlFor = id;
    label.append(element('span', '', title));
    const input = element('textarea');
    input.id = id;
    input.rows = 3;
    input.value = typeof value === 'string' ? value : '';
    input.placeholder = placeholder;
    label.append(input);
    parent.append(label);
    return input;
  }
  function readJson(input: HTMLTextAreaElement, title: string): Record<string, unknown> | undefined {
    if (!input.value.trim()) return undefined;
    try {
      const value = JSON.parse(input.value);
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
      return value;
    } catch {
      throw new Error(`${title} must be a JSON object.`);
    }
  }
  function readNumber(input: HTMLInputElement, title: string, minimum = 0): number | undefined {
    if (!input.value.trim()) return undefined;
    const value = Number(input.value);
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new Error(`${title} must be a whole number of at least ${minimum}.`);
    return value;
  }
  function validUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error('Enter a complete http:// or https:// API URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP or HTTPS URL. Enter credentials in the API key field.');
    return value.trim();
  }
  function installStyles(): void {
    if (document.getElementById('agy-manager-style')) return;
    const style = element('style');
    style.id = 'agy-manager-style';
    style.textContent = `
      #agy-custom-models-section,#agy-modal-overlay{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e4e4e7;box-sizing:border-box}
      #agy-custom-models-section *,#agy-modal-overlay *{box-sizing:border-box}
      #agy-custom-models-section [hidden],#agy-modal-overlay [hidden]{display:none!important}
      #agy-custom-models-section{margin:24px 0;padding:20px;border:1px solid rgba(255,255,255,.10);border-radius:12px;background:#121214;min-width:0}
      #agy-custom-models-section[data-fullwidth="true"]{margin:0;padding:24px 28px 32px;border:0;border-radius:0;background:transparent;width:100%;max-width:none;min-height:100%;box-sizing:border-box}
      #agy-custom-models-section[data-fullwidth="true"] .zc-split-card{min-height:calc(100vh - 230px);grid-template-columns:240px minmax(0,1fr)}
      #agy-providers-banner{margin:18px 0;padding:14px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.10);background:#1b1b1e;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f4f4f5}
      #agy-providers-banner .agy-btn{appearance:none;font:inherit;font-size:12.5px;font-weight:600;padding:6px 13px;border-radius:8px;border:1px solid #f4f4f5;background:#f4f4f5;color:#09090b;cursor:pointer;white-space:nowrap}
      #agy-providers-banner .agy-btn:hover{background:#e4e4e7}
      .agy-providers-nav-tab{width:100%;text-align:left;cursor:pointer;transition:background .12s ease,color .12s ease}
      .agy-providers-nav-tab[data-active="true"]{background:rgba(255,255,255,.11)!important;color:#fafafa!important;font-weight:500}
      #agy-custom-models-section h2,#agy-modal-overlay h2{font-size:18px;margin:0;color:#f4f4f5;font-weight:600;letter-spacing:-.015em}
      #agy-custom-models-section h3{font-size:14px;margin:0;color:#f4f4f5;font-weight:600}
      .agy-toolbar,.agy-actions,.agy-group-heading,.agy-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .agy-toolbar{justify-content:space-between;margin-bottom:6px}.agy-actions{margin:8px 0}
      .agy-toolbar .agy-btn{padding:6px 12px;font-size:12.5px;border-radius:8px}
      .agy-tools-menu{position:relative}
      .agy-tools-btn{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:6px 11px;font-size:12.5px;font-weight:500;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#e4e4e7;user-select:none;transition:background .12s ease,border-color .12s ease}
      .agy-tools-btn::-webkit-details-marker{display:none}
      .agy-tools-btn:hover,.agy-tools-menu[open] .agy-tools-btn{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.22);color:#fafafa}
      .agy-tools-popover{position:absolute;right:0;top:calc(100% + 6px);z-index:45;min-width:220px;padding:6px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:#232327;box-shadow:0 16px 40px rgba(0,0,0,.65);display:flex;flex-direction:column;gap:2px}
      #agy-custom-models-section .agy-tools-popover .agy-btn{width:100%;text-align:left;border:0;background:transparent;border-radius:6px;padding:7px 10px;font-size:12.5px;color:#e4e4e7}
      #agy-custom-models-section .agy-tools-popover .agy-btn:hover{background:rgba(255,255,255,.08);color:#fafafa}
      .agy-tools-divider{height:1px;background:rgba(255,255,255,.09);margin:4px 2px}
      .agy-tools-popover .agy-toggle-label{padding:6px 10px;font-size:12px;color:#d4d4d8;border-radius:6px}
      .agy-tools-popover .agy-toggle-label:hover{background:rgba(255,255,255,.06)}
      .agy-muted{color:#a1a1aa;font-size:12px;overflow-wrap:anywhere}
      .agy-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      /* ZCode two-pane Models UI (B7n / R7n / b8n / V7n / l8n / K6n / G6n) */
      .zc-split-card{overflow:hidden;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:#1b1b1e;display:grid;grid-template-columns:220px minmax(0,1fr);min-height:460px;margin-top:10px}
      .zc-sidebar{border-right:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.16);padding:10px 8px;display:flex;flex-direction:column;gap:12px;min-width:0}
      .zc-nav-group{display:flex;flex-direction:column;gap:2px}
      .zc-nav-group-title{font-size:11px;font-weight:600;color:#71717a;padding:4px 8px;letter-spacing:.01em}
      .zc-nav-item{appearance:none;display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border-radius:8px;border:0;background:transparent;color:#a1a1aa;font:inherit;font-size:12.5px;font-weight:500;text-align:left;cursor:pointer;transition:background .12s ease,color .12s ease}
      .zc-nav-item:hover{background:rgba(255,255,255,.07);color:#f4f4f5}
      .zc-nav-item.active{background:rgba(255,255,255,.11);color:#f4f4f5}
      .zc-nav-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .zc-nav-count{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#71717a;flex-shrink:0}
      .zc-badge{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;font-size:10px;font-weight:700;color:#09090b;flex-shrink:0;letter-spacing:-.02em}
      .zc-badge-lg{width:24px;height:24px;font-size:11px}
      .zc-badge-xl{width:34px;height:34px;border-radius:8px;font-size:12px}
      .zc-detail{position:relative;min-width:0;padding:18px 20px 64px;display:flex;flex-direction:column;gap:16px}
      .zc-detail-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
      .zc-detail-title{display:flex;align-items:center;gap:9px;min-width:0}
      .zc-detail-title h3{font-size:15px;font-weight:600;color:#f4f4f5;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .zc-detail-head-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
      .zc-conn-fields{display:flex;flex-direction:column;gap:10px}
      .zc-field-row{display:flex;flex-direction:column;gap:4px}
      .zc-field-label{font-size:12px;color:#a1a1aa;font-weight:500}
      .zc-input-wrap{position:relative;display:flex;align-items:center}
      #agy-custom-models-section .zc-input{font:inherit;font-size:12.5px;width:100%;height:34px;padding:0 11px;border-radius:8px;border:1px solid rgba(255,255,255,.10);background:#232327;color:#f4f4f5;outline:none;transition:border-color .14s ease,background .14s ease}
      #agy-custom-models-section .zc-input.zc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
      #agy-custom-models-section .zc-input:hover{border-color:rgba(255,255,255,.18)}
      #agy-custom-models-section .zc-input:focus{background:#161618;border-color:#38bdf8;box-shadow:0 0 0 2px rgba(56,189,248,.16)}
      #agy-custom-models-section select.zc-input{padding-right:28px;cursor:pointer}
      #agy-custom-models-section select.zc-input option{background:#232327;color:#f4f4f5}
      .zc-eye-btn{position:absolute;right:5px;top:50%;transform:translateY(-50%)}
      .zc-models-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap}
      .zc-model-list{overflow:visible;border-radius:8px;border:1px solid rgba(255,255,255,.10);background:#232327}
      .zc-model-list .agy-row{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;border:0;border-bottom:1px solid rgba(255,255,255,.08);border-radius:0;padding:8px 11px;margin:0;background:transparent;min-width:0;font-size:12.5px;transition:background .12s ease}
      .zc-model-list .agy-row:first-child{border-radius:7px 7px 0 0}
      .zc-model-list .agy-row:last-child{border-bottom:0;border-radius:0 0 7px 7px}
      .zc-model-list .agy-row:only-child{border-radius:7px}
      .zc-model-list .agy-row:hover{background:rgba(255,255,255,.035)}
      .zc-icon-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border-radius:6px;border:0;background:transparent;color:#a1a1aa;cursor:pointer;flex-shrink:0;transition:background .12s ease,color .12s ease}
      .zc-icon-btn:hover:not(:disabled){background:rgba(255,255,255,.09);color:#f4f4f5}
      .zc-icon-btn.zc-icon-danger:hover:not(:disabled){background:rgba(239,68,68,.15);color:#f87171}
      .zc-icon-btn:disabled{opacity:.45;cursor:not-allowed}
      .zc-ctx-badge{display:inline-flex;align-items:center;height:19px;padding:0 6px;border-radius:5px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.045);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;color:#a1a1aa;flex-shrink:0}
      .zc-vision-badge{display:inline-flex;align-items:center;justify-content:center;color:#a1a1aa;flex-shrink:0}
      .zc-empty-models{display:flex;align-items:center;gap:8px;min-height:46px;padding:0 14px;border-radius:8px;border:1px dashed rgba(255,255,255,.15);color:#a1a1aa;font-size:12.5px}
      .zc-tpl-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}
      .zc-tpl-card{appearance:none;display:flex;align-items:center;gap:12px;min-height:60px;width:100%;padding:10px 13px;border-radius:8px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);color:#f4f4f5;font:inherit;font-size:13px;font-weight:500;text-align:left;cursor:pointer;transition:border-color .13s ease,background .13s ease}
      .zc-tpl-card:hover{border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.08)}
      .zc-toast-viewport{position:sticky;bottom:10px;margin-top:auto;z-index:20;display:flex;flex-direction:column;gap:6px;pointer-events:none}
      .zc-toast{pointer-events:auto;display:flex;align-items:center;gap:8px;min-height:38px;padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(35,35,39,.96);color:#f4f4f5;font-size:12px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,.45)}
      .zc-toast[data-type="success"]{border-color:rgba(34,197,94,.35);background:rgba(20,45,30,.92);color:#86efac}
      .zc-toast[data-type="failure"]{border-color:rgba(239,68,68,.38);background:rgba(52,20,22,.92);color:#fca5a5}
      #agy-custom-models-section .agy-switch{position:relative;display:inline-flex;align-items:center;width:30px;height:17px;padding:0;border-radius:9999px;border:1px solid transparent;background:#3a3a42;cursor:pointer;flex-shrink:0;transition:background .18s cubic-bezier(.22,1,.36,1),border-color .18s ease}
      #agy-custom-models-section .agy-switch[aria-checked="true"]{background:#22c55e}
      #agy-custom-models-section .agy-switch:hover{filter:brightness(1.08)}
      .agy-switch-dot{width:13px;height:13px;border-radius:9999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.4);transform:translateX(1px);transition:transform .18s cubic-bezier(.22,1,.36,1);pointer-events:none}
      #agy-custom-models-section .agy-switch[aria-checked="true"] .agy-switch-dot{transform:translateX(14px)}
      .agy-row .agy-muted{font-size:11px}
      .agy-row .agy-status{margin-top:2px;font-size:11px}
      .agy-row-info{display:flex;flex-direction:column;gap:2px;min-width:0;overflow:hidden;flex:1 1 auto}
      .agy-row-title{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
      .agy-row-title strong{font-size:12.5px;font-weight:500;color:#f4f4f5;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .agy-row-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .agy-row-actions{display:flex;align-items:center;gap:3px;margin-left:auto;flex:0 0 auto}
      .agy-menu{position:relative}
      .agy-menu-btn{list-style:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;border:0;background:transparent;color:#a1a1aa;font-size:14px;line-height:1;user-select:none}
      .agy-menu-btn::-webkit-details-marker{display:none}
      .agy-menu-btn:hover,.agy-menu[open] .agy-menu-btn{background:rgba(255,255,255,.09);color:#f4f4f5}
      .agy-menu-list{position:absolute;right:0;top:calc(100% + 4px);z-index:30;display:flex;flex-direction:column;min-width:170px;padding:4px;border:1px solid rgba(255,255,255,.16);border-radius:10px;background:#232327;box-shadow:0 12px 32px rgba(0,0,0,.6)}
      #agy-custom-models-section .agy-menu-list .agy-btn{width:100%;text-align:left;border:0;background:transparent;border-radius:6px;padding:6px 9px;font-size:12px}
      #agy-custom-models-section .agy-menu-list .agy-btn:hover{background:rgba(255,255,255,.08)}
      #agy-custom-models-section .agy-menu-list .agy-danger{color:#fca5a5}
      .agy-row[data-enabled="false"] .agy-row-info{opacity:.55}
      .agy-effort-chip{display:inline-block;padding:1px 6px;border-radius:5px;background:rgba(56,189,248,.10);border:1px solid rgba(56,189,248,.25);color:#7dd3fc;font-size:10.5px;font-weight:500;line-height:16px;white-space:nowrap}
      .agy-effort-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:6px;background:#16161a;border:1px solid rgba(255,255,255,.09);flex-shrink:0}
      .agy-effort-tab{appearance:none;padding:2px 6px;border-radius:4px;border:none;background:transparent;color:#8e8e98;font-size:10.5px;font-weight:500;line-height:14px;white-space:nowrap;cursor:pointer;transition:background .12s,color .12s,opacity .12s}
      .agy-effort-tab:hover{color:#e4e4e7;background:rgba(255,255,255,.06)}
      .agy-effort-tab[aria-pressed="true"]{background:rgba(56,189,248,.18);color:#7dd3fc;font-weight:600}
      .agy-effort-tab[data-enabled="false"]{opacity:.38;text-decoration:line-through}
      .agy-effort-tab[data-enabled="false"][aria-pressed="true"]{opacity:.72}
      .agy-row-slug{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#8e8e98}
      .agy-sticky-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 2px;padding:6px 0}
      .agy-sticky-bar .agy-field{margin:0;flex:1 1 220px}
      .agy-chip{appearance:none;font:inherit;font-size:11.5px;color:#a1a1aa;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);border-radius:9999px;padding:3px 10px;cursor:pointer;white-space:nowrap}
      .agy-chip:hover{color:#f4f4f5;border-color:rgba(255,255,255,.20)}
      .agy-chip[aria-pressed="true"]{color:#09090b;background:#f4f4f5;border-color:#f4f4f5;font-weight:600}
      @media(max-width:680px){.zc-split-card{grid-template-columns:1fr}.zc-sidebar{border-right:0;border-bottom:1px solid rgba(255,255,255,.10);flex-direction:row;overflow-x:auto}.zc-tpl-grid{grid-template-columns:1fr}}
      #agy-custom-models-section .agy-btn,#agy-modal-overlay .agy-btn{appearance:none;font:inherit;font-size:12.5px;font-weight:500;color:#e4e4e7;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 12px;cursor:pointer;white-space:nowrap;transition:background .13s ease,border-color .13s ease}
      #agy-custom-models-section .agy-primary,#agy-modal-overlay .agy-primary{background:#f4f4f5;color:#09090b;border-color:#f4f4f5;font-weight:600}
      #agy-custom-models-section .agy-btn:hover,#agy-modal-overlay .agy-btn:hover{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.22)}
      #agy-custom-models-section .agy-primary:hover,#agy-modal-overlay .agy-primary:hover{background:#e4e4e7;border-color:#e4e4e7}
      #agy-custom-models-section .agy-btn:disabled,#agy-modal-overlay .agy-btn:disabled{opacity:.48;cursor:wait}
      #agy-custom-models-section :focus-visible,#agy-modal-overlay :focus-visible{outline:2px solid #38bdf8;outline-offset:2px}
      .agy-status{color:#86efac;font-size:12.5px;font-weight:500;margin-top:10px;padding:8px 12px;border-radius:8px;border:1px solid rgba(34,197,94,.30);background:rgba(34,197,94,.10);white-space:pre-wrap;overflow-wrap:anywhere}.agy-status:empty{display:none}.agy-error{color:#fca5a5;border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.12)}
      .agy-row .agy-status{margin-top:4px;padding:3px 7px;font-size:11px;border-radius:6px}
      .agy-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;min-width:0;color:#a1a1aa;font-size:12px;font-weight:500}
      #agy-custom-models-section input,#agy-modal-overlay input,#agy-modal-overlay select,#agy-modal-overlay textarea{font:inherit;font-size:13px;font-weight:400;width:100%;background:#232327;border:1px solid rgba(255,255,255,.11);border-radius:8px;color:#f4f4f5;padding:8px 11px;min-width:0;outline:none;transition:border-color .13s ease,background .13s ease}
      #agy-custom-models-section input:hover,#agy-modal-overlay input:hover,#agy-modal-overlay select:hover,#agy-modal-overlay textarea:hover{border-color:rgba(255,255,255,.20)}
      #agy-custom-models-section input:focus,#agy-modal-overlay input:focus,#agy-modal-overlay select:focus,#agy-modal-overlay textarea:focus{background:#161618;border-color:#38bdf8;box-shadow:0 0 0 2px rgba(56,189,248,.16)}
      #agy-modal-overlay select option{background:#232327;color:#f4f4f5}
      #agy-modal-overlay textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;resize:vertical}#agy-modal-overlay input[type=checkbox],#agy-custom-models-section input[type=checkbox]{width:auto!important;accent-color:#38bdf8;cursor:pointer;margin:0 6px 0 0}
      .agy-options-row{display:flex;align-items:center;gap:16px;margin:8px 0 12px;font-size:12px;color:#d4d4d8}
      .agy-toggle-label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
      #agy-modal-overlay{position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.66);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px}
      #agy-modal-card{width:620px;max-width:100%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;background:#1b1b1e;border:1px solid rgba(255,255,255,.15);border-radius:14px;padding:0;box-shadow:0 28px 84px rgba(0,0,0,.72)}
      .zc-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 20px;border-bottom:1px solid rgba(255,255,255,.09);flex-shrink:0}
      .zc-modal-body{flex:1 1 auto;overflow-y:auto;padding:18px 20px}
      .zc-modal-status-wrap{padding:0 20px 14px;flex-shrink:0}
      .zc-modal-status-wrap:has(.agy-status:empty){padding-bottom:0}
      .zc-modal-rec-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;margin-bottom:14px;border-radius:9px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.03)}
      .zc-modal-rec-left{display:flex;align-items:center;gap:9px;font-size:12.5px;color:#f4f4f5;font-weight:500}
      .zc-modal-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:14px;margin-top:14px;border-top:1px solid rgba(255,255,255,.09)}
      .zc-modal-footer-left,.zc-modal-footer-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .agy-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.agy-discovery{max-height:240px;overflow:auto;margin:12px 0;border-radius:8px;border:1px solid rgba(255,255,255,.09);background:#161618;padding:4px 10px}
      .agy-discovery:empty{display:none}
      .agy-choice{display:flex;gap:10px;align-items:center;padding:7px 2px;border-bottom:1px solid rgba(255,255,255,.06);overflow-wrap:anywhere}.agy-choice:last-child{border-bottom:0}.agy-choice span{min-width:0}
      #agy-modal-overlay details{border:1px solid rgba(255,255,255,.09);border-radius:10px;margin:14px 0 6px;padding:10px 14px;background:rgba(255,255,255,.02)}#agy-modal-overlay summary{cursor:pointer;font-size:13px;font-weight:500;color:#e4e4e7;user-select:none}#agy-modal-overlay details[open] summary{margin-bottom:12px}
      #agy-modal-overlay .agy-switch{position:relative;display:inline-flex;align-items:center;width:30px;height:17px;padding:0;border-radius:9999px;border:1px solid transparent;background:#3a3a42;cursor:pointer;flex-shrink:0;transition:background .18s ease}
      #agy-modal-overlay .agy-switch[aria-checked="true"]{background:#22c55e}
      #agy-modal-overlay .agy-switch[aria-checked="true"] .agy-switch-dot{transform:translateX(14px)}
      .agy-fleet{margin:18px 0;border:1px solid #303036;border-radius:10px;padding:14px;min-width:0}.agy-fleet-table{width:100%;border-collapse:separate;border-spacing:0 12px;text-align:left;table-layout:fixed}.agy-fleet-table td{padding:0}.agy-fleet-card{background:#202024;border:1px solid #3f3f46;border-radius:10px;padding:16px;min-width:0}.agy-fleet-card-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.agy-fleet-card-header .agy-actions{margin:0}.agy-fleet-label{font-size:14px;font-weight:600;overflow-wrap:anywhere}.agy-fleet-pools{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px;margin-top:14px}.agy-fleet-pool{border:1px solid #303036;border-radius:8px;padding:12px;background:#18181b;min-width:0}.agy-fleet-pool .agy-actions{margin-bottom:0}.agy-fleet-account-state{margin-top:5px}.agy-pool-badge{display:inline-block;padding:2px 6px;border-radius:5px;background:#27272c;color:#a1a1aa;font-size:11px}.agy-pool-preferred,.agy-plan-pro{color:#86efac}.agy-plan-pro{background:rgba(34,197,94,.12);border:1px solid rgba(134,239,172,.3)}.agy-plan-ultra{color:#c4b5fd;background:rgba(139,92,246,.16);border:1px solid rgba(167,139,250,.35)}.agy-pool-disabled{color:#fca5a5}.agy-fleet-quotas{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:10px;margin:12px 0}.agy-quota-group{display:grid;gap:8px;align-content:start;background:#202024;border:1px solid #2b2b31;border-radius:8px;padding:10px}.agy-quota-group-title{font-size:11px;font-weight:600;color:#d4d4d8}.agy-quota-note{font-size:10px;color:#71717a;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.agy-quota-bucket[data-disabled="true"]{opacity:.55}.agy-quota-bucket{min-width:0}.agy-quota-heading{display:flex;justify-content:space-between;gap:8px;font-size:12px;flex-wrap:wrap}.agy-quota-bucket progress{display:block;width:100%;height:7px;margin:5px 0;accent-color:#86efac}.agy-quota-bucket[data-quota-level="high"] progress{accent-color:#86efac}.agy-quota-bucket[data-quota-level="high"] .agy-quota-value{color:#86efac}.agy-quota-bucket[data-quota-level="mid"] progress{accent-color:#fbbf24}.agy-quota-bucket[data-quota-level="mid"] .agy-quota-value{color:#fcd34d}.agy-quota-bucket[data-quota-level="low"] progress{accent-color:#f87171}.agy-quota-bucket[data-quota-level="low"] .agy-quota-value{color:#fca5a5}.agy-quota-bucket[data-exhausted="true"] progress{accent-color:#ef4444}.agy-quota-bucket[data-exhausted="true"] .agy-quota-value{color:#fca5a5}.agy-quota-reset{font-size:11px;color:#a1a1aa}.agy-fleet-fallback{display:flex;align-items:center;gap:8px;font-size:12px}.agy-fleet-fallback input{width:auto!important;accent-color:#86efac}.agy-fleet-details[hidden]{display:none}
      #agy-fleet-target-pool{font:inherit;color:#fafafa;background:#25252a;border:1px solid #414149;border-radius:6px;padding:6px;max-width:240px}#agy-fleet-target-pool option{background:#25252a;color:#fafafa}
      .agy-model-search-box{padding:4px 6px 6px}.agy-model-search-wrap{position:relative;display:flex;align-items:center}.agy-model-search-icon{position:absolute;left:8px;width:13px;height:13px;color:#a1a1aa;pointer-events:none;flex-shrink:0}.agy-model-search-input{box-sizing:border-box;width:100%;font:inherit;font-size:12px;color:inherit;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.14);border-radius:6px;padding:5px 26px 5px 27px;outline:none;transition:border-color .12s,background .12s}.agy-model-search-input:focus{border-color:rgba(255,255,255,.32);background:rgba(255,255,255,.07)}.agy-model-search-clear{position:absolute;right:5px;border:0;background:transparent;color:#a1a1aa;cursor:pointer;font-size:12px;line-height:1;padding:2px 4px;border-radius:4px}.agy-model-search-clear:hover{color:#fafafa;background:rgba(255,255,255,.1)}.agy-model-no-results{padding:8px;color:#a1a1aa;font-size:12px}
      .agy-provider-divider{height:1px;background:rgba(255,255,255,.08);margin:4px 0}
      .agy-provider-row{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;user-select:none;outline:none}.agy-provider-row:not([class*=" "]){padding:6px 8px;border-radius:6px;font-size:12px;color:inherit}.agy-provider-row[data-open="true"],.agy-provider-row:hover,.agy-provider-row:focus{background:rgba(255,255,255,.08)}.agy-provider-row-left{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden}.agy-provider-row-name{font-weight:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agy-provider-row-active{font-size:inherit;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}.agy-provider-row-right{display:flex;align-items:center;gap:6px;flex-shrink:0;opacity:.65}
      .agy-provider-sidepanel{position:fixed;z-index:9999999;min-width:240px;max-width:340px;max-height:70vh;overflow-y:auto;padding:4px;box-shadow:0 12px 36px rgba(0,0,0,.55)}.agy-sidepanel-item{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;user-select:none;outline:none}.agy-sidepanel-item:not([class*=" "]){padding:6px 8px;border-radius:6px;font-size:12px;color:inherit}.agy-sidepanel-item:hover,.agy-sidepanel-item:focus{background:rgba(255,255,255,.08)}.agy-sidepanel-item[data-disabled="true"]{opacity:.45;cursor:not-allowed}.agy-sidepanel-item-left{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden}.agy-sidepanel-item-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agy-sidepanel-item-right{display:flex;align-items:center;gap:6px;flex-shrink:0;opacity:.75}
      @media(max-width:600px){.agy-grid{grid-template-columns:1fr}.agy-row-actions{margin-left:0;width:100%;justify-content:flex-end}#agy-modal-card{padding:16px}}
    `;
    document.head.append(style);
  }
  function openModal(title: string): { body: HTMLElement; status: HTMLElement; close: () => void } {
    cancelModalOperation?.();
    cancelModalOperation = undefined;
    document.getElementById('agy-modal-overlay')?.remove();
    const previousFocus = document.activeElement as HTMLElement | null;
    const overlay = element('div');
    overlay.id = 'agy-modal-overlay';
    const card = element('div');
    card.id = 'agy-modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'agy-modal-title');
    const header = element('div', 'zc-modal-head');
    const heading = element('h2', '', title);
    heading.id = 'agy-modal-title';
    const close = () => {
      if (!overlay.isConnected) return;
      cancelModalOperation?.();
      cancelModalOperation = undefined;
      overlay.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
    const closeBtn = button('Close', close);
    closeBtn.className = 'zc-icon-btn';
    closeBtn.title = 'Close';
    closeBtn.replaceChildren(
      makeSvgIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 16),
      element('span', 'agy-sr-only', 'Close'),
    );
    header.append(heading, closeBtn);
    const body = element('div', 'zc-modal-body');
    const statusWrap = element('div', 'zc-modal-status-wrap');
    const status = statusNode();
    statusWrap.append(status);
    card.append(header, body, statusWrap);
    overlay.append(card);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        card.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,textarea,summary'),
      );
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    });
    document.body.append(overlay);
    header.querySelector('button')?.focus();
    return { body, status, close };
  }

  function createGoogleAccountPanel(
    parent: HTMLElement,
    initialAccounts: GoogleAccountEntry[],
    modelName?: string,
  ): () => GoogleAccountEntry[] {
    let accounts = initialAccounts.map((account) => ({ ...account }));
    const locallyEdited = new Set<string>();
    let accountOperationAttempt = 0;
    let accountOperationPending = false;
    const panel = element('details');
    panel.open = true;
    panel.append(element('summary', '', 'Google accounts'));
    panel.append(
      element(
        'p',
        'agy-muted',
        'Add up to 50 accounts you own using Antigravity sign-in, your Desktop OAuth client, or a credential file. Save the model to retain changes. Existing secrets stay masked. Prepare account checks the Cloud Code project and may activate the available free tier.',
      ),
    );
    const list = element('div');
    list.id = 'agy-google-accounts-list';
    const editor = element('div');
    const status = statusNode();
    const randomId = () => `account-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const addAccount = (account: GoogleAccountEntry) => {
      if (!account.id || (!account.refreshToken && !account.accessToken))
        throw new Error('An account needs an ID and a refresh token or access token.');
      if (account.refreshToken && !account.clientId)
        throw new Error('An OAuth client ID is required with a refresh token.');
      const index = accounts.findIndex((value) => value.id === account.id);
      if (index < 0) {
        if (accounts.length >= 50) throw new Error('A model can contain at most 50 Google accounts.');
        accounts.push(account);
      } else accounts[index] = account;
      locallyEdited.add(account.id);
      renderAccounts();
    };
    function editAccount(account?: GoogleAccountEntry): void {
      editor.replaceChildren();
      editor.append(element('h3', '', account ? 'Edit account' : 'Add account credentials'));
      const accountGrid = element('div', 'agy-grid');
      const id = field(accountGrid, 'Account ID', 'agy-account-id', account?.id || randomId());
      const label = field(accountGrid, 'Label', 'agy-account-label', account?.label || '');
      const clientId = field(accountGrid, 'Desktop OAuth client ID', 'agy-account-client-id', account?.clientId || '');
      const clientSecret = field(
        accountGrid,
        'OAuth client secret (if required)',
        'agy-account-client-secret',
        account?.clientSecret || '',
        'password',
      );
      const refresh = field(
        accountGrid,
        'Refresh token',
        'agy-account-refresh-token',
        account?.refreshToken || '',
        'password',
      );
      const access = field(
        accountGrid,
        'Access token (optional with refresh token)',
        'agy-account-access-token',
        account?.accessToken || '',
        'password',
      );
      const expires = field(
        accountGrid,
        'Access token expiry (Unix milliseconds)',
        'agy-account-expires-at',
        account?.expiresAt != null ? String(account.expiresAt) : '',
        'number',
      );
      const project = field(accountGrid, 'Cloud project (optional)', 'agy-account-project', account?.project || '');
      editor.append(accountGrid);
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Apply account',
          () => {
            const accountId = id.value.trim();
            if (account && accountId !== account.id && accounts.some((value) => value.id === accountId))
              throw new Error('That account ID already exists.');
            const updated: GoogleAccountEntry = {
              id: accountId,
              label: label.value.trim(),
              clientId: clientId.value.trim(),
              clientSecret: clientSecret.value.trim(),
              refreshToken: refresh.value.trim(),
              accessToken: access.value.trim(),
              expiresAt: readNumber(expires, 'Token expiry', 1),
              project: project.value.trim(),
              authMode: account?.authMode,
              cloudCodeEndpoint: account?.cloudCodeEndpoint,
              enabled: account?.enabled !== false,
            };
            // IDs bind masked secrets to their stored record, so changing an existing ID requires fresh credentials.
            if (
              account &&
              accountId !== account.id &&
              [updated.refreshToken, updated.accessToken, updated.clientSecret].some((value) => value?.includes('***'))
            )
              throw new Error('Keep the account ID unchanged when using masked credentials.');
            addAccount(updated);
            if (account && accountId !== account.id) accounts = accounts.filter((value) => value.id !== account.id);
            editor.replaceChildren();
            renderAccounts();
            setStatus(status, 'Account updated. Save the model to keep these changes.');
          },
          status,
        ),
        button('Cancel account edit', () => editor.replaceChildren(), status),
      );
      editor.append(actions);
    }
    function renderAccounts(): void {
      list.replaceChildren();
      if (!accounts.length) list.append(element('p', 'agy-muted', 'No Google accounts configured.'));
      for (const account of accounts) {
        const row = element('div', 'agy-row');
        const info = element('div', 'agy-row-info');
        info.append(
          element('strong', '', account.label || account.id),
          element(
            'div',
            'agy-muted',
            `${account.id} · ${account.enabled === false ? 'Disabled' : 'Enabled'}${account.project ? ` · ${account.project}` : ''}`,
          ),
        );
        const actions = element('div', 'agy-actions');
        actions.append(
          button('Edit account', () => editAccount(account), status),
          button(
            account.enabled === false ? 'Enable account' : 'Disable account',
            () => {
              account.enabled = account.enabled === false;
              renderAccounts();
            },
            status,
          ),
          button(
            'Test account',
            async () => {
              setStatus(status, 'Checking account access and quota…');
              const result = await ipcRenderer.invoke(
                'storage:google-test-account',
                modelName && !locallyEdited.has(account.id)
                  ? { modelName, accountId: account.id }
                  : { account, ...(modelName ? { modelName } : {}) },
              );
              requireSuccess(result);
              setStatus(
                status,
                result.message ||
                  (result.quota
                    ? `Account verified. Quota: ${JSON.stringify(result.quota)}`
                    : 'Account verified. Generation was not tested.'),
              );
            },
            status,
          ),
          button(
            'Prepare account',
            async () => {
              if (accountOperationPending)
                throw new Error('Wait for the current Google account operation or cancel it.');
              accountOperationPending = true;
              const attempt = ++accountOperationAttempt;
              const cancel = () => {
                accountOperationAttempt++;
                void ipcRenderer.invoke('storage:google-login-cancel').catch(() => {});
              };
              cancelModalOperation = cancel;
              try {
                setStatus(status, 'Preparing account access and Cloud Code project…');
                const result = await ipcRenderer.invoke('storage:google-account-prepare', {
                  ...(modelName && !locallyEdited.has(account.id)
                    ? { modelName, accountId: account.id }
                    : { account, ...(modelName ? { modelName } : {}) }),
                  allowOnboard: true,
                });
                if (!panel.isConnected || accountOperationAttempt !== attempt) return;
                requireSuccess(result);
                if (!accounts.some((value) => value.id === account.id)) return;
                if (!result.account || result.account.id !== account.id)
                  throw new Error('Account preparation did not return the selected account.');
                addAccount({ ...account, ...(result.account as GoogleAccountEntry) });
                setStatus(
                  status,
                  result.message ||
                    'Account prepared. Save the model to retain the project. Generation was not tested.',
                );
              } finally {
                accountOperationPending = false;
                if (cancelModalOperation === cancel) cancelModalOperation = undefined;
              }
            },
            status,
          ),
          button(
            'Remove account',
            () => {
              accounts = accounts.filter((value) => value.id !== account.id);
              locallyEdited.delete(account.id);
              renderAccounts();
            },
            status,
          ),
        );
        row.append(info, actions);
        list.append(row);
      }
    }
    const actions = element('div', 'agy-actions');
    actions.append(
      button('Add account', () => editAccount(), status),
      button(
        'Pool status',
        async () => {
          const result = await ipcRenderer.invoke('storage:google-pool-status');
          if (result?.success === false) requireSuccess(result);
          setStatus(status, JSON.stringify(result, null, 2));
        },
        status,
      ),
    );
    const login = element('details');
    login.append(element('summary', '', 'Sign in with Google'));
    const loginMode = selectField(
      login,
      'Sign-in method',
      'agy-google-login-auth-mode',
      [
        ['antigravity', 'Antigravity account'],
        ['custom', 'My Desktop OAuth client'],
      ],
      'antigravity',
    );
    const loginHelp = element('p', 'agy-muted');
    login.append(loginHelp);
    const loginLabel = field(login, 'Account label', 'agy-google-login-label');
    const loginClient = field(login, 'Desktop OAuth client ID', 'agy-google-login-client-id');
    const loginSecret = field(
      login,
      'OAuth client secret (if required)',
      'agy-google-login-client-secret',
      '',
      'password',
    );
    const updateLoginMode = () => {
      const native = loginMode.value === 'antigravity';
      loginClient.closest('label')!.hidden = native;
      loginSecret.closest('label')!.hidden = native;
      loginHelp.textContent = native
        ? 'Sign in through your browser using the installed Antigravity app’s OAuth client. This prepares your Cloud Code project and may activate the available free tier. A recognized Antigravity installation is required. Repeat for each account, then save the model. Generation must be tested separately.'
        : 'Enter a Desktop OAuth client from your Google Cloud project. Your project and account must have access to the configured Cloud Code service. Repeat Sign in with Google for each account, then save the model.';
    };
    loginMode.addEventListener('change', updateLoginMode);
    updateLoginMode();
    const loginActions = element('div', 'agy-actions');
    loginActions.append(
      button(
        'Sign in with Google',
        async () => {
          const authMode = loginMode.value === 'custom' ? 'custom' : 'antigravity';
          if (authMode === 'custom' && !loginClient.value.trim())
            throw new Error('Enter your Desktop OAuth client ID.');
          if (accountOperationPending) throw new Error('Wait for the current Google account operation or cancel it.');
          accountOperationPending = true;
          const attempt = ++accountOperationAttempt;
          const cancel = () => {
            accountOperationAttempt++;
            void ipcRenderer.invoke('storage:google-login-cancel').catch(() => {});
          };
          cancelModalOperation = cancel;
          for (const input of [loginMode, loginLabel, loginClient, loginSecret]) input.disabled = true;
          setStatus(
            status,
            authMode === 'antigravity'
              ? 'Complete consent in your browser, then wait for account preparation. Browser login expires after two minutes.'
              : 'Complete consent in your browser. This login expires after two minutes.',
          );
          try {
            const result = await ipcRenderer.invoke('storage:google-login', {
              authMode,
              ...(authMode === 'custom'
                ? { clientId: loginClient.value.trim(), clientSecret: loginSecret.value.trim() || undefined }
                : {}),
              label: loginLabel.value.trim() || undefined,
            });
            if (!panel.isConnected || accountOperationAttempt !== attempt) return;
            requireSuccess(result);
            if (!result.account) throw new Error('Google login did not return an account.');
            addAccount(result.account as GoogleAccountEntry);
            loginSecret.value = '';
            setStatus(
              status,
              'Account authorized. Save the model within 10 minutes to retain it; otherwise sign in again. Use Test account to check service access and quota, then Test generation to verify a model response.',
            );
          } finally {
            accountOperationPending = false;
            for (const input of [loginMode, loginLabel, loginClient, loginSecret]) input.disabled = false;
            if (cancelModalOperation === cancel) cancelModalOperation = undefined;
          }
        },
        status,
      ),
      button(
        'Cancel Google login',
        async () => {
          accountOperationAttempt++;
          requireSuccess(await ipcRenderer.invoke('storage:google-login-cancel'));
          cancelModalOperation = undefined;
          setStatus(status, 'Google login cancelled.');
        },
        status,
      ),
    );
    login.append(loginActions);
    const importer = element('details');
    importer.append(element('summary', '', 'Import account credentials'));
    importer.append(
      element(
        'p',
        'agy-muted',
        'Import your own authorized_user JSON, an account object, or an accounts array. Importing does not open a browser or make network requests.',
      ),
    );
    const accountJson = jsonField(importer, 'Account JSON', 'agy-google-account-json', undefined);
    const file = field(importer, 'Credential JSON file', 'agy-google-account-file', '', 'file');
    file.accept = '.json,application/json';
    file.addEventListener('change', async () => {
      try {
        const selected = file.files?.[0];
        if (!selected) return;
        if (selected.size > 512 * 1024) throw new Error('Account files must be smaller than 512 KB.');
        accountJson.value = await selected.text();
      } catch (error) {
        setStatus(status, String(error), true);
      }
    });
    importer.append(
      button(
        'Import accounts',
        () => {
          let data: unknown;
          try {
            data = JSON.parse(accountJson.value);
          } catch {
            throw new Error('Account credentials must be valid JSON.');
          }
          const root = data as { accounts?: unknown[]; googleAccounts?: unknown[] };
          const values = Array.isArray(data) ? data : root?.accounts || root?.googleAccounts || [data];
          if (!Array.isArray(values) || !values.length || values.length + accounts.length > 50)
            throw new Error('Import between 1 and 50 accounts.');
          const incoming = values.map((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new Error('Each account must be a JSON object.');
            const entry = value as Record<string, unknown>;
            const text = (key: string, alternate = key): string => String(entry[key] || entry[alternate] || '');
            const account: GoogleAccountEntry = {
              id: text('id') || randomId(),
              label: text('label', 'accountEmail') || 'Imported account',
              refreshToken: text('refreshToken', 'refresh_token'),
              accessToken: text('accessToken', 'access_token'),
              clientId: text('clientId', 'client_id'),
              clientSecret: text('clientSecret', 'client_secret'),
              project: text('project', 'quota_project_id'),
              ...(entry.authMode === 'custom' || entry.authMode === 'antigravity' ? { authMode: entry.authMode } : {}),
              ...(entry.cloudCodeEndpoint ? { cloudCodeEndpoint: text('cloudCodeEndpoint') } : {}),
              enabled: entry.enabled !== false,
              ...(entry.expiresAt != null ? { expiresAt: Number(entry.expiresAt) } : {}),
            };
            if (!account.refreshToken && !account.accessToken)
              throw new Error('An imported account must contain a refresh token or access token.');
            if (account.refreshToken && !account.clientId)
              throw new Error('An imported refresh token requires its OAuth client ID.');
            return account;
          });
          for (const account of incoming) addAccount(account);
          accountJson.value = '';
          file.value = '';
          setStatus(status, `Imported ${incoming.length} accounts. Save the model to encrypt and retain them.`);
        },
        status,
      ),
    );
    panel.append(list, actions, editor, login, importer, status);
    parent.append(panel);
    renderAccounts();
    return () => accounts.map((account) => ({ ...account }));
  }
  const nonSettingsContent =
    '#agy-custom-models-section,#agy-modal-overlay,button,nav,[role="tablist"],article,[role="article"],pre,code,' +
    '[data-testid="conversation-view"],[data-testid="autoscroll-viewport"],[role="log"]';
  function isSettingsContent(node: HTMLElement): boolean {
    if (node.closest(nonSettingsContent)) return false;
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function findRefreshButton(root: ParentNode): HTMLButtonElement | null {
    return (
      Array.from(root.querySelectorAll('button')).find(
        (node) =>
          !node.closest('#agy-custom-models-section') &&
          isSettingsContent(node.parentElement || node) &&
          (node.textContent?.trim() === 'Refresh' ||
            /refresh quota/i.test(`${node.getAttribute('aria-label') || ''} ${node.title || ''}`)),
      ) || null
    );
  }
  async function modelsChanged(): Promise<void> {
    const restore = captureScrollPosition(document.getElementById('agy-custom-models-section') || document.body);
    fleetEpoch++;
    quotaCache.clear();
    await renderCustomModelsList();
    const mount = findSettingsMount();
    if (mount) findRefreshButton(mount)?.click();
    restore();
  }
  function uniqueName(base: string): string {
    let name = base,
      index = 2;
    while (modelList.some((model) => model.name === name)) name = `${base}-${index++}`;
    return name;
  }
  function captureScrollPosition(node: HTMLElement): () => void {
    const positions = new Map<HTMLElement, { top: number; left: number }>();
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement)
      positions.set(parent, { top: parent.scrollTop, left: parent.scrollLeft });
    const scrollingElement = document.scrollingElement as HTMLElement | null;
    if (scrollingElement && !positions.has(scrollingElement))
      positions.set(scrollingElement, { top: scrollingElement.scrollTop, left: scrollingElement.scrollLeft });
    return () => {
      for (const [element, position] of positions) {
        if (!element.isConnected) continue;
        element.scrollTop = position.top;
        element.scrollLeft = position.left;
      }
    };
  }
  function openDeleteModelModal(model: CustomModelEntry): void {
    const { body, status, close } = openModal('Delete model');
    body.append(
      element('p', '', `Delete “${model.displayName || model.name}”?`),
      element('p', 'agy-muted', 'This removes the saved model configuration from this app.'),
    );
    const actions = element('div', 'agy-actions');
    actions.append(
      button('Cancel', close),
      button(
        'Delete model',
        async () => {
          const visibleRows = Array.from(document.querySelectorAll<HTMLElement>('#agy-custom-models-content [data-model-name]'));
          const deletedIndex = visibleRows.findIndex((row) => row.dataset.modelName === model.name);
          const adjacentNames = [...visibleRows.slice(deletedIndex + 1), ...visibleRows.slice(0, deletedIndex).reverse()]
            .map((row) => row.dataset.modelName);
          setStatus(status, 'Deleting model…');
          requireSuccess(await storageAPI.deleteCustomModel(model.name));
          // The user may have closed this dialog while storage was updating.
          const dialogStillOpen = body.isConnected;
          if (dialogStillOpen) close();
          const focusAfterClose = document.activeElement;
          await modelsChanged();
          if (dialogStillOpen && !document.getElementById('agy-modal-overlay') &&
            (document.activeElement === document.body || document.activeElement === focusAfterClose)) {
            const remainingRows = Array.from(document.querySelectorAll<HTMLElement>('#agy-custom-models-content [data-model-name]'));
            const adjacentRow = adjacentNames.map((name) => remainingRows.find((row) => row.dataset.modelName === name)).find(Boolean);
            // The overflow menu is closed after a delete, so focus the next row's visible toggle:
            // a button inside a closed <details> is not rendered and cannot take focus.
            const nextFocus = adjacentRow?.querySelector<HTMLButtonElement>('.agy-row-actions > .agy-btn')
              || document.getElementById('agy-add-model');
            nextFocus?.focus({ preventScroll: true });
          }
        },
        status,
        true,
      ),
    );
    body.append(actions);
  }
  const quotaCache = new Map<string, { quota?: AccountQuota; error?: string; at: number }>();
  let fleetEpoch = 0;
  let fleetBusy = false;
  let fleetError = '';
  let fleetCollapsed = false;
  let fleetTargetPool = '';
  try { fleetCollapsed = localStorage.getItem('agy_google_fleet_collapsed') === 'true'; } catch {}
  let fleetRefreshing = false;
  let fleetTimer: ReturnType<typeof setInterval> | undefined;
  function fleetMembers(models: CustomModelEntry[]) {
    const members: { account: GoogleAccountEntry; owner: CustomModelEntry }[] = [];
    for (const model of models) {
      if (model.provider !== 'google-cloudcode' || !Array.isArray(model.googleAccounts)) continue;
      for (const account of model.googleAccounts as GoogleAccountEntry[]) {
        if (!account?.id) continue;
        members.push({ account, owner: model });
      }
    }
    return members;
  }
  function fleetAccounts(models: CustomModelEntry[]) {
    const rows = new Map<string, { identity: string; members: ReturnType<typeof fleetMembers> }>();
    for (const member of fleetMembers(models)) {
      const { owner, account } = member;
      const email = (account.email || quotaCache.get(quotaKey(owner, account))?.quota?.email)?.trim();
      // Only a known email identifies a shared account. Unknown memberships stay
      // separate, and grouping never replaces the original owner/account used by actions.
      const key = email ? `email:${email.toLowerCase()}` : `member:${owner.name}:${account.id}`;
      const row = rows.get(key);
      if (row) row.members.push(member);
      else rows.set(key, { identity: email || account.label || account.id, members: [member] });
    }
    return [...rows.values()];
  }
  function quotaKey(model: CustomModelEntry, account: GoogleAccountEntry) {
    return JSON.stringify([model.name, model.apiUrl, model.externalModelName, account.id, account.email, account.clientId, account.project, account.authMode, account.cloudCodeEndpoint]);
  }
  async function connectFleetAccount(modelName: string, replaceAccountId?: string): Promise<void> {
    const { body, status, close } = openModal(replaceAccountId ? 'Reconnect Google account' : 'Add Google account');
    body.append(element('p', 'agy-muted', `Complete Google sign-in in your browser. The account is saved to ${modelName}.`));
    cancelModalOperation = () => { void ipcRenderer.invoke('storage:google-login-cancel'); };
    setStatus(status, 'Waiting for Google sign-in…');
    try {
      const result = await ipcRenderer.invoke('storage:google-login', { authMode: 'antigravity' }) as ActionResult & { account?: GoogleAccountEntry };
      if (!body.isConnected) return;
      requireSuccess(result);
      if (!result.account) throw new Error('Google did not return an account.');
      requireSuccess(await ipcRenderer.invoke('storage:google-link-account', { modelName, accountId: result.account.id, ...(replaceAccountId ? { replaceAccountId } : {}) }));
      quotaCache.clear();
      cancelModalOperation = undefined;
      close();
      await modelsChanged();
    } catch (error) {
      if (body.isConnected) setStatus(status, error instanceof Error ? error.message : String(error), true);
    }
  }
  function removeFleetAccount(account: GoogleAccountEntry, modelName: string) {
    const { body, status, close } = openModal('Remove Google account');
    body.append(element('p', '', `Remove ${account.email || account.label || account.id} from ${modelName}? This model will be disabled if no enabled account remains. Other model pools and your IDE login are preserved.`));
    body.append(button('Remove account', async () => {
      requireSuccess(await ipcRenderer.invoke('storage:google-remove-account', { modelName, accountId: account.id }));
      quotaCache.clear();
      close();
      await modelsChanged();
    }, status), button('Cancel', close));
  }
  async function runFleetAction(action: () => Promise<void>): Promise<void> {
    if (fleetBusy) throw new Error('Wait for the current account change to finish.');
    fleetBusy = true;
    fleetError = '';
    renderGoogleFleet();
    const disabledStates = new Map<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, boolean>();
    const roots = document.querySelectorAll<HTMLElement>('#agy-custom-models-section, #agy-modal-overlay');
    for (const root of roots) {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea')) {
        disabledStates.set(control, control.disabled);
        control.disabled = true;
      }
    }
    try {
      await action();
    } catch (error) {
      fleetError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      // Keep the lock until fresh records replace the old model/group closures.
      // The button helper also guards controls created during an async rerender.
      try {
        await modelsChanged();
      } finally {
        fleetBusy = false;
        for (const [control, wasDisabled] of disabledStates) {
          if (control.isConnected) control.disabled = wasDisabled;
        }
        renderGoogleFleet();
        void refreshFleetQuotas();
      }
    }
  }
  async function updateFleetAccounts(
    members: ReturnType<typeof fleetMembers>,
    update: (account: GoogleAccountEntry) => GoogleAccountEntry,
    updateAvailability = false,
  ): Promise<void> {
    // Read current records and save each owner once. A card is a display grouping;
    // its members retain their original IDs, credentials, projects and endpoints.
    const current = await storageAPI.getCustomModels();
    for (const owner of current) {
      const selected = new Set(members.filter((m) => m.owner.name === owner.name).map((m) => m.account.id));
      if (!selected.size || !Array.isArray(owner.googleAccounts)) continue;
      const accounts = owner.googleAccounts as GoogleAccountEntry[];
      const updated = accounts.map((account) => selected.has(account.id) ? update(account) : account);
      const hadEnabled = accounts.some((account) => account.enabled !== false);
      const hasEnabled = updated.some((account) => account.enabled !== false);
      requireSuccess(await storageAPI.saveCustomModel({
        ...owner,
        googleAccounts: updated,
        ...(updateAvailability ? { enabled: hasEnabled ? (hadEnabled ? owner.enabled : true) : false } : {}),
      }));
    }
  }
  function editFleetLabel(identity: string, members: ReturnType<typeof fleetMembers>): void {
    const { body, status, close } = openModal('Edit account label');
    body.append(element('p', 'agy-muted', `Update the label for ${identity}. Use a model pool's account editor to change its credentials or project.`));
    const label = field(body, 'Account label', 'agy-fleet-account-label', members[0]?.account.label || '');
    body.append(button('Save account label', async () => {
      await runFleetAction(() => updateFleetAccounts(members, (account) => ({ ...account, label: label.value.trim() })));
      close();
    }, status, true), button('Cancel', close));
  }
  function removeFleetMemberships(identity: string, members: ReturnType<typeof fleetMembers>): void {
    const { body, status, close } = openModal('Remove account from fleet');
    body.append(element('p', '', `Remove ${identity} from ${members.length} assigned model pool${members.length === 1 ? '' : 's'}?`),
      element('p', 'agy-muted', 'Model definitions and other accounts are preserved. Pools without enabled accounts will be disabled.'));
    body.append(button('Remove from all pools', async () => {
      await runFleetAction(async () => {
        for (const { owner, account } of members) {
          requireSuccess(await ipcRenderer.invoke('storage:google-remove-account', { modelName: owner.name, accountId: account.id }));
        }
      });
      close();
    }, status), button('Cancel', close));
  }
  function relativeQuotaReset(value: string): string {
    const diff = Date.parse(value) - Date.now();
    if (!Number.isFinite(diff)) return '';
    if (diff <= 0) return 'Reset due · refresh quota';
    const minutes = Math.ceil(diff / 60_000);
    if (minutes >= 1440) return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
    if (minutes >= 60) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return `Resets in ${minutes}m`;
  }
  function renderPoolQuota(quota: HTMLElement, cached: ReturnType<typeof quotaCache.get>): void {
    if (cached?.quota?.planTier) {
      const tier = cached.quota.planTier;
      const tierClass = /\bpro\b/i.test(tier) ? ' agy-plan-pro' : /\bultra\b/i.test(tier) ? ' agy-plan-ultra' : '';
      quota.append(element('span', `agy-pool-badge${tierClass}`, tier));
    }
    if (cached?.error) {
      quota.append(element('div', 'agy-status agy-error', cached.error));
      return;
    }
    if (!cached) {
      quota.append(element('span', 'agy-muted', 'Loading quota…'));
      return;
    }
    // The flat snapshot contains every parsed bucket, including groups. Never
    // deduplicate across projects, model pools, or distinct model buckets.
    const buckets = cached.quota?.buckets || [];
    if (!buckets.length && !(cached.quota?.groups || []).some((group) => (group.buckets || []).length)) {
      quota.append(element('span', 'agy-muted', 'Quota unavailable — Google returned no buckets.'));
      return;
    }
    // Native groups decide the order and wording: Gemini and Claude/GPT pools share a weekly
    // and a 5-hour limit, and some plans expose extra per-model groups. Free tiers simply
    // report fewer groups. Quota that is spent early on expensive models lasts less time.
    const prettyBucket = (bucket: QuotaBucket): string => {
      const source = bucket.window || bucket.id;
      if (/weekly/i.test(source)) return 'Weekly limit';
      if (/5h|five.?hour/i.test(source)) return '5-hour limit';
      if (/daily/i.test(source)) return 'Daily limit';
      return (bucket.displayName || bucket.id)
        .replace(/\s*limit remaining$/i, ' limit')
        .replace(/\s*remaining$/i, '')
        .trim();
    };
    const ordered: { title: string; description?: string; buckets: QuotaBucket[] }[] = [];
    // Free plans only meter a weekly limit per group; a 5-hour pool there is not part of the plan.
    const freePlan = /^free\b/i.test((cached.quota?.planTier || '').trim());
    const planned = (items: QuotaBucket[]) =>
      freePlan ? items.filter((bucket) => !/5h|five.?hour/i.test(bucket.window || bucket.id)) : items;
    for (const source of cached.quota?.groups || []) {
      const items = planned((source.buckets || []).filter((bucket) => bucket && typeof bucket === 'object'));
      if (items.length)
        ordered.push({
          title: source.displayName || source.name || 'Reported quota',
          description: source.description,
          buckets: items,
        });
    }
    if (!ordered.length) {
      const flat = new Map<string, QuotaBucket[]>();
      for (const bucket of planned(buckets)) {
        const title = bucket.groupName ||
          (/claude|gpt|anthropic|openai|third[- ]?party/i.test(`${bucket.displayName || ''} ${bucket.id}`)
            ? 'Claude and GPT models'
            : 'Gemini Models');
        flat.set(title, [...(flat.get(title) || []), bucket]);
      }
      for (const [title, items] of flat) ordered.push({ title, buckets: items });
    }
    // Native order: Gemini pools, then Claude/GPT pools, then any extra per-model groups.
    const canonical = ['gemini models', 'claude and gpt models'];
    const rank = (title: string) => {
      const index = canonical.indexOf(title.toLowerCase().trim());
      return index === -1 ? canonical.length : index;
    };
    ordered.sort((left, right) => rank(left.title) - rank(right.title) ||
      (rank(left.title) < canonical.length ? 0 : left.title.localeCompare(right.title)));
    const windowRank = (bucket: QuotaBucket) => {
      const source = `${bucket.window || ''} ${bucket.id}`.toLowerCase();
      if (/weekly/.test(source)) return 1;
      if (/5h|five|hour/.test(source)) return 2;
      if (/daily|day/.test(source)) return 3;
      return 4;
    };
    for (const groupInfo of ordered) groupInfo.buckets.sort((left, right) => windowRank(left) - windowRank(right));
    for (const groupInfo of ordered) {
      const group = element('div', 'agy-quota-group');
      group.append(element('div', 'agy-quota-group-title', groupInfo.title));
      if (groupInfo.description) {
        const note = element('div', 'agy-quota-note', groupInfo.description);
        note.title = groupInfo.description;
        group.append(note);
      }
      for (const bucket of groupInfo.buckets) {
        const block = element('div', 'agy-quota-bucket');
        const fraction = bucket.remainingFraction;
        const known = typeof fraction === 'number' && Number.isFinite(fraction);
        const disabled = bucket.disabled === true;
        block.dataset.disabled = String(disabled);
        block.dataset.exhausted = String(known && fraction <= 0);
        block.dataset.quotaLevel = !known
          ? 'unknown'
          : fraction <= 0
            ? 'exhausted'
            : fraction < 0.2
              ? 'low'
              : fraction <= 0.5
                ? 'mid'
                : 'high';
        const label = prettyBucket(bucket);
        const heading = element('div', 'agy-quota-heading');
        heading.append(
          element('span', 'agy-muted', label),
          element(
            'span',
            'agy-quota-value',
            disabled
              ? 'Not applicable'
              : known
                ? fraction <= 0
                  ? 'Exhausted'
                  : `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}% left`
                : 'Unknown',
          ),
        );
        block.append(heading);
        if (bucket.description) block.title = bucket.description;
        if (known && !disabled) {
          const progress = element('progress');
          progress.max = 1;
          progress.value = Math.max(0, Math.min(1, fraction));
          progress.setAttribute('aria-label', `${groupInfo.title} ${label} remaining quota`.trim());
          block.append(progress);
        }
        if (bucket.resetTime) {
          const text = relativeQuotaReset(bucket.resetTime);
          if (text) {
            const reset = element('div', 'agy-quota-reset', text);
            reset.title = new Date(bucket.resetTime).toLocaleString();
            block.append(reset);
          }
        }
        group.append(block);
      }
      quota.append(group);
    }
  }
  async function refreshFleetQuotas(force = false): Promise<void> {
    if (fleetRefreshing || fleetBusy) return;
    const container = document.getElementById('agy-google-account-pool-section');
    if (!container?.isConnected || container.hidden) return;
    const members = fleetMembers(modelList).filter(({ owner, account }) =>
      force || Date.now() - (quotaCache.get(quotaKey(owner, account))?.at || 0) >= 120_000);
    if (!members.length) return;
    const epoch = fleetEpoch;
    fleetRefreshing = true;
    renderGoogleFleet();
    try {
      // A small sequential queue avoids a login or quota request burst on large fleets.
      for (const { account, owner } of members) {
        if (!container.isConnected || fleetEpoch !== epoch || fleetBusy) break;
        const key = quotaKey(owner, account);
        if (!force && Date.now() - (quotaCache.get(key)?.at || 0) < 120_000) continue;
        try {
          const result = await ipcRenderer.invoke('storage:google-test-account', { modelName: owner.name, accountId: account.id }) as ActionResult & { quota?: AccountQuota };
          requireSuccess(result);
          if (fleetEpoch === epoch) quotaCache.set(key, { quota: result.quota, at: Date.now() });
        } catch (error) {
          if (fleetEpoch === epoch) quotaCache.set(key, { error: error instanceof Error ? error.message : String(error), at: Date.now() });
        }
      }
    } finally {
      fleetRefreshing = false;
      if (container.isConnected) renderGoogleFleet();
      if (fleetEpoch !== epoch) void refreshFleetQuotas();
    }
  }
  function renderGoogleFleet(): void {
    const container = document.getElementById('agy-google-account-pool-section');
    if (!container) return;
    const restoreScroll = captureScrollPosition(container);
    const rows = fleetAccounts(modelList);
    const hasGoogleModels = modelList.some((model) => model.provider === 'google-cloudcode');
    container.hidden = !hasGoogleModels;
    if (!hasGoogleModels) {
      container.replaceChildren();
      restoreScroll();
      return;
    }
    const keys = new Set(fleetMembers(modelList).map(({ account, owner }) => quotaKey(owner, account)));
    for (const key of quotaCache.keys()) if (!keys.has(key)) quotaCache.delete(key);
    const header = element('div', 'agy-toolbar');
    const collapse = button(`${fleetCollapsed ? '▸' : '▾'} Google account fleet · ${rows.length} account${rows.length === 1 ? '' : 's'}`, () => {
      fleetCollapsed = !fleetCollapsed;
      try { localStorage.setItem('agy_google_fleet_collapsed', String(fleetCollapsed)); } catch {}
      renderGoogleFleet();
      document.getElementById('agy-fleet-collapse')?.focus({ preventScroll: true });
    });
    collapse.id = 'agy-fleet-collapse';
    collapse.setAttribute('aria-expanded', String(!fleetCollapsed));
    collapse.setAttribute('aria-controls', 'agy-fleet-details');
    header.append(collapse);
    const actions = element('div', 'agy-actions');
    const targetPool = element('select');
    targetPool.id = 'agy-fleet-target-pool';
    targetPool.setAttribute('aria-label', 'Pool for new Google account');
    for (const model of modelList.filter((model) => model.provider === 'google-cloudcode')) {
      const option = element('option', '', model.displayName || model.name); option.value = model.name; targetPool.append(option);
    }
    if (Array.from(targetPool.options).some((option) => option.value === fleetTargetPool)) targetPool.value = fleetTargetPool;
    targetPool.onchange = () => { fleetTargetPool = targetPool.value; };
    actions.append(targetPool);
    const add = button('+ Add Account', () => connectFleetAccount(targetPool.value));
    add.id = 'agy-pool-add-account-btn';
    const refresh = button(fleetRefreshing ? 'Refreshing quotas…' : 'Refresh quotas', () => refreshFleetQuotas(true));
    refresh.id = 'agy-fleet-refresh';
    refresh.disabled = fleetRefreshing;
    actions.append(add, refresh);
    header.append(actions);
    const wrap = element('div', 'agy-fleet-details');
    wrap.id = 'agy-fleet-details';
    wrap.hidden = fleetCollapsed;
    const fallback = element('label', 'agy-fleet-fallback');
    const fallbackInput = element('input');
    fallbackInput.type = 'checkbox';
    fallbackInput.id = 'agy-fleet-native-failover';
    const googleModels = modelList.filter((model) => model.provider === 'google-cloudcode');
    const enabledFallbacks = googleModels.filter((model) => (model.googlePool as { nativeFailoverEnabled?: boolean } | undefined)?.nativeFailoverEnabled === true).length;
    fallbackInput.checked = enabledFallbacks > 0;
    fallbackInput.indeterminate = enabledFallbacks > 0 && enabledFallbacks < googleModels.length;
    fallback.append(fallbackInput, element('span', '', 'Native Google request fallback'),
      element('span', 'agy-muted', fallbackInput.indeterminate ? 'Some pools enabled' : fallbackInput.checked ? 'Enabled' : 'Disabled'));
    fallbackInput.addEventListener('change', async () => {
      const enabled = fallbackInput.checked;
      try {
        await runFleetAction(async () => {
          for (const model of await storageAPI.getCustomModels()) {
            if (model.provider !== 'google-cloudcode') continue;
            requireSuccess(await storageAPI.saveCustomModel({
              ...model, googlePool: { ...(model.googlePool as object || {}), nativeFailoverEnabled: enabled },
            }));
          }
        });
      } catch { /* runFleetAction displays the persisted result and error. */ }
    });
    wrap.append(fallback,
      element('p', 'agy-muted', 'Each model pool keeps its own credentials, project and reported quotas. Preferred accounts are used when eligible; unknown limits are not available credit.'));
    const table = element('table', 'agy-fleet-table');
    table.setAttribute('aria-label', 'Google account fleet');
    const tbody = element('tbody');
    for (const { identity: accountIdentity, members } of rows) {
      const row = element('tr');
      row.dataset.accountIdentity = accountIdentity;
      const cell = element('td');
      const card = element('article', 'agy-fleet-card');
      const cardHeader = element('div', 'agy-fleet-card-header');
      const identity = element('div');
      identity.append(element('div', 'agy-fleet-label', accountIdentity),
        element('div', 'agy-muted', `${members.length} model pool${members.length === 1 ? '' : 's'}`));
      const labels = [...new Set(members.map(({ account }) => account.label?.trim()).filter((label): label is string => !!label && label !== accountIdentity))];
      if (labels.length) identity.append(element('div', 'agy-muted', labels.join(' · ')));
      const activeCount = members.filter(({ account }) => account.enabled !== false).length;
      identity.append(element('span', `agy-fleet-account-state agy-pool-badge${activeCount === 0 ? ' agy-pool-disabled' : ''}`,
        activeCount === 0 ? 'Disabled' : activeCount === members.length ? 'Enabled' : 'Partially enabled'));
      const accountActions = element('div', 'agy-actions agy-fleet-account-actions');
      accountActions.append(
        button(activeCount ? 'Disable account' : 'Enable account', async () => {
          await runFleetAction(() => updateFleetAccounts(members, (account) => ({ ...account, enabled: activeCount === 0 }), true));
        }),
        button('Edit label', () => editFleetLabel(accountIdentity, members)),
        button('Remove from fleet', () => removeFleetMemberships(accountIdentity, members)),
      );
      cardHeader.append(identity, accountActions);
      card.append(cardHeader);
      const pools = element('div', 'agy-fleet-pools');
      for (const { account, owner } of members) {
        const cached = quotaCache.get(quotaKey(owner, account));
        const pool = element('section', 'agy-fleet-pool');
        pool.setAttribute('role', 'group');
        pool.setAttribute('aria-label', `${owner.displayName || owner.name} account ${account.id}`);
        pool.dataset.modelName = owner.name;
        pool.dataset.accountId = account.id;
        const poolHeading = element('div', 'agy-group-heading');
        const poolIdentity = element('div');
        poolIdentity.append(element('h3', '', owner.displayName || owner.name),
          element('div', 'agy-muted', [owner.name, `Account: ${account.id}`, account.project ? `Project: ${account.project}` : ''].filter(Boolean).join(' · ')));
        const preferred = (owner.googlePool as { preferredAccountId?: string } | undefined)?.preferredAccountId === account.id;
        const enabled = owner.enabled !== false && account.enabled !== false;
        poolHeading.append(poolIdentity, element('span', `agy-pool-badge${preferred ? ' agy-pool-preferred' : ''}`, !enabled ? 'Disabled' : preferred ? 'Preferred' : 'Automatic'));
        pool.append(poolHeading);
        const quota = element('div', 'agy-fleet-quotas');
        renderPoolQuota(quota, cached);
        const rowActions = element('div', 'agy-actions');
        const choose = button(preferred ? 'Automatic' : 'Use preferred', async () => {
          await runFleetAction(async () => {
            requireSuccess(await ipcRenderer.invoke('storage:google-select-account', { modelName: owner.name, ...(preferred ? {} : { accountId: account.id }) }));
          });
        });
        choose.disabled = !enabled;
        rowActions.append(choose, account.authMode === 'antigravity' ? button('Reconnect', () => connectFleetAccount(owner.name, account.id)) : button('Edit account', () => openModelModal(owner)), button('Remove', () => removeFleetAccount(account, owner.name)));
        pool.append(quota, rowActions);
        pools.append(pool);
      }
      card.append(pools);
      cell.append(card);
      row.append(cell);
      tbody.append(row);
    }
    table.append(tbody);
    wrap.append(table);
    const status = statusNode();
    setStatus(status, fleetError || (fleetRefreshing ? 'Checking each model pool’s quota…' : ''), !!fleetError);
    container.setAttribute('aria-busy', String(fleetBusy || fleetRefreshing));
    container.replaceChildren(header, status, wrap);
    if (fleetBusy) {
      for (const control of container.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')) {
        if (control !== collapse) control.disabled = true;
      }
    }
    restoreScroll();
  }

  let rowMenuDismissInstalled = false;
  const selectedEffortByKey = new Map<string, string>();
  const EFFORT_ORDER: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, extra: 5 };

  function shouldSkipBackgroundRefresh(target: HTMLElement): boolean {
    if (!target.isConnected) return true;
    if (document.getElementById('agy-modal-overlay')) return true;
    if (target.querySelector('details.agy-menu[open]')) return true;
    const active = document.activeElement;
    if (active && target.contains(active)) return true;
    for (const statusEl of target.querySelectorAll('.agy-status')) {
      if (statusEl.textContent?.trim()) return true;
    }
    return false;
  }

  function providerBadgeMeta(label: string): { text: string; color: string } {
    const clean = label.trim() || 'PR';
    const words = clean.split(/[\s\-_/.]+/).filter(Boolean);
    const text = (words.length >= 2 ? words[0][0] + words[1][0] : clean.slice(0, 2)).toUpperCase();
    const palette = ['#38bdf8', '#a78bfa', '#34d399', '#84cc16', '#f59e0b', '#f97316', '#ec4899', '#60a5fa'];
    let h = 0;
    for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
    return { text, color: palette[h % palette.length] };
  }
  function formatCompactContext(tokens?: number): string {
    if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return '';
    if (tokens >= 1_000_000) {
      const m = tokens / 1_000_000;
      return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
    }
    return `${Math.round(tokens / 1000)}K`;
  }
  function makeSvgIcon(svgMarkup: string, size = 14): SVGSVGElement {
    const tpl = document.createElement('template');
    tpl.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgMarkup}</svg>`;
    return tpl.content.firstElementChild as SVGSVGElement;
  }
  function showProviderToast(text: string, type: 'pending' | 'success' | 'failure' = 'success', durationMs = 3400): void {
    if (providerToastTimer) clearTimeout(providerToastTimer);
    providerToast = { text, type };
    const vp = document.getElementById('zc-toast-viewport');
    if (vp) {
      const toast = element('div', 'zc-toast', text);
      toast.dataset.type = type;
      toast.setAttribute('role', type === 'failure' ? 'alert' : 'status');
      vp.replaceChildren(toast);
    }
    if (durationMs > 0) {
      providerToastTimer = setTimeout(() => {
        providerToast = null;
        document.getElementById('zc-toast-viewport')?.replaceChildren();
      }, durationMs);
    }
  }
  async function renderCustomModelsList(options?: { background?: boolean }): Promise<void> {
    const background = Boolean(options?.background);
    const target = document.getElementById('agy-custom-models-content');
    if (!target) return;
    if (background && shouldSkipBackgroundRefresh(target)) return;
    const version = ++renderVersion;
    try {
      const [models, healthMap, displaySettings, presets] = await Promise.all([
        storageAPI.getCustomModels(),
        storageAPI.getModelHealth().catch(
          () =>
            ({} as Record<
              string,
              { status: 'healthy' | 'slow' | 'unhealthy' | 'cooldown'; error?: string; latencyMs?: number; checkedAt: number }
            >),
        ),
        storageAPI.getDisplaySettings().catch(() => ({ showStatusEmoji: true })),
        storageAPI.getPresets().catch(() => [] as ProviderPreset[]),
      ]);
      if (version !== renderVersion || !target.isConnected) return;
      if (background && shouldSkipBackgroundRefresh(target)) return;
      const showStatusEmoji = displaySettings?.showStatusEmoji !== false;
      const allModelsByGroupKey = new Map<string, CustomModelEntry[]>();
      const groups = new Map<string, CustomModelEntry[]>();
      for (const model of models) {
        const groupLabel = (model.providerName || '').trim() || model.provider;
        const key = `${groupLabel}\n${model.apiUrl}`;
        allModelsByGroupKey.set(key, [...(allModelsByGroupKey.get(key) || []), model]);
        if (
          searchTerm &&
          !`${model.displayName} ${model.name} ${model.externalModelName} ${model.provider} ${model.providerName || ''}`
            .toLowerCase()
            .includes(searchTerm)
        )
          continue;
        if (filterMode === 'enabled' && model.enabled === false) continue;
        if (filterMode === 'disabled' && model.enabled !== false) continue;
        if (filterMode === 'unhealthy') {
          const health = healthMap?.[model.name];
          const isUnhealthy =
            Boolean(health) &&
            (health.status === 'unhealthy' ||
              health.status === 'slow' ||
              health.status === 'cooldown' ||
              Boolean(health.error) ||
              (typeof health.status === 'string' && health.status !== 'healthy'));
          if (!isUnhealthy) continue;
        }
        groups.set(key, [...(groups.get(key) || []), model]);
      }

      const groupEntries = Array.from(groups.entries());
      const effectiveSelectedKey =
        groupEntries.length && !groups.has(selectedProviderKey) ? groupEntries[0][0] : selectedProviderKey;
      const snapshot = JSON.stringify({
        models,
        healthMap,
        showStatusEmoji,
        searchTerm,
        filterMode,
        selectedProviderKey: effectiveSelectedKey,
        rightPaneMode,
        apiKeyVisible,
      });
      if (background && snapshot === lastRenderedSnapshot) return;
      selectedProviderKey = effectiveSelectedKey;
      const emojiToggle = document.getElementById('agy-toggle-status-emojis') as HTMLInputElement | null;
      if (emojiToggle && typeof displaySettings?.showStatusEmoji === 'boolean') {
        emojiToggle.checked = displaySettings.showStatusEmoji;
      }
      const restoreScroll = captureScrollPosition(target);
      modelList = models;
      renderGoogleFleet();
      void refreshFleetQuotas();
      const content = document.createDocumentFragment();
      if (!groupEntries.length && rightPaneMode !== 'template-picker') {
        content.append(
          element(
            'p',
            'agy-muted',
            models.length
              ? 'No models match this search.'
              : 'Add a provider model, discover a local server, or import a configuration to get started.',
          ),
        );
        target.replaceChildren(content);
        lastRenderedSnapshot = snapshot;
        restoreScroll();
        return;
      }

      const splitCard = element('div', 'zc-split-card');
      const sidebar = element('aside', 'zc-sidebar');
      sidebar.setAttribute('aria-label', 'Model providers');

      const customNavItems: Array<[string, CustomModelEntry[]]> = [];
      const presetNavItems: Array<[string, CustomModelEntry[]]> = [];
      for (const entry of groupEntries) {
        if (entry[1][0]?.provider === 'custom') customNavItems.push(entry);
        else presetNavItems.push(entry);
      }

      const appendSidebarGroup = (title: string, items: Array<[string, CustomModelEntry[]]>) => {
        if (!items.length) return;
        const navGroup = element('div', 'zc-nav-group');
        navGroup.append(element('div', 'zc-nav-group-title', title));
        for (const [key, gModels] of items) {
          const first = gModels[0];
          const label = (first.providerName || '').trim() || first.provider;
          const badge = providerBadgeMeta(label);
          const navBtn = document.createElement('button');
          navBtn.type = 'button';
          navBtn.className = `zc-nav-item${rightPaneMode === 'detail' && key === selectedProviderKey ? ' active' : ''}`;
          const badgeEl = element('span', 'zc-badge', badge.text);
          badgeEl.style.background = badge.color;
          const nameEl = element('span', 'zc-nav-name', label);
          const enabledCount = gModels.filter((m) => m.enabled !== false).length;
          if (enabledCount === 0) nameEl.style.opacity = '0.55';
          const countEl = element('span', 'zc-nav-count', String(enabledCount));
          navBtn.append(badgeEl, nameEl, countEl);
          navBtn.addEventListener('click', () => {
            selectedProviderKey = key;
            rightPaneMode = 'detail';
            apiKeyVisible = false;
            void renderCustomModelsList();
          });
          navGroup.append(navBtn);
        }
        sidebar.append(navGroup);
      };

      appendSidebarGroup('Custom Providers', customNavItems);
      appendSidebarGroup('Preset Providers', presetNavItems);
      if (!groupEntries.length) {
        sidebar.append(element('div', 'agy-muted', 'No providers yet.'));
      }

      const detail = element('div', 'zc-detail');

      if (rightPaneMode === 'template-picker') {
        const backRow = element('div', 'zc-detail-head');
        const backLeft = element('div', 'zc-detail-title');
        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'zc-icon-btn';
        backBtn.title = 'Back to provider details';
        backBtn.append(makeSvgIcon('<path d="m15 18-6-6 6-6"/>', 16), element('span', 'agy-sr-only', 'Back'));
        backBtn.addEventListener('click', () => {
          rightPaneMode = 'detail';
          void renderCustomModelsList();
        });
        backLeft.append(backBtn, element('h3', '', 'Add provider'));
        backRow.append(backLeft);
        detail.append(backRow);

        const tplGrid = element('div', 'zc-tpl-grid');
        const customCard = document.createElement('button');
        customCard.type = 'button';
        customCard.className = 'zc-tpl-card';
        const plusBadge = element('span', 'zc-badge zc-badge-xl');
        plusBadge.style.cssText = 'background:rgba(255,255,255,.08);color:#f4f4f5';
        plusBadge.append(makeSvgIcon('<path d="M5 12h14"/><path d="M12 5v14"/>', 16));
        const customLabel = element('span', 'zc-nav-name', 'Create custom provider');
        customCard.append(plusBadge, customLabel, makeSvgIcon('<path d="m9 18 6-6-6-6"/>', 15));
        customCard.addEventListener('click', () => {
          rightPaneMode = 'detail';
          void openModelModal(undefined, 'edit', { provider: 'custom' });
        });
        tplGrid.append(customCard);

        for (const preset of presets) {
          if (preset.id === 'custom') continue;
          const card = document.createElement('button');
          card.type = 'button';
          card.className = 'zc-tpl-card';
          const badge = providerBadgeMeta(preset.label || preset.id);
          const badgeEl = element('span', 'zc-badge zc-badge-xl', badge.text);
          badgeEl.style.background = badge.color;
          card.append(badgeEl, element('span', 'zc-nav-name', preset.label || preset.id), makeSvgIcon('<path d="m9 18 6-6-6-6"/>', 15));
          card.addEventListener('click', () => {
            rightPaneMode = 'detail';
            void openModelModal(undefined, 'edit', {
              provider: preset.id,
              apiUrl: preset.defaultUrl,
              apiFormat: preset.apiFormat,
            });
          });
          tplGrid.append(card);
        }
        detail.append(tplGrid);
      } else {
        const modelsInGroup = groups.get(selectedProviderKey) || groupEntries[0][1];
        const first = modelsInGroup[0];
        const groupDisplayName = (first.providerName || '').trim() || first.provider;
        const groupKey = `${groupDisplayName}\n${first.apiUrl}`;
        const fullGroupModels = allModelsByGroupKey.get(groupKey) || modelsInGroup;
        const groupStatus = statusNode();

        // ZCode Provider Header (o8n)
        const head = element('div', 'zc-detail-head');
        const headLeft = element('div', 'zc-detail-title');
        const badge = providerBadgeMeta(groupDisplayName);
        const badgeEl = element('span', 'zc-badge zc-badge-lg', badge.text);
        badgeEl.style.background = badge.color;
        const headingText = `${groupDisplayName}${first.providerName && first.providerName !== first.provider ? ` (${first.provider})` : ''}`;
        const enabledInGroup = modelsInGroup.filter((m) => m.enabled !== false).length;
        headLeft.append(
          badgeEl,
          element('h3', '', headingText),
          element('span', 'zc-ctx-badge', `${enabledInGroup}/${modelsInGroup.length} on`),
        );

        const headActions = element('div', 'zc-detail-head-actions');
        if (first.provider === 'custom') {
          const renameBtn = button(
            'Rename provider',
            () => {
              const { body, status, close } = openModal('Rename provider group');
              const nameInput = field(body, 'Provider name', 'agy-rename-provider', first.providerName || '');
              nameInput.placeholder = `e.g. Agnes AI, Coarena (blank resets to ${first.provider})`;
              const modalActions = element('div', 'agy-actions');
              modalActions.append(
                button(
                  'Save',
                  async () => {
                    const nextName = nameInput.value.trim() || undefined;
                    for (const model of fullGroupModels) {
                      requireSuccess(await storageAPI.saveCustomModel({ ...model, providerName: nextName }));
                    }
                    selectedProviderKey = `${nextName || first.provider}\n${first.apiUrl}`;
                    await modelsChanged();
                    showProviderToast(`${nextName || first.provider} saved`, 'success');
                    close();
                  },
                  status,
                  true,
                ),
                button('Cancel', close),
              );
              body.append(modalActions);
            },
            groupStatus,
          );
          headActions.append(renameBtn);
        }

        const allEnabled = fullGroupModels.every((model) => model.enabled !== false);
        const groupToggle = button(
          allEnabled ? 'Disable group' : 'Enable group',
          async () => {
            groupToggle.setAttribute('aria-checked', String(!allEnabled));
            showProviderToast(`Saving ${groupDisplayName}…`, 'pending', 0);
            for (const model of fullGroupModels) {
              requireSuccess(await storageAPI.saveCustomModel({ ...model, enabled: !allEnabled }));
            }
            await modelsChanged();
            showProviderToast(`${groupDisplayName} ${allEnabled ? 'disabled' : 'enabled'}`, 'success');
          },
          groupStatus,
        );
        groupToggle.classList.add('agy-switch');
        groupToggle.setAttribute('role', 'switch');
        groupToggle.setAttribute('aria-checked', String(allEnabled));
        groupToggle.title = allEnabled ? 'Disable group' : 'Enable group';
        groupToggle.replaceChildren(
          element('span', 'agy-sr-only', allEnabled ? 'Disable group' : 'Enable group'),
          element('span', 'agy-switch-dot'),
        );
        headActions.append(groupToggle);
        head.append(headLeft, headActions);
        detail.append(head, groupStatus);

        // ZCode Connection Fields (s8n + c8n): Base URL, API format, API Key
        const connFields = element('div', 'zc-conn-fields');

        const urlRow = element('div', 'zc-field-row');
        urlRow.append(element('label', 'zc-field-label', 'Base URL'));
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'zc-input zc-mono';
        urlInput.value = first.apiUrl || '';
        urlInput.placeholder = 'https://api.example.com/v1';
        const saveGroupUrl = async () => {
          const nextUrl = urlInput.value.trim();
          if (!nextUrl || nextUrl === first.apiUrl) return;
          try {
            validUrl(nextUrl);
            showProviderToast(`Saving ${groupDisplayName}…`, 'pending', 0);
            for (const m of fullGroupModels) {
              requireSuccess(await storageAPI.saveCustomModel({ ...m, apiUrl: nextUrl }));
            }
            selectedProviderKey = `${groupDisplayName}\n${nextUrl}`;
            await modelsChanged();
            showProviderToast(`${groupDisplayName} saved`, 'success');
          } catch (err) {
            showProviderToast(err instanceof Error ? err.message : 'Invalid Base URL', 'failure', 6000);
          }
        };
        urlInput.addEventListener('blur', () => void saveGroupUrl());
        urlInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') urlInput.blur();
        });
        urlRow.append(urlInput);

        const formatRow = element('div', 'zc-field-row');
        formatRow.append(element('label', 'zc-field-label', 'API format'));
        const formatSelect = document.createElement('select');
        formatSelect.className = 'zc-input';
        const formatOptions: Array<[string, string]> = [
          ['openai', 'Chat Completions (/chat/completions)'],
          ['anthropic', 'Anthropic Messages (/v1/messages)'],
          ['openai-responses', 'Responses (/responses)'],
          ['google', 'Google Gemini'],
        ];
        const currentFormat = first.apiFormat || 'openai';
        for (const [val, label] of formatOptions) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          if (val === currentFormat) opt.selected = true;
          formatSelect.append(opt);
        }
        formatSelect.addEventListener('change', async () => {
          const nextFormat = formatSelect.value;
          try {
            showProviderToast(`Saving ${groupDisplayName}…`, 'pending', 0);
            for (const m of fullGroupModels) {
              requireSuccess(await storageAPI.saveCustomModel({ ...m, apiFormat: nextFormat }));
            }
            await modelsChanged();
            showProviderToast(`${groupDisplayName} saved`, 'success');
          } catch (err) {
            showProviderToast(err instanceof Error ? err.message : 'Failed to save API format', 'failure', 6000);
          }
        });
        formatRow.append(formatSelect);

        const keyRow = element('div', 'zc-field-row');
        keyRow.append(element('label', 'zc-field-label', 'API Key'));
        const keyWrap = element('div', 'zc-input-wrap');
        const keyInput = document.createElement('input');
        keyInput.type = apiKeyVisible ? 'text' : 'password';
        keyInput.className = 'zc-input zc-mono';
        keyInput.style.paddingRight = '36px';
        keyInput.value = first.apiKey || '';
        keyInput.placeholder = 'Enter API key';
        const saveGroupKey = async () => {
          const nextKey = keyInput.value;
          if (nextKey === (first.apiKey || '')) return;
          try {
            showProviderToast(`Saving ${groupDisplayName}…`, 'pending', 0);
            for (const m of fullGroupModels) {
              requireSuccess(await storageAPI.saveCustomModel({ ...m, apiKey: nextKey }));
            }
            await modelsChanged();
            showProviderToast(`${groupDisplayName} saved`, 'success');
          } catch (err) {
            showProviderToast(err instanceof Error ? err.message : 'Failed to save API key', 'failure', 6000);
          }
        };
        keyInput.addEventListener('blur', () => void saveGroupKey());
        keyInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') keyInput.blur();
        });
        const eyeBtn = document.createElement('button');
        eyeBtn.type = 'button';
        eyeBtn.className = 'zc-icon-btn zc-eye-btn';
        eyeBtn.title = apiKeyVisible ? 'Hide API key' : 'Show API key';
        eyeBtn.append(
          makeSvgIcon(
            apiKeyVisible
              ? '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>'
              : '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
            14,
          ),
        );
        eyeBtn.addEventListener('click', () => {
          apiKeyVisible = !apiKeyVisible;
          keyInput.type = apiKeyVisible ? 'text' : 'password';
        });
        keyWrap.append(keyInput, eyeBtn);
        keyRow.append(keyWrap);

        connFields.append(urlRow, formatRow, keyRow);
        detail.append(connFields);

        // ZCode Models Section (l8n)
        const modelsSec = element('div');
        const modelsHead = element('div', 'zc-models-head');
        modelsHead.append(element('span', 'zc-field-label', 'Models'));
        const modelsHeadBtns = element('div', 'zc-detail-head-actions');
        modelsHeadBtns.append(
          button('Discover models', () => openModelModal(first, 'discover'), groupStatus),
          button(
            '+ Add model',
            () =>
              openModelModal(undefined, 'edit', {
                provider: first.provider,
                providerName: first.providerName,
                apiUrl: first.apiUrl,
                apiFormat: first.apiFormat,
                apiKey: first.apiKey,
              }),
            groupStatus,
          ),
        );
        modelsHead.append(modelsHeadBtns);
        modelsSec.append(modelsHead);

        const modelsList = element('div', 'zc-model-list');
        const formatEffortLabel = (eff: string): string => {
          const lower = eff.toLowerCase();
          if (lower === 'xhigh') return 'XHigh';
          if (lower === 'medium') return 'Med';
          if (lower === 'minimal') return 'Min';
          return lower.charAt(0).toUpperCase() + lower.slice(1);
        };
        const stripGroupSuffix = (name: string): string => {
          const trimmedGroup = groupDisplayName.trim();
          if (!trimmedGroup) return name;
          const escaped = trimmedGroup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const stripped = name.replace(new RegExp(`\\s*\\(${escaped}\\)\\s*$`, 'i'), '').trim();
          return stripped || name;
        };
        type ParsedVariant = { model: CustomModelEntry; cleanName: string; shortName: string; effort?: string };
        type RowSlot = { key: string; shortName: string; variants: ParsedVariant[] };
        const slots: RowSlot[] = [];
        const effortSlots = new Map<string, RowSlot>();
        for (const model of modelsInGroup) {
          const rawName = model.displayName || model.name;
          const cleanName = rawName.replace(/^⭐\s*/u, '').replace(/^[🟢🔴⚪🟡⭐\s•·|-]+(?:\[[^\]]+\]\s*)?[•·|-]?\s*/u, '').trim();
          const effort = /\((minimal|low|medium|high|xhigh|extra)\)\s*$/i.exec(cleanName)?.[1];
          const withoutEffort = effort ? cleanName.slice(0, cleanName.length - effort.length - 2).trim() : cleanName;
          const shortName = stripGroupSuffix(withoutEffort);
          const parsed: ParsedVariant = { model, cleanName, shortName, effort };
          if (effort) {
            const slotKey = `${shortName.toLowerCase()}\0${(model.externalModelName || '').toLowerCase()}\0${(model.apiUrl || '').toLowerCase()}`;
            const existingSlot = effortSlots.get(slotKey);
            if (existingSlot && !existingSlot.variants.some((v) => v.effort?.toLowerCase() === effort.toLowerCase())) {
              existingSlot.variants.push(parsed);
              continue;
            }
            if (!existingSlot) {
              const created: RowSlot = { key: slotKey, shortName, variants: [parsed] };
              effortSlots.set(slotKey, created);
              slots.push(created);
              continue;
            }
          }
          slots.push({ key: model.name, shortName, variants: [parsed] });
        }

        for (const slot of slots) {
          if (slot.variants.length > 1) {
            slot.variants.sort(
              (a, b) =>
                (EFFORT_ORDER[(a.effort || '').toLowerCase()] ?? 99) -
                (EFFORT_ORDER[(b.effort || '').toLowerCase()] ?? 99),
            );
          }
          const isGrouped = slot.variants.length > 1;
          const pickInitialVariant = (): ParsedVariant => {
            if (!isGrouped) return slot.variants[0];
            const savedName = selectedEffortByKey.get(slot.key);
            return (
              slot.variants.find((v) => v.model.name === savedName) ||
              slot.variants.find((v) => v.effort?.toLowerCase() === 'medium' && v.model.enabled !== false) ||
              slot.variants.find((v) => v.model.enabled !== false) ||
              slot.variants[0]
            );
          };

          const row = element('div', 'agy-row');
          const renderSlotRow = (active: ParsedVariant) => {
            const { model, shortName, effort } = active;
            if (isGrouped) selectedEffortByKey.set(slot.key, model.name);
            const health = healthMap ? healthMap[model.name] : undefined;
            const isRecent = isGrouped
              ? slot.variants.some((v) => Boolean(v.model.isRecent))
              : Boolean(model.isRecent);
            const starPrefix = isRecent && showStatusEmoji ? '⭐ ' : '';
            const statusDot = !showStatusEmoji
              ? ''
              : health?.status === 'slow' || health?.status === 'cooldown'
                ? '🟡 '
                : !health || health.status === 'healthy'
                  ? '🟢 '
                  : '🔴 ';

            const enabledVariantsCount = slot.variants.filter((v) => v.model.enabled !== false).length;
            const allDisabled = enabledVariantsCount === 0;
            row.dataset.modelName = model.name;
            row.dataset.enabled = String(isGrouped ? !allDisabled : model.enabled !== false);

            const info = element('div', 'agy-row-info');
            const titleLine = element('div', 'agy-row-title');
            const titleEl = element('strong', '', `${starPrefix}${statusDot}${shortName}`);
            titleLine.append(titleEl);
            const ctxNum = typeof model.contextWindow === 'number' ? model.contextWindow : undefined;
            const ctxLabel = formatCompactContext(ctxNum);
            if (ctxLabel) {
              const ctxBadge = element('span', 'zc-ctx-badge', ctxLabel);
              ctxBadge.title = `Context window: ${ctxNum?.toLocaleString()} tokens`;
              titleLine.append(ctxBadge);
            }
            if (model.supportsImages) {
              const visionEl = element('span', 'zc-vision-badge');
              visionEl.title = 'Supports image input';
              visionEl.append(makeSvgIcon('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>', 13));
              titleLine.append(visionEl);
            }

            const meta = element('div', 'agy-muted agy-row-meta');
            if (model.externalModelName) meta.append(element('span', 'agy-row-slug', model.externalModelName));
            if (isRecent) {
              if (meta.childNodes.length) meta.append(document.createTextNode(' · '));
              meta.append(document.createTextNode('Recent'));
            }
            if (isGrouped && enabledVariantsCount < slot.variants.length) {
              if (meta.childNodes.length) meta.append(document.createTextNode(' · '));
              meta.append(document.createTextNode(`${enabledVariantsCount}/${slot.variants.length} on`));
            }

            const rowStatus = statusNode();
            info.append(titleLine, meta);
            if (model.nativePickerAvailable === false) {
              info.append(
                element(
                  'div',
                  'agy-muted agy-row-meta',
                  typeof model.nativePickerError === 'string'
                    ? model.nativePickerError
                    : 'Not currently available in the native model picker. Direct API access remains available.',
                ),
              );
            }
            info.append(rowStatus);

            const buildEffortTabs = (): HTMLElement | null => {
              if (!isGrouped) return effort ? element('span', 'agy-effort-chip', formatEffortLabel(effort)) : null;
              const tabs = element('div', 'agy-effort-tabs');
              tabs.setAttribute('role', 'group');
              tabs.setAttribute('aria-label', `Reasoning effort variants for ${shortName}`);
              for (const variant of slot.variants) {
                const effLabel = formatEffortLabel(variant.effort || '');
                const tab = document.createElement('button');
                tab.type = 'button';
                tab.className = 'agy-effort-tab';
                tab.textContent = effLabel;
                const isSelected = variant.model.name === model.name;
                const isVarEnabled = variant.model.enabled !== false;
                tab.setAttribute('aria-pressed', String(isSelected));
                tab.dataset.enabled = String(isVarEnabled);
                tab.dataset.modelName = variant.model.name;
                tab.title = `${shortName} (${variant.effort}) — ${isVarEnabled ? 'Enabled' : 'Disabled'}${isSelected ? ' (selected)' : '. Click to select'}`;
                tab.addEventListener('click', () => {
                  if (variant.model.name !== model.name) renderSlotRow(variant);
                });
                tabs.append(tab);
              }
              return tabs;
            };

            const makeIconAction = (
              label: string,
              svg: string,
              onClick: () => void | Promise<void>,
              danger = false,
            ): HTMLButtonElement => {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = `zc-icon-btn${danger ? ' zc-icon-danger' : ''}`;
              btn.title = label;
              btn.append(makeSvgIcon(svg, 14), element('span', 'agy-sr-only', label));
              btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                  await onClick();
                } catch (err) {
                  const msg = err instanceof Error ? err.message : 'Action failed.';
                  setStatus(rowStatus, msg, true);
                  showProviderToast(msg, 'failure', 6000);
                } finally {
                  btn.disabled = false;
                }
              });
              return btn;
            };

            // Inline ZCode row actions (K6n): Test (plug), Edit (pencil), Delete (trash), Enable/Disable switch, More menu
            const testBtn = makeIconAction(
              'Test',
              '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
              async () => {
                setStatus(rowStatus, 'Testing…');
                showProviderToast(`Connecting to ${groupDisplayName} / ${model.externalModelName || model.name}…`, 'pending', 0);
                const result = requireSuccess(await storageAPI.testModelConnection(model));
                const msg = result.message || 'Connection successful.';
                setStatus(rowStatus, msg);
                showProviderToast(msg, 'success');
              },
            );
            const editBtn = makeIconAction(
              'Edit',
              '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
              () => openModelModal(model, 'edit'),
            );
            const deleteBtn = makeIconAction(
              'Delete',
              '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
              () => openDeleteModelModal(model),
              true,
            );

            const isOn = model.enabled !== false;
            const toggleButton = button(
              isOn ? 'Disable' : 'Enable',
              async () => {
                toggleButton.setAttribute('aria-checked', String(!isOn));
                requireSuccess(await storageAPI.saveCustomModel({ ...model, enabled: !isOn }));
                await modelsChanged();
                showProviderToast(`${groupDisplayName} / ${shortName} saved`, 'success');
              },
              rowStatus,
            );
            toggleButton.classList.add('agy-switch');
            toggleButton.setAttribute('role', 'switch');
            toggleButton.setAttribute('aria-checked', String(isOn));
            toggleButton.replaceChildren(
              element('span', 'agy-sr-only', isOn ? 'Disable' : 'Enable'),
              element('span', 'agy-switch-dot'),
            );
            toggleButton.title = `${isOn ? 'Disable' : 'Enable'}${isGrouped && effort ? ` ${effort.toUpperCase()}` : ''}`;

            const menuList = element('div', 'agy-menu-list');
            menuList.append(
              button(
                'Check',
                async () => {
                  setStatus(rowStatus, 'Checking…');
                  try {
                    const checkRes = await storageAPI.checkModelHealth(model.name);
                    const mHealth = checkRes[model.name];
                    if (mHealth?.status === 'healthy') {
                      setStatus(rowStatus, `🟢 Healthy (${mHealth.latencyMs || 0}ms)`);
                      showProviderToast(`${shortName} healthy (${mHealth.latencyMs || 0}ms)`, 'success');
                    } else {
                      setStatus(rowStatus, `🔴 Unhealthy (${mHealth?.error || 'Failed'})`, true);
                      showProviderToast(`${shortName} unhealthy: ${mHealth?.error || 'Failed'}`, 'failure', 6000);
                    }
                    void renderCustomModelsList();
                  } catch (e: unknown) {
                    setStatus(rowStatus, (e as Error)?.message || 'Check failed', true);
                  }
                },
                rowStatus,
              ),
              button('Test generation', () => openGenerationTest(model), rowStatus),
              button('Duplicate', () => openModelModal(model, 'duplicate'), rowStatus),
              ...(model.supportsThinking === false
                ? []
                : [
                    button(
                      'Effort variants',
                      () => {
                        const { body, status, close } = openModal('Create reasoning variants');
                        body.append(
                          element(
                            'p',
                            'agy-muted',
                            'Creates three copies with low, medium and high reasoning effort. The provider must support reasoning. For Google and Anthropic formats the thinking budgets are 1,024 / 4,096 / 8,192 tokens; output limits increase if needed to fit the budget. Existing models and credentials are preserved.',
                          ),
                        );
                        body.append(
                          button(
                            'Create three variants',
                            async () => {
                              requireSuccess(await ipcRenderer.invoke('storage:create-effort-variants', model.name));
                              close();
                              await modelsChanged();
                              showProviderToast(`Created effort variants for ${shortName}`, 'success');
                            },
                            status,
                            true,
                          ),
                        );
                      },
                      rowStatus,
                    ),
                  ]),
              ...(isGrouped
                ? [
                    button(
                      allDisabled ? 'Enable all efforts' : 'Disable all efforts',
                      async () => {
                        const targetEnabled = allDisabled;
                        for (const variant of slot.variants) {
                          if ((variant.model.enabled !== false) !== targetEnabled) {
                            requireSuccess(await storageAPI.saveCustomModel({ ...variant.model, enabled: targetEnabled }));
                          }
                        }
                        await modelsChanged();
                      },
                      rowStatus,
                    ),
                  ]
                : []),
            );
            const menu = element('details', 'agy-menu');
            const menuSummary = element('summary', 'agy-menu-btn', '⋯');
            menuSummary.title = isGrouped && effort ? `More actions for ${shortName} (${effort})` : 'More actions';
            menuSummary.setAttribute('aria-label', `More actions for ${shortName}${isGrouped && effort ? ` (${effort})` : ''}`);
            menu.append(menuSummary, menuList);
            menu.addEventListener('click', (event) => {
              if ((event.target as HTMLElement).closest('button')) menu.open = false;
            });
            menu.addEventListener('toggle', () => {
              if (!menu.open) return;
              for (const other of target.querySelectorAll<HTMLDetailsElement>('details.agy-menu[open]')) {
                if (other !== menu) other.open = false;
              }
            });

            const actions = element('div', 'agy-row-actions');
            const effortControl = buildEffortTabs();
            actions.append(
              ...(effortControl ? [effortControl] : []),
              testBtn,
              editBtn,
              deleteBtn,
              toggleButton,
              menu,
            );
            row.replaceChildren(info, actions);
          };

          renderSlotRow(pickInitialVariant());
          modelsList.append(row);
        }

        modelsSec.append(modelsList);
        detail.append(modelsSec);
      }

      // Floating bottom toast viewport (G6n)
      const toastVp = element('div', 'zc-toast-viewport');
      toastVp.id = 'zc-toast-viewport';
      if (providerToast) {
        const toast = element('div', 'zc-toast', providerToast.text);
        toast.dataset.type = providerToast.type;
        toastVp.append(toast);
      }
      detail.append(toastVp);

      splitCard.append(sidebar, detail);
      content.append(splitCard);
      target.replaceChildren(content);
      lastRenderedSnapshot = snapshot;
      restoreScroll();
    } catch (error) {
      setStatus(target, error instanceof Error ? error.message : 'Could not load custom models.', true);
    }
  }

  async function openModelModal(
    existing?: CustomModelEntry,
    mode: 'edit' | 'duplicate' | 'discover' = 'edit',
    initialProvider?: {
      provider: string;
      providerName?: string;
      apiUrl?: string;
      apiFormat?: string;
      apiKey?: string;
    },
  ): Promise<void> {
    const { body, status, close } = openModal(
      mode === 'duplicate'
        ? 'Duplicate model'
        : mode === 'discover'
          ? 'Discover provider models'
          : existing
            ? 'Edit model'
            : 'Add custom model',
    );
    try {
      const presets = await storageAPI.getPresets();
      if (!body.isConnected) return;
      const providers = [...presets];
      const seedProvider = existing?.provider || initialProvider?.provider;
      if (seedProvider && !providers.some((preset) => preset.id === seedProvider))
        providers.push({
          id: seedProvider,
          label: seedProvider,
          defaultUrl: existing?.apiUrl || initialProvider?.apiUrl || '',
          apiFormat: existing?.apiFormat || initialProvider?.apiFormat || 'openai',
          keyRequired: false,
        });
      if (!providers.length) throw new Error('Provider presets are unavailable. Close this dialog and try again.');
      // ZCode V6n: Follow recommended config bar + 2-column primary form with Context & Max Output up front
      let followRecommended = !existing || mode !== 'edit';
      const recBar = element('div', 'zc-modal-rec-bar');
      const recLeft = element('div', 'zc-modal-rec-left');
      const recSwitch = document.createElement('button');
      recSwitch.type = 'button';
      recSwitch.className = 'agy-switch';
      recSwitch.setAttribute('role', 'switch');
      recSwitch.setAttribute('aria-checked', String(followRecommended));
      recSwitch.setAttribute('aria-label', 'Follow recommended config');
      recSwitch.append(element('span', 'agy-switch-dot'));
      recLeft.append(element('span', '', 'Follow recommended config'), recSwitch);
      const detectNowBtn = button(
        'Detect properties',
        async () => {
          const id = modelId.value.trim();
          if (!id) throw new Error('Enter a provider model ID first.');
          setStatus(status, 'Detecting model properties…');
          const result = await storageAPI.detectModelCapabilities([id]);
          const detected = result[id];
          if (!detected) {
            setStatus(status, `No catalog match found for "${id}". You can enter limits manually.`, true);
            return;
          }
          if (detected.contextWindow != null) context.value = String(detected.contextWindow);
          if (detected.maxOutputTokens != null) maxOutput.value = String(detected.maxOutputTokens);
          if (detected.supportsVision != null) vision.value = String(detected.supportsVision);
          const parts: string[] = [];
          if (detected.contextWindow != null) parts.push(`${detected.contextWindow.toLocaleString()} ctx`);
          if (detected.maxOutputTokens != null) parts.push(`${detected.maxOutputTokens.toLocaleString()} max out`);
          if (detected.supportsVision) parts.push('vision');
          if (detected.supportsThinking) parts.push('reasoning');
          setStatus(status, `Model defaults loaded: ${parts.join(' · ') || 'matched'}.`);
        },
        status,
      );
      recSwitch.addEventListener('click', () => {
        followRecommended = !followRecommended;
        recSwitch.setAttribute('aria-checked', String(followRecommended));
      });
      recBar.append(recLeft, detectNowBtn);
      body.append(recBar);

      const providerRow = element('div', 'agy-grid');
      const provider = selectField(
        providerRow,
        'Provider',
        'agy-provider',
        providers.map((preset) => [preset.id, preset.label]),
        seedProvider || providers[0].id,
      );
      const providerNameInput = field(
        providerRow,
        'Provider name (optional, for grouping)',
        'agy-provider-name',
        existing?.providerName || initialProvider?.providerName || '',
      );
      providerNameInput.placeholder = 'e.g. Agnes AI, Coarena';
      body.append(providerRow);
      const updateProviderNameVisibility = () => {
        const label = providerNameInput.closest('label');
        if (label) label.hidden = provider.value !== 'custom';
      };
      updateProviderNameVisibility();
      const preset = () => providers.find((value) => value.id === provider.value) || providers[0];
      const endpointRow = element('div', 'agy-grid');
      const apiUrl = field(endpointRow, 'API URL', 'agy-api-url', existing?.apiUrl || initialProvider?.apiUrl || preset().defaultUrl, 'url');
      const apiFormat = selectField(
        endpointRow,
        'API format',
        'agy-api-format',
        [
          ['openai', 'OpenAI compatible'],
          ['anthropic', 'Anthropic Messages'],
          ['google', 'Google Gemini'],
        ],
        existing?.apiFormat || initialProvider?.apiFormat || preset().apiFormat,
      );
      body.append(endpointRow);
      const workersHint = element(
        'p',
        'agy-muted',
        'Cloudflare: replace ACCOUNT_ID in the API URL with your 32-character Account ID. Use the Workers AI API token template, or keep your existing authentication headers. Model discovery verifies catalog access; generation is not tested.',
      );
      body.append(workersHint);
      function workersConnection(): boolean {
        if (provider.value === 'workers-ai') return true;
        try {
          const url = new URL(apiUrl.value);
          return url.origin === 'https://api.cloudflare.com' && /^\/client\/v4\/accounts\//.test(url.pathname);
        } catch {
          return false;
        }
      }
      const updateWorkersHint = () => {
        workersHint.hidden = !workersConnection();
      };
      apiUrl.addEventListener('input', updateWorkersHint);
      updateWorkersHint();
      const apiKey = field(
        body,
        'API key',
        'agy-api-key',
        existing?.apiKey === 'none' ? '' : existing?.apiKey || initialProvider?.apiKey || '',
        'password',
      );
      apiKey.placeholder = preset().keyRequired ? 'Enter provider API key' : 'Optional for local servers';
      const opencodeAuth = selectField(body, 'OpenCode authentication', 'agy-opencode-auth',
        [['auth', 'API key'], ['noAuth', 'Keyless request']], existing?.apiKey && existing.apiKey !== 'none' ? 'auth' : 'noAuth');
      const opencodeHint = element('p', 'agy-muted', 'OpenCode may restrict keyless free models to its own app. If the service rejects this client, add an API key or choose another model/provider.');
      body.append(opencodeHint);
      const isOpencode = () => ['opencode', 'zen'].includes(provider.value) || (() => {
        try { const url = new URL(apiUrl.value); return url.origin === 'https://opencode.ai' && !/\/(?:zen|inference)\/go\//.test(url.pathname); } catch { return false; }
      })();
      const keylessOpencode = () => isOpencode() && opencodeAuth.value === 'noAuth';
      const updateOpencodeAuth = () => {
        opencodeAuth.closest('label')!.hidden = !isOpencode();
        opencodeHint.hidden = !isOpencode();
        apiKey.closest('label')!.hidden = provider.value === 'google-cloudcode' || keylessOpencode();
      };
      opencodeAuth.addEventListener('change', updateOpencodeAuth);
      apiUrl.addEventListener('input', updateOpencodeAuth);
      updateOpencodeAuth();
      const grid = element('div', 'agy-grid');
      const modelId = field(
        grid,
        'Provider model ID',
        'agy-model-id',
        mode === 'discover' ? '' : existing?.externalModelName || '',
      );
      modelId.style.fontFamily = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
      const cleanExistingDisplayName = (existing?.displayName || '')
        .replace(/^[🟢🔴⚪🟡⭐\s•·|-]+(?:\[[^\]]+\]\s*)?[•·|-]?\s*/u, '')
        .trim();
      const displayName = field(
        grid,
        'Display name',
        'agy-display-name',
        mode === 'duplicate'
          ? `${cleanExistingDisplayName || existing?.externalModelName || ''} copy`
          : mode === 'discover'
            ? ''
            : cleanExistingDisplayName,
      );
      body.append(grid);
      const tokensRow = element('div', 'agy-grid');
      const context = field(
        tokensRow,
        'Context window (tokens)',
        'agy-context-window',
        existing?.contextWindow != null ? String(existing.contextWindow) : '',
        'number',
      );
      context.placeholder = 'e.g. 128000';
      const maxOutput = field(
        tokensRow,
        'Maximum output tokens',
        'agy-max-output',
        existing?.maxOutputTokens != null ? String(existing.maxOutputTokens) : '',
        'number',
      );
      maxOutput.placeholder = 'e.g. 16384';
      body.append(tokensRow);
      modelId.addEventListener('blur', async () => {
        if (!followRecommended) return;
        const id = modelId.value.trim();
        if (!id || (context.value.trim() && maxOutput.value.trim())) return;
        try {
          const detectedMap = await storageAPI.detectModelCapabilities([id]);
          const detected = detectedMap[id];
          if (!detected) return;
          if (!context.value.trim() && detected.contextWindow != null) context.value = String(detected.contextWindow);
          if (!maxOutput.value.trim() && detected.maxOutputTokens != null) maxOutput.value = String(detected.maxOutputTokens);
          if (!vision.value && detected.supportsVision != null) vision.value = String(detected.supportsVision);
          setStatus(status, 'Model defaults loaded.');
        } catch {}
      });
      const name = field(
        body,
        'Configuration name (unique)',
        'agy-model-name',
        mode === 'duplicate' ? uniqueName(`${existing?.name}-copy`) : mode === 'discover' ? '' : existing?.name || '',
      );
      name.placeholder = 'Generated from provider and model ID when left blank';
      const description = field(body, 'Description', 'agy-description', String(existing?.description || ''));
      const googleConfig = element('div');
      googleConfig.id = 'agy-google-account-config';
      const googleProject = field(
        googleConfig,
        'Default Cloud Code project (optional)',
        'agy-google-project',
        String(existing?.googleProject || ''),
      );
      const initialPool = existing?.googlePool as
        | { strategy?: string; maxConcurrency?: number; cooldownMs?: number; preferredAccountId?: string; nativeFailoverEnabled?: boolean }
        | undefined;
      const poolGrid = element('div', 'agy-grid');
      const poolStrategy = selectField(
        poolGrid,
        'Account selection',
        'agy-google-pool-strategy',
        [
          ['round-robin', 'Round robin'],
          ['least-loaded', 'Least loaded'],
          ['quota', 'Remaining quota'],
          ['adaptive', 'Adaptive health and load'],
        ],
        initialPool?.strategy || 'least-loaded',
      );
      const poolConcurrency = field(
        poolGrid,
        'Maximum requests per account',
        'agy-google-pool-concurrency',
        String(initialPool?.maxConcurrency || 2),
        'number',
      );
      const poolCooldown = field(
        poolGrid,
        'Account cooldown (milliseconds)',
        'agy-google-pool-cooldown',
        String(initialPool?.cooldownMs || 60000),
        'number',
      );
      const nativeFailover = selectField(poolGrid, 'Native Google request fallback', 'agy-google-native-failover',
        [['false', 'Off'], ['true', 'Use this pool for matching native models']], String(initialPool?.nativeFailoverEnabled === true));
      googleConfig.append(poolGrid);
      googleConfig.append(element('p', 'agy-muted', 'Optional fallback uses this saved Google account pool only when a native request for the exact provider model fails. It does not change your signed-in IDE account.'));
      const readAccounts = createGoogleAccountPanel(
        googleConfig,
        Array.isArray(existing?.googleAccounts) ? (existing.googleAccounts as GoogleAccountEntry[]) : [],
        existing?.name,
      );
      const updateGoogleVisibility = () => {
        const isGoogle = provider.value === 'google-cloudcode';
        googleConfig.hidden = !isGoogle;
        updateOpencodeAuth();
        apiFormat.closest('label')!.hidden = isGoogle;
      };
      updateGoogleVisibility();
      body.append(googleConfig);
      const advanced = element('details');
      advanced.append(element('summary', '', 'Advanced settings'));
      const advancedGrid = element('div', 'agy-grid');
      const effort = selectField(
        advancedGrid,
        'Reasoning effort',
        'agy-reasoning-effort',
        ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => [
          value,
          value || 'Provider default',
        ]),
        String(existing?.reasoningEffort || ''),
      );
      const thinking = field(
        advancedGrid,
        'Thinking budget (tokens)',
        'agy-thinking-budget',
        existing?.thinkingBudget != null ? String(existing.thinkingBudget) : '',
        'number',
      );
      const compactionEffort = selectField(
        advancedGrid,
        'Compaction reasoning effort',
        'agy-compaction-effort',
        ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => [
          value,
          value || 'Use normal model settings',
        ]),
        String(existing?.compactionReasoningEffort || ''),
      );
      advancedGrid.append(
        element(
          'p',
          'agy-muted',
          'Only recognized IDE continuation summaries use this effort. Choose low for faster summaries, or none if your model supports disabling reasoning. Normal chat keeps its settings.',
        ),
      );
      const compactionThreshold = field(
        advancedGrid,
        'IDE compaction threshold (%)',
        'agy-compaction-threshold',
        existing?.compactionThresholdPercent != null ? String(existing.compactionThresholdPercent) : '',
        'number',
      );
      compactionThreshold.min = '10';
      compactionThreshold.max = '90';
      compactionThreshold.placeholder = '80';
      advancedGrid.append(element('p', 'agy-muted',
        'Optional, 10–90% of the actual context window in new tokens since the previous checkpoint. Leave blank to use 80% of a context window you set above; without a context window the IDE keeps its own 50,000-token default. Native counts may differ from provider totals, and a high value can trim older history before a full checkpoint. The threshold is capped to reserve the model output limit plus 1,024 tokens. Set accurate context and output limits, then fully quit and reopen the IDE; the model cache may take an additional turn to refresh.',
      ));
      advancedGrid.append(element('p', 'agy-muted',
        'IDE 2.5.5 needs at least 50,000 input tokens after those reserves. Its native picker may show a compatibility context, for example 90,000 for a real 85,000-token model. Your saved context and provider limit remain 85,000 in that example, and the custom checkpoint policy uses that real limit.',
      ));
      const timeout = field(
        advancedGrid,
        'Request timeout (milliseconds)',
        'agy-timeout',
        existing?.timeout != null ? String(existing.timeout) : '',
        'number',
      );
      const retries = field(
        advancedGrid,
        'Maximum retries (0–5)',
        'agy-max-retries',
        existing?.maxRetries != null ? String(existing.maxRetries) : '',
        'number',
      );
      retries.max = '5';
      const vision = selectField(
        advancedGrid,
        'Image input',
        'agy-vision',
        [
          ['', 'Auto detect'],
          ['true', 'Supported'],
          ['false', 'Unsupported'],
        ],
        existing?.supportsVision == null ? '' : String(existing.supportsVision),
      );
      const rawUrl = selectField(
        advancedGrid,
        'Endpoint path',
        'agy-raw-url',
        [
          ['false', 'Normalize for provider'],
          ['true', 'Use exactly as entered'],
        ],
        String(existing?.rawUrl === true),
      );
      const tls = selectField(
        advancedGrid,
        'TLS certificates',
        'agy-tls',
        [
          ['false', 'Verify certificates'],
          ['true', 'Allow self-signed certificates'],
        ],
        String(existing?.allowUnauthorized === true),
      );
      const enabled = selectField(
        advancedGrid,
        'Model state',
        'agy-enabled',
        [
          ['true', 'Enabled'],
          ['false', 'Disabled'],
        ],
        String(existing?.enabled !== false),
      );
      advanced.append(advancedGrid);
      const fallbacks = field(
        advanced,
        'Fallback model configuration names (comma separated)',
        'agy-fallback-models',
        Array.isArray(existing?.fallbackModels) ? existing.fallbackModels.join(', ') : '',
      );
      const headers = jsonField(advanced, 'Custom headers (JSON)', 'agy-custom-headers', existing?.customHeaders);
      const extraBody = jsonField(advanced, 'Additional request fields (JSON)', 'agy-extra-body', existing?.extraBody);
      const systemPrompt = textAreaField(
        advanced,
        'System prompt (added after Antigravity’s own instructions)',
        'agy-system-prompt',
        existing?.systemPrompt,
        'For example: Always answer in Turkish.',
      );
      const breaker = existing?.circuitBreaker as
        | { enabled?: boolean; failureThreshold?: number; cooldownMs?: number }
        | undefined;
      const breakerGrid = element('div', 'agy-grid');
      const breakerEnabled = selectField(
        breakerGrid,
        'Circuit breaker',
        'agy-breaker-enabled',
        [
          ['', 'Default'],
          ['true', 'Enabled'],
          ['false', 'Disabled'],
        ],
        breaker?.enabled == null ? '' : String(breaker.enabled),
      );
      const breakerThreshold = field(
        breakerGrid,
        'Failures before cooldown',
        'agy-breaker-threshold',
        breaker?.failureThreshold != null ? String(breaker.failureThreshold) : '',
        'number',
      );
      const breakerCooldown = field(
        breakerGrid,
        'Cooldown (milliseconds)',
        'agy-breaker-cooldown',
        breaker?.cooldownMs != null ? String(breaker.cooldownMs) : '',
        'number',
      );
      advanced.append(breakerGrid);
      body.append(advanced);
      const discovery = element('div', 'agy-discovery');
      const discoveryFilter = element('div');
      discoveryFilter.hidden = true;
      const discoverySearch = field(discoveryFilter, 'Search provider models', 'agy-discovery-search', '', 'search');
      discoverySearch.placeholder = 'Filter by model name or ID';
      discoverySearch.addEventListener('input', () => showChoices());
      let choices: ModelChoice[] = [];
      const selected = new Set<string>();
      function hasWorkersAuthentication(customHeaders?: Record<string, unknown>): boolean {
        const authentication = Object.fromEntries(
          Object.entries(customHeaders || {}).map(([key, value]) => [
            key.toLowerCase(),
            typeof value === 'string' ? value.trim() : '',
          ]),
        );
        return !!(
          (apiKey.value.trim() && apiKey.value.trim() !== 'none') ||
          authentication.authorization ||
          (authentication['x-auth-key'] && authentication['x-auth-email'])
        );
      }
      function connection(): Partial<CustomModelEntry> {
        const endpoint = validUrl(apiUrl.value);
        const customHeaders = readJson(headers, 'Custom headers');
        if (workersConnection()) {
          if (
            !/^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1(?:\/chat\/completions)?\/?$/i.test(
              new URL(endpoint).pathname,
            )
          )
            throw new Error('Replace ACCOUNT_ID in the Cloudflare API URL with your 32-character Account ID.');
          if (apiFormat.value !== 'openai')
            throw new Error('Cloudflare Workers AI requires the OpenAI compatible API format.');
          if (!hasWorkersAuthentication(customHeaders))
            throw new Error('Enter a Cloudflare Workers AI API token or authentication headers.');
        }
        return {
          provider: provider.value,
          apiUrl: endpoint,
          apiKey: keylessOpencode() ? 'none' : apiKey.value.trim() || 'none',
          apiFormat: apiFormat.value,
          name: existing?.name,
          allowUnauthorized: tls.value === 'true',
          externalModelName: modelId.value.trim(),
          customHeaders,
          rawUrl: rawUrl.value === 'true',
          ...(provider.value === 'google-cloudcode'
            ? {
                googleAccounts: readAccounts(),
                googleProject: googleProject.value.trim(),
                googlePool: {
                  ...initialPool,
                  preferredAccountId: readAccounts().some((account) => account.id === initialPool?.preferredAccountId) ? initialPool?.preferredAccountId : undefined,
                  strategy: poolStrategy.value,
                  nativeFailoverEnabled: nativeFailover.value === 'true',
                  maxConcurrency: readNumber(poolConcurrency, 'Account concurrency', 1),
                  cooldownMs: readNumber(poolCooldown, 'Account cooldown', 1),
                },
              }
            : {}),
        };
      }
      function modelConfig(id: string, title: string, localName?: string): CustomModelEntry {
        if (!id.trim() || /\s/.test(id.trim())) throw new Error('Enter a model ID without spaces.');
        if (preset().keyRequired && !keylessOpencode() && !apiKey.value.trim() && !workersConnection())
          throw new Error('Enter an API key for this provider.');
        if (provider.value === 'google-cloudcode' && !readAccounts().some((account) => account.enabled !== false))
          throw new Error('Add and enable at least one Google account.');
        const maxRetries = readNumber(retries, 'Maximum retries');
        if (maxRetries != null && maxRetries > 5) throw new Error('Maximum retries cannot exceed 5.');
        const compactionThresholdPercent = readNumber(compactionThreshold, 'IDE compaction threshold', 10);
        if (compactionThresholdPercent != null && compactionThresholdPercent > 90)
          throw new Error('IDE compaction threshold cannot exceed 90%.');
        if (compactionThresholdPercent != null && !context.value.trim())
          throw new Error('Set the actual context window before configuring the IDE compaction threshold.');
        const customHeaders = readJson(headers, 'Custom headers');
        if (customHeaders && Object.values(customHeaders).some((value) => typeof value !== 'string'))
          throw new Error('Custom header values must be strings.');
        return {
          ...(mode === 'edit' && existing ? existing : {}),
          ...connection(),
          name: localName || name.value.trim() || uniqueName(`models/${provider.value}/${id}`),
          provider: provider.value,
          providerName: provider.value === 'custom' ? providerNameInput.value.trim() || undefined : undefined,
          apiUrl: apiUrl.value.trim(),
          apiKey: keylessOpencode() ? 'none' : apiKey.value.trim() || 'none',
          externalModelName: id.trim(),
          displayName:
            (title || id.trim())
              .replace(/^[🟢🔴⚪🟡⭐\s•·|-]+(?:\[[^\]]+\]\s*)?[•·|-]?\s*/u, '')
              .trim() || id.trim(),
          description: description.value.trim(),
          enabled: enabled.value === 'true',
          apiFormat: apiFormat.value,
          googleAccounts: provider.value === 'google-cloudcode' ? readAccounts() : undefined,
          googleProject: provider.value === 'google-cloudcode' ? googleProject.value.trim() || undefined : undefined,
          googlePool:
            provider.value === 'google-cloudcode'
              ? {
                  ...initialPool,
                  preferredAccountId: readAccounts().some((account) => account.id === initialPool?.preferredAccountId) ? initialPool?.preferredAccountId : undefined,
                  strategy: poolStrategy.value,
                  nativeFailoverEnabled: nativeFailover.value === 'true',
                  maxConcurrency: readNumber(poolConcurrency, 'Account concurrency', 1),
                  cooldownMs: readNumber(poolCooldown, 'Account cooldown', 1),
                }
              : undefined,
          reasoningEffort: effort.value || undefined,
          compactionReasoningEffort: compactionEffort.value || undefined,
          compactionThresholdPercent,
          thinkingBudget: readNumber(thinking, 'Thinking budget'),
          maxOutputTokens: readNumber(maxOutput, 'Maximum output tokens', 1),
          contextWindow: readNumber(context, 'Context window', 1),
          timeout: readNumber(timeout, 'Timeout', 1),
          maxRetries,
          fallbackModels: fallbacks.value
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          customHeaders,
          extraBody: readJson(extraBody, 'Additional request fields'),
          systemPrompt: systemPrompt.value.trim() || undefined,
          supportsVision: vision.value === '' ? undefined : vision.value === 'true',
          rawUrl: rawUrl.value === 'true',
          allowUnauthorized: tls.value === 'true',
          circuitBreaker:
            breakerEnabled.value || breakerThreshold.value || breakerCooldown.value
              ? {
                  enabled: breakerEnabled.value !== 'false',
                  failureThreshold: readNumber(breakerThreshold, 'Failure threshold', 1),
                  cooldownMs: readNumber(breakerCooldown, 'Cooldown', 1),
                }
              : undefined,
          ...(existing?.name && mode === 'edit'
            ? { originalName: existing.name }
            : existing?.name
              ? { copyFrom: existing.name }
              : {}),
        };
      }
      function showChoices(): void {
        discovery.replaceChildren();
        discoveryFilter.hidden = !choices.length;
        if (!choices.length) return;
        const query = discoverySearch.value.trim().toLowerCase();
        const visible = choices.filter((model) =>
          `${model.displayName || ''} ${model.id}`.toLowerCase().includes(query),
        );
        const toolbar = element('div', 'agy-actions');
        const count = element(
          'span',
          'agy-muted',
          `${visible.length} of ${choices.length} models · ${selected.size} selected`,
        );
        toolbar.append(
          count,
          button(
            query ? 'Select filtered' : 'Select all',
            () => {
              for (const model of visible) selected.add(model.id);
              showChoices();
            },
            status,
          ),
          button(
            'Clear selection',
            () => {
              selected.clear();
              showChoices();
            },
            status,
          ),
        );
        discovery.append(toolbar);
        if (!visible.length) discovery.append(element('p', 'agy-muted', 'No provider models match this search.'));
        for (const model of visible) {
          const label = element('label', 'agy-choice');
          const checkbox = element('input');
          checkbox.type = 'checkbox';
          checkbox.checked = selected.has(model.id);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selected.add(model.id);
            else selected.delete(model.id);
            count.textContent = `${visible.length} of ${choices.length} models · ${selected.size} selected`;
          });
          const capHints: string[] = [];
          if (typeof model.contextWindow === 'number') {
            capHints.push(
              model.contextWindow >= 1_000_000
                ? `${(model.contextWindow / 1_000_000).toFixed(model.contextWindow % 1_000_000 === 0 ? 0 : 1)}M ctx`
                : `${Math.round(model.contextWindow / 1000)}K ctx`,
            );
          }
          if (model.supportsVision) capHints.push('Vision');
          if (model.supportsThinking) capHints.push('Thinking');
          const baseText =
            model.displayName && model.displayName !== model.id ? `${model.displayName} · ${model.id}` : model.id;
          label.append(
            checkbox,
            element('span', '', capHints.length ? `${baseText} (${capHints.join(' · ')})` : baseText),
          );
          discovery.append(label);
        }
      }
      const applyDetectedCaps = (
        config: CustomModelEntry,
        detected?: {
          contextWindow?: number;
          maxOutputTokens?: number;
          supportsVision?: boolean;
          supportsThinking?: boolean;
          reasoningEffort?: CustomModelEntry['reasoningEffort'];
        },
      ) => {
        if (!detected) return;
        for (const key of ['contextWindow', 'maxOutputTokens', 'supportsVision', 'supportsThinking', 'reasoningEffort'] as const) {
          if (config[key] === undefined && detected[key] !== undefined) {
            (config as unknown as Record<string, unknown>)[key] = detected[key];
          }
        }
        if (
          typeof config.contextWindow === 'number' &&
          typeof config.maxOutputTokens === 'number' &&
          config.maxOutputTokens >= config.contextWindow &&
          !maxOutput.value.trim()
        ) {
          config.maxOutputTokens = config.contextWindow > 1 ? config.contextWindow - 1 : undefined;
        }
      };
      const actions = element('div', 'zc-modal-footer');
      const actionsLeft = element('div', 'zc-modal-footer-left');
      const actionsRight = element('div', 'zc-modal-footer-right');
      actionsLeft.append(
        button(
          'Test connection',
          async () => {
            setStatus(status, 'Testing…');
            const result = requireSuccess(await storageAPI.testModelConnection(connection()));
            setStatus(status, result.message || 'Connection successful.');
          },
          status,
        ),
        button(
          'Test generation (may incur charges)',
          async () => {
            setStatus(status, 'Sending a short generation test…');
            const result = requireSuccess(await storageAPI.testModelGeneration(connection()));
            setStatus(status, result.message || 'Generation succeeded.');
          },
          status,
        ),
        button(
          'Fetch provider models',
          async () => {
            setStatus(status, 'Fetching models…');
            const result = await storageAPI.discoverModels(connection());
            requireSuccess(result);
            choices = result.models || [];
            discoverySearch.value = '';
            selected.clear();
            showChoices();
            setStatus(
              status,
              choices.length
                ? 'Select models below, then choose Add selected (properties auto-detect on add).'
                : 'This provider returned no models. You can enter a model ID manually.',
            );
          },
          status,
        ),
      );
      actionsRight.append(
        button(
          'Save model',
          async () => {
            const config = modelConfig(modelId.value, displayName.value.trim());
            // Auto-detect missing properties when adding a new model (never overriding explicit fields)
            if (followRecommended && (!existing || mode !== 'edit')) {
              const id = modelId.value.trim();
              if (
                id &&
                (config.contextWindow === undefined ||
                  config.maxOutputTokens === undefined ||
                  config.supportsVision === undefined ||
                  config.supportsThinking === undefined)
              ) {
                const detectedMap = await storageAPI.detectModelCapabilities([id]);
                applyDetectedCaps(config, detectedMap[id]);
              }
            }
            requireSuccess(await storageAPI.saveCustomModel(config));
            await modelsChanged();
            close();
          },
          status,
          true,
        ),
      );
      actions.append(actionsLeft, actionsRight);
      body.append(actions, discoveryFilter, discovery);
      body.append(
        button(
          'Add selected',
          async () => {
            if (!selected.size) throw new Error('Select at least one model from the fetched list.');
            const chosen = choices.filter((model) => selected.has(model.id));
            setStatus(status, `Detecting properties and saving ${chosen.length} models…`);
            const detectedMap = await storageAPI.detectModelCapabilities(chosen.map((c) => c.id));
            let saved = 0;
            for (const choice of chosen) {
              const prior = modelList.find(
                (model) =>
                  model.provider === provider.value &&
                  model.apiUrl === apiUrl.value.trim() &&
                  model.externalModelName === choice.id,
              );
              const config = modelConfig(
                choice.id,
                choice.displayName || choice.id,
                prior?.name || uniqueName(`models/${provider.value}/${choice.id}`),
              );
              // Precedence: explicit form overrides > provider /v1/models metadata > catalog auto-detection
              for (const key of ['contextWindow', 'maxOutputTokens', 'supportsVision', 'supportsThinking'] as const) {
                if (config[key] === undefined && choice[key] !== undefined) config[key] = choice[key];
              }
              applyDetectedCaps(config, detectedMap[choice.id]);
              delete config.originalName;
              if (prior) config.originalName = prior.name;
              else if (existing?.name) config.copyFrom = existing.name;
              requireSuccess(await storageAPI.saveCustomModel(config));
              saved++;
            }
            await modelsChanged();
            setStatus(status, `Saved ${saved} models.`);
          },
          status,
        ),
      );
      provider.addEventListener('change', () => {
        apiUrl.value = preset().defaultUrl;
        apiFormat.value = preset().apiFormat;
        apiKey.value = '';
        apiKey.placeholder = preset().keyRequired ? 'Enter provider API key' : 'Optional for local servers';
        updateWorkersHint();
        updateProviderNameVisibility();
        choices = [];
        selected.clear();
        discoverySearch.value = '';
        showChoices();
        updateGoogleVisibility();
      });
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : 'Could not open model settings.', true);
    }
  }

  async function openImportExport(kind: 'import' | 'export'): Promise<void> {
    const { body, status } = openModal(kind === 'export' ? 'Export models' : 'Import models');
    body.append(
      element(
        'p',
        'agy-muted',
        kind === 'export'
          ? 'Credentials are removed from this export. Add API keys on the destination device.'
          : 'Paste a model configuration as JSON or an exported base64 string. Existing configurations are merged by name.',
      ),
    );
    const input = jsonField(body, 'Configuration', 'agy-config-json', undefined);
    input.rows = 14;
    if (kind === 'export') {
      input.readOnly = true;
      try {
        input.value = JSON.stringify(await ipcRenderer.invoke('storage:export-custom-models'), null, 2);
      } catch (error) {
        setStatus(status, String(error), true);
      }
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Select all',
          () => {
            input.focus();
            input.select();
          },
          status,
        ),
        button(
          'Copy JSON',
          async () => {
            await navigator.clipboard.writeText(input.value);
            setStatus(status, 'Configuration copied.');
          },
          status,
        ),
      );
      body.append(actions);
    } else {
      const file = field(body, 'Or choose a JSON file', 'agy-import-file', '', 'file');
      file.accept = '.json,application/json';
      file.addEventListener('change', async () => {
        try {
          const selected = file.files?.[0];
          if (!selected) return;
          if (selected.size > 2 * 1024 * 1024) throw new Error('Configuration files must be smaller than 2 MB.');
          input.value = await selected.text();
        } catch (error) {
          setStatus(status, String(error), true);
        }
      });
      body.append(
        button(
          'Import configuration',
          async () => {
            if (!input.value.trim()) throw new Error('Paste a configuration or choose a file first.');
            const result = requireSuccess(await ipcRenderer.invoke('storage:import-custom-models', input.value.trim()));
            await modelsChanged();
            setStatus(status, `Imported ${result.count ?? 0} models. Add any missing API keys before use.`);
          },
          status,
          true,
        ),
      );
    }
  }
  async function discoverLocal(): Promise<void> {
    const { body, status } = openModal('Local model servers');
    setStatus(status, 'Checking Ollama, LM Studio and llama.cpp on this computer…');
    try {
      const result = (await ipcRenderer.invoke('storage:discover-local')) as ActionResult & {
        servers?: { provider: string; apiUrl: string; models: ModelChoice[] }[];
      };
      requireSuccess(result);
      if (!body.isConnected) return;
      setStatus(
        status,
        result.servers?.length
          ? 'Choose a server to configure its models.'
          : 'No local model servers were found. Start a server or add its URL manually.',
      );
      for (const server of result.servers || []) {
        const row = element('div', 'agy-row');
        row.append(
          element('span', '', `${server.provider} · ${server.models.length} models`),
          element('div', 'agy-muted', server.apiUrl),
          button(
            'Configure',
            () =>
              openModelModal(
                { name: '', provider: server.provider, apiUrl: server.apiUrl, apiKey: 'none', externalModelName: '' },
                'discover',
              ),
            status,
          ),
        );
        body.append(row);
      }
    } catch (error) {
      setStatus(status, String(error), true);
    }
  }
  function openGenerationTest(model: CustomModelEntry): void {
    const { body, status } = openModal('Test model generation');
    body.append(element('p', '', `Model: ${model.displayName || model.externalModelName || model.name}`));
    body.append(
      element(
        'p',
        'agy-muted',
        'Sends one “Reply with OK.” request with a 1024-token output limit using this model’s saved settings. Your provider may charge for the request. No conversation content is sent.',
      ),
    );
    body.append(
      button(
        'Run generation test',
        async () => {
          setStatus(status, 'Sending a short generation test…');
          const result = requireSuccess(await storageAPI.testModelGeneration(model));
          setStatus(status, result.message || 'Generation succeeded.');
        },
        status,
        true,
      ),
    );
  }

  async function openDiagnostics(): Promise<void> {
    const { body, status } = openModal('Proxy diagnostics');
    body.append(
      element(
        'p',
        'agy-muted',
        'Measured requests from this proxy process only; restarting clears the history. Up to 200 completed requests are retained. Prompts, responses, URLs and credentials are not recorded. Gateway requests have separate history in its dashboard.',
      ),
    );
    const summary = element('div');
    summary.id = 'agy-diagnostics-summary';
    const search = field(body, 'Filter by model or provider', 'agy-diagnostics-search');
    const recent = element('div');
    const list = element('div');
    list.id = 'agy-diagnostics-requests';
    const output = element('textarea');
    output.id = 'agy-diagnostics-export';
    output.readOnly = true;
    output.rows = 8;
    output.hidden = true;
    output.setAttribute('aria-label', 'Exported diagnostic metadata');
    let snapshot: DiagnosticsSnapshot | undefined;
    const token = (value: unknown) => (typeof value === 'number' ? value.toLocaleString() : 'unknown');
    const render = () => {
      if (!snapshot) return;
      const s = snapshot.summary;
      summary.replaceChildren(
        element(
          'p',
          '',
          `${s.requests} completed · ${snapshot.active} active · ${s.succeeded} succeeded · ${s.failed} failed · ${s.cancelled} cancelled`,
        ),
      );
      summary.append(
        element(
          'p',
          'agy-muted',
          s.measuredRequests
            ? `Provider-reported tokens: ${token(s.measuredInputRequests ? s.inputTokens : undefined)} input · ${token(s.measuredOutputRequests ? s.outputTokens : undefined)} output · ${token(s.measuredCachedRequests ? s.cachedTokens : undefined)} cached. Usage received for ${s.measuredRequests} of ${s.requests} requests; totals exclude unknown usage.`
            : 'Token usage: unknown. No provider-reported usage received yet.',
        ),
      );
      recent.replaceChildren();
      if (snapshot.recentModels.length)
        recent.append(element('p', 'agy-muted', `Recently used: ${snapshot.recentModels.join(' · ')}`));
      list.replaceChildren();
      const query = search.value.trim().toLowerCase();
      const rows = snapshot.requests.filter((r) => `${r.model} ${r.provider}`.toLowerCase().includes(query));
      if (!rows.length) list.append(element('p', 'agy-muted', 'No matching requests recorded.'));
      for (const r of rows) {
        const row = element('div', 'agy-row');
        row.append(element('strong', '', `${r.model} · ${r.provider}`));
        row.append(
          element(
            'div',
            'agy-muted',
            `${new Date(r.timestamp).toLocaleTimeString()} · ${r.outcome}${r.status ? ` (HTTP ${r.status})` : ''} · ${r.latencyMs} ms · ${r.kind === 'generation-test' ? 'generation test' : r.stream ? 'streaming' : 'request'}`,
          ),
        );
        row.append(
          element(
            'div',
            'agy-muted',
            `Tokens: ${token(r.inputTokens)} input · ${token(r.outputTokens)} output · ${token(r.cachedTokens)} cached`,
          ),
        );
        list.append(row);
      }
    };
    const refresh = async () => {
      snapshot = await ipcRenderer.invoke('storage:get-diagnostics');
      requireSuccess(snapshot);
      if (body.isConnected) render();
    };
    search.addEventListener('input', render);
    const actions = element('div', 'agy-actions');
    actions.append(
      button('Refresh diagnostics', refresh, status),
      button(
        'Export diagnostics',
        () => {
          output.value = JSON.stringify(snapshot, null, 2);
          output.hidden = false;
          output.focus();
          output.select();
        },
        status,
      ),
      button(
        'Clear diagnostic history',
        async () => {
          requireSuccess(await ipcRenderer.invoke('storage:clear-diagnostics'));
          output.value = '';
          output.hidden = true;
          await refresh();
        },
        status,
      ),
    );
    body.append(summary, recent, actions, output, list);
    await refresh();
  }

  async function openPromptSections(): Promise<void> {
    const { body, status, close } = openModal('System prompt sections');
    try {
      const data = (await ipcRenderer.invoke('storage:get-prompt-sections')) as {
        success: boolean;
        tags: string[];
        defaults: Record<string, string>;
        config: { overrides: Record<string, string>; enabled: Record<string, boolean> };
      };
      if (!body.isConnected) return;
      requireSuccess(data);

      body.append(
        element(
          'p',
          'agy-muted',
          'Customize static sections of Antigravity’s system prompt (<identity>, <guidelines>, etc.). Dynamic sections like active workspaces, tools, and skills are preserved automatically.',
        ),
      );

      const sectionLabels: Record<string, string> = {
        identity: 'Identity (<identity>)',
        guidelines: 'Behavior & Security Guidelines (<guidelines>)',
        communication_style: 'Communication Style (<communication_style>)',
        artifacts: 'Artifacts Instruction (<artifacts>)',
        messaging: 'Messaging & Reactive Wakeup (<messaging>)',
        conversation_transcript: 'Transcript Format (<conversation_transcript>)',
      };

      const textareas = new Map<string, HTMLTextAreaElement>();
      const checkboxes = new Map<string, HTMLInputElement>();

      for (const tag of data.tags) {
        const details = element('details');
        const summary = element('summary');
        const isEnabled = data.config.enabled?.[tag] !== false;
        const currentCustom = data.config.overrides?.[tag] ?? '';
        const defaultText = data.defaults?.[tag] ?? '';

        const titleSpan = element('span', '', sectionLabels[tag] || tag);
        summary.append(titleSpan);
        details.append(summary);

        const enableLabel = element('label', 'agy-fleet-fallback');
        const enableCheck = element('input');
        enableCheck.type = 'checkbox';
        enableCheck.checked = isEnabled;
        checkboxes.set(tag, enableCheck);

        enableLabel.append(enableCheck, element('span', '', 'Include this section'));
        details.append(enableLabel);

        const area = textAreaField(
          details,
          'Content (leave empty to use default)',
          `agy-prompt-section-${tag}`,
          currentCustom,
          defaultText,
        );
        area.rows = 8;
        textareas.set(tag, area);

        const sectionToolbar = element('div', 'agy-actions');
        sectionToolbar.append(
          button('Use default as template', () => {
            area.value = defaultText;
          }),
          button('Clear override', () => {
            area.value = '';
          }),
        );
        details.append(sectionToolbar);

        body.append(details);
      }

      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Save prompt settings',
          async () => {
            const overrides: Record<string, string> = {};
            const enabled: Record<string, boolean> = {};

            for (const tag of data.tags) {
              const val = textareas.get(tag)?.value ?? '';
              if (val.trim()) {
                overrides[tag] = val.trim();
              }
              const en = checkboxes.get(tag)?.checked ?? true;
              if (!en) {
                enabled[tag] = false;
              }
            }

            requireSuccess(
              await ipcRenderer.invoke('storage:save-prompt-sections', {
                overrides,
                enabled,
              }),
            );
            setStatus(status, 'System prompt sections saved successfully.');
          },
          status,
          true,
        ),
        button(
          'Reset all to default',
          async () => {
            requireSuccess(await ipcRenderer.invoke('storage:reset-prompt-sections'));
            for (const tag of data.tags) {
              const area = textareas.get(tag);
              if (area) area.value = '';
              const chk = checkboxes.get(tag);
              if (chk) chk.checked = true;
            }
            setStatus(status, 'All sections reset to defaults.');
          },
          status,
        ),
        button('Close', close),
      );

      body.append(actions);
    } catch (error) {
      if (body.isConnected) setStatus(status, error instanceof Error ? error.message : String(error), true);
    }
  }

  async function openGateway(): Promise<void> {
    const { body, status } = openModal('Remote gateway');
    try {
      const saved = (await ipcRenderer.invoke('storage:get-gateway')) as GatewayConfig;
      if (!body.isConnected) return;
      body.append(
        element(
          'p',
          'agy-muted',
          'Connect to your proxy gateway to import its model aliases and open its management dashboard.',
        ),
      );
      const url = field(body, 'Gateway URL', 'agy-gateway-url', saved?.url || '', 'url');
      const token = field(body, 'Gateway token', 'agy-gateway-token', saved?.token || '', 'password');
      const dashboard = field(body, 'Dashboard URL (optional)', 'agy-dashboard-url', saved?.dashboardUrl || '', 'url');
      const config = (): GatewayConfig => ({
        url: validUrl(url.value),
        token: token.value.trim(),
        dashboardUrl: dashboard.value.trim() ? validUrl(dashboard.value) : '',
      });
      const save = async () => {
        requireSuccess(await ipcRenderer.invoke('storage:save-gateway', config()));
      };
      const actions = element('div', 'agy-actions');
      actions.append(
        button(
          'Save connection',
          async () => {
            await save();
            setStatus(status, 'Gateway connection saved.');
          },
          status,
          true,
        ),
        button(
          'Test gateway',
          async () => {
            setStatus(status, 'Connecting…');
            const result = requireSuccess(await ipcRenderer.invoke('storage:test-gateway', config()));
            setStatus(status, result.message || 'Gateway reachable and authentication accepted.');
          },
          status,
        ),
        button(
          'Import model aliases',
          async () => {
            await save();
            const result = requireSuccess(await ipcRenderer.invoke('storage:import-gateway-models'));
            await modelsChanged();
            setStatus(status, `Imported ${result.count ?? 0} gateway models.`);
          },
          status,
        ),
        button(
          'Open dashboard',
          async () => {
            await save();
            requireSuccess(await ipcRenderer.invoke('storage:open-gateway-dashboard'));
          },
          status,
        ),
      );
      body.append(actions);
    } catch (error) {
      setStatus(status, String(error), true);
    }
  }
  function findSettingsMount(): HTMLElement | null {
    // Desktop settings are a modal over /c/...; older layouts use a settings route.
    // A chat span saying "MCP" is not evidence that the settings page is open.
    const settingsRoot = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"][aria-label="Settings"],.settings-modal-container,[data-testid="settings-view"],[data-testid="settings-panel"]',
      ),
    ).find(isSettingsContent);
    const settingsRoute =
      /^\/settings(?:\/|$)/i.test(window.location.pathname) || /^#\/?settings(?:\/|\?|$)/i.test(window.location.hash);
    const root = settingsRoot || (settingsRoute ? document.body : null);
    if (!root) return null;
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,[role="heading"],div,span'));
    const heading = headings.find(
      (node) =>
        node.children.length === 0 &&
        /^(Models\s*(?:&|and)\s*Usage|Model Settings|MCP Servers|MCP)$/i.test(node.textContent?.trim() || '') &&
        isSettingsContent(node),
    );
    if (heading) {
      const section = heading.closest('section');
      if (section && root.contains(section)) return section;
      const panel = heading.closest('[role="tabpanel"]');
      if (panel && root.contains(panel)) return panel as HTMLElement;
      let content: HTMLElement = heading;
      while (content.parentElement && content.parentElement !== root) {
        if (content.parentElement.classList.contains('overflow-y-auto')) return content;
        content = content.parentElement;
      }
      const fallback = heading.parentElement?.parentElement || heading.parentElement;
      return fallback && root.contains(fallback) ? fallback : root;
    }
    const refresh = findRefreshButton(root);
    const legacy = refresh?.parentElement?.parentElement?.parentElement;
    if (
      legacy &&
      root.contains(legacy) &&
      isSettingsContent(legacy) &&
      /MCP|Model Context Protocol/i.test(legacy.textContent || '')
    )
      return legacy;
    return null;
  }
  function findSettingsSidebarAndPane(): {
    root: HTMLElement;
    modelsBtn: HTMLElement;
    sidebarCol: HTMLElement;
    contentPane: HTMLElement;
  } | null {
    const isVisibleEl = (el: HTMLElement): boolean => {
      for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
        if (cur.hidden || cur.getAttribute('aria-hidden') === 'true') return false;
        const st = window.getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
      }
      return true;
    };
    const settingsRoot =
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-label="Settings"],.settings-modal-container,[data-testid="settings-view"],[data-testid="settings-panel"],[role="dialog"]',
        ),
      ).find((el) => isVisibleEl(el) && /\bModels\b/.test(el.textContent || '') && /\b(General|Appearance|Browser)\b/.test(el.textContent || '')) ||
      null;
    if (!settingsRoot) return null;
    const buttons = Array.from(settingsRoot.querySelectorAll<HTMLElement>('button,[role="tab"]'));
    const modelsBtn = buttons.find(
      (btn) =>
        btn.id !== 'agy-providers-nav-tab' &&
        (btn.textContent || '').trim() === 'Models' &&
        isVisibleEl(btn),
    );
    if (!modelsBtn || !modelsBtn.parentElement) return null;
    // Verify this is the Settings left sidebar (contains sibling nav items like General / Browser / Appearance).
    const siblingTexts = Array.from(modelsBtn.parentElement.querySelectorAll<HTMLElement>('button,[role="tab"]')).map(
      (el) => (el.textContent || '').trim(),
    );
    if (!siblingTexts.some((t) => /^(General|Appearance|Browser|Shortcuts|Notifications)$/i.test(t))) return null;
    // Walk up from modelsBtn to find the 2-column split [sidebarCol, contentPane] inside settingsRoot.
    let node: HTMLElement | null = modelsBtn.parentElement;
    while (node && node.parentElement && node !== settingsRoot) {
      const parent: HTMLElement = node.parentElement;
      const visibleSiblings = Array.from(parent.children).filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child !== node && child.tagName !== 'STYLE' && child.tagName !== 'SCRIPT',
      );
      if (visibleSiblings.length >= 1) {
        const candidatePane = visibleSiblings.find((el) => el.querySelector('h1,h2,h3,button,input,section,[role="tabpanel"]')) || visibleSiblings[0];
        if (candidatePane && settingsRoot.contains(candidatePane)) {
          return { root: settingsRoot, modelsBtn, sidebarCol: node, contentPane: candidatePane };
        }
      }
      node = parent;
    }
    return null;
  }

  function restoreHiddenNativeSettings(contentPane: HTMLElement): void {
    for (const child of Array.from(contentPane.children)) {
      if (child instanceof HTMLElement && child.dataset.agyHiddenByProviders === '1') {
        child.style.display = child.dataset.agyPrevDisplay || '';
        delete child.dataset.agyHiddenByProviders;
        delete child.dataset.agyPrevDisplay;
      }
    }
  }

  function buildCustomModelsSection(fullWidth: boolean): HTMLElement {
    const section = element('section');
    section.id = 'agy-custom-models-section';
    section.setAttribute('aria-label', 'Custom Models');
    if (fullWidth) section.dataset.fullwidth = 'true';

    const status = statusNode();
    status.id = 'agy-main-status';

    const header = element('div', 'agy-toolbar');
    const titleWrap = element('div');
    titleWrap.append(
      element('h2', '', fullWidth ? 'Providers' : 'Models'),
      element('p', 'agy-muted', 'Configure model providers, API endpoints, local servers, and gateways.'),
    );

    const headerBtns = element('div', 'zc-detail-head-actions');
    const toolsMenu = element('details', 'agy-tools-menu');
    const toolsSummary = element('summary', 'agy-tools-btn', 'Tools ▾');
    const toolsList = element('div', 'agy-tools-popover');
    toolsList.append(
      button('Discover local', discoverLocal),
      button('Check health', async () => {
        setStatus(status, 'Checking health of all models…');
        try {
          await storageAPI.checkModelHealth();
          setStatus(status, 'Health check complete.');
          void renderCustomModelsList();
        } catch (e: unknown) {
          setStatus(status, (e as Error)?.message || 'Health check failed', true);
        }
      }),
      button('Import', () => openImportExport('import')),
      button('Export', () => openImportExport('export')),
      button('System Prompt', openPromptSections),
      button('Remote gateway', openGateway),
      button('Diagnostics', openDiagnostics),
      element('div', 'agy-tools-divider'),
    );
    const emojiToggleLabel = element('label', 'agy-toggle-label');
    const emojiToggleCheckbox = document.createElement('input');
    emojiToggleCheckbox.type = 'checkbox';
    emojiToggleCheckbox.id = 'agy-toggle-status-emojis';
    emojiToggleCheckbox.checked = true;
    emojiToggleCheckbox.title = 'Prefix model names with status circle (🟢/🟡/🔴) and star (⭐). Uncheck to display only clean model names.';
    emojiToggleCheckbox.addEventListener('change', async () => {
      const enabled = emojiToggleCheckbox.checked;
      try {
        await storageAPI.saveDisplaySettings({ showStatusEmoji: enabled });
        setStatus(
          status,
          enabled
            ? 'Status emojis enabled for model names.'
            : 'Status emojis disabled. Model names will show without emojis.',
        );
        await modelsChanged();
      } catch {
        setStatus(status, 'Failed to save display setting', true);
      }
    });
    emojiToggleLabel.append(emojiToggleCheckbox, document.createTextNode('Status emojis (🟢)'));
    toolsList.append(emojiToggleLabel);
    toolsMenu.append(toolsSummary, toolsList);
    toolsMenu.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button')) toolsMenu.open = false;
    });

    storageAPI.getDisplaySettings().then((settings) => {
      if (settings && typeof settings.showStatusEmoji === 'boolean') {
        emojiToggleCheckbox.checked = settings.showStatusEmoji;
      }
    }).catch(() => {});

    const addModel = button('Add model', () => openModelModal(), undefined, false);
    addModel.id = 'agy-add-model';
    const addProvider = button(
      '+ Add provider',
      () => {
        rightPaneMode = rightPaneMode === 'template-picker' ? 'detail' : 'template-picker';
        void renderCustomModelsList();
      },
      undefined,
      true,
    );
    headerBtns.append(toolsMenu, addModel, addProvider);
    header.append(titleWrap, headerBtns);

    const bar = element('div', 'agy-sticky-bar');
    bar.setAttribute('role', 'search');
    const search = field(bar, 'Search models', 'agy-model-search', searchTerm, 'search');
    search.placeholder = 'Search name, model ID or provider';
    search.addEventListener('input', () => {
      searchTerm = search.value.trim().toLowerCase();
      void renderCustomModelsList();
    });
    const chips = element('div', 'agy-actions');
    const filters: Array<[ModelFilter, string]> = [
      ['all', 'All'],
      ['enabled', 'Enabled'],
      ['disabled', 'Disabled'],
      ['unhealthy', 'Unhealthy'],
    ];
    const chipButtons = new Map<ModelFilter, HTMLButtonElement>();
    for (const [mode, label] of filters) {
      const chip = element('button', 'agy-chip', label);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(filterMode === mode));
      chip.addEventListener('click', () => {
        filterMode = mode;
        for (const [key, node] of chipButtons) node.setAttribute('aria-pressed', String(key === mode));
        void renderCustomModelsList();
      });
      chipButtons.set(mode, chip);
      chips.append(chip);
    }
    bar.append(chips);

    const content = element('div');
    content.id = 'agy-custom-models-content';
    const fleet = element('div', 'agy-fleet');
    fleet.id = 'agy-google-account-pool-section';
    fleet.setAttribute('aria-label', 'Google account fleet and quotas');
    fleet.hidden = true;

    section.append(header, status, fleet, bar, content);
    return section;
  }

  function injectCustomModelsSection(): void {
    installStyles();
    const sidebarInfo = findSettingsSidebarAndPane();

    // 1. Real Antigravity Settings dialog with left sidebar: inject dedicated full-width "Providers" tab!
    if (sidebarInfo) {
      const { modelsBtn, sidebarCol, contentPane } = sidebarInfo;
      let navTab = document.getElementById('agy-providers-nav-tab') as HTMLButtonElement | null;
      if (!navTab || !sidebarCol.contains(navTab)) {
        navTab?.remove();
        navTab = document.createElement('button');
        navTab.id = 'agy-providers-nav-tab';
        navTab.type = 'button';
        // Copy native nav button layout classes while stripping active background classes.
        const baseClasses = (modelsBtn.className || '')
          .split(/\s+/)
          .filter((c) => c && !/^(bg-|text-foreground|font-medium|font-semibold)/.test(c))
          .join(' ');
        navTab.className = `${baseClasses} agy-providers-nav-tab`.trim();
        navTab.textContent = 'Providers';
        modelsBtn.insertAdjacentElement('afterend', navTab);

        navTab.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          providersTabActive = true;
          navTab!.dataset.active = 'true';
          document.getElementById('agy-providers-banner')?.remove();
          for (const child of Array.from(contentPane.children)) {
            if (child instanceof HTMLElement && child.id !== 'agy-custom-models-section') {
              // Keep floating close (×) button visible if it's a direct button child.
              if (child.tagName === 'BUTTON' && child.children.length <= 1) continue;
              if (child.dataset.agyHiddenByProviders !== '1') {
                child.dataset.agyPrevDisplay = child.style.display || '';
                child.dataset.agyHiddenByProviders = '1';
                child.style.display = 'none';
              }
            }
          }
          let section = document.getElementById('agy-custom-models-section');
          if (!section || section.parentElement !== contentPane) {
            section?.remove();
            section = buildCustomModelsSection(true);
            contentPane.append(section);
          }
          void renderCustomModelsList();
        });

        if (sidebarCol.dataset.agyNavListener !== '1') {
          sidebarCol.dataset.agyNavListener = '1';
          sidebarCol.addEventListener(
            'click',
            (e) => {
              const clicked = (e.target as HTMLElement | null)?.closest('button,[role="tab"]');
              if (!clicked || clicked.id === 'agy-providers-nav-tab') return;
              if (!providersTabActive) return;
              providersTabActive = false;
              const tab = document.getElementById('agy-providers-nav-tab');
              if (tab) delete tab.dataset.active;
              document.getElementById('agy-custom-models-section')?.remove();
              restoreHiddenNativeSettings(contentPane);
            },
            true,
          );
        }
      }

      if (providersTabActive) {
        navTab.dataset.active = 'true';
        for (const child of Array.from(contentPane.children)) {
          if (child instanceof HTMLElement && child.id !== 'agy-custom-models-section') {
            if (child.tagName === 'BUTTON' && child.children.length <= 1) continue;
            if (child.dataset.agyHiddenByProviders !== '1') {
              child.dataset.agyPrevDisplay = child.style.display || '';
              child.dataset.agyHiddenByProviders = '1';
              child.style.display = 'none';
            }
          }
        }
        const existingFull = document.getElementById('agy-custom-models-section');
        if (!existingFull || existingFull.parentElement !== contentPane) {
          existingFull?.remove();
          contentPane.append(buildCustomModelsSection(true));
          void renderCustomModelsList();
        }
        return;
      }

      // When another tab (e.g. Models) is active, show a slim 1-line link banner on the Models tab
      const mount = findSettingsMount();
      document.getElementById('agy-custom-models-section')?.remove();
      const existingBanner = document.getElementById('agy-providers-banner');
      if (!mount) {
        existingBanner?.remove();
        return;
      }
      if (existingBanner && existingBanner.parentElement === mount) return;
      existingBanner?.remove();
      const banner = element('div');
      banner.id = 'agy-providers-banner';
      const left = element('div');
      left.append(
        element('div', '', 'Custom Providers & Models'),
        element('div', 'agy-muted', 'Manage API endpoints, custom models, and local servers in full width.'),
      );
      (left.firstElementChild as HTMLElement).style.fontWeight = '600';
      const openBtn = button('Open Providers →', () => navTab?.click());
      banner.append(left, openBtn);
      mount.append(banner);
      return;
    }

    // 2. Fallback (settings route or JSDOM tests without left Settings sidebar): mount directly inside mount
    providersTabActive = false;
    const mount = findSettingsMount();
    const existing = document.getElementById('agy-custom-models-section');
    if (existing && mount && existing.parentElement === mount) return;
    existing?.remove();
    if (!mount) return;
    const section = buildCustomModelsSection(false);
    mount.append(section);
    if (!rowMenuDismissInstalled) {
      rowMenuDismissInstalled = true;
      const closeOpenRowMenus = (except?: Node | null) => {
        for (const openMenu of document.querySelectorAll<HTMLDetailsElement>('#agy-custom-models-section details.agy-menu[open], #agy-custom-models-section details.agy-tools-menu[open]')) {
          if (!except || !openMenu.contains(except)) openMenu.open = false;
        }
      };
      document.addEventListener('click', (event) => closeOpenRowMenus(event.target as Node | null));
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const active = document.activeElement as HTMLElement | null;
        const activeMenu = active?.closest<HTMLDetailsElement>('#agy-custom-models-section details.agy-menu[open], #agy-custom-models-section details.agy-tools-menu[open]');
        closeOpenRowMenus();
        activeMenu?.querySelector('summary')?.focus({ preventScroll: true });
      });
    }
    void renderCustomModelsList();
  }
  let pickerSearch: { menu: HTMLElement; update: () => void; cleanup: () => void } | undefined;
  function pickerVisible(menu: HTMLElement): boolean {
    if (!menu.isConnected) return false;
    for (let node: HTMLElement | null = menu; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.getAttribute('data-state') === 'closed') return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function checkModelPickerSearch(): void {
    if (document.documentElement?.dataset.agyMitmSelector === '1') {
      if (pickerSearch) {
        pickerSearch.cleanup();
        pickerSearch = undefined;
      }
      return;
    }
    if (pickerSearch) {
      if (pickerVisible(pickerSearch.menu)) { pickerSearch.update(); return; }
      pickerSearch.cleanup();
      pickerSearch = undefined;
    }
    const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]'));
    const menu = menus.find((candidate) => {
      if (!pickerVisible(candidate) || candidate.closest('#agy-modal-overlay, #agy-custom-models-section') ||
          candidate.parentElement?.closest('[role="menu"], [role="listbox"]') ||
          candidate.matches('[data-radix-menu-sub-content], [data-radix-dropdown-menu-sub-content]')) return false;
      const trigger = document.getElementById(candidate.getAttribute('aria-labelledby') || '');
      if (trigger?.closest('[role="menuitem"], [role="menuitemradio"]')) return false;
      const leaves = Array.from(candidate.querySelectorAll<HTMLElement>('*')).filter((node) => !node.children.length);
      const labels = leaves.map((node) => node.textContent?.trim() || '').filter(Boolean);
      return labels.slice(0, 2).includes('Model') && labels.some((label) => /^View\s+Usage$/i.test(label));
    });
    if (!menu) return;
    installStyles();
    const box = element('div', 'agy-model-search-box');
    const wrap = element('div', 'agy-model-search-wrap');
    const searchIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    searchIcon.setAttribute('viewBox', '0 0 16 16');
    searchIcon.setAttribute('fill', 'none');
    searchIcon.setAttribute('aria-hidden', 'true');
    searchIcon.classList.add('agy-model-search-icon');
    searchIcon.innerHTML =
      '<path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10ZM14 14l-3.2-3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
    const input = element('input', 'agy-model-search-input');
    input.type = 'search';
    input.placeholder = 'Search models…';
    input.setAttribute('aria-label', 'Search models');
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'agy-model-search-clear';
    clearBtn.textContent = '✕';
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.hidden = true;
    wrap.append(searchIcon, input, clearBtn);
    box.append(wrap);
    const empty = element('div', 'agy-model-no-results', 'No matching models');
    empty.hidden = true;
    const header = Array.from(menu.querySelectorAll<HTMLElement>('*')).find((node) => !node.children.length && node.textContent?.trim() === 'Model');
    (header || menu).insertAdjacentElement(header ? 'afterend' : 'afterbegin', box);
    box.after(empty);

    const displays = new Map<HTMLElement, { value: string; priority: string }>();
    const injectedNodes: HTMLElement[] = [];
    let sidepanelEl: HTMLElement | null = null;
    let activeProviderRow: HTMLElement | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let bridgedNode: HTMLElement | null = null;
    let bridgedOldStyle = '';

    const stripStatusPrefix = (text: string): string =>
      text
        .replace(/^⭐\s*/u, '')
        .replace(/^[🟢🔴⚪🟡⭐\s•·|-]+(?:\[[^\]]+\]\s*)?[•·|-]?\s*/u, '')
        .replace(/\s+/g, ' ')
        .trim();

    const effortWords = new Set(['low', 'medium', 'high', 'xhigh', 'minimal', 'extra', 'default']);
    const inferProviderGroup = (model: CustomModelEntry): string => {
      const explicit = (model.providerName || '').trim();
      if (explicit) return explicit;
      const clean = stripStatusPrefix(model.displayName || model.name);
      const matches = Array.from(clean.matchAll(/\(([^()]+)\)/g));
      for (let i = matches.length - 1; i >= 0; i--) {
        const candidate = matches[i][1].trim();
        if (candidate && !effortWords.has(candidate.toLowerCase())) {
          return candidate;
        }
      }
      return model.provider || 'custom';
    };

    const isItemSelected = (node: HTMLElement): boolean => {
      if (node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true') return true;
      if (node.dataset.state === 'checked') return true;
      return Boolean(node.querySelector('svg[data-lucide="check"], .lucide-check'));
    };

    const hasEffortSubmenu = (node: HTMLElement): boolean => {
      if (node.getAttribute('aria-haspopup') === 'menu') return true;
      return Boolean(node.querySelector('svg[data-lucide="chevron-right"], .lucide-chevron-right'));
    };

    const viewUsageNode = () =>
      Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="option"], button')).find(
        (node) => !node.closest('.agy-model-search-box, .agy-provider-row') && /^View\s+Usage$/i.test(node.textContent?.trim() || ''),
      );

    const rawItems = () =>
      Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="option"], button')).filter(
        (node) =>
          !node.parentElement?.closest('[role="menuitem"], [role="menuitemradio"], [role="option"]') &&
          !node.closest('.agy-model-search-box, .agy-provider-row') &&
          !/^View\s+Usage/i.test(node.textContent?.trim() || ''),
      );

    const hideNode = (node: HTMLElement) => {
      if (displays.has(node)) return;
      displays.set(node, { value: node.style.getPropertyValue('display'), priority: node.style.getPropertyPriority('display') });
      node.style.setProperty('display', 'none', 'important');
    };

    const restore = (node: HTMLElement) => {
      const old = displays.get(node);
      if (!old) return;
      if (old.value) node.style.setProperty('display', old.value, old.priority);
      else node.style.removeProperty('display');
      displays.delete(node);
    };

    const unbridgeNode = () => {
      if (!bridgedNode) return;
      bridgedNode.setAttribute('style', bridgedOldStyle);
      bridgedNode = null;
      bridgedOldStyle = '';
    };

    const closeSidepanel = () => {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      unbridgeNode();
      if (sidepanelEl) {
        sidepanelEl.remove();
        sidepanelEl = null;
      }
      if (activeProviderRow) {
        activeProviderRow.removeAttribute('data-open');
        activeProviderRow = null;
      }
    };

    const scheduleCloseSidepanel = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        const subOpen = document.querySelector('[data-radix-menu-sub-content]:hover, [data-radix-dropdown-menu-sub-content]:hover');
        if (!subOpen) closeSidepanel();
      }, 160);
    };

    const createChevronSvg = (sampleNode?: HTMLElement): SVGElement => {
      const existingSvg = sampleNode?.querySelector('svg[data-lucide="chevron-right"], .lucide-chevron-right') as SVGElement | null;
      if (existingSvg) return existingSvg.cloneNode(true) as SVGElement;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '14');
      svg.setAttribute('height', '14');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.innerHTML = '<path d="m9 18 6-6-6-6"/>';
      return svg;
    };

    let lastRenderKey = '';

    const openProviderSidepanel = (
      providerRow: HTMLElement,
      providerName: string,
      entries: Array<{ node: HTMLElement; model: CustomModelEntry }>,
      officialSample?: HTMLElement,
    ) => {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      if (activeProviderRow === providerRow && sidepanelEl?.isConnected) return;
      closeSidepanel();
      activeProviderRow = providerRow;
      providerRow.setAttribute('data-open', 'true');

      const panel = element('div', `${menu.className ? menu.className + ' ' : ''}agy-provider-sidepanel`);
      panel.setAttribute('role', 'menu');
      const menuStyle = window.getComputedStyle(menu);
      if (menuStyle.backgroundColor && menuStyle.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        panel.style.backgroundColor = menuStyle.backgroundColor;
      } else {
        panel.style.backgroundColor = '#18181b';
      }
      if (menuStyle.borderColor) panel.style.borderColor = menuStyle.borderColor;
      if (menuStyle.borderStyle && menuStyle.borderStyle !== 'none') panel.style.borderStyle = menuStyle.borderStyle;
      if (menuStyle.borderWidth && menuStyle.borderWidth !== '0px') panel.style.borderWidth = menuStyle.borderWidth;
      if (menuStyle.borderRadius) panel.style.borderRadius = menuStyle.borderRadius;
      if (menuStyle.color) panel.style.color = menuStyle.color;
      if (menuStyle.fontFamily) panel.style.fontFamily = menuStyle.fontFamily;
      if (menuStyle.fontSize) panel.style.fontSize = menuStyle.fontSize;

      const sampleClass = officialSample?.className || '';
      const chevronSample = officialSample || entries.find((e) => hasEffortSubmenu(e.node))?.node;

      for (const { node, model } of entries) {
        const item = element('div', `${sampleClass ? sampleClass + ' ' : ''}agy-sidepanel-item`);
        item.setAttribute('role', 'menuitem');
        item.tabIndex = -1;
        const disabled = node.getAttribute('aria-disabled') === 'true' || (node as HTMLButtonElement).disabled;
        if (disabled) item.setAttribute('data-disabled', 'true');

        const rawLabel = (node.textContent || model.displayName || model.name).replace(/\s+/g, ' ').trim();
        const left = element('span', 'agy-sidepanel-item-left');
        left.append(element('span', 'agy-sidepanel-item-label', rawLabel));

        const right = element('span', 'agy-sidepanel-item-right');
        if (isItemSelected(node)) {
          right.append(element('span', '', '✓'));
        }
        const hasSub = hasEffortSubmenu(node);
        if (hasSub) {
          right.append(createChevronSvg(chevronSample));
        }
        item.append(left, right);

        item.addEventListener('pointerenter', () => {
          if (closeTimer) {
            clearTimeout(closeTimer);
            closeTimer = undefined;
          }
          unbridgeNode();
          if (hasSub && !disabled) {
            const rect = item.getBoundingClientRect();
            bridgedNode = node;
            bridgedOldStyle = node.getAttribute('style') || '';
            node.style.cssText = `position:fixed!important;left:${rect.left}px!important;top:${rect.top}px!important;width:${rect.width}px!important;height:${rect.height}px!important;opacity:0!important;pointer-events:none!important;display:flex!important;z-index:-1!important;`;
            for (const ev of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove']) {
              node.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8 }));
            }
          }
        });

        item.addEventListener('pointerdown', (e) => e.stopPropagation());
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          if (disabled) return;
          closeSidepanel();
          restore(node);
          node.click();
        });
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' || e.key === 'ArrowLeft') {
            e.preventDefault();
            e.stopPropagation();
            closeSidepanel();
            providerRow.focus();
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            item.click();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            (item.nextElementSibling as HTMLElement | null)?.focus();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = item.previousElementSibling as HTMLElement | null;
            if (prev && prev.classList.contains('agy-sidepanel-item')) prev.focus();
          }
        });

        panel.append(item);
      }

      panel.addEventListener('pointerenter', () => {
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = undefined;
        }
      });
      panel.addEventListener('pointerleave', scheduleCloseSidepanel);
      for (const ev of ['pointerdown', 'mousedown', 'click']) {
        panel.addEventListener(ev, (e) => e.stopPropagation());
      }

      document.body.append(panel);
      sidepanelEl = panel;

      const menuRect = menu.getBoundingClientRect();
      const rowRect = providerRow.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      let left = menuRect.right + 4;
      if (left + panelRect.width > window.innerWidth - 8) {
        left = Math.max(8, menuRect.left - panelRect.width - 4);
      }
      let top = rowRect.top - 4;
      if (top + panelRect.height > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - panelRect.height - 8);
      }
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    const clearInjectedProviders = () => {
      closeSidepanel();
      while (injectedNodes.length) {
        injectedNodes.pop()?.remove();
      }
    };

    const stripTrailingSuffix = (text: string): string =>
      text
        .replace(/(?:\s*(?:Low|Medium|High|XHigh|Minimal|Extra|New|Notice|Unavailable|✓|›|>))+$/iu, '')
        .trim();

    const stripEffortParens = (text: string): string =>
      text.replace(/\s*\((?:low|medium|high|xhigh|minimal|extra)\)\s*$/iu, '').trim();

    const matchNodeToCustomModel = (node: HTMLElement, sortedModels: Array<{ model: CustomModelEntry; clean: string; base: string }>): CustomModelEntry | undefined => {
      const attrLabel =
        node.getAttribute('data-model-label') ||
        node.querySelector<HTMLElement>('[data-model-base]')?.getAttribute('data-model-base') ||
        '';
      const nodeClean = stripStatusPrefix(attrLabel || node.textContent || '');
      if (!nodeClean) return undefined;
      const nodeBase = stripEffortParens(stripTrailingSuffix(nodeClean)).toLowerCase();
      const nodeCleanLower = nodeClean.toLowerCase();
      const isTruncated = nodeBase.endsWith('...') || nodeBase.endsWith('…');
      const truncatedPrefix = isTruncated ? nodeBase.replace(/(?:\.\.\.|…)+$/, '').trim() : '';

      for (const { model, clean, base } of sortedModels) {
        if (!clean) continue;
        const cleanLower = clean.toLowerCase();
        const baseLower = base.toLowerCase();
        if (
          nodeBase === cleanLower ||
          nodeBase === baseLower ||
          nodeCleanLower === cleanLower ||
          nodeCleanLower === baseLower ||
          nodeCleanLower.startsWith(cleanLower) ||
          nodeCleanLower.startsWith(baseLower)
        ) {
          return model;
        }
        if (truncatedPrefix.length >= 12 && (cleanLower.startsWith(truncatedPrefix) || baseLower.startsWith(truncatedPrefix))) {
          return model;
        }
      }
      return undefined;
    };

    const update = () => {
      const query = input.value.trim().toLowerCase();
      clearBtn.hidden = !query;

      const allNodes = rawItems();
      const enabledModels = modelList.filter((m) => m.enabled !== false);
      const sortedModels = enabledModels
        .map((model) => {
          const clean = stripStatusPrefix(model.displayName || model.name);
          return { model, clean, base: stripEffortParens(clean) };
        })
        .sort((a, b) => b.base.length - a.base.length || b.clean.length - a.clean.length);

      const providerGroups = new Map<string, Array<{ node: HTMLElement; model: CustomModelEntry }>>();
      const customNodes = new Set<HTMLElement>();
      let officialSample: HTMLElement | undefined;

      if (sortedModels.length > 0) {
        for (const node of allNodes) {
          const matched = matchNodeToCustomModel(node, sortedModels);
          if (matched) {
            customNodes.add(node);
            const groupName = inferProviderGroup(matched);
            const list = providerGroups.get(groupName) || [];
            list.push({ node, model: matched });
            providerGroups.set(groupName, list);
          } else if (!officialSample && pickerVisible(node)) {
            officialSample = node;
          }
        }
      }

      const renderKey = `${query}|${allNodes.length}|${Array.from(providerGroups.keys()).join(',')}|${allNodes.findIndex((n) => isItemSelected(n))}`;
      if (!query && providerGroups.size > 0 && renderKey === lastRenderKey && injectedNodes.some((n) => n.isConnected)) {
        return;
      }
      lastRenderKey = renderKey;
      clearInjectedProviders();

      if (!query && providerGroups.size > 0) {
        // Grouped Provider View: keep Official Models visible, hide flat Custom Models, inject Provider Rows
        for (const node of allNodes) {
          if (customNodes.has(node)) {
            hideNode(node);
          } else {
            restore(node);
          }
        }

        const anchor = viewUsageNode();
        const divider = element('div', 'agy-provider-divider');
        injectedNodes.push(divider);
        if (anchor) anchor.insertAdjacentElement('beforebegin', divider);
        else menu.append(divider);

        const rowClass = officialSample?.className ? `${officialSample.className} agy-provider-row` : 'agy-provider-row';
        const chevronSample = officialSample || Array.from(customNodes).find((n) => hasEffortSubmenu(n));

        for (const [providerName, entries] of providerGroups.entries()) {
          const row = element('div', rowClass);
          row.setAttribute('role', 'menuitem');
          row.setAttribute('aria-haspopup', 'menu');
          row.tabIndex = -1;

          const activeEntry = entries.find((e) => isItemSelected(e.node));
          const left = element('span', 'agy-provider-row-left');
          left.append(element('span', 'agy-provider-row-name', providerName));
          if (activeEntry) {
            const activeClean = stripStatusPrefix(activeEntry.model.displayName || activeEntry.model.name);
            left.append(element('span', 'agy-provider-row-active', activeClean));
          }

          const right = element('span', 'agy-provider-row-right');
          if (activeEntry) {
            right.append(element('span', '', '✓'));
          }
          right.append(createChevronSvg(chevronSample));
          row.append(left, right);

          row.addEventListener('pointerenter', () => openProviderSidepanel(row, providerName, entries, officialSample));
          row.addEventListener('pointerleave', scheduleCloseSidepanel);
          row.addEventListener('pointerdown', (e) => e.stopPropagation());
          row.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openProviderSidepanel(row, providerName, entries, officialSample);
          });
          row.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              openProviderSidepanel(row, providerName, entries, officialSample);
              (sidepanelEl?.querySelector('.agy-sidepanel-item') as HTMLElement | null)?.focus();
            }
          });

          injectedNodes.push(row);
          if (anchor) anchor.insertAdjacentElement('beforebegin', row);
          else menu.append(row);
        }

        empty.hidden = true;
        return;
      }

      // Search View (or fallback if no custom provider groups exist)
      let matches = 0;
      for (const node of allNodes) {
        const matchedModel = sortedModels.length ? matchNodeToCustomModel(node, sortedModels) : undefined;
        const providerHint = matchedModel ? inferProviderGroup(matchedModel) : '';
        const haystack = `${node.textContent || ''} ${providerHint}`.toLowerCase();
        const matched = !query || haystack.includes(query);
        if (matched) {
          if (displays.has(node)) restore(node);
          if (pickerVisible(node)) matches++;
        } else {
          hideNode(node);
        }
      }
      const hidden = !query || matches > 0;
      if (empty.hidden !== hidden) empty.hidden = hidden;
    };

    for (const event of ['pointerdown', 'mousedown', 'click']) box.addEventListener(event, (e) => e.stopPropagation());
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      update();
      input.focus();
    });
    input.addEventListener('input', update);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !input.value) return;
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); input.value = ''; update(); }
      else if (event.key === 'Enter' || event.key === 'ArrowDown') {
        event.preventDefault();
        const first = rawItems().find((node) => pickerVisible(node) && node.getAttribute('aria-disabled') !== 'true' && !(node as HTMLButtonElement).disabled);
        if (event.key === 'Enter') first?.click();
        else (first || (injectedNodes.find((n) => n.classList.contains('agy-provider-row')) as HTMLElement | undefined))?.focus();
      }
    });

    pickerSearch = {
      menu,
      update,
      cleanup: () => {
        clearInjectedProviders();
        for (const node of Array.from(displays.keys())) restore(node);
        box.remove();
        empty.remove();
      },
    };
    update();
    if (!modelList.length) {
      void storageAPI.getCustomModels().then((list) => {
        modelList = list;
        if (pickerSearch?.menu === menu && pickerVisible(menu)) {
          update();
        }
      }).catch(() => {});
    }
    setTimeout(() => { if (box.isConnected && pickerVisible(menu)) input.focus(); }, 0);
  }
  function setupInjectionObserver(): void {
    injectCustomModelsSection();
    if (!document.body) return;
    checkModelPickerSearch();
    fleetTimer = setInterval(() => { void refreshFleetQuotas(); }, 30_000);
    let pending: ReturnType<typeof setTimeout> | undefined;
    const isAddonPickerNode = (target: Node | null): boolean => {
      const el = target instanceof HTMLElement ? target : target?.parentElement;
      return Boolean(el?.closest('.agy-provider-sidepanel, .agy-provider-row, .agy-provider-divider, .agy-model-search-box'));
    };
    const observer = new MutationObserver((mutations) => {
      if (mutations.every((m) => isAddonPickerNode(m.target))) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = undefined;
        injectCustomModelsSection();
        checkModelPickerSearch();
      }, 150);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'data-state'],
    });
    window.addEventListener(
      'pagehide',
      () => {
        observer.disconnect();
        if (pending) clearTimeout(pending);
        if (fleetTimer) clearInterval(fleetTimer);
      },
      { once: true },
    );
  }


  function hashCodeStr(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) + h + s.charCodeAt(i);
      h = h & h;
    }
    return Math.abs(h);
  }

  // Start the observer
  setupInjectionObserver();

  const onWindowFocus = () => {
    void renderCustomModelsList({ background: true });
  };
  window.addEventListener('focus', onWindowFocus);
  listPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      void renderCustomModelsList({ background: true });
    }
  }, 4000);
  window.addEventListener(
    'pagehide',
    () => {
      if (listPollTimer !== undefined && typeof clearInterval === 'function') {
        clearInterval(listPollTimer);
        listPollTimer = undefined;
      }
      window.removeEventListener?.('focus', onWindowFocus);
    },
    { once: true },
  );
});
