import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { Public } from '../access/decorators';
import { AgentDriveService } from './agent-drive.service';
import { AgentPlansService } from './agent-plans.service';
import { AgentProfileService } from './agent-profile.service';
import { AgentReceiptsService } from './agent-receipts.service';

const tokenParam = new ZodValidationPipe(z.string().regex(/^[A-Za-z0-9_-]{32}$/, 'Receipt not found'));
const callbackQuery = z.object({ code: z.string().max(2048).optional(), state: z.string().max(128).optional(), error: z.string().max(200).optional() });

/** Unauthenticated agent routes: plan prices for the sign-up page, customers' receipt links, Google's redirect. */
@ApiTags('Agent (public)')
@Controller('v1/public')
export class AgentsPublicController {
  constructor(
    private readonly plans: AgentPlansService,
    private readonly receipts: AgentReceiptsService,
    private readonly profile: AgentProfileService,
    private readonly drive: AgentDriveService,
  ) {}

  @Public()
  @Get('agent-plans')
  @ApiOperation({ summary: 'Agent plans and prices' })
  plansList() {
    return this.plans.catalog();
  }

  @Public()
  @Get('agent-receipts/:token')
  @ApiOperation({ summary: 'A customer’s receipt, by the token in its link' })
  receipt(@Param('token', tokenParam) token: string) {
    return this.receipts.publicByToken(token);
  }

  @Public()
  @Get('agent-receipts/:token/logo')
  @ApiOperation({ summary: 'The shop logo on a receipt' })
  async logo(@Param('token', tokenParam) token: string, @Res() res: Response) {
    const img = await this.profile.image(await this.receipts.agentIdForToken(token), 'logo');
    res.setHeader('Content-Type', img.type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    img.stream.pipe(res);
  }

  @Public()
  @Get('agent-drive/callback')
  @ApiOperation({ summary: 'Google OAuth redirect for agent Drive backups' })
  async driveCallback(@Query(new ZodValidationPipe(callbackQuery)) q: z.output<typeof callbackQuery>, @Res() res: Response) {
    res.redirect(302, await this.drive.callback(q.code, q.state, q.error));
  }
}
