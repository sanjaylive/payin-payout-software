import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { ReportGeneratorService } from './report-generator.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [AccessModule, AuditModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportGeneratorService],
  exports: [ReportGeneratorService, ReportsService],
})
export class ReportsModule {}
