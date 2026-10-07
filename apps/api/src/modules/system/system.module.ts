import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { SystemController } from './system.controller';

@Module({ imports: [AccessModule], controllers: [SystemController] })
export class SystemModule {}
