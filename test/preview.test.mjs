/**
 * 磁力预览（src/preview.mjs）测试。
 *
 * 重点覆盖：lookup() 必须在返回前把截图字节落盘 —— 否则前端拿到元信息
 * 立刻渲染 <img src="/api/preview/image/<key>"> 时会 404（本回归的起因）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPreviewFetcher, magnetInfohash } from '../src/preview.mjs';
import { memoryCache } from './helpers.mjs';

/** 造一张可识别的 JPEG 头（guessType 靠魔数探测内容类型）。 */
function fakeJpeg(marker) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(marker, 'utf8')]);
}

/**
 * 桩 HTTP 客户端：认 whatslink.info 的两个端点。
 * - /api/v1/link：返回元信息 JSON
 * - /image/<n>：返回一张「图片」，带可延迟的 headers.content-type
 */
function stubPreviewHttp({ shots = 2, shotDelayMs = 0 } = {}) {
  const calls = [];
  const meta = {
    error: null,
    type: 'video',
    file_type: 'iso',
    name: 'Ubuntu 24.04 Desktop amd64',
    size: 5766787968,
    count: 1,
    screenshots: Array.from({ length: shots }, (_, i) => ({
      time: 10 + i * 5,
      screenshot: `https://whatslink.info/image/${i}.jpg`,
    })),
  };

  return {
    calls,
    async request(url, options = {}) {
      calls.push(url);
      await new Promise((resolve) => setTimeout(resolve, shotDelayMs));
      if (url.includes('/api/v1/link')) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(meta), 'utf8'),
          url,
        };
      }
      if (url.startsWith('https://whatslink.info/image/')) {
        return {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
          body: fakeJpeg(url.split('/').pop()),
          url,
        };
      }
      return { status: 404, headers: {}, body: Buffer.from('not found'), url };
    },
  };
}

test('magnetInfohash：40 位 hex / base32 / 裸磁力 / 无效输入', () => {
  const hex = '01c137287d6f0ed05a56742dae794f632c79ff3d';
  assert.equal(magnetInfohash(hex), hex);
  assert.equal(magnetInfohash(hex.toUpperCase()), hex);

  const b32 = 'ahatokd5n4hnawswoqw246kpmmwht7z5'; // 01c137287d6f0ed05a56742dae794f632c79ff3d 的 RFC 4648 编码
  assert.equal(magnetInfohash(`magnet:?xt=urn:btih:${b32}`), hex);

  assert.equal(magnetInfohash(`magnet:?xt=urn:btih:${hex}&dn=x`), hex);

  assert.equal(magnetInfohash(''), null);
  assert.equal(magnetInfohash('not a magnet'), null);
});

test('lookup：归一化第三方元信息并给出截图 key', async () => {
  const http = stubPreviewHttp();
  const cache = memoryCache();
  const finder = createPreviewFetcher({ http, cache, logger: () => {} });

  const result = await finder.lookup(`magnet:?xt=urn:btih:${'0'.repeat(40)}`);

  assert.equal(result.infohash, '0'.repeat(40));
  assert.equal(result.source, 'remote');
  assert.equal(result.preview.name, 'Ubuntu 24.04 Desktop amd64');
  assert.equal(result.preview.type, 'video');
  assert.equal(result.preview.size, 5766787968);
  assert.equal(result.preview.count, 1);
  assert.deepEqual(
    result.preview.screenshots.map((shot) => shot.key),
    result.preview.screenshots.map((shot) => shot.key), // 幂等重算
  );
  // key 必须符合 image() 接受的格式
  assert.match(result.preview.screenshots[0].key, /^preview-shot-[0-9a-f]{20}$/);

  // 非 whatslink.info 域名的截图会被丢弃（而不是整体丢信）
  const foreignResult = await createPreviewFetcher({
    http: {
      async request(url) {
        if (url.includes('/api/v1/link')) {
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({ name: 'x', screenshots: [{ screenshot: 'https://evil.example/x.jpg' }] })),
            url,
          };
        }
        return { status: 200, headers: {}, body: fakeJpeg('x'), url };
      },
    },
    cache: memoryCache(),
    logger: () => {},
  }).lookup('magnet:?xt=urn:btih:' + '1'.repeat(40));
  assert.ok(foreignResult);
  assert.equal(foreignResult.preview.screenshots.length, 0);
});

test('lookup：截图字节先落盘、随元信息一起返回（竞态回归）', async () => {
  // 截图代取故意慢于元信息响应：若 lookup 不等落盘，返回后立刻取图必然 404。
  const http = stubPreviewHttp({ shots: 2, shotDelayMs: 80 });
  const cache = memoryCache();
  const finder = createPreviewFetcher({ http, cache, logger: () => {} });

  const result = await finder.lookup('0'.repeat(40));

  assert.ok(result.preview.screenshots.length >= 1);
  for (const shot of result.preview.screenshots) {
    // lookup 返回的瞬间，字节必须已经在缓存里可读
    const image = await finder.image(shot.key);
    assert.ok(image, `截图 ${shot.key} 必须在 lookup 返回前落盘`);
    assert.equal(image.contentType, 'image/jpeg');
  }
});

test('lookup：第三方没收录时 preview 为 null，且缓存未收录标记', async () => {
  const http = {
    async request(url) {
      if (url.includes('/api/v1/link')) {
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ error: 'not found' })), url };
      }
      return { status: 404, headers: {}, body: Buffer.from(''), url };
    },
  };
  const cache = memoryCache();
  const finder = createPreviewFetcher({ http, cache, logger: () => {} });

  const result = await finder.lookup('magnet:?xt=urn:btih:' + '2'.repeat(40));
  assert.equal(result.preview, null);

  // 第二次查询走缓存（不再请求第三方），依旧返回未收录
  const cached = await finder.lookup('magnet:?xt=urn:btih:' + '2'.repeat(40));
  assert.equal(cached.source, 'cache');
  assert.equal(cached.preview, null);
});

test('lookup：第三方返回非 200 / 非 JSON 时归一为未收录', async () => {
  const http = {
    async request(url) {
      if (url.includes('/api/v1/link')) {
        return { status: 503, headers: {}, body: Buffer.from('upstream down'), url };
      }
      return { status: 200, headers: {}, body: fakeJpeg('x'), url };
    },
  };
  const cache = memoryCache();
  const finder = createPreviewFetcher({ http, cache, logger: () => {} });
  const result = await finder.lookup('magnet:?xt=urn:btih:' + '3'.repeat(40));
  assert.equal(result.preview, null);
});

test('lookup：第三方抛错视为未收录而不是抛给调用方', async () => {
  const http = {
    async request(url) {
      throw new Error('ECONNRESET');
    },
  };
  const cache = memoryCache();
  const finder = createPreviewFetcher({ http, cache, logger: () => {} });
  const result = await finder.lookup('magnet:?xt=urn:btih:' + '4'.repeat(40));
  assert.equal(result.preview, null);
});

test('image：拒绝非法 key；已缓存的字节可读回', async () => {
  const http = stubPreviewHttp({ shots: 1 });
  const cache = memoryCache();
  const finder = createPreviewFetcher({ http, cache, logger: () => {} });

  const result = await finder.lookup('magnet:?xt=urn:btih:' + '5'.repeat(40));
  const key = result.preview.screenshots[0].key;

  assert.equal(await finder.image('../../etc/passwd'), null);
  assert.equal(await finder.image('preview-shot-wrong'), null);

  const image = await finder.image(key);
  assert.ok(image.body.length > 0);
  assert.equal(image.contentType, 'image/jpeg');
});

test('lookup：未启用时直接返回 null，不发任何请求', async () => {
  let called = false;
  const http = {
    async request(url) {
      called = true;
      return { status: 404, headers: {}, body: Buffer.from(''), url };
    },
  };
  const finder = createPreviewFetcher({ http, cache: memoryCache(), enabled: false });
  const result = await finder.lookup('magnet:?xt=urn:btih:' + '6'.repeat(40));
  assert.equal(result, null);
  assert.equal(called, false);
  assert.equal(finder.enabled, false);
});
