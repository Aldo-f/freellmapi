import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { parseKeysFromFile, stripJsoncComments, stripTrailingCommas } from '../lib/key-parser.js';

export const keysRouter = Router();

const ALLOWED_EXTENSIONS = ['.txt', '.env', '.json', '.jsonc', '.md'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error('Unsupported file type'));
    }
    cb(null, true);
  },
});

// Active providers — must match providers/index.ts registrations + shared/types.ts Platform.
// Moonshot and MiniMax direct integrations were dropped in V4. HuggingFace
// was dropped in V4 and re-added in V13 via the router.huggingface.co route.
// SambaNova was dropped in V23 (free tier permanently retired).
const PLATFORMS = [
  'google', 'groq', 'cerebras', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'ovh', 'custom',
] as const;

// `key` is optional so keyless providers (Kilo's anonymous gateway) can be added
// without one; the handler enforces a non-empty key for everyone else.
const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().optional(),
  label: z.string().optional(),
});

const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
}).refine(data => data.enabled !== undefined || data.label !== undefined, {
  message: 'At least one of enabled or label must be provided',
});

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      baseUrl: row.base_url ?? null,
      status: row.status,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

// Add a key
keysRouter.post('/', (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, label } = parsed.data;
  const isKeyless = resolveProvider(platform)?.keyless === true;
  const rawKey = parsed.data.key?.trim() ?? '';

  if (!isKeyless && !rawKey) {
    res.status(400).json({ error: { message: 'key is required' } });
    return;
  }

  // Keyless providers (Kilo anon) store a sentinel so routing sees the platform
  // as configured; the provider omits the auth header on outgoing calls.
  const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;

  const db = getDb();

  // A keyless provider needs only one sentinel row — re-enable an existing one
  // instead of piling up duplicates each time the user clicks "Add".
  if (isKeyless) {
    const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);
      res.status(200).json({
        id: existing.id,
        platform,
        label: label ?? '',
        maskedKey: maskKey(keyToStore),
        status: 'unknown',
        enabled: true,
      });
      return;
    }
  }

  const { encrypted, iv, authTag } = encrypt(keyToStore);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, label ?? '', encrypted, iv, authTag);

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    label: label ?? '',
    maskedKey: maskKey(keyToStore),
    status: 'unknown',
    enabled: true,
  });
});

// ── Custom OpenAI-compatible providers (#117, #212) ───────────────────────
// User-configured endpoints (llama.cpp / LM Studio / vLLM / Ollama / any
// OpenAI-compatible base_url). Each DISTINCT base_url gets its own 'custom'
// api_keys row, and every registered model binds to its endpoint's key via
// models.key_id — so several custom providers coexist without overwriting
// each other (#212). Re-submitting an existing base_url updates its key/label;
// re-registering an existing model id re-binds it to the submitted endpoint.
const customProviderSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().min(1, 'model is required'),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
});

keysRouter.post('/custom', (req: Request, res: Response) => {
  const parsed = customProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const modelId = parsed.data.model.trim();
  const displayName = (parsed.data.displayName ?? modelId).trim();
  // Local servers often need no key; keep a sentinel so there's always a bearer.
  const rawKey = parsed.data.apiKey?.trim() || 'no-key';
  const label = parsed.data.label ?? 'Custom';

  const db = getDb();
  const upsert = db.transaction(() => {
    // One 'custom' key row PER ENDPOINT (matched on base_url). Re-submitting
    // the same endpoint updates its key/label; a new base_url gets its own
    // row instead of clobbering the previous provider. (#212)
    const existing = db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND base_url = ? LIMIT 1")
      .get(baseUrl) as { id: number } | undefined;
    let keyId: number;
    if (existing) {
      const { encrypted, iv, authTag } = encrypt(rawKey);
      db.prepare("UPDATE api_keys SET label = ?, encrypted_key = ?, iv = ?, auth_tag = ?, status = 'unknown', enabled = 1 WHERE id = ?")
        .run(label, encrypted, iv, authTag, existing.id);
      keyId = existing.id;
    } else {
      const { encrypted, iv, authTag } = encrypt(rawKey);
      const r = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
        VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)
      `).run(label, encrypted, iv, authTag, baseUrl);
      keyId = Number(r.lastInsertRowid);
    }

    // Register the model bound to THIS endpoint's key. Custom models carry no
    // rate limits and sort last in the intelligence preset (size_label tier).
    // Re-registering an existing model id re-binds it (model ids are unique
    // per platform, so one id can't live on two endpoints at once).
    db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, key_id)
      VALUES ('custom', ?, ?, 50, 50, 'Custom', NULL, NULL, NULL, NULL, '', NULL, 1, ?)
      ON CONFLICT(platform, model_id)
      DO UPDATE SET display_name = excluded.display_name, key_id = excluded.key_id, enabled = 1
    `).run(modelId, displayName, keyId);

    const modelRow = db.prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = ?").get(modelId) as { id: number };

    // Append to the fallback chain if not already present.
    const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelRow.id);
    if (!inChain) {
      const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelRow.id, max.m + 1);
    }

    return { keyId, modelDbId: modelRow.id };
  });

  const { keyId, modelDbId } = upsert();
  res.status(201).json({
    success: true,
    keyId,
    modelDbId,
    platform: 'custom',
    baseUrl,
    model: modelId,
    displayName,
    maskedKey: maskKey(rawKey),
  });
});

// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT platform FROM api_keys WHERE id = ?').get(id) as { platform: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    // Custom models exist only because POST /custom registered them alongside
    // their endpoint key (#117) — they can't route without it. Cascade away
    // the models bound to THIS endpoint (#212); other custom providers keep
    // theirs. Legacy rows (key_id NULL) are swept once no custom keys remain,
    // so they never linger in the fallback chain forever (#189).
    if (row.platform === 'custom') {
      db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom' AND key_id = ?)").run(id);
      db.prepare("DELETE FROM models WHERE platform = 'custom' AND key_id = ?").run(id);
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom'").get() as { n: number };
      if (remaining.n === 0) {
        db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
        db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
      }
    }
  });
  remove();

  res.json({ success: true });
});

// Toggle all keys for a platform
keysRouter.patch('/platform/:platform', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE platform = ?').run(enabled ? 1 : 0, platform);

  res.json({ success: true, enabled, updatedKeys: result.changes });
});

keysRouter.post('/import', (req: Request, res: Response, next: any) => {
  upload.single('file')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: { message: 'File too large. Maximum size is 5MB' } });
        return;
      }
      if (err.message?.includes('Unsupported file type')) {
        res.status(400).json({ error: { message: err.message } });
        return;
      }
      next(err);
      return;
    }

    try {
      if (!req.file) {
        res.status(400).json({ error: { message: 'No file uploaded' } });
        return;
      }

      const content = req.file.buffer.toString('utf-8');
      if (!content || content.trim().length === 0) {
        res.status(400).json({ error: { message: 'File contains no data' } });
        return;
      }

      const isJsonOrJsonc = /\.jsonc?$/i.test(req.file.originalname);
      if (isJsonOrJsonc) {
        try {
          JSON.parse(stripTrailingCommas(stripJsoncComments(content)));
        } catch {
          res.status(400).json({ error: { message: 'Invalid JSON format' } });
          return;
        }
      }

      const result = parseKeysFromFile(content, req.file.originalname);

      const imported: Array<{ keyName: string; platform: string }> = [];
      const errors: Array<{ key: string; error: string }> = [];
      const unrecognizedSkipped: string[] = [];
      const db = getDb();

      for (const key of result.keys) {
        if (!key.platform || key.platform === 'unknown') {
          unrecognizedSkipped.push(key.rawKey);
          continue;
        }

        // rawKey is "KEY=VALUE" — split so we store only the value encrypted
        // and use the key name as the human-readable label.
        const eqIdx = key.rawKey.indexOf('=');
        const keyName = eqIdx >= 0 ? key.rawKey.slice(0, eqIdx) : key.rawKey;
        const keyValue = eqIdx >= 0 ? key.rawKey.slice(eqIdx + 1) : '';

        if (!keyValue) {
          errors.push({ key: keyName, error: 'No key value found' });
          continue;
        }

        try {
          const { encrypted, iv, authTag } = encrypt(keyValue);

          const stmt = db.prepare(`
            INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url, status, enabled)
            VALUES (?, ?, ?, ?, ?, ?, 'unknown', 1)
          `);
          stmt.run(key.platform, keyName, encrypted, iv, authTag, '');

          imported.push({ keyName, platform: key.platform || 'unknown' });
        } catch (insertErr) {
          errors.push({ key: keyName, error: (insertErr as Error).message });
        }
      }

      res.json({
        imported: imported.length,
        skipped: [...result.skipped, ...unrecognizedSkipped],
        errors,
        total: result.keys.length + result.skipped.length,
      });
    } catch (handlerErr: any) {
      if (handlerErr.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: { message: 'File too large. Maximum size is 5MB' } });
        return;
      }
      if (handlerErr.message?.includes('Unsupported file type')) {
        res.status(400).json({ error: { message: handlerErr.message } });
        return;
      }
      next(handlerErr);
    }
  });
});

// Preview keys from uploaded files (no DB storage, no encryption)
keysRouter.post('/preview', (req: Request, res: Response, next: any) => {
  upload.array('files', 10)(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: { message: 'File too large. Maximum size is 5MB' } });
        return;
      }
      if (err.message?.includes('Unsupported file type')) {
        res.status(400).json({ error: { message: err.message } });
        return;
      }
      next(err);
      return;
    }

    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        res.status(400).json({ error: { message: 'No files uploaded' } });
        return;
      }

      const allKeys: Array<{ keyName: string; keyValue: string; detectedPlatform: string | null; prefix: string }> = [];
      const allSkipped: string[] = [];

      for (const file of files) {
        const content = file.buffer.toString('utf-8');
        if (!content || content.trim().length === 0) {
          res.status(400).json({ error: { message: 'File contains no data' } });
          return;
        }

        const isJsonOrJsonc = /\.jsonc?$/i.test(file.originalname);
        if (isJsonOrJsonc) {
          try {
            JSON.parse(stripTrailingCommas(stripJsoncComments(content)));
          } catch {
            res.status(400).json({ error: { message: 'Invalid JSON format' } });
            return;
          }
        }

        const result = parseKeysFromFile(content, file.originalname);

        for (const key of result.keys) {
          const eqIdx = key.rawKey.indexOf('=');
          const keyName = eqIdx >= 0 ? key.rawKey.slice(0, eqIdx) : key.rawKey;
          const keyValue = eqIdx >= 0 ? key.rawKey.slice(eqIdx + 1) : '';
          allKeys.push({
            keyName,
            keyValue,
            detectedPlatform: key.platform,
            prefix: key.prefix,
          });
        }

        allSkipped.push(...result.skipped);
      }

      res.json({ keys: allKeys, total: allKeys.length, skipped: allSkipped });
    } catch (handlerErr: any) {
      if (handlerErr.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: { message: 'File too large. Maximum size is 5MB' } });
        return;
      }
      if (handlerErr.message?.includes('Unsupported file type')) {
        res.status(400).json({ error: { message: handlerErr.message } });
        return;
      }
      throw handlerErr;
    }
  });
});

// Import selected keys from preview table (encrypt + insert to DB)
keysRouter.post('/import-selected', (req: Request, res: Response) => {
  try {
    const { keys } = req.body;
    if (!Array.isArray(keys)) {
      res.status(400).json({ error: { message: 'keys must be an array' } });
      return;
    }

    let imported = 0;
    const errors: Array<{ key: string; error: string }> = [];
    const db = getDb();

    for (const key of keys) {
      const platformParse = z.enum(PLATFORMS).safeParse(key.platform);
      if (!platformParse.success) {
        res.status(400).json({ error: { message: `Invalid platform: ${key.platform}` } });
        return;
      }

      try {
        const keyValue = key.keyValue ?? '';
        if (!keyValue) {
          errors.push({ key: key.keyName, error: 'keyValue must be at least 1 character' });
          continue;
        }

        const actualValue = keyValue.trim();
        const { encrypted, iv, authTag } = encrypt(actualValue);

        const stmt = db.prepare(`
          INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url, status, enabled)
          VALUES (?, ?, ?, ?, ?, ?, 'unknown', 1)
        `);
        stmt.run(platformParse.data, key.keyName ?? '', encrypted, iv, authTag, '');
        imported++;
      } catch (insertErr) {
        errors.push({ key: key.keyName, error: (insertErr as Error).message });
      }
    }

    res.json({
      imported,
      skipped: [],
      errors,
      total: keys.length,
    });
  } catch (err) {
    res.status(500).json({ error: { message: (err as Error).message } });
  }
});

keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { enabled, label } = parsed.data;
  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(enabled ? 1 : 0);
  }
  if (label !== undefined) {
    updates.push('label = ?');
    values.push(label);
  }

  values.push(id);

  const db = getDb();
  const result = db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const response: Record<string, unknown> = { success: true };
  if (enabled !== undefined) response.enabled = enabled;
  if (label !== undefined) response.label = label;
  res.json(response);
});
