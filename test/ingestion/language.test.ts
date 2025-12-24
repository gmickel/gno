/**
 * Language detector tests.
 * @module test/ingestion/language.test
 */

import { describe, expect, test } from 'bun:test';
import { SimpleLanguageDetector } from '../../src/ingestion/language';

describe('SimpleLanguageDetector', () => {
  const detector = new SimpleLanguageDetector();

  test('returns null for empty input', () => {
    expect(detector.detect('')).toBe(null);
  });

  test('returns null for short input', () => {
    expect(detector.detect('Hello')).toBe(null);
    expect(detector.detect('A'.repeat(49))).toBe(null);
  });

  test('detects English text', () => {
    const text =
      'The quick brown fox jumps over the lazy dog. This is a test of the English language detection system. The algorithm should be able to identify common English words and patterns.';
    expect(detector.detect(text)).toBe('en');
  });

  test('detects German text', () => {
    const text =
      'Der schnelle braune Fuchs springt über den faulen Hund. Das ist ein Test für die deutsche Spracherkennung. Der Algorithmus sollte deutsche Wörter und Muster erkennen können.';
    expect(detector.detect(text)).toBe('de');
  });

  test('detects French text', () => {
    const text =
      "Le renard brun rapide saute par-dessus le chien paresseux. C'est un test pour la détection de la langue française. L'algorithme devrait pouvoir identifier les mots et les modèles français.";
    expect(detector.detect(text)).toBe('fr');
  });

  test('detects Chinese text', () => {
    const text =
      '这是一个中文测试文本。我们需要测试语言检测系统能否正确识别中文内容。中文使用汉字书写，是一种表意文字系统。';
    expect(detector.detect(text)).toBe('zh');
  });

  test('detects Japanese text', () => {
    const text =
      'これは日本語のテストです。言語検出システムが日本語を正しく識別できるかどうかをテストしています。日本語はひらがな、カタカナ、漢字を使用します。';
    expect(detector.detect(text)).toBe('ja');
  });

  test('detects Korean text', () => {
    const text =
      '이것은 한국어 테스트입니다. 언어 감지 시스템이 한국어를 올바르게 식별할 수 있는지 테스트하고 있습니다. 한국어는 한글을 사용합니다.';
    expect(detector.detect(text)).toBe('ko');
  });

  test('returns null for mixed/ambiguous content', () => {
    const text = '12345 67890 !@#$% ^&*() [] {} | \\ : ; " \' < > , . ? /';
    expect(detector.detect(text)).toBe(null);
  });

  test('prioritizes CJK over European detection', () => {
    // Text with both CJK and English, but CJK dominant (must be > 50 chars)
    const text =
      '这是一个测试文本，包含中文和英文混合内容。The quick brown fox jumps. 但是中文内容占主导地位，所以应该检测为中文。';
    expect(detector.detect(text)).toBe('zh');
  });

  test('handles text with code blocks', () => {
    const text = `
The following code demonstrates the pattern:

function hello() {
  console.log("Hello, world!");
}

This is a common programming pattern used in JavaScript applications.
The function simply outputs a greeting message to the console.
    `;
    // Should still detect as English due to surrounding prose
    const result = detector.detect(text);
    expect(result === 'en' || result === null).toBe(true);
  });
});
