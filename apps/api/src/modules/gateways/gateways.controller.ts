import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { gatewayRemoveCredentialsSchema, gatewayToggleSchema, saveGatewaySchema } from '@pay2all/validation';
import { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { GatewaysService } from './gateways.service';

const keyPipe = new ZodValidationPipe(z.string().regex(/^[a-z0-9-]{2,40}$/));

@ApiTags('Payment gateways')
@ApiBearerAuth()
@Controller('v1/gateways')
export class GatewaysController {
  constructor(private readonly gateways: GatewaysService) {}

  @Get()
  @RequirePermissions('provider.read')
  @ApiOperation({ summary: 'Supported gateways, connection state, webhook URLs (credentials never returned)' })
  list(@CurrentActor() actor: Actor) {
    return this.gateways.list(actor);
  }

  @Put(':key')
  @RequireStepUp()
  @RequirePermissions('system.settings.manage')
  @ApiOperation({ summary: 'Connect or update a gateway: environment and credentials (merged with stored ones)' })
  @ApiZodBody(saveGatewaySchema)
  save(@CurrentActor() actor: Actor, @Param('key', keyPipe) key: string, @Body(new ZodValidationPipe(saveGatewaySchema)) body: z.output<typeof saveGatewaySchema>) {
    return this.gateways.save(actor, key, body);
  }

  @Post(':key/test')
  @HttpCode(200)
  @RequirePermissions('system.settings.manage')
  @ApiOperation({ summary: 'Check the stored credentials against the gateway' })
  test(@CurrentActor() actor: Actor, @Param('key', keyPipe) key: string) {
    return this.gateways.test(actor, key);
  }

  @Post(':key/enabled')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('system.settings.manage')
  @ApiZodBody(gatewayToggleSchema)
  toggle(@CurrentActor() actor: Actor, @Param('key', keyPipe) key: string, @Body(new ZodValidationPipe(gatewayToggleSchema)) body: z.output<typeof gatewayToggleSchema>) {
    return this.gateways.setEnabled(actor, key, body.enabled, body.reason);
  }

  @Post(':key/credentials/remove')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('system.settings.manage')
  @ApiZodBody(gatewayRemoveCredentialsSchema)
  removeCredentials(@CurrentActor() actor: Actor, @Param('key', keyPipe) key: string, @Body(new ZodValidationPipe(gatewayRemoveCredentialsSchema)) body: z.output<typeof gatewayRemoveCredentialsSchema>) {
    return this.gateways.removeCredentials(actor, key, body.environment, body.reason);
  }
}
