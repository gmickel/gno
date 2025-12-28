import { describe, expect, test } from 'bun:test';

import { detectQueryLanguage } from '../../src/pipeline/query-language';

describe('detectQueryLanguage', () => {
  describe('known language detection', () => {
    test('detects English text', () => {
      const result = detectQueryLanguage(
        'What is the best way to implement this feature'
      );
      expect(result.bcp47).toBe('en');
      expect(result.iso639_3).toBe('eng');
      expect(result.confident).toBe(true);
    });

    test('detects German text', () => {
      const result = detectQueryLanguage(
        'Wie kann ich diese Funktion am besten implementieren'
      );
      expect(result.bcp47).toBe('de');
      expect(result.iso639_3).toBe('deu');
      expect(result.confident).toBe(true);
    });

    test('detects French text', () => {
      const result = detectQueryLanguage(
        'Comment configurer les déploiements kubernetes'
      );
      expect(result.bcp47).toBe('fr');
      expect(result.iso639_3).toBe('fra');
      expect(result.confident).toBe(true);
    });

    test('detects Spanish text', () => {
      const result = detectQueryLanguage(
        'Cómo puedo implementar esta función en mi aplicación'
      );
      expect(result.bcp47).toBe('es');
      expect(result.iso639_3).toBe('spa');
      expect(result.confident).toBe(true);
    });
  });

  describe('short text handling', () => {
    test('returns und for text under 15 chars', () => {
      const result = detectQueryLanguage('hello world');
      expect(result.bcp47).toBe('und');
      expect(result.iso639_3).toBe('und');
      expect(result.confident).toBe(false);
    });

    test('returns und for empty string', () => {
      const result = detectQueryLanguage('');
      expect(result.bcp47).toBe('und');
      expect(result.iso639_3).toBe('und');
      expect(result.confident).toBe(false);
    });

    test('returns und for whitespace only', () => {
      const result = detectQueryLanguage('     ');
      expect(result.bcp47).toBe('und');
      expect(result.iso639_3).toBe('und');
      expect(result.confident).toBe(false);
    });
  });

  describe('determinism', () => {
    test('same input produces same output', () => {
      const input = 'How do I configure kubernetes deployments in production';
      const result1 = detectQueryLanguage(input);
      const result2 = detectQueryLanguage(input);
      const result3 = detectQueryLanguage(input);

      expect(result1.bcp47).toBe(result2.bcp47);
      expect(result2.bcp47).toBe(result3.bcp47);
      expect(result1.iso639_3).toBe(result2.iso639_3);
      expect(result1.confident).toBe(result2.confident);
    });
  });

  describe('edge cases', () => {
    test('handles code snippets gracefully', () => {
      const result = detectQueryLanguage('function foo() { return bar.baz() }');
      // Code may be detected as some language or und, but shouldn't error
      expect(result.bcp47).toBeDefined();
      expect(typeof result.bcp47).toBe('string');
      expect(typeof result.confident).toBe('boolean');
    });

    test('handles numbers and symbols', () => {
      const result = detectQueryLanguage('12345 !@#$% 67890 ^&*() 12345');
      // Numbers and symbols should return und or some fallback
      expect(result).toBeDefined();
    });

    test('trims whitespace before detection', () => {
      const result1 = detectQueryLanguage(
        '  What is the best way to implement this  '
      );
      const result2 = detectQueryLanguage(
        'What is the best way to implement this'
      );
      expect(result1.bcp47).toBe(result2.bcp47);
    });
  });

  describe('ISO 639-3 to BCP-47 mapping', () => {
    test('maps eng to en', () => {
      const result = detectQueryLanguage(
        'This is a long enough English sentence for detection'
      );
      if (result.iso639_3 === 'eng') {
        expect(result.bcp47).toBe('en');
      }
    });

    test('maps deu to de', () => {
      const result = detectQueryLanguage(
        'Dies ist ein ausreichend langer deutscher Satz'
      );
      if (result.iso639_3 === 'deu') {
        expect(result.bcp47).toBe('de');
      }
    });
  });
});
