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
  src?: string; // 영상·이미지 파일 경로
  keepAudio?: boolean; // 올린 영상의 원래 소리 쓰기
  voice?: string; // 녹음·AI 목소리 파일 경로
  layers?: Layers;
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

export async function renderSegment(c: Clip, i: number, dir: string): Promise<string> {
  const out = join(dir, `seg_${String(i).padStart(2, '0')}.mp4`);
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS}`;
  const d = String(c.dur);
  const filters: string[] = [];

  // 0번 입력: 바탕(영상·이미지·색)
  if (c.kind === 'video' && c.src) {
    if (c.start && c.start > 0) args.push('-ss', String(c.start));
    args.push('-i', c.src);
    filters.push(`[0:v]${fit},tpad=stop_mode=clone:stop_duration=${c.dur}[b0]`);
  } else if (c.kind === 'image' && c.src) {
    args.push('-loop', '1', '-t', d, '-i', c.src);
    filters.push(`[0:v]${fit}[b0]`);
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
