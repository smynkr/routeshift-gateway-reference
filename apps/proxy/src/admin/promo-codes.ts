// apps/proxy/src/admin/promo-codes.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';

export async function handleListPromoCodes(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, code, plan, credits_cents, max_uses, uses_count, expires_at, created_at
     FROM promo_codes
     ORDER BY created_at DESC`,
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rows));
}

export async function handleCreatePromoCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: any;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }

  if (!body.code || typeof body.code !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'code is required' } }));
    return;
  }

  const id = `promo_${randomUUID().replace(/-/g, '')}`;
  const pool = getPool();

  try {
    await pool.query(
      `INSERT INTO promo_codes (id, code, plan, credits_cents, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        body.code.trim().toUpperCase(),
        body.plan ?? 'starter',
        body.credits_cents ?? 0,
        body.max_uses ?? 1,
        body.expires_at ?? null,
      ],
    );
  } catch (err: any) {
    if (err.code === '23505') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Promo code already exists' } }));
      return;
    }
    throw err;
  }

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id, code: body.code.trim().toUpperCase() }));
}

export async function handleDeletePromoCode(req: IncomingMessage, res: ServerResponse, promoId: string): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    'DELETE FROM promo_codes WHERE id = $1',
    [promoId],
  );

  if (!rowCount) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Promo code not found' } }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ deleted: true }));
}
