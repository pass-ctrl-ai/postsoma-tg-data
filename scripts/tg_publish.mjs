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

function buildMessage(item) {
  const title = safeTitle(item);
  const summary = (item.summary || '').trim();
  const url = item.canonical_url || item.url;
  const tags = formatTags(item.tags);

  // Enforce 1-sentence, <=160 chars guideline as best-effort (without LLM)
  const summaryLine = summary ? summary.slice(0, 160) : 'A useful web find worth saving.';

  const highlights = item.content?.highlights;
  const hl = Array.isArray(highlights) && highlights.length
    ? `• Highlights: ${highlights.slice(0, 2).join('; ')}`
    : null;

  const bestFor = item.content?.best_for || item.content?.use_case;
  const bf = bestFor ? `• Best for: ${String(bestFor).slice(0, 120)}` : null;

  const lines = [
    `【${title}】`,
    summaryLine,
    '',
    hl,
    bf,
    tags,
    '',
    `Link: ${url}`,
  ].filter(x => x != null && String(x).trim().length > 0);

  return lines.join('\n');
}

async function tgSendMessage(text) {
  const endpoint = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHANNEL_CHAT_ID,
      text,
      disable_web_page_preview: false
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

const text = buildMessage(next);
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
