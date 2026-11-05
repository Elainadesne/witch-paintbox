import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import {
  defaultOpenAIImageParameters, validateOpenAIImageParameters, generateOpenAIImage, fetchOpenAIImageModels,
  OPENAI_IMAGE_26_MODELS, supportsOpenAIImageComplexity,
} from '../dist/openai-image.js';
import { queueImageGeneration } from '../dist/image-queue.js';
import { crc32 } from '../dist/image-bytes.js';
import { defaultAllImageSettings, validateAllImageSettings } from '../dist/image-settings.js';

// A real, CRC-checked single-pixel PNG keeps decoding on the production byte path.
function png() {
  function chunk(name, bytes) {
    const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, crc]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const image = png();
const connection = { channel: 'custom', url: 'https://image-mock.invalid/v1', key: 'test-only-not-a-real-key', appendSuffix: true };
const params = (extra = {}) => ({ ...defaultOpenAIImageParameters(), model: 'gpt-image-2.6-flare', ...extra });
function intercept(t, respond = () => Response.json({ data: [{ b64_json: image.toString('base64') }] })) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options, json: options?.body ? JSON.parse(options.body) : undefined });
    return respond(url, options);
  });
  return calls;
}

test('2.6 PNG requests preserve explicit model, prompt and quality, omitting default complexity', async t => {
  const calls = intercept(t);
  for (const model of OPENAI_IMAGE_26_MODELS) {
    const input = params({ model, quality: 'max' }), text = 'exact user scene, @example:outfit, 1.2::red::';
    const result = await generateOpenAIImage(connection, input, text, new AbortController().signal);
    assert.deepEqual(calls.at(-1).json, { model, prompt: text, n: 1, size: '1024x1536', quality: 'max', output_format: 'png' });
    assert.equal(calls.at(-1).url, 'https://image-mock.invalid/v1/images/generations');
    assert.equal(result.blob.type, 'image/png'); assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), image);
    assert.equal(result.parameters.width, 1); assert.equal(result.parameters.height, 1);
    assert.equal(result.parameters.complexity, 'default'); assert.equal(input.width, 1024);
    assert.equal('response_format' in calls.at(-1).json, false);
    assert.equal('key' in result.parameters, false);
  }
});

test('each 2.6 model sends low, medium and high complexity independently of quality', async t => {
  const calls = intercept(t);
  for (const model of OPENAI_IMAGE_26_MODELS) for (const complexity of ['low', 'medium', 'high']) {
    const result = await generateOpenAIImage(connection, params({ model, complexity, quality: 'low' }), 'scene', new AbortController().signal);
    assert.equal(calls.at(-1).json.complexity, complexity);
    assert.equal(calls.at(-1).json.quality, 'low');
    assert.equal(result.parameters.complexity, complexity);
  }
  assert.equal(calls.length, 6);
});

test('older, unknown and proxy alias models omit complexity without losing saved choices', async t => {
  const calls = intercept(t);
  for (const model of ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'chatgpt-image-latest', 'my-image-alias']) {
    const input = params({ model, complexity: 'high' });
    assert.equal(supportsOpenAIImageComplexity(model), false);
    const result = await generateOpenAIImage(connection, input, 'scene', new AbortController().signal);
    assert.equal(Object.hasOwn(calls.at(-1).json, 'complexity'), false);
    assert.equal(result.parameters.complexity, 'default'); assert.equal(input.complexity, 'high');
  }
});

test('2.6 size limits reject invalid requests before fetch, retaining previous 2/2.5 checks', async t => {
  const calls = intercept(t);
  for (const model of [...OPENAI_IMAGE_26_MODELS, 'gpt-image-2', 'gpt-image-2.5-sunburst']) {
    for (const [width, height] of [[64, 64], [4096, 1024], [3840, 3840], [512, 2048], [2048, 512], [1000, 1024]]) {
      await assert.rejects(generateOpenAIImage(connection, params({ model, width, height }), 'scene', new AbortController().signal), error => error.fault === 'setup');
    }
  }
  assert.equal(calls.length, 0);
  for (const model of OPENAI_IMAGE_26_MODELS) {
    for (const [width, height] of [[1024, 1024], [1024, 1536], [1536, 1024], [1536, 864], [3840, 2160], [640, 1024]]) {
      await generateOpenAIImage(connection, params({ model, width, height }), 'scene', new AbortController().signal);
      assert.equal(calls.at(-1).json.size, `${width}x${height}`);
    }
  }
});

test('legacy settings and history parameters gain default complexity; invalid values fail validation', () => {
  const old = { model: 'gpt-image-2.5-flare', width: 1024, height: 1536, quality: 'auto' };
  assert.equal(validateOpenAIImageParameters(old).complexity, 'default');
  assert.equal(validateOpenAIImageParameters({ ...old, width: 1, height: 1 }, 'image').complexity, 'default');
  const all = defaultAllImageSettings(); delete all.profiles.openai.openaiParameters.complexity;
  assert.equal(validateAllImageSettings(all).profiles.openai.openaiParameters.complexity, 'default');
  for (const complexity of [null, '', 'auto', 'xhigh', 0, false, {}, []]) {
    assert.throws(() => validateOpenAIImageParameters(params({ complexity })), error => error.fault === 'setup');
  }
});

test('queued requests freeze complexity, dimensions and connection before later edits', async t => {
  const calls = intercept(t), gate = Promise.withResolvers();
  const first = queueImageGeneration(() => gate.promise, new AbortController().signal);
  const input = params({ complexity: 'medium' }), configured = { ...connection };
  const request = generateOpenAIImage(configured, input, 'original scene', new AbortController().signal);
  assert.equal(calls.length, 0);
  input.complexity = 'high'; input.quality = 'max'; input.model = 'other-model'; input.width = 1536;
  configured.url = 'https://other.invalid'; configured.key = 'other-key';
  gate.resolve(); await first;
  const result = await request;
  assert.equal(calls[0].json.complexity, 'medium'); assert.equal(calls[0].json.model, 'gpt-image-2.6-flare');
  assert.equal(calls[0].json.size, '1024x1536'); assert.equal(calls[0].json.quality, 'auto');
  assert.equal(calls[0].url, 'https://image-mock.invalid/v1/images/generations');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-only-not-a-real-key');
  assert.equal(result.parameters.complexity, 'medium');
});

test('unsupported complexity responses and rate limits never trigger a paid retry or model fallback', async t => {
  const calls = intercept(t, () => Response.json({ error: { message: 'unsupported complexity' } }, { status: 400 }));
  await assert.rejects(generateOpenAIImage(connection, params({ complexity: 'high' }), 'scene', new AbortController().signal), /HTTP 400/);
  assert.equal(calls.length, 1);
  t.mock.restoreAll();
  const limited = intercept(t, () => Response.json({ error: {} }, { status: 429 }));
  await assert.rejects(generateOpenAIImage(connection, params(), 'scene', new AbortController().signal), error => error.fault === 'busy');
  assert.equal(limited.length, 1);
});

test('model discovery keeps new IDs and custom IDs without claiming access or filtering', async t => {
  const calls = intercept(t, () => Response.json({ data: [...OPENAI_IMAGE_26_MODELS, 'custom-image', 'gpt-image-2.6-flare'].map(id => ({ id })) }));
  const models = await fetchOpenAIImageModels(connection, new AbortController().signal);
  assert.deepEqual(models, ['custom-image', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']);
  assert.equal(calls[0].url, 'https://image-mock.invalid/v1/models');
});
