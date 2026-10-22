// 완성 영상에 들어갈 글자(제목·자막·말풍선·AI 표시)를 브라우저에서 투명 PNG 로 그린다.
// 서버는 이 그림을 영상 위에 겹치기만 한다. 크기·위치 규칙은 편집 미리보기와 같다.
import type { CapStyle } from './store';

// 완성 영상 크기에 맞춰 그린다: 가로 1280x720, 세로 1080x1920(공모전·쇼츠 규격)
let W = 1280;
let H = 720;
export function setOverlayAspect(aspect?: string) {
  [W, H] = aspect === '9:16' ? [1080, 1920] : [1280, 720];
}
// 글자 크기는 화면 너비에 맞춰 줄이거나 늘린다(가로 1280 기준)
const k = () => W / 1280;
const FONT = `'Pretendard Variable', Pretendard, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif`;
const SIZE_PX = { S: 34, M: 46, L: 62 } as const;
export const AI_NOTICE = '이 영상에는 AI 생성 콘텐츠가 포함되어 있어요';

// 긴 글은 한 줄 max 글자 안팎으로 나누고 3줄까지만 쓴다 (서버 wrap 과 같은 규칙)
export function wrap(text: string, max = 22): string[] {
  const words = text.replace(/\r/g, '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

type Block = {
  lines: string[];
  size: number;
  color: string;
  x: 'center' | number; // center 또는 왼쪽 위치(px)
  y: 'top' | 'mid' | 'bottom' | 'title' | number; // 위치 규칙 또는 위쪽 px
  deco: 'box' | 'bubble' | 'outline' | 'none';
  at?: { x: number; y: number }; // 마우스로 옮긴 위치(비율). 글자 덩어리의 가운데
};

function canvas() {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}

function draw(ctx: CanvasRenderingContext2D, b: Block) {
  if (!b.lines.length) return;
  const size = Math.round(b.size * k());
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textBaseline = 'top';
  const gap = Math.round(10 * k());
  const lineH = Math.round(size * 1.2);
  const widths = b.lines.map((l) => ctx.measureText(l).width);
  const tw = Math.max(...widths);
  const th = lineH * b.lines.length + gap * (b.lines.length - 1);
  const pad = Math.round((b.deco === 'bubble' ? 22 : 18) * k());
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  let top =
    typeof b.y === 'number' ? b.y * k() : b.y === 'top' ? H * 0.083 : b.y === 'mid' ? (H - th) / 2 : b.y === 'title' ? (H - th) / 2 - 30 * k() : H - th - H * 0.097;
  let left = b.x === 'center' ? (W - tw) / 2 : b.x * k();
  if (b.at) {
    left = clamp(b.at.x * W - tw / 2, pad, W - tw - pad);
    top = clamp(b.at.y * H - th / 2, pad, H - th - pad);
  }
  if (b.deco === 'box' || b.deco === 'bubble') {
    ctx.fillStyle = b.deco === 'bubble' ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.6)';
    ctx.fillRect(left - pad, top - pad, tw + pad * 2, th + pad * 2);
  }
  b.lines.forEach((l, i) => {
    const lx = b.at ? (b.deco === 'bubble' ? left : left + (tw - widths[i]) / 2) : b.x === 'center' ? (W - widths[i]) / 2 : left;
    const ly = top + i * (lineH + gap);
    if (b.deco === 'outline') {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(4, size / 8);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(l, lx, ly);
    }
    ctx.fillStyle = b.color;
    ctx.fillText(l, lx, ly);
  });
}

function png(blocks: Block[]): string | undefined {
  if (!blocks.some((b) => b.lines.length)) return undefined;
  const c = canvas();
  const ctx = c.getContext('2d')!;
  blocks.forEach((b) => draw(ctx, b));
  return c.toDataURL('image/png');
}

function capBlock(text: string, st: CapStyle = {}): Block {
  const bubble = st.kind === 'bubble';
  const size = SIZE_PX[st.size ?? 'M'] ?? 46;
  return {
    lines: wrap(text, size >= 62 ? 16 : size <= 34 ? 28 : 22),
    size,
    color: st.color ?? (bubble ? '#1E2A44' : '#FFFFFF'),
    x: bubble ? 80 : 'center',
    y: st.pos ?? (bubble ? 'top' : 'bottom'),
    deco: bubble ? 'bubble' : st.box === false ? 'outline' : 'box',
    at: st.x !== undefined && st.y !== undefined ? { x: st.x, y: st.y } : undefined,
  };
}

// 자막 그림. 타자 치듯 움직임이면 글자를 조금씩 늘린 그림을 여러 장 만든다.
function captionPngs(text: string, st: CapStyle = {}): string[] {
  if (!text.trim()) return [];
  const full = capBlock(text, st);
  if (st.anim !== 'type') return [png([full])!];
  const all = full.lines.join('\n');
  const chars = [...all];
  const steps = Math.min(chars.length, 14);
  const out: string[] = [];
  for (let k = 1; k <= steps; k++) {
    const part = chars.slice(0, Math.ceil((chars.length * k) / steps)).join('');
    const p = png([{ ...full, lines: part.split('\n') }]);
    if (p) out.push(p);
  }
  return out;
}

export type Overlay = { fixed?: string; cap?: string[]; anim?: CapStyle['anim'] };

export type OverlayItem =
  | { key: 'intro'; text: string }
  | { key: 'outro'; text: string }
  | { key: string; kind: 'scene' | 'upload'; caption: string; capStyle?: CapStyle; aiBadge?: boolean; placeholder?: string };

export async function buildOverlays(items: OverlayItem[]): Promise<Record<string, Overlay>> {
  try {
    await Promise.all([document.fonts.load(`700 46px ${FONT}`, '가나다'), document.fonts.ready]);
  } catch {
    /* 글꼴을 못 불러와도 기본 글꼴로 그린다 */
  }
  const out: Record<string, Overlay> = {};
  for (const it of items) {
    if (it.key === 'intro' && 'text' in it) {
      out.intro = { fixed: png([{ lines: wrap(it.text, 16), size: 64, color: '#FFFFFF', x: 'center', y: 'title', deco: 'none' }]) };
    } else if (it.key === 'outro' && 'text' in it) {
      out.outro = {
        fixed: png([
          { lines: wrap(it.text, 16), size: 64, color: '#FFFFFF', x: 'center', y: 'title', deco: 'none' },
          { lines: [AI_NOTICE], size: 30, color: '#FFFFFF', x: 'center', y: (H - H * 0.22) / k(), deco: 'none' },
        ]),
      };
    } else if ('kind' in it) {
      const fixed: Block[] = [];
      if (it.aiBadge) fixed.push({ lines: ['AI 생성'], size: 24, color: '#FFFFFF', x: 28, y: 24, deco: 'box' });
      if (it.placeholder) {
        fixed.push({ lines: wrap(it.placeholder, 16), size: 44, color: '#FFFFFF', x: 'center', y: 'title', deco: 'none' });
        fixed.push({ lines: ['(아직 정하지 않은 장면 자리)'], size: 26, color: 'rgba(255,255,255,0.7)', x: 'center', y: 40, deco: 'none' });
      }
      out[it.key] = { fixed: png(fixed), cap: captionPngs(it.caption ?? '', it.capStyle), anim: it.capStyle?.anim ?? 'none' };
    }
  }
  return out;
}

// 하나의 타임라인용 글자 그림: 조각마다 고정 글자(AI 표시·빈 장면 안내), 구간 자막마다 그림
export async function buildTimelineOverlays(x: {
  intro: string;
  outro: string;
  clips: { key: string; aiBadge?: boolean; placeholder?: string }[];
  caps: { id: string; text: string; style?: CapStyle }[];
}): Promise<{ intro?: string; outro?: string; clips: Record<string, string>; caps: Record<string, string[]> }> {
  const items: OverlayItem[] = [
    { key: 'intro', text: x.intro },
    { key: 'outro', text: x.outro },
    ...x.clips.map((c) => ({ key: c.key, kind: 'scene' as const, caption: '', aiBadge: c.aiBadge, placeholder: c.placeholder })),
  ];
  const o = await buildOverlays(items);
  const clips: Record<string, string> = {};
  for (const c of x.clips) if (o[c.key]?.fixed) clips[c.key] = o[c.key].fixed!;
  const caps: Record<string, string[]> = {};
  for (const c of x.caps) caps[c.id] = captionPngs(c.text, c.style).slice(0, 16);
  return { intro: o.intro?.fixed, outro: o.outro?.fixed, clips, caps };
}
