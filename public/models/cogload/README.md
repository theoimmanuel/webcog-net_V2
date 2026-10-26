# Cognitive-Load Classifier Artifact (`cogload`)

This directory holds the pre-trained, quantized TensorFlow.js **LayersModel** that the
Scenario C adaptive loop loads in the browser to infer cognitive load from the
5-second feature window.

## Files

| File | Purpose |
| --- | --- |
| `model.json` | Model topology (`modelTopology`) + `weightsManifest` with per-tensor uint8 quantization metadata. |
| `group1-shard1of1.bin` | Single quantized (uint8) weight shard referenced by `weightsManifest[0].paths`. |

The app loads it with:

```ts
const model = await tf.loadLayersModel('/models/cogload/model.json');
```

## Model shape

Hybrid 1D CNN-GRU, matching the design:

```
Input [1, 5, 3]            # 5 timesteps (1 aggregated vector/sec), 3 channels = [EAR, BlinkRate, SaccadeVelocity]
  -> Conv1D(filters=4, kernelSize=2, padding="same", relu)   # small filter bank
  -> GRU(units=4, tanh / sigmoid recurrent)                   # temporal dynamics
  -> Dense(3, softmax)                                        # LOW / MODERATE / HIGH
```

Total parameters: **151** (deliberately tiny to meet the size and latency targets,
Req 4.1 / 4.2).

## Measured artifact size

| File | Bytes |
| --- | --- |
| `model.json` | 3,068 |
| `group1-shard1of1.bin` | 151 |
| **Total** | **3,219** |

This is well under the **51,200-byte (50 KB)** budget required by Requirement 4.1 /
Property 12 (under budget by ~47,981 bytes).

> The app also measures this size at load time by summing the fetched byte lengths and
> records it in the session (Req 4.3); it flags the artifact if the total ever reaches
> 51,200 bytes (Req 4.6).

## Offline training + quantization conversion step

Training is **offline and out of band** — the app only ships and runs the artifact; it
never trains. The artifact currently committed is structurally valid with
small/random-initialized weights so the pipeline is loadable and testable end to end.
Replace it with real trained weights using the standard offline flow below.

### 1. Train (offline, e.g. Keras / TF)

Train the Conv1D → GRU → Dense(softmax) model above on labeled 5×3 feature windows and
save it as a Keras model (`cogload.keras` / SavedModel / `cogload.h5`).

### 2. Convert + quantize with `tensorflowjs_converter`

Quantize weights during conversion to keep the on-disk artifact tiny. uint8 (1 byte per
weight) is used here; float16 is also acceptable:

```bash
# uint8 (used for the committed artifact)
tensorflowjs_converter \
  --input_format=keras \
  --quantize_uint8=* \
  cogload.keras \
  public/models/cogload

# or float16
tensorflowjs_converter \
  --input_format=keras \
  --quantize_float16=* \
  cogload.keras \
  public/models/cogload
```

This emits `model.json` plus one or more `groupN-shardMofK.bin` weight shards. The
`weightsManifest` in `model.json` references the exact shard filename(s); keep them in
sync if you re-shard.

### Regenerating the placeholder artifact

The committed placeholder is produced by a Node script that builds the model with
`@tensorflow/tfjs` and applies the same uint8 quantization the converter would:

```bash
node scripts/build-cogload-model.mjs    # writes model.json + group1-shard1of1.bin
node scripts/verify-cogload-model.mjs   # loads it and runs a [1,5,3] -> 3-class inference
```

After replacing with real trained weights, re-measure the total byte size and update the
table above to confirm it stays under 51,200 bytes.
