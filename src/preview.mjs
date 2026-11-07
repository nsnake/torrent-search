/**
 * 磁力预览：把磁力链接解析成种子元信息（名称 / 大小 / 文件数 / 截图）。
 *
 * 为什么放在服务端，而不是让前端直连：
 *   1. **隐私**：前端直连会把内容直接送给第三方；走服务端可以整体关掉（serve --no-preview）；
 *   2. **缓存**：第三方有速率限制，同一个 infohash 在多次搜索里反复出现，必须缓存；
 *   3. **不热链**：接口返回的截图由服务端代取，浏览器只访问同源地址。
 *
 * 没敲到就返回 null（第三方没收录这个种子），前端显示「无法预览」即可。
 */

import crypto from 'node:crypto';

/** 预览元信息缓存有效期：同一 infohash 的内容基本不变，缓存久一点省重复请求。 */
const META_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 截图字节缓存有效期。 */
const SHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 预览接口只返回很小的 JSON。 */
const META_MAX_BYTES = 1024 * 1024;
/** 截图图片远比普通封面小，2 MB 足够，也防止异常响应撑爆磁盘。 */
const SHOT_MAX_BYTES = 2 * 1024 * 1024;
/** 单个种子最多保留的截图数量 */
const MAX_SCREENSHOTS = 8;

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * 从磁力链接里提取 infohash。
 *
 * 兼容 `magnet:?xt=urn:btih:<40hex>` 与 `<32base32>`，也兼容直接传裸 infohash。
 *
 * @param {string} magnet 磁力链接或裸 infohash
 * @returns {string|null} 小写 hex infohash（40 位），无效时 null
 */
export function magnetInfohash(magnet) {
  const text = String(magnet ?? '').trim();
  if (text === '' || text.length > 2048) return null;

  if (/^[0-9a-fA-F]{40}$/.test(text)) return text.toLowerCase();

  const match = text.match(/[?&]xt=urn:btih:([A-Za-z2-7]{32})/i);
  if (match) {
    try {
      return base32ToHex(match[1].toLowerCase());
    } catch {
      return null;
    }
  }

  const hex = text.match(/[?&]xt=urn:btih:([0-9a-fA-F]{40})/i);
  if (hex) return hex[1].toLowerCase();

  return null;
}

/**
 * base32（RFC 4648）转小写十六进制。
 *
 * @param {string} input 32 位 base32
 * @returns {string} 40 位 hex
 */
function base32ToHex(input) {
  const bits = [];
  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('非法 base32 字符：' + char);
    for (let i = 4; i >= 0; i -= 1) bits.push((index >> i) & 1);
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  }
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error('非法 infohash');
  return hex;
}

/** 预览元信息在磁盘缓存里的 key：按 infohash，各类磁力链接变体共用一份。 */
function previewKey(infohash) {
  return `preview-meta-${infohash}`;
}

/** 截图在磁盘缓存里的 key：按截图 URL。 */
function screenshotKey(url) {
  return `preview-shot-${crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 20)}`;
}

/**
 * 建一个磁力预览器。
 *
 * @param {{
 *   http: {request: (url: string, options?: object) => Promise<{status: number, headers: object, body: Buffer}>},
 *   cache: {get: Function, set: Function},
 *   logger?: (message: string) => void,
 *   enabled?: boolean,
 *   timeoutMs?: number
 * }} options
 * @returns {{lookup: Function, image: Function, enabled: boolean}}
 */
export function createPreviewFetcher(options) {
  const { http, cache } = options;
  const logger = options.logger ?? (() => {});
  const enabled = options.enabled !== false;
  const timeoutMs = options.timeoutMs ?? 8000;

  /**
   * 解析一个磁力链接的预览信息（带缓存）。
   * 不会预先触发：只有调用方点开预览时才会真正请求第三方。
   *
   * @param {string} magnet 磁力链接（或裸 infohash）
   * @returns {Promise<{infohash: string, preview: object|null, source: 'cache'|'remote'}|null>}
   *   - null：功能未启用 / 磁力链接无效
   *   - preview：归一化元数据；第三方没收录时为 null
   */
  async function lookup(magnet) {
    if (!enabled) return null;

    const infohash = magnetInfohash(magnet);
    if (infohash === null) return null;

    const metaKey = previewKey(infohash);
    const cached = await readMeta(cache, metaKey).catch(() => null);
    if (cached !== null) {
      logger(`预览 ${infohash} 命中缓存${cached.payload ? '（已收录）' : '（未收录）'}`);
      return { infohash, preview: cached.payload, source: 'cache' };
    }

    // 向第三方发起真正的查询：url 参数要求原样编码整条磁力链接
    const target = text_startsWithMagnet(magnet) ? String(magnet) : `magnet:?xt=urn:btih:${infohash}`;

    let payload;
    try {
      const response = await http.request(
        `https://whatslink.info/api/v1/link?url=${encodeURIComponent(target)}`,
        { timeoutMs, maxBytes: META_MAX_BYTES, headers: { accept: 'application/json' } },
      );
      if (response.status !== 200) {
        logger(`预览查询失败： 返回 HTTP ${response.status}`);
        payload = null;
      } else {
        try {
          payload = JSON.parse(response.body.toString('utf8'));
        } catch (error) {
          logger(`预览查询失败：JSON 解析错误（${error?.message ?? error}）`);
          payload = null;
        }
      }
    } catch (error) {
      logger(`预览查询失败：${error?.message ?? error}`);
      payload = null;
    }

    const record = normalize(payload);
    await writeMeta(cache, metaKey, record).catch(() => {});
    // 截图字节也顺带取回，缓存下来供 /api/preview/image 直接读盘，前端不再接触第三方域名。
    // 必须 await 等字节全部落盘再返回：前端拿到元信息就会立刻渲染 <img src>，
    // 若这里 fire-and-forget，首次打开弹窗时截图字节还没写出，图片只会 404，
    // 必须点「重新加载」（后台代取那时早已完成）才能看到。
    if (record && record.screenshots.length > 0) {
      await prefetchScreenshots(record.screenshots).catch(() => {});
    }
    logger(`预览 ${infohash} ${record ? '命中' : '未命中'}`);
    return { infohash, preview: record, source: 'remote' };
  }

  /**
   * 取截图图片字节（只读缓存）。
   *
   * 与封面同理：只服务**缓存里已有的**截图。截图字节由 lookup() 在首次查询时
   * 代取并写入，因此这个接口不会变成任意 URL 代理（SSRF）。
   *
   * @param {string} key screenshotKey(url)，形如 preview-shot-<20hex>
   * @returns {Promise<{body: Buffer, contentType: string}|null>}
   */
  async function image(key) {
    if (!enabled || !/^preview-shot-[0-9a-f]{20}$/.test(key)) return null;

    const cached = await cache.get(key, { maxAgeMs: SHOT_TTL_MS }).catch(() => null);
    if (!cached) return null;
    return { body: cached.body, contentType: guessType(cached.body) };
  }

  /**
   * 并行预取截图字节（全部失败也不影响元信息返回）。
   *
   * @param {Array<{screenshot: string}>} shots
   */
  async function prefetchScreenshots(shots) {
    const results = await Promise.allSettled(
      shots.map((shot) => fetchShot(shot.screenshot)),
    );
    for (let i = 0; i < results.length; i += 1) {
      if (results[i].status !== 'fulfilled') continue;
      const { value } = results[i];
      await cache.set(screenshotKey(shots[i].screenshot), value.body).catch(() => {});
      logger(`预览截图已缓存（${value.size} 字节）`);
    }
  }

  /**
   * 取一张截图图片。
   *
   * @param {string} url
   * @returns {Promise<{body: Buffer, size: number}|null>}
   */
  async function fetchShot(url) {
    const response = await http.request(url, { timeoutMs, maxBytes: SHOT_MAX_BYTES });
    if (response.status !== 200) return null;
    const contentType = String(response.headers['content-type'] ?? '');
    if (!contentType.toLowerCase().startsWith('image/')) return null;
    return { body: response.body, size: response.body.length };
  }

  return { lookup, image, enabled };
}

/**
 * 把第三方响应归一化成固定结构，并截断过长字段。
 *
 * @param {any} payload 第三方 JSON 或 null
 * @returns {{name: string, fileType: string, type: string, size: number, count: number, screenshots: Array<{time: number, screenshot: string, key: string}>, hasInfo: boolean}|null}
 */
function normalize(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const name = asString(payload.name).slice(0, 300);
  const fileType = (asString(payload.file_type).slice(0, 32) || 'unknown').toLowerCase();
  const type = (asString(payload.type).slice(0, 32) || 'unknown').toLowerCase();
  const size = Math.max(0, asNumber(payload.size));
  const count = Math.max(0, asNumber(payload.count));

  const screenshots = [];
  for (const shot of Array.isArray(payload.screenshots) ? payload.screenshots : []) {
    const url = asString(shot?.screenshot);
    if (!/^https:\/\/[^\s]*whatslink\.info\/image/i.test(url)) continue;
    // 顺带给出截图在本地磁盘缓存里的 key（供 /api/preview/image/<key> 读取）：
    // 前端无需自己算 SHA-1，且读旧缓存时 normalize() 会重新补算，幂等。
    const target = url.slice(0, 2048);
    screenshots.push({ time: asNumber(shot?.time), screenshot: target, key: screenshotKey(target) });
    if (screenshots.length >= MAX_SCREENSHOTS) break;
  }

  const hasInfo = name !== '' || size > 0 || count > 0;
  if (!hasInfo) return null; // 第三方查到节点但没有可用信息，归一成未收录

  return { name, fileType, type, size, count, screenshots, hasInfo };
}

/**
 * 读预览元信息缓存。
 *
 * @param {any} cache
 * @param {string} key
 * @returns {Promise<{payload: object|null, at: number|null}|null>}
 */
async function readMeta(cache, key) {
  const hit = await cache.get(key, { maxAgeMs: META_TTL_MS }).catch(() => null);
  if (!hit) return null;
  try {
    const raw = JSON.parse(hit.body.toString('utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const payload = raw.payload ? normalize(raw.payload) : null;
    return { payload, at: typeof raw.at === 'number' ? raw.at : null };
  } catch {
    return null;
  }
}

/**
 * 写预览元信息缓存。
 *
 * @param {any} cache
 * @param {string} key
 * @param {object} record normalize() 的结果
 */
async function writeMeta(cache, key, record) {
  await cache.set(
    key,
    Buffer.from(JSON.stringify({ payload: record ?? null, at: Date.now() }), 'utf8'),
  );
}

/** 判断字符串是否以磁力链接开头。 */
function text_startsWithMagnet(value) {
  return String(value ?? '').startsWith('magnet:');
}

/**
 * 从图片字节猜内容类型（写缓存时没存 header，读缓存时靠内容探测）。
 *
 * @param {Buffer} body
 * @returns {string}
 */
function guessType(body) {
  const bytes = body.subarray(0, 16);
  if (body.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (body.length >= 8 && bytes.subarray(0, 4).toString('binary') === 'RIFF' && bytes.subarray(8, 12).toString('binary') === 'WEBP') return 'image/webp';
  if (body.length >= 6 && (bytes.subarray(0, 6).toString('binary') === 'GIF87a' || bytes.subarray(0, 6).toString('binary') === 'GIF89a')) return 'image/gif';
  if (body.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return 'image/jpeg';
}

/** 安全转字符串（非字符串/超长一律空串）。 */
function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 安全转有限数字。 */
function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return 0;
}
