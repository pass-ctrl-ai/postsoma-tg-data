#!/usr/bin/env node
/**
 * GitHub Issue → PostSoma DB ingest
 *
 * Triggered by GitHub Actions on issues.
 * - Extract GitHub repo links from issue title/body
 * - Upsert each repo into data/tools.jsonl (status=enriched)
 * - Write notes/<id>.md
 * - Comment back + close issue
 *
 * Env (Actions):
 * - GITHUB_TOKEN (required)
 * - GEMINI_API_KEY (optional)
 * - GITHUB_REPOSITORY (owner/repo)
 * - ISSUE_NUMBER (required)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GH_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const REPO_SLUG = process.env.GITHUB_REPOSITORY;
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;

if (!GH_TOKEN) throw new Error('Missing GITHUB_TOKEN');
if (!REPO_SLUG) throw new Error('Missing GITHUB_REPOSITORY');
if (!ISSUE_NUMBER) throw new Error('Missing ISSUE_NUMBER');

const TOOLS_PATH = 'data/tools.jsonl';
const NOTES_DIR = 'notes';

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.toString();
  } catch {
    return url;
  }
}

function extractGitHubRepoUrls(text) {
  const t = String(text || '');
  const re = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?/g;
  const found = new Set();
  for (const m of t.matchAll(re)) {
    const raw = m[0];
    // Reduce to owner/repo root
    try {
      const u = new URL(raw);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        found.add(`https://github.com/${parts[0]}/${parts[1]}`);
      }
    } catch {}
  }
  return [...found];
}

function parseGitHubRepo(url) {
  const u = new URL(url);
  if (u.hostname !== 'github.com') throw new Error('Not a github.com URL');
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Expected github.com/OWNER/REPO');
  return { owner: parts[0], repo: parts[1] };
}

async function ghApi(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com/${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'PostSomaBot/1.0'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${pathname} failed: ${res.status} ${t}`);
  }
  return await res.json();
}

async function fetchGitHubRepoMeta(owner, repo) {
  const d = await ghApi(`repos/${owner}/${repo}`);
  return {
    full_name: d.full_name,
    description: d.description,
    stars: d.stargazers_count,
    forks: d.forks_count,
    language: d.language,
    license: d.license?.spdx_id ?? d.license?.key ?? null,
    updated_at: d.updated_at,
    pushed_at: d.pushed_at,
    topics: Array.isArray(d.topics) ? d.topics : [],
    homepage: d.homepage || null
  };
}

function sanitizeHierTag(t) {
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
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function geminiEnrich({ url, title, description }) {
  if (!GEMINI_API_KEY) return null;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const prompt = `You are writing an English knowledge-base entry for a \"Web Intel\" library.\n\nReturn strictly VALID JSON with keys:\n- summary: exactly ONE sentence, <=160 chars\n- highlights: array of 2 short bullet phrases (<=60 chars each)\n- tags: array of 1-3 hierarchical tags using / (lowercase). Examples: ai/agents, dev/cli, dev/open-source, security/privacy, data/etl, ops/infra, design/ui, productivity/automation\n\nRules:\n- Do NOT include any other keys.\n- Do NOT wrap in markdown.\n- Do NOT include URLs.\n\nInput:\nURL: ${url}\nTitle hint: ${title}\nDescription hint: ${description || ''}\n`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 256 }
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini API failed: ${res.status} ${t}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  const json = tryParseJson(text);
  if (!json) return null;

  const out = {
    summary: typeof json.summary === 'string' ? json.summary.trim() : null,
    highlights: Array.isArray(json.highlights) ? json.highlights.map(x => String(x).trim()).filter(Boolean) : [],
    tags: Array.isArray(json.tags) ? json.tags.map(sanitizeHierTag).filter(Boolean) : []
  };
  if (out.summary && out.summary.length > 160) out.summary = out.summary.slice(0, 160);
  out.highlights = out.highlights.slice(0, 2).map(h => h.slice(0, 60));
  out.tags = uniq(out.tags).slice(0, 3);
  return out;
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\n/).filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function writeJsonl(p, items) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, items.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
}

function isoNow() {
  return new Date().toISOString();
}

function makeNotesMd({ meta, enrich, url }) {
  const hl = enrich?.highlights?.length ? enrich.highlights.map(h => `- ${h}`).join('\n') : '- (auto)';
  const tags = enrich?.tags?.length ? enrich.tags.join(', ') : '(none)';

  return `# ${meta.full_name}\n\n` +
    `**Summary:** ${enrich?.summary || meta.description || ''}\n\n` +
    `## Highlights\n${hl}\n\n` +
    `## Metadata\n` +
    `- Stars: ${meta.stars}\n` +
    `- Forks: ${meta.forks}\n` +
    `- Language: ${meta.language || 'unknown'}\n` +
    `- License: ${meta.license || 'unknown'}\n` +
    `- Updated: ${meta.updated_at}\n\n` +
    `## Tags\n${tags}\n\n` +
    `## Link\n${url}\n`;
}

async function main() {
  const issue = await ghApi(`repos/${REPO_SLUG}/issues/${ISSUE_NUMBER}`);
  const text = `${issue.title || ''}\n\n${issue.body || ''}`;
  const urls = extractGitHubRepoUrls(text);

  if (!urls.length) {
    await ghApi(`repos/${REPO_SLUG}/issues/${ISSUE_NUMBER}/comments`, {
      method: 'POST',
      body: { body: 'No GitHub repo links found in this issue.' }
    });
    return;
  }

  const items = readJsonl(TOOLS_PATH);
  const now = isoNow();

  const results = [];

  for (const u of urls) {
    const canonical = normalizeUrl(u);
    const { owner, repo } = parseGitHubRepo(canonical);
    const meta = await fetchGitHubRepoMeta(owner, repo);
    const enrich = await geminiEnrich({ url: canonical, title: meta.full_name, description: meta.description }).catch(() => null);

    const id = `tool_${sha1(canonical).slice(0, 12)}`;
    const idx = items.findIndex(it => it.id === id);

    const record = {
      id,
      url: canonical,
      canonical_url: canonical,
      title: meta.full_name,
      summary: enrich?.summary ?? meta.description ?? null,
      tags: (enrich?.tags?.length ? enrich.tags : ['dev/open-source']),
      language: 'en',
      source: {
        type: 'github',
        owner,
        repo,
        issue: Number(ISSUE_NUMBER)
      },
      status: 'enriched',
      created_at: idx >= 0 ? (items[idx].created_at || now) : now,
      updated_at: now,
      content: {
        highlights: enrich?.highlights ?? [],
        repo: canonical,
        metrics: {
          stars: meta.stars,
          forks: meta.forks,
          language: meta.language,
          license: meta.license,
          updated_at: meta.updated_at,
          pushed_at: meta.pushed_at
        }
      }
    };

    if (idx >= 0) items[idx] = { ...items[idx], ...record };
    else items.push(record);

    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.writeFileSync(path.join(NOTES_DIR, `${id}.md`), makeNotesMd({ meta, enrich, url: canonical }), 'utf8');

    results.push({ id, repo: meta.full_name, url: canonical, updated: idx >= 0 });
  }

  writeJsonl(TOOLS_PATH, items);

  const lines = results.map(r => `- ${r.repo} → ${r.id} ${r.updated ? '(updated)' : '(new)'}\n  ${r.url}`).join('\n');
  await ghApi(`repos/${REPO_SLUG}/issues/${ISSUE_NUMBER}/comments`, {
    method: 'POST',
    body: { body: `Saved to database:\n\n${lines}` }
  });

  // Close issue
  await ghApi(`repos/${REPO_SLUG}/issues/${ISSUE_NUMBER}`, {
    method: 'PATCH',
    body: { state: 'closed' }
  });
}

await main();
