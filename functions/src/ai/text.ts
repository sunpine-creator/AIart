import { genai } from './client';
import { CONFIG } from '../config';

export type AiCheck = {
  safe: boolean;
  category?: string;
  reasonKo?: string;
  suggestionKo?: string;
  english: string; // 영상 모델에 보낼 영어 프롬프트
};

const SYSTEM = `너는 초중고 학생이 쓴 AI 영상 프롬프트를 검사하고 번역하는 도우미다. 수업 주제는 「AI로 달라진 나의 일상」이다.
1) 안전 검사는 아주 좁게 한다. 아래에 분명히 해당할 때만 safe=false:
   - 피·상처·죽음·살해·무기 공격처럼 잔인하거나 다치는 장면 (예: "피를 흘리며 쓰러진")
   - 성적인 내용
   - 특정 사람이나 집단을 놀리거나 혐오하는 표현
   - 실제 개인정보(전화번호, 집 주소, 주민번호 등)
   - 실존 인물(유명인·친구·선생님)의 얼굴이나 모습을 그대로 만들기
   - 아이가 따라 하면 위험한 행동(불장난, 높은 곳에서 뛰어내리기 등)
   다음은 모두 safe=true 다(막지 않는다): 슬픔·외로움·속상함·질투·서운함 같은 감정, 친구가 나를 빼고 놀러 간 이야기, 친구와 다툼·화해,
   비 오는 날, 음식·간식·요리·레시피(칼로 재료 썰기, 불에 굽기 포함), 운동 경기, 게임, 무서운 꿈 이야기 정도의 가벼운 긴장감, 일상적인 낱말(칼국수, 총무, 공격수 등).
   애매하면 safe=true 로 한다.
2) safe=false 이면 category(폭력·잔인함/성적 내용/놀림·혐오/개인정보/실존 인물/위험 행동 중 하나), reasonKo(초등학생이 이해할 한 문장), suggestionKo(바꿔 쓸 예시 한 문장)를 쓴다.
3) english: safe 여부와 상관없이 항상 쓴다. 학생 의도를 바꾸지 말고 영상 모델용 영어 한 문단으로 옮긴다. 그림 스타일 문장은 붙이지 않는다(서버가 붙인다).
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
    // 검사 결과를 읽지 못하면 선생님이 직접 확인하도록 넘긴다
    return { safe: false, category: '검사 오류', reasonKo: 'AI 검사가 잠시 안 돼서 선생님이 직접 확인해요.', suggestionKo: '선생님 확인을 기다려 주세요.', english: '' };
  }
}
