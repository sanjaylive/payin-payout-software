import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { generateToken } from '@pay2all/auth';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';

const ISSUER = 'pay2all';
const ACCESS_AUDIENCE = 'pay2all-dashboard';
const MFA_AUDIENCE = 'pay2all-mfa-challenge';
export const MFA_CHALLENGE_TTL_SECONDS = 300;

export interface AccessClaims {
  sub: string;
  sid: string;
  org: string;
  /** Restricted session (MFA enrollment pending). */
  rst: boolean;
  typ: 'access';
}

export interface MfaChallengeClaims {
  sub: string;
  org: string;
  jti: string;
  typ: 'mfa';
}

/**
 * Signs/verifies JWTs. Access and MFA-challenge tokens use different audiences and a `typ` claim, so
 * one can never be replayed as the other. Algorithm is pinned to HS256 on verify.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ApiConfig,
  ) {}

  get accessTtlSeconds(): number {
    return this.config.env.JWT_ACCESS_TTL_SECONDS;
  }

  signAccess(claims: Omit<AccessClaims, 'typ'>): Promise<string> {
    return this.jwt.signAsync({ ...claims, typ: 'access' } satisfies AccessClaims, {
      secret: this.config.env.JWT_ACCESS_SECRET,
      algorithm: 'HS256',
      expiresIn: this.accessTtlSeconds,
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
    });
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const claims = await this.verify<AccessClaims>(token, ACCESS_AUDIENCE);
    if (claims.typ !== 'access' || !claims.sid || !claims.sub || !claims.org) {
      throw new AppError(ErrorCode.UNAUTHORIZED);
    }
    return claims;
  }

  signMfaChallenge(userId: string, organizationId: string): Promise<{ token: string; jti: string }> {
    const jti = generateToken(16);
    return this.jwt
      .signAsync({ sub: userId, org: organizationId, jti, typ: 'mfa' } satisfies MfaChallengeClaims, {
        secret: this.config.env.JWT_ACCESS_SECRET,
        algorithm: 'HS256',
        expiresIn: MFA_CHALLENGE_TTL_SECONDS,
        issuer: ISSUER,
        audience: MFA_AUDIENCE,
      })
      .then((token) => ({ token, jti }));
  }

  async verifyMfaChallenge(token: string): Promise<MfaChallengeClaims> {
    const claims = await this.verify<MfaChallengeClaims>(token, MFA_AUDIENCE);
    if (claims.typ !== 'mfa' || !claims.jti) throw new AppError(ErrorCode.UNAUTHORIZED);
    return claims;
  }

  private async verify<T extends object>(token: string, audience: string): Promise<T> {
    try {
      return await this.jwt.verifyAsync<T>(token, {
        secret: this.config.env.JWT_ACCESS_SECRET,
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience,
      });
    } catch {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid or expired token');
    }
  }
}
