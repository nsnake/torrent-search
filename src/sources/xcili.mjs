/**
 * Xcili（无极磁链，xcili.net）——中文磁力索引站。
 *
 * 站点形态：
 * - 搜索是服务端渲染的 HTML 表格（GET /search?q=…），没有公开 JSON/RSS。
 * - 列表行只给「标题 + 体积 + 日期」；磁力链接在**详情页** `/!xxxxxx` 的
 *   `<input id="input-magnet" value="magnet:?xt=urn:btih:…">` 里。
 *
 * 稳健性处理：
 * 1. 主结果行一定带 `<mark>查询词</mark>` 高亮；站点还会在表格尾部混入
 *    「相关资源」区（无关成人片名，同样是 result-title 结构）——只保留
 *    带高亮的行，杜绝无关资源混入。
 * 2. 体积列形如 "6.2GB"，无空格，交给 parseSizeText 兜底归一。
 * 3. 详情页逐条抓、边抓边拼，达到 limit 即停，减少站点负担；
 *    碰到 403/超时只跳过当前条（站点软封频繁，单条错误不能放大成整次失败）。
 *
 * 分类与成人：本站是综合内容站（正常 + 成人混杂），但站点不提供任何分类
 * 标注，因此**不猜标题关键词**，一律 `adult: false`（见 F16「非成人站点
 * 永不标记」）。需要过滤成人的用户不要依赖 --safe，它对本站无效。
 */

import { makeResult } from '../models.mjs';
import { take, stripHtml } from './util.mjs';
import { parseTimestamp } from '../size.mjs';
import { parseMagnet, normalizeInfoHash } from '../magnet.mjs';

const SITE_BASE = 'https://xcili.net';
const HTML_OPTS = (ctx) => ({
  timeoutMs: ctx.timeoutMs,
  signal: ctx.signal,
  maxBytes: 8 * 1024 * 1024,
});

/**
 * 从详情页 HTML 提取磁力链接（属性值需实体解码）。
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractMagnet(html) {
  if (!html) return null;
  const m = html.match(/<input[^>]*id="input-magnet"[^>]*value="([^"]*)"/i);
  if (!m) return null;
  const value = m[1]
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'");
  return value.startsWith('magnet:') ? value : null;
}

/**
 * 从列表页提取主结果行。
 *
 * 主结果行：单元格先进入 `result-title`（标题 + 详情页链接），后进入
 * `result-meta`（体积 `<div>` + `result-date` 日期）。相关资源区结构相同但
 * 标题没有 `<mark>` 高亮，据此剔除。
 *
 * @param {string|null|undefined} html
 * @returns {Array<{href: string, title: string, sizeText: string, dateText: string}>}
 */
function parseRows(html) {
  const rows = [];
  if (!html) return rows;

  const rowRe = /<tr[^>]*>[\s\S]*?<td[^>]*class="[^"]*result-title[^"]*"[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*class="[^"]*result-meta[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  let m;

  while ((m = rowRe.exec(html)) !== null) {
    const titleCell = m[1];
    const metaCell = m[2];

    const hrefMatch = titleCell.match(/<a[^>]*href="([^"]*)"[^>]*>/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];
    if (!href || href.startsWith('javascript:')) continue;
    // 主结果的标题一定包含 <mark> 高亮；相关资源区没有
    if (!/<mark/i.test(titleCell)) continue;

    const title = titleCell
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) continue;

    const sizeMatch = metaCell.match(/<div[^>]*>([^<]*)<\/div>/i);
    const dateMatch = metaCell.match(/<div[^>]*class="[^"]*result-date[^"]*"[^>]*>([^<]*)<\/div>/i);

    rows.push({
      href,
      title,
      sizeText: sizeMatch ? stripHtml(sizeMatch[1]) : '',
      dateText: dateMatch ? stripHtml(dateMatch[1]) : '',
    });
  }
  return rows;
}

/**
 * 站点搜索主流程。
 */
export default {
  id: 'xcili',
  name: 'Xcili 无极磁链',
  description: '中文磁力索引站（xcili.net）：列表 HTML + 详情页取磁力；仅取主结果行，剔除相关资源区',
  homepage: SITE_BASE,
  kinds: ['general'],
  defaultEnabled: true,

  async search(query, ctx) {
    const limit = Math.max(1, ctx.limit ?? 20);
    const q = (query ?? '').trim();
    if (!q) return [];

    const pageUrl = `${SITE_BASE}/search?q=${encodeURIComponent(q)}`;
    const html = await ctx.http.getText(pageUrl, HTML_OPTS(ctx));

    const rows = parseRows(html);
    const results = [];

    for (const row of rows) {
      if (results.length >= limit) break;
      const rel = row.href.startsWith('http') ? new URL(row.href).pathname : row.href;
      const detailUrl = rel.startsWith('/') ? `${SITE_BASE}${rel}` : `${SITE_BASE}/${rel}`;
      try {
        const detailHtml = await ctx.http.getText(detailUrl, HTML_OPTS(ctx));
        const magnet = extractMagnet(detailHtml);
        const parsed = magnet ? parseMagnet(magnet) : null;
        const infoHash = parsed ? normalizeInfoHash(parsed.infoHash) : null;
        if (!infoHash) continue;

        results.push(makeResult({
          source: 'xcili',
          title: row.title,
          infoHash,
          magnet,
          sizeText: row.sizeText,
          seeders: null,
          leechers: null,
          category: null,
          publishedAt: parseTimestamp(row.dateText),
          detailsUrl: detailUrl,
          torrentUrl: null,
          adult: false,
        }));
      } catch {
        // 单条详情页失败直接跳过
        continue;
      }
    }

    return take(results, limit);
  },
};
