// 편집한 장면들을 ffmpeg 로 한 편의 MP4 로 합친다.
// 모든 조각을 같은 형식(1280x720, 30fps, H.264, AAC 48kHz 스테레오)으로 만든 뒤 이어 붙이고, 마지막에 배경음악을 섞는다.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Clip = {
  kind: 'title' | 'outro' | 'video' | 'image' | 'placeholder';
  dur: number; // 초
  start?: number; // 영상 앞부분을 자를 길이(초)
  text?: string; // 제목 화면·자리표시 화면의 글자
  caption?: string; // 자막·말풍선
  src?: string; // 영상·이미지 파일 경로
  keepAudio?: boolean; // 올린 영상의 원래 소리 쓰기
  voice?: string; // 녹음·AI 목소리 파일 경로
  aiBadge?: boolean; // 화면 왼쪽 위 "AI 생성" 표시
};

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

export function fontPath(): string | undefined {
  const p = join(__dirname, '..', 'assets', 'NotoSansKR-Bold.otf');
  return existsSync(p) ? p : process.env.CAPTION_FONT;
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

// drawtext 는 글자를 파일로 넘겨 특수문자 문제를 피한다
function textFilter(dir: string, name: string, text: string, opts: { size: number; y: string; box?: boolean; color?: string }) {
  const font = fontPath();
  if (!font || !text.trim()) return '';
  const tf = join(dir, `${name}.txt`);
  writeFileSync(tf, text.replace(/\r/g, ''));
  const box = opts.box ? ':box=1:boxcolor=black@0.6:boxborderw=18' : '';
  return `drawtext=fontfile='${font}':textfile='${tf}':expansion=none:fontsize=${opts.size}:fontcolor=${opts.color ?? 'white'}:line_spacing=10:x=(w-text_w)/2:y=${opts.y}${box}`;
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

export async function renderSegment(c: Clip, i: number, dir: string): Promise<string> {
  const out = join(dir, `seg_${String(i).padStart(2, '0')}.mp4`);
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS}`;
  let vchain: string;

  // 영상 입력 (0번)
  if (c.kind === 'video' && c.src) {
    if (c.start && c.start > 0) args.push('-ss', String(c.start));
    args.push('-i', c.src);
    vchain = `[0:v]${fit},tpad=stop_mode=clone:stop_duration=${c.dur}`;
  } else if (c.kind === 'image' && c.src) {
    args.push('-loop', '1', '-t', String(c.dur), '-i', c.src);
    vchain = `[0:v]${fit}`;
  } else {
    const bg = c.kind === 'outro' ? '0x7FA6F0' : c.kind === 'title' ? '0x17203A' : '0x2B3550';
    args.push('-f', 'lavfi', '-t', String(c.dur), '-i', `color=c=${bg}:s=${W}x${H}:r=${FPS}`);
    vchain = '[0:v]null';
  }

  // 글자
  const parts: string[] = [];
  if (c.kind === 'title' || c.kind === 'outro' || c.kind === 'placeholder') {
    const t = textFilter(dir, `t${i}`, wrap(c.text ?? '', 16), { size: c.kind === 'placeholder' ? 44 : 64, y: '(h-text_h)/2-30' });
    if (t) parts.push(t);
    if (c.kind === 'outro') {
      const n = textFilter(dir, `n${i}`, AI_NOTICE, { size: 30, y: 'h-120' });
      if (n) parts.push(n);
    }
    if (c.kind === 'placeholder') {
      const n = textFilter(dir, `p${i}`, '(연습 모드: AI 장면 자리)', { size: 26, y: '40', color: 'white@0.7' });
      if (n) parts.push(n);
    }
  }
  if (c.caption?.trim() && c.kind !== 'title' && c.kind !== 'outro') {
    const cap = textFilter(dir, `c${i}`, wrap(c.caption), { size: 44, y: 'h-text_h-70', box: true });
    if (cap) parts.push(cap);
  }
  if (c.aiBadge) {
    const b = textFilter(dir, `b${i}`, 'AI 생성', { size: 24, y: '24', box: true });
    if (b) parts.push(b.replace('x=(w-text_w)/2', 'x=28'));
  }
  vchain += parts.length ? `,${parts.join(',')}` : '';
  vchain += ',format=yuv420p[v]';

  // 소리 입력 (1번): 목소리 > 원래 소리 > 무음
  let achain: string;
  if (c.voice) {
    args.push('-i', c.voice);
    achain = `[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${c.dur}[a]`;
  } else if (c.kind === 'video' && c.src && c.keepAudio && (await hasAudio(c.src))) {
    achain = `[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${c.dur}[a]`;
  } else {
    args.push('-f', 'lavfi', '-t', String(c.dur), '-i', 'anullsrc=r=48000:cl=stereo');
    achain = `[1:a]atrim=0:${c.dur}[a]`;
  }

  args.push(
    '-filter_complex', `${vchain};${achain}`,
    '-map', '[v]', '-map', '[a]',
    '-t', String(c.dur),
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
