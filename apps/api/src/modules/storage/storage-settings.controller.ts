import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { activateStorageSchema, removeStorageBackendSchema, saveStorageBackendSchema, STORAGE_KINDS } from '@pay2all/validation';
import { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { StorageSettingsService } from './storage-settings.service';

const kindPipe = new ZodValidationPipe(z.enum(STORAGE_KINDS));
type Kind = (typeof STORAGE_KINDS)[number];

@ApiTags('File storage')
@ApiBearerAuth()
@Controller('v1/storage')
export class StorageSettingsController {
  constructor(private readonly settings: StorageSettingsService) {}

  @Get('backends')
  @RequirePermissions('system.settings.manage')
  @ApiOperation({ summary: 'Storage backends, which one receives new files, and usage' })
  overview(@CurrentActor() actor: Actor) {
    return this.settings.overview(actor);
  }

  @Put('backends/:kind')
  @RequireStepUp()
  @RequirePermissions('system.settings.manage')
  @ApiOperation({ summary: 'Create or update a backend (credentials are write-only)' })
  @ApiZodBody(saveStorageBackendSchema)
  save(@CurrentActor() actor: Actor, @Param('kind', kindPipe) kind: Kind, @Body(new ZodValidationPipe(saveStorageBackendSchema)) body: z.output<typeof saveStorageBackendSchema>) {
    return this.settings.save(actor, kind, body);
  }

  @Post('backends/:kind/test')
  @HttpCode(200)
  @RequirePermissions('system.settings.manage')
  @ApiOperation({ summary: 'Connection test: checks, then an encrypted write, read and delete' })
  test(@CurrentActor() actor: Actor, @Param('kind', kindPipe) kind: Kind) {
    return this.settings.test(actor, kind);
  }

  @Post('backends/:kind/remove')
  @HttpCode(200)
  @RequirePermissions('system.settings.manage')
  @ApiZodBody(removeStorageBackendSchema)
  remove(@CurrentActor() actor: Actor, @Param('kind', kindPipe) kind: Kind, @Body(new ZodValidationPipe(removeStorageBackendSchema)) body: z.output<typeof removeStorageBackendSchema>) {
    return this.settings.remove(actor, kind, body);
  }

  @Post('active')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('system.settings.manage')
  @ApiOperation({ summary: 'Choose where new files go (runs a connection test first)' })
  @ApiZodBody(activateStorageSchema)
  activate(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(activateStorageSchema)) body: z.output<typeof activateStorageSchema>) {
    return this.settings.activate(actor, body);
  }
}
