import { writeFileSync } from 'node:fs';
import { genai } from './client';
import { env } from '../config';

// 정해진 AI 목소리만 쓴다. 학생 목소리를 흉내 내는 기능은 만들지 않는다.
const VOICES: Record<string, string> = {
  'AI 목소리 · 맑은': 'Leda',
  'AI 목소리 · 차분한': 'Charon',
  'AI 목소리 · 씩씩한': 'Puck',
};
export const isAiVoice = (v?: string) => !!v && v in VOICES;

// Gemini TTS 는 24kHz 16비트 모노 PCM 을 돌려준다. WAV 머리말을 붙여 파일로 저장한다.
export async function speak(text: string, voice: string, outPath: string): Promise<string | undefined> {
  const res: any = await genai().models.generateContent({
    model: env('TTS_MODEL', 'gemini-2.5-flash-preview-tts'),
    contents: [{ role: 'user', parts: [{ text: `어린이에게 들려주듯 밝고 또박또박 읽어 줘: ${text}` }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES[voice] } } },
    } as any,
  });
  const data = res.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;
  if (!data) return undefined;
  const pcm = Buffer.from(data, 'base64');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(outPath, Buffer.concat([h, pcm]));
  return outPath;
}
