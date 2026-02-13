#!/usr/bin/env node
/**
 * Publish next inbox item to a Telegram Channel.
 *
 * Reads:
 *   - TG_BOT_TOKEN (env)
 *   - CHANNEL_CHAT_ID (env)
 *
 * Modifies:
 *   - data/tools.jsonl (marks one item as posted)
 */

import fs from 'node:fs';

const TOKEN = process.env.TG_BOT_TOKEN;
const CHANNEL_CHAT_ID = process.env.CHANNEL_CHAT_ID;

if (!TOKEN) throw new Error('Missing env TG_BOT_TOKEN');
if (!CHANNEL_CHAT_ID) throw new Error('Missing env CHANNEL_CHAT_ID');

const TOOLS_PATH = 'data/tools.jsonl';

function readLines(path) {
  if (!fs.existsSync(path)) return [];
  const txt = fs.readFileSync(path, 'utf8');
  return txt.split(/\n/).filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function safeTitle(item) {
  const t = (item.title || '').trim();
  if (t && t !== item.canonical_url && t !== item.url) return t;
  try {
    const u = new URL(item.canonical_url || item.url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return `${host}${path}`;
  } catch {
    return (item.canonical_url || item.url || 'Unknown').slice(0, 120);
  }
}

function formatTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return '#webintel';
  // Convert hierarchical tags to Telegram hashtags by replacing / with _
  const hashTags = tags
    .slice(0, 5)
    .map(t => String(t).trim())
    .filter(Boolean)
    .map(t => `#${t.replace(/\//g, '_')}`);
  return ['#webintel', ...hashTags].join(' ');
}

async function fetchPageMeta(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'PostSomaBot/1.0 (+https://github.com/pass-ctrl-ai/postsoma-tg-data)'
      }
    });
    clearTimeout(t);
    if (!res.ok) return { title: null, description: null };

    const html = (await res.text()).slice(0, 180_000);

    const titleMatch = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null;

    // Prefer OG/Twitter descriptions then meta name=description
    const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,400})["'][^>]*>/i)
      || html.match(/<meta[^>]+content=["']([^"']{1,400})["'][^>]+property=["']og:description["'][^>]*>/i);

    const twDesc = html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{1,400})["'][^>]*>/i)
      || html.match(/<meta[^>]+content=["']([^"']{1,400})["'][^>]+name=["']twitter:description["'][^>]*>/i);

    const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,400})["'][^>]*>/i)
      || html.match(/<meta[^>]+content=["']([^"']{1,400})["'][^>]+name=["']description["'][^>]*>/i);

    const descriptionRaw = (ogDesc?.[1] || twDesc?.[1] || metaDesc?.[1] || '').trim();
    const description = descriptionRaw ? descriptionRaw.replace(/\s+/g, ' ').trim() : null;

    return { title, description };
  } catch {
    return { title: null, description: null };
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function buildMessage(item) {
  let title = safeTitle(item);
  const url = item.canonical_url || item.url;

  let description = null;

  // If title is still basically a URL (and/or summary missing), try to fetch page title + meta description.
  if (url) {
    const titleIsUrlish = (title === url || title === (item.canonical_url || '') || title === (item.url || ''));
    const summaryMissing = !(item.summary || '').trim();
    if (titleIsUrlish || summaryMissing) {
      const meta = await fetchPageMeta(url);
      if (titleIsUrlish && meta.title) title = meta.title;
      if (summaryMissing && meta.description) description = meta.description;
    }
  }

  const summary = (item.summary || '').trim();
  const tags = formatTags(item.tags);

  // Enforce 1-sentence, <=160 chars guideline as best-effort (without LLM)
  const baseSummary = summary || description || 'A useful web find worth saving.';
  const summaryLine = baseSummary.slice(0, 160);

  const highlights = item.content?.highlights;
  const hl = Array.isArray(highlights) && highlights.length
    ? `• Highlights: ${highlights.slice(0, 2).join('; ')}`
    : null;

  const bestFor = item.content?.best_for || item.content?.use_case;
  const bf = bestFor ? `• Best for: ${String(bestFor).slice(0, 120)}` : null;

  const bodyLines = [hl, bf].filter(Boolean);

  // HTML parse_mode for clean formatting
  const parts = [
    `<b>${escapeHtml(title)}</b>`,
    escapeHtml(summaryLine),
    bodyLines.length ? `\n${escapeHtml(bodyLines.join('\n'))}` : '',
    `\n${escapeHtml(tags)}`,
    `\n🔗 ${escapeHtml(url)}`
  ].filter(Boolean);

  return parts.join('\n');
}

async function tgSendMessage(text) {
  const endpoint = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHANNEL_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram sendMessage not ok: ${JSON.stringify(data)}`);
  return data.result;
}

const lines = readLines(TOOLS_PATH);
const items = lines.map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const next = items.find(it => it.status === 'inbox');

if (!next) {
  console.log(JSON.stringify({ posted: false, reason: 'no_inbox_items' }));
  process.exit(0);
}

const text = await buildMessage(next);
const result = await tgSendMessage(text);

// Mark posted
const postedAt = nowIso();
next.status = 'posted';
next.updated_at = postedAt;
next.published = {
  channel: 'telegram',
  post_id: String(result.message_id ?? ''),
  posted_at: postedAt
};

const out = items.map(it => JSON.stringify(it)).join('\n') + '\n';
fs.writeFileSync(TOOLS_PATH, out, 'utf8');

console.log(JSON.stringify({
  posted: true,
  id: next.id,
  message_id: result.message_id,
  posted_at: postedAt
}, null, 2));
