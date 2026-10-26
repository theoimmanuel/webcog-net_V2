// Offline artifact generator for the WebCog-Net cognitive-load classifier.
//
// This script builds the hybrid 1D CNN-GRU TF.js LayersModel described in the
// design (input [1, 5, 3] -> Conv1D -> GRU -> Dense softmax over 3 classes),
// serializes it to the standard TF.js LayersModel format, applies uint8
// post-training-style quantization to the weight data, and writes
//   public/models/cogload/model.json
//   public/models/cogload/group1-shard1of1.bin
//
// Weights are small/random-initialized on purpose: real training is OFFLINE and
// out of band (see public/models/cogload/README.md). This script only produces a
// structurally valid, loadable artifact well under the 51,200-byte budget.
//
// Run with:  node scripts/build-cogload-model.mjs

import * as tf from '@tensorflow/tfjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'models', 'cogload');
const WEIGHTS_FILE = 'group1-shard1of1.bin';

const T = 5; // timesteps (one aggregated feature vector per second over 5s window)
const C = 3; // channels: [EAR, BlinkRate, SaccadeVelocity]
const CLASSES = 3; // LOW / MODERATE / HIGH

function buildModel() {
  const model = tf.sequential();
  // Conv1D small filter bank over the 5-timestep window.
  model.add(
    tf.layers.conv1d({
      inputShape: [T, C],
      filters: 4,
      kernelSize: 2,
      padding: 'same',
      activation: 'relu',
      name: 'conv1d_feat',
    })
  );
  // GRU with a few units to capture temporal dynamics.
  model.add(
    tf.layers.gru({
      units: 4,
      activation: 'tanh',
      recurrentActivation: 'sigmoid',
      name: 'gru_temporal',
    })
  );
  // Dense softmax over the 3 cognitive-load classes.
  model.add(
    tf.layers.dense({
      units: CLASSES,
      activation: 'softmax',
      name: 'dense_logits',
    })
  );
  return model;
}

// uint8 affine quantization matching TF.js's `quantization` weight-spec format.
// For each weight group we store: min, scale (float32 in model.json) + uint8 data.
function quantizeToUint8(float32Values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of float32Values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min) || !isFinite(max)) {
    min = 0;
    max = 0;
  }
  const range = max - min;
  const scale = range > 0 ? range / 255 : 1;
  const quantized = new Uint8Array(float32Values.length);
  for (let i = 0; i < float32Values.length; i++) {
    let q = scale > 0 ? Math.round((float32Values[i] - min) / scale) : 0;
    if (q < 0) q = 0;
    if (q > 255) q = 255;
    quantized[i] = q;
  }
  return { quantized, min, scale };
}

async function main() {
  await tf.setBackend('cpu');
  await tf.ready();

  const model = buildModel();
  model.summary();

  // Capture the raw (float32) artifacts via a custom IOHandler.
  let captured;
  await model.save(
    tf.io.withSaveHandler(async (artifacts) => {
      captured = artifacts;
      return {
        modelArtifactsInfo: {
          dateSaved: new Date(),
          modelTopologyType: 'JSON',
        },
      };
    })
  );

  const { modelTopology, weightSpecs } = captured;
  const weightData = new Float32Array(captured.weightData); // concatenated float32

  // Build a uint8-quantized weight blob while rewriting the weight specs so the
  // artifact declares per-tensor quantization. Each tensor is quantized over its
  // own value range for better fidelity at uint8.
  const quantSpecs = [];
  const chunks = [];
  let offset = 0; // in float32 elements
  for (const spec of weightSpecs) {
    const numEls = spec.shape.reduce((a, b) => a * b, 1);
    const slice = weightData.subarray(offset, offset + numEls);
    offset += numEls;
    const { quantized, min, scale } = quantizeToUint8(slice);
    chunks.push(quantized);
    quantSpecs.push({
      name: spec.name,
      shape: spec.shape,
      dtype: 'float32',
      quantization: { dtype: 'uint8', scale, min },
    });
  }

  // Concatenate all uint8 chunks into a single shard.
  const totalBytes = chunks.reduce((a, c) => a + c.byteLength, 0);
  const shard = new Uint8Array(totalBytes);
  let p = 0;
  for (const c of chunks) {
    shard.set(c, p);
    p += c.byteLength;
  }

  const modelJson = {
    format: 'layers-model',
    generatedBy: 'webcog-net build-cogload-model.mjs (TensorFlow.js)',
    convertedBy: 'uint8 post-training quantization (offline)',
    modelTopology,
    weightsManifest: [
      {
        paths: [WEIGHTS_FILE],
        weights: quantSpecs,
      },
    ],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const modelJsonStr = JSON.stringify(modelJson);
  writeFileSync(join(OUT_DIR, 'model.json'), modelJsonStr);
  writeFileSync(join(OUT_DIR, WEIGHTS_FILE), Buffer.from(shard));

  const modelJsonBytes = Buffer.byteLength(modelJsonStr);
  const shardBytes = shard.byteLength;
  const total = modelJsonBytes + shardBytes;
  console.log('--- artifact written ---');
  console.log('model.json           :', modelJsonBytes, 'bytes');
  console.log(`${WEIGHTS_FILE} :`, shardBytes, 'bytes');
  console.log('total                :', total, 'bytes');
  console.log('budget (< 51200)     :', total < 51200 ? 'OK' : 'EXCEEDED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
