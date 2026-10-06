import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { createKeyring, FieldEncryptor } from '@pay2all/auth';
import { ApiConfig } from '../../config/api-config';
import { AccessModule } from '../access/access.module';
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
  imports: [JwtModule.register({}), AccessModule, AuditModule],
  controllers: [AuthController],
  providers: [
    {
      provide: FieldEncryptor,
      inject: [ApiConfig],
      useFactory: (config: ApiConfig) =>
        new FieldEncryptor(
          createKeyring(config.env.ENCRYPTION_KEY_ID, { [config.env.ENCRYPTION_KEY_ID]: config.env.ENCRYPTION_KEY }),
        ),
    },
    TokenService,
    SessionService,
    AuthService,
    MfaService,
    PasswordService,
    MeService,
    AuthGuard,
  ],
  exports: [AuthGuard, SessionService, PasswordService, TokenService, FieldEncryptor],
})
export class AuthModule {}
