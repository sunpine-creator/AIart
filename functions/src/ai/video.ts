import { genai } from './client';
import { CONFIG, Res } from '../config';

export type VideoJob = {
  promptEn: string; // 지금까지의 수정이 모두 반영된 영어 프롬프트
  editEn?: string; // 대화형 수정 지시(영어)
  previousInteractionId?: string; // 수정할 원본의 Omni 상호작용 ID
  res: Res;
  sec: number;
  img: boolean; // 중등 이미지 모드
};
export type VideoResult = { bytes?: Buffer; mimeType: string; interactionId?: string; mock?: boolean };

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
  const m = contents.find((c) => c?.type === 'video' || c?.type === 'image' || c?.data || c?.uri);
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

export const omniProvider: VideoProvider = {
  async generate(job) {
    if (job.img) return imageProvider.generate(job);
    const ai: any = genai();
    let input: any = job.promptEn;
    let task = 'text_to_video';
    if (job.editEn && job.previousInteractionId) {
      // 대화형 수정: 이전 상호작용의 단계에 새 지시를 덧붙인다
      try {
        const prev = await ai.interactions.get(job.previousInteractionId);
        input = [...(prev.steps ?? []), { type: 'user_input', content: [{ type: 'text', text: job.editEn }] }];
        task = 'edit';
      } catch {
        input = `${job.promptEn}`; // 이전 기록을 못 읽으면 합친 프롬프트로 새로 만든다
      }
    }
    const created = await ai.interactions.create({
      model: CONFIG.omniModel(),
      input,
      background: true,
      generation_config: { video_config: { task } },
      response_format: { aspect_ratio: '16:9', duration: `${job.sec}s`, resolution: job.res },
    });
    const it = created.status === 'completed' ? created : await waitDone(created.id);
    if (it.status !== 'completed') {
      const reason = JSON.stringify(it.error ?? it.status);
      if (/safety|blocked|policy/i.test(reason)) throw new SafetyBlockedError(reason);
      throw new Error(`Omni 생성 실패: ${reason}`);
    }
    const m = pickMedia(it);
    const bytes = m.data ? Buffer.from(m.data, 'base64') : await download(m.uri!);
    return { bytes, mimeType: m.mimeType, interactionId: created.id };
  },
};

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
