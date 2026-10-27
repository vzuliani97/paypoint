import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface PartnerCredentials {
  id: string;
  name: string;
  posId: string;
  hmacSecret: string;
  allowedIps: string[];
}

interface PartnerRow {
  id: string;
  name: string;
  pos_id: string;
  hmac_secret: string;
  allowed_ips: string[];
}

@Injectable()
export class PartnersService {
  constructor(private readonly db: DatabaseService) {}

  async findActiveByKeyId(apiKeyId: string): Promise<PartnerCredentials | null> {
    const { rows } = await this.db.query<PartnerRow>(
      `SELECT id, name, pos_id, hmac_secret, allowed_ips
       FROM partners
       WHERE api_key_id = $1 AND active`,
      [apiKeyId],
    );
    const row = rows[0];

    return row
      ? { id: row.id, name: row.name, posId: row.pos_id, hmacSecret: row.hmac_secret, allowedIps: row.allowed_ips }
      : null;
  }
}
