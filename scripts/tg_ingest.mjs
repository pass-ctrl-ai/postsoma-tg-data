#!/usr/bin/env node
/**
 * Telegram inbox ingestion (polling via getUpdates)
 *
 * Reads:
 *   - TG_BOT_TOKEN (env)
 *   - INBOX_CHAT_ID (env)
 *
 * Writes:
 *   - data/tools.jsonl (append new items)
 *   - data/tg_state.json (persists last_update_id)
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const TOKEN = process.env.TG_BOT_TOKEN;
const INBOX_CHAT_ID = process.env.INBOX_CHAT_ID;

if (!TOKEN) throw new Error('Missing env TG_BOT_TOKEN');
if (!INBOX_CHAT_ID) throw new Error('Missing env INBOX_CHAT_ID');

const STATE_PATH = 'data/tg_state.json';
const OUT_PATH = 'data/tools.jsonl';

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Strip common tracking params
    const strip = new Set([
      'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
      'ref','ref_src','fbclid','gclid','igshid'
    ]);
    [...u.searchParams.keys()].forEach(k => { if (strip.has(k)) u.searchParams.delete(k); });
    // Canonical-ish cleanup
    u.hash = '';
    // remove trailing slash except root
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    // prefer https
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.toString();
  } catch {
    return url;
  }
}

function extractUrls(text) {
  if (!text) return [];
  const re = /(https?:\/\/[^\s)\]}>"']+)/g;
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1]);
  }
  return [...found];
}

async function tgGetUpdates(offset) {
  const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=0${offset ? `&offset=${offset}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram getUpdates failed: ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram getUpdates not ok: ${JSON.stringify(data)}`);
  return data.result;
}

function appendLines(path, lines) {
  if (!lines.length) return;
  fs.appendFileSync(path, lines.join('\n') + '\n', 'utf8');
}

const state = readJson(STATE_PATH, { last_update_id: null });
const offset = state.last_update_id ? state.last_update_id + 1 : undefined;

const updates = await tgGetUpdates(offset);

let maxUpdateId = state.last_update_id ?? 0;

// Build a set of existing ids to avoid duplicates
const existingIds = new Set();
if (fs.existsSync(OUT_PATH)) {
  const txt = fs.readFileSync(OUT_PATH, 'utf8');
  for (const line of txt.split(/\n/)) {
    if (!line.trim()) continue;
    try { existingIds.add(JSON.parse(line).id); } catch {}
  }
}

const newItems = [];

for (const u of updates) {
  if (typeof u.update_id === 'number') maxUpdateId = Math.max(maxUpdateId, u.update_id);

  const msg = u.message || u.edited_message || u.channel_post || u.edited_channel_post;
  if (!msg || !msg.chat) continue;

  const chatId = String(msg.chat.id);
  if (chatId !== String(INBOX_CHAT_ID)) continue;

  const text = msg.text || msg.caption || '';
  const urls = extractUrls(text);
  if (!urls.length) continue;

  const author = msg.from?.username || msg.from?.first_name || null;

  for (const rawUrl of urls) {
    const canonical = normalizeUrl(rawUrl);
    const id = `tool_${sha1(canonical).slice(0, 12)}`;
    if (existingIds.has(id)) continue;

    const createdAt = new Date((msg.date ?? Math.floor(Date.now()/1000)) * 1000).toISOString();

    const item = {
      id,
      url: rawUrl,
      canonical_url: canonical,
      title: canonical, // placeholder; we can enrich later
      summary: null,
      tags: [],
      language: 'en',
      source: {
        type: 'tg',
        chat_id: chatId,
        message_id: String(msg.message_id ?? ''),
        author
      },
      status: 'inbox',
      created_at: createdAt,
      updated_at: null
    };

    newItems.push(item);
    existingIds.add(id);
  }
}

appendLines(OUT_PATH, newItems.map(x => JSON.stringify(x)));

fs.mkdirSync('data', { recursive: true });
if (updates.length) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ last_update_id: maxUpdateId }, null, 2) + '\n');
}

console.log(JSON.stringify({
  updates: updates.length,
  new_items: newItems.length,
  last_update_id: updates.length ? maxUpdateId : state.last_update_id
}, null, 2));
