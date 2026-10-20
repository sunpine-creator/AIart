import { GoogleGenAI } from '@google/genai';
import { CONFIG } from '../config';

// Vertex AI(Gemini Enterprise Agent Platform)로 호출한다. 인증은 Cloud Functions 서비스 계정(ADC).
// API 키 방식(AI Studio)은 18세 미만 대상 서비스에 쓸 수 없으므로 쓰지 않는다.
let client: GoogleGenAI | null = null;
export function genai(): GoogleGenAI {
  if (!client) {
    const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
    // SDK 버전에 따라 옵션 이름이 vertexai 또는 enterprise 다. 둘 다 넘긴다.
    client = new GoogleGenAI({ vertexai: true, enterprise: true, project, location: CONFIG.genaiLocation() } as any);
    // 한 반이 동시에 쓰면 AI 쪽에서 "잠시 뒤에"(429·503)라고 할 때가 있다. 그럴 땐 조금씩 기다렸다 다시 부른다.
    const models: any = client.models;
    const raw = models.generateContent.bind(models);
    models.generateContent = async (req: any) => {
      let wait = 1500;
      for (let k = 0; ; k++) {
        try {
          return await raw(req);
        } catch (e: any) {
          const msg = String(e?.message ?? e) + ' ' + String(e?.status ?? '');
          const busy = /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded|try again|DEADLINE|500 |INTERNAL/i.test(msg);
          if (!busy || k >= 5) throw e;
          await new Promise((r) => setTimeout(r, wait + Math.random() * 1000));
          wait = Math.min(wait * 2, 12000);
        }
      }
    };
  }
  return client;
}
