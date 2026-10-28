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
   인물이 하는 말(대사·혼잣말·내레이션)이 있으면 번역하지 말고 한국어 그대로 두되, 큰따옴표로 감싸지 말고 'AUDIO ONLY (spoken in Korean, never written on screen): 우산 챙겨' 처럼 소리로만 들린다고 쓴다. 장면 설명에는 글자·자막을 화면에 쓰라는 말을 넣지 않는다.
JSON만 출력한다.`;

// 중·고등학생은 표현을 훨씬 넓게 허용한다(수업에서 요청). 정말 위험한 것만 막는다
const MIDDLE_NOTE = `
[중·고등학생 기준 — 위의 1)보다 이 기준을 따른다]
이 학생은 중·고등학생이다. 다음은 모두 safe=true 다: 욕설·비속어, "죽겠다/죽어/죽여버린다/죽어줌" 같은 과장·장난 표현, 친구끼리 다투거나 싸우는 장면, 화나거나 우울한 감정, 어둡거나 무서운 분위기, 공포·긴장, 넘어지거나 다치는 정도의 가벼운 사고.
safe=false 는 이것뿐이다: 성적인 내용, 신체가 훼손되거나 피가 낭자한 잔인한 묘사, 특정 집단 혐오, 자해·자살 방법, 실제 개인정보, 실존 인물의 얼굴.
욕설이 들어간 대사는 바꾸지 말고 한국어 그대로 소리로만 들리게 쓴다.`;

export async function checkAndTranslate(textKo: string, kind: 'prompt' | 'edit', band?: string): Promise<AiCheck> {
  const res = await genai().models.generateContent({
    model: CONFIG.textModel(),
    contents: [{ role: 'user', parts: [{ text: `${kind === 'edit' ? '[수정 지시]' : '[장면 프롬프트]'} ${textKo}` }] }],
    config: {
      systemInstruction: band === 'middle' ? SYSTEM + MIDDLE_NOTE : SYSTEM,
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

// ───────── 이야기 공통 설정: 모든 장면이 한 편의 영화처럼 이어지게 ─────────
// 학생이 매 장면 "같은 배경·날씨·밤낮·그림체로" 라고 쓰지 않아도, 이야기 전체를 보고 한 번 정해 모든 장면에 붙인다.
export type World = { place: string; weather: string; time: string; light: string; camera: string; en: string };

const WORLD_SYSTEM = `너는 초중고 학생이 만든 짧은 영상 이야기를 보고, 모든 장면이 한 편의 영화처럼 자연스럽게 이어지도록 "공통 설정"을 정하는 도우미다.
- 학생이 쓴 내용(언제·어디서·장면 설명)에 나온 것을 가장 먼저 따른다. 없으면 이야기에 어울리게 정한다.
- place: 주된 장소. 이야기 중에 장소가 바뀌면 "집 → 학교"처럼 순서대로.
- weather: 날씨 하나(예: 비 오는 날). time: 때(아침/낮/저녁/밤 중, 이야기 순서대로 바뀌면 "아침 → 저녁").
- light: 빛과 색감(예: 흐리고 차분한 파란빛). camera: 구도(예: 눈높이에서 인물 허리 위까지 보이는 비슷한 구도).
- 각 항목은 초등학생이 읽을 짧은 한국어.
- en: 영상 모델에 줄 영어 2~3문장. 모든 장면에서 같은 장소의 모습(건물·방·소품 배치), 같은 날씨, 같은 시간대의 빛, 같은 색감, 비슷한 카메라 높이와 구도를 유지하라고 쓴다. 장소나 때가 이야기 순서대로 바뀌면 그 순서를 쓴다.
- 폭력·무서운 내용은 넣지 않는다. JSON만 출력한다.`;

export async function makeWorld(storyKo: string): Promise<World> {
  const res = await genai().models.generateContent({
    model: CONFIG.textModel(),
    contents: [{ role: 'user', parts: [{ text: storyKo.slice(0, 3000) }] }],
    config: {
      systemInstruction: WORLD_SYSTEM,
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { place: { type: 'STRING' }, weather: { type: 'STRING' }, time: { type: 'STRING' }, light: { type: 'STRING' }, camera: { type: 'STRING' }, en: { type: 'STRING' } },
        required: ['place', 'weather', 'time', 'light', 'camera', 'en'],
      },
    } as any,
  });
  const j = JSON.parse((res as any).text ?? '{}') as World;
  if (!j.en) throw new Error('공통 설정을 만들지 못했어요');
  return j;
}
