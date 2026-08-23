// Source document fetching + normalization (feature 001-model-sources-crud).
//
// A source `location` serves a JSON model list. Two formats accepted:
//   custom : {"models":[{"model_id","display_name","context_window","supports_vision"}]}
//   OpenAI : {"data":[{"id","owned_by?"}]}
//
// Deliberate bounds (spec): 15s timeout, 5 MB body cap, max 5,000 models.

import type { NormalizedModelEntry } from './model-sources.js';

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_MODELS = 5_000;

export class SourceFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceFetchError';
  }
}

/** Fetch + parse + normalize a source document. Throws SourceFetchError on
 *  any failure (network, size, schema) with an operator-safe message. */
export async function fetchSourceModels(location: string): Promise<NormalizedModelEntry[]> {
  let res: Response;
  try {
    res = await fetch(location, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new SourceFetchError(
      `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new SourceFetchError(`source returned HTTP ${res.status}`);
  }
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) {
    throw new SourceFetchError(`document too large (${len} bytes > ${MAX_BODY_BYTES})`);
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new SourceFetchError(`document too large (> ${MAX_BODY_BYTES} bytes)`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new SourceFetchError('document is not valid JSON');
  }

  const entries = normalizeDocument(doc);
  if (entries.length > MAX_MODELS) {
    throw new SourceFetchError(`document lists ${entries.length} models (max ${MAX_MODELS})`);
  }
  return entries;
}

function normalizeDocument(doc: unknown): NormalizedModelEntry[] {
  if (doc === null || typeof doc !== 'object') {
    throw new SourceFetchError('document root is not an object');
  }
  const record = doc as Record<string, unknown>;

  if (Array.isArray(record.models)) {
    return record.models.map(normalizeCustomModel);
  }
  if (Array.isArray(record.data)) {
    return record.data.map(normalizeOpenAiModel);
  }
  throw new SourceFetchError('document has neither "models" nor "data" array');
}

function normalizeCustomModel(raw: unknown): NormalizedModelEntry {
  if (raw === null || typeof raw !== 'object') {
    throw new SourceFetchError('models[] entry is not an object');
  }
  const r = raw as Record<string, unknown>;
  const modelId = typeof r.model_id === 'string' ? sanitizeId(r.model_id) : '';
  if (!modelId) throw new SourceFetchError('models[] entry missing valid model_id');
  return {
    model_id: modelId,
    display_name: typeof r.display_name === 'string' && r.display_name.trim()
      ? r.display_name.trim()
      : modelId,
    context_window: typeof r.context_window === 'number' ? Math.floor(r.context_window) : null,
    supports_vision: r.supports_vision === true,
  };
}

function normalizeOpenAiModel(raw: unknown): NormalizedModelEntry {
  if (raw === null || typeof raw !== 'object') {
    throw new SourceFetchError('data[] entry is not an object');
  }
  const r = raw as Record<string, unknown>;
  const modelId = typeof r.id === 'string' ? sanitizeId(r.id) : '';
  if (!modelId) throw new SourceFetchError('data[] entry missing valid id');
  return {
    model_id: modelId,
    display_name: modelId,
    context_window: null,
    supports_vision: false,
  };
}

/** Model ids become part of routing lookups; keep them to a safe charset. */
function sanitizeId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 200) return '';
  if (!/^[A-Za-z0-9._:\-\/]+$/.test(trimmed)) return '';
  return trimmed;
}
