# PostSoma TG Data

Public data repository for PostSoma’s tool/link curation pipeline.

## Goals

- Store curated “useful tools” items in a durable, reusable format
- Enable automation later (TG inbox → ingest → dedupe → summarize → publish)
- Keep history/versioning (Git)

## Repo structure

- `data/tools.jsonl` — append-only item log (1 JSON object per line)
- `data/index.json` — derived index (optional, generated)
- `posts/` — published posts in Markdown (daily/weekly)
- `schemas/` — JSON Schemas for validation
- `docs/` — formatting rules and conventions

## Primary record format: JSONL

See:
- `schemas/tool-item.schema.json`
- `docs/FORMAT.md`

## License

TBD (recommend: CC BY 4.0 for content + MIT for code). Can be adjusted.
