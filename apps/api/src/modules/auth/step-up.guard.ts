import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_STEP_UP, type RequestWithActor } from '../access/decorators';
import { StepUpService } from './step-up.service';

/** Enforces @RequireStepUp after authentication and permissions have passed. */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly stepUp: StepUpService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.reflector.getAllAndOverride<boolean>(REQUIRE_STEP_UP, [context.getHandler(), context.getClass()])) return true;
    const actor = context.switchToHttp().getRequest<RequestWithActor>().actor;
    if (actor) await this.stepUp.assertFresh(actor);
    return true;
  }
}
