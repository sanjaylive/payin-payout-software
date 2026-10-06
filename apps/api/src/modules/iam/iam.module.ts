import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { RolesController } from './roles.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AccessModule, AuditModule, AuthModule],
  controllers: [OrganizationsController, UsersController, RolesController],
  providers: [OrganizationsService, UsersService],
})
export class IamModule {}
