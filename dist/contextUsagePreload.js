"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/** Independent sandbox-safe preload; deployment appends this module beside the settings preload. */
const electron_1 = require("electron");
window.addEventListener('DOMContentLoaded', () => {
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    const composerSelector = '[data-testid="agent-input-box"], .no-focus-agent-input, ' +
        '[role="combobox"][contenteditable="true"][aria-label="Message input"]';
    const triggerSelector = '[data-testid="model-selector-trigger"], button[aria-label*="Select model" i], ' +
        'button[aria-label*="Choose model" i], button[aria-label*="Switch model" i]';
    const states = new Map();
    const toolbarParents = new Set();
    const style = document.createElement('style');
    style.textContent =
        '[data-agy-context-toolbar]:has(> [data-agy-context-ring]){display:inline-flex!important;align-items:center;gap:4px;max-width:100%}' +
            '[data-agy-context-toolbar]>[data-testid="model-selector-trigger"]{min-width:0;flex:0 1 auto}' +
            '[data-agy-context-ring]{display:inline-flex;align-items:center;gap:5px;flex:none;height:22px;padding:0 8px 0 5px;border-radius:9999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:inherit;font-size:11px;line-height:1;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}' +
            '[data-agy-context-ring]:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.22)}' +
            '.agy-ctx-popover{position:fixed;z-index:9999999;width:276px;padding:10px 12px;border-radius:10px;background:#18181b;border:1px solid rgba(255,255,255,.14);box-shadow:0 14px 36px rgba(0,0,0,.6);color:#e4e4e7;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none}' +
            '.agy-ctx-pop-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;font-weight:600;color:#fafafa}' +
            '.agy-ctx-pop-badge{font-size:10px;font-weight:500;padding:1px 6px;border-radius:9999px;background:#27272c;color:#a1a1aa;flex-shrink:0}' +
            '.agy-ctx-pop-bar{position:relative;height:6px;border-radius:9999px;background:rgba(255,255,255,.1);overflow:hidden;margin:6px 0}' +
            '.agy-ctx-pop-fill{height:100%;border-radius:9999px;transition:width .15s}' +
            '.agy-ctx-pop-row{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#d4d4d8;margin-top:4px}' +
            '.agy-ctx-pop-row span:first-child{color:#a1a1aa}' +
            '.agy-ctx-pop-section{margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08)}' +
            '.agy-ctx-pop-muted{font-size:10px;color:#a1a1aa;margin-top:7px;line-height:1.35}';
    document.head.append(style);
    const limits = new Map();
    let stopped = false;
    let debounce;
    let customNames = [];
    let namesAt = 0;
    let namesPending = false;
    const visible = (element) => {
        for (let current = element; current; current = current.parentElement) {
            if (current.hidden || current.getAttribute('aria-hidden') === 'true')
                return false;
            const style = window.getComputedStyle(current);
            if (style.display === 'none' || style.visibility === 'hidden')
                return false;
        }
        return true;
    };
    const text = (element) => (element.textContent || '').replace(/[▾▲▼◂▸◀▶]/g, '').replace(/\s+/g, ' ').trim();
    const idFrom = (value) => typeof value === 'string' && uuid.test(value) ? value : undefined;
    const composers = () => {
        // Native 2.23 also puts .no-focus-agent-input on the model toolbar itself.
        // A composer must contain an editor; a styling class alone is not an editor.
        const editorSelector = 'textarea, [role="combobox"][contenteditable="true"]';
        const candidates = Array.from(document.querySelectorAll(composerSelector))
            .filter((candidate) => visible(candidate) && (candidate.matches(editorSelector) || candidate.querySelector(editorSelector)));
        return candidates
            .filter((candidate) => !candidates.some((other) => other !== candidate && candidate.contains(other)))
            .sort((a, b) => Number(b.matches(editorSelector)) - Number(a.matches(editorSelector)));
    };
    function conversationIdentity(element) {
        for (const attr of ['data-conversation-id', 'data-cascade-id']) {
            const id = idFrom(element.getAttribute(attr));
            if (id)
                return id;
        }
        // React fiber expandos live in the page world and are invisible from this
        // isolated preload world. uiMitm.ts writes the active id onto the selector
        // DOM node (and the document root when there is only one composer).
        const bridged = idFrom(element.closest('[data-agy-conversation-id]')?.getAttribute('data-agy-conversation-id'));
        if (bridged)
            return bridged;
        const rootId = idFrom(document.documentElement.getAttribute('data-agy-conversation-id'));
        if (rootId && document.querySelectorAll('[data-agy-conversation-id]').length <= 1)
            return rootId;
        return undefined;
    }
    function readTarget(composer) {
        if (!composer.isConnected || !visible(composer))
            return undefined;
        let scope = composer;
        let trigger = scope.querySelector(triggerSelector);
        // Standalone 2.23 uses a Lexical contenteditable. Its model toolbar is a sibling,
        // so stop at the closest container with one model control instead of searching the page.
        if (composer.matches('[data-lexical-editor], [contenteditable="true"]')) {
            for (let depth = 0; !trigger && depth < 6 && scope.parentElement && scope.parentElement !== document.body; depth++) {
                scope = scope.parentElement;
                const controls = Array.from(scope.querySelectorAll(triggerSelector)).filter(visible);
                if (controls.length > 1)
                    break;
                if (controls.length === 1)
                    trigger = controls[0];
            }
        }
        if (!trigger) {
            trigger = Array.from(scope.querySelectorAll('button, [role="button"]')).find((button) => {
                if (button.hasAttribute('data-agy-context-ring') || !visible(button))
                    return false;
                const name = text(button);
                if (!name || name.length > 120 || /attach|add context|mention|send|submit/i.test(button.getAttribute('aria-label') || ''))
                    return false;
                return customNames.includes(name.toLowerCase()) ||
                    (/\b(gemini|claude|sonnet|opus|haiku|gpt|deepseek|qwen|llama|mistral)\b/i.test(name) &&
                        !!button.querySelector('svg, .codicon-chevron-down'));
            });
        }
        if (!trigger || !visible(trigger))
            return undefined;
        const modelName = text(trigger);
        if (!modelName)
            return undefined;
        let conversationId = conversationIdentity(composer) || conversationIdentity(trigger);
        const panel = composer.closest('[data-testid="conversation-view"], [data-testid="cascade-view"], [data-conversation-id], [data-cascade-id]');
        if (!conversationId && panel)
            conversationId = conversationIdentity(panel);
        // A route identifies only the sole composer; multi-pane/subagent views need their own IDs.
        if (!conversationId && composers().length === 1) {
            const route = `${window.location.pathname} ${window.location.hash}`;
            conversationId = idFrom(route.match(/(?:\/c\/|\/conversation\/)([a-f0-9-]{36})(?:[/?#\s]|$)/i)?.[1]);
        }
        return { trigger, modelName, conversationId, key: `${conversationId || ''}\n${modelName}` };
    }
    let activePopover;
    let activePopoverState;
    const formatCompactTokens = (value) => {
        if (value >= 1000000)
            return `${(value / 1000000).toFixed(1)}M`;
        if (value >= 1000)
            return `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}K`;
        return String(value);
    };
    const formatLatency = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
    /** Provider generation speed, e.g. `42 t/s`. Empty when the sample was too short to measure. */
    const formatSpeed = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0
        ? `${value >= 999.95 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value))} t/s`
        : '';
    const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const usageAccent = (fraction, nearCompact) => {
        if (nearCompact || fraction >= 0.85)
            return '#f87171';
        if (fraction >= 0.6)
            return '#fbbf24';
        return '#34d399';
    };
    const hidePopover = () => {
        activePopover?.remove();
        activePopover = undefined;
        activePopoverState = undefined;
    };
    const showPopover = (state) => {
        const reuse = activePopover && activePopover.isConnected && activePopoverState === state;
        if (!reuse)
            hidePopover();
        const { usage, target, ring } = state;
        const limit = usage?.maxTokens;
        const actual = usage?.source === 'actual' && typeof usage.actualTokens === 'number' && Number.isFinite(usage.actualTokens);
        const known = actual || (typeof usage?.currentTokens === 'number' && Number.isFinite(usage.currentTokens));
        const count = actual ? usage.actualTokens : known ? usage.currentTokens : 0;
        const rawFraction = known && limit ? Math.max(0, count / limit) : 0;
        const fraction = Math.min(1, rawFraction);
        const pct = (rawFraction * 100).toFixed(1);
        const compactPct = usage?.compactionThresholdPercent;
        const untilCompact = usage?.tokensUntilCompaction;
        const nearCompact = typeof untilCompact === 'number' && untilCompact <= 0;
        const accent = known && limit ? usageAccent(fraction, nearCompact) : '#a1a1aa';
        const num = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
        // Detail rows use the same compact scale as the pill so they stay on one line.
        const cnum = (value) => typeof value === 'number' && Number.isFinite(value) ? formatCompactTokens(value) : '—';
        const pop = reuse ? activePopover : document.createElement('div');
        if (!reuse)
            pop.className = 'agy-ctx-popover';
        const badge = actual ? 'Actual' : known ? 'Estimate' : 'Unavailable';
        const usageLine = known
            ? limit
                ? `${actual ? '' : '~'}${num(count)} / ${num(limit)} (${pct}%)`
                : `${actual ? '' : '~'}${num(count)} tokens`
            : 'Unavailable';
        const overhead = typeof usage?.overheadTokens === 'number'
            ? `<div class="agy-ctx-pop-row"><span>System prompt, tools &amp; images</span><span>${cnum(usage.overheadTokens)}</span></div>`
            : '';
        const visibleLine = actual && typeof usage?.currentTokens === 'number'
            ? `<div class="agy-ctx-pop-row"><span>Visible conversation</span><span>~${cnum(usage.currentTokens)}</span></div>`
            : '';
        const compactLine = typeof untilCompact === 'number'
            ? untilCompact > 0
                ? `<div class="agy-ctx-pop-row"><span>Before compact (${compactPct ?? 80}%)</span><span style="color:${accent};font-weight:600">${num(untilCompact)} left${typeof usage?.turnsUntilCompaction === 'number' ? ` · ~${usage.turnsUntilCompaction} turns` : ''}</span></div>`
                : `<div class="agy-ctx-pop-row"><span>Before compact (${compactPct ?? 80}%)</span><span style="color:#f87171;font-weight:600">Threshold reached</span></div>`
            : usage?.compactionSource === 'ide'
                ? `<div class="agy-ctx-pop-row"><span>Before compact</span><span>IDE default · ~50K new tokens</span></div>`
                : '';
        const cachedPct = actual && typeof usage?.actualCachedTokens === 'number' && count > 0
            ? Math.round((usage.actualCachedTokens / count) * 100)
            : undefined;
        const lastTurnLine = actual
            ? `<div class="agy-ctx-pop-section"></div>` +
                `<div class="agy-ctx-pop-row"><span>Last prompt</span><span>${cnum(usage?.actualInputTokens)} new · ${cnum(usage?.actualCachedTokens)} cached${cachedPct === undefined ? '' : ` (${cachedPct}% hit)`}</span></div>` +
                `<div class="agy-ctx-pop-row"><span>Last output</span><span>${cnum(usage?.actualOutputTokens)}</span></div>`
            : '';
        const speed = formatSpeed(usage?.tokensPerSecond);
        const generationLine = speed
            ? `<div class="agy-ctx-pop-row"><span>Last generation</span><span>${speed}${typeof usage?.ttftMs === 'number' ? ` · ${formatLatency(usage.ttftMs)} first token` : ''}</span></div>`
            : '';
        const sessionLine = actual && (typeof usage?.sessionInputTokens === 'number' || typeof usage?.sessionOutputTokens === 'number')
            ? `<div class="agy-ctx-pop-section"></div>` +
                `<div class="agy-ctx-pop-row"><span>Burned this session</span><span>${cnum((usage?.sessionInputTokens ?? 0) + (usage?.sessionCachedTokens ?? 0))} in · ${cnum(usage?.sessionOutputTokens)} out</span></div>` +
                `<div class="agy-ctx-pop-row"><span>Turns · compactions</span><span>${num(usage?.turns)} · ${num(usage?.compactions ?? 0)}</span></div>`
            : '';
        pop.innerHTML =
            `<div class="agy-ctx-pop-head"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(target.modelName)}</span><span class="agy-ctx-pop-badge">${badge}</span></div>` +
                `<div class="agy-ctx-pop-row"><span>Context used</span><span>${usageLine}</span></div>` +
                (limit ? `<div class="agy-ctx-pop-bar"><div class="agy-ctx-pop-fill" style="width:${(fraction * 100).toFixed(1)}%;background:${accent}"></div></div>` : '') +
                compactLine +
                (actual ? overhead + visibleLine : '') +
                generationLine +
                lastTurnLine +
                sessionLine +
                `<div class="agy-ctx-pop-muted">${!target.conversationId ? 'Open conversation could not be identified. ' : ''}${!limit ? 'Click pill to look up limit in public catalog.' : ''}</div>`;
        if (!reuse)
            document.body.append(pop);
        activePopover = pop;
        activePopoverState = state;
        const r = ring.getBoundingClientRect();
        const pr = pop.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.left));
        const top = Math.max(8, r.top - pr.height - 8);
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
    };
    function render(state) {
        const { usage, target, ring } = state;
        const limit = usage?.maxTokens;
        const actual = usage?.source === 'actual' && typeof usage.actualTokens === 'number' && Number.isFinite(usage.actualTokens);
        const known = actual || (typeof usage?.currentTokens === 'number' && Number.isFinite(usage.currentTokens));
        const count = actual ? usage.actualTokens : known ? usage.currentTokens : 0;
        const untilCompact = usage?.tokensUntilCompaction;
        let description = actual
            ? `Actual context: ${count.toLocaleString('en-US')} tokens (includes system prompt, tools and images)`
            : known
                ? `Visible transcript estimate: ~${count.toLocaleString('en-US')} tokens`
                : 'Context usage unavailable';
        if (limit)
            description += ` / ${limit.toLocaleString('en-US')} context limit (${usage?.limitSource === 'configured'
                ? 'configured'
                : usage?.limitSource === 'native-catalog'
                    ? 'model catalog'
                    : 'public catalog'})`;
        if (typeof untilCompact === 'number') {
            description += ` · ${untilCompact.toLocaleString('en-US')} tokens remaining before compact`;
        }
        if (actual) {
            if (typeof usage?.overheadTokens === 'number')
                description += ` · ${usage.overheadTokens.toLocaleString('en-US')} tokens for system prompt, tools and images`;
            if (typeof usage?.actualCachedTokens === 'number')
                description += ` · ${usage.actualCachedTokens.toLocaleString('en-US')} of the last prompt was cached`;
        }
        else if (known) {
            description += '. Hidden prompts, tool definitions and images are not included; actual usage can be higher.';
        }
        const speed = formatSpeed(usage?.tokensPerSecond);
        if (speed)
            description += ` · last generation ${speed}${typeof usage?.ttftMs === 'number' ? ` (first token ${formatLatency(usage.ttftMs)})` : ''}`;
        if (!target.conversationId)
            description += ' The open conversation could not be identified.';
        if (!limit)
            description += ' Click to look up the model limit in the public catalog.';
        if (ring.title !== description) {
            ring.title = description;
            ring.setAttribute('aria-label', description);
        }
        if (ring.dataset.agyContextSource !== String(usage?.source || 'unavailable'))
            ring.dataset.agyContextSource = String(usage?.source || 'unavailable');
        const fraction = known && limit ? Math.max(0, Math.min(1, count / limit)) : 0;
        const strokeColor = known && limit ? usageAccent(fraction, typeof untilCompact === 'number' && untilCompact <= 0) : 'currentColor';
        const circ = 37.7; // 2 * pi * 6
        const pillLabel = known
            ? `${actual ? '' : '~'}${formatCompactTokens(count)}${limit ? ` / ${formatCompactTokens(limit)}` : ''}${speed ? ` · ${speed}` : ''}`
            : '?';
        const html = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">` +
            `<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" opacity=".2" stroke-width="2"/>` +
            `<circle cx="8" cy="8" r="6" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${circ}" stroke-dashoffset="${(circ * (1 - fraction)).toFixed(2)}"/>` +
            `</svg><span>${pillLabel}</span>`;
        if (ring.innerHTML !== html)
            ring.innerHTML = html;
        const parent = target.trigger.parentElement;
        if (parent) {
            if (!parent.hasAttribute('data-agy-context-toolbar'))
                parent.setAttribute('data-agy-context-toolbar', '');
            toolbarParents.add(parent);
        }
        if (target.trigger.nextElementSibling !== ring)
            target.trigger.insertAdjacentElement('afterend', ring);
    }
    async function request(state, force = false) {
        if (stopped || states.get(state.composer) !== state)
            return;
        if (state.inFlight) {
            if (force)
                state.queued = true;
            return;
        }
        if (!force && Date.now() - state.lastRequest < 3000)
            return;
        const requested = state.target;
        const discoverLimit = state.discover;
        state.discover = false;
        state.inFlight = true;
        state.lastRequest = Date.now();
        try {
            const usage = await electron_1.ipcRenderer.invoke('storage:get-chat-context-usage', {
                conversationId: requested.conversationId,
                modelName: requested.modelName,
                discoverLimit,
            });
            const current = readTarget(state.composer);
            if (stopped || !current || states.get(state.composer) !== state)
                return;
            if (current.key !== requested.key) {
                state.target = current;
                state.usage = undefined;
                state.lastRequest = 0;
                state.queued = true;
                render(state);
                return;
            }
            if (usage.conversationId && usage.conversationId !== requested.conversationId)
                return;
            state.target = current;
            if (typeof usage.maxTokens === 'number' && Number.isSafeInteger(usage.maxTokens) && usage.maxTokens > 0) {
                if (usage.limitSource === 'public-catalog')
                    limits.set(requested.modelName, { maxTokens: usage.maxTokens, limitSource: usage.limitSource, expires: Date.now() + 300000 });
            }
            else {
                const cached = limits.get(requested.modelName);
                if (cached && Date.now() < cached.expires)
                    Object.assign(usage, { maxTokens: cached.maxTokens, limitSource: cached.limitSource });
            }
            state.usage = usage;
            render(state);
            if (activePopover && activePopoverState === state && state.ring.isConnected)
                showPopover(state);
        }
        catch {
            const current = readTarget(state.composer);
            if (states.get(state.composer) === state && current && current.key === requested.key) {
                state.usage = undefined;
                render(state);
                if (activePopover && activePopoverState === state && state.ring.isConnected)
                    showPopover(state);
            }
        }
        finally {
            state.inFlight = false;
            if (state.queued && !stopped && states.get(state.composer) === state) {
                state.queued = false;
                void request(state, true);
            }
        }
    }
    function refresh(force = false) {
        if (stopped)
            return;
        if (!namesPending && Date.now() - namesAt > 30000) {
            namesAt = Date.now();
            namesPending = true;
            void electron_1.ipcRenderer.invoke('storage:get-custom-models').then((models) => {
                customNames = Array.isArray(models) ? models.flatMap((model) => [model.displayName, model.name])
                    .filter((name) => typeof name === 'string').map((name) => name.toLowerCase()) : [];
                schedule();
            }).catch(() => { }).finally(() => { namesPending = false; });
        }
        // One trigger owns one ring, even if future native DOM changes provide
        // several plausible composer containers for the same model control.
        const targets = new Map();
        const triggers = new Set();
        for (const composer of composers()) {
            const target = readTarget(composer);
            if (target && !triggers.has(target.trigger)) {
                targets.set(composer, target);
                triggers.add(target.trigger);
            }
        }
        for (const parent of toolbarParents) {
            if (!parent.isConnected)
                toolbarParents.delete(parent);
        }
        for (const [composer, state] of states) {
            if (!targets.has(composer)) {
                if (activePopoverState === state)
                    hidePopover();
                state.ring.remove();
                states.delete(composer);
            }
        }
        for (const [composer, target] of targets) {
            let state = states.get(composer);
            let changed = false;
            if (!state) {
                const ring = document.createElement('button');
                ring.type = 'button';
                ring.dataset.agyContextRing = '';
                ring.className = 'agy-context-usage';
                ring.style.flex = '0 0 auto';
                state = { composer, target, ring, inFlight: false, queued: false, discover: false, lastRequest: 0 };
                const ownState = state;
                ring.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    ownState.discover = !ownState.usage?.maxTokens;
                    void request(ownState, true);
                });
                ring.addEventListener('pointerenter', () => showPopover(ownState));
                ring.addEventListener('pointerleave', () => hidePopover());
                ring.addEventListener('focus', () => showPopover(ownState));
                ring.addEventListener('blur', () => hidePopover());
                ring.addEventListener('mousedown', (event) => event.stopPropagation());
                states.set(composer, state);
                changed = true;
            }
            else if (state.target.key !== target.key) {
                state.usage = undefined;
                state.lastRequest = 0;
                changed = true;
            }
            state.target = target;
            render(state);
            void request(state, force || changed);
        }
    }
    function schedule() {
        if (stopped || debounce)
            return;
        debounce = setTimeout(() => { debounce = undefined; refresh(); }, 100);
    }
    const observer = new MutationObserver((records) => {
        if (records.some((record) => !(record.target instanceof Element && record.target.closest('[data-agy-context-ring], .agy-ctx-popover'))))
            schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['class', 'hidden', 'aria-hidden', 'data-conversation-id', 'data-cascade-id'] });
    const focus = () => refresh(true);
    const route = () => refresh(true);
    window.addEventListener('focus', focus);
    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', route);
    // Polling also catches transcript appends with no renderer DOM change and missed SPA route events.
    const poll = setInterval(() => refresh(), 5000);
    window.addEventListener('pagehide', () => {
        stopped = true;
        observer.disconnect();
        if (debounce)
            clearTimeout(debounce);
        clearInterval(poll);
        window.removeEventListener('focus', focus);
        window.removeEventListener('popstate', route);
        window.removeEventListener('hashchange', route);
        hidePopover();
        for (const state of states.values())
            state.ring.remove();
        states.clear();
        for (const parent of toolbarParents)
            parent.removeAttribute('data-agy-context-toolbar');
        toolbarParents.clear();
        style.remove();
    }, { once: true });
    refresh();
});
//# sourceMappingURL=contextUsagePreload.js.map