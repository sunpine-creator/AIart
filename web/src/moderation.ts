// 1단계(규칙) 윤리 검사. 통과하면 ai/text.ts 의 2단계(Gemini 맥락) 검사를 거친다.
// web/src/moderation.ts 와 같은 규칙을 쓴다(학생 화면의 미리 알림용). 바꿀 때는 둘 다 바꾼다.
export type RuleVerdict = { pass: boolean; category?: string; reason?: string; suggestion?: string };

type Rule = { category: string; words: (string | RegExp)[]; reason: string; suggestion: string };

// 낱말이 들어 있어도 막지 않을 표현 (칼국수 같은 오탐 방지)
const ALLOW = ['칼국수', '칼슘', '총무', '총알택시', '죽순', '호박죽', '전복죽', '피아노', '피자', '공격수'];

const RULES: Rule[] = [
  {
    category: '폭력',
    words: ['죽', '피가', '피를', '총', '칼', '때리', '때려', '싸움', '폭탄', '공격'],
    reason: '다치거나 무서운 장면은 AI로 만들 수 없어요.',
    suggestion: '어떤 기분이었는지를 표정이나 행동으로 바꿔 써 보세요. 예: "깜짝 놀라 눈이 동그래진"',
  },
  {
    category: '놀림·비하',
    words: ['바보', '멍청', '못생긴', '뚱뚱', '찐따'],
    reason: '누군가를 놀리거나 깎아내리는 표현이 들어 있어요.',
    suggestion: '인물의 모습을 있는 그대로, 친절한 말로 설명해 보세요.',
  },
  {
    category: '개인정보',
    words: [/01\d[- ]?\d{3,4}[- ]?\d{4}/, /\d{6}[- ]?\d{7}/, '주소는', '전화번호', '비밀번호'],
    reason: '전화번호·주소 같은 개인정보는 프롬프트에 쓰면 안 돼요.',
    suggestion: '개인정보를 빼고 "우리 동네", "친구" 처럼 바꿔 써 보세요.',
  },
  {
    category: '실존 인물',
    words: ['대통령', '연예인', '아이돌', '선생님 얼굴', '친구 얼굴', '사진처럼 똑같이'],
    reason: '실제 사람의 모습을 AI로 만들면 그 사람의 권리를 침해할 수 있어요.',
    suggestion: '이름 없는 가상의 인물로 바꿔 보세요. 예: "안경 쓴 아이"',
  },
];

export function moderateRules(text: string): RuleVerdict {
  let t = text.replace(/\s+/g, ' ');
  for (const a of ALLOW) t = t.split(a).join(' ');
  for (const r of RULES) {
    for (const w of r.words) {
      const hit = typeof w === 'string' ? t.includes(w) : w.test(t);
      if (hit) return { pass: false, category: r.category, reason: r.reason, suggestion: r.suggestion };
    }
  }
  return { pass: true };
}

export type Builder = { who: string; what: string; where: string; how: string; extra?: string; mode?: 'fields' | 'free'; free?: string };

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
  return [b.who && subject(b.who), b.where && `${b.where}에서`, b.what, b.how && `${b.how} 모습`, b.extra?.trim()]
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
}

// 학생 화면에서 보내기 전에 미리 알려 주는 용도. 최종 판단은 서버가 한다.
export const moderate = moderateRules;
