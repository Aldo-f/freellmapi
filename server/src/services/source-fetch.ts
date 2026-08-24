// Source document fetching + normalization (feature 001-model-sources-crud).
//
// A source `location` serves a JSON model list. Two formats accepted:
//   custom : {"models":[{"model_id","display_name","context_window","supports_vision"}]}
//   OpenAI : {"data":[{"id","owned_by?"}]}
//
// Deliberate bounds (spec): 15s timeout, 5 MB body cap, max 5,000 models.
// Feature 002 adds catalog sources (models.dev api.json shape) with their own
// generous caps: the live document is ~4 MB / thousands of models.

import type { NormalizedModelEntry } from './model-sources.js';

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_MODELS = 5_000;
export const CATALOG_MAX_BODY_BYTES = 20 * 1024 * 1024;
export const CATALOG_MAX_MODELS = 25_000;

/** Raw per-model metadata as found in a catalog document (all optional). */
export interface CatalogMetadata {
  cost_input: number | null;
  cost_output: number | null;
  context_limit: number | null;
  output_limit: number | null;
  tool_call: boolean | null;
  structured_output: boolean | null;
  reasoning: boolean | null;
  modalities_input: string[];
  modalities_output: string[];
  open_weights: boolean | null;
}

export interface CatalogEntry {
  platform: string;          // models.dev provider slug, verbatim
  model_id: string;
  display_name: string;
  context_window: number | null;
  supports_vision: boolean;
  metadata: CatalogMetadata;
}

export class SourceFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceFetchError';
  }
}

/** Shared fetch+parse with caller-chosen bounds. */
async function fetchJsonDocument(
  location: string,
  maxBodyBytes: number,
): Promise<unknown> {
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
  if (len > maxBodyBytes) {
    throw new SourceFetchError(`document too large (${len} bytes > ${maxBodyBytes})`);
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBodyBytes) {
    throw new SourceFetchError(`document too large (> ${maxBodyBytes} bytes)`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceFetchError('document is not valid JSON');
  }
}

/** Fetch + parse + normalize a source document. Throws SourceFetchError on
 *  any failure (network, size, schema) with an operator-safe message. */
export async function fetchSourceModels(location: string): Promise<NormalizedModelEntry[]> {
  const doc = await fetchJsonDocument(location, MAX_BODY_BYTES);

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


// ── Feature 002: catalog documents (models.dev api.json shape) ──────────────

function optBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function optNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function modalityList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : ['text'];
}

function toCatalogMetadata(raw: Record<string, unknown>): CatalogMetadata {
  const limit = (raw.limit ?? {}) as Record<string, unknown>;
  const cost = (raw.cost ?? {}) as Record<string, unknown>;
  const modalities = (raw.modalities ?? {}) as Record<string, unknown>;
  return {
    cost_input: optNum(cost.input),
    cost_output: optNum(cost.output),
    context_limit: optNum(limit.context),
    output_limit: optNum(limit.output),
    tool_call: optBool(raw.tool_call),
    structured_output: optBool(raw.structured_output),
    reasoning: optBool(raw.reasoning),
    modalities_input: modalityList(modalities.input),
    modalities_output: modalityList(modalities.output),
    open_weights: optBool(raw.open_weights),
  };
}

function slugOk(slug: string): boolean {
  return /^[A-Za-z0-9._\-]{1,64}$/.test(slug);
}

/** Fetch + parse a models.dev-style catalog document into entries carrying
 *  full metadata. Caps are the generous catalog ones. */
export async function fetchCatalogDocument(location: string): Promise<CatalogEntry[]> {
  const doc = await fetchJsonDocument(location, CATALOG_MAX_BODY_BYTES);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new SourceFetchError('catalog root is not an object');
  }
  const entries: CatalogEntry[] = [];
  for (const [slug, providerRaw] of Object.entries(doc as Record<string, unknown>)) {
    if (!slugOk(slug)) continue;
    if (providerRaw === null || typeof providerRaw !== 'object') continue;
    const models = (providerRaw as Record<string, unknown>).models;
    if (models === null || typeof models !== 'object') continue;
    for (const [modelId, modelRaw] of Object.entries(models as Record<string, unknown>)) {
      if (modelRaw === null || typeof modelRaw !== 'object') continue;
      const cleanId = sanitizeId(modelId);
      if (!cleanId) continue;
      const r = modelRaw as Record<string, unknown>;
      const metadata = toCatalogMetadata(r);
      entries.push({
        platform: slug,
        model_id: cleanId,
        display_name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : cleanId,
        context_window: metadata.context_limit,
        supports_vision: metadata.modalities_input.includes('image'),
        metadata,
      });
    }
  }
  if (entries.length > CATALOG_MAX_MODELS) {
    throw new SourceFetchError(
      `catalog lists ${entries.length} models (max ${CATALOG_MAX_MODELS})`,
    );
  }
  return entries;
}
