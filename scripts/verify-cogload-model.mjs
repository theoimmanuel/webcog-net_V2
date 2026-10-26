// Verifies the generated artifact loads as a TF.js LayersModel and runs a
// [1, 5, 3] -> 3-class inference. Run: node scripts/verify-cogload-model.mjs
import * as tf from '@tensorflow/tfjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '..', 'public', 'models', 'cogload');

async function main() {
  await tf.setBackend('cpu');
  await tf.ready();

  const modelJson = JSON.parse(readFileSync(join(DIR, 'model.json'), 'utf8'));
  const manifest = modelJson.weightsManifest;
  const shardPath = join(DIR, manifest[0].paths[0]);
  const shardBuf = readFileSync(shardPath);
  const weightData = shardBuf.buffer.slice(
    shardBuf.byteOffset,
    shardBuf.byteOffset + shardBuf.byteLength
  );

  // Load via a custom IOHandler that feeds the on-disk artifacts to tfjs,
  // exactly as the browser's http handler would from /public.
  const handler = {
    load: async () => ({
      modelTopology: modelJson.modelTopology,
      weightSpecs: manifest.flatMap((g) => g.weights),
      weightData,
      format: modelJson.format,
      generatedBy: modelJson.generatedBy,
      convertedBy: modelJson.convertedBy,
    }),
  };

  const model = await tf.loadLayersModel(handler);
  console.log('Loaded LayersModel. Input:', JSON.stringify(model.inputs[0].shape),
    'Output:', JSON.stringify(model.outputs[0].shape));

  const input = tf.tensor3d([[
    [0.3, 15, 40],
    [0.28, 16, 45],
    [0.25, 18, 60],
    [0.22, 20, 80],
    [0.2, 22, 95],
  ]]); // shape [1, 5, 3]

  const out = model.predict(input);
  const probs = await out.data();
  const sum = probs.reduce((a, b) => a + b, 0);
  console.log('Output probs:', Array.from(probs).map((p) => p.toFixed(4)));
  console.log('Prob count:', probs.length, '(expected 3)');
  console.log('Softmax sums to ~1:', Math.abs(sum - 1) < 1e-4 ? 'OK' : `FAIL (${sum})`);
  console.log('All finite:', probs.every((p) => Number.isFinite(p)) ? 'OK' : 'FAIL');

  if (probs.length !== 3 || Math.abs(sum - 1) > 1e-4 || !probs.every(Number.isFinite)) {
    process.exit(1);
  }
  console.log('VERIFY: artifact is a valid, loadable LayersModel.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
