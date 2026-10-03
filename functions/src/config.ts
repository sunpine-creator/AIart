// 설정값은 functions/.env 에서 읽는다. 코드에 모델 이름이나 가격을 직접 쓰지 않는다.
export const REGION = 'asia-northeast3'; // 서울
export const env = (k: string, d = '') => process.env[k] ?? d;
export const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const CONFIG = {
  videoProvider: () => env('VIDEO_PROVIDER', 'mock') as 'mock' | 'omni',
  genaiLocation: () => env('GENAI_LOCATION', 'global'),
  omniModel: () => env('OMNI_MODEL', 'gemini-omni-flash-preview'),
  textModel: () => env('TEXT_MODEL', 'gemini-2.5-flash'),
  imageModel: () => env('IMAGE_MODEL', 'gemini-2.5-flash-image'),
  maxConcurrent: () => num('MAX_CONCURRENT', 5),
  price: () => ({ '360p': num('PRICE_360P', 0.03), '720p': num('PRICE_720P', 0.1), image: num('PRICE_IMAGE', 0.04) }),
};

// 생성 종류별 해상도·길이·크레딧 (작업지시서 §8)
export const DRAFT = { res: '360p' as const, sec: 3 };
export const FINAL = { res: '720p' as const, sec: 5 };
export const CREDIT_PER_SEC = { '360p': 1, '720p': 3 } as const;
export const MAX_EDITS = 2;
export const OPEN_STAGE_FOR_AI = 3; // 3단계 AI로 만들기

export type Kind = 'draft' | 'edit' | 'final';
export type Res = '360p' | '720p';

export function specFor(kind: Kind, img: boolean) {
  const res: Res = kind === 'final' ? FINAL.res : DRAFT.res;
  const sec = kind === 'final' ? FINAL.sec : DRAFT.sec;
  const credits = img ? (kind === 'final' ? 2 : 1) : CREDIT_PER_SEC[res] * sec;
  const p = CONFIG.price();
  const costUsd = img ? p.image : p[res] * sec;
  return { res, sec, credits, costUsd };
}
