"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/** Custom-model UI, appended to the vendor preload. Sandboxed preloads require Electron only. */
const electron_1 = require("electron");
const storageAPI = {
    getCustomModels: () => electron_1.ipcRenderer.invoke('storage:get-custom-models'),
    saveCustomModel: (model) => electron_1.ipcRenderer.invoke('storage:save-custom-model', model),
    deleteCustomModel: (name) => electron_1.ipcRenderer.invoke('storage:delete-custom-model', name),
    testModelConnection: (model) => electron_1.ipcRenderer.invoke('storage:test-model-connection', model),
    testModelGeneration: (model) => electron_1.ipcRenderer.invoke('storage:test-model-generation', model),
    getPresets: () => electron_1.ipcRenderer.invoke('storage:get-provider-presets'),
    discoverModels: (params) => electron_1.ipcRenderer.invoke('storage:discover-models', params),
    getModelHealth: () => electron_1.ipcRenderer.invoke('storage:get-model-health'),
    checkModelHealth: (name) => electron_1.ipcRenderer.invoke('storage:check-model-health', name),
    getDisplaySettings: () => electron_1.ipcRenderer.invoke('storage:get-display-settings'),
    saveDisplaySettings: (settings) => electron_1.ipcRenderer.invoke('storage:save-display-settings', settings),
};
window.addEventListener('DOMContentLoaded', () => {
    let modelList = [];
    let renderVersion = 0;
    let lastRenderedSnapshot = '';
    let listPollTimer;
    let searchTerm = '';
    const LAYOUT_STORAGE_KEY = 'agy-model-layout';
    const loadSavedLayout = () => {
        try {
            const saved = window.localStorage?.getItem(LAYOUT_STORAGE_KEY);
            if (saved === 'linear' || saved === 'split' || saved === 'accordion' || saved === 'grid')
                return saved;
        }
        catch { }
        return 'linear';
    };
    let filterMode = 'all';
    let layoutMode = loadSavedLayout();
    let animateNextLayout = false;
    const expandedAccordions = new Set();
    const collapsedGroups = new Set();
    let cancelModalOperation;
    const requireSuccess = (result) => {
        if (!result?.success)
            throw new Error(result?.error || 'The operation could not be completed.');
        return result;
    };
    function element(tag, className = '', text = '') {
        const node = document.createElement(tag);
        node.className = className;
        if (text)
            node.textContent = text;
        return node;
    }
    function setStatus(target, text, error = false) {
        target.textContent = text;
        target.className = `agy-status${error ? ' agy-error' : ''}`;
    }
    function statusNode() {
        const node = element('div', 'agy-status');
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        return node;
    }
    function button(label, action, status, primary = false) {
        const node = element('button', `agy-btn${primary ? ' agy-primary' : ''}`, label);
        node.type = 'button';
        node.addEventListener('click', async () => {
            // Fleet saves read and replace complete model records. Other settings
            // actions must not submit an older record while that transaction is pending.
            if (node.disabled || fleetBusy)
                return;
            node.disabled = true;
            try {
                await action();
            }
            catch (error) {
                const target = status || document.getElementById('agy-main-status');
                if (target)
                    setStatus(target, error instanceof Error ? error.message : String(error), true);
            }
            finally {
                node.disabled = false;
            }
        });
        return node;
    }
    function field(parent, title, id, value = '', type = 'text') {
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
    function selectField(parent, title, id, options, value) {
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
    function jsonField(parent, title, id, value) {
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
    function textAreaField(parent, title, id, value, placeholder) {
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
    function readJson(input, title) {
        if (!input.value.trim())
            return undefined;
        try {
            const value = JSON.parse(input.value);
            if (!value || Array.isArray(value) || typeof value !== 'object')
                throw new Error();
            return value;
        }
        catch {
            throw new Error(`${title} must be a JSON object.`);
        }
    }
    function readNumber(input, title, minimum = 0) {
        if (!input.value.trim())
            return undefined;
        const value = Number(input.value);
        if (!Number.isSafeInteger(value) || value < minimum)
            throw new Error(`${title} must be a whole number of at least ${minimum}.`);
        return value;
    }
    function validUrl(value) {
        let url;
        try {
            url = new URL(value.trim());
        }
        catch {
            throw new Error('Enter a complete http:// or https:// API URL.');
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw new Error('Use an HTTP or HTTPS URL. Enter credentials in the API key field.');
        return value.trim();
    }
    function installStyles() {
        if (document.getElementById('agy-manager-style'))
            return;
        const style = element('style');
        style.id = 'agy-manager-style';
        style.textContent = `
      #agy-custom-models-section,#agy-modal-overlay{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e4e4e7;box-sizing:border-box}
      #agy-custom-models-section *,#agy-modal-overlay *{box-sizing:border-box}
      #agy-custom-models-section [hidden],#agy-modal-overlay [hidden]{display:none!important}
      #agy-custom-models-section{margin:24px 0;padding:20px;border:1px solid #303036;border-radius:12px;background:#18181b;min-width:0}
      #agy-custom-models-section h2,#agy-modal-overlay h2{font-size:18px;margin:0;color:#fafafa;font-weight:600}
      #agy-custom-models-section h3{font-size:13px;margin:0;color:#f4f4f5}
      .agy-toolbar,.agy-actions,.agy-group-heading,.agy-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .agy-toolbar{justify-content:space-between;margin-bottom:12px}.agy-actions{margin:10px 0}
      .agy-toolbar .agy-btn{padding:4px 9px;font-size:11px;border-radius:6px}
      .agy-muted{color:#a1a1aa;font-size:12px;overflow-wrap:anywhere}.agy-group{margin-top:16px;border-top:1px solid #303036;padding-top:14px}
      .agy-group-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;padding:2px 0;flex-wrap:nowrap}
      .agy-group-heading .agy-actions{margin:0;justify-content:flex-end}
      #agy-custom-models-section .agy-group-heading .agy-disclosure{padding:0;width:23px;height:23px;justify-content:center;background:transparent;border-color:#3f3f46}
      @keyframes agyLayoutFade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
      .agy-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .agy-models{display:flex;flex-direction:column;gap:4px;margin-top:8px;transition:opacity .16s ease}
      .agy-models.agy-layout-anim{animation:agyLayoutFade .18s cubic-bezier(.22,1,.36,1)}
      .agy-models[data-layout="linear"],.agy-models[data-layout="split"],.agy-models[data-layout="accordion"]{gap:0;border:1px solid #2b2b32;border-radius:10px;background:#1c1c20}
      .agy-models[data-layout="linear"] .agy-row,.agy-models[data-layout="split"] .agy-row,.agy-models[data-layout="accordion"] .agy-row{border:0;border-bottom:1px solid #26262c;border-radius:0;background:transparent;padding:7px 11px;transition:background .14s ease}
      .agy-models[data-layout="linear"] .agy-row:first-child,.agy-models[data-layout="split"] .agy-row:first-child,.agy-models[data-layout="accordion"] .agy-row:first-child{border-radius:9px 9px 0 0}
      .agy-models[data-layout="linear"] .agy-row:last-child,.agy-models[data-layout="split"] .agy-row:last-child,.agy-models[data-layout="accordion"] .agy-row:last-child{border-bottom:0;border-radius:0 0 9px 9px}
      .agy-models[data-layout="linear"] .agy-row:only-child,.agy-models[data-layout="split"] .agy-row:only-child,.agy-models[data-layout="accordion"] .agy-row:only-child{border-radius:9px}
      .agy-models[data-layout="linear"] .agy-row:hover,.agy-models[data-layout="split"] .agy-row:hover,.agy-models[data-layout="accordion"] .agy-row:hover{background:rgba(255,255,255,.03)}
      .agy-models[data-layout="split"] .agy-row{flex-direction:column;align-items:stretch;gap:5px}
      .agy-models[data-layout="split"] .agy-row-info,.agy-models[data-layout="accordion"] .agy-row-info,.agy-models[data-layout="grid"] .agy-row-info{flex:0 0 auto;overflow:visible}
      .agy-split-top,.agy-split-bot{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
      .agy-split-bot{padding-left:0}
      .agy-models[data-layout="grid"]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      .agy-models[data-layout="grid"] .agy-row{flex-direction:column;align-items:stretch;justify-content:space-between;gap:8px;padding:9px 10px;border:1px solid #2b2b32;border-radius:10px;background:#1c1c20;transition:border-color .14s ease,background .14s ease}
      .agy-models[data-layout="grid"] .agy-row:hover{border-color:#3f3f47;background:#202026}
      .agy-grid-top{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}
      .agy-grid-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;padding-top:6px;border-top:1px solid #26262c}
      .agy-models[data-layout="accordion"] .agy-row{flex-direction:column;align-items:stretch;gap:0;padding:0}
      .agy-acc-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 11px;cursor:pointer;user-select:none;min-width:0}
      .agy-acc-chev{display:inline-flex;align-items:center;justify-content:center;width:14px;font-size:10px;color:#8e8e98;transition:transform .18s cubic-bezier(.22,1,.36,1);flex-shrink:0}
      .agy-row[data-expanded="true"] .agy-acc-chev{transform:rotate(90deg);color:#e4e4e7}
      .agy-acc-body{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .2s cubic-bezier(.22,1,.36,1),opacity .18s ease}
      .agy-row[data-expanded="true"] .agy-acc-body{grid-template-rows:1fr;opacity:1}
      .agy-acc-inner{overflow:hidden}
      .agy-acc-list{background:#151519;border-top:1px solid #26262c;padding:4px 11px 4px 30px;display:flex;flex-direction:column}
      .agy-acc-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:11.5px}
      .agy-acc-item:last-child{border-bottom:0}
      .agy-acc-item-name{font-weight:500;min-width:44px;color:#e4e4e7}
      .agy-acc-item[data-enabled="false"] .agy-acc-item-name{opacity:.45;text-decoration:line-through}
      .agy-acc-link{appearance:none;border:0;background:transparent;color:#8e8e98;font-size:11px;padding:2px 5px;border-radius:4px;cursor:pointer;transition:color .12s,background .12s}
      .agy-acc-link:hover{color:#fafafa;background:rgba(255,255,255,.06)}
      .agy-acc-count{font-size:10.5px;padding:1px 6px;border-radius:5px;background:#26262c;color:#a1a1aa;white-space:nowrap;flex-shrink:0}
      .agy-status-dot{width:6px;height:6px;border-radius:9999px;flex-shrink:0;display:inline-block}
      .agy-status-dot[data-s="ok"]{background:#34d399}
      .agy-status-dot[data-s="warn"]{background:#fbbf24}
      .agy-status-dot[data-s="err"]{background:#f87171}
      .agy-status-dot[data-s="idle"]{background:#52525b}
      #agy-custom-models-section .agy-switch{position:relative;display:inline-flex;align-items:center;width:30px;height:17px;padding:0;border-radius:9999px;border:1px solid transparent;background:#3a3a42;cursor:pointer;flex-shrink:0;transition:background .18s cubic-bezier(.22,1,.36,1),border-color .18s ease}
      #agy-custom-models-section .agy-switch[aria-checked="true"]{background:#22c55e}
      #agy-custom-models-section .agy-switch:hover{filter:brightness(1.08)}
      .agy-switch-dot{width:13px;height:13px;border-radius:9999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.4);transform:translateX(1px);transition:transform .18s cubic-bezier(.22,1,.36,1);pointer-events:none}
      #agy-custom-models-section .agy-switch[aria-checked="true"] .agy-switch-dot{transform:translateX(14px)}
      .agy-layout-switcher{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:7px;background:#141417;border:1px solid #2b2b33;margin-left:auto;flex-shrink:0}
      .agy-layout-btn{appearance:none;border:0;background:transparent;color:#8e8e98;font:inherit;font-size:11px;font-weight:500;padding:3px 7px;border-radius:5px;cursor:pointer;white-space:nowrap;transition:background .14s ease,color .14s ease}
      .agy-layout-btn:hover{color:#e4e4e7}
      .agy-layout-btn[aria-pressed="true"]{background:#2c2c34;color:#fafafa;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.35)}
      @media(max-width:520px){.agy-models[data-layout="grid"]{grid-template-columns:1fr}}
      .agy-row{display:flex;flex-wrap:wrap;align-items:center;gap:5px 10px;border:1px solid #2b2b31;border-radius:8px;padding:6px 9px 6px 11px;margin-top:0;background:#202024;min-width:0;font-size:12px}
      .agy-row:hover{background:#242429;border-color:#3f3f46}
      .agy-row .agy-btn{padding:3px 8px;font-size:11px;border-radius:6px}
      .agy-row .agy-muted{font-size:11px}
      .agy-row .agy-status{margin-top:2px;font-size:11px}
      .agy-row-info{display:flex;flex-direction:column;gap:3px;min-width:0;overflow:hidden;flex:1 1 240px}
      .agy-row-title{display:flex;align-items:center;gap:6px;min-width:0}
      .agy-row-title strong{flex:1 1 auto;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .agy-row-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .agy-row-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex:0 0 auto}
      .agy-menu{position:relative}
      .agy-menu-btn{list-style:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:23px;height:23px;border-radius:6px;border:1px solid #414149;background:#27272c;color:#d4d4d8;font-size:13px;line-height:1;user-select:none}
      .agy-menu-btn::-webkit-details-marker{display:none}
      .agy-menu-btn:hover,.agy-menu[open] .agy-menu-btn{background:#33333a;color:#fafafa}
      .agy-menu-list{position:absolute;right:0;top:calc(100% + 4px);z-index:30;display:flex;flex-direction:column;min-width:170px;padding:4px;border:1px solid #414149;border-radius:8px;background:#1c1c20;box-shadow:0 12px 32px #0009}
      #agy-custom-models-section .agy-menu-list .agy-btn{width:100%;text-align:left;border:0;background:transparent;border-radius:6px;padding:6px 9px;font-size:12px}
      #agy-custom-models-section .agy-menu-list .agy-btn:hover{background:#2b2b31}
      #agy-custom-models-section .agy-menu-list .agy-danger{color:#fca5a5}
      .agy-row[data-enabled="false"] .agy-row-info,.agy-row[data-enabled="false"] .agy-row-actions>.agy-btn{opacity:.6}
      .agy-effort-chip{display:inline-block;padding:1px 6px;border-radius:5px;background:#16161a;border:1px solid #2b2b33;color:#a1a1aa;font-size:10.5px;font-weight:500;line-height:16px;white-space:nowrap}
      .agy-effort-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:6px;background:#16161a;border:1px solid #2b2b33;flex-shrink:0}
      .agy-effort-tab{appearance:none;padding:2px 7px;border-radius:4px;border:none;background:transparent;color:#8e8e98;font-size:10.5px;font-weight:500;line-height:14px;white-space:nowrap;cursor:pointer;transition:background .12s,color .12s,opacity .12s}
      .agy-effort-tab:hover{color:#e4e4e7;background:rgba(255,255,255,.05)}
      .agy-effort-tab[aria-pressed="true"]{background:#2e2e36;color:#fafafa;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.4)}
      .agy-effort-tab[data-enabled="false"]{opacity:.38;text-decoration:line-through}
      .agy-effort-tab[data-enabled="false"][aria-pressed="true"]{opacity:.72}
      .agy-row-slug{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;color:#8e8e98}
      .agy-row-badge-ok{color:#34d399}
      .agy-row-badge-warn{color:#fbbf24}
      .agy-row-badge-err{color:#f87171}
      .agy-sticky-bar{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px;padding:8px 0;background:#18181b;border-bottom:1px solid #303036}
      .agy-sticky-bar .agy-field{margin:0;flex:1 1 220px}
      .agy-chip{appearance:none;font:inherit;font-size:11px;color:#a1a1aa;background:#202024;border:1px solid #303036;border-radius:9999px;padding:3px 9px;cursor:pointer;white-space:nowrap}
      .agy-chip:hover{color:#fafafa;border-color:#414149}
      .agy-chip[aria-pressed="true"]{color:#18181b;background:#e4e4e7;border-color:#e4e4e7;font-weight:600}
      .agy-group-heading .agy-btn{padding:3px 8px;font-size:11px;border-radius:5px}
      .agy-group-heading h3{font-size:12px}
      #agy-custom-models-section .agy-btn,#agy-modal-overlay .agy-btn{appearance:none;font:inherit;color:#e4e4e7;background:#27272c;border:1px solid #414149;border-radius:6px;padding:6px 10px;cursor:pointer;white-space:nowrap}
      #agy-custom-models-section .agy-primary,#agy-modal-overlay .agy-primary{background:#e4e4e7;color:#18181b;border-color:#e4e4e7;font-weight:600}
      #agy-custom-models-section .agy-btn:hover,#agy-modal-overlay .agy-btn:hover{filter:brightness(1.12)}
      #agy-custom-models-section .agy-btn:disabled,#agy-modal-overlay .agy-btn:disabled{opacity:.5;cursor:wait}
      #agy-custom-models-section :focus-visible,#agy-modal-overlay :focus-visible{outline:2px solid #a78bfa;outline-offset:3px}
      .agy-status{color:#86efac;font-size:12px;margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere}.agy-status:empty{display:none}.agy-error{color:#fca5a5}
      .agy-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;min-width:0;color:#a1a1aa}
      #agy-custom-models-section input,#agy-modal-overlay input,#agy-modal-overlay select,#agy-modal-overlay textarea{font:inherit;width:100%;background:#25252a;border:1px solid #414149;border-radius:6px;color:#fafafa;padding:8px 10px;min-width:0}
      #agy-modal-overlay textarea{font-family:ui-monospace,monospace;resize:vertical}#agy-modal-overlay input[type=checkbox],#agy-custom-models-section input[type=checkbox]{width:auto!important;accent-color:#a78bfa;cursor:pointer;margin:0 6px 0 0}
      .agy-options-row{display:flex;align-items:center;gap:16px;margin:8px 0 12px;font-size:12px;color:#d4d4d8}
      .agy-toggle-label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
      #agy-modal-overlay{position:fixed;inset:0;z-index:999999;background:#000a;display:flex;align-items:center;justify-content:center;padding:20px}
      #agy-modal-card{width:680px;max-width:100%;max-height:90vh;overflow:auto;background:#18181b;border:1px solid #414149;border-radius:12px;padding:24px;box-shadow:0 24px 80px #0008}
      .agy-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.agy-discovery{max-height:240px;overflow:auto;margin:12px 0}
      .agy-choice{display:flex;gap:10px;align-items:center;padding:7px 0;overflow-wrap:anywhere}.agy-choice span{min-width:0}
      #agy-modal-overlay details{border:1px solid #303036;border-radius:8px;margin:12px 0;padding:12px}#agy-modal-overlay summary{cursor:pointer;margin-bottom:10px;font-weight:500}
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
    function openModal(title) {
        cancelModalOperation?.();
        cancelModalOperation = undefined;
        document.getElementById('agy-modal-overlay')?.remove();
        const previousFocus = document.activeElement;
        const overlay = element('div');
        overlay.id = 'agy-modal-overlay';
        const card = element('div');
        card.id = 'agy-modal-card';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-labelledby', 'agy-modal-title');
        const header = element('div', 'agy-toolbar');
        const heading = element('h2', '', title);
        heading.id = 'agy-modal-title';
        const close = () => {
            if (!overlay.isConnected)
                return;
            cancelModalOperation?.();
            cancelModalOperation = undefined;
            overlay.remove();
            if (previousFocus?.isConnected)
                previousFocus.focus({ preventScroll: true });
        };
        header.append(heading, button('Close', close));
        const body = element('div');
        const status = statusNode();
        card.append(header, body, status);
        overlay.append(card);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay)
                close();
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
            }
            if (event.key !== 'Tab')
                return;
            const controls = Array.from(card.querySelectorAll('button:not(:disabled),input:not(:disabled),select,textarea,summary'));
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        });
        document.body.append(overlay);
        header.querySelector('button')?.focus();
        return { body, status, close };
    }
    function createGoogleAccountPanel(parent, initialAccounts, modelName) {
        let accounts = initialAccounts.map((account) => ({ ...account }));
        const locallyEdited = new Set();
        let accountOperationAttempt = 0;
        let accountOperationPending = false;
        const panel = element('details');
        panel.open = true;
        panel.append(element('summary', '', 'Google accounts'));
        panel.append(element('p', 'agy-muted', 'Add up to 50 accounts you own using Antigravity sign-in, your Desktop OAuth client, or a credential file. Save the model to retain changes. Existing secrets stay masked. Prepare account checks the Cloud Code project and may activate the available free tier.'));
        const list = element('div');
        list.id = 'agy-google-accounts-list';
        const editor = element('div');
        const status = statusNode();
        const randomId = () => `account-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const addAccount = (account) => {
            if (!account.id || (!account.refreshToken && !account.accessToken))
                throw new Error('An account needs an ID and a refresh token or access token.');
            if (account.refreshToken && !account.clientId)
                throw new Error('An OAuth client ID is required with a refresh token.');
            const index = accounts.findIndex((value) => value.id === account.id);
            if (index < 0) {
                if (accounts.length >= 50)
                    throw new Error('A model can contain at most 50 Google accounts.');
                accounts.push(account);
            }
            else
                accounts[index] = account;
            locallyEdited.add(account.id);
            renderAccounts();
        };
        function editAccount(account) {
            editor.replaceChildren();
            editor.append(element('h3', '', account ? 'Edit account' : 'Add account credentials'));
            const accountGrid = element('div', 'agy-grid');
            const id = field(accountGrid, 'Account ID', 'agy-account-id', account?.id || randomId());
            const label = field(accountGrid, 'Label', 'agy-account-label', account?.label || '');
            const clientId = field(accountGrid, 'Desktop OAuth client ID', 'agy-account-client-id', account?.clientId || '');
            const clientSecret = field(accountGrid, 'OAuth client secret (if required)', 'agy-account-client-secret', account?.clientSecret || '', 'password');
            const refresh = field(accountGrid, 'Refresh token', 'agy-account-refresh-token', account?.refreshToken || '', 'password');
            const access = field(accountGrid, 'Access token (optional with refresh token)', 'agy-account-access-token', account?.accessToken || '', 'password');
            const expires = field(accountGrid, 'Access token expiry (Unix milliseconds)', 'agy-account-expires-at', account?.expiresAt != null ? String(account.expiresAt) : '', 'number');
            const project = field(accountGrid, 'Cloud project (optional)', 'agy-account-project', account?.project || '');
            editor.append(accountGrid);
            const actions = element('div', 'agy-actions');
            actions.append(button('Apply account', () => {
                const accountId = id.value.trim();
                if (account && accountId !== account.id && accounts.some((value) => value.id === accountId))
                    throw new Error('That account ID already exists.');
                const updated = {
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
                if (account &&
                    accountId !== account.id &&
                    [updated.refreshToken, updated.accessToken, updated.clientSecret].some((value) => value?.includes('***')))
                    throw new Error('Keep the account ID unchanged when using masked credentials.');
                addAccount(updated);
                if (account && accountId !== account.id)
                    accounts = accounts.filter((value) => value.id !== account.id);
                editor.replaceChildren();
                renderAccounts();
                setStatus(status, 'Account updated. Save the model to keep these changes.');
            }, status), button('Cancel account edit', () => editor.replaceChildren(), status));
            editor.append(actions);
        }
        function renderAccounts() {
            list.replaceChildren();
            if (!accounts.length)
                list.append(element('p', 'agy-muted', 'No Google accounts configured.'));
            for (const account of accounts) {
                const row = element('div', 'agy-row');
                const info = element('div', 'agy-row-info');
                info.append(element('strong', '', account.label || account.id), element('div', 'agy-muted', `${account.id} · ${account.enabled === false ? 'Disabled' : 'Enabled'}${account.project ? ` · ${account.project}` : ''}`));
                const actions = element('div', 'agy-actions');
                actions.append(button('Edit account', () => editAccount(account), status), button(account.enabled === false ? 'Enable account' : 'Disable account', () => {
                    account.enabled = account.enabled === false;
                    renderAccounts();
                }, status), button('Test account', async () => {
                    setStatus(status, 'Checking account access and quota…');
                    const result = await electron_1.ipcRenderer.invoke('storage:google-test-account', modelName && !locallyEdited.has(account.id)
                        ? { modelName, accountId: account.id }
                        : { account, ...(modelName ? { modelName } : {}) });
                    requireSuccess(result);
                    setStatus(status, result.message ||
                        (result.quota
                            ? `Account verified. Quota: ${JSON.stringify(result.quota)}`
                            : 'Account verified. Generation was not tested.'));
                }, status), button('Prepare account', async () => {
                    if (accountOperationPending)
                        throw new Error('Wait for the current Google account operation or cancel it.');
                    accountOperationPending = true;
                    const attempt = ++accountOperationAttempt;
                    const cancel = () => {
                        accountOperationAttempt++;
                        void electron_1.ipcRenderer.invoke('storage:google-login-cancel').catch(() => { });
                    };
                    cancelModalOperation = cancel;
                    try {
                        setStatus(status, 'Preparing account access and Cloud Code project…');
                        const result = await electron_1.ipcRenderer.invoke('storage:google-account-prepare', {
                            ...(modelName && !locallyEdited.has(account.id)
                                ? { modelName, accountId: account.id }
                                : { account, ...(modelName ? { modelName } : {}) }),
                            allowOnboard: true,
                        });
                        if (!panel.isConnected || accountOperationAttempt !== attempt)
                            return;
                        requireSuccess(result);
                        if (!accounts.some((value) => value.id === account.id))
                            return;
                        if (!result.account || result.account.id !== account.id)
                            throw new Error('Account preparation did not return the selected account.');
                        addAccount({ ...account, ...result.account });
                        setStatus(status, result.message ||
                            'Account prepared. Save the model to retain the project. Generation was not tested.');
                    }
                    finally {
                        accountOperationPending = false;
                        if (cancelModalOperation === cancel)
                            cancelModalOperation = undefined;
                    }
                }, status), button('Remove account', () => {
                    accounts = accounts.filter((value) => value.id !== account.id);
                    locallyEdited.delete(account.id);
                    renderAccounts();
                }, status));
                row.append(info, actions);
                list.append(row);
            }
        }
        const actions = element('div', 'agy-actions');
        actions.append(button('Add account', () => editAccount(), status), button('Pool status', async () => {
            const result = await electron_1.ipcRenderer.invoke('storage:google-pool-status');
            if (result?.success === false)
                requireSuccess(result);
            setStatus(status, JSON.stringify(result, null, 2));
        }, status));
        const login = element('details');
        login.append(element('summary', '', 'Sign in with Google'));
        const loginMode = selectField(login, 'Sign-in method', 'agy-google-login-auth-mode', [
            ['antigravity', 'Antigravity account'],
            ['custom', 'My Desktop OAuth client'],
        ], 'antigravity');
        const loginHelp = element('p', 'agy-muted');
        login.append(loginHelp);
        const loginLabel = field(login, 'Account label', 'agy-google-login-label');
        const loginClient = field(login, 'Desktop OAuth client ID', 'agy-google-login-client-id');
        const loginSecret = field(login, 'OAuth client secret (if required)', 'agy-google-login-client-secret', '', 'password');
        const updateLoginMode = () => {
            const native = loginMode.value === 'antigravity';
            loginClient.closest('label').hidden = native;
            loginSecret.closest('label').hidden = native;
            loginHelp.textContent = native
                ? 'Sign in through your browser using the installed Antigravity app’s OAuth client. This prepares your Cloud Code project and may activate the available free tier. A recognized Antigravity installation is required. Repeat for each account, then save the model. Generation must be tested separately.'
                : 'Enter a Desktop OAuth client from your Google Cloud project. Your project and account must have access to the configured Cloud Code service. Repeat Sign in with Google for each account, then save the model.';
        };
        loginMode.addEventListener('change', updateLoginMode);
        updateLoginMode();
        const loginActions = element('div', 'agy-actions');
        loginActions.append(button('Sign in with Google', async () => {
            const authMode = loginMode.value === 'custom' ? 'custom' : 'antigravity';
            if (authMode === 'custom' && !loginClient.value.trim())
                throw new Error('Enter your Desktop OAuth client ID.');
            if (accountOperationPending)
                throw new Error('Wait for the current Google account operation or cancel it.');
            accountOperationPending = true;
            const attempt = ++accountOperationAttempt;
            const cancel = () => {
                accountOperationAttempt++;
                void electron_1.ipcRenderer.invoke('storage:google-login-cancel').catch(() => { });
            };
            cancelModalOperation = cancel;
            for (const input of [loginMode, loginLabel, loginClient, loginSecret])
                input.disabled = true;
            setStatus(status, authMode === 'antigravity'
                ? 'Complete consent in your browser, then wait for account preparation. Browser login expires after two minutes.'
                : 'Complete consent in your browser. This login expires after two minutes.');
            try {
                const result = await electron_1.ipcRenderer.invoke('storage:google-login', {
                    authMode,
                    ...(authMode === 'custom'
                        ? { clientId: loginClient.value.trim(), clientSecret: loginSecret.value.trim() || undefined }
                        : {}),
                    label: loginLabel.value.trim() || undefined,
                });
                if (!panel.isConnected || accountOperationAttempt !== attempt)
                    return;
                requireSuccess(result);
                if (!result.account)
                    throw new Error('Google login did not return an account.');
                addAccount(result.account);
                loginSecret.value = '';
                setStatus(status, 'Account authorized. Save the model within 10 minutes to retain it; otherwise sign in again. Use Test account to check service access and quota, then Test generation to verify a model response.');
            }
            finally {
                accountOperationPending = false;
                for (const input of [loginMode, loginLabel, loginClient, loginSecret])
                    input.disabled = false;
                if (cancelModalOperation === cancel)
                    cancelModalOperation = undefined;
            }
        }, status), button('Cancel Google login', async () => {
            accountOperationAttempt++;
            requireSuccess(await electron_1.ipcRenderer.invoke('storage:google-login-cancel'));
            cancelModalOperation = undefined;
            setStatus(status, 'Google login cancelled.');
        }, status));
        login.append(loginActions);
        const importer = element('details');
        importer.append(element('summary', '', 'Import account credentials'));
        importer.append(element('p', 'agy-muted', 'Import your own authorized_user JSON, an account object, or an accounts array. Importing does not open a browser or make network requests.'));
        const accountJson = jsonField(importer, 'Account JSON', 'agy-google-account-json', undefined);
        const file = field(importer, 'Credential JSON file', 'agy-google-account-file', '', 'file');
        file.accept = '.json,application/json';
        file.addEventListener('change', async () => {
            try {
                const selected = file.files?.[0];
                if (!selected)
                    return;
                if (selected.size > 512 * 1024)
                    throw new Error('Account files must be smaller than 512 KB.');
                accountJson.value = await selected.text();
            }
            catch (error) {
                setStatus(status, String(error), true);
            }
        });
        importer.append(button('Import accounts', () => {
            let data;
            try {
                data = JSON.parse(accountJson.value);
            }
            catch {
                throw new Error('Account credentials must be valid JSON.');
            }
            const root = data;
            const values = Array.isArray(data) ? data : root?.accounts || root?.googleAccounts || [data];
            if (!Array.isArray(values) || !values.length || values.length + accounts.length > 50)
                throw new Error('Import between 1 and 50 accounts.');
            const incoming = values.map((value) => {
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    throw new Error('Each account must be a JSON object.');
                const entry = value;
                const text = (key, alternate = key) => String(entry[key] || entry[alternate] || '');
                const account = {
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
            for (const account of incoming)
                addAccount(account);
            accountJson.value = '';
            file.value = '';
            setStatus(status, `Imported ${incoming.length} accounts. Save the model to encrypt and retain them.`);
        }, status));
        panel.append(list, actions, editor, login, importer, status);
        parent.append(panel);
        renderAccounts();
        return () => accounts.map((account) => ({ ...account }));
    }
    const nonSettingsContent = '#agy-custom-models-section,#agy-modal-overlay,button,nav,[role="tablist"],article,[role="article"],pre,code,' +
        '[data-testid="conversation-view"],[data-testid="autoscroll-viewport"],[role="log"]';
    function isSettingsContent(node) {
        if (node.closest(nonSettingsContent))
            return false;
        for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true')
                return false;
            const style = window.getComputedStyle(ancestor);
            if (style.display === 'none' || style.visibility === 'hidden')
                return false;
        }
        return true;
    }
    function findRefreshButton(root) {
        return (Array.from(root.querySelectorAll('button')).find((node) => !node.closest('#agy-custom-models-section') &&
            isSettingsContent(node.parentElement || node) &&
            (node.textContent?.trim() === 'Refresh' ||
                /refresh quota/i.test(`${node.getAttribute('aria-label') || ''} ${node.title || ''}`))) || null);
    }
    async function modelsChanged() {
        const restore = captureScrollPosition(document.getElementById('agy-custom-models-section') || document.body);
        fleetEpoch++;
        quotaCache.clear();
        await renderCustomModelsList();
        const mount = findSettingsMount();
        if (mount)
            findRefreshButton(mount)?.click();
        restore();
    }
    function uniqueName(base) {
        let name = base, index = 2;
        while (modelList.some((model) => model.name === name))
            name = `${base}-${index++}`;
        return name;
    }
    function captureScrollPosition(node) {
        const positions = new Map();
        for (let parent = node; parent; parent = parent.parentElement)
            positions.set(parent, { top: parent.scrollTop, left: parent.scrollLeft });
        const scrollingElement = document.scrollingElement;
        if (scrollingElement && !positions.has(scrollingElement))
            positions.set(scrollingElement, { top: scrollingElement.scrollTop, left: scrollingElement.scrollLeft });
        return () => {
            for (const [element, position] of positions) {
                if (!element.isConnected)
                    continue;
                element.scrollTop = position.top;
                element.scrollLeft = position.left;
            }
        };
    }
    function openDeleteModelModal(model) {
        const { body, status, close } = openModal('Delete model');
        body.append(element('p', '', `Delete “${model.displayName || model.name}”?`), element('p', 'agy-muted', 'This removes the saved model configuration from this app.'));
        const actions = element('div', 'agy-actions');
        actions.append(button('Cancel', close), button('Delete model', async () => {
            const visibleRows = Array.from(document.querySelectorAll('#agy-custom-models-content [data-model-name]'));
            const deletedIndex = visibleRows.findIndex((row) => row.dataset.modelName === model.name);
            const adjacentNames = [...visibleRows.slice(deletedIndex + 1), ...visibleRows.slice(0, deletedIndex).reverse()]
                .map((row) => row.dataset.modelName);
            setStatus(status, 'Deleting model…');
            requireSuccess(await storageAPI.deleteCustomModel(model.name));
            // The user may have closed this dialog while storage was updating.
            const dialogStillOpen = body.isConnected;
            if (dialogStillOpen)
                close();
            const focusAfterClose = document.activeElement;
            await modelsChanged();
            if (dialogStillOpen && !document.getElementById('agy-modal-overlay') &&
                (document.activeElement === document.body || document.activeElement === focusAfterClose)) {
                const remainingRows = Array.from(document.querySelectorAll('#agy-custom-models-content [data-model-name]'));
                const adjacentRow = adjacentNames.map((name) => remainingRows.find((row) => row.dataset.modelName === name)).find(Boolean);
                // The overflow menu is closed after a delete, so focus the next row's visible toggle:
                // a button inside a closed <details> is not rendered and cannot take focus.
                const nextFocus = adjacentRow?.querySelector('.agy-row-actions > .agy-btn')
                    || document.getElementById('agy-add-model');
                nextFocus?.focus({ preventScroll: true });
            }
        }, status, true));
        body.append(actions);
    }
    const quotaCache = new Map();
    let fleetEpoch = 0;
    let fleetBusy = false;
    let fleetError = '';
    let fleetCollapsed = false;
    let fleetTargetPool = '';
    try {
        fleetCollapsed = localStorage.getItem('agy_google_fleet_collapsed') === 'true';
    }
    catch { }
    let fleetRefreshing = false;
    let fleetTimer;
    function fleetMembers(models) {
        const members = [];
        for (const model of models) {
            if (model.provider !== 'google-cloudcode' || !Array.isArray(model.googleAccounts))
                continue;
            for (const account of model.googleAccounts) {
                if (!account?.id)
                    continue;
                members.push({ account, owner: model });
            }
        }
        return members;
    }
    function fleetAccounts(models) {
        const rows = new Map();
        for (const member of fleetMembers(models)) {
            const { owner, account } = member;
            const email = (account.email || quotaCache.get(quotaKey(owner, account))?.quota?.email)?.trim();
            // Only a known email identifies a shared account. Unknown memberships stay
            // separate, and grouping never replaces the original owner/account used by actions.
            const key = email ? `email:${email.toLowerCase()}` : `member:${owner.name}:${account.id}`;
            const row = rows.get(key);
            if (row)
                row.members.push(member);
            else
                rows.set(key, { identity: email || account.label || account.id, members: [member] });
        }
        return [...rows.values()];
    }
    function quotaKey(model, account) {
        return JSON.stringify([model.name, model.apiUrl, model.externalModelName, account.id, account.email, account.clientId, account.project, account.authMode, account.cloudCodeEndpoint]);
    }
    async function connectFleetAccount(modelName, replaceAccountId) {
        const { body, status, close } = openModal(replaceAccountId ? 'Reconnect Google account' : 'Add Google account');
        body.append(element('p', 'agy-muted', `Complete Google sign-in in your browser. The account is saved to ${modelName}.`));
        cancelModalOperation = () => { void electron_1.ipcRenderer.invoke('storage:google-login-cancel'); };
        setStatus(status, 'Waiting for Google sign-in…');
        try {
            const result = await electron_1.ipcRenderer.invoke('storage:google-login', { authMode: 'antigravity' });
            if (!body.isConnected)
                return;
            requireSuccess(result);
            if (!result.account)
                throw new Error('Google did not return an account.');
            requireSuccess(await electron_1.ipcRenderer.invoke('storage:google-link-account', { modelName, accountId: result.account.id, ...(replaceAccountId ? { replaceAccountId } : {}) }));
            quotaCache.clear();
            cancelModalOperation = undefined;
            close();
            await modelsChanged();
        }
        catch (error) {
            if (body.isConnected)
                setStatus(status, error instanceof Error ? error.message : String(error), true);
        }
    }
    function removeFleetAccount(account, modelName) {
        const { body, status, close } = openModal('Remove Google account');
        body.append(element('p', '', `Remove ${account.email || account.label || account.id} from ${modelName}? This model will be disabled if no enabled account remains. Other model pools and your IDE login are preserved.`));
        body.append(button('Remove account', async () => {
            requireSuccess(await electron_1.ipcRenderer.invoke('storage:google-remove-account', { modelName, accountId: account.id }));
            quotaCache.clear();
            close();
            await modelsChanged();
        }, status), button('Cancel', close));
    }
    async function runFleetAction(action) {
        if (fleetBusy)
            throw new Error('Wait for the current account change to finish.');
        fleetBusy = true;
        fleetError = '';
        renderGoogleFleet();
        const disabledStates = new Map();
        const roots = document.querySelectorAll('#agy-custom-models-section, #agy-modal-overlay');
        for (const root of roots) {
            for (const control of root.querySelectorAll('button,input,select,textarea')) {
                disabledStates.set(control, control.disabled);
                control.disabled = true;
            }
        }
        try {
            await action();
        }
        catch (error) {
            fleetError = error instanceof Error ? error.message : String(error);
            throw error;
        }
        finally {
            // Keep the lock until fresh records replace the old model/group closures.
            // The button helper also guards controls created during an async rerender.
            try {
                await modelsChanged();
            }
            finally {
                fleetBusy = false;
                for (const [control, wasDisabled] of disabledStates) {
                    if (control.isConnected)
                        control.disabled = wasDisabled;
                }
                renderGoogleFleet();
                void refreshFleetQuotas();
            }
        }
    }
    async function updateFleetAccounts(members, update, updateAvailability = false) {
        // Read current records and save each owner once. A card is a display grouping;
        // its members retain their original IDs, credentials, projects and endpoints.
        const current = await storageAPI.getCustomModels();
        for (const owner of current) {
            const selected = new Set(members.filter((m) => m.owner.name === owner.name).map((m) => m.account.id));
            if (!selected.size || !Array.isArray(owner.googleAccounts))
                continue;
            const accounts = owner.googleAccounts;
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
    function editFleetLabel(identity, members) {
        const { body, status, close } = openModal('Edit account label');
        body.append(element('p', 'agy-muted', `Update the label for ${identity}. Use a model pool's account editor to change its credentials or project.`));
        const label = field(body, 'Account label', 'agy-fleet-account-label', members[0]?.account.label || '');
        body.append(button('Save account label', async () => {
            await runFleetAction(() => updateFleetAccounts(members, (account) => ({ ...account, label: label.value.trim() })));
            close();
        }, status, true), button('Cancel', close));
    }
    function removeFleetMemberships(identity, members) {
        const { body, status, close } = openModal('Remove account from fleet');
        body.append(element('p', '', `Remove ${identity} from ${members.length} assigned model pool${members.length === 1 ? '' : 's'}?`), element('p', 'agy-muted', 'Model definitions and other accounts are preserved. Pools without enabled accounts will be disabled.'));
        body.append(button('Remove from all pools', async () => {
            await runFleetAction(async () => {
                for (const { owner, account } of members) {
                    requireSuccess(await electron_1.ipcRenderer.invoke('storage:google-remove-account', { modelName: owner.name, accountId: account.id }));
                }
            });
            close();
        }, status), button('Cancel', close));
    }
    function relativeQuotaReset(value) {
        const diff = Date.parse(value) - Date.now();
        if (!Number.isFinite(diff))
            return '';
        if (diff <= 0)
            return 'Reset due · refresh quota';
        const minutes = Math.ceil(diff / 60000);
        if (minutes >= 1440)
            return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
        if (minutes >= 60)
            return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
        return `Resets in ${minutes}m`;
    }
    function renderPoolQuota(quota, cached) {
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
        const prettyBucket = (bucket) => {
            const source = bucket.window || bucket.id;
            if (/weekly/i.test(source))
                return 'Weekly limit';
            if (/5h|five.?hour/i.test(source))
                return '5-hour limit';
            if (/daily/i.test(source))
                return 'Daily limit';
            return (bucket.displayName || bucket.id)
                .replace(/\s*limit remaining$/i, ' limit')
                .replace(/\s*remaining$/i, '')
                .trim();
        };
        const ordered = [];
        // Free plans only meter a weekly limit per group; a 5-hour pool there is not part of the plan.
        const freePlan = /^free\b/i.test((cached.quota?.planTier || '').trim());
        const planned = (items) => freePlan ? items.filter((bucket) => !/5h|five.?hour/i.test(bucket.window || bucket.id)) : items;
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
            const flat = new Map();
            for (const bucket of planned(buckets)) {
                const title = bucket.groupName ||
                    (/claude|gpt|anthropic|openai|third[- ]?party/i.test(`${bucket.displayName || ''} ${bucket.id}`)
                        ? 'Claude and GPT models'
                        : 'Gemini Models');
                flat.set(title, [...(flat.get(title) || []), bucket]);
            }
            for (const [title, items] of flat)
                ordered.push({ title, buckets: items });
        }
        // Native order: Gemini pools, then Claude/GPT pools, then any extra per-model groups.
        const canonical = ['gemini models', 'claude and gpt models'];
        const rank = (title) => {
            const index = canonical.indexOf(title.toLowerCase().trim());
            return index === -1 ? canonical.length : index;
        };
        ordered.sort((left, right) => rank(left.title) - rank(right.title) ||
            (rank(left.title) < canonical.length ? 0 : left.title.localeCompare(right.title)));
        const windowRank = (bucket) => {
            const source = `${bucket.window || ''} ${bucket.id}`.toLowerCase();
            if (/weekly/.test(source))
                return 1;
            if (/5h|five|hour/.test(source))
                return 2;
            if (/daily|day/.test(source))
                return 3;
            return 4;
        };
        for (const groupInfo of ordered)
            groupInfo.buckets.sort((left, right) => windowRank(left) - windowRank(right));
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
                heading.append(element('span', 'agy-muted', label), element('span', 'agy-quota-value', disabled
                    ? 'Not applicable'
                    : known
                        ? fraction <= 0
                            ? 'Exhausted'
                            : `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}% left`
                        : 'Unknown'));
                block.append(heading);
                if (bucket.description)
                    block.title = bucket.description;
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
    async function refreshFleetQuotas(force = false) {
        if (fleetRefreshing || fleetBusy)
            return;
        const container = document.getElementById('agy-google-account-pool-section');
        if (!container?.isConnected || container.hidden)
            return;
        const members = fleetMembers(modelList).filter(({ owner, account }) => force || Date.now() - (quotaCache.get(quotaKey(owner, account))?.at || 0) >= 120000);
        if (!members.length)
            return;
        const epoch = fleetEpoch;
        fleetRefreshing = true;
        renderGoogleFleet();
        try {
            // A small sequential queue avoids a login or quota request burst on large fleets.
            for (const { account, owner } of members) {
                if (!container.isConnected || fleetEpoch !== epoch || fleetBusy)
                    break;
                const key = quotaKey(owner, account);
                if (!force && Date.now() - (quotaCache.get(key)?.at || 0) < 120000)
                    continue;
                try {
                    const result = await electron_1.ipcRenderer.invoke('storage:google-test-account', { modelName: owner.name, accountId: account.id });
                    requireSuccess(result);
                    if (fleetEpoch === epoch)
                        quotaCache.set(key, { quota: result.quota, at: Date.now() });
                }
                catch (error) {
                    if (fleetEpoch === epoch)
                        quotaCache.set(key, { error: error instanceof Error ? error.message : String(error), at: Date.now() });
                }
            }
        }
        finally {
            fleetRefreshing = false;
            if (container.isConnected)
                renderGoogleFleet();
            if (fleetEpoch !== epoch)
                void refreshFleetQuotas();
        }
    }
    function renderGoogleFleet() {
        const container = document.getElementById('agy-google-account-pool-section');
        if (!container)
            return;
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
        for (const key of quotaCache.keys())
            if (!keys.has(key))
                quotaCache.delete(key);
        const header = element('div', 'agy-toolbar');
        const collapse = button(`${fleetCollapsed ? '▸' : '▾'} Google account fleet · ${rows.length} account${rows.length === 1 ? '' : 's'}`, () => {
            fleetCollapsed = !fleetCollapsed;
            try {
                localStorage.setItem('agy_google_fleet_collapsed', String(fleetCollapsed));
            }
            catch { }
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
            const option = element('option', '', model.displayName || model.name);
            option.value = model.name;
            targetPool.append(option);
        }
        if (Array.from(targetPool.options).some((option) => option.value === fleetTargetPool))
            targetPool.value = fleetTargetPool;
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
        const enabledFallbacks = googleModels.filter((model) => model.googlePool?.nativeFailoverEnabled === true).length;
        fallbackInput.checked = enabledFallbacks > 0;
        fallbackInput.indeterminate = enabledFallbacks > 0 && enabledFallbacks < googleModels.length;
        fallback.append(fallbackInput, element('span', '', 'Native Google request fallback'), element('span', 'agy-muted', fallbackInput.indeterminate ? 'Some pools enabled' : fallbackInput.checked ? 'Enabled' : 'Disabled'));
        fallbackInput.addEventListener('change', async () => {
            const enabled = fallbackInput.checked;
            try {
                await runFleetAction(async () => {
                    for (const model of await storageAPI.getCustomModels()) {
                        if (model.provider !== 'google-cloudcode')
                            continue;
                        requireSuccess(await storageAPI.saveCustomModel({
                            ...model, googlePool: { ...(model.googlePool || {}), nativeFailoverEnabled: enabled },
                        }));
                    }
                });
            }
            catch { /* runFleetAction displays the persisted result and error. */ }
        });
        wrap.append(fallback, element('p', 'agy-muted', 'Each model pool keeps its own credentials, project and reported quotas. Preferred accounts are used when eligible; unknown limits are not available credit.'));
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
            identity.append(element('div', 'agy-fleet-label', accountIdentity), element('div', 'agy-muted', `${members.length} model pool${members.length === 1 ? '' : 's'}`));
            const labels = [...new Set(members.map(({ account }) => account.label?.trim()).filter((label) => !!label && label !== accountIdentity))];
            if (labels.length)
                identity.append(element('div', 'agy-muted', labels.join(' · ')));
            const activeCount = members.filter(({ account }) => account.enabled !== false).length;
            identity.append(element('span', `agy-fleet-account-state agy-pool-badge${activeCount === 0 ? ' agy-pool-disabled' : ''}`, activeCount === 0 ? 'Disabled' : activeCount === members.length ? 'Enabled' : 'Partially enabled'));
            const accountActions = element('div', 'agy-actions agy-fleet-account-actions');
            accountActions.append(button(activeCount ? 'Disable account' : 'Enable account', async () => {
                await runFleetAction(() => updateFleetAccounts(members, (account) => ({ ...account, enabled: activeCount === 0 }), true));
            }), button('Edit label', () => editFleetLabel(accountIdentity, members)), button('Remove from fleet', () => removeFleetMemberships(accountIdentity, members)));
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
                poolIdentity.append(element('h3', '', owner.displayName || owner.name), element('div', 'agy-muted', [owner.name, `Account: ${account.id}`, account.project ? `Project: ${account.project}` : ''].filter(Boolean).join(' · ')));
                const preferred = owner.googlePool?.preferredAccountId === account.id;
                const enabled = owner.enabled !== false && account.enabled !== false;
                poolHeading.append(poolIdentity, element('span', `agy-pool-badge${preferred ? ' agy-pool-preferred' : ''}`, !enabled ? 'Disabled' : preferred ? 'Preferred' : 'Automatic'));
                pool.append(poolHeading);
                const quota = element('div', 'agy-fleet-quotas');
                renderPoolQuota(quota, cached);
                const rowActions = element('div', 'agy-actions');
                const choose = button(preferred ? 'Automatic' : 'Use preferred', async () => {
                    await runFleetAction(async () => {
                        requireSuccess(await electron_1.ipcRenderer.invoke('storage:google-select-account', { modelName: owner.name, ...(preferred ? {} : { accountId: account.id }) }));
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
            for (const control of container.querySelectorAll('button,input,select')) {
                if (control !== collapse)
                    control.disabled = true;
            }
        }
        restoreScroll();
    }
    let rowMenuDismissInstalled = false;
    const selectedEffortByKey = new Map();
    const EFFORT_ORDER = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, extra: 5 };
    function shouldSkipBackgroundRefresh(target) {
        if (!target.isConnected)
            return true;
        if (document.getElementById('agy-modal-overlay'))
            return true;
        if (target.querySelector('details.agy-menu[open]'))
            return true;
        const active = document.activeElement;
        if (active && target.contains(active))
            return true;
        for (const statusEl of target.querySelectorAll('.agy-status')) {
            if (statusEl.textContent?.trim())
                return true;
        }
        return false;
    }
    async function renderCustomModelsList(options) {
        const background = Boolean(options?.background);
        const target = document.getElementById('agy-custom-models-content');
        if (!target)
            return;
        if (background && shouldSkipBackgroundRefresh(target))
            return;
        const version = ++renderVersion;
        try {
            const [models, healthMap, displaySettings] = await Promise.all([
                storageAPI.getCustomModels(),
                storageAPI.getModelHealth().catch(() => ({})),
                storageAPI.getDisplaySettings().catch(() => ({ showStatusEmoji: true })),
            ]);
            if (version !== renderVersion || !target.isConnected)
                return;
            if (background && shouldSkipBackgroundRefresh(target))
                return;
            const showStatusEmoji = displaySettings?.showStatusEmoji !== false;
            const snapshot = JSON.stringify({
                models,
                healthMap,
                showStatusEmoji,
                searchTerm,
                filterMode,
                layoutMode,
                collapsed: Array.from(collapsedGroups).sort(),
            });
            if (background && snapshot === lastRenderedSnapshot)
                return;
            const emojiToggle = document.getElementById('agy-toggle-status-emojis');
            if (emojiToggle && typeof displaySettings?.showStatusEmoji === 'boolean') {
                emojiToggle.checked = displaySettings.showStatusEmoji;
            }
            const restoreScroll = captureScrollPosition(target);
            modelList = models;
            renderGoogleFleet();
            void refreshFleetQuotas();
            const content = document.createDocumentFragment();
            const allModelsByGroupKey = new Map();
            const groups = new Map();
            for (const model of models) {
                const groupLabel = (model.providerName || '').trim() || model.provider;
                const key = `${groupLabel}\n${model.apiUrl}`;
                allModelsByGroupKey.set(key, [...(allModelsByGroupKey.get(key) || []), model]);
                if (searchTerm &&
                    !`${model.displayName} ${model.name} ${model.externalModelName} ${model.provider} ${model.providerName || ''}`
                        .toLowerCase()
                        .includes(searchTerm))
                    continue;
                if (filterMode === 'enabled' && model.enabled === false)
                    continue;
                if (filterMode === 'disabled' && model.enabled !== false)
                    continue;
                if (filterMode === 'unhealthy') {
                    const health = healthMap?.[model.name];
                    const isUnhealthy = Boolean(health) &&
                        (health.status === 'unhealthy' ||
                            health.status === 'slow' ||
                            health.status === 'cooldown' ||
                            Boolean(health.error) ||
                            (typeof health.status === 'string' && health.status !== 'healthy'));
                    if (!isUnhealthy)
                        continue;
                }
                groups.set(key, [...(groups.get(key) || []), model]);
            }
            if (!groups.size)
                content.append(element('p', 'agy-muted', models.length
                    ? 'No models match this search.'
                    : 'Add a provider model, discover a local server, or import a configuration to get started.'));
            // Keep provider groups and models in stable order so testing/using a model
            // in the middle of the modal never teleports its provider group to the top.
            const sortedGroups = Array.from(groups.values());
            for (const groupModels of sortedGroups) {
                const modelsInGroup = groupModels;
                const first = modelsInGroup[0];
                const groupDisplayName = (first.providerName || '').trim() || first.provider;
                const group = element('section', 'agy-group');
                const groupKey = `${groupDisplayName}\n${first.apiUrl}`;
                const fullGroupModels = allModelsByGroupKey.get(groupKey) || modelsInGroup;
                const collapsed = collapsedGroups.has(groupKey);
                const header = element('div', 'agy-group-heading');
                const heading = element('div');
                heading.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0';
                const titleBlock = element('div');
                titleBlock.style.minWidth = '0';
                const disclosure = element('button', 'agy-btn agy-disclosure', collapsed ? '▸' : '▾');
                disclosure.type = 'button';
                disclosure.title = collapsed ? 'Expand provider' : 'Collapse provider';
                disclosure.setAttribute('aria-expanded', String(!collapsed));
                disclosure.addEventListener('click', () => {
                    if (collapsed)
                        collapsedGroups.delete(groupKey);
                    else
                        collapsedGroups.add(groupKey);
                    void renderCustomModelsList();
                });
                titleBlock.append(element('h3', '', `${groupDisplayName}${first.providerName && first.providerName !== first.provider ? ` (${first.provider})` : ''} · ${modelsInGroup.filter((model) => model.enabled !== false).length}/${modelsInGroup.length} enabled`), element('div', 'agy-muted', first.apiUrl));
                heading.append(disclosure, titleBlock);
                const groupStatus = statusNode();
                const actions = element('div', 'agy-actions');
                actions.append(button('Discover models', () => openModelModal(first, 'discover'), groupStatus), ...(first.provider === 'custom'
                    ? [
                        button('Rename provider', () => {
                            const { body, status, close } = openModal('Rename provider group');
                            const nameInput = field(body, 'Provider name', 'agy-rename-provider', first.providerName || '');
                            nameInput.placeholder = `e.g. Agnes AI, Coarena (blank resets to ${first.provider})`;
                            const modalActions = element('div', 'agy-actions');
                            modalActions.append(button('Save', async () => {
                                const nextName = nameInput.value.trim() || undefined;
                                for (const model of fullGroupModels) {
                                    requireSuccess(await storageAPI.saveCustomModel({ ...model, providerName: nextName }));
                                }
                                await modelsChanged();
                                close();
                            }, status, true), button('Cancel', close));
                            body.append(modalActions);
                        }, groupStatus),
                    ]
                    : []));
                const allEnabled = fullGroupModels.every((model) => model.enabled !== false);
                actions.append(button(allEnabled ? 'Disable group' : 'Enable group', async () => {
                    for (const model of fullGroupModels)
                        requireSuccess(await storageAPI.saveCustomModel({ ...model, enabled: !allEnabled }));
                    await modelsChanged();
                }, groupStatus));
                header.append(heading, actions);
                group.append(header, groupStatus);
                if (collapsed) {
                    content.append(group);
                    continue;
                }
                const modelsList = element('div', animateNextLayout ? 'agy-models agy-layout-anim' : 'agy-models');
                modelsList.dataset.layout = layoutMode;
                const formatEffortLabel = (eff) => {
                    const lower = eff.toLowerCase();
                    if (lower === 'xhigh')
                        return 'XHigh';
                    if (lower === 'medium')
                        return 'Med';
                    if (lower === 'minimal')
                        return 'Min';
                    return lower.charAt(0).toUpperCase() + lower.slice(1);
                };
                const stripGroupSuffix = (name) => {
                    const trimmedGroup = groupDisplayName.trim();
                    if (!trimmedGroup)
                        return name;
                    const escaped = trimmedGroup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const stripped = name.replace(new RegExp(`\\s*\\(${escaped}\\)\\s*$`, 'i'), '').trim();
                    return stripped || name;
                };
                const slots = [];
                const effortSlots = new Map();
                for (const model of modelsInGroup) {
                    const rawName = model.displayName || model.name;
                    const cleanName = rawName.replace(/^⭐\s*/u, '').replace(/^[🟢🔴⚪🟡⭐\s•·|-]+(?:\[[^\]]+\]\s*)?[•·|-]?\s*/u, '').trim();
                    const effort = /\((minimal|low|medium|high|xhigh|extra)\)\s*$/i.exec(cleanName)?.[1];
                    const withoutEffort = effort ? cleanName.slice(0, cleanName.length - effort.length - 2).trim() : cleanName;
                    const shortName = stripGroupSuffix(withoutEffort);
                    const parsed = { model, cleanName, shortName, effort };
                    if (effort) {
                        const slotKey = `${shortName.toLowerCase()}\0${(model.externalModelName || '').toLowerCase()}\0${(model.apiUrl || '').toLowerCase()}`;
                        const existingSlot = effortSlots.get(slotKey);
                        if (existingSlot && !existingSlot.variants.some((v) => v.effort?.toLowerCase() === effort.toLowerCase())) {
                            existingSlot.variants.push(parsed);
                            continue;
                        }
                        if (!existingSlot) {
                            const created = { key: slotKey, shortName, variants: [parsed] };
                            effortSlots.set(slotKey, created);
                            slots.push(created);
                            continue;
                        }
                    }
                    slots.push({ key: model.name, shortName, variants: [parsed] });
                }
                for (const slot of slots) {
                    if (slot.variants.length > 1) {
                        slot.variants.sort((a, b) => (EFFORT_ORDER[(a.effort || '').toLowerCase()] ?? 99) -
                            (EFFORT_ORDER[(b.effort || '').toLowerCase()] ?? 99));
                    }
                    const isGrouped = slot.variants.length > 1;
                    const pickInitialVariant = () => {
                        if (!isGrouped)
                            return slot.variants[0];
                        const savedName = selectedEffortByKey.get(slot.key);
                        return (slot.variants.find((v) => v.model.name === savedName) ||
                            slot.variants.find((v) => v.effort?.toLowerCase() === 'medium' && v.model.enabled !== false) ||
                            slot.variants.find((v) => v.model.enabled !== false) ||
                            slot.variants[0]);
                    };
                    const row = element('div', 'agy-row');
                    const renderSlotRow = (active) => {
                        const { model, shortName, effort } = active;
                        if (isGrouped)
                            selectedEffortByKey.set(slot.key, model.name);
                        const health = healthMap ? healthMap[model.name] : undefined;
                        const isRecent = isGrouped
                            ? slot.variants.some((v) => Boolean(v.model.isRecent))
                            : Boolean(model.isRecent);
                        const starPrefix = isRecent && showStatusEmoji ? '⭐ ' : '';
                        const statusDot = !showStatusEmoji
                            ? ''
                            : health?.status === 'slow'
                                ? '🟡 '
                                : health?.status === 'cooldown'
                                    ? '🟡 '
                                    : !health || health.status === 'healthy'
                                        ? '🟢 '
                                        : '🔴 ';
                        const latencyText = health?.latencyMs !== undefined
                            ? health.latencyMs >= 1000
                                ? `${(health.latencyMs / 1000).toFixed(1)}s`
                                : `${health.latencyMs}ms`
                            : '';
                        const statusLabel = health?.status === 'slow'
                            ? 'Slow'
                            : health?.status === 'cooldown'
                                ? 'Cooldown (429)'
                                : health?.error
                                    ? health.error
                                    : health?.status === 'healthy'
                                        ? 'OK'
                                        : '';
                        const statusClass = health?.status === 'healthy'
                            ? 'agy-row-badge-ok'
                            : health?.status === 'slow' || health?.status === 'cooldown'
                                ? 'agy-row-badge-warn'
                                : health?.error
                                    ? 'agy-row-badge-err'
                                    : '';
                        const enabledVariantsCount = slot.variants.filter((v) => v.model.enabled !== false).length;
                        const allDisabled = enabledVariantsCount === 0;
                        row.dataset.modelName = model.name;
                        row.dataset.enabled = String(isGrouped ? !allDisabled : model.enabled !== false);
                        const info = element('div', 'agy-row-info');
                        const titleEl = element('strong', '', `${starPrefix}${statusDot}${shortName}`);
                        titleEl.title = health
                            ? health.status === 'healthy'
                                ? `Healthy${latencyText ? ` · ${latencyText}` : ''} · Checked ${new Date(health.checkedAt).toLocaleTimeString()}`
                                : health.status === 'slow'
                                    ? `Slow response (${latencyText}) · Checked ${new Date(health.checkedAt).toLocaleTimeString()}`
                                    : health.status === 'cooldown'
                                        ? `Cooldown / Rate Limit (429) · Checked ${new Date(health.checkedAt).toLocaleTimeString()}`
                                        : `Unhealthy: ${health.error || 'Failed'} · Checked ${new Date(health.checkedAt).toLocaleTimeString()}`
                            : 'Status unknown';
                        const meta = element('div', 'agy-muted agy-row-meta');
                        if (model.externalModelName)
                            meta.append(element('span', 'agy-row-slug', model.externalModelName));
                        if (isRecent) {
                            if (meta.childNodes.length)
                                meta.append(document.createTextNode(' · '));
                            meta.append(document.createTextNode('Recent'));
                        }
                        if (isGrouped && enabledVariantsCount < slot.variants.length) {
                            if (meta.childNodes.length)
                                meta.append(document.createTextNode(' · '));
                            meta.append(document.createTextNode(`${enabledVariantsCount}/${slot.variants.length} on`));
                        }
                        const rowStatus = statusNode();
                        info.append(rowStatus);
                        const actions = element('div', 'agy-row-actions');
                        const menuList = element('div', 'agy-menu-list');
                        menuList.append(button('Check', async () => {
                            setStatus(rowStatus, 'Checking…');
                            try {
                                const checkRes = await storageAPI.checkModelHealth(model.name);
                                const mHealth = checkRes[model.name];
                                if (mHealth?.status === 'healthy') {
                                    setStatus(rowStatus, `🟢 Healthy (${mHealth.latencyMs || 0}ms)`);
                                }
                                else {
                                    setStatus(rowStatus, `🔴 Unhealthy (${mHealth?.error || 'Failed'})`, true);
                                }
                                void renderCustomModelsList();
                            }
                            catch (e) {
                                setStatus(rowStatus, e?.message || 'Check failed', true);
                            }
                        }, rowStatus), button('Test', async () => {
                            setStatus(rowStatus, 'Testing…');
                            const result = requireSuccess(await storageAPI.testModelConnection(model));
                            setStatus(rowStatus, result.message || 'Connection successful.');
                        }, rowStatus), button('Test generation', () => openGenerationTest(model), rowStatus), button('Edit', () => openModelModal(model, 'edit'), rowStatus), button('Duplicate', () => openModelModal(model, 'duplicate'), rowStatus), ...(model.supportsThinking === false
                            ? []
                            : [
                                button('Effort variants', () => {
                                    const { body, status, close } = openModal('Create reasoning variants');
                                    body.append(element('p', 'agy-muted', 'Creates three copies with low, medium and high reasoning effort. The provider must support reasoning. For Google and Anthropic formats the thinking budgets are 1,024 / 4,096 / 8,192 tokens; output limits increase if needed to fit the budget. Existing models and credentials are preserved.'));
                                    body.append(button('Create three variants', async () => {
                                        requireSuccess(await electron_1.ipcRenderer.invoke('storage:create-effort-variants', model.name));
                                        close();
                                        await modelsChanged();
                                    }, status, true));
                                }, rowStatus),
                            ]), ...(isGrouped
                            ? [
                                button(allDisabled ? 'Enable all efforts' : 'Disable all efforts', async () => {
                                    const targetEnabled = allDisabled;
                                    for (const variant of slot.variants) {
                                        if ((variant.model.enabled !== false) !== targetEnabled) {
                                            requireSuccess(await storageAPI.saveCustomModel({ ...variant.model, enabled: targetEnabled }));
                                        }
                                    }
                                    await modelsChanged();
                                }, rowStatus),
                            ]
                            : []));
                        const menu = element('details', 'agy-menu');
                        const menuSummary = element('summary', 'agy-menu-btn', '⋯');
                        menuSummary.title = isGrouped && effort ? `More actions for ${shortName} (${effort})` : 'More actions';
                        menuSummary.setAttribute('aria-label', `More actions for ${shortName}${isGrouped && effort ? ` (${effort})` : ''}`);
                        const deleteButton = button('Delete', () => openDeleteModelModal(model), rowStatus);
                        deleteButton.classList.add('agy-danger');
                        menuList.append(deleteButton);
                        menu.append(menuSummary, menuList);
                        // Picking an item closes the menu again; the summary is not a button and stays unaffected.
                        menu.addEventListener('click', (event) => {
                            if (event.target.closest('button'))
                                menu.open = false;
                        });
                        menu.addEventListener('toggle', () => {
                            if (!menu.open)
                                return;
                            for (const other of target.querySelectorAll('details.agy-menu[open]')) {
                                if (other !== menu)
                                    other.open = false;
                            }
                        });
                        const makeSwitch = (targetModel, statusTarget, labelSuffix) => {
                            const isOn = targetModel.enabled !== false;
                            const btn = button(isOn ? 'Disable' : 'Enable', async () => {
                                // Optimistically animate the switch thumb immediately before IPC settles.
                                btn.setAttribute('aria-checked', String(!isOn));
                                requireSuccess(await storageAPI.saveCustomModel({ ...targetModel, enabled: !isOn }));
                                await modelsChanged();
                            }, statusTarget);
                            btn.classList.add('agy-switch');
                            btn.setAttribute('role', 'switch');
                            btn.setAttribute('aria-checked', String(isOn));
                            const srText = element('span', 'agy-sr-only', isOn ? 'Disable' : 'Enable');
                            const dot = element('span', 'agy-switch-dot');
                            btn.replaceChildren(srText, dot);
                            btn.title = `${isOn ? 'Disable' : 'Enable'}${labelSuffix ? ` ${labelSuffix}` : ''}`;
                            return btn;
                        };
                        const dotState = health?.status === 'healthy'
                            ? 'ok'
                            : health?.status === 'slow' || health?.status === 'cooldown'
                                ? 'warn'
                                : health?.error
                                    ? 'err'
                                    : 'idle';
                        const dotEl = element('span', 'agy-status-dot');
                        dotEl.dataset.s = dotState;
                        const buildEffortTabs = () => {
                            if (!isGrouped)
                                return effort ? element('span', 'agy-effort-chip', formatEffortLabel(effort)) : null;
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
                                    if (variant.model.name !== model.name)
                                        renderSlotRow(variant);
                                });
                                tabs.append(tab);
                            }
                            return tabs;
                        };
                        const toggleButton = makeSwitch(model, rowStatus, isGrouped && effort ? effort.toUpperCase() : undefined);
                        const effortControl = buildEffortTabs();
                        if (layoutMode === 'split') {
                            const splitTop = element('div', 'agy-split-top');
                            const splitTitle = element('div', 'agy-row-title');
                            splitTitle.append(titleEl);
                            actions.append(toggleButton, menu);
                            splitTop.append(splitTitle, actions);
                            const splitBot = element('div', 'agy-split-bot');
                            splitBot.append(meta, ...(effortControl ? [effortControl] : []));
                            info.replaceChildren(splitTop, splitBot);
                            if (model.nativePickerAvailable === false)
                                info.append(element('div', 'agy-muted agy-row-meta', typeof model.nativePickerError === 'string' ? model.nativePickerError :
                                    'Not currently available in the native model picker. Direct API access remains available.'));
                            info.append(rowStatus);
                            row.replaceChildren(info);
                        }
                        else if (layoutMode === 'grid') {
                            const gridTop = element('div', 'agy-grid-top');
                            const gridTitle = element('div', 'agy-row-title');
                            gridTitle.append(titleEl);
                            gridTop.append(gridTitle, menu);
                            const gridFoot = element('div', 'agy-grid-foot');
                            actions.append(toggleButton);
                            gridFoot.append(effortControl || element('span', 'agy-muted', 'Default'), actions);
                            info.replaceChildren(gridTop, meta);
                            if (model.nativePickerAvailable === false)
                                info.append(element('div', 'agy-muted agy-row-meta', typeof model.nativePickerError === 'string' ? model.nativePickerError :
                                    'Not currently available in the native model picker. Direct API access remains available.'));
                            info.append(rowStatus);
                            row.replaceChildren(info, gridFoot);
                        }
                        else if (layoutMode === 'accordion') {
                            const isExpanded = isGrouped && expandedAccordions.has(slot.key);
                            row.dataset.expanded = String(isExpanded);
                            const head = element('div', 'agy-acc-head');
                            const left = element('div', 'agy-row-title');
                            const chev = element('span', 'agy-acc-chev', isGrouped ? '▸' : '');
                            left.append(chev, titleEl);
                            if (isGrouped) {
                                left.append(element('span', 'agy-acc-count', `${enabledVariantsCount}/${slot.variants.length}`));
                            }
                            else if (effort) {
                                left.append(element('span', 'agy-effort-chip', formatEffortLabel(effort)));
                            }
                            actions.append(...(isGrouped ? [] : [toggleButton]), menu);
                            actions.addEventListener('click', (e) => e.stopPropagation());
                            head.append(left, actions);
                            if (isGrouped) {
                                head.addEventListener('click', () => {
                                    const next = !expandedAccordions.has(slot.key);
                                    if (next)
                                        expandedAccordions.add(slot.key);
                                    else
                                        expandedAccordions.delete(slot.key);
                                    row.dataset.expanded = String(next);
                                });
                            }
                            const children = [head];
                            if (isGrouped) {
                                const accBody = element('div', 'agy-acc-body');
                                const accInner = element('div', 'agy-acc-inner');
                                const accList = element('div', 'agy-acc-list');
                                for (const variant of slot.variants) {
                                    const item = element('div', 'agy-acc-item');
                                    item.dataset.enabled = String(variant.model.enabled !== false);
                                    const itemLeft = element('div');
                                    itemLeft.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0';
                                    itemLeft.append(element('span', 'agy-acc-item-name', formatEffortLabel(variant.effort || '')), ...(variant.model.externalModelName ? [element('span', 'agy-row-slug', variant.model.externalModelName)] : []));
                                    const itemRight = element('div');
                                    itemRight.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0';
                                    const editBtn = document.createElement('button');
                                    editBtn.type = 'button';
                                    editBtn.className = 'agy-acc-link';
                                    editBtn.textContent = 'Edit';
                                    editBtn.addEventListener('click', () => openModelModal(variant.model, 'edit'));
                                    const testBtn = document.createElement('button');
                                    testBtn.type = 'button';
                                    testBtn.className = 'agy-acc-link';
                                    testBtn.textContent = 'Test';
                                    testBtn.addEventListener('click', () => openGenerationTest(variant.model));
                                    itemRight.append(editBtn, testBtn, makeSwitch(variant.model, rowStatus, variant.effort));
                                    item.append(itemLeft, itemRight);
                                    accList.append(item);
                                }
                                accInner.append(accList);
                                accBody.append(accInner);
                                children.push(accBody);
                            }
                            info.replaceChildren(...children, rowStatus);
                            row.replaceChildren(info);
                        }
                        else {
                            // Default: 'linear' — clean divided row with title + slug + segmented effort + switch + menu
                            const linTitle = element('div', 'agy-row-title');
                            linTitle.append(titleEl);
                            info.replaceChildren(linTitle, meta);
                            if (model.nativePickerAvailable === false)
                                info.append(element('div', 'agy-muted agy-row-meta', typeof model.nativePickerError === 'string' ? model.nativePickerError :
                                    'Not currently available in the native model picker. Direct API access remains available.'));
                            info.append(rowStatus);
                            actions.append(...(effortControl ? [effortControl] : []), toggleButton, menu);
                            row.replaceChildren(info, actions);
                        }
                    };
                    renderSlotRow(pickInitialVariant());
                    modelsList.append(row);
                }
                group.append(modelsList);
                content.append(group);
            }
            animateNextLayout = false;
            target.replaceChildren(content);
            lastRenderedSnapshot = snapshot;
            restoreScroll();
        }
        catch (error) {
            setStatus(target, error instanceof Error ? error.message : 'Could not load custom models.', true);
        }
    }
    async function openModelModal(existing, mode = 'edit') {
        const { body, status, close } = openModal(mode === 'duplicate'
            ? 'Duplicate model'
            : mode === 'discover'
                ? 'Discover provider models'
                : existing
                    ? 'Edit model'
                    : 'Add custom model');
        try {
            const presets = await storageAPI.getPresets();
            if (!body.isConnected)
                return;
            const providers = [...presets];
            if (existing && !providers.some((preset) => preset.id === existing.provider))
                providers.push({
                    id: existing.provider,
                    label: existing.provider,
                    defaultUrl: existing.apiUrl,
                    apiFormat: existing.apiFormat || 'openai',
                    keyRequired: false,
                });
            if (!providers.length)
                throw new Error('Provider presets are unavailable. Close this dialog and try again.');
            const provider = selectField(body, 'Provider', 'agy-provider', providers.map((preset) => [preset.id, preset.label]), existing?.provider || providers[0].id);
            const providerNameInput = field(body, 'Provider name (optional, for grouping)', 'agy-provider-name', existing?.providerName || '');
            providerNameInput.placeholder = 'e.g. Agnes AI, Coarena';
            const updateProviderNameVisibility = () => {
                const label = providerNameInput.closest('label');
                if (label)
                    label.hidden = provider.value !== 'custom';
            };
            updateProviderNameVisibility();
            const preset = () => providers.find((value) => value.id === provider.value) || providers[0];
            const apiUrl = field(body, 'API URL', 'agy-api-url', existing?.apiUrl || preset().defaultUrl, 'url');
            const workersHint = element('p', 'agy-muted', 'Cloudflare: replace ACCOUNT_ID in the API URL with your 32-character Account ID. Use the Workers AI API token template, or keep your existing authentication headers. Model discovery verifies catalog access; generation is not tested.');
            body.append(workersHint);
            function workersConnection() {
                if (provider.value === 'workers-ai')
                    return true;
                try {
                    const url = new URL(apiUrl.value);
                    return url.origin === 'https://api.cloudflare.com' && /^\/client\/v4\/accounts\//.test(url.pathname);
                }
                catch {
                    return false;
                }
            }
            const updateWorkersHint = () => {
                workersHint.hidden = !workersConnection();
            };
            apiUrl.addEventListener('input', updateWorkersHint);
            updateWorkersHint();
            const apiKey = field(body, 'API key', 'agy-api-key', existing?.apiKey === 'none' ? '' : existing?.apiKey || '', 'password');
            apiKey.placeholder = preset().keyRequired ? 'Enter provider API key' : 'Optional for local servers';
            const opencodeAuth = selectField(body, 'OpenCode authentication', 'agy-opencode-auth', [['auth', 'API key'], ['noAuth', 'Keyless request']], existing?.apiKey && existing.apiKey !== 'none' ? 'auth' : 'noAuth');
            const opencodeHint = element('p', 'agy-muted', 'OpenCode may restrict keyless free models to its own app. If the service rejects this client, add an API key or choose another model/provider.');
            body.append(opencodeHint);
            const isOpencode = () => ['opencode', 'zen'].includes(provider.value) || (() => {
                try {
                    const url = new URL(apiUrl.value);
                    return url.origin === 'https://opencode.ai' && !/\/(?:zen|inference)\/go\//.test(url.pathname);
                }
                catch {
                    return false;
                }
            })();
            const keylessOpencode = () => isOpencode() && opencodeAuth.value === 'noAuth';
            const updateOpencodeAuth = () => {
                opencodeAuth.closest('label').hidden = !isOpencode();
                opencodeHint.hidden = !isOpencode();
                apiKey.closest('label').hidden = provider.value === 'google-cloudcode' || keylessOpencode();
            };
            opencodeAuth.addEventListener('change', updateOpencodeAuth);
            apiUrl.addEventListener('input', updateOpencodeAuth);
            updateOpencodeAuth();
            const apiFormat = selectField(body, 'API format', 'agy-api-format', [
                ['openai', 'OpenAI compatible'],
                ['anthropic', 'Anthropic Messages'],
                ['google', 'Google Gemini'],
            ], existing?.apiFormat || preset().apiFormat);
            const grid = element('div', 'agy-grid');
            const modelId = field(grid, 'Provider model ID', 'agy-model-id', mode === 'discover' ? '' : existing?.externalModelName || '');
            const cleanExistingDisplayName = (existing?.displayName || '')
                .replace(/^[🟢🔴⚪🟡⭐\s•·|-]+(?:\[[^\]]+\]\s*)?[•·|-]?\s*/u, '')
                .trim();
            const displayName = field(grid, 'Display name', 'agy-display-name', mode === 'duplicate'
                ? `${cleanExistingDisplayName || existing?.externalModelName || ''} copy`
                : mode === 'discover'
                    ? ''
                    : cleanExistingDisplayName);
            body.append(grid);
            const name = field(body, 'Configuration name (unique)', 'agy-model-name', mode === 'duplicate' ? uniqueName(`${existing?.name}-copy`) : mode === 'discover' ? '' : existing?.name || '');
            name.placeholder = 'Generated from provider and model ID when left blank';
            const description = field(body, 'Description', 'agy-description', String(existing?.description || ''));
            const googleConfig = element('div');
            googleConfig.id = 'agy-google-account-config';
            const googleProject = field(googleConfig, 'Default Cloud Code project (optional)', 'agy-google-project', String(existing?.googleProject || ''));
            const initialPool = existing?.googlePool;
            const poolGrid = element('div', 'agy-grid');
            const poolStrategy = selectField(poolGrid, 'Account selection', 'agy-google-pool-strategy', [
                ['round-robin', 'Round robin'],
                ['least-loaded', 'Least loaded'],
                ['quota', 'Remaining quota'],
                ['adaptive', 'Adaptive health and load'],
            ], initialPool?.strategy || 'least-loaded');
            const poolConcurrency = field(poolGrid, 'Maximum requests per account', 'agy-google-pool-concurrency', String(initialPool?.maxConcurrency || 2), 'number');
            const poolCooldown = field(poolGrid, 'Account cooldown (milliseconds)', 'agy-google-pool-cooldown', String(initialPool?.cooldownMs || 60000), 'number');
            const nativeFailover = selectField(poolGrid, 'Native Google request fallback', 'agy-google-native-failover', [['false', 'Off'], ['true', 'Use this pool for matching native models']], String(initialPool?.nativeFailoverEnabled === true));
            googleConfig.append(poolGrid);
            googleConfig.append(element('p', 'agy-muted', 'Optional fallback uses this saved Google account pool only when a native request for the exact provider model fails. It does not change your signed-in IDE account.'));
            const readAccounts = createGoogleAccountPanel(googleConfig, Array.isArray(existing?.googleAccounts) ? existing.googleAccounts : [], existing?.name);
            const updateGoogleVisibility = () => {
                const isGoogle = provider.value === 'google-cloudcode';
                googleConfig.hidden = !isGoogle;
                updateOpencodeAuth();
                apiFormat.closest('label').hidden = isGoogle;
            };
            updateGoogleVisibility();
            body.append(googleConfig);
            const advanced = element('details');
            advanced.append(element('summary', '', 'Advanced settings'));
            const advancedGrid = element('div', 'agy-grid');
            const effort = selectField(advancedGrid, 'Reasoning effort', 'agy-reasoning-effort', ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => [
                value,
                value || 'Provider default',
            ]), String(existing?.reasoningEffort || ''));
            const thinking = field(advancedGrid, 'Thinking budget (tokens)', 'agy-thinking-budget', existing?.thinkingBudget != null ? String(existing.thinkingBudget) : '', 'number');
            const compactionEffort = selectField(advancedGrid, 'Compaction reasoning effort', 'agy-compaction-effort', ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => [
                value,
                value || 'Use normal model settings',
            ]), String(existing?.compactionReasoningEffort || ''));
            advancedGrid.append(element('p', 'agy-muted', 'Only recognized IDE continuation summaries use this effort. Choose low for faster summaries, or none if your model supports disabling reasoning. Normal chat keeps its settings.'));
            const maxOutput = field(advancedGrid, 'Maximum output tokens', 'agy-max-output', existing?.maxOutputTokens != null ? String(existing.maxOutputTokens) : '', 'number');
            const context = field(advancedGrid, 'Context window (tokens)', 'agy-context-window', existing?.contextWindow != null ? String(existing.contextWindow) : '', 'number');
            const compactionThreshold = field(advancedGrid, 'IDE compaction threshold (%)', 'agy-compaction-threshold', existing?.compactionThresholdPercent != null ? String(existing.compactionThresholdPercent) : '', 'number');
            compactionThreshold.min = '10';
            compactionThreshold.max = '90';
            compactionThreshold.placeholder = '80';
            advancedGrid.append(element('p', 'agy-muted', 'Optional, 10–90% of the actual context window in new tokens since the previous checkpoint. Leave blank to use 80% of a context window you set above; without a context window the IDE keeps its own 50,000-token default. Native counts may differ from provider totals, and a high value can trim older history before a full checkpoint. The threshold is capped to reserve the model output limit plus 1,024 tokens. Set accurate context and output limits, then fully quit and reopen the IDE; the model cache may take an additional turn to refresh.'));
            advancedGrid.append(element('p', 'agy-muted', 'IDE 2.5.5 needs at least 50,000 input tokens after those reserves. Its native picker may show a compatibility context, for example 90,000 for a real 85,000-token model. Your saved context and provider limit remain 85,000 in that example, and the custom checkpoint policy uses that real limit.'));
            const timeout = field(advancedGrid, 'Request timeout (milliseconds)', 'agy-timeout', existing?.timeout != null ? String(existing.timeout) : '', 'number');
            const retries = field(advancedGrid, 'Maximum retries (0–5)', 'agy-max-retries', existing?.maxRetries != null ? String(existing.maxRetries) : '', 'number');
            retries.max = '5';
            const vision = selectField(advancedGrid, 'Image input', 'agy-vision', [
                ['', 'Auto detect'],
                ['true', 'Supported'],
                ['false', 'Unsupported'],
            ], existing?.supportsVision == null ? '' : String(existing.supportsVision));
            const rawUrl = selectField(advancedGrid, 'Endpoint path', 'agy-raw-url', [
                ['false', 'Normalize for provider'],
                ['true', 'Use exactly as entered'],
            ], String(existing?.rawUrl === true));
            const tls = selectField(advancedGrid, 'TLS certificates', 'agy-tls', [
                ['false', 'Verify certificates'],
                ['true', 'Allow self-signed certificates'],
            ], String(existing?.allowUnauthorized === true));
            const enabled = selectField(advancedGrid, 'Model state', 'agy-enabled', [
                ['true', 'Enabled'],
                ['false', 'Disabled'],
            ], String(existing?.enabled !== false));
            advanced.append(advancedGrid);
            const fallbacks = field(advanced, 'Fallback model configuration names (comma separated)', 'agy-fallback-models', Array.isArray(existing?.fallbackModels) ? existing.fallbackModels.join(', ') : '');
            const headers = jsonField(advanced, 'Custom headers (JSON)', 'agy-custom-headers', existing?.customHeaders);
            const extraBody = jsonField(advanced, 'Additional request fields (JSON)', 'agy-extra-body', existing?.extraBody);
            const systemPrompt = textAreaField(advanced, 'System prompt (added after Antigravity’s own instructions)', 'agy-system-prompt', existing?.systemPrompt, 'For example: Always answer in Turkish.');
            const breaker = existing?.circuitBreaker;
            const breakerGrid = element('div', 'agy-grid');
            const breakerEnabled = selectField(breakerGrid, 'Circuit breaker', 'agy-breaker-enabled', [
                ['', 'Default'],
                ['true', 'Enabled'],
                ['false', 'Disabled'],
            ], breaker?.enabled == null ? '' : String(breaker.enabled));
            const breakerThreshold = field(breakerGrid, 'Failures before cooldown', 'agy-breaker-threshold', breaker?.failureThreshold != null ? String(breaker.failureThreshold) : '', 'number');
            const breakerCooldown = field(breakerGrid, 'Cooldown (milliseconds)', 'agy-breaker-cooldown', breaker?.cooldownMs != null ? String(breaker.cooldownMs) : '', 'number');
            advanced.append(breakerGrid);
            body.append(advanced);
            const discovery = element('div', 'agy-discovery');
            const discoveryFilter = element('div');
            discoveryFilter.hidden = true;
            const discoverySearch = field(discoveryFilter, 'Search provider models', 'agy-discovery-search', '', 'search');
            discoverySearch.placeholder = 'Filter by model name or ID';
            discoverySearch.addEventListener('input', () => showChoices());
            let choices = [];
            const selected = new Set();
            function hasWorkersAuthentication(customHeaders) {
                const authentication = Object.fromEntries(Object.entries(customHeaders || {}).map(([key, value]) => [
                    key.toLowerCase(),
                    typeof value === 'string' ? value.trim() : '',
                ]));
                return !!((apiKey.value.trim() && apiKey.value.trim() !== 'none') ||
                    authentication.authorization ||
                    (authentication['x-auth-key'] && authentication['x-auth-email']));
            }
            function connection() {
                const endpoint = validUrl(apiUrl.value);
                const customHeaders = readJson(headers, 'Custom headers');
                if (workersConnection()) {
                    if (!/^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1(?:\/chat\/completions)?\/?$/i.test(new URL(endpoint).pathname))
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
            function modelConfig(id, title, localName) {
                if (!id.trim() || /\s/.test(id.trim()))
                    throw new Error('Enter a model ID without spaces.');
                if (preset().keyRequired && !keylessOpencode() && !apiKey.value.trim() && !workersConnection())
                    throw new Error('Enter an API key for this provider.');
                if (provider.value === 'google-cloudcode' && !readAccounts().some((account) => account.enabled !== false))
                    throw new Error('Add and enable at least one Google account.');
                const maxRetries = readNumber(retries, 'Maximum retries');
                if (maxRetries != null && maxRetries > 5)
                    throw new Error('Maximum retries cannot exceed 5.');
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
                    displayName: (title || id.trim())
                        .replace(/^[🟢🔴⚪🟡⭐\s•·|-]+(?:\[[^\]]+\]\s*)?[•·|-]?\s*/u, '')
                        .trim() || id.trim(),
                    description: description.value.trim(),
                    enabled: enabled.value === 'true',
                    apiFormat: apiFormat.value,
                    googleAccounts: provider.value === 'google-cloudcode' ? readAccounts() : undefined,
                    googleProject: provider.value === 'google-cloudcode' ? googleProject.value.trim() || undefined : undefined,
                    googlePool: provider.value === 'google-cloudcode'
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
                    circuitBreaker: breakerEnabled.value || breakerThreshold.value || breakerCooldown.value
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
            function showChoices() {
                discovery.replaceChildren();
                discoveryFilter.hidden = !choices.length;
                if (!choices.length)
                    return;
                const query = discoverySearch.value.trim().toLowerCase();
                const visible = choices.filter((model) => `${model.displayName || ''} ${model.id}`.toLowerCase().includes(query));
                const toolbar = element('div', 'agy-actions');
                const count = element('span', 'agy-muted', `${visible.length} of ${choices.length} models · ${selected.size} selected`);
                toolbar.append(count, button(query ? 'Select filtered' : 'Select all', () => {
                    for (const model of visible)
                        selected.add(model.id);
                    showChoices();
                }, status), button('Clear selection', () => {
                    selected.clear();
                    showChoices();
                }, status));
                discovery.append(toolbar);
                if (!visible.length)
                    discovery.append(element('p', 'agy-muted', 'No provider models match this search.'));
                for (const model of visible) {
                    const label = element('label', 'agy-choice');
                    const checkbox = element('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = selected.has(model.id);
                    checkbox.addEventListener('change', () => {
                        if (checkbox.checked)
                            selected.add(model.id);
                        else
                            selected.delete(model.id);
                        count.textContent = `${visible.length} of ${choices.length} models · ${selected.size} selected`;
                    });
                    label.append(checkbox, element('span', '', model.displayName && model.displayName !== model.id ? `${model.displayName} · ${model.id}` : model.id));
                    discovery.append(label);
                }
            }
            const actions = element('div', 'agy-actions');
            actions.append(button('Test connection', async () => {
                setStatus(status, 'Testing…');
                const result = requireSuccess(await storageAPI.testModelConnection(connection()));
                setStatus(status, result.message || 'Connection successful.');
            }, status), button('Test generation (may incur charges)', async () => {
                setStatus(status, 'Sending a short generation test…');
                const result = requireSuccess(await storageAPI.testModelGeneration(connection()));
                setStatus(status, result.message || 'Generation succeeded.');
            }, status), button('Fetch provider models', async () => {
                setStatus(status, 'Fetching models…');
                const result = await storageAPI.discoverModels(connection());
                requireSuccess(result);
                choices = result.models || [];
                discoverySearch.value = '';
                selected.clear();
                showChoices();
                setStatus(status, choices.length
                    ? 'Select models below, then choose Add selected.'
                    : 'This provider returned no models. You can enter a model ID manually.');
            }, status), button('Save model', async () => {
                requireSuccess(await storageAPI.saveCustomModel(modelConfig(modelId.value, displayName.value.trim())));
                await modelsChanged();
                close();
            }, status, true));
            body.append(actions, discoveryFilter, discovery);
            body.append(button('Add selected', async () => {
                if (!selected.size)
                    throw new Error('Select at least one model from the fetched list.');
                let saved = 0;
                for (const choice of choices.filter((model) => selected.has(model.id))) {
                    const prior = modelList.find((model) => model.provider === provider.value &&
                        model.apiUrl === apiUrl.value.trim() &&
                        model.externalModelName === choice.id);
                    const config = modelConfig(choice.id, choice.displayName || choice.id, prior?.name || uniqueName(`models/${provider.value}/${choice.id}`));
                    // Prefer explicit form overrides; otherwise retain the catalog's advertised limits/capabilities.
                    for (const key of ['contextWindow', 'maxOutputTokens', 'supportsVision', 'supportsThinking']) {
                        if (config[key] === undefined && choice[key] !== undefined)
                            config[key] = choice[key];
                    }
                    if (typeof config.contextWindow === 'number' &&
                        typeof config.maxOutputTokens === 'number' &&
                        config.maxOutputTokens >= config.contextWindow &&
                        !maxOutput.value.trim()) {
                        config.maxOutputTokens = config.contextWindow > 1 ? config.contextWindow - 1 : undefined;
                    }
                    delete config.originalName;
                    if (prior)
                        config.originalName = prior.name;
                    else if (existing?.name)
                        config.copyFrom = existing.name;
                    requireSuccess(await storageAPI.saveCustomModel(config));
                    saved++;
                }
                await modelsChanged();
                setStatus(status, `Saved ${saved} models.`);
            }, status));
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
        }
        catch (error) {
            setStatus(status, error instanceof Error ? error.message : 'Could not open model settings.', true);
        }
    }
    async function openImportExport(kind) {
        const { body, status } = openModal(kind === 'export' ? 'Export models' : 'Import models');
        body.append(element('p', 'agy-muted', kind === 'export'
            ? 'Credentials are removed from this export. Add API keys on the destination device.'
            : 'Paste a model configuration as JSON or an exported base64 string. Existing configurations are merged by name.'));
        const input = jsonField(body, 'Configuration', 'agy-config-json', undefined);
        input.rows = 14;
        if (kind === 'export') {
            input.readOnly = true;
            try {
                input.value = JSON.stringify(await electron_1.ipcRenderer.invoke('storage:export-custom-models'), null, 2);
            }
            catch (error) {
                setStatus(status, String(error), true);
            }
            const actions = element('div', 'agy-actions');
            actions.append(button('Select all', () => {
                input.focus();
                input.select();
            }, status), button('Copy JSON', async () => {
                await navigator.clipboard.writeText(input.value);
                setStatus(status, 'Configuration copied.');
            }, status));
            body.append(actions);
        }
        else {
            const file = field(body, 'Or choose a JSON file', 'agy-import-file', '', 'file');
            file.accept = '.json,application/json';
            file.addEventListener('change', async () => {
                try {
                    const selected = file.files?.[0];
                    if (!selected)
                        return;
                    if (selected.size > 2 * 1024 * 1024)
                        throw new Error('Configuration files must be smaller than 2 MB.');
                    input.value = await selected.text();
                }
                catch (error) {
                    setStatus(status, String(error), true);
                }
            });
            body.append(button('Import configuration', async () => {
                if (!input.value.trim())
                    throw new Error('Paste a configuration or choose a file first.');
                const result = requireSuccess(await electron_1.ipcRenderer.invoke('storage:import-custom-models', input.value.trim()));
                await modelsChanged();
                setStatus(status, `Imported ${result.count ?? 0} models. Add any missing API keys before use.`);
            }, status, true));
        }
    }
    async function discoverLocal() {
        const { body, status } = openModal('Local model servers');
        setStatus(status, 'Checking Ollama, LM Studio and llama.cpp on this computer…');
        try {
            const result = (await electron_1.ipcRenderer.invoke('storage:discover-local'));
            requireSuccess(result);
            if (!body.isConnected)
                return;
            setStatus(status, result.servers?.length
                ? 'Choose a server to configure its models.'
                : 'No local model servers were found. Start a server or add its URL manually.');
            for (const server of result.servers || []) {
                const row = element('div', 'agy-row');
                row.append(element('span', '', `${server.provider} · ${server.models.length} models`), element('div', 'agy-muted', server.apiUrl), button('Configure', () => openModelModal({ name: '', provider: server.provider, apiUrl: server.apiUrl, apiKey: 'none', externalModelName: '' }, 'discover'), status));
                body.append(row);
            }
        }
        catch (error) {
            setStatus(status, String(error), true);
        }
    }
    function openGenerationTest(model) {
        const { body, status } = openModal('Test model generation');
        body.append(element('p', '', `Model: ${model.displayName || model.externalModelName || model.name}`));
        body.append(element('p', 'agy-muted', 'Sends one “Reply with OK.” request with a 1024-token output limit using this model’s saved settings. Your provider may charge for the request. No conversation content is sent.'));
        body.append(button('Run generation test', async () => {
            setStatus(status, 'Sending a short generation test…');
            const result = requireSuccess(await storageAPI.testModelGeneration(model));
            setStatus(status, result.message || 'Generation succeeded.');
        }, status, true));
    }
    async function openDiagnostics() {
        const { body, status } = openModal('Proxy diagnostics');
        body.append(element('p', 'agy-muted', 'Measured requests from this proxy process only; restarting clears the history. Up to 200 completed requests are retained. Prompts, responses, URLs and credentials are not recorded. Gateway requests have separate history in its dashboard.'));
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
        let snapshot;
        const token = (value) => (typeof value === 'number' ? value.toLocaleString() : 'unknown');
        const render = () => {
            if (!snapshot)
                return;
            const s = snapshot.summary;
            summary.replaceChildren(element('p', '', `${s.requests} completed · ${snapshot.active} active · ${s.succeeded} succeeded · ${s.failed} failed · ${s.cancelled} cancelled`));
            summary.append(element('p', 'agy-muted', s.measuredRequests
                ? `Provider-reported tokens: ${token(s.measuredInputRequests ? s.inputTokens : undefined)} input · ${token(s.measuredOutputRequests ? s.outputTokens : undefined)} output · ${token(s.measuredCachedRequests ? s.cachedTokens : undefined)} cached. Usage received for ${s.measuredRequests} of ${s.requests} requests; totals exclude unknown usage.`
                : 'Token usage: unknown. No provider-reported usage received yet.'));
            recent.replaceChildren();
            if (snapshot.recentModels.length)
                recent.append(element('p', 'agy-muted', `Recently used: ${snapshot.recentModels.join(' · ')}`));
            list.replaceChildren();
            const query = search.value.trim().toLowerCase();
            const rows = snapshot.requests.filter((r) => `${r.model} ${r.provider}`.toLowerCase().includes(query));
            if (!rows.length)
                list.append(element('p', 'agy-muted', 'No matching requests recorded.'));
            for (const r of rows) {
                const row = element('div', 'agy-row');
                row.append(element('strong', '', `${r.model} · ${r.provider}`));
                row.append(element('div', 'agy-muted', `${new Date(r.timestamp).toLocaleTimeString()} · ${r.outcome}${r.status ? ` (HTTP ${r.status})` : ''} · ${r.latencyMs} ms · ${r.kind === 'generation-test' ? 'generation test' : r.stream ? 'streaming' : 'request'}`));
                row.append(element('div', 'agy-muted', `Tokens: ${token(r.inputTokens)} input · ${token(r.outputTokens)} output · ${token(r.cachedTokens)} cached`));
                list.append(row);
            }
        };
        const refresh = async () => {
            snapshot = await electron_1.ipcRenderer.invoke('storage:get-diagnostics');
            requireSuccess(snapshot);
            if (body.isConnected)
                render();
        };
        search.addEventListener('input', render);
        const actions = element('div', 'agy-actions');
        actions.append(button('Refresh diagnostics', refresh, status), button('Export diagnostics', () => {
            output.value = JSON.stringify(snapshot, null, 2);
            output.hidden = false;
            output.focus();
            output.select();
        }, status), button('Clear diagnostic history', async () => {
            requireSuccess(await electron_1.ipcRenderer.invoke('storage:clear-diagnostics'));
            output.value = '';
            output.hidden = true;
            await refresh();
        }, status));
        body.append(summary, recent, actions, output, list);
        await refresh();
    }
    async function openPromptSections() {
        const { body, status, close } = openModal('System prompt sections');
        try {
            const data = (await electron_1.ipcRenderer.invoke('storage:get-prompt-sections'));
            if (!body.isConnected)
                return;
            requireSuccess(data);
            body.append(element('p', 'agy-muted', 'Customize static sections of Antigravity’s system prompt (<identity>, <guidelines>, etc.). Dynamic sections like active workspaces, tools, and skills are preserved automatically.'));
            const sectionLabels = {
                identity: 'Identity (<identity>)',
                guidelines: 'Behavior & Security Guidelines (<guidelines>)',
                communication_style: 'Communication Style (<communication_style>)',
                artifacts: 'Artifacts Instruction (<artifacts>)',
                messaging: 'Messaging & Reactive Wakeup (<messaging>)',
                conversation_transcript: 'Transcript Format (<conversation_transcript>)',
            };
            const textareas = new Map();
            const checkboxes = new Map();
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
                const area = textAreaField(details, 'Content (leave empty to use default)', `agy-prompt-section-${tag}`, currentCustom, defaultText);
                area.rows = 8;
                textareas.set(tag, area);
                const sectionToolbar = element('div', 'agy-actions');
                sectionToolbar.append(button('Use default as template', () => {
                    area.value = defaultText;
                }), button('Clear override', () => {
                    area.value = '';
                }));
                details.append(sectionToolbar);
                body.append(details);
            }
            const actions = element('div', 'agy-actions');
            actions.append(button('Save prompt settings', async () => {
                const overrides = {};
                const enabled = {};
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
                requireSuccess(await electron_1.ipcRenderer.invoke('storage:save-prompt-sections', {
                    overrides,
                    enabled,
                }));
                setStatus(status, 'System prompt sections saved successfully.');
            }, status, true), button('Reset all to default', async () => {
                requireSuccess(await electron_1.ipcRenderer.invoke('storage:reset-prompt-sections'));
                for (const tag of data.tags) {
                    const area = textareas.get(tag);
                    if (area)
                        area.value = '';
                    const chk = checkboxes.get(tag);
                    if (chk)
                        chk.checked = true;
                }
                setStatus(status, 'All sections reset to defaults.');
            }, status), button('Close', close));
            body.append(actions);
        }
        catch (error) {
            if (body.isConnected)
                setStatus(status, error instanceof Error ? error.message : String(error), true);
        }
    }
    async function openGateway() {
        const { body, status } = openModal('Remote gateway');
        try {
            const saved = (await electron_1.ipcRenderer.invoke('storage:get-gateway'));
            if (!body.isConnected)
                return;
            body.append(element('p', 'agy-muted', 'Connect to your proxy gateway to import its model aliases and open its management dashboard.'));
            const url = field(body, 'Gateway URL', 'agy-gateway-url', saved?.url || '', 'url');
            const token = field(body, 'Gateway token', 'agy-gateway-token', saved?.token || '', 'password');
            const dashboard = field(body, 'Dashboard URL (optional)', 'agy-dashboard-url', saved?.dashboardUrl || '', 'url');
            const config = () => ({
                url: validUrl(url.value),
                token: token.value.trim(),
                dashboardUrl: dashboard.value.trim() ? validUrl(dashboard.value) : '',
            });
            const save = async () => {
                requireSuccess(await electron_1.ipcRenderer.invoke('storage:save-gateway', config()));
            };
            const actions = element('div', 'agy-actions');
            actions.append(button('Save connection', async () => {
                await save();
                setStatus(status, 'Gateway connection saved.');
            }, status, true), button('Test gateway', async () => {
                setStatus(status, 'Connecting…');
                const result = requireSuccess(await electron_1.ipcRenderer.invoke('storage:test-gateway', config()));
                setStatus(status, result.message || 'Gateway reachable and authentication accepted.');
            }, status), button('Import model aliases', async () => {
                await save();
                const result = requireSuccess(await electron_1.ipcRenderer.invoke('storage:import-gateway-models'));
                await modelsChanged();
                setStatus(status, `Imported ${result.count ?? 0} gateway models.`);
            }, status), button('Open dashboard', async () => {
                await save();
                requireSuccess(await electron_1.ipcRenderer.invoke('storage:open-gateway-dashboard'));
            }, status));
            body.append(actions);
        }
        catch (error) {
            setStatus(status, String(error), true);
        }
    }
    function findSettingsMount() {
        // Desktop settings are a modal over /c/...; older layouts use a settings route.
        // A chat span saying "MCP" is not evidence that the settings page is open.
        const settingsRoot = Array.from(document.querySelectorAll('[role="dialog"][aria-label="Settings"],.settings-modal-container,[data-testid="settings-view"],[data-testid="settings-panel"]')).find(isSettingsContent);
        const settingsRoute = /^\/settings(?:\/|$)/i.test(window.location.pathname) || /^#\/?settings(?:\/|\?|$)/i.test(window.location.hash);
        const root = settingsRoot || (settingsRoute ? document.body : null);
        if (!root)
            return null;
        const headings = Array.from(root.querySelectorAll('h1,h2,h3,h4,[role="heading"],div,span'));
        const heading = headings.find((node) => node.children.length === 0 &&
            /^(Models\s*(?:&|and)\s*Usage|Model Settings|MCP Servers|MCP)$/i.test(node.textContent?.trim() || '') &&
            isSettingsContent(node));
        if (heading) {
            const section = heading.closest('section');
            if (section && root.contains(section))
                return section;
            const panel = heading.closest('[role="tabpanel"]');
            if (panel && root.contains(panel))
                return panel;
            let content = heading;
            while (content.parentElement && content.parentElement !== root) {
                if (content.parentElement.classList.contains('overflow-y-auto'))
                    return content;
                content = content.parentElement;
            }
            const fallback = heading.parentElement?.parentElement || heading.parentElement;
            return fallback && root.contains(fallback) ? fallback : root;
        }
        const refresh = findRefreshButton(root);
        const legacy = refresh?.parentElement?.parentElement?.parentElement;
        if (legacy &&
            root.contains(legacy) &&
            isSettingsContent(legacy) &&
            /MCP|Model Context Protocol/i.test(legacy.textContent || ''))
            return legacy;
        return null;
    }
    function injectCustomModelsSection() {
        const mount = findSettingsMount();
        const existing = document.getElementById('agy-custom-models-section');
        if (existing && mount && existing.parentElement === mount)
            return;
        existing?.remove();
        if (!mount)
            return;
        installStyles();
        const section = element('section');
        section.id = 'agy-custom-models-section';
        section.setAttribute('aria-label', 'Custom Models');
        const header = element('div', 'agy-toolbar');
        const addModel = button('Add model', () => openModelModal(), undefined, true);
        addModel.id = 'agy-add-model';
        header.append(element('h2', '', 'Custom Models'), addModel);
        const actions = element('div', 'agy-actions');
        actions.append(button('Discover local', discoverLocal), button('Check health', async () => {
            setStatus(status, 'Checking health of all models…');
            try {
                await storageAPI.checkModelHealth();
                setStatus(status, 'Health check complete.');
                void renderCustomModelsList();
            }
            catch (e) {
                setStatus(status, e?.message || 'Health check failed', true);
            }
        }), button('Import', () => openImportExport('import')), button('Export', () => openImportExport('export')), button('System Prompt', openPromptSections), button('Remote gateway', openGateway), button('Diagnostics', openDiagnostics));
        const optionsRow = element('div', 'agy-options-row');
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
                setStatus(status, enabled
                    ? 'Status emojis enabled for model names.'
                    : 'Status emojis disabled. Model names will show without emojis.');
                await modelsChanged();
            }
            catch (err) {
                setStatus(status, 'Failed to save display setting', true);
            }
        });
        emojiToggleLabel.append(emojiToggleCheckbox, document.createTextNode('Show status emojis before model names (🟢 • name)'));
        optionsRow.append(emojiToggleLabel);
        storageAPI.getDisplaySettings().then((settings) => {
            if (settings && typeof settings.showStatusEmoji === 'boolean') {
                emojiToggleCheckbox.checked = settings.showStatusEmoji;
            }
        }).catch(() => { });
        const bar = element('div', 'agy-sticky-bar');
        bar.setAttribute('role', 'search');
        const search = field(bar, 'Search models', 'agy-model-search', searchTerm, 'search');
        search.placeholder = 'Search name, model ID or provider';
        search.addEventListener('input', () => {
            searchTerm = search.value.trim().toLowerCase();
            void renderCustomModelsList();
        });
        const chips = element('div', 'agy-actions');
        const filters = [
            ['all', 'All'],
            ['enabled', 'Enabled'],
            ['disabled', 'Disabled'],
            ['unhealthy', 'Unhealthy'],
        ];
        const chipButtons = new Map();
        for (const [mode, label] of filters) {
            const chip = element('button', 'agy-chip', label);
            chip.type = 'button';
            chip.setAttribute('aria-pressed', String(filterMode === mode));
            chip.addEventListener('click', () => {
                filterMode = mode;
                for (const [key, node] of chipButtons)
                    node.setAttribute('aria-pressed', String(key === mode));
                void renderCustomModelsList();
            });
            chipButtons.set(mode, chip);
            chips.append(chip);
        }
        const layoutBar = element('div', 'agy-layout-switcher');
        layoutBar.setAttribute('role', 'group');
        layoutBar.setAttribute('aria-label', 'Model list layout');
        const layouts = [
            ['linear', 'List', 'Linear list'],
            ['split', 'Split', '2-line split'],
            ['accordion', 'Fold', 'Accordion rows'],
            ['grid', 'Grid', '2-column grid'],
        ];
        const layoutButtons = new Map();
        for (const [mode, label, tip] of layouts) {
            const btn = element('button', 'agy-layout-btn', label);
            btn.type = 'button';
            btn.title = tip;
            btn.setAttribute('aria-pressed', String(layoutMode === mode));
            btn.addEventListener('click', () => {
                if (layoutMode === mode)
                    return;
                layoutMode = mode;
                try {
                    window.localStorage?.setItem(LAYOUT_STORAGE_KEY, mode);
                }
                catch { }
                for (const [key, node] of layoutButtons)
                    node.setAttribute('aria-pressed', String(key === mode));
                animateNextLayout = true;
                void renderCustomModelsList();
            });
            layoutButtons.set(mode, btn);
            layoutBar.append(btn);
        }
        bar.append(chips, layoutBar);
        const content = element('div');
        content.id = 'agy-custom-models-content';
        const fleet = element('div', 'agy-fleet');
        fleet.id = 'agy-google-account-pool-section';
        fleet.setAttribute('aria-label', 'Google account fleet and quotas');
        fleet.hidden = true;
        const status = statusNode();
        status.id = 'agy-main-status';
        section.prepend(header, element('p', 'agy-muted', 'Provider connections, local models and remote gateways.'), actions, optionsRow);
        section.append(status, fleet, bar, content);
        mount.append(section);
        if (!rowMenuDismissInstalled) {
            rowMenuDismissInstalled = true;
            const closeOpenRowMenus = (except) => {
                for (const openMenu of document.querySelectorAll('#agy-custom-models-content details.agy-menu[open]')) {
                    if (!except || !openMenu.contains(except))
                        openMenu.open = false;
                }
            };
            document.addEventListener('click', (event) => closeOpenRowMenus(event.target));
            document.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape')
                    return;
                const active = document.activeElement;
                const activeMenu = active?.closest('#agy-custom-models-content details.agy-menu[open]');
                closeOpenRowMenus();
                activeMenu?.querySelector('summary')?.focus({ preventScroll: true });
            });
        }
        void renderCustomModelsList();
    }
    let pickerSearch;
    function pickerVisible(menu) {
        if (!menu.isConnected)
            return false;
        for (let node = menu; node; node = node.parentElement) {
            if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.getAttribute('data-state') === 'closed')
                return false;
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden')
                return false;
        }
        return true;
    }
    function checkModelPickerSearch() {
        if (document.documentElement?.dataset.agyMitmSelector === '1') {
            if (pickerSearch) {
                pickerSearch.cleanup();
                pickerSearch = undefined;
            }
            return;
        }
        if (pickerSearch) {
            if (pickerVisible(pickerSearch.menu)) {
                pickerSearch.update();
                return;
            }
            pickerSearch.cleanup();
            pickerSearch = undefined;
        }
        const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]'));
        const menu = menus.find((candidate) => {
            if (!pickerVisible(candidate) || candidate.closest('#agy-modal-overlay, #agy-custom-models-section') ||
                candidate.parentElement?.closest('[role="menu"], [role="listbox"]') ||
                candidate.matches('[data-radix-menu-sub-content], [data-radix-dropdown-menu-sub-content]'))
                return false;
            const trigger = document.getElementById(candidate.getAttribute('aria-labelledby') || '');
            if (trigger?.closest('[role="menuitem"], [role="menuitemradio"]'))
                return false;
            const leaves = Array.from(candidate.querySelectorAll('*')).filter((node) => !node.children.length);
            const labels = leaves.map((node) => node.textContent?.trim() || '').filter(Boolean);
            return labels.slice(0, 2).includes('Model') && labels.some((label) => /^View\s+Usage$/i.test(label));
        });
        if (!menu)
            return;
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
        const header = Array.from(menu.querySelectorAll('*')).find((node) => !node.children.length && node.textContent?.trim() === 'Model');
        (header || menu).insertAdjacentElement(header ? 'afterend' : 'afterbegin', box);
        box.after(empty);
        const displays = new Map();
        const injectedNodes = [];
        let sidepanelEl = null;
        let activeProviderRow = null;
        let closeTimer;
        let bridgedNode = null;
        let bridgedOldStyle = '';
        const stripStatusPrefix = (text) => text
            .replace(/^⭐\s*/u, '')
            .replace(/^[🟢🔴⚪🟡⭐\s•·|-]+(?:\[[^\]]+\]\s*)?[•·|-]?\s*/u, '')
            .replace(/\s+/g, ' ')
            .trim();
        const effortWords = new Set(['low', 'medium', 'high', 'xhigh', 'minimal', 'extra', 'default']);
        const inferProviderGroup = (model) => {
            const explicit = (model.providerName || '').trim();
            if (explicit)
                return explicit;
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
        const isItemSelected = (node) => {
            if (node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true')
                return true;
            if (node.dataset.state === 'checked')
                return true;
            return Boolean(node.querySelector('svg[data-lucide="check"], .lucide-check'));
        };
        const hasEffortSubmenu = (node) => {
            if (node.getAttribute('aria-haspopup') === 'menu')
                return true;
            return Boolean(node.querySelector('svg[data-lucide="chevron-right"], .lucide-chevron-right'));
        };
        const viewUsageNode = () => Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button')).find((node) => !node.closest('.agy-model-search-box, .agy-provider-row') && /^View\s+Usage$/i.test(node.textContent?.trim() || ''));
        const rawItems = () => Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button')).filter((node) => !node.parentElement?.closest('[role="menuitem"], [role="menuitemradio"], [role="option"]') &&
            !node.closest('.agy-model-search-box, .agy-provider-row') &&
            !/^View\s+Usage/i.test(node.textContent?.trim() || ''));
        const hideNode = (node) => {
            if (displays.has(node))
                return;
            displays.set(node, { value: node.style.getPropertyValue('display'), priority: node.style.getPropertyPriority('display') });
            node.style.setProperty('display', 'none', 'important');
        };
        const restore = (node) => {
            const old = displays.get(node);
            if (!old)
                return;
            if (old.value)
                node.style.setProperty('display', old.value, old.priority);
            else
                node.style.removeProperty('display');
            displays.delete(node);
        };
        const unbridgeNode = () => {
            if (!bridgedNode)
                return;
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
            if (closeTimer)
                clearTimeout(closeTimer);
            closeTimer = setTimeout(() => {
                const subOpen = document.querySelector('[data-radix-menu-sub-content]:hover, [data-radix-dropdown-menu-sub-content]:hover');
                if (!subOpen)
                    closeSidepanel();
            }, 160);
        };
        const createChevronSvg = (sampleNode) => {
            const existingSvg = sampleNode?.querySelector('svg[data-lucide="chevron-right"], .lucide-chevron-right');
            if (existingSvg)
                return existingSvg.cloneNode(true);
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
        const openProviderSidepanel = (providerRow, providerName, entries, officialSample) => {
            if (closeTimer) {
                clearTimeout(closeTimer);
                closeTimer = undefined;
            }
            if (activeProviderRow === providerRow && sidepanelEl?.isConnected)
                return;
            closeSidepanel();
            activeProviderRow = providerRow;
            providerRow.setAttribute('data-open', 'true');
            const panel = element('div', `${menu.className ? menu.className + ' ' : ''}agy-provider-sidepanel`);
            panel.setAttribute('role', 'menu');
            const menuStyle = window.getComputedStyle(menu);
            if (menuStyle.backgroundColor && menuStyle.backgroundColor !== 'rgba(0, 0, 0, 0)') {
                panel.style.backgroundColor = menuStyle.backgroundColor;
            }
            else {
                panel.style.backgroundColor = '#18181b';
            }
            if (menuStyle.borderColor)
                panel.style.borderColor = menuStyle.borderColor;
            if (menuStyle.borderStyle && menuStyle.borderStyle !== 'none')
                panel.style.borderStyle = menuStyle.borderStyle;
            if (menuStyle.borderWidth && menuStyle.borderWidth !== '0px')
                panel.style.borderWidth = menuStyle.borderWidth;
            if (menuStyle.borderRadius)
                panel.style.borderRadius = menuStyle.borderRadius;
            if (menuStyle.color)
                panel.style.color = menuStyle.color;
            if (menuStyle.fontFamily)
                panel.style.fontFamily = menuStyle.fontFamily;
            if (menuStyle.fontSize)
                panel.style.fontSize = menuStyle.fontSize;
            const sampleClass = officialSample?.className || '';
            const chevronSample = officialSample || entries.find((e) => hasEffortSubmenu(e.node))?.node;
            for (const { node, model } of entries) {
                const item = element('div', `${sampleClass ? sampleClass + ' ' : ''}agy-sidepanel-item`);
                item.setAttribute('role', 'menuitem');
                item.tabIndex = -1;
                const disabled = node.getAttribute('aria-disabled') === 'true' || node.disabled;
                if (disabled)
                    item.setAttribute('data-disabled', 'true');
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
                    if (disabled)
                        return;
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
                    }
                    else if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        item.click();
                    }
                    else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        item.nextElementSibling?.focus();
                    }
                    else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        const prev = item.previousElementSibling;
                        if (prev && prev.classList.contains('agy-sidepanel-item'))
                            prev.focus();
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
        const stripTrailingSuffix = (text) => text
            .replace(/(?:\s*(?:Low|Medium|High|XHigh|Minimal|Extra|New|Notice|Unavailable|✓|›|>))+$/iu, '')
            .trim();
        const stripEffortParens = (text) => text.replace(/\s*\((?:low|medium|high|xhigh|minimal|extra)\)\s*$/iu, '').trim();
        const matchNodeToCustomModel = (node, sortedModels) => {
            const attrLabel = node.getAttribute('data-model-label') ||
                node.querySelector('[data-model-base]')?.getAttribute('data-model-base') ||
                '';
            const nodeClean = stripStatusPrefix(attrLabel || node.textContent || '');
            if (!nodeClean)
                return undefined;
            const nodeBase = stripEffortParens(stripTrailingSuffix(nodeClean)).toLowerCase();
            const nodeCleanLower = nodeClean.toLowerCase();
            const isTruncated = nodeBase.endsWith('...') || nodeBase.endsWith('…');
            const truncatedPrefix = isTruncated ? nodeBase.replace(/(?:\.\.\.|…)+$/, '').trim() : '';
            for (const { model, clean, base } of sortedModels) {
                if (!clean)
                    continue;
                const cleanLower = clean.toLowerCase();
                const baseLower = base.toLowerCase();
                if (nodeBase === cleanLower ||
                    nodeBase === baseLower ||
                    nodeCleanLower === cleanLower ||
                    nodeCleanLower === baseLower ||
                    nodeCleanLower.startsWith(cleanLower) ||
                    nodeCleanLower.startsWith(baseLower)) {
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
            const providerGroups = new Map();
            const customNodes = new Set();
            let officialSample;
            if (sortedModels.length > 0) {
                for (const node of allNodes) {
                    const matched = matchNodeToCustomModel(node, sortedModels);
                    if (matched) {
                        customNodes.add(node);
                        const groupName = inferProviderGroup(matched);
                        const list = providerGroups.get(groupName) || [];
                        list.push({ node, model: matched });
                        providerGroups.set(groupName, list);
                    }
                    else if (!officialSample && pickerVisible(node)) {
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
                    }
                    else {
                        restore(node);
                    }
                }
                const anchor = viewUsageNode();
                const divider = element('div', 'agy-provider-divider');
                injectedNodes.push(divider);
                if (anchor)
                    anchor.insertAdjacentElement('beforebegin', divider);
                else
                    menu.append(divider);
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
                            sidepanelEl?.querySelector('.agy-sidepanel-item')?.focus();
                        }
                    });
                    injectedNodes.push(row);
                    if (anchor)
                        anchor.insertAdjacentElement('beforebegin', row);
                    else
                        menu.append(row);
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
                    if (displays.has(node))
                        restore(node);
                    if (pickerVisible(node))
                        matches++;
                }
                else {
                    hideNode(node);
                }
            }
            const hidden = !query || matches > 0;
            if (empty.hidden !== hidden)
                empty.hidden = hidden;
        };
        for (const event of ['pointerdown', 'mousedown', 'click'])
            box.addEventListener(event, (e) => e.stopPropagation());
        clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            input.value = '';
            update();
            input.focus();
        });
        input.addEventListener('input', update);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !input.value)
                return;
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                input.value = '';
                update();
            }
            else if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault();
                const first = rawItems().find((node) => pickerVisible(node) && node.getAttribute('aria-disabled') !== 'true' && !node.disabled);
                if (event.key === 'Enter')
                    first?.click();
                else
                    (first || injectedNodes.find((n) => n.classList.contains('agy-provider-row')))?.focus();
            }
        });
        pickerSearch = {
            menu,
            update,
            cleanup: () => {
                clearInjectedProviders();
                for (const node of Array.from(displays.keys()))
                    restore(node);
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
            }).catch(() => { });
        }
        setTimeout(() => { if (box.isConnected && pickerVisible(menu))
            input.focus(); }, 0);
    }
    function setupInjectionObserver() {
        injectCustomModelsSection();
        if (!document.body)
            return;
        checkModelPickerSearch();
        fleetTimer = setInterval(() => { void refreshFleetQuotas(); }, 30000);
        let pending;
        const isAddonPickerNode = (target) => {
            const el = target instanceof HTMLElement ? target : target?.parentElement;
            return Boolean(el?.closest('.agy-provider-sidepanel, .agy-provider-row, .agy-provider-divider, .agy-model-search-box'));
        };
        const observer = new MutationObserver((mutations) => {
            if (mutations.every((m) => isAddonPickerNode(m.target)))
                return;
            if (pending)
                clearTimeout(pending);
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
        window.addEventListener('pagehide', () => {
            observer.disconnect();
            if (pending)
                clearTimeout(pending);
            if (fleetTimer)
                clearInterval(fleetTimer);
        }, { once: true });
    }
    function hashCodeStr(s) {
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
    window.addEventListener('pagehide', () => {
        if (listPollTimer !== undefined && typeof clearInterval === 'function') {
            clearInterval(listPollTimer);
            listPollTimer = undefined;
        }
        window.removeEventListener?.('focus', onWindowFocus);
    }, { once: true });
});
//# sourceMappingURL=customPreload.js.map