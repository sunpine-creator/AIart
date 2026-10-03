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
  }
  return client;
}
