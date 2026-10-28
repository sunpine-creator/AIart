// 1단계(규칙) 윤리 검사. 걸리면 막지 않고 선생님 확인으로 보낸다. 통과하면 ai/text.ts 의 2단계(Gemini 맥락) 검사를 거친다.
// web/src/moderation.ts 와 같은 규칙을 쓴다(학생 화면의 미리 알림용). 바꿀 때는 둘 다 바꾼다.
export type RuleVerdict = { pass: boolean; category?: string; reason?: string; suggestion?: string };

type Rule = { category: string; words: (string | RegExp)[]; reason: string; suggestion: string };

// 낱말이 들어 있어도 막지 않을 표현 (칼국수 같은 오탐 방지)
const ALLOW = ['칼국수', '칼슘', '총무', '총알택시', '죽순', '호박죽', '전복죽', '팥죽', '피아노', '피자', '공격수'];

// 걸리면 바로 막지 않고 선생님이 확인한다. 슬픔·소외·다툼·음식·요리(레시피) 같은 일상 이야기는 걸리지 않게
// 분명히 다치거나 잔인한 표현만 고른다.
const RULES: Rule[] = [
  {
    category: '폭력·잔인함',
    words: ['피를 흘', '피가 흘', '피가 나', '피가 철철', '피투성이', '피범벅', '유혈', '죽이', '죽여', '죽였', '살인', '시체', '총을 쏘', '총으로 쏘', '총에 맞', '칼로 찌', '칼에 찔', '칼을 휘두', '폭탄', '자살', '목을 졸', '고문'],
    reason: '다치거나 잔인한 장면처럼 보이는 표현이 있어서 선생님이 먼저 확인해요.',
    suggestion: '어떤 기분이었는지를 표정이나 행동으로 바꿔 써 보세요. 예: "깜짝 놀라 눈이 동그래진"',
  },
  {
    category: '놀림·비하',
    words: ['바보', '멍청', '못생긴', '찐따'],
    reason: '누군가를 놀리거나 깎아내리는 표현처럼 보여서 선생님이 먼저 확인해요.',
    suggestion: '인물의 모습을 있는 그대로, 친절한 말로 설명해 보세요.',
  },
  {
    category: '개인정보',
    words: [/01\d[- ]?\d{3,4}[- ]?\d{4}/, /\d{6}[- ]?\d{7}/, '주소는', '전화번호', '비밀번호'],
    reason: '전화번호·주소 같은 개인정보처럼 보여서 선생님이 먼저 확인해요.',
    suggestion: '개인정보를 빼고 "우리 동네", "친구" 처럼 바꿔 써 보세요.',
  },
  {
    category: '실존 인물',
    words: ['대통령', '연예인', '아이돌', '선생님 얼굴', '친구 얼굴', '사진처럼 똑같이'],
    reason: '실제 사람의 모습을 만드는 것처럼 보여서 선생님이 먼저 확인해요.',
    suggestion: '이름 없는 가상의 인물로 바꿔 보세요. 예: "안경 쓴 아이"',
  },
];

// 중·고등학생: 욕설·과장 표현("죽겠다", "죽여버린다")·다툼·어두운 분위기는 막지 않는다.
// 남겨 두는 것: 아주 잔인한 표현, 개인정보, 실존 인물(초상권)
const MIDDLE_SEVERE = ['피투성이', '피범벅', '시체', '고문', '자살', '목을 졸', '살인'];

export function moderateRules(text: string, band?: string): RuleVerdict {
  let t = text.replace(/\s+/g, ' ');
  for (const a of ALLOW) t = t.split(a).join(' ');
  const rules = band === 'middle' ? RULES.filter((r) => r.category === '개인정보' || r.category === '실존 인물').concat([{ ...RULES[0], words: MIDDLE_SEVERE }]) : RULES;
  for (const r of rules) {
    for (const w of r.words) {
      const hit = typeof w === 'string' ? t.includes(w) : w.test(t);
      if (hit) return { pass: false, category: r.category, reason: r.reason, suggestion: r.suggestion };
    }
  }
  return { pass: true };
}

export type Builder = { who: string; what: string; where: string; how: string; when?: string; why?: string; extra?: string; mode?: 'fields' | 'free'; free?: string };

function subject(w: string): string {
  const t = w.trim();
  if (t === '나') return '내가';
  if (t === '저') return '제가';
  const c = t.charCodeAt(t.length - 1);
  if (c < 0xac00 || c > 0xd7a3) return `${t}이(가)`;
  return (c - 0xac00) % 28 ? `${t}이` : `${t}가`;
}

export function buildPromptKo(b: Builder): string {
  // 직접 쓰기: 학생이 쓴 문장을 그대로 쓴다
  if (b.mode === 'free') return String(b.free ?? '').trim().slice(0, 300);
  // 육하원칙: 누가 · 언제 · 어디서 · 무엇을 · 어떻게 · 왜 (빈칸은 건너뛴다)
  const t = (v?: string) => String(v ?? '').trim();
  const main = [t(b.who) && subject(t(b.who)), t(b.when), t(b.where) && `${t(b.where)}에서`, t(b.what)].filter(Boolean).join(' ');
  const more = [t(b.how) && `${t(b.how)} 모습`, t(b.why) && `(왜: ${t(b.why)})`, t(b.extra)].filter(Boolean).join(', ');
  return [main, more].filter(Boolean).join(', ').slice(0, 300);
}
