/**
 * Captcha OCR — nhận diện captcha MB Bank bằng ONNX model
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import * as ort from "onnxruntime-node";

// Model nằm cạnh binary sau khi build (hoặc tại root artifact khi dev)
const MODEL_PATH = join(process.cwd(), "model.onnx");

/** Character set: 0-9 a-z A-Z (sorted) */
const CHARSET: string[] = [];
for (let i = 0; i < 10; i++) CHARSET.push(String(i));
for (let i = 97; i <= 122; i++) CHARSET.push(String.fromCharCode(i));
for (let i = 65; i <= 90; i++) CHARSET.push(String.fromCharCode(i));
CHARSET.sort();

let session: ort.InferenceSession | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (session) return session;
  if (!existsSync(MODEL_PATH)) {
    throw new Error(`OCR model not found at ${MODEL_PATH}`);
  }
  session = await ort.InferenceSession.create(MODEL_PATH);
  return session;
}

export async function recognizeCaptcha(imageBuffer: Buffer): Promise<string | null> {
  try {
    const sess = await getSession();
    const raw = await sharp(imageBuffer).grayscale().resize(160, 50).raw().toBuffer();
    const pixels = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) pixels[i] = raw[i] / 255.0;

    const tensor = new ort.Tensor("float32", pixels, [1, 1, 50, 160]);
    const results = await sess.run({ [sess.inputNames[0]]: tensor });
    const output = Object.values(results)[0];
    const data = output.data as Float32Array;
    const dims = output.dims as readonly number[];
    const seqLen = dims[1], numClasses = dims[2];

    let text = "";
    for (let s = 0; s < seqLen; s++) {
      let maxIdx = 0, maxVal = data[s * numClasses];
      for (let c = 1; c < numClasses; c++) {
        const val = data[s * numClasses + c];
        if (val > maxVal) { maxVal = val; maxIdx = c; }
      }
      if (maxIdx >= 0 && maxIdx < CHARSET.length) text += CHARSET[maxIdx];
    }
    return text.length === 6 ? text : null;
  } catch {
    return null;
  }
}

export async function warmupOCR(): Promise<void> {
  await getSession();
}
