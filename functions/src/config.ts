// 설정값은 functions/.env 에서 읽는다. 코드에 모델 이름이나 가격을 직접 쓰지 않는다.
export const REGION = 'asia-northeast3'; // 서울
export const env = (k: string, d = '') => process.env[k] ?? d;
export const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const CONFIG = {
  // 실제 배포에서는 항상 진짜 AI(omni)를 쓴다. 가짜(mock)는 내 컴퓨터 연습 모드(에뮬레이터)에서만.
  videoProvider: () => (process.env.FUNCTIONS_EMULATOR === 'true' ? (env('VIDEO_PROVIDER', 'mock') as 'mock' | 'omni') : 'omni'),
  genaiLocation: () => env('GENAI_LOCATION', 'global'),
  omniModel: () => env('OMNI_MODEL', 'gemini-omni-flash-preview'),
  textModel: () => env('TEXT_MODEL', 'gemini-2.5-flash'),
  imageModel: () => env('IMAGE_MODEL', 'gemini-2.5-flash-image'),
  maxConcurrent: () => num('MAX_CONCURRENT', 5),
  price: () => ({ '360p': num('PRICE_360P', 0.03), '720p': num('PRICE_720P', 0.1), image: num('PRICE_IMAGE', 0.04) }),
};

// 생성 종류별 해상도·길이·크레딧 (작업지시서 §8)
// Vertex 의 Omni 미리보기는 720p 만 만든다. 초안이 곧 완성 화질이라, 학생이 고르면 그대로 장면으로 확정한다(추가 생성 없음).
export const DRAFT = { res: '720p' as const, sec: 3 };
export const FINAL = DRAFT;
export const CREDIT_PER_SEC = { '360p': 1, '720p': 3 } as const;
export const MAX_EDITS = 1;
export const OPEN_STAGE_FOR_AI = 3; // 3단계 AI로 만들기

export type Kind = 'draft' | 'edit' | 'final';
export type Res = '360p' | '720p';

export function specFor(kind: Kind, img: boolean) {
  const res: Res = kind === 'final' ? FINAL.res : DRAFT.res;
  const sec = kind === 'final' ? FINAL.sec : DRAFT.sec;
  const p = CONFIG.price();
  if (kind === 'final') return { res, sec, credits: 0, costUsd: 0 }; // 확정은 새로 만들지 않는다
  const credits = img ? 1 : CREDIT_PER_SEC[res] * sec;
  const costUsd = img ? p.image : p[res] * sec;
  return { res, sec, credits, costUsd };
}
