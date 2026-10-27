import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { AppConfig } from '../config';

const DEMO_POS_NAME = 'Tienda Centro';
const DEMO_INITIAL_BALANCE = 100_000;

/**
 * Inserts demo data for local runs. Safe to run on every start: existing rows are left alone.
 */
export async function seedDemoData(pool: Pool, config: AppConfig): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO products (code, name, type, min_amount, max_amount) VALUES
        ('RECARGA_MOVILCO', 'Recarga MovilCo', 'TOPUP', 1000, 100000),
        ('RECARGA_TELERED', 'Recarga TeleRed', 'TOPUP', 1000, 100000),
        ('GIFT_JUEGAYA_20K', 'Gift card JuegaYa $20.000', 'GIFT_CARD', 20000, 20000)
      ON CONFLICT (code) DO NOTHING
    `);

    const insertedPos = await client.query<{ id: string }>(
      `INSERT INTO points_of_sale (name, balance) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING
       RETURNING id`,
      [DEMO_POS_NAME, DEMO_INITIAL_BALANCE],
    );

    // Only a newly created POS gets its opening-balance ledger entry.
    if (insertedPos.rowCount === 1) {
      await client.query(
        `INSERT INTO balance_movements (pos_id, type, amount, balance_after, note)
         VALUES ($1, 'CREDIT', $2, $2, 'Saldo inicial')`,
        [insertedPos.rows[0].id, DEMO_INITIAL_BALANCE],
      );
    }

    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM points_of_sale WHERE name = $1',
      [DEMO_POS_NAME],
    );
    const posId = rows[0].id;
    const passwordHash = await bcrypt.hash(config.DEMO_PASSWORD, 10);

    await client.query(
      `INSERT INTO users (email, password_hash, role, pos_id) VALUES
         ('admin@paypoint.local', $1, 'ADMIN', NULL),
         ('cajero@paypoint.local', $1, 'CASHIER', $2)
       ON CONFLICT (email) DO NOTHING`,
      [passwordHash, posId],
    );

    const allowedIps = config.DEMO_PARTNER_ALLOWED_IPS.split(',').map((ip) => ip.trim()).filter(Boolean);

    await client.query(
      `INSERT INTO partners (name, api_key_id, hmac_secret, pos_id, allowed_ips)
       VALUES ('Integrador Demo', 'pk_demo_tienda_centro', $1, $2, $3)
       ON CONFLICT (api_key_id) DO NOTHING`,
      [config.DEMO_PARTNER_SECRET, posId, allowedIps],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
