// 하나의 타임라인 편집: 모든 시각은 "바탕 영상"(제목 + 장면들 + 끝 화면을 XF 초씩 겹쳐 이은 것) 기준 초.
// 서버(functions/src/render.ts)의 XF·mergeCuts·mapTime 과 같은 규칙을 쓴다. 바꿀 때는 둘 다 바꾼다.
import type { CapStyle } from './store';

export const XF = 0.5;

// 시작 위치는 "어느 조각(k)의 몇 초(o)"로 저장한다. 그래서 장면 순서를 바꿔도 자막·목소리·지운 구간이 그 장면을 따라간다.
export type Anchor = { k: string; o: number };
export type TlCut = Anchor & { id: string; len: number };
export type TlCap = Anchor & { id: string; len: number; text: string; style?: CapStyle };
export type TlVoice = Anchor & { id: string; kind: 'ai' | 'mine'; voice: string; text?: string; path?: string; url?: string; dur: number; fixed?: boolean /* 학생이 길이를 직접 정함 */ };
export type Timeline = { cuts: TlCut[]; caps: TlCap[]; voices: TlVoice[] };
export const emptyTl = (): Timeline => ({ cuts: [], caps: [], voices: [] });

export const tid = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
export const r1 = (x: number) => Math.round(x * 10) / 10;

// 각 조각이 바탕 영상에서 시작하는 시각
export function layout<T extends { dur: number }>(items: T[]): { item: T; at: number; end: number }[] {
  let acc = 0;
  return items.map((it, i) => {
    const at = i === 0 ? 0 : acc - XF;
    acc = at + it.dur;
    return { item: it, at, end: at + it.dur };
  });
}
export const baseLen = (items: { dur: number }[]) => Math.max(0, items.reduce((a, b) => a + b.dur, 0) - XF * Math.max(0, items.length - 1));

export function mergeCuts(cuts: { a: number; b: number }[], total: number): { a: number; b: number }[] {
  const xs = cuts
    .map((c) => ({ a: Math.max(0, Math.min(c.a, c.b)), b: Math.min(total, Math.max(c.a, c.b)) }))
    .filter((c) => c.b - c.a >= 0.05)
    .sort((p, q) => p.a - q.a);
  const out: { a: number; b: number }[] = [];
  for (const c of xs) {
    const last = out[out.length - 1];
    if (last && c.a <= last.b) last.b = Math.max(last.b, c.b);
    else out.push({ ...c });
  }
  return out;
}

// 바탕 시각 → 완성 영상 시각
export function mapTime(t: number, cuts: { a: number; b: number }[]): number {
  let o = t;
  for (const c of cuts) {
    if (t >= c.b) o -= c.b - c.a;
    else if (t > c.a) o -= t - c.a;
  }
  return o;
}

// 지운 구간 안이면 그 구간 끝으로 건너뛴다
export function skipCut(t: number, cuts: { a: number; b: number }[]): number {
  for (const c of cuts) if (t >= c.a && t < c.b) return c.b;
  return t;
}

export const cutTotal = (cuts: { a: number; b: number }[]) => cuts.reduce((a, c) => a + (c.b - c.a), 0);

// AI 목소리 길이 어림(한 글자 0.2초쯤)
export const ttsGuess = (text: string) => Math.max(1.5, Math.min(20, r1([...text.replace(/\s/g, '')].length * 0.28 + 1)));

// 조각 시작 시각표(key → at)
export type AtMap = Record<string, { at: number; dur: number }>;
export const atMap = (lay: { item: { key: string; dur: number }; at: number }[]): AtMap => Object.fromEntries(lay.map((e) => [e.item.key, { at: e.at, dur: e.item.dur }]));
// 저장된 위치 → 바탕 시각. 조각이 빠져 있으면 undefined
export const absAt = (x: Anchor, m: AtMap): number | undefined => (m[x.k] ? m[x.k].at + Math.max(0, Math.min(x.o, m[x.k].dur)) : undefined);
// 바탕 시각 → 저장할 위치(그 시각에 보이는 조각 기준)
export function anchorAt(t: number, lay: { item: { key: string }; at: number; end: number }[]): Anchor {
  let e = lay[0];
  for (const x of lay) if (x.at <= t + 1e-6) e = x;
  return { k: e.item.key, o: r1(Math.max(0, t - e.at)) };
}
