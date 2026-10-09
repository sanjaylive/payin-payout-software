import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { SignupController } from './signup.controller';
import { SignupService } from './signup.service';

@Module({
  imports: [AuditModule, AuthModule, MerchantsModule],
  controllers: [SignupController],
  providers: [SignupService],
})
export class SignupModule {}
