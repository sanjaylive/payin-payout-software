import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { AgentAdminService } from './agent-admin.service';
import { AgentBillingService } from './agent-billing.service';
import { AgentDeskService } from './agent-desk.service';
import { AgentDriveService } from './agent-drive.service';
import { AgentPlansService } from './agent-plans.service';
import { AgentProfileService } from './agent-profile.service';
import { AgentReceiptsService } from './agent-receipts.service';
import { AgentStaffService } from './agent-staff.service';
import { AgentsAdminController } from './agents-admin.controller';
import { AgentsPublicController } from './agents-public.controller';
import { AgentsController } from './agents.controller';

/** Agents — customer service points (docs/AGENTS.md). */
@Module({
  imports: [AccessModule, AuditModule, AuthModule],
  controllers: [AgentsController, AgentsPublicController, AgentsAdminController],
  providers: [AgentPlansService, AgentProfileService, AgentDeskService, AgentReceiptsService, AgentStaffService, AgentBillingService, AgentDriveService, AgentAdminService],
  exports: [AgentProfileService, AgentBillingService, AgentDriveService, AgentPlansService],
})
export class AgentsModule {}
