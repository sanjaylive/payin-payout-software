import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { ReportsModule } from '../reports/reports.module';
import { LoginEventsController } from './login-events.controller';
import { LoginEventsService } from './login-events.service';

@Module({
  imports: [AccessModule, AuditModule, ReportsModule],
  controllers: [LoginEventsController],
  providers: [LoginEventsService],
  exports: [LoginEventsService],
})
export class LoginEventsModule {}
