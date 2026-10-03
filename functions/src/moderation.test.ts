import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptKo, moderateRules } from './moderation';

test('폭력 표현은 막는다', () => assert.equal(moderateRules('동생을 때리는').category, '폭력'));
test('칼국수는 막지 않는다', () => assert.equal(moderateRules('엄마와 칼국수를 먹는').pass, true));
test('전화번호는 막는다', () => assert.equal(moderateRules('내 번호 010-1234-5678').category, '개인정보'));
test('평범한 문장은 통과', () => assert.equal(moderateRules('AI 스피커에게 날씨를 물어보는').pass, true));
test('조사', () => {
  assert.equal(buildPromptKo({ who: '나', what: '웃는', where: '거실', how: '' }), '내가 거실에서 웃는');
  assert.equal(buildPromptKo({ who: 'AI 스피커', what: '말하는', where: '', how: '' }), 'AI 스피커가 말하는');
  assert.equal(buildPromptKo({ who: '로봇청소기', what: '', where: '', how: '' }), '로봇청소기가');
  assert.equal(buildPromptKo({ who: '동생', what: '', where: '', how: '' }), '동생이');
});
