import { logger } from 'firebase-functions';
import { genai } from './client';
import { CONFIG, Res } from '../config';

export type VideoJob = {
  promptEn: string; // 지금까지의 수정이 모두 반영된 영어 프롬프트
  editEn?: string; // 대화형 수정 지시(영어)
  previousInteractionId?: string; // 수정할 원본의 Omni 상호작용 ID
  res: Res;
  sec: number;
  img: boolean; // 중등 이미지 모드
  refImage?: Buffer; // 주인공 카드(기준 그림)
  prevFrame?: Buffer; // 앞 장면의 마지막 화면(이어지게)
  srcVideo?: Buffer; // 그림체를 바꿀 학생 영상(mp4, 10초 이하)
};
export type VideoResult = { bytes?: Buffer; mimeType: string; interactionId?: string; mock?: boolean; sec?: number; keyframe?: Buffer; usedRef?: boolean };

export interface VideoProvider {
  generate(job: VideoJob): Promise<VideoResult>;
}

export class SafetyBlockedError extends Error {}

// ───────── 가짜(mock): 비용 없이 흐름만 확인 ─────────
export const mockProvider: VideoProvider = {
  async generate(job) {
    await new Promise((r) => setTimeout(r, (job.res === '720p' ? 6 : 3) * 1000));
    return { mimeType: job.img ? 'image/png' : 'video/mp4', mock: true, interactionId: `mock-${Date.now()}` };
  },
};

// ───────── Gemini Omni (Interactions API) ─────────
// 공식 예제(GoogleCloudPlatform/generative-ai, gemini_omni_flash_video_gen.ipynb)의 구조를 따른다.
// 필드 이름은 REST 와 같은 snake_case. SDK 버전이 바뀌면 이 파일만 고치면 된다.
const POLL_MS = 4_000; // 다 됐는지 자주 확인해서 끝나자마자 가져온다
const TIMEOUT_MS = 25 * 60_000;

async function waitDone(id: string): Promise<any> {
  const ai: any = genai();
  const start = Date.now();
  let it = await ai.interactions.get(id);
  while (it.status === 'in_progress' || it.status === 'queued' || it.status === 'pending') {
    if (Date.now() - start > TIMEOUT_MS) throw new Error('Omni 생성 시간이 너무 오래 걸려요');
    await new Promise((r) => setTimeout(r, POLL_MS));
    it = await ai.interactions.get(id);
  }
  return it;
}

function pickMedia(it: any): { data?: string; uri?: string; mimeType: string } {
  const contents: any[] = [];
  for (const step of it.steps ?? []) if (step.type === 'model_output') contents.push(...(step.content ?? []));
  for (const o of it.outputs ?? []) contents.push(o);
  // 영상이 있으면 영상을 먼저 고른다
  const m = contents.find((c) => c?.type === 'video' || String(c?.mime_type ?? '').startsWith('video')) ?? contents.find((c) => c?.type === 'image' || c?.data || c?.uri);
  if (!m) throw new Error('Omni 응답에 영상이 없어요');
  return { data: m.data, uri: m.uri, mimeType: m.mime_type ?? m.mimeType ?? 'video/mp4' };
}

async function download(uri: string): Promise<Buffer> {
  if (uri.startsWith('gs://')) {
    const { getStorage } = await import('firebase-admin/storage');
    const [bucket, ...rest] = uri.slice(5).split('/');
    const [buf] = await getStorage().bucket(bucket).file(rest.join('/')).download();
    return buf;
  }
  const r = await fetch(uri);
  if (!r.ok) throw new Error(`영상 내려받기 실패 ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// 한 번 만들기: 요청 → 끝날 때까지 기다리기 → 영상 꺼내기
async function runOmni(req: Record<string, any>, sec: number, res: string) {
  const ai: any = genai();
  // 고치기(edit)는 원래 영상의 화면 비율·길이를 그대로 쓰므로 비율·길이를 보내면 안 된다(400 오류)
  const isEdit = req?.generation_config?.video_config?.task === 'edit' || !!req?.previous_interaction_id;
  const fmt: Record<string, any> = { type: 'video', delivery: 'inline', resolution: res };
  if (!isEdit) {
    fmt.aspect_ratio = '16:9';
    if (sec) fmt.duration = `${sec}s`;
  }
  let created: any;
  try {
    created = await ai.interactions.create({ model: CONFIG.omniModel(), background: true, response_format: fmt, ...req });
  } catch (e: any) {
    // "~ cannot be set in response format" 이면 그 칸을 빼고 한 번 더
    const m = /(aspect ratio|duration|resolution)[^.]*cannot be set/i.exec(String(e?.message ?? e));
    if (!m) throw e;
    const key = m[1].toLowerCase().startsWith('aspect') ? 'aspect_ratio' : m[1].toLowerCase();
    delete fmt[key];
    logger.warn('Omni: response_format 에서 빼고 다시', { key });
    created = await ai.interactions.create({ model: CONFIG.omniModel(), background: true, response_format: fmt, ...req });
  }
  const it = created.status === 'completed' ? created : await waitDone(created.id);
  if (it.status !== 'completed') {
    const reason = JSON.stringify(it.error ?? it.status);
    if (/safety|blocked|policy/i.test(reason)) throw new SafetyBlockedError(reason);
    throw new Error(`Omni 생성 실패: ${reason}`);
  }
  const m = pickMedia(it);
  const bytes = m.data ? Buffer.from(m.data, 'base64') : await download(m.uri!);
  return { bytes, mimeType: m.mimeType, interactionId: created.id as string };
}

// 고른 길이를 모델이 받지 않으면(400) 더 짧은 길이로 다시 시도한다. 실제로 만든 길이를 돌려준다
async function runOmniSec(req: Record<string, any>, sec: number, res: string): Promise<VideoResult> {
  const tries = [sec, ...[8, 6, 5, 4, 3].filter((x) => x < sec)];
  let last: unknown;
  for (const s of tries) {
    try {
      return { ...(await runOmni(req, s, res)), sec: s };
    } catch (e: any) {
      last = e;
      if (e instanceof SafetyBlockedError) throw e;
      const msg = String(e?.message ?? e);
      if (!/duration|INVALID_ARGUMENT|400/i.test(msg)) throw e; // 길이 문제가 아니면 바로 실패
      logger.warn('Omni: 이 길이는 안 돼서 더 짧게 다시 시도', { sec: s, err: msg.slice(0, 200) });
    }
  }
  throw last;
}

export const omniProvider: VideoProvider = {
  async generate(job) {
    if (job.img) return imageProvider.generate(job);
    if (job.srcVideo) {
      // 학생이 올린 영상을 고른 그림체로 다시 그린다(움직임·구도·길이는 그대로)
      const input = [{ type: 'user_input', content: [{ type: 'video', data: job.srcVideo.toString('base64'), mime_type: 'video/mp4' }, { type: 'text', text: job.promptEn }] }];
      try {
        return { ...(await runOmni({ input, generation_config: { video_config: { task: 'edit' } } }, 0, job.res)), sec: job.sec };
      } catch (e: any) {
        if (e instanceof SafetyBlockedError) throw e;
        const msg = String(e?.message ?? e);
        logger.warn('Omni: 내 영상 그림체 바꾸기 실패', { err: msg.slice(0, 300) });
        throw e;
      }
    }
    const t2v = { input: job.promptEn, generation_config: { video_config: { task: 'text_to_video' } } };
    if (!job.editEn && (job.refImage || job.prevFrame)) {
      // ① 주인공 카드를 보고 이 장면의 첫 그림(같은 주인공·같은 그림체)을 그린다
      // ② 그 그림을 첫 장면으로 영상을 만든다. 어느 단계든 안 되면 글만으로 만든다.
      try {
        const parts: any[] = [];
        const notes: string[] = [];
        if (job.refImage) {
          parts.push({ inlineData: { mimeType: 'image/png', data: job.refImage.toString('base64') } });
          notes.push(`Image ${parts.length} is the main character reference: keep exactly this character (same face, hair, body, clothes and colors) and exactly the same art style.`);
        }
        if (job.prevFrame) {
          parts.push({ inlineData: { mimeType: 'image/png', data: job.prevFrame.toString('base64') } });
          notes.push(`Image ${parts.length} is the LAST frame of the previous scene of the same story. This new frame must feel like the very next moment of one continuous film: same art style, same color palette and lighting mood, same character look, natural continuation of position and camera. If the scene below happens in a different place, keep the style and mood and change only the place.`);
        }
        parts.push({ text: `${notes.join(' ')} Draw ONE 16:9 frame of the scene below. No text.\n${job.promptEn}` });
        // 첫 그림이 40초 안에 안 나오면(AI가 바쁠 때) 기다리지 않고 글만으로 바로 영상을 만든다
        const key = await Promise.race([
          drawImage(parts, '16:9', { quick: true }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('keyframe timeout')), 40_000)),
        ]);
        try {
          const r = await runOmniSec(
            {
              input: [{ type: 'user_input', content: [{ type: 'image', data: key.bytes.toString('base64'), mime_type: key.mimeType }, { type: 'text', text: job.promptEn }] }],
              generation_config: { video_config: { task: 'image_to_video' } },
            },
            job.sec,
            job.res,
          );
          return { ...r, keyframe: key.bytes, usedRef: true };
        } catch (e) {
          if (e instanceof SafetyBlockedError) throw e;
          logger.warn('Omni: 그림으로 시작하는 영상 실패, 글만으로 만듭니다', { err: String((e as any)?.message ?? e).slice(0, 300) });
        }
      } catch (e) {
        if (e instanceof SafetyBlockedError) throw e;
        logger.warn('장면 첫 그림 실패, 글만으로 만듭니다', { err: String((e as any)?.message ?? e).slice(0, 300) });
      }
    }
    if (!job.editEn) return runOmniSec(t2v, job.sec, job.res);
    // 수정: ① 이전 결과를 이어서 고치기(previous_interaction_id) → 안 되면 ② 원래 프롬프트에 수정 지시를 합쳐 새로 만들기
    if (job.previousInteractionId) {
      try {
        return await runOmniSec(
          { input: job.editEn, previous_interaction_id: job.previousInteractionId, generation_config: { video_config: { task: 'edit' } } },
          job.sec,
          job.res,
        );
      } catch (e) {
        if (e instanceof SafetyBlockedError) throw e;
        logger.warn('Omni 이어서 고치기 실패, 합친 프롬프트로 새로 만듭니다', { err: String((e as any)?.message ?? e).slice(0, 300) });
      }
    }
    return runOmniSec({ ...t2v, input: `${job.promptEn}` }, job.sec, job.res);
  },
};

// ───────── 그림 한 장 그리기 (주인공 카드, 장면 첫 그림) ─────────
// 그림 모델은 이름이 바뀌거나 지원이 끝날 수 있어서, 설정한 모델이 안 되면 다음 모델로 넘어간다.
// 같은 모델에서 그림 없이 끝나면(가끔 생김) 한 번 더 시도한다.
const IMAGE_MODELS = () => [...new Set([CONFIG.imageModel(), 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image'])];
let goodImageModel: string | undefined;

async function drawOnce(model: string, parts: any[], aspectRatio: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const res: any = await genai().models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } } as any,
  });
  const part = res.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!part) {
    const why = res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason ?? 'no image';
    if (/SAFETY|BLOCK|PROHIBITED/i.test(String(why))) throw new SafetyBlockedError(String(why));
    throw new Error(`NO_IMAGE ${why}`);
  }
  return { bytes: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType ?? 'image/png' };
}

export async function drawImage(parts: any[], aspectRatio: '1:1' | '16:9', opt: { quick?: boolean } = {}): Promise<{ bytes: Buffer; mimeType: string }> {
  // quick: 한 번 성공한 모델만 한 번 시도(장면 첫 그림처럼 늦으면 안 되는 곳)
  const models = goodImageModel ? (opt.quick ? [goodImageModel] : [goodImageModel, ...IMAGE_MODELS().filter((m) => m !== goodImageModel)]) : IMAGE_MODELS();
  let last: unknown;
  for (const model of models) {
    for (let k = 0; k < (opt.quick ? 1 : 2); k++) {
      try {
        const r = await drawOnce(model, parts, aspectRatio);
        goodImageModel = model;
        return r;
      } catch (e: any) {
        if (e instanceof SafetyBlockedError) throw e;
        last = e;
        const msg = String(e?.message ?? e);
        logger.warn('그림 그리기 실패', { model, try: k + 1, err: msg.slice(0, 300) });
        // 모델이 없거나 지원이 끝났으면 다음 모델로, 그림만 안 나왔으면 같은 모델로 한 번 더
        if (!/NO_IMAGE|RESOURCE_EXHAUSTED|429|503|UNAVAILABLE|DEADLINE/i.test(msg)) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

// ───────── 중등 이미지 모드 ─────────
export const imageProvider: VideoProvider = {
  async generate(job) {
    return drawImage([{ text: job.editEn ? `${job.promptEn}\nChange: ${job.editEn}` : job.promptEn }], '16:9');
  },
};

export function provider(): VideoProvider {
  return CONFIG.videoProvider() === 'omni' ? omniProvider : mockProvider;
}
