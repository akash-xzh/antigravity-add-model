import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PROMPT_SECTIONS,
  getAvailableTags,
  getEffectivePromptDefaults,
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
const prevObservedEnv = process.env.ANTIGRAVITY_OBSERVED_SECTIONS_FILE;
afterEach(() => {
  if (prevEnv === undefined) delete process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE;
  else process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE = prevEnv;
  if (prevObservedEnv === undefined) delete process.env.ANTIGRAVITY_OBSERVED_SECTIONS_FILE;
  else process.env.ANTIGRAVITY_OBSERVED_SECTIONS_FILE = prevObservedEnv;
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

  it('dynamically captures live prompt updates from Google into observed defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sections-test-'));
    dirs.push(dir);
    process.env.ANTIGRAVITY_OBSERVED_SECTIONS_FILE = path.join(dir, 'observed.json');

    const googleUpdatedPrompt = [
      '<identity>\nYou are Antigravity 3.0, designed by Google DeepMind.\n</identity>',
      '<guidelines>\nUpdated Guidelines from Google 2026.\n</guidelines>',
      '<brand_new_section>\nSpecial rules.\n</brand_new_section>',
      '<skills>\nDynamic skill\n</skills>',
    ].join('\n');

    rewritePromptSections(googleUpdatedPrompt);

    const effectiveDefaults = getEffectivePromptDefaults();
    expect(effectiveDefaults.identity).toBe('You are Antigravity 3.0, designed by Google DeepMind.');
    expect(effectiveDefaults.guidelines).toBe('Updated Guidelines from Google 2026.');
    expect(effectiveDefaults.brand_new_section).toBe('Special rules.');

    const availableTags = getAvailableTags();
    expect(availableTags).toContain('brand_new_section');
    expect(availableTags).not.toContain('skills');
  });

  it('preserves $$, $&, $1, and LaTeX math literally without String.prototype.replace pattern corruption', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sections-test-'));
    dirs.push(dir);
    process.env.ANTIGRAVITY_OBSERVED_SECTIONS_FILE = path.join(dir, 'observed.json');
    const customStyle = [
      '- Display math uses $$E = mc^2$$ on its own line.',
      '- Keep $& and $1 and $\' and $` literally intact.',
      '- Prices: \\$100, shell: `$HOME`, awk `$1`.',
    ].join('\n');
    process.env.ANTIGRAVITY_PROMPT_SECTIONS_FILE = tempConfig({
      overrides: { communication_style: customStyle },
    });

    const prompt = '<communication_style>\nOld style\n</communication_style>\n<skills>Keep</skills>';
    const result = rewritePromptSections(prompt);

    expect(result).toBe(`<communication_style>\n${customStyle}\n</communication_style>\n<skills>Keep</skills>`);
  });
});
