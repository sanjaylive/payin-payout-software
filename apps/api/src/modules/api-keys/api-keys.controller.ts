import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { apiLogsQuerySchema, apiUsageQuerySchema, createApiKeySchema, idSchema, ipAllowlistEntrySchema, rotateApiKeySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { ApiKeysService } from './api-keys.service';

const keyId = new ZodValidationPipe(idSchema('key'));

@ApiTags('API keys')
@ApiBearerAuth()
@Controller('v1/developers')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Post('api-keys')
  @RequireStepUp()
  @RequirePermissions('api_key.manage')
  @ApiOperation({ summary: 'Create an API key. The secret is returned once.' })
  @ApiZodBody(createApiKeySchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createApiKeySchema)) body: z.output<typeof createApiKeySchema>) {
    return this.keys.create(actor, body);
  }

  @Get('api-keys')
  @RequirePermissions('api_key.read')
  list(@CurrentActor() actor: Actor) {
    return this.keys.list(actor);
  }

  @Post('api-keys/:id/rotate')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('api_key.manage')
  @ApiZodBody(rotateApiKeySchema)
  rotate(@CurrentActor() actor: Actor, @Param('id', keyId) id: string, @Body(new ZodValidationPipe(rotateApiKeySchema)) body: z.output<typeof rotateApiKeySchema>) {
    return this.keys.rotate(actor, id, body.overlap_hours);
  }

  @Post('api-keys/:id/revoke')
  @HttpCode(200)
  @RequirePermissions('api_key.manage')
  revoke(@CurrentActor() actor: Actor, @Param('id', keyId) id: string) {
    return this.keys.revoke(actor, id);
  }

  @Get('ip-allowlist')
  @RequirePermissions('api_key.read')
  allowlist(@CurrentActor() actor: Actor) {
    return this.keys.listAllowlist(actor);
  }

  @Post('ip-allowlist')
  @RequireStepUp()
  @RequirePermissions('api_key.manage')
  @ApiZodBody(ipAllowlistEntrySchema)
  addAllowlist(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(ipAllowlistEntrySchema)) body: z.output<typeof ipAllowlistEntrySchema>) {
    return this.keys.addAllowlist(actor, body);
  }

  @Delete('ip-allowlist/:id')
  @RequireStepUp()
  @RequirePermissions('api_key.manage')
  removeAllowlist(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(idSchema('ipa'))) id: string) {
    return this.keys.removeAllowlist(actor, id);
  }

  @Get('api-logs')
  @RequirePermissions('api_key.read')
  @ApiZodQuery(apiLogsQuerySchema)
  logs(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(apiLogsQuerySchema)) q: z.output<typeof apiLogsQuerySchema>) {
    return this.keys.logs(actor, q);
  }

  @Get('api-usage')
  @RequirePermissions('api_key.read')
  @ApiZodQuery(apiUsageQuerySchema)
  usage(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(apiUsageQuerySchema)) q: z.output<typeof apiUsageQuerySchema>) {
    return this.keys.usage(actor, q.days, q.merchant_id);
  }
}
