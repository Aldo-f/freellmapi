import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';

export const importRouter = Router();

// Mapping from hermes auth.json credential pool names to freellmapi platform names
const PLATFORM_MAP: Record<string, string> = {
  gemini: 'google',
  openrouter: 'openrouter',
  nvidia: 'nvidia',
};

interface HermesCredential {
  id: string;
  label: string;
  auth_type: string;
  priority: number;
  source: string;
  access_token: string;
  last_status: string;
  base_url: string;
  request_count: number;
}

interface HermesAuthJson {
  version: number;
  providers: Record<string, unknown>;
  active_provider: string | null;
  updated_at: string;
  credential_pool: Record<string, HermesCredential[]>;
}

/**
 * POST /api/import/hermes
 * Import API keys from ~/.hermes/auth.json into the freellmapi database.
 * Only imports credentials from pools that map to supported platforms.
 */
importRouter.post('/hermes', (_req: Request, res: Response) => {
 // Check Docker mount first (/hermes/auth.json), then fallback to host path
 const dockerMountPath = '/hermes/auth.json';
 const hostPath = path.join(os.homedir(), '.hermes', 'auth.json');
 const hermesAuthPath = fs.existsSync(dockerMountPath) ? dockerMountPath : hostPath;

 // Check if auth.json exists
 if (!fs.existsSync(hermesAuthPath)) {
 res.status(404).json({
 error: {
 message: `Hermes auth.json not found at ${dockerMountPath} or ${hostPath}. Cannot import keys.`,
 },
 });
 return;
 }

  let hermesAuth: HermesAuthJson;
  try {
    const content = fs.readFileSync(hermesAuthPath, 'utf-8');
    hermesAuth = JSON.parse(content);
  } catch (err) {
    res.status(400).json({
      error: { message: `Failed to parse hermes auth.json: ${err}` },
    });
    return;
  }

  const pool = hermesAuth.credential_pool;
  if (!pool || typeof pool !== 'object') {
    res.status(400).json({
      error: { message: 'Invalid hermes auth.json: missing credential_pool' },
    });
    return;
  }

  const db = getDb();
  const results: Array<{
    platform: string;
    poolName: string;
    imported: number;
    skipped: number;
    errors: string[];
  }> = [];

  for (const [poolName, credentials] of Object.entries(pool)) {
    const platform = PLATFORM_MAP[poolName];
    if (!platform) {
      // Skip pools that don't map to a freellmapi platform
      continue;
    }

    if (!Array.isArray(credentials)) continue;

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const cred of credentials) {
      // Skip credentials without a valid access_token
      if (!cred.access_token || cred.access_token === '***') {
        skipped++;
        continue;
      }

      // Skip credentials with empty tokens
      if (cred.access_token.trim().length === 0) {
        skipped++;
        continue;
      }

      try {
        const { encrypted, iv, authTag } = encrypt(cred.access_token);
        const label = cred.label || `Hermes ${poolName} ${cred.id.slice(0, 6)}`;

        db.prepare(`
          INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
          VALUES (?, ?, ?, ?, ?, 'unknown', 1)
        `).run(platform, label, encrypted, iv, authTag);

        imported++;
      } catch (err) {
        errors.push(`Key ${cred.id}: ${err}`);
      }
    }

    results.push({ platform, poolName, imported, skipped, errors });
  }

  const totalImported = results.reduce((sum, r) => sum + r.imported, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);

  res.json({
    success: true,
    message: `Imported ${totalImported} keys, skipped ${totalSkipped} keys.`,
    details: results,
  });
});

/**
 * GET /api/import/mappings
 * Returns the mapping of hermes credential pools to freellmapi platforms.
 */
importRouter.get('/mappings', (_req: Request, res: Response) => {
  res.json({
    mappings: PLATFORM_MAP,
    unsupported_pools: getUnsupportedPools(),
  });
});

/**
 * GET /api/import/status
 * Returns which hermes credential pools would be imported (without importing).
 */
importRouter.get('/status', (_req: Request, res: Response) => {
  const hermesAuthPath = path.join(os.homedir(), '.hermes', 'auth.json');

  if (!fs.existsSync(hermesAuthPath)) {
    res.status(404).json({
      error: { message: `Hermes auth.json not found at ${hermesAuthPath}` },
    });
    return;
  }

  let hermesAuth: HermesAuthJson;
  try {
    const content = fs.readFileSync(hermesAuthPath, 'utf-8');
    hermesAuth = JSON.parse(content);
  } catch (err) {
    res.status(400).json({
      error: { message: `Failed to parse hermes auth.json: ${err}` },
    });
    return;
  }

  const pool = hermesAuth.credential_pool;
  const status: Record<string, { supported: boolean; platform: string | null; count: number }> = {};

  const allPoolNames = new Set([
    ...Object.keys(PLATFORM_MAP),
    ...getUnsupportedPools(),
  ]);

  for (const poolName of Object.keys(pool)) {
    allPoolNames.add(poolName);
  }

  for (const poolName of allPoolNames) {
    const credentials = pool[poolName] || [];
    const platform = PLATFORM_MAP[poolName];
    status[poolName] = {
      supported: !!platform,
      platform: platform || null,
      count: Array.isArray(credentials) ? credentials.length : 0,
    };
  }

  res.json({
    auth_json_path: hermesAuthPath,
    pools: status,
    total_supported: Object.values(status).filter((s) => s.supported).length,
    total_credentials: Object.values(status).reduce((sum, s) => sum + s.count, 0),
  });
});

function getUnsupportedPools(): string[] {
  // Pools in auth.json that don't have a mapping to freellmapi platforms
  return [
    'opencode-zen',
    'xai',
    'alibaba',
    'tencent-tokenhub',
    'google-gemini-cli',
    'ollama-cloud',
  ];
}