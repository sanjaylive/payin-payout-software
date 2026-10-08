import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createProviderSchema,
  idSchema,
  listRoutesQuerySchema,
  providerCredentialsSchema,
  providerStatusSchema,
  routeSchema,
  simulateRouteSchema,
  updateProviderSchema,
} from '@pay2all/validation';
import { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { ProvidersService } from './providers.service';
import { RoutingService } from './routing.service';

const providerIdPipe = new ZodValidationPipe(idSchema('prv'));
const routeIdPipe = new ZodValidationPipe(idSchema('prt'));
const kindQuery = z.strictObject({ kind: z.enum(['PAYIN', 'PAYOUT']).optional() });

@ApiTags('Providers & routing')
@ApiBearerAuth()
@Controller('v1')
export class ProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly routing: RoutingService,
  ) {}

  @Get('providers')
  @RequirePermissions('provider.read')
  @ApiOperation({ summary: 'Providers with live health metrics (credentials shown as fingerprints only)' })
  list(@Query(new ZodValidationPipe(kindQuery)) q: z.output<typeof kindQuery>) {
    return this.providers.list(q.kind);
  }

  @Get('providers/adapters')
  @RequirePermissions('provider.read')
  adapters() {
    return this.providers.adapters();
  }

  @Get('providers/:id')
  @RequirePermissions('provider.read')
  get(@Param('id', providerIdPipe) id: string) {
    return this.providers.get(id);
  }

  @Post('providers')
  @RequirePermissions('provider.manage')
  @ApiOperation({ summary: 'Register a provider (starts DISABLED until credentials are set)' })
  @ApiZodBody(createProviderSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createProviderSchema)) body: z.output<typeof createProviderSchema>) {
    return this.providers.create(actor, body);
  }

  @Patch('providers/:id')
  @RequirePermissions('provider.manage')
  @ApiZodBody(updateProviderSchema)
  update(@CurrentActor() actor: Actor, @Param('id', providerIdPipe) id: string, @Body(new ZodValidationPipe(updateProviderSchema)) body: z.output<typeof updateProviderSchema>) {
    return this.providers.update(actor, id, body);
  }

  @Patch('providers/:id/status')
  @RequireStepUp()
  @RequirePermissions('provider.manage')
  @ApiOperation({ summary: 'Manual status: MAINTENANCE / DISABLED (never auto-overridden) or ACTIVE (hand back to health management)' })
  @ApiZodBody(providerStatusSchema)
  status(@CurrentActor() actor: Actor, @Param('id', providerIdPipe) id: string, @Body(new ZodValidationPipe(providerStatusSchema)) body: z.output<typeof providerStatusSchema>) {
    return this.providers.setStatus(actor, id, body);
  }

  @Put('providers/:id/credentials')
  @RequireStepUp()
  @RequirePermissions('provider.manage')
  @ApiOperation({ summary: 'Set or rotate credentials (write-only; values are encrypted and never returned)' })
  @ApiZodBody(providerCredentialsSchema)
  credentials(@CurrentActor() actor: Actor, @Param('id', providerIdPipe) id: string, @Body(new ZodValidationPipe(providerCredentialsSchema)) body: z.output<typeof providerCredentialsSchema>) {
    return this.providers.setCredentials(actor, id, body);
  }

  @Post('providers/:id/test')
  @HttpCode(200)
  @RequirePermissions('provider.manage')
  @ApiOperation({ summary: 'Run the adapter health check now (recorded as a probe)' })
  test(@Param('id', providerIdPipe) id: string) {
    return this.providers.testConnection(id);
  }

  @Get('provider-routes')
  @RequirePermissions('provider.read')
  @ApiZodQuery(listRoutesQuerySchema)
  routes(@Query(new ZodValidationPipe(listRoutesQuerySchema)) q: z.output<typeof listRoutesQuerySchema>) {
    return this.routing.list(q);
  }

  @Post('provider-routes')
  @RequirePermissions('routing.manage')
  @ApiZodBody(routeSchema)
  createRoute(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(routeSchema)) body: z.output<typeof routeSchema>) {
    return this.routing.create(actor, body);
  }

  @Put('provider-routes/:id')
  @RequirePermissions('routing.manage')
  @ApiZodBody(routeSchema)
  updateRoute(@CurrentActor() actor: Actor, @Param('id', routeIdPipe) id: string, @Body(new ZodValidationPipe(routeSchema)) body: z.output<typeof routeSchema>) {
    return this.routing.update(actor, id, body);
  }

  @Post('routing/simulate')
  @HttpCode(200)
  @RequirePermissions('provider.read')
  @ApiOperation({ summary: 'Explain which providers a transaction would be routed to, and why' })
  @ApiZodBody(simulateRouteSchema)
  simulate(@Body(new ZodValidationPipe(simulateRouteSchema)) body: z.output<typeof simulateRouteSchema>) {
    return this.routing.simulate(body);
  }
}
