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
const POLL_MS = 10_000;
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
  const created = await ai.interactions.create({
    model: CONFIG.omniModel(),
    background: true,
    response_format: { type: 'video', delivery: 'inline', aspect_ratio: '16:9', duration: `${sec}s`, resolution: res },
    ...req,
  });
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
    const t2v = { input: job.promptEn, generation_config: { video_config: { task: 'text_to_video' } } };
    if (!job.editEn && job.refImage) {
      // ① 주인공 카드를 보고 이 장면의 첫 그림(같은 주인공·같은 그림체)을 그린다
      // ② 그 그림을 첫 장면으로 영상을 만든다. 어느 단계든 안 되면 글만으로 만든다.
      try {
        const key = await drawImage(
          [
            { inlineData: { mimeType: 'image/png', data: job.refImage.toString('base64') } },
            { text: `The attached image is the main character reference. Draw ONE 16:9 frame of the scene below with exactly this character (same face, hair, body, clothes and colors) and exactly the same art style. No text.\n${job.promptEn}` },
          ],
          '16:9',
        );
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
export async function drawImage(parts: any[], aspectRatio: '1:1' | '16:9'): Promise<{ bytes: Buffer; mimeType: string }> {
  const res: any = await genai().models.generateContent({
    model: CONFIG.imageModel(),
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } } as any,
  });
  const part = res.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!part) {
    const why = res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason ?? 'no image';
    if (/SAFETY|BLOCK|PROHIBITED/i.test(String(why))) throw new SafetyBlockedError(String(why));
    throw new Error(`그림 생성 실패: ${why}`);
  }
  return { bytes: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType ?? 'image/png' };
}

// ───────── 중등 이미지 모드 ─────────
export const imageProvider: VideoProvider = {
  async generate(job) {
    const res: any = await genai().models.generateContent({
      model: CONFIG.imageModel(),
      contents: [{ role: 'user', parts: [{ text: job.editEn ? `${job.promptEn}\nChange: ${job.editEn}` : job.promptEn }] }],
      config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } } as any,
    });
    const part = res.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
    if (!part) {
      const why = res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason ?? 'no image';
      if (/SAFETY|BLOCK|PROHIBITED/i.test(String(why))) throw new SafetyBlockedError(String(why));
      throw new Error(`이미지 생성 실패: ${why}`);
    }
    return { bytes: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType ?? 'image/png' };
  },
};

export function provider(): VideoProvider {
  return CONFIG.videoProvider() === 'omni' ? omniProvider : mockProvider;
}
