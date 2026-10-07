import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessModule } from '../access/access.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuditModule } from '../audit/audit.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MeService } from './me.service';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({}), AccessModule, AuditModule, ApiKeysModule],
  controllers: [AuthController],
  providers: [
    TokenService,
    SessionService,
    AuthService,
    MfaService,
    PasswordService,
    MeService,
    AuthGuard,
  ],
  exports: [AuthGuard, SessionService, PasswordService, TokenService, MfaService],
})
export class AuthModule {}
