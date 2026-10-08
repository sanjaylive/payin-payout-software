import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ErrorCode } from '@pay2all/types';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  idSchema,
  loginSchema,
  mfaVerifySchema,
  passkeyChallengeSchema,
  passkeyRegisterSchema,
  passkeyRenameSchema,
  regenerateRecoveryCodesSchema,
  stepUpSchema,
  resetPasswordSchema,
  totpDisableSchema,
  totpEnableSchema,
} from '@pay2all/validation';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiConfig } from '../../config/api-config';
import { AllowRestrictedSession, AuthenticatedOnly, CurrentActor, Public, RequireStepUp } from '../access/decorators';
import { AuditService } from '../audit/audit.service';
import type { Actor } from './actor';
import { assertCsrf, clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './auth.cookies';
import { AuthService } from './auth.service';
import { RATE_LIMITS } from './auth.util';
import { MeService } from './me.service';
import { MfaService } from './mfa.service';
import { PasskeyService } from './passkey.service';
import { PasswordService } from './password.service';
import { type IssuedSession, SessionService } from './session.service';
import { StepUpService } from './step-up.service';
import { TokenService } from './token.service';

function presentSession(s: IssuedSession) {
  return {
    status: s.restricted ? 'MFA_ENROLLMENT_REQUIRED' : 'AUTHENTICATED',
    access_token: s.accessToken,
    token_type: 'Bearer',
    expires_in: s.expiresIn,
  };
}

@ApiTags('Auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly passwords: PasswordService,
    private readonly me: MeService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly config: ApiConfig,
    private readonly passkeys: PasskeyService,
    private readonly stepUp: StepUpService,
    private readonly tokens: TokenService,
  ) {}

  /** Adding a second (or further) factor to an account is sensitive; the very first enrollment isn't gated. */
  private async assertMayAddFactor(actor: Actor) {
    if (actor.restricted) return;
    if ((await this.mfa.status(actor.userId)).enabled) await this.stepUp.assertFresh(actor);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email or mobile + password' })
  @ApiZodBody(loginSchema)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.output<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body.identifier, body.password, body.location);
    if (result.kind === 'mfa_required') {
      return { status: 'MFA_REQUIRED', mfa_token: result.mfaToken, expires_in: result.expiresIn, mfa_methods: result.methods };
    }
    setRefreshCookie(res, this.config, result.session.refreshToken);
    return presentSession(result.session);
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete sign-in with a TOTP code' })
  @ApiZodBody(mfaVerifySchema)
  async verifyMfa(
    @Body(new ZodValidationPipe(mfaVerifySchema)) body: z.output<typeof mfaVerifySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.completeMfaLogin(
      body.mfa_token,
      (userId, challengeId) =>
        body.passkey
          ? this.passkeys.verifyAssertion(userId, 'login', `${userId}:${challengeId}`, body.passkey)
          : body.recovery_code
            ? this.mfa.verifyRecoveryCode(userId, body.recovery_code)
            : this.mfa.verifyForLogin(userId, body.code!),
      body.location,
    );
    setRefreshCookie(res, this.config, session.refreshToken);
    return presentSession(session);
  }

  @Public()
  @Post('mfa/passkey/options')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign-in second step: get a passkey challenge for the pending sign-in' })
  @ApiZodBody(passkeyChallengeSchema)
  async passkeyLoginOptions(@Body(new ZodValidationPipe(passkeyChallengeSchema)) body: z.output<typeof passkeyChallengeSchema>) {
    await this.rateLimit.enforce(RATE_LIMITS.mfaByIp, RequestContextStore.get()?.ipAddress ?? 'unknown');
    const claims = await this.tokens.verifyMfaChallenge(body.mfa_token);
    return this.passkeys.authenticationOptions(claims.sub, 'login', `${claims.sub}:${claims.jti}`);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh token cookie and issue a new access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertCsrf(req, this.config);
    await this.rateLimit.enforce(RATE_LIMITS.refreshByIp, RequestContextStore.get()?.ipAddress ?? 'unknown');
    const token = readRefreshCookie(req);
    if (!token) throw new AppError(ErrorCode.UNAUTHORIZED);
    try {
      const session = await this.sessions.rotate(token);
      setRefreshCookie(res, this.config, session.refreshToken);
      return presentSession(session);
    } catch (err) {
      clearRefreshCookie(res, this.config);
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign out of the current session (cookie-identified)' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertCsrf(req, this.config);
    const token = readRefreshCookie(req);
    clearRefreshCookie(res, this.config);
    const sessionId = token ? await this.sessions.findSessionIdByRefreshToken(token) : null;
    if (sessionId && (await this.sessions.revoke(sessionId, 'LOGOUT'))) {
      await this.audit.record({ action: 'auth.logout', resourceType: 'session', resourceId: sessionId, organizationId: null, actor: { type: 'USER', id: null } });
    }
    return { logged_out: true };
  }

  @AuthenticatedOnly()
  @AllowRestrictedSession()
  @Post('logout-all')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out of every session for the current user' })
  async logoutAll(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    const count = await this.sessions.revokeAllForUser(actor.userId, 'LOGOUT_ALL');
    clearRefreshCookie(res, this.config);
    await this.audit.record({ action: 'auth.logout_all', resourceType: 'user', resourceId: actor.userId, metadata: { sessions: count } });
    return { revoked_sessions: count };
  }

  @AuthenticatedOnly()
  @AllowRestrictedSession()
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current user, active organization, roles and permissions' })
  getMe(@CurrentActor() actor: Actor) {
    return this.me.get(actor);
  }

  @AuthenticatedOnly()
  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions for the current user' })
  async listSessions(@CurrentActor() actor: Actor) {
    const sessions = await this.sessions.listActive(actor.userId);
    return sessions.map((s) => ({
      id: s.id,
      current: s.id === actor.sessionId,
      ip_address: s.ipAddress,
      user_agent: s.userAgent,
      created_at: s.createdAt,
      last_used_at: s.lastUsedAt,
      expires_at: s.expiresAt,
      mfa_verified: Boolean(s.mfaVerifiedAt),
    }));
  }

  @AuthenticatedOnly()
  @Delete('sessions/:sessionId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one of your sessions' })
  async revokeSession(
    @CurrentActor() actor: Actor,
    @Param('sessionId', new ZodValidationPipe(idSchema('ses'))) sessionId: string,
  ) {
    const owned = (await this.sessions.listActive(actor.userId)).some((s) => s.id === sessionId);
    if (!owned) throw new AppError(ErrorCode.NOT_FOUND, 'Session not found');
    await this.sessions.revoke(sessionId, 'USER_REVOKED');
    await this.audit.record({ action: 'auth.session.revoked', resourceType: 'session', resourceId: sessionId });
    return { revoked: true };
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request a password reset link (always succeeds)' })
  @ApiZodBody(forgotPasswordSchema)
  async forgot(@Body(new ZodValidationPipe(forgotPasswordSchema)) body: z.output<typeof forgotPasswordSchema>) {
    await this.passwords.requestReset(body.identifier);
    return { message: 'If an account exists for that identifier, a reset link has been sent.' };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a new password using a reset or invitation token' })
  @ApiZodBody(resetPasswordSchema)
  async reset(@Body(new ZodValidationPipe(resetPasswordSchema)) body: z.output<typeof resetPasswordSchema>) {
    await this.passwords.reset(body.token, body.new_password);
    return { password_reset: true };
  }

  @AuthenticatedOnly()
  @Post('password/change')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password (signs out other sessions)' })
  @ApiZodBody(changePasswordSchema)
  async change(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.output<typeof changePasswordSchema>,
  ) {
    await this.passwords.change(actor, body.current_password, body.new_password);
    return { password_changed: true };
  }

  @AuthenticatedOnly()
  @AllowRestrictedSession()
  @Post('mfa/totp/setup')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Begin TOTP enrollment — returns secret and QR once' })
  async setupTotp(@CurrentActor() actor: Actor) {
    await this.assertMayAddFactor(actor);
    const result = await this.mfa.setup(actor);
    return { secret: result.secret, otpauth_url: result.otpauthUrl, qr_data_url: result.qrDataUrl };
  }

  @AuthenticatedOnly()
  @AllowRestrictedSession()
  @Post('mfa/totp/enable')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm TOTP enrollment with a code' })
  @ApiZodBody(totpEnableSchema)
  async enableTotp(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(totpEnableSchema)) body: z.output<typeof totpEnableSchema>,
  ) {
    await this.assertMayAddFactor(actor);
    const token = await this.mfa.enable(actor, body.code);
    // Recovery codes are returned exactly once (first factor only); only their keyed hashes are stored.
    return { status: 'AUTHENTICATED', access_token: token.accessToken, token_type: 'Bearer', expires_in: token.expiresIn, ...(token.recoveryCodes ? { recovery_codes: token.recoveryCodes } : {}) };
  }

  @AuthenticatedOnly()
  @Post('mfa/recovery-codes')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Regenerate recovery codes (invalidates previous ones; needs a current TOTP code or a recent step-up)' })
  @ApiZodBody(regenerateRecoveryCodesSchema)
  async regenerateRecoveryCodes(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(regenerateRecoveryCodesSchema)) body: z.output<typeof regenerateRecoveryCodesSchema>,
  ) {
    if (body.code) return { recovery_codes: await this.mfa.regenerateRecoveryCodes(actor, { code: body.code }) };
    await this.stepUp.assertFresh(actor);
    return { recovery_codes: await this.mfa.regenerateRecoveryCodes(actor, { steppedUp: true }) };
  }

  @AuthenticatedOnly()
  @Post('mfa/totp/disable')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disable TOTP (not allowed for roles that require MFA)' })
  @ApiZodBody(totpDisableSchema)
  async disableTotp(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(totpDisableSchema)) body: z.output<typeof totpDisableSchema>,
  ) {
    await this.mfa.disable(actor, body.code, body.password);
    return { mfa_enabled: false };
  }

  // ---- Passkeys --------------------------------------------------------------------------------

  @AuthenticatedOnly()
  @Get('passkeys')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List your passkeys' })
  listPasskeys(@CurrentActor() actor: Actor) {
    return this.passkeys.list(actor.userId);
  }

  @AuthenticatedOnly()
  @AllowRestrictedSession()
  @Post('passkeys/register/options')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Begin adding a passkey (WebAuthn creation options)' })
  async passkeyRegistrationOptions(@CurrentActor() actor: Actor) {
    await this.assertMayAddFactor(actor);
    return this.passkeys.registrationOptions(actor);
  }

  @AuthenticatedOnly()
  @AllowRestrictedSession()
  @Post('passkeys/register')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Finish adding a passkey' })
  @ApiZodBody(passkeyRegisterSchema)
  async registerPasskey(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(passkeyRegisterSchema)) body: z.output<typeof passkeyRegisterSchema>,
  ) {
    await this.assertMayAddFactor(actor);
    return this.passkeys.register(actor, body.name, body.response);
  }

  @AuthenticatedOnly()
  @Post('passkeys/:passkeyId/rename')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rename a passkey' })
  @ApiZodBody(passkeyRenameSchema)
  renamePasskey(
    @CurrentActor() actor: Actor,
    @Param('passkeyId', new ZodValidationPipe(idSchema('mfa'))) id: string,
    @Body(new ZodValidationPipe(passkeyRenameSchema)) body: z.output<typeof passkeyRenameSchema>,
  ) {
    return this.passkeys.rename(actor, id, body.name);
  }

  @AuthenticatedOnly()
  @RequireStepUp()
  @Delete('passkeys/:passkeyId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a passkey (needs a recent step-up)' })
  removePasskey(@CurrentActor() actor: Actor, @Param('passkeyId', new ZodValidationPipe(idSchema('mfa'))) id: string) {
    return this.passkeys.remove(actor, id);
  }

  // ---- Step-up ---------------------------------------------------------------------------------

  @AuthenticatedOnly()
  @Get('step-up')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'How you can confirm it is you, and whether a recent confirmation is still valid' })
  stepUpMethods(@CurrentActor() actor: Actor) {
    return this.stepUp.methods(actor);
  }

  @AuthenticatedOnly()
  @Post('step-up/passkey/options')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Passkey challenge for a step-up confirmation' })
  stepUpPasskeyOptions(@CurrentActor() actor: Actor) {
    return this.stepUp.passkeyOptions(actor);
  }

  @AuthenticatedOnly()
  @Post('step-up')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm it is you (passkey, authenticator code, recovery code; password only without two-factor)' })
  @ApiZodBody(stepUpSchema)
  confirmStepUp(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(stepUpSchema)) body: z.output<typeof stepUpSchema>) {
    return this.stepUp.confirm(actor, body);
  }
}
