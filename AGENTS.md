# AGENTS.md — Antigravity Add-Model Context & Architecture

This file documents the project architecture, customizations, and key files so future sessions can pick up immediately without re-discovering everything.

## Mandatory Rule: Git Checkpoints (All Agents)
- **Before modifying code**: Check `git status`. If the working tree already has unrelated verified edits, commit them as a checkpoint first so there is always a clean rollback point.
- **After completing & verifying changes**: Once `npm run build` and relevant tests pass, **always commit a descriptive git checkpoint** (`git add` only relevant project files + `git commit -m "<type>: <summary>"`) before ending your turn. Never leave verified changes uncommitted across sessions.
- **Never commit** secrets, logs, or scratch review files (`scratch/`, `HERMES_UNDO_REVIEW.md`, `*.log`).
- **Remotes**: `myfork` (`https://github.com/akash-xzh/antigravity-add-model.git`) is the user's writable fork; `origin` (`https://github.com/vahapogut/antigravity-add-model.git`) is upstream. Push only to `myfork` when requested and never force-push `main`.
- **Easy rollback**: If an experiment breaks the app, restore cleanly with `git reset --hard HEAD` or `git revert <sha>`.

## Locations
- **Repository**: `c:\Users\AKASH\Documents\antigravity-add-model`
- **Installed Antigravity App**: `C:\Users\AKASH\AppData\Local\Programs\antigravity\resources` (`app.asar` + `bin/language_server.exe`)
- **Antigravity Data Directory**: `C:\Users\AKASH\.gemini\antigravity`
  - `custom_models.json` — Encrypted custom model configs (`local-gcm:...` via `cryptoStore.ts`)
  - `custom_model_identities.json` — Persistent native placeholder ID assignments
  - `model_health_cache.json` — Cached model health & recent models
  - `model_display_settings.json` — Persistent `{ showStatusEmoji: boolean }` setting
  - `system-prompt-sections.json` / `observed-prompt-sections.json` — Custom & live-captured system prompt sections
- **9router Sync Plugin**: `C:\Users\AKASH\.gemini\config\plugins\nine-router-sync\scripts\sync.mjs`
- **Desktop Zero-Token Sync Shortcut**: `C:\Users\AKASH\Desktop\Sync 9router Models.bat`
- **Electron Main Log**: `C:\Users\AKASH\AppData\Roaming\Antigravity\logs\main.log`

---

## How Antigravity UI & Proxy Work Together
- `app.asar` contains only the Electron main/preload/bridge JS (`dist/main.js`, `dist/languageServer.js`, etc.).
- The actual React frontend (`index.html`, `/main.js`, `/compiled_tailwind.css`) is embedded in `language_server.exe` and served over `https://127.0.0.1:<lsPort>/`.
- **Important**: Preload scripts (`src/customPreload.ts`) run with `contextIsolation: true` (isolated from `window` in `/main.js`). Cross-world signaling uses DOM attributes on `document.documentElement` (e.g. `document.documentElement.dataset.agyMitmSelector = "1"`).

---

## Implemented Features & Key Files

### 1. Real-Time `/main.js` MITM Model Selector
- **[`src/desktop.ts`](src/desktop.ts)**:
  - Uses `session.defaultSession.webRequest.onBeforeRequest` to redirect:
    - `https://127.0.0.1:<lsPort>/main.js` -> `http://127.0.0.1:<proxyPort>/_ui/main.js`
    - `LanguageServerService/GetAvailableModels` -> `http://127.0.0.1:<proxyPort>/GetAvailableModels?ls=...`
    - Cancels `LanguageServerService/SetCloudCodeURL`
- **[`src/proxy.ts`](src/proxy.ts)**:
  - Serves `GET /_ui/main.js`: fetches `/main.js` from `currentLanguageServerPort()`, patches it via `patchMainJsModelSelector()`, and returns it with `Access-Control-Allow-Origin: *`.
  - Serves `GET /_ui/custom-providers.json`: returns `buildCustomProviderMap(loadCustomModels())`.
- **[`src/proxy/uiMitm.ts`](src/proxy/uiMitm.ts)**:
  - Dynamically extracts minified React identifiers (`h0c`, `i0c`, `j0c`, `zW`, `GW`, `HW`, `yW`, `DW`) from `/main.js` using structural regexes (allowing `\s*` across newlines).
  - Replaces `j0c` in `/main.js` so React natively renders:
    - Search bar with magnifying glass icon (`left-3`) & clear `✕` button, plus `↻` refresh button in the `Model` header.
    - Official models at the top (`i0c`).
    - Divider (`DW`) + Provider submenus (`GW` / `HW` / `yW` -> `renderProviderItems()`) below for custom models, grouped by `providerName` (falling back to `(Provider)` suffix or `provider`).
    - `renderProviderItems()` collapses `(Minimal)`, `(Low)`, `(Medium)`, `(High)`, `(XHigh)`, `(Extra)` variants into native `GW` / `HW` / `yW` effort submenus even on Antigravity `2.34.0+` (where built-in `dW`/`bW` skips `isCustom` models).
    - Removes the `if (!a.isCustom)` guard from `bW` and adds `minimal` to `iSb` so the bottom `model-selector-trigger` button displays the selected effort dimmed beside the model name like official models.
    - **Effort tables** (`effortPatches` in `uiMitm.ts`) are matched by exact string anchors against the minified build, because the trigger only dims an effort it can derive: `["minimal",...]` order tables (`gSb`/`rSb`), `aW` labels, `iSb` label pattern, `lW` modelId pattern, and the two `nSb` fallbacks (`{name:a.label}` → derive `base`/`effort` via `bW`). Anchors that do not match are returned in `missed` and logged as `main.js effort patches not applicable to this build` — the previous regex-based attempts silently no-op'd on 2.34.0.
    - `collisionBoundary: "viewport"` on both provider `yW` and `h0c`/custom nested effort `yW` so effort sidebars open to the right instead of flipping left onto the main menu.
    - Auto-refresh: on mount, fetches `/_ui/custom-providers.json` and calls `refreshModels()` (`b()`) if custom models changed (throttled to 3s).
    - Sets `document.documentElement.dataset.agyMitmSelector = "1"`.
  - **Caveat**: Do **not** redirect `POST` Connect-RPC calls (`GetMendelFlags`, `GetUserStatus`, `GetCascadeModelConfigs`) from `https://127.0.0.1:<lsPort>` to `http://127.0.0.1:<proxyPort>` via `webRequest.onBeforeRequest` — Chromium blocks those cross-origin/mixed-content `POST` `fetch` redirects and prevents the model list from loading.
- **[`src/customPreload.ts`](src/customPreload.ts)**:
  - `checkModelPickerSearch()` exits immediately (and cleans up if mounted) when `document.documentElement.dataset.agyMitmSelector === '1'`, avoiding duplicate search bars or DOM flicker. (Fallback DOM picker remains for unit tests.)

### 2. Custom Provider Name Grouping (`providerName`)
- **[`src/schemaValidator.ts`](src/schemaValidator.ts)**, **[`src/modelStore.ts`](src/modelStore.ts)**, **[`src/proxy.ts`](src/proxy.ts)**:
  - Added optional `providerName?: string` (max 80 chars, no control chars) on custom models.
- **[`src/customPreload.ts`](src/customPreload.ts)**:
  - In Add/Edit/Discover modal, **Provider name (optional, for grouping)** is shown **only** when `provider === 'custom'` (hidden for premade presets like `nvidia`, `openai`, `anthropic`, etc.).
  - Custom Models dashboard groups by `providerName || provider` and shows a **Rename provider** batch action on `custom` groups.

### 3. Status Emoji Toggle
- **[`src/proxy/modelHealth.ts`](src/proxy/modelHealth.ts)** & **[`src/proxy/modelCatalog.ts`](src/proxy/modelCatalog.ts)**:
  - `loadDisplaySettings` / `saveDisplaySettings` / `isStatusEmojiEnabled` persist `showStatusEmoji` to `model_display_settings.json` (with `mtimeMs` cache invalidation).
  - `formatHealthDisplayName` and `catalogDisplayNames` return clean model names without `⭐` or `🟢 •` / `🟡 •` / `🔴 •` when disabled.
- **[`src/modelActions.ts`](src/modelActions.ts)** & **[`src/customPreload.ts`](src/customPreload.ts)**:
  - IPC channels `storage:get-display-settings` and `storage:save-display-settings`, wired to `#agy-toggle-status-emojis` checkbox in the Custom Models dashboard.

### 4. System Prompt & 9router Sync
- **[`src/proxy/promptSections.ts`](src/proxy/promptSections.ts)**:
  - `recordLivePromptSections()` captures Google's live prompt sections into `observed-prompt-sections.json` so defaults stay up to date.
- **[`sync.mjs`](file:///C:/Users/AKASH/.gemini/config/plugins/nine-router-sync/scripts/sync.mjs)** & **[`Sync 9router Models.bat`](file:///C:/Users/AKASH/Desktop/Sync%209router%20Models.bat)**:
  - Emits synced 9router models with `provider: 'custom'`, `apiFormat: 'openai'`, `providerName: group.name`, and effort variants `(Low)`, `(Medium)`, `(High)`, `(XHigh)`.
  - Desktop `.bat` is self-contained (embeds `sync.mjs` + `capabilities.mjs` and uses universal `%USERPROFILE%`/`%APPDATA%`/`%TEMP%` paths so it can be shared to any Windows PC with 0 AI tokens).

### 5. Duplicate Model Guard & Subagent Routing
- **[`src/modelActions.ts`](src/modelActions.ts)**, **[`src/proxy.ts`](src/proxy.ts)**, **[`src/proxy/modelCatalog.ts`](src/proxy/modelCatalog.ts)**:
  - Deduplicates models by `name` in `storage:get-custom-models`, `modelIdentities()`, and `loadCustomModels()`, adds `configIndex`, and uses `fallbackModelDisplayName()` when `displayName` is blank.
  - `src/proxy.ts` loads `./proxy/uiMitm` lazily via `getUiMitm()` so sandboxed proxy tests remain isolated.
- **[`src/proxy/subagentRouting.ts`](src/proxy/subagentRouting.ts)**:
  - Tracks `inherited`, `parentHttpModelName`, and `httpModelName` so subagents using an independent Executor custom model route to their own endpoint.

### 6. ASAR Packaging Gotcha
- **[`scripts/deploy.mjs`](scripts/deploy.mjs)**:
  - `REQUIRED_BUILD_FILES` must explicitly include every compiled file in `dist/` needed by the patched runtime (e.g. `proxy/globalPrompt.js`, `proxy/promptSections.js`, `proxy/modelHealth.js`, `proxy/nativeLimits.js`, `proxy/conversationUsage.js`, `proxy/uiMitm.js`). Missing an entry causes `Cannot find module` crashes on boot.
  - Sandboxed proxy tests (`src/__tests__/proxy-*.test.ts`, `subagent-routing-http.test.ts`) stub every `require` of `src/proxy.ts`: a new proxy dependency must be added to their `dependencies` map or every case fails with `Unexpected proxy dependency`.

### 7. Context Usage Pill, TPS, Native Limits & Settings / Quota UI
- **[`src/chatContext.ts`](src/chatContext.ts)** & **[`src/contextUsagePreload.ts`](src/contextUsagePreload.ts)**:
  - `getChatContextUsage` / `getContextInformation` return `actualTokens` (real prompt = `input_tokens` + `cache_read_tokens`), `overheadTokens`, `visibleInputTokens`/`visibleOutputTokens`, session totals, `turns`, `compactions`, `tokensPerTurn`, `compactionSource` (`custom` | `default` | `ide`), `compactionThresholdPercent`, `compactionAtTokens`, `tokensUntilCompaction`/`turnsUntilCompaction`, `maxTokens` + `limitSource` (`configured` | `native-catalog` | `public-catalog`), and `tokensPerSecond`/`ttftMs`.
  - Composer pill (`data-agy-context-ring`) shows `94.5K / 1.0M · 48 t/s`; the `.agy-ctx-popover` shows usage, compaction countdown, overhead, cache hit rate, `Last generation` speed and TTFT. Detail rows reuse the pill's compact K/M scale; the `Context used` line keeps exact numbers.
  - Compaction policy: `nativeCheckpointConfig` (`src/proxy/modelUtils.ts`) emits the IDE `CASCADE_USE_EXPERIMENT_CHECKPOINTER` override for every saved model that declares a real `contextWindow`, defaulting to `DEFAULT_COMPACTION_THRESHOLD_PERCENT` (**80%** of that window; the editor field overrides it). A model without a declared window keeps the IDE's own **50,000 new-token** default, because a guessed 1M window must never raise the trigger past the provider. `getContextInformation` calls `nativeCheckpointConfig` itself and reports `compactionSource: 'custom' | 'default'` with that exact `tokenThreshold`; `'ide'` means the IDE's own new-token default, which the popover labels `IDE default · ~50K new tokens` instead of a fake countdown.
- **[`src/proxy/nativeLimits.ts`](src/proxy/nativeLimits.ts)**:
  - Official models never appear in `custom_models.json`, so their context limit is captured from the language server catalog (`catalog.models[slug].maxTokens`) in `customCloudCodeCatalog()`, keyed by slug and `displayName` (lowercased, non-alphanumerics stripped) and cached in `native_model_limits.json`. `findNativeLimit()` ignores the picker's effort suffix (`Gemini 4 Hydrogen (Medium)`), and is only consulted when no saved custom model matched.
- **[`src/proxy/conversationUsage.ts`](src/proxy/conversationUsage.ts)**:
  - Process-local last usage/timing per conversation, keyed by UUID, bounded to 200 entries. `recordConversationUsage` (custom models, from `diagnostics.usage()` + measured decode window) and `recordConversationTiming` (native models: the `/v1internal:streamGenerateContent` tap in `src/proxy.ts` measures `ttftMs` and `decodeMs`; the tokens come from the transcript). `tokensPerSecond()` rejects sub-50ms windows and <2-token samples.
- **[`src/customPreload.ts`](src/customPreload.ts)**:
  - Model rows render densely (`.agy-row` → `.agy-row-title` + `.agy-row-meta` + `.agy-row-actions`; sticky search/filter bar, collapsible provider groups, effort chips). Each row keeps exactly one inline toggle (`Enable`/`Disable`) plus a `<details class="agy-menu">` overflow menu (`summary.agy-menu-btn` `⋯` → `Check`, `Test`, `Test generation`, `Edit`, `Duplicate`, `Effort variants`, `Delete`); the menu closes itself on any action, and the group header is a `grid` (title left / actions right) with a square `.agy-disclosure`. The post-delete focus target is the next row's `.agy-row-actions > .agy-btn`, because a button inside a closed `<details>` cannot take focus in a real browser. Google quota groups render as multi-column cards (`.agy-fleet-quotas`) in native order with `Weekly limit` / `5h limit`, `data-quota-level` colors, plan badges (`PRO`, `ULTRA`), weekly-only filtering for Free plans, and "Not included in your plan" for locked buckets.

### 8. Robust Custom Model Selection & Real Context/Compaction Fixes
- **Model Selection & Bypass of Native Label Lookup (`uiMitm.ts`)**:
  - Native Antigravity IDE uses `var Z = S.isCustom ? S : L7c(u, n, S.label)` when setting a model. Because custom models from `GetAvailableModels` did not have `isCustom: true`, Antigravity searched `L7c(u, n, S.label)` which failed whenever health status emojis (`🟢 • `) or free-tier filter `pl(a)` stripped non-Gemini models from `clientModelConfigs`, resulting in `Invalid model label` error and keeping whatever model was previously active.
  - Fix: All provider submenu and search items pass `{ ...opt, isCustom: true }` to `setSelectedModel(opt)` so `Z = S` evaluates directly without failing lookup. Additionally patched `pl(a)` in `/main.js` so `xqa` never strips custom models from `clientModelConfigs`.
- **Accurate Context & Compaction Thresholds (`chatContext.ts` & `modelUtils.ts`)**:
  - Fixed double-counting of cached context tokens: `actualTokens = recorded.inputTokens` (already includes cached tokens) and `actualInputTokens = Math.max(0, recorded.inputTokens - cachedTokens)`.
  - Compaction percentage display: `.agy-ctx-popover` now dynamically displays the true effective threshold percentage `(${compactPct ?? 80}%)` instead of hardcoding `(80%)`. When models have high `maxOutputTokens` (such as 128k from 9router), the usable input window is clamped by reserve, which the popover truthfully displays (`Before compact (35%): Threshold reached`). Setting `maxOutputTokens` to realistic generation bounds (e.g. 8k-16k) restores the full 80% input threshold.
- **MITM `/_ui/main.js` Loopback Security (`loopbackSecurity.ts`, `desktop.ts`, `proxy.ts`)**:
  - Redirecting `<script src="/main.js">` from `https://127.0.0.1:<lsPort>` to `http://127.0.0.1:<proxyPort>/_ui/main.js` triggers Chromium's `Sec-Fetch-Site: cross-site` with no `Origin` and stripped `Referer`. `loopbackSecurity.ts` generates a per-process random `UI_MITM_TOKEN` (`getUiMitmToken()`); `desktop.ts` appends `?t=<token>` on the redirect and `guardLoopbackRequest()` authenticates it via `timingSafeEqual` while continuing to block unauthenticated cross-site requests with `403`. `uiCorsHeaders()` keeps `Cross-Origin-Resource-Policy: cross-origin` without emitting wildcard `Access-Control-Allow-Origin: *`.


---

## Common Commands (PowerShell)
- **Build TypeScript**: `npm run build`
- **Preflight Check**: `node scripts/deploy.mjs --check`
- **Patch Antigravity**: Run `repath.bat` (or `node scripts/deploy.mjs`)
- **Run Relevant Tests**:
  ```powershell
  npx vitest run src/__tests__/ui-mitm.test.ts src/__tests__/custom-model-ui.test.ts src/__tests__/desktop.test.ts src/__tests__/model-health.test.ts src/__tests__/model-actions.test.ts
  ```
- **Run Full Test Suite**: `npx vitest run`
- **Sync 9router Models (0 tokens)**: Double-click `C:\Users\AKASH\Desktop\Sync 9router Models.bat` or run:
  ```powershell
  node "$env:USERPROFILE\.gemini\config\plugins\nine-router-sync\scripts\sync.mjs"
  ```
