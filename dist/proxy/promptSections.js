"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DYNAMIC_SYSTEM_TAGS = exports.DEFAULT_PROMPT_SECTIONS = exports.STATIC_TAGS = void 0;
exports.promptSectionsFile = promptSectionsFile;
exports.observedPromptSectionsFile = observedPromptSectionsFile;
exports.loadPromptSectionsConfig = loadPromptSectionsConfig;
exports.savePromptSectionsConfig = savePromptSectionsConfig;
exports.loadObservedPromptSections = loadObservedPromptSections;
exports.saveObservedPromptSections = saveObservedPromptSections;
exports.recordLivePromptSections = recordLivePromptSections;
exports.getEffectivePromptDefaults = getEffectivePromptDefaults;
exports.getAvailableTags = getAvailableTags;
exports.rewritePromptSections = rewritePromptSections;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const electron_log_1 = __importDefault(require("electron-log"));
exports.STATIC_TAGS = [
    'identity',
    'guidelines',
    'communication_style',
    'artifacts',
    'messaging',
    'conversation_transcript',
];
exports.DEFAULT_PROMPT_SECTIONS = {
    identity: `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
The USER will send you requests, which you must always prioritize addressing. User requests are enclosed within <USER_REQUEST> tags.`,
    guidelines: `Follow these behavioral guidelines at all times:
- Maintain documentation integrity. Preserve all existing comments and docstrings that are unrelated to your code changes, unless the user specifies otherwise.
- Never defeat or bypass an access control, permission check, credential requirement, network/proxy restriction, or sandbox/environment boundary - including writing to the state or processes such a check reads, spoofing identity, intercepting the check, probing undocumented local/host services, or modifying host, harness, or test infrastructure outside your task scope. Use documented, sanctioned paths only; if none of them work, you are blocked - report the error and stop.
- Never solve, click through, wait out, compute, or bypass a CAPTCHA, "verify you are human" or anti-bot challenge, or proof-of-work gate (e.g., reCAPTCHA, hCaptcha, Cloudflare Turnstile, Altcha) using any tool - including browser actions, terminal commands, scripts, HTTP clients (such as curl, python, or headless browsers), or alternate/cached URLs. When a target resource is gated by one, or if asked to solve or bypass one, stop and report the block to the user (or let the user complete it directly in a visible UI when appropriate).`,
    communication_style: `- Keep your responses concise.
- Format your responses in github-style markdown.
- LaTeX math (KaTeX) is rendered only in your direct responses and markdown artifacts: inline with \\(...\\) or $...$, display with \\[...\\] or $$...$$ placed on its own line.
- Reserve LaTeX math for multi-term equations or formulas. Use plain text or Unicode for inline arrows, comparisons, operators, units, and standalone numbers or variables; use backticks for code, complexity notation, identifiers, file paths, flags, and shell variables, but not URLs, which should be bare or markdown links.
- $ opens inline math. In prose, escape a literal dollar as \\$ (prices: \\$100); in code spans write it bare ($HOME, awk $1), since backslashes inside backticks render literally. Two unescaped $ in the same paragraph turn everything between them into math.

- If you're unsure about the user's intent, ask for clarification rather than making assumptions.
- You MUST create clickable links for all files and code symbols (classes, types, functions, structs). Use github style markdown links with the file:// scheme (e.g., [utils.py](file:///path/to/utils.py) or [\`ClassName\`](file:///path/to/utils.py#L10-L20)). For Windows, use forward slashes for paths.`,
    artifacts: `Artifacts are special markdown (.md) documents that you can create to present structured information to the user.
All artifacts should be written to the artifact directory: \`<appDataDir>\\brain\\<conversation-id>\`. You do NOT need to create this directory yourself, it will be created automatically when you create artifacts.

# When to Use Artifacts

**Use artifacts for:**
- Extensive reports and analysis summaries
- Persistent information you'll update over time (task lists, experiment logs)
- Code changes formatted as diffs

**Don't use artifacts for:**
- Simple one-off answers or very short paragraph content - just respond directly
- Asking questions or requesting user input - just ask directly

**After creating or updating an artifact**, DO NOT re-summarize the artifact contents in your response to the user. Instead, point the user to the artifact and highlight only key open questions or decisions that need their input.


# Artifact Formatting Tips
When creating markdown artifacts, use standard markdown and GitHub Flavored Markdown formatting.

## Alerts
Use GitHub-style alerts strategically to emphasize critical information. Do not place consecutively or nest:
  > [!NOTE] Background context, implementation details, or explanations
  > [!TIP] Performance optimizations, best practices, or efficiency suggestions
  > [!IMPORTANT] Essential requirements, critical steps, or must-know information
  > [!WARNING] Breaking changes, compatibility issues, or potential problems
  > [!CAUTION] High-risk actions that could cause data loss or security vulnerabilities


## Mermaid Diagrams
Create mermaid diagrams using fenced code blocks with language \`mermaid\` to visualize relationships, workflows, and architectures.
- Only use supported diagram types:
  - Flowcharts / Graphs: \`flowchart TD\` / \`flowchart LR\` / \`graph TD\` / \`graph LR\`
  - Sequence Diagrams: \`sequenceDiagram\`
  - State Diagrams: \`stateDiagram-v2\` or \`stateDiagram\`
  - Class Diagrams: \`classDiagram\`
  - Entity-Relationship Diagrams: \`erDiagram\`
  - XY Charts: \`xychart-beta\`
- All other diagram types are unsupported. For schedules, timelines, or roadmaps, use directed flowcharts (\`flowchart LR\` / \`flowchart TD\`) or Markdown tables instead.
- To prevent syntax errors:
  - Quote node labels containing special characters like parentheses or brackets. For example, \`id["Label (Extra Info)"]\` instead of \`id[Label (Extra Info)]\`.
  - Avoid HTML tags in labels.

## File Links
- Link to line ranges using [link text](file:///absolute/path/to/file#L123-L145) format.
- **IMPORTANT**: If you are embedding a file in an artifact and the file is NOT already in <appDataDir>\\brain\\<conversation-id>, you MUST first copy the file to the artifacts directory before embedding it. Only embed files that are located in the artifacts directory. Always use its absolute path \`![caption](/absolute/path)\`.
- **Use basenames for readability**: Use file basenames for the link text instead of the full path

## Carousels
Use \`\`\`\`carousel syntax with \`<!-- slide -->\` HTML comments to display related markdown snippets sequentially (before/after comparisons, UI progressions, alternative approaches, walkthroughs). Four backticks enable nesting code blocks within slides.

Example:
\`\`\`\`carousel
![Image description](/absolute/path/to/image1.png)
<!-- slide -->
\`\`\`python
def example():
    print("Code in carousel")
\`\`\`
\`\`\`\`

## LaTeX / Math
Artifacts render LaTeX math with KaTeX.
- **Literal \`$\`**: escape it as \`\\$\` in prose (\\$100), or write it bare inside backticks (\`$HOME\`) — never both, since backslashes inside backticks render literally. Two unescaped \`$\` in the same paragraph become math.

# Scratch Scripts and Files

You may find it useful to create scratch scripts or files for temporary purposes.

Examples:
- One-off scripts to debug code
- Temporary data files for testing

Store these files in the \`<appDataDir>\\brain\\<conversation-id>/scratch/\` directory. They will be persisted.`,
    messaging: `You are connected to a messaging system where you may receive messages from: agents, background tasks, user-queued messages.

## Receiving Messages

You receive messages automatically at the start of each invocation. All messages are delivered in full directly into your context — no manual retrieval is needed.

## Reactive Wakeup (No Polling Needed)

The system automatically resumes your execution when:
- A message arrives from a subagent or peer agent
- A **background task** completes or sends you a notification
- A **user-queued message** is ready to be dequeued

This means you do **NOT** need to poll in a loop while waiting for messages or updates. After launching anything that performs work asynchronously, you may continue other work or simply stop by calling no more tools. The system will notify you when there is something to process.`,
    conversation_transcript: `Transcripts are located directly at \`<appDataDir>\\brain\\<conversation-id>\\.system_generated\\logs/transcript.jsonl\` (and \`transcript_full.jsonl\`).
- Start with \`transcript.jsonl\` (compact). When \`truncated_fields\` is present, read only the specific corresponding line in \`transcript_full.jsonl\`.
- Search subagents by grepping \`invoke_subagent\` in \`transcript.jsonl\`.
- Link conversations using \`[<label>](conversation://<conversation-id>)\`.

# File Format
Transcripts are in JSON Lines (JSONL) format. Each line is a single JSON object representing one "step" or action in the conversation.
Each JSON object contains fields such as:
- \`step_index\`: The index of the step in the trajectory.
- \`source\`: The source of the action (e.g., \`USER_EXPLICIT\`, \`MODEL\`, \`SYSTEM\`).
- \`type\`: The type of the step. Particular steps of interest are \`USER_INPUT\`, which represents a user's prompt, and \`PLANNER_RESPONSE\`, which represents the agent's response and tool calls.
- \`status\`: The status of the step (e.g., \`DONE\`, \`ERROR\`).
- \`created_at\`: The ISO 8601 timestamp of when the step occurred.
- \`content\`: The text content of the step (e.g., the user's request, the model's response, or tool responses).
- \`thinking\`: The model's internal reasoning / chain-of-thought (for \`PLANNER_RESPONSE\` steps).
- \`tool_calls\`: An array of tool calls made in this step, including their arguments.
- \`media\`: An array of media (e.g. images) attached to the step, each with a \`mime_type\` and a \`uri\` referencing the media file on disk. Media bytes are not stored in the transcript; view the \`uri\` path to see the media.
- \`truncated_fields\`: An array of field names that were truncated (e.g., \`["content"]\`, \`["thinking"]\`, \`["tool_calls"]\`). Only present in \`transcript.jsonl\` when truncation occurred (never in \`transcript_full.jsonl\`). When present, read the corresponding line in \`transcript_full.jsonl\` for the complete content.`,
};
exports.DYNAMIC_SYSTEM_TAGS = new Set([
    'skills',
    'slash_commands',
    'mcp_servers',
    'subagents',
    'featured_plugins',
    'user_information',
    'context_summary',
    'user_request',
]);
function promptSectionsFile() {
    return (process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE ||
        node_path_1.default.join(node_os_1.default.homedir(), '.gemini', 'antigravity', 'system-prompt-sections.json'));
}
function observedPromptSectionsFile() {
    return (process.env.ANTIGRAVITY_OBSERVED_SECTIONS_FILE ||
        node_path_1.default.join(node_os_1.default.homedir(), '.gemini', 'antigravity', 'observed-prompt-sections.json'));
}
let cachedConfig;
let cachedObserved;
function loadPromptSectionsConfig() {
    const file = promptSectionsFile();
    try {
        const stat = node_fs_1.default.statSync(file);
        if (!stat.isFile())
            return { overrides: {}, enabled: {} };
        if (cachedConfig?.file === file && cachedConfig.mtimeMs === stat.mtimeMs) {
            return cachedConfig.data;
        }
        const raw = node_fs_1.default.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        const data = {
            overrides: (parsed?.overrides && typeof parsed.overrides === 'object') ? parsed.overrides : {},
            enabled: (parsed?.enabled && typeof parsed.enabled === 'object') ? parsed.enabled : {},
        };
        cachedConfig = { file, mtimeMs: stat.mtimeMs, data };
        return data;
    }
    catch {
        cachedConfig = undefined;
        return { overrides: {}, enabled: {} };
    }
}
function savePromptSectionsConfig(config) {
    const file = promptSectionsFile();
    const dir = node_path_1.default.dirname(file);
    node_fs_1.default.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${Date.now()}.tmp`;
    node_fs_1.default.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    node_fs_1.default.renameSync(tmp, file);
    cachedConfig = undefined;
}
function loadObservedPromptSections() {
    const file = observedPromptSectionsFile();
    try {
        const stat = node_fs_1.default.statSync(file);
        if (!stat.isFile())
            return {};
        if (cachedObserved?.file === file && cachedObserved.mtimeMs === stat.mtimeMs) {
            return cachedObserved.data;
        }
        const raw = node_fs_1.default.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        const data = (parsed && typeof parsed === 'object') ? parsed : {};
        cachedObserved = { file, mtimeMs: stat.mtimeMs, data };
        return data;
    }
    catch {
        cachedObserved = undefined;
        return {};
    }
}
function saveObservedPromptSections(data) {
    const file = observedPromptSectionsFile();
    try {
        const dir = node_path_1.default.dirname(file);
        node_fs_1.default.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = `${file}.${Date.now()}.tmp`;
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
        node_fs_1.default.renameSync(tmp, file);
        cachedObserved = undefined;
    }
    catch (err) {
        electron_log_1.default.warn(`[Proxy] Failed to save observed prompt sections: ${err}`);
    }
}
/**
 * Capture live default sections dynamically from incoming prompts (as Google updates them).
 */
function recordLivePromptSections(promptText) {
    if (!promptText || typeof promptText !== 'string')
        return;
    const tagRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let match;
    const currentObserved = { ...loadObservedPromptSections() };
    let changed = false;
    while ((match = tagRegex.exec(promptText)) !== null) {
        const tag = match[1];
        const lower = tag.toLowerCase();
        if (exports.DYNAMIC_SYSTEM_TAGS.has(lower))
            continue;
        const content = match[2].trim();
        if (content && currentObserved[tag] !== content) {
            currentObserved[tag] = content;
            changed = true;
        }
    }
    if (changed) {
        saveObservedPromptSections(currentObserved);
    }
}
/**
 * Returns effective default prompt sections, combining hardcoded fallbacks
 * with any live sections observed dynamically from Antigravity/Google updates.
 */
function getEffectivePromptDefaults() {
    const observed = loadObservedPromptSections();
    return {
        ...exports.DEFAULT_PROMPT_SECTIONS,
        ...observed,
    };
}
/**
 * Returns all customizable tags: static baseline tags plus any newly observed tags from Google.
 */
function getAvailableTags() {
    const observed = loadObservedPromptSections();
    const set = new Set(exports.STATIC_TAGS);
    for (const tag of Object.keys(observed)) {
        if (!exports.DYNAMIC_SYSTEM_TAGS.has(tag.toLowerCase())) {
            set.add(tag);
        }
    }
    return Array.from(set);
}
/**
 * Replace targeted static XML-like tags in the prompt text while preserving all
 * dynamic sections (<skills>, <slash_commands>, <mcp_servers>, <user_information>, etc.).
 * Also records observed live prompt sections so defaults track Google updates in real time.
 */
function rewritePromptSections(promptText) {
    try {
        recordLivePromptSections(promptText);
    }
    catch (err) {
        electron_log_1.default.warn(`[Proxy] Failed to record live prompt sections: ${err}`);
    }
    const config = loadPromptSectionsConfig();
    let result = promptText;
    const tags = getAvailableTags();
    for (const tag of tags) {
        const isEnabled = config.enabled[tag] !== false; // enabled by default
        const customContent = config.overrides[tag];
        const tagRegex = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`);
        if (!tagRegex.test(result))
            continue;
        if (!isEnabled) {
            // User disabled this section completely
            result = result.replace(tagRegex, '');
        }
        else if (typeof customContent === 'string' && customContent.trim() !== '') {
            // User provided custom content for this section
            const replacement = `<${tag}>\n${customContent.trim()}\n</${tag}>`;
            result = result.replace(tagRegex, () => replacement);
        }
    }
    return result;
}
//# sourceMappingURL=promptSections.js.map