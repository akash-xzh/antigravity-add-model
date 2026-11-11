"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PROMPT_SECTIONS = exports.STATIC_TAGS = void 0;
exports.promptSectionsFile = promptSectionsFile;
exports.loadPromptSectionsConfig = loadPromptSectionsConfig;
exports.savePromptSectionsConfig = savePromptSectionsConfig;
exports.rewritePromptSections = rewritePromptSections;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const defaultPromptSections_json_1 = __importDefault(require("./defaultPromptSections.json"));
exports.STATIC_TAGS = [
    'identity',
    'guidelines',
    'communication_style',
    'artifacts',
    'messaging',
    'conversation_transcript',
];
exports.DEFAULT_PROMPT_SECTIONS = defaultPromptSections_json_1.default;
function promptSectionsFile() {
    return (process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE ||
        node_path_1.default.join(node_os_1.default.homedir(), '.gemini', 'antigravity', 'system-prompt-sections.json'));
}
let cachedConfig;
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
/**
 * Replace targeted static XML-like tags in the prompt text while preserving all
 * dynamic sections (<skills>, <slash_commands>, <mcp_servers>, <user_information>, etc.).
 */
function rewritePromptSections(promptText) {
    const config = loadPromptSectionsConfig();
    let result = promptText;
    for (const tag of exports.STATIC_TAGS) {
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
            result = result.replace(tagRegex, replacement);
        }
    }
    return result;
}
//# sourceMappingURL=promptSections.js.map