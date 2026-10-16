// 편집한 장면들을 ffmpeg 로 한 편의 MP4 로 합친다.
// 모든 조각을 같은 형식(1280x720, 30fps, H.264, AAC 48kHz 스테레오)으로 만든 뒤 이어 붙이고, 마지막에 배경음악을 섞는다.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 글자(제목·자막·말풍선·AI 표시)는 브라우저가 투명 PNG 로 그려서 보내고, 여기서는 영상 위에 겹치기만 한다.
// (클라우드의 ffmpeg 에는 글자 그리기(drawtext) 기능이 없어서 overlay 만 쓴다)
export type Layers = {
  fixed?: string; // 처음부터 끝까지 보이는 글자 그림 (제목, AI 표시 등)
  cap?: string[]; // 자막 그림. 타자 치듯 움직임이면 여러 장
  anim?: 'none' | 'fade' | 'slide' | 'type';
};

export type Clip = {
  kind: 'title' | 'outro' | 'video' | 'image' | 'placeholder';
  dur: number; // 초
  start?: number; // 영상 앞부분을 자를 길이(초)
  srcLen?: number; // 원본 영상 길이(초). 장면 길이가 더 길면 fill 로 채운다
  fill?: 'freeze' | 'slow' | 'loop';
  grade?: boolean; // AI 장면: 모든 장면에 같은 색 보정을 입혀 분위기를 맞춘다
  src?: string; // 영상·이미지 파일 경로
  keepAudio?: boolean; // 올린 영상의 원래 소리 쓰기
  voice?: string; // 녹음·AI 목소리 파일 경로
  layers?: Layers;
};

// 모든 AI 장면에 똑같이 입히는 색 보정(살짝 부드럽고 따뜻하게). 장면마다 다른 색감 차이를 줄인다
const GRADE = 'eq=contrast=1.04:saturation=0.92:gamma=1.02,colorbalance=rm=0.02:bm=-0.02';

export const W = 1280;
export const H = 720;
const FPS = 30;
export const AI_NOTICE = '이 영상에는 AI 생성 콘텐츠가 포함되어 있어요';

function bin(name: 'ffmpeg' | 'ffprobe'): string {
  const envPath = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (envPath) return envPath;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path;
  } catch {
    return name;
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} 실패(${code}): ${err.slice(-600)}`))));
  });
}

export async function hasAudio(file: string): Promise<boolean> {
  try {
    const out = await run(bin('ffprobe'), ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// 긴 자막은 한 줄 22자 안팎으로 나눈다
export function wrap(text: string, max = 22): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).join('\n');
}

// 영상의 마지막 화면을 PNG 로 꺼낸다 (다음 장면을 이 화면에서 이어 시작하게)
export async function lastFrame(file: string, out: string): Promise<boolean> {
  try {
    await run(bin('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', '-sseof', '-0.25', '-i', file, '-frames:v', '1', '-update', '1', out]);
    return existsSync(out);
  } catch {
    return false;
  }
}

// 영상 파일의 실제 길이(초). 알 수 없으면 0
export async function probeDur(file: string): Promise<number> {
  try {
    const out = await run(bin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const n = parseFloat(out.trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function renderSegment(c: Clip, i: number, dir: string): Promise<string> {
  const out = join(dir, `seg_${String(i).padStart(2, '0')}.mp4`);
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS}`;
  const d = String(c.dur);
  const filters: string[] = [];

  // 0번 입력: 바탕(영상·이미지·색)
  if (c.kind === 'video' && c.src) {
    const avail = c.srcLen ? Math.max(0.5, c.srcLen - (c.start ?? 0)) : 0;
    const longer = !!avail && c.dur > avail + 0.05;
    if (longer && c.fill === 'loop') args.push('-stream_loop', '-1');
    if (c.start && c.start > 0) args.push('-ss', String(c.start));
    args.push('-i', c.src);
    const slow = longer && c.fill === 'slow' ? `setpts=${(c.dur / avail).toFixed(3)}*PTS,` : '';
    filters.push(`[0:v]${slow}${fit}${c.grade ? `,${GRADE}` : ''},tpad=stop_mode=clone:stop_duration=${c.dur}[b0]`);
  } else if (c.kind === 'image' && c.src) {
    args.push('-loop', '1', '-t', d, '-i', c.src);
    filters.push(`[0:v]${fit}${c.grade ? `,${GRADE}` : ''}[b0]`);
  } else {
    const bg = c.kind === 'outro' ? '0x7FA6F0' : c.kind === 'title' ? '0x26324F' : '0x2B3550';
    args.push('-f', 'lavfi', '-t', d, '-i', `color=c=${bg}:s=${W}x${H}:r=${FPS}`);
    filters.push('[0:v]null[b0]');
  }

  // 글자 그림 겹치기
  let idx = 1;
  let cur = 'b0';
  const lay = (png: string, opt: { enable?: string; fade?: boolean; slide?: boolean }) => {
    args.push('-loop', '1', '-t', d, '-i', png);
    const o = `o${idx}`;
    filters.push(`[${idx}:v]format=rgba${opt.fade ? ',fade=in:st=0:d=0.6:alpha=1' : ''}[${o}]`);
    const y = opt.slide ? `'max(0,0.6-t)*160'` : '0';
    const next = `v${idx}`;
    filters.push(`[${cur}][${o}]overlay=x=0:y=${y}:eof_action=pass${opt.enable ? `:enable='${opt.enable}'` : ''}[${next}]`);
    cur = next;
    idx++;
  };
  const L = c.layers ?? {};
  if (L.fixed && existsSync(L.fixed)) lay(L.fixed, {});
  const caps = (L.cap ?? []).filter((p) => existsSync(p));
  if (caps.length) {
    const anim = L.anim ?? 'none';
    if (anim === 'type' && caps.length > 1) {
      const step = Math.min(1.6, c.dur * 0.6) / caps.length;
      caps.forEach((p, k) => {
        const a = (k * step).toFixed(2);
        const b = ((k + 1) * step).toFixed(2);
        lay(p, { enable: k < caps.length - 1 ? `between(t,${a},${b})` : `gte(t,${a})` });
      });
    } else {
      lay(caps[caps.length - 1], { fade: anim === 'fade' || anim === 'slide', slide: anim === 'slide' });
    }
  }
  filters.push(`[${cur}]format=yuv420p[v]`);

  // 소리: 목소리 > 원래 소리 > 무음
  const ai = idx;
  if (c.voice) {
    args.push('-i', c.voice);
    filters.push(`[${ai}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${c.dur}[a]`);
  } else if (c.kind === 'video' && c.src && c.keepAudio && (await hasAudio(c.src))) {
    filters.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${c.dur}[a]`);
  } else {
    args.push('-f', 'lavfi', '-t', d, '-i', 'anullsrc=r=48000:cl=stereo');
    filters.push(`[${ai}:a]atrim=0:${c.dur}[a]`);
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-t', d,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    out,
  );
  await run(bin('ffmpeg'), args);
  return out;
}

export async function renderAll(clips: Clip[], dir: string, bgm?: string): Promise<string> {
  const segs: string[] = [];
  for (let i = 0; i < clips.length; i++) segs.push(await renderSegment(clips[i], i, dir));
  const list = join(dir, 'list.txt');
  writeFileSync(list, segs.map((s) => `file '${s}'`).join('\n'));
  const joined = join(dir, 'joined.mp4');
  await run(bin('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  const final = join(dir, 'final.mp4');
  const meta = ['-metadata', 'comment=AI 생성 콘텐츠 포함 (AI 스튜디오)', '-metadata', 'title=AI로 달라진 나의 일상'];
  if (bgm) {
    await run(bin('ffmpeg'), [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', joined, '-stream_loop', '-1', '-i', bgm,
      '-filter_complex', '[1:a]volume=0.18,aresample=48000,aformat=channel_layouts=stereo[b];[0:a][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', ...meta, '-movflags', '+faststart', final,
    ]);
  } else {
    await run(bin('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', '-i', joined, '-c', 'copy', ...meta, '-movflags', '+faststart', final]);
  }
  return final;
}

// ───────── 하나의 타임라인으로 합치기 ─────────
// ① 조각들을 장면 사이 XF 초씩 겹쳐(디졸브) 한 편의 바탕 영상으로 잇는다
// ② 학생이 지운 구간을 빼고 ③ 구간마다 넣은 자막·목소리를 얹는다. 모든 시각은 ①의 바탕 영상 기준(초).
export const XF = 0.5;
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', String(FPS), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];

export async function concatCopy(list: string, out: string) {
  await run(bin('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
}

export async function joinXfade(segs: string[], durs: number[], dir: string): Promise<string> {
  if (segs.length === 1) return segs[0];
  const out = join(dir, 'base.mp4');
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  segs.forEach((s) => args.push('-i', s));
  const f: string[] = [];
  let v = '0:v';
  let a = '0:a';
  let acc = durs[0];
  for (let k = 1; k < segs.length; k++) {
    const off = Math.max(0, acc - XF);
    f.push(`[${v}][${k}:v]xfade=transition=fade:duration=${XF}:offset=${off.toFixed(3)}[xv${k}]`);
    f.push(`[${a}][${k}:a]acrossfade=d=${XF}:c1=tri:c2=tri[xa${k}]`);
    v = `xv${k}`;
    a = `xa${k}`;
    acc = acc + durs[k] - XF;
  }
  args.push('-filter_complex', f.join(';'), '-map', `[${v}]`, '-map', `[${a}]`, ...ENC, out);
  await run(bin('ffmpeg'), args);
  return out;
}

export type Range = { a: number; b: number };
export type TlCapIn = { a: number; b: number; pngs: string[]; anim: 'none' | 'fade' | 'slide' | 'type' };
export type TlVoiceIn = { a: number; file: string; dur?: number };

// 지운 구간을 정리한다(겹치면 합치고, 바탕 영상 길이 안으로)
export function mergeCuts(cuts: Range[], total: number): Range[] {
  const xs = cuts
    .map((c) => ({ a: Math.max(0, Math.min(c.a, c.b)), b: Math.min(total, Math.max(c.a, c.b)) }))
    .filter((c) => c.b - c.a >= 0.05)
    .sort((p, q) => p.a - q.a);
  const out: Range[] = [];
  for (const c of xs) {
    const last = out[out.length - 1];
    if (last && c.a <= last.b) last.b = Math.max(last.b, c.b);
    else out.push({ ...c });
  }
  return out;
}

// 바탕 영상 시각 → 지운 구간을 뺀 완성 영상 시각
export function mapTime(t: number, cuts: Range[]): number {
  let o = t;
  for (const c of cuts) {
    if (t >= c.b) o -= c.b - c.a;
    else if (t > c.a) o -= t - c.a;
  }
  return o;
}

export async function applyTimeline(
  base: string,
  total: number,
  cutsIn: Range[],
  caps: TlCapIn[],
  voices: TlVoiceIn[],
  dir: string,
): Promise<{ file: string; dur: number }> {
  const cuts = mergeCuts(cutsIn, total);
  const keep: Range[] = [];
  let pos = 0;
  for (const c of cuts) {
    if (c.a - pos >= 0.05) keep.push({ a: pos, b: c.a });
    pos = c.b;
  }
  if (total - pos >= 0.05) keep.push({ a: pos, b: total });
  const dur = keep.reduce((s, r) => s + (r.b - r.a), 0);
  if (dur < 0.5) throw new Error('지우고 남은 영상이 없어요');

  // ② 지운 구간 빼기
  let cutFile = base;
  if (cuts.length) {
    cutFile = join(dir, 'cut.mp4');
    const f: string[] = [];
    keep.forEach((r, i) => {
      f.push(`[0:v]trim=start=${r.a.toFixed(3)}:end=${r.b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      f.push(`[0:a]atrim=start=${r.a.toFixed(3)}:end=${r.b.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    });
    f.push(`${keep.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${keep.length}:v=1:a=1[v][a]`);
    await run(bin('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', '-i', base, '-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]', ...ENC, cutFile]);
  }

  // ③ 자막·목소리 얹기
  const final = join(dir, 'final.mp4');
  const meta = ['-metadata', 'comment=AI 생성 콘텐츠 포함 (AI 스튜디오)', '-metadata', 'title=AI로 달라진 나의 일상'];
  const D = dur.toFixed(3);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', cutFile];
  const f: string[] = [];
  let idx = 1;
  let cur = '0:v';
  let n = 0;
  const lay = (png: string, enable: string, opt: { fadeAt?: number; slideAt?: number }) => {
    args.push('-loop', '1', '-t', D, '-i', png);
    const o = `o${idx}`;
    f.push(`[${idx}:v]format=rgba${opt.fadeAt !== undefined ? `,fade=in:st=${opt.fadeAt.toFixed(3)}:d=0.6:alpha=1` : ''}[${o}]`);
    const y = opt.slideAt !== undefined ? `'if(lt(t,${(opt.slideAt + 0.6).toFixed(3)}),(${(opt.slideAt + 0.6).toFixed(3)}-t)*160,0)'` : '0';
    const next = `c${idx}`;
    f.push(`[${cur}][${o}]overlay=x=0:y=${y}:eof_action=pass:enable='${enable}'[${next}]`);
    cur = next;
    idx++;
    n++;
  };
  for (const c of caps) {
    if (n > 150) break;
    const a = mapTime(c.a, cuts);
    const b = mapTime(c.b, cuts);
    if (b - a < 0.1 || !c.pngs.length) continue;
    const win = (x: number, y: number) => `between(t,${x.toFixed(3)},${y.toFixed(3)})`;
    if (c.anim === 'type' && c.pngs.length > 1) {
      const step = Math.min(1.6, (b - a) * 0.6) / c.pngs.length;
      c.pngs.forEach((p, k) => lay(p, win(a + k * step, k < c.pngs.length - 1 ? a + (k + 1) * step : b), {}));
    } else {
      const p = c.pngs[c.pngs.length - 1];
      lay(p, win(a, b), { fadeAt: c.anim === 'fade' || c.anim === 'slide' ? a : undefined, slideAt: c.anim === 'slide' ? a : undefined });
    }
  }
  const vOut = cur === '0:v' ? '0:v' : cur;
  if (vOut !== '0:v') f.push(`[${vOut}]format=yuv420p[vo]`);
  const mix: string[] = ['[0:a]'];
  for (const v of voices.slice(0, 30)) {
    const at = mapTime(v.a, cuts);
    if (at >= dur - 0.1) continue;
    args.push('-i', v.file);
    const ms = Math.round(at * 1000);
    const trim = v.dur && v.dur > 0.2 ? `atrim=0:${v.dur.toFixed(2)},afade=t=out:st=${Math.max(0, v.dur - 0.15).toFixed(2)}:d=0.15,` : '';
    f.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,${trim}adelay=${ms}|${ms}[m${idx}]`);
    mix.push(`[m${idx}]`);
    idx++;
  }
  if (mix.length > 1) f.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[ao]`);
  if (!f.length) {
    await run(bin('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', '-i', cutFile, '-c', 'copy', ...meta, '-movflags', '+faststart', final]);
  } else {
    args.push('-filter_complex', f.join(';'), '-map', vOut === '0:v' ? '0:v' : '[vo]', '-map', mix.length > 1 ? '[ao]' : '0:a', '-t', D, ...ENC, ...meta, '-movflags', '+faststart', final);
    await run(bin('ffmpeg'), args);
  }
  return { file: final, dur: Math.round(dur * 10) / 10 };
}
