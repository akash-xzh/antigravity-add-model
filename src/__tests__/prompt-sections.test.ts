import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PROMPT_SECTIONS,
  loadPromptSectionsConfig,
  promptSectionsFile,
  rewritePromptSections,
  savePromptSectionsConfig,
  STATIC_TAGS,
} from '../proxy/promptSections';
import { withGlobalSystemPrompt } from '../proxy/globalPrompt';

const dirs: string[] = [];
function tempConfig(data?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sections-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'system-prompt-sections.json');
  if (data) fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

const prevEnv = process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE;
afterEach(() => {
  if (prevEnv === undefined) delete process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE;
  else process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE = prevEnv;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('prompt sections configuration & rewriting', () => {
  it('exposes all static tags with valid defaults', () => {
    expect(STATIC_TAGS).toContain('identity');
    expect(STATIC_TAGS).toContain('guidelines');
    expect(STATIC_TAGS).toContain('communication_style');
    for (const tag of STATIC_TAGS) {
      expect(DEFAULT_PROMPT_SECTIONS[tag]).toBeTruthy();
      expect(typeof DEFAULT_PROMPT_SECTIONS[tag]).toBe('string');
    }
  });

  it('saves and reloads custom sections configuration', () => {
    process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE = tempConfig();
    const config = {
      overrides: { identity: 'Custom Identity Rule' },
      enabled: { guidelines: false },
    };
    savePromptSectionsConfig(config);
    const loaded = loadPromptSectionsConfig();
    expect(loaded.overrides.identity).toBe('Custom Identity Rule');
    expect(loaded.enabled.guidelines).toBe(false);
  });

  it('rewrites specified tags while preserving dynamic tags (<skills>, <user_information>)', () => {
    process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE = tempConfig({
      overrides: { identity: 'I am a specialized assistant.' },
      enabled: { guidelines: false },
    });

    const samplePrompt = [
      '<identity>\nDefault Identity\n</identity>',
      '<guidelines>\nDefault Guidelines\n</guidelines>',
      '<skills>\nInstalled skill: my-custom-skill\n</skills>',
      '<user_information>\nWorkspace: /my/project\n</user_information>',
    ].join('\n');

    const result = rewritePromptSections(samplePrompt);

    expect(result).toContain('<identity>\nI am a specialized assistant.\n</identity>');
    expect(result).not.toContain('<guidelines>');
    expect(result).not.toContain('Default Guidelines');
    expect(result).toContain('<skills>\nInstalled skill: my-custom-skill\n</skills>');
    expect(result).toContain('<user_information>\nWorkspace: /my/project\n</user_information>');
  });

  it('applies section rewriting inside withGlobalSystemPrompt', () => {
    process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE = tempConfig({
      overrides: { identity: 'New Identity' },
    });

    const body = {
      systemInstruction: {
        parts: [{ text: '<identity>Old Identity</identity>\n<skills>my-skills</skills>' }],
      },
      contents: [],
    };

    const updated = withGlobalSystemPrompt(body);
    const text = (updated.systemInstruction as { parts: { text: string }[] }).parts[0].text;
    expect(text).toContain('<identity>\nNew Identity\n</identity>');
    expect(text).toContain('<skills>my-skills</skills>');
  });
});
