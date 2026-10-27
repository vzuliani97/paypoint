import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { AppError } from '../common/app-error';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { AuthUser, JwtPayload, Role } from './auth.types';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  pos_id: string | null;
}

// Compared against when the email does not exist, so both cases take about the same time.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(email: string, password: string) {
    const { rows } = await this.db.query<UserRow>(
      'SELECT id, email, password_hash, role, pos_id FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    const user = rows[0];
    const passwordMatches = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);

    // Same error for unknown email and wrong password: do not reveal which accounts exist.
    if (!user || !passwordMatches) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const authUser: AuthUser = { id: user.id, email: user.email, role: user.role, posId: user.pos_id };
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role, posId: user.pos_id };

    return {
      accessToken: await this.jwt.signAsync(payload),
      expiresIn: this.config.JWT_EXPIRES_IN_SECONDS,
      user: authUser,
    };
  }
}
