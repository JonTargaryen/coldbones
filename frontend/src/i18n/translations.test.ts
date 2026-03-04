import { describe, expect, it } from 'vitest';
import { LANGUAGES, MODEL_LANGUAGE_INSTRUCTIONS, TRANSLATION_MAP } from './translations';

describe('translations', () => {
  it('contains supported languages and translation maps', () => {
    expect(LANGUAGES.map(l => l.code)).toEqual(['en', 'hi', 'es', 'bn']);
    expect(Object.keys(TRANSLATION_MAP)).toEqual(['en', 'hi', 'es', 'bn']);
  });

  it('provides translation entries for each language', () => {
    for (const lang of LANGUAGES) {
      const t = TRANSLATION_MAP[lang.code];
      expect(t.appSubtitle.length).toBeGreaterThan(0);
      expect(t.uploadTitle.length).toBeGreaterThan(0);
      expect(t.analyzeBtn(2).length).toBeGreaterThan(0);
      expect(t.processedIn('1.2').length).toBeGreaterThan(0);
      expect(t.failedChecks(2).length).toBeGreaterThan(0);
    }
  });

  it('has model language instructions for each language key', () => {
    expect(Object.keys(MODEL_LANGUAGE_INSTRUCTIONS)).toEqual(['en', 'hi', 'es', 'bn']);
    expect(MODEL_LANGUAGE_INSTRUCTIONS.en).toBe('');
    expect(MODEL_LANGUAGE_INSTRUCTIONS.hi).toContain('Hindi');
    expect(MODEL_LANGUAGE_INSTRUCTIONS.es).toContain('Spanish');
    expect(MODEL_LANGUAGE_INSTRUCTIONS.bn).toContain('Bengali');
  });
});
