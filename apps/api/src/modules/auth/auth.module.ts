import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessModule } from '../access/access.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuditModule } from '../audit/audit.module';
import { LoginEventsModule } from '../login-events/login-events.module';
import { AuthController } from './auth.controller';
import { DashboardIpService } from './dashboard-ip.service';
import { PasskeyService } from './passkey.service';
import { SecurityController } from './security.controller';
import { StepUpGuard } from './step-up.guard';
import { StepUpService } from './step-up.service';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MeService } from './me.service';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({}), AccessModule, AuditModule, ApiKeysModule, LoginEventsModule],
  controllers: [AuthController, SecurityController],
  providers: [
    TokenService,
    SessionService,
    AuthService,
    MfaService,
    PasswordService,
    MeService,
    AuthGuard,
    DashboardIpService,
    PasskeyService,
    StepUpService,
    StepUpGuard,
  ],
  exports: [AuthService, AuthGuard, StepUpGuard, StepUpService, SessionService, PasswordService, TokenService, MfaService],
})
export class AuthModule {}
