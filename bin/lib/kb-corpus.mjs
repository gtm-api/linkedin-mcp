// Shared KB corpus loader: frontmatter parsing + heading-boundary chunking.
// Consumers: bin/build-kb-index.mjs (bundled BM25 index) and
// bin/vectorize-kb.mjs (embed + upsert into Vectorize). Keep chunking identical
// on both paths - RRF fusion in the worker dedupes by article+section.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const MAX_CHUNK_CHARS = 1800;

export function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      meta[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }
  return { meta, body: raw.slice(m[0].length) };
}

export function splitChunks(body) {
  const lines = body.split('\n');
  const sections = [];
  let current = { section: 'Intro', text: [] };
  for (const line of lines) {
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) {
      sections.push(current);
      current = { section: h[1].trim(), text: [] };
    } else {
      current.text.push(line);
    }
  }
  sections.push(current);

  const chunks = [];
  for (const { section, text } of sections) {
    const joined = text.join('\n').trim();
    if (!joined) continue;
    let buf = '';
    for (const para of joined.split(/\n\n+/)) {
      if (buf && buf.length + para.length + 2 > MAX_CHUNK_CHARS) {
        chunks.push({ section, body: buf.trim() });
        buf = '';
      }
      buf += (buf ? '\n\n' : '') + para;
    }
    if (buf.trim()) chunks.push({ section, body: buf.trim() });
  }
  return chunks;
}

function loadDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f.toLowerCase() !== 'readme.md')
    .map((f) => ({ file: join(dir, f), raw: readFileSync(join(dir, f), 'utf8') }));
}

/** Load {articles, chunks} from a KB dir ({articles,qa}/*.md; _reference skipped). */
export function loadCorpus(kbDir) {
  const files = [...loadDir(join(kbDir, 'articles')), ...loadDir(join(kbDir, 'qa'))];
  const articles = [];
  const chunks = [];
  const seen = new Set();

  for (const { file, raw } of files) {
    const { meta, body } = parseFrontmatter(raw);
    const id = String(meta.id ?? basename(file, '.md'));
    if (seen.has(id)) throw new Error(`duplicate article id '${id}' (${file})`);
    seen.add(id);
    const title = String(meta.title ?? body.match(/^#\s+(.*)$/m)?.[1] ?? id);
    articles.push({
      id,
      title,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      help_url: meta.help_url ? String(meta.help_url) : null,
      updated_at: meta.updated_at ? String(meta.updated_at) : null,
      content: body.trim(),
    });
    for (const { section, body: chunkBody } of splitChunks(body)) {
      chunks.push({ article_id: id, section, head: `${title}: ${section}`, body: chunkBody });
    }
  }
  return { articles, chunks };
}
