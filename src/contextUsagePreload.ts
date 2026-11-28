/** Independent sandbox-safe preload; deployment appends this module beside the settings preload. */
import { ipcRenderer } from 'electron';

window.addEventListener('DOMContentLoaded', () => {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const composerSelector = '[data-testid="agent-input-box"], .no-focus-agent-input, ' +
    '[role="combobox"][contenteditable="true"][aria-label="Message input"]';
  const triggerSelector = '[data-testid="model-selector-trigger"], button[aria-label*="Select model" i], ' +
    'button[aria-label*="Choose model" i], button[aria-label*="Switch model" i]';
  type Usage = {
    conversationId: string;
    source: 'actual' | 'estimated' | 'unavailable';
    currentTokens?: number;
    actualTokens?: number;
    overheadTokens?: number;
    visibleInputTokens?: number;
    visibleOutputTokens?: number;
    actualInputTokens?: number;
    actualCachedTokens?: number;
    actualOutputTokens?: number;
    sessionInputTokens?: number;
    sessionCachedTokens?: number;
    sessionOutputTokens?: number;
    turns?: number;
    compactions?: number;
    tokensPerTurn?: number;
    turnsUntilCompaction?: number;
    maxTokens?: number;
    limitSource?: 'configured' | 'native-catalog' | 'public-catalog';
    tokensPerSecond?: number;
    ttftMs?: number;
    compactionThresholdPercent?: number;
    compactionAtTokens?: number;
    tokensUntilCompaction?: number;
    compactionSource?: 'custom' | 'default' | 'ide';
  };
  type Target = { trigger: HTMLElement; scope: HTMLElement; conversationId?: string; modelName: string; key: string };
  type State = {
    composer: HTMLElement;
    target: Target;
    ring: HTMLButtonElement;
    inFlight: boolean;
    queued: boolean;
    discover: boolean;
    lastRequest: number;
    usage?: Usage;
  };
  const states = new Map<HTMLElement, State>();
  const toolbarParents = new Set<HTMLElement>();
  const style = document.createElement('style');
  style.textContent =
    '[data-agy-context-toolbar]:has(> [data-agy-context-ring]){display:inline-flex!important;align-items:center;gap:4px;max-width:100%}' +
    '[data-agy-context-toolbar]>[data-testid="model-selector-trigger"]{min-width:0;flex:0 1 auto}' +
    '[data-agy-context-ring]{display:inline-flex;align-items:center;gap:5px;flex:none;height:22px;padding:0 8px 0 5px;border-radius:9999px;border:1px solid var(--border,color-mix(in srgb,currentColor 18%,transparent));background:color-mix(in srgb,currentColor 4%,transparent);color:var(--muted-foreground,inherit);font-size:11px;line-height:1;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap;outline:none;transition:background .12s,border-color .12s,color .12s,box-shadow .2s}' +
    '[data-agy-context-ring]:hover,[data-agy-context-ring]:focus-visible{background:var(--secondary,color-mix(in srgb,currentColor 9%,transparent));border-color:color-mix(in srgb,currentColor 28%,transparent);color:var(--foreground,inherit)}' +
    '[data-agy-context-ring][data-agy-compacted="1"]{border-color:#34d399;box-shadow:0 0 0 2px rgba(52,211,153,.22)}' +
    '[data-agy-context-ring] svg{flex-shrink:0}' +
    '.agy-compact-toast{position:fixed;right:18px;bottom:18px;z-index:9999999;max-width:300px;padding:10px 13px;border-radius:10px;background:var(--popover,var(--card,#18181b));border:1px solid color-mix(in srgb,#34d399 45%,var(--border,rgba(128,128,128,.25)));box-shadow:0 12px 32px rgba(0,0,0,.45);color:var(--popover-foreground,var(--foreground,#e4e4e7));font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;display:flex;flex-direction:column;gap:2px}' +
    '.agy-compact-toast-title{font-weight:600;font-size:12px;color:#34d399;display:flex;align-items:center;gap:6px}' +
    '.agy-compact-toast-sub{font-size:11px;color:var(--muted-foreground,#a1a1aa);font-variant-numeric:tabular-nums}' +
    '.agy-ctx-popover{position:fixed;z-index:9999999;width:288px;padding:12px 14px;border-radius:10px;background:var(--popover,var(--card,#18181b));border:1px solid var(--border,rgba(128,128,128,.22));box-shadow:0 12px 32px rgba(0,0,0,.45);color:var(--popover-foreground,var(--foreground,#e4e4e7));font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none}' +
    '.agy-ctx-pop-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;font-weight:600;color:var(--foreground,#fafafa)}' +
    '.agy-ctx-pop-badge{font-size:10px;font-weight:500;padding:2px 7px;border-radius:9999px;background:var(--secondary,color-mix(in srgb,currentColor 10%,transparent));color:var(--muted-foreground,#a1a1aa);flex-shrink:0}' +
    '.agy-ctx-pop-bar{position:relative;height:6px;border-radius:9999px;background:color-mix(in srgb,currentColor 12%,transparent);overflow:hidden;margin:6px 0 8px}' +
    '.agy-ctx-pop-fill{height:100%;border-radius:9999px;transition:width .15s}' +
    '.agy-ctx-pop-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:11.5px;color:var(--foreground,#e4e4e7);margin-top:4px;font-variant-numeric:tabular-nums}' +
    '.agy-ctx-pop-row span:first-child{color:var(--muted-foreground,#9ca3af);flex-shrink:0}' +
    '.agy-ctx-pop-row span:last-child{text-align:right}' +
    '.agy-ctx-pop-section{margin-top:9px;padding-top:7px;border-top:1px solid var(--border,color-mix(in srgb,currentColor 10%,transparent))}' +
    '.agy-ctx-pop-muted{font-size:10.5px;color:var(--muted-foreground,#9ca3af);margin-top:8px;line-height:1.35}';
  document.head.append(style);
  const limits = new Map<string, { maxTokens: number; limitSource: Usage['limitSource']; expires: number }>();
  let stopped = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let customNames: string[] = [];
  let namesAt = 0;
  let namesPending = false;
  const visible = (element: HTMLElement) => {
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const text = (element: HTMLElement) => (element.textContent || '').replace(/[▾▲▼◂▸◀▶]/g, '').replace(/\s+/g, ' ').trim();
  const idFrom = (value: unknown): string | undefined => typeof value === 'string' && uuid.test(value) ? value : undefined;
  const composers = () => {
    // Native 2.23 also puts .no-focus-agent-input on the model toolbar itself.
    // A composer must contain an editor; a styling class alone is not an editor.
    const editorSelector = 'textarea, [role="combobox"][contenteditable="true"]';
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(composerSelector))
      .filter((candidate) => visible(candidate) && (candidate.matches(editorSelector) || candidate.querySelector(editorSelector)));
    return candidates
      .filter((candidate) => !candidates.some((other) => other !== candidate && candidate.contains(other)))
      .sort((a, b) => Number(b.matches(editorSelector)) - Number(a.matches(editorSelector)));
  };

  function conversationIdentity(element: HTMLElement): string | undefined {
    for (const attr of ['data-conversation-id', 'data-cascade-id']) {
      const id = idFrom(element.getAttribute(attr));
      if (id) return id;
    }
    // React fiber expandos live in the page world and are invisible from this
    // isolated preload world. uiMitm.ts writes the active id onto the selector
    // DOM node (and the document root when there is only one composer).
    const bridged = idFrom(element.closest('[data-agy-conversation-id]')?.getAttribute('data-agy-conversation-id'));
    if (bridged) return bridged;
    const rootId = idFrom(document.documentElement.getAttribute('data-agy-conversation-id'));
    if (rootId && document.querySelectorAll('[data-agy-conversation-id]').length <= 1) return rootId;
    return undefined;
  }

  function readTarget(composer: HTMLElement): Target | undefined {
    if (!composer.isConnected || !visible(composer)) return undefined;
    let scope = composer;
    let trigger = scope.querySelector<HTMLElement>(triggerSelector);
    // Standalone 2.23 uses a Lexical contenteditable. Its model toolbar is a sibling,
    // so stop at the closest container with one model control instead of searching the page.
    if (composer.matches('[data-lexical-editor], [contenteditable="true"]')) {
      for (let depth = 0; !trigger && depth < 6 && scope.parentElement && scope.parentElement !== document.body; depth++) {
        scope = scope.parentElement;
        const controls = Array.from(scope.querySelectorAll<HTMLElement>(triggerSelector)).filter(visible);
        if (controls.length > 1) break;
        if (controls.length === 1) trigger = controls[0];
      }
    }
    if (!trigger) {
      trigger = Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"]')).find((button) => {
        if (button.hasAttribute('data-agy-context-ring') || !visible(button)) return false;
        const name = text(button);
        if (!name || name.length > 120 || /attach|add context|mention|send|submit/i.test(button.getAttribute('aria-label') || '')) return false;
        return customNames.includes(name.toLowerCase()) ||
          (/\b(gemini|claude|sonnet|opus|haiku|gpt|deepseek|qwen|llama|mistral)\b/i.test(name) &&
            !!button.querySelector('svg, .codicon-chevron-down'));
      });
    }
    if (!trigger || !visible(trigger)) return undefined;
    const modelName = text(trigger);
    if (!modelName) return undefined;
    let conversationId = conversationIdentity(composer) || conversationIdentity(trigger);
    const panel = composer.closest<HTMLElement>('[data-testid="conversation-view"], [data-testid="cascade-view"], [data-conversation-id], [data-cascade-id]');
    if (!conversationId && panel) conversationId = conversationIdentity(panel);
    // A route identifies only the sole composer; multi-pane/subagent views need their own IDs.
    if (!conversationId && composers().length === 1) {
      const route = `${window.location.pathname} ${window.location.hash}`;
      conversationId = idFrom(route.match(/(?:\/c\/|\/conversation\/)([a-f0-9-]{36})(?:[/?#\s]|$)/i)?.[1]);
    }
    const inputBox = trigger.closest<HTMLElement>('[data-testid="agent-input-box"]') || scope;
    return { trigger, scope: inputBox, modelName, conversationId, key: `${conversationId || ''}\n${modelName}` };
  }

  let activePopover: HTMLElement | undefined;
  let activePopoverState: State | undefined;
  let activeToast: HTMLElement | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const seenCompactions = new Map<string, { count: number; tokens?: number }>();
  let lastRealtimeToastAt = 0;
  const playCompactChime = () => {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const schedule = () => {
        const now = ctx.currentTime;
        const tone = (freq: number, start: number, dur: number) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + dur);
        };
        tone(587.33, now, 0.16); // D5
        tone(880.0, now + 0.12, 0.26); // A5
        setTimeout(() => { void ctx.close().catch(() => {}); }, 600);
      };
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        void ctx.resume().then(schedule, () => { void ctx.close().catch(() => {}); });
      } else {
        schedule();
      }
    } catch {
      /* Audio playback unavailable or blocked */
    }
  };
  const showCompactToast = (title: string, detail: string, ring?: HTMLElement) => {
    if (toastTimer) clearTimeout(toastTimer);
    activeToast?.remove();
    const toast = document.createElement('div');
    toast.className = 'agy-compact-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML =
      `<div class="agy-compact-toast-title"><span>●</span><span>${escapeHtml(title)}</span></div>` +
      `<div class="agy-compact-toast-sub">${escapeHtml(detail)}</div>`;
    toast.addEventListener('click', () => {
      toast.remove();
      if (activeToast === toast) activeToast = undefined;
    });
    document.body.append(toast);
    activeToast = toast;
    toastTimer = setTimeout(() => {
      toast.remove();
      if (activeToast === toast) activeToast = undefined;
    }, 8000);
    if (ring && ring.isConnected) {
      ring.dataset.agyCompacted = '1';
      setTimeout(() => {
        if (ring.isConnected) delete ring.dataset.agyCompacted;
      }, 3000);
    }
    playCompactChime();
  };
  const onRealtimeCompaction = (
    _event: unknown,
    info?: { conversationId?: string; modelName?: string; isCustom?: boolean },
  ) => {
    if (stopped) return;
    lastRealtimeToastAt = Date.now();
    const matchingState = info?.conversationId
      ? Array.from(states.values()).find((s) => s.target.conversationId === info.conversationId)
      : Array.from(states.values())[0];
    const modelLabel = info?.modelName ? ` (${info.modelName})` : '';
    showCompactToast(
      'Auto-compacting context',
      `Summarizing earlier messages${modelLabel} to free context space.`,
      matchingState?.ring,
    );
    for (const delay of [1500, 4500, 9000]) {
      setTimeout(() => {
        if (!stopped) refresh(true);
      }, delay);
    }
  };
  if (typeof ipcRenderer.on === 'function') {
    ipcRenderer.on('agy:compaction-event', onRealtimeCompaction);
  }
  const formatCompactTokens = (value: number): string => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
    return String(value);
  };
  const formatLatency = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
  /** Provider generation speed, e.g. `42 t/s`. Empty when the sample was too short to measure. */
  const formatSpeed = (value?: number): string =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? `${value >= 999.95 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value))} t/s`
      : '';
  const escapeHtml = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const usageAccent = (fraction: number, nearCompact: boolean): string => {
    if (nearCompact || fraction >= 0.85) return '#f87171';
    if (fraction >= 0.6) return '#fbbf24';
    return '#34d399';
  };
  const hidePopover = () => {
    activePopover?.remove();
    activePopover = undefined;
    activePopoverState = undefined;
  };
  const showPopover = (state: State) => {
    const reuse = activePopover && activePopover.isConnected && activePopoverState === state;
    if (!reuse) hidePopover();
    const { usage, target, ring } = state;
    const limit = usage?.maxTokens;
    const actual = usage?.source === 'actual' && typeof usage.actualTokens === 'number' && Number.isFinite(usage.actualTokens);
    const known = actual || (typeof usage?.currentTokens === 'number' && Number.isFinite(usage.currentTokens));
    const count = actual ? usage!.actualTokens! : known ? usage!.currentTokens! : 0;
    const rawFraction = known && limit ? Math.max(0, count / limit) : 0;
    const fraction = Math.min(1, rawFraction);
    const pct = (rawFraction * 100).toFixed(1);
    const compactPct = usage?.compactionThresholdPercent;
    const untilCompact = usage?.tokensUntilCompaction;
    const nearCompact = typeof untilCompact === 'number' && untilCompact <= 0;
    const accent = known && limit ? usageAccent(fraction, nearCompact) : '#a1a1aa';
    const num = (value?: number) =>
      typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
    // Detail rows use the same compact scale as the pill so they stay on one line.
    const cnum = (value?: number) =>
      typeof value === 'number' && Number.isFinite(value) ? formatCompactTokens(value) : '—';

    const pop = reuse ? activePopover! : document.createElement('div');
    if (!reuse) pop.className = 'agy-ctx-popover';
    const badge = actual ? 'Live' : known ? 'Estimate' : 'Unavailable';
    const usageLine = known
      ? limit
        ? `${actual ? '' : '~'}${num(count)} / ${num(limit)} (${pct}%)`
        : `${actual ? '' : '~'}${num(count)} tokens`
      : 'Unavailable';
    const visibleLine =
      actual && typeof usage?.currentTokens === 'number'
        ? `<div class="agy-ctx-pop-row"><span>Chat messages</span><span>~${cnum(usage.currentTokens)}</span></div>`
        : '';
    const overhead =
      typeof usage?.overheadTokens === 'number'
        ? `<div class="agy-ctx-pop-row"><span>Tools, files &amp; system</span><span>${cnum(usage.overheadTokens)}</span></div>`
        : '';
    const compactLine =
      typeof untilCompact === 'number'
        ? untilCompact > 0
          ? `<div class="agy-ctx-pop-row"><span>Auto-compact (${compactPct ?? 80}%)</span><span style="color:${accent};font-weight:600">${cnum(untilCompact)} left${typeof usage?.turnsUntilCompaction === 'number' ? ` · ~${usage.turnsUntilCompaction} turns` : ''}</span></div>`
          : `<div class="agy-ctx-pop-row"><span>Auto-compact (${compactPct ?? 80}%)</span><span style="color:#f87171;font-weight:600">Ready on next turn</span></div>`
        : usage?.compactionSource === 'ide'
          ? `<div class="agy-ctx-pop-row"><span>Auto-compact</span><span>Automatic (Antigravity)</span></div>`
          : '';
    const cachedPct =
      actual && typeof usage?.actualCachedTokens === 'number' && count > 0
        ? Math.round((usage.actualCachedTokens / count) * 100)
        : undefined;
    const speed = formatSpeed(usage?.tokensPerSecond);
    const generationLine = speed
      ? `<div class="agy-ctx-pop-row"><span>Speed</span><span>${speed}${typeof usage?.ttftMs === 'number' ? ` · ${formatLatency(usage.ttftMs)} TTFT` : ''}</span></div>`
      : '';
    const lastTurnLine = actual
      ? `<div class="agy-ctx-pop-section"></div>` +
        generationLine +
        `<div class="agy-ctx-pop-row"><span>Prompt cache</span><span>${cnum(usage?.actualInputTokens)} new · ${cnum(usage?.actualCachedTokens)} cached${cachedPct === undefined ? '' : ` (${cachedPct}%)`}</span></div>` +
        `<div class="agy-ctx-pop-row"><span>Last reply</span><span>${cnum(usage?.actualOutputTokens)}</span></div>`
      : generationLine;
    const sessionLine =
      actual && (typeof usage?.sessionInputTokens === 'number' || typeof usage?.sessionOutputTokens === 'number')
        ? `<div class="agy-ctx-pop-section"></div>` +
          `<div class="agy-ctx-pop-row"><span>Session total</span><span>${cnum((usage?.sessionInputTokens ?? 0) + (usage?.sessionCachedTokens ?? 0))} in · ${cnum(usage?.sessionOutputTokens)} out</span></div>` +
          `<div class="agy-ctx-pop-row"><span>Turns · Compactions</span><span>${num(usage?.turns)} · ${num(usage?.compactions ?? 0)}</span></div>`
        : '';
    const footerNote = `${!target.conversationId ? 'Open conversation could not be identified. ' : ''}${!limit ? 'Click to look up model limit.' : ''}`.trim();
    pop.innerHTML =
      `<div class="agy-ctx-pop-head"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(target.modelName)}</span><span class="agy-ctx-pop-badge">${badge}</span></div>` +
      `<div class="agy-ctx-pop-row"><span>Context window</span><span>${usageLine}</span></div>` +
      (limit ? `<div class="agy-ctx-pop-bar"><div class="agy-ctx-pop-fill" style="width:${(fraction * 100).toFixed(1)}%;background:${accent}"></div></div>` : '') +
      compactLine +
      (actual ? visibleLine + overhead : '') +
      lastTurnLine +
      sessionLine +
      (footerNote ? `<div class="agy-ctx-pop-muted">${footerNote}</div>` : '');
    if (!reuse) document.body.append(pop);
    activePopover = pop;
    activePopoverState = state;
    const r = ring.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const preferredLeft = r.left > window.innerWidth / 2 ? r.right - pr.width : r.left;
    const left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, preferredLeft));
    const top = Math.max(8, r.top - pr.height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };

  function render(state: State): void {
    const { usage, target, ring } = state;
    const limit = usage?.maxTokens;
    const actual = usage?.source === 'actual' && typeof usage.actualTokens === 'number' && Number.isFinite(usage.actualTokens);
    const known = actual || (typeof usage?.currentTokens === 'number' && Number.isFinite(usage.currentTokens));
    const count = actual ? usage!.actualTokens! : known ? usage!.currentTokens! : 0;
    const untilCompact = usage?.tokensUntilCompaction;
    let description = actual
      ? `Actual context: ${count.toLocaleString('en-US')} tokens (includes system prompt, tools and images)`
      : known
        ? `Visible transcript estimate: ~${count.toLocaleString('en-US')} tokens`
        : 'Context usage unavailable';
    if (limit)
      description += ` / ${limit.toLocaleString('en-US')} context limit (${
        usage?.limitSource === 'configured'
          ? 'configured'
          : usage?.limitSource === 'native-catalog'
            ? 'model catalog'
            : 'public catalog'
      })`;
    if (typeof untilCompact === 'number') {
      description += ` · ${untilCompact.toLocaleString('en-US')} tokens remaining before compact`;
    }
    if (actual) {
      if (typeof usage?.overheadTokens === 'number')
        description += ` · ${usage.overheadTokens.toLocaleString('en-US')} tokens for system prompt, tools and images`;
      if (typeof usage?.actualCachedTokens === 'number')
        description += ` · ${usage.actualCachedTokens.toLocaleString('en-US')} of the last prompt was cached`;
    } else if (known) {
      description += '. Hidden prompts, tool definitions and images are not included; actual usage can be higher.';
    }
    const speed = formatSpeed(usage?.tokensPerSecond);
    if (speed) description += ` · last generation ${speed}${typeof usage?.ttftMs === 'number' ? ` (first token ${formatLatency(usage.ttftMs)})` : ''}`;
    if (!target.conversationId) description += ' The open conversation could not be identified.';
    if (!limit) description += ' Click to look up the model limit in the public catalog.';
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
    const html =
      `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">` +
      `<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" opacity=".22" stroke-width="2"/>` +
      `<circle cx="8" cy="8" r="6" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="${circ}" stroke-dashoffset="${(circ * (1 - fraction)).toFixed(2)}"/>` +
      `</svg><span>${pillLabel}</span>`;
    if (ring.innerHTML !== html) ring.innerHTML = html;
    const findPermissionButton = (): HTMLElement | null => {
      const searchRoot = target.scope || state.composer;
      const candidates = Array.from(searchRoot.querySelectorAll<HTMLElement>('button,[role="button"]'));
      for (const btn of candidates) {
        if (btn === target.trigger || btn === ring || !visible(btn) || btn.closest('[data-agy-context-ring],.agy-ctx-popover')) continue;
        const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const label = text(btn);
        if (
          /permission|security-preset|approval|execution|policy/.test(testId) ||
          /permission|security|approval|execution|turbo|auto-run|review policy/.test(aria) ||
          /^(Turbo|Auto|Default|Review|Ask|Off|Manual|Safe|Agent-driven|Always Proceed|Request Review)$/i.test(label)
        ) {
          return btn;
        }
      }
      return null;
    };
    const permBtn = findPermissionButton();
    if (permBtn && permBtn.parentElement) {
      if (!permBtn.parentElement.hasAttribute('data-agy-context-toolbar')) {
        permBtn.parentElement.setAttribute('data-agy-context-toolbar', '');
      }
      toolbarParents.add(permBtn.parentElement);
      if (permBtn.previousElementSibling !== ring) permBtn.insertAdjacentElement('beforebegin', ring);
    } else {
      const parent = target.trigger.parentElement;
      if (parent) {
        if (!parent.hasAttribute('data-agy-context-toolbar')) parent.setAttribute('data-agy-context-toolbar', '');
        toolbarParents.add(parent);
      }
      if (target.trigger.nextElementSibling !== ring) target.trigger.insertAdjacentElement('afterend', ring);
    }
  }

  async function request(state: State, force = false): Promise<void> {
    if (stopped || states.get(state.composer) !== state) return;
    if (state.inFlight) {
      if (force) state.queued = true;
      return;
    }
    if (!force && Date.now() - state.lastRequest < 3000) return;
    const requested = state.target;
    const discoverLimit = state.discover;
    state.discover = false;
    state.inFlight = true;
    state.lastRequest = Date.now();
    try {
      const usage: Usage = await ipcRenderer.invoke('storage:get-chat-context-usage', {
        conversationId: requested.conversationId,
        modelName: requested.modelName,
        discoverLimit,
      });
      const current = readTarget(state.composer);
      if (stopped || !current || states.get(state.composer) !== state) return;
      if (current.key !== requested.key) {
        state.target = current;
        state.usage = undefined;
        state.lastRequest = 0;
        state.queued = true;
        render(state);
        return;
      }
      if (usage.conversationId && usage.conversationId !== requested.conversationId) return;
      state.target = current;
      if (typeof usage.maxTokens === 'number' && Number.isSafeInteger(usage.maxTokens) && usage.maxTokens > 0) {
        if (usage.limitSource === 'public-catalog')
          limits.set(requested.modelName, { maxTokens: usage.maxTokens, limitSource: usage.limitSource, expires: Date.now() + 300_000 });
      } else {
        const cached = limits.get(requested.modelName);
        if (cached && Date.now() < cached.expires) Object.assign(usage, { maxTokens: cached.maxTokens, limitSource: cached.limitSource });
      }
      if (usage.conversationId && typeof usage.compactions === 'number') {
        const currentCount = usage.actualTokens ?? usage.currentTokens;
        const prev = seenCompactions.get(usage.conversationId);
        if (prev && usage.compactions > prev.count && Date.now() - lastRealtimeToastAt > 20_000) {
          const detail =
            typeof prev.tokens === 'number' && typeof currentCount === 'number' && prev.tokens > currentCount
              ? `Context freed: ${formatCompactTokens(prev.tokens)} → ${formatCompactTokens(currentCount)} tokens`
              : 'Earlier messages were summarized to free context space.';
          showCompactToast(`Context compacted (#${usage.compactions})`, detail, state.ring);
        }
        seenCompactions.set(usage.conversationId, { count: usage.compactions, tokens: currentCount });
      }
      state.usage = usage;
      render(state);
      if (activePopover && activePopoverState === state && state.ring.isConnected) showPopover(state);
    } catch {
      const current = readTarget(state.composer);
      if (states.get(state.composer) === state && current && current.key === requested.key) {
        state.usage = undefined;
        render(state);
        if (activePopover && activePopoverState === state && state.ring.isConnected) showPopover(state);
      }
    } finally {
      state.inFlight = false;
      if (state.queued && !stopped && states.get(state.composer) === state) {
        state.queued = false;
        void request(state, true);
      }
    }
  }

  function refresh(force = false): void {
    if (stopped) return;
    if (!namesPending && Date.now() - namesAt > 30_000) {
      namesAt = Date.now();
      namesPending = true;
      void ipcRenderer.invoke('storage:get-custom-models').then((models: { name?: string; displayName?: string }[]) => {
        customNames = Array.isArray(models) ? models.flatMap((model) => [model.displayName, model.name])
          .filter((name): name is string => typeof name === 'string').map((name) => name.toLowerCase()) : [];
        schedule();
      }).catch(() => {}).finally(() => { namesPending = false; });
    }
    // One trigger owns one ring, even if future native DOM changes provide
    // several plausible composer containers for the same model control.
    const targets = new Map<HTMLElement, Target>();
    const triggers = new Set<HTMLElement>();
    for (const composer of composers()) {
      const target = readTarget(composer);
      if (target && !triggers.has(target.trigger)) {
        targets.set(composer, target);
        triggers.add(target.trigger);
      }
    }
    for (const parent of toolbarParents) {
      if (!parent.isConnected) toolbarParents.delete(parent);
    }
    for (const [composer, state] of states) {
      if (!targets.has(composer)) {
        if (activePopoverState === state) hidePopover();
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
      } else if (state.target.key !== target.key) {
        state.usage = undefined;
        state.lastRequest = 0;
        changed = true;
      }
      state.target = target;
      render(state);
      void request(state, force || changed);
    }
  }

  function schedule(): void {
    if (stopped || debounce) return;
    debounce = setTimeout(() => { debounce = undefined; refresh(); }, 100);
  }
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !(record.target instanceof Element && record.target.closest('[data-agy-context-ring], .agy-ctx-popover')))) schedule();
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
    if (debounce) clearTimeout(debounce);
    clearInterval(poll);
    window.removeEventListener('focus', focus);
    window.removeEventListener('popstate', route);
    window.removeEventListener('hashchange', route);
    hidePopover();
    if (toastTimer) clearTimeout(toastTimer);
    activeToast?.remove();
    if (typeof ipcRenderer.removeListener === 'function') {
      ipcRenderer.removeListener('agy:compaction-event', onRealtimeCompaction);
    }
    for (const state of states.values()) state.ring.remove();
    states.clear();
    for (const parent of toolbarParents) parent.removeAttribute('data-agy-context-toolbar');
    toolbarParents.clear();
    style.remove();
  }, { once: true });
  refresh();
});
