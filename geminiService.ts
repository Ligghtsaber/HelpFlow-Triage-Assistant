
import { GoogleGenAI, Type, Modality, LiveServerMessage } from "@google/genai";
import { TriageInput, TriageResult, GroundingSource } from "./types";

const SYSTEM_INSTRUCTION = `You are a deterministic triage assistant. Follow these rules exactly:
- Role: customer support triage assistant for HelpFlow.
- Behavior: always return a single JSON object matching the Golden Prompt schema and keys exactly.
- Tone: empathetic and concise in the "reply" field; factual and actionable elsewhere.
- Length limits: reply <= 60 words; troubleshooting_step <= 30 words; summary <= 120 characters; priority_reason <= 200 characters.
- Priority rules: set High for data loss, crashes for paid tiers, duplicate billing, security incidents, or legal/medical/financial requests; include escalation_instructions for High.
- Ambiguity: assume reasonable defaults and state assumptions in priority_reason.
- Safety: never give legal, medical, or financial advice; escalate instead.
- Output enforcement: if you cannot produce valid JSON, return {"error":"unable_to_generate_valid_json"}.

Output format (strict JSON only):
{
  "summary": "<one-line summary>",
  "priority": "<High|Medium|Low>",
  "priority_reason": "<one-sentence reason>",
  "reply": "<suggested reply, <=60 words>",
  "troubleshooting_step": "<one short step, <=30 words>",
  "escalation_instructions": "<one-line or empty string>"
}

Constraints:
- Return ONLY valid JSON with the exact keys above and no extra keys.
- If recent_activity_summary is empty, assume "no recent changes".`;

export const triageMessage = async (input: TriageInput): Promise<TriageResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const processedInput = {
    ...input,
    recent_activity_summary: input.recent_activity_summary?.trim() || "no recent changes"
  };

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Input: ${JSON.stringify(processedInput)}`,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.0,
      maxOutputTokens: 300,
      responseMimeType: "application/json",
      tools: input.use_search ? [{ googleSearch: {} }] : undefined,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          priority: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
          priority_reason: { type: Type.STRING },
          reply: { type: Type.STRING },
          troubleshooting_step: { type: Type.STRING },
          escalation_instructions: { type: Type.STRING }
        },
        required: ["summary", "priority", "priority_reason", "reply", "troubleshooting_step", "escalation_instructions"],
      }
    }
  });

  const raw = response.text; 
  if (!raw) throw new Error('Empty response from AI engine');

  let result: TriageResult;
  try {
    result = JSON.parse(raw.trim());
  } catch (e) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      result = JSON.parse(raw.slice(start, end + 1));
    } else {
      throw new Error('Could not parse JSON response');
    }
  }

  // Extract grounding chunks if search was used
  const grounding_sources: GroundingSource[] = [];
  if (input.use_search && response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
    response.candidates[0].groundingMetadata.groundingChunks.forEach((chunk: any) => {
      if (chunk.web) {
        grounding_sources.push({
          title: chunk.web.title || 'Source',
          uri: chunk.web.uri
        });
      }
    });
  }

  return { ...result, grounding_sources };
};

// --- Live Audio Utilities ---

export function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function createPcmBlob(data: Float32Array): { data: string; mimeType: string } {
  const int16 = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encodeBase64(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}
