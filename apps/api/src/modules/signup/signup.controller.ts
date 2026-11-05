import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { signupInfoQuerySchema, signupResendSchema, signupStartSchema, signupVerifySchema } from '@pay2all/validation';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiConfig } from '../../config/api-config';
import { Public } from '../access/decorators';
import { deliverSession } from '../auth/auth.controller';
import { SignupService } from './signup.service';

const origin = (req: Request) => (typeof req.headers.origin === 'string' ? req.headers.origin : undefined);

/** Merchant self sign-up (docs/ONBOARDING.md §1). All routes are public and rate-limited. */
@ApiTags('Sign-up')
@Controller('v1/signup')
export class SignupController {
  constructor(
    private readonly signup: SignupService,
    private readonly config: ApiConfig,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Whether self sign-up is open, and the referring partner for a referral code or custom domain' })
  info(@Query(new ZodValidationPipe(signupInfoQuerySchema)) q: z.output<typeof signupInfoQuerySchema>, @Req() req: Request) {
    return this.signup.info(q.ref, origin(req));
  }

  @Public()
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a sign-up: emails a 6-digit verification code' })
  @ApiZodBody(signupStartSchema)
  start(@Body(new ZodValidationPipe(signupStartSchema)) body: z.output<typeof signupStartSchema>, @Req() req: Request) {
    return this.signup.start(body, origin(req));
  }

  @Public()
  @Post('resend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email a new verification code' })
  @ApiZodBody(signupResendSchema)
  resend(@Body(new ZodValidationPipe(signupResendSchema)) body: z.output<typeof signupResendSchema>) {
    return this.signup.resend(body.signup_id);
  }

  @Public()
  @Post('verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify the code: creates the merchant account and signs in (two-factor enrolment comes next)' })
  @ApiZodBody(signupVerifySchema)
  async verify(@Body(new ZodValidationPipe(signupVerifySchema)) body: z.output<typeof signupVerifySchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const session = await this.signup.verify(body.signup_id, body.code);
    return deliverSession(req, res, this.config, session);
  }
}
