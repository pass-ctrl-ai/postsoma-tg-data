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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
// Optional comma-separated fallbacks, used if the primary model errors/timeouts.
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash,gemini-1.5-flash')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);


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

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanSummary(s) {
  let out = decodeHtmlEntities(String(s || '')).replace(/\s+/g, ' ').trim();
  // Drop common low-quality / SEO boilerplate
  const bad = [
    'Contribute to',
    'by creating an account on GitHub',
    'Sign up for',
    'Subscribe',
    'cookies',
    'newsletter',
  ];
  if (bad.some(b => out.toLowerCase().includes(b.toLowerCase()))) return null;
  // Trim trailing boilerplate separators
  out = out.replace(/\s+[\-|•|·]\s+GitHub\s*$/i, '').trim();
  return out || null;
}

function parseGitHubRepo(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'github.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1];
    // ignore pages like /topics, /search
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

async function fetchGitHubRepoMeta(owner, repo) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      signal: ctrl.signal,
      headers: {
        'user-agent': 'PostSomaBot/1.0',
        'accept': 'application/vnd.github+json'
      }
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      full_name: data.full_name,
      description: data.description,
      stargazers_count: data.stargazers_count,
      homepage: data.homepage,
      topics: data.topics
    };
  } catch {
    return null;
  }
}

function sanitizeHierTag(t) {
  // Lowercase, keep alnum + / + -
  const out = String(t || '').trim().toLowerCase().replace(/[^a-z0-9\/-]+/g, '-');
  return out.replace(/^-+|-+$/g, '').replace(/\/+/, '/');
}

function uniq(arr) {
  return [...new Set(arr)];
}

function tryParseJson(text) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    const slice = text.slice(start, end + 1);
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

async function geminiEnrich({ url, title, description }) {
  if (!GEMINI_API_KEY) return null;

  const candidates = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS.filter(m => m !== GEMINI_MODEL)];

  const prompt = `You are writing a Telegram post for an English "Web Intel" channel.

Given a URL and optional hints, generate strictly VALID JSON with keys:
- title: short, human-friendly (<=80 chars)
- summary: exactly ONE sentence, <=160 chars, no quotes around it
- highlights: array of 2 short bullet phrases (each <=60 chars)
- tags: array of 1-3 hierarchical tags using / (lowercase). Examples: ai/agents, dev/cli, security/privacy, data/etl, ops/infra, design/ui, productivity/automation

Rules:
- Do NOT include any other keys.
- Do NOT wrap in markdown.
- Do NOT include URLs in summary/highlights.

Input:
URL: ${url}
Hint title: ${title || ''}
Hint description: ${description || ''}
`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 256
    }
  };

  let lastErr = null;

  for (const modelId of candidates) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    try {
      const ctrl = new AbortController();
      const tmr = setTimeout(() => ctrl.abort(), 15_000);

      const res = await fetch(endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });

      clearTimeout(tmr);

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        lastErr = new Error(`Gemini API failed (${modelId}): ${res.status} ${t}`);
        continue;
      }

      const data = await res.json();

      // Success path
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
      const json = tryParseJson(text);
      if (!json) return null;

      const out = {
        title: typeof json.title === 'string' ? json.title.trim() : null,
        summary: typeof json.summary === 'string' ? json.summary.trim() : null,
        highlights: Array.isArray(json.highlights) ? json.highlights.map(x => String(x).trim()).filter(Boolean) : [],
        tags: Array.isArray(json.tags) ? json.tags.map(sanitizeHierTag).filter(Boolean) : [],
      };

      if (out.summary && out.summary.length > 160) out.summary = out.summary.slice(0, 160);
      if (out.title && out.title.length > 120) out.title = out.title.slice(0, 120);

      out.highlights = out.highlights.slice(0, 2).map(h => h.slice(0, 60));
      out.tags = uniq(out.tags).slice(0, 3);

      return out;

    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  if (lastErr) throw lastErr;
  return null;

  // Unreachable
  // return null;

  // NOTE: we return inside the loop on success.

  // End geminiEnrich

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  const json = tryParseJson(text);
  if (!json) return null;

  const out = {
    title: typeof json.title === 'string' ? json.title.trim() : null,
    summary: typeof json.summary === 'string' ? json.summary.trim() : null,
    highlights: Array.isArray(json.highlights) ? json.highlights.map(x => String(x).trim()).filter(Boolean) : [],
    tags: Array.isArray(json.tags) ? json.tags.map(sanitizeHierTag).filter(Boolean) : [],
  };

  if (out.summary && out.summary.length > 160) out.summary = out.summary.slice(0, 160);
  if (out.title && out.title.length > 120) out.title = out.title.slice(0, 120);

  out.highlights = out.highlights.slice(0, 2).map(h => h.slice(0, 60));
  out.tags = uniq(out.tags).slice(0, 3);

  return out;
}

async function buildMessage(item) {
  let title = safeTitle(item);
  const url = item.canonical_url || item.url;

  let description = null;

  const summary = (item.summary || '').trim();
  const summaryMissing = !summary;

  // Special-case GitHub repos (much better summary/title than HTML meta on github.com)
  const gh = url ? parseGitHubRepo(url) : null;
  if (gh) {
    const meta = await fetchGitHubRepoMeta(gh.owner, gh.repo);
    if (meta) {
      title = meta.full_name || title;
      if (summaryMissing && meta.description) description = meta.description;
      // If item.tags empty, use a light default tag.
      if (Array.isArray(item.tags) && item.tags.length === 0) {
        item.tags = ['dev/open-source'];
      }
    }
  }

  // If title is still basically a URL (and/or summary missing), try to fetch page title + meta description.
  if (url) {
    const titleIsUrlish = (title === url || title === (item.canonical_url || '') || title === (item.url || ''));
    if (titleIsUrlish || summaryMissing) {
      const meta = await fetchPageMeta(url);
      if (titleIsUrlish && meta.title) title = meta.title;
      if (summaryMissing && meta.description) description = meta.description;
    }
  }

  // LLM enrich (Gemini) to improve title/summary/highlights/tags.
  // Only runs when GEMINI_API_KEY is set.
  const enrich = await geminiEnrich({
    url,
    title: decodeHtmlEntities(title),
    description: cleanSummary(description) || description
  }).catch(() => null);

  if (enrich?.title) title = enrich.title;
  const finalSummary = (enrich?.summary || summary || cleanSummary(description) || 'A useful web find worth saving.').trim();

  // Merge tags
  if (enrich?.tags?.length) {
    const merged = uniq([...(Array.isArray(item.tags) ? item.tags : []), ...enrich.tags].map(sanitizeHierTag).filter(Boolean));
    item.tags = merged.slice(0, 3);
  }

  // Attach highlights (for future use)
  if (enrich?.highlights?.length) {
    item.content = item.content || {};
    item.content.highlights = enrich.highlights;
  }

  // Clean up HTML entities
  title = decodeHtmlEntities(title);

  const tags = formatTags(item.tags);

  const summaryLine = decodeHtmlEntities(finalSummary).slice(0, 160);

  const highlights = item.content?.highlights;
  const hl = Array.isArray(highlights) && highlights.length
    ? highlights.slice(0, 2).map(h => `• ${String(h).trim()}`).join('\n')
    : null;

  const bodyLines = [hl].filter(Boolean);

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
