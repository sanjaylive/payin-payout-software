import { Module } from '@nestjs/common';
import { AccessProfileService } from './access-profile.service';
import { PermissionGuard } from './permission.guard';
import { TenantScopeService } from './tenant-scope.service';

@Module({
  providers: [AccessProfileService, TenantScopeService, PermissionGuard],
  exports: [AccessProfileService, TenantScopeService, PermissionGuard],
})
export class AccessModule {}
