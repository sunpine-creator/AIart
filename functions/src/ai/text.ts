import { genai } from './client';
import { CONFIG } from '../config';

export type AiCheck = {
  safe: boolean;
  category?: string;
  reasonKo?: string;
  suggestionKo?: string;
  english: string; // 영상 모델에 보낼 영어 프롬프트
};

const SYSTEM = `너는 초중등 학생이 쓴 AI 영상 프롬프트를 검사하고 번역하는 도우미다.
1) 안전 검사: 폭력·공포, 성적 내용, 놀림·혐오, 개인정보(이름+학교, 전화번호, 주소), 실존 인물(유명인·친구·선생님)의 모습, 위험한 행동 따라하기가 있으면 safe=false.
   일상적인 표현(칼국수, 총무, 축구에서 공격 등)은 막지 않는다.
2) safe=false 이면 category(폭력/성적 내용/놀림·혐오/개인정보/실존 인물/위험 행동 중 하나), reasonKo(초등학생이 이해할 한 문장), suggestionKo(바꿔 쓸 예시 한 문장)를 쓴다.
3) english: 학생 의도를 바꾸지 말고 영상 모델용 영어 한 문단으로 옮긴다. 끝에 "Bright, gentle picture-book animation style, safe for children, fictional people only." 를 붙인다.
JSON만 출력한다.`;

export async function checkAndTranslate(textKo: string, kind: 'prompt' | 'edit'): Promise<AiCheck> {
  const res = await genai().models.generateContent({
    model: CONFIG.textModel(),
    contents: [{ role: 'user', parts: [{ text: `${kind === 'edit' ? '[수정 지시]' : '[장면 프롬프트]'} ${textKo}` }] }],
    config: {
      systemInstruction: SYSTEM,
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          safe: { type: 'BOOLEAN' },
          category: { type: 'STRING' },
          reasonKo: { type: 'STRING' },
          suggestionKo: { type: 'STRING' },
          english: { type: 'STRING' },
        },
        required: ['safe', 'english'],
      },
    } as any,
  });
  const raw = (res as any).text ?? '';
  try {
    const j = JSON.parse(raw) as AiCheck;
    if (typeof j.safe !== 'boolean' || typeof j.english !== 'string') throw new Error('shape');
    return j;
  } catch {
    // 검사 결과를 읽지 못하면 안전하지 않은 것으로 본다(보수적으로)
    return { safe: false, category: '검사 오류', reasonKo: '지금은 검사를 할 수 없어요. 잠시 뒤 다시 해 보세요.', english: '' };
  }
}
