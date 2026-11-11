import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import defaultSectionsJson from './defaultPromptSections.json';

export const STATIC_TAGS = [
  'identity',
  'guidelines',
  'communication_style',
  'artifacts',
  'messaging',
  'conversation_transcript',
] as const;

export type StaticTag = (typeof STATIC_TAGS)[number];

export const DEFAULT_PROMPT_SECTIONS: Record<StaticTag, string> = defaultSectionsJson as Record<StaticTag, string>;

export interface PromptSectionsConfig {
  overrides: Partial<Record<StaticTag, string>>;
  enabled: Partial<Record<StaticTag, boolean>>;
}

export function promptSectionsFile(): string {
  return (
    process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'system-prompt-sections.json')
  );
}

let cachedConfig: { file: string; mtimeMs: number; data: PromptSectionsConfig } | undefined;

export function loadPromptSectionsConfig(): PromptSectionsConfig {
  const file = promptSectionsFile();
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { overrides: {}, enabled: {} };
    if (cachedConfig?.file === file && cachedConfig.mtimeMs === stat.mtimeMs) {
      return cachedConfig.data;
    }
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PromptSectionsConfig>;
    const data: PromptSectionsConfig = {
      overrides: (parsed?.overrides && typeof parsed.overrides === 'object') ? parsed.overrides : {},
      enabled: (parsed?.enabled && typeof parsed.enabled === 'object') ? parsed.enabled : {},
    };
    cachedConfig = { file, mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    cachedConfig = undefined;
    return { overrides: {}, enabled: {} };
  }
}

export function savePromptSectionsConfig(config: PromptSectionsConfig): void {
  const file = promptSectionsFile();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  cachedConfig = undefined;
}

/**
 * Replace targeted static XML-like tags in the prompt text while preserving all
 * dynamic sections (<skills>, <slash_commands>, <mcp_servers>, <user_information>, etc.).
 */
export function rewritePromptSections(promptText: string): string {
  const config = loadPromptSectionsConfig();
  let result = promptText;

  for (const tag of STATIC_TAGS) {
    const isEnabled = config.enabled[tag] !== false; // enabled by default
    const customContent = config.overrides[tag];

    const tagRegex = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`);
    if (!tagRegex.test(result)) continue;

    if (!isEnabled) {
      // User disabled this section completely
      result = result.replace(tagRegex, '');
    } else if (typeof customContent === 'string' && customContent.trim() !== '') {
      // User provided custom content for this section
      const replacement = `<${tag}>\n${customContent.trim()}\n</${tag}>`;
      result = result.replace(tagRegex, replacement);
    }
  }

  return result;
}
