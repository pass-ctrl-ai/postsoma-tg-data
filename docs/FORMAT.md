# PostSoma data + output format

This doc defines the canonical storage format (`tools.jsonl`) and recommended output formats.

## 1) Canonical storage: `data/tools.jsonl`

- Append-only log: one JSON object per line
- `id` is stable and unique (preferred: url-normalized + sha1)
- Keep **raw** fields + **derived** fields separated

### Minimal required fields

```json
{
  "id": "tool_2f3c...",
  "url": "https://example.com",
  "title": "Example Tool",
  "created_at": "2026-02-10T08:16:00Z",
  "source": {"type": "manual"},
  "status": "inbox"
}
```

### Full item (recommended)

```json
{
  "id": "tool_2f3c...",
  "url": "https://example.com",
  "canonical_url": "https://example.com",
  "title": "Example Tool",
  "summary": "One-sentence description.",
  "tags": ["ai", "productivity"],
  "language": "en",

  "source": {
    "type": "tg",
    "chat_id": "-1001234567890",
    "message_id": "42",
    "author": "777"
  },

  "status": "shortlisted",
  "created_at": "2026-02-10T08:16:00Z",
  "updated_at": "2026-02-10T08:20:00Z",
  "published": {
    "channel": "telegram",
    "post_id": null,
    "posted_at": null
  },

  "content": {
    "highlights": ["Key feature A", "Key feature B"],
    "pricing": "free|paid|freemium|unknown",
    "platform": ["web"],
    "open_source": "unknown",
    "repo": null
  },

  "metrics": {
    "score": 0,
    "saved_count": 1
  },

  "raw": {
    "text": null
  }
}
```

### Status lifecycle

- `inbox` → `shortlisted` → `scheduled` → `posted`
- Alternative terminal: `dropped`

## 2) Output formats

### 2.1 Telegram post (default)

Principles:
- 1 tool per post (early stage), or 3–5 tools per daily digest
- Keep **title + link + 2–3 bullets + tags**

**Single-tool template**

```
【{title}】
{summary}

• 亮点：{highlight1}；{highlight2}
• 适合：{use_case}
• 标签：#{tag1} #{tag2}

链接：{url}
```

**Digest template**

```
今日工具清单（{date}）

1) {title1}
- {one-liner1}
- {url1}

2) {title2}
- {one-liner2}
- {url2}

#tools #{top_tag}
```

### 2.2 Markdown (repo posts)

Store posts in `posts/YYYY-MM-DD.md`.

```md
# {date} Tools

## 1) {title}
- Link: {url}
- Summary: {summary}
- Tags: {tags}
```

## 3) Dedupe rules (v1)

- Normalize URL:
  - strip UTM params
  - force https when possible
  - remove trailing slash (except root)
- `id = sha1(canonical_url)`

## 4) What we will automate later

- TG inbox ingestion (getUpdates)
- URL extraction + title fetch
- Optional LLM summarization + tags
- Scheduled publish to TG channel
