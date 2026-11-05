import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ErrorCode } from '@pay2all/types';
import {
  agentBeneficiaryIdSchema,
  agentBeneficiarySchema,
  agentCheckoutSchema,
  agentCustomerIdSchema,
  agentCustomerSchema,
  agentCustomerUpdateSchema,
  agentDriveSettingsSchema,
  agentListQuerySchema,
  agentPlanOrderIdSchema,
  agentProfileUpdateSchema,
  agentReportQuerySchema,
  agentSendReceiptSchema,
  agentStaffCreateSchema,
  agentStaffStatusSchema,
  agentTransactionCreateSchema,
  agentTransactionIdSchema,
  agentTransactionListQuerySchema,
  agentTransactionStatusSchema,
  idSchema,
  mobileSchema,
} from '@pay2all/validation';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { REDIS } from '../../infra/tokens';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { agentOnly } from './agent-common';
import { AgentBillingService } from './agent-billing.service';
import { AgentDeskService } from './agent-desk.service';
import { AgentDriveService } from './agent-drive.service';
import { AgentProfileService } from './agent-profile.service';
import { AgentReceiptsService } from './agent-receipts.service';
import { AgentStaffService } from './agent-staff.service';

const imageKind = new ZodValidationPipe(z.enum(['qr', 'logo']));
const lookupQuery = z.strictObject({ mobile: mobileSchema });
const userIdParam = new ZodValidationPipe(idSchema('usr'));
const upload = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 + 1, files: 1, fields: 0 } });
const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

function sendImage(res: Response, img: { stream: NodeJS.ReadableStream; type: string }) {
  res.setHeader('Content-Type', img.type);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  img.stream.pipe(res);
}

/** The agent's own account (docs/AGENTS.md). Every route acts on the signed-in agent only. */
@ApiTags('Agent')
@ApiBearerAuth()
@Controller('v1/agent')
export class AgentsController {
  constructor(
    private readonly profile: AgentProfileService,
    private readonly desk: AgentDeskService,
    private readonly receipts: AgentReceiptsService,
    private readonly staff: AgentStaffService,
    private readonly billing: AgentBillingService,
    private readonly drive: AgentDriveService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ---- Home & profile -------------------------------------------------------------------------------

  @Get('dashboard')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'Today and this month at a glance, plan usage and recent transactions' })
  dashboard(@CurrentActor() actor: Actor) {
    return this.profile.dashboard(actor);
  }

  @Get('profile')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'Shop profile, plan and usage' })
  getProfile(@CurrentActor() actor: Actor) {
    return this.profile.get(actor);
  }

  @Patch('profile')
  @RequirePermissions('agent.settings.manage')
  @ApiOperation({ summary: 'Update the shop profile, UPI id and receipt footer' })
  @ApiZodBody(agentProfileUpdateSchema)
  updateProfile(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(agentProfileUpdateSchema)) body: z.output<typeof agentProfileUpdateSchema>) {
    return this.profile.update(actor, body);
  }

  @Post('profile/:kind')
  @RequirePermissions('agent.settings.manage')
  @UseInterceptors(upload)
  @ApiOperation({ summary: 'Upload the shop QR image (kind=qr) or logo (kind=logo): PNG/JPEG/WebP, 2 MB' })
  uploadImage(@CurrentActor() actor: Actor, @Param('kind', imageKind) kind: 'qr' | 'logo', @UploadedFile() file: { buffer: Buffer; size: number } | undefined) {
    return this.profile.uploadImage(actor, kind, file);
  }

  @Delete('profile/:kind')
  @RequirePermissions('agent.settings.manage')
  @ApiOperation({ summary: 'Remove the uploaded QR image or logo' })
  removeImage(@CurrentActor() actor: Actor, @Param('kind', imageKind) kind: 'qr' | 'logo') {
    return this.profile.removeImage(actor, kind);
  }

  @Get('profile/:kind')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'The uploaded QR image or logo' })
  async image(@CurrentActor() actor: Actor, @Param('kind', imageKind) kind: 'qr' | 'logo', @Res() res: Response) {
    sendImage(res, await this.profile.image(agentOnly(actor), kind));
  }

  // ---- Customers & beneficiaries --------------------------------------------------------------------

  @Get('customers')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'Customers, newest first; search by name or mobile' })
  customers(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(agentListQuerySchema)) q: z.output<typeof agentListQuerySchema>) {
    return this.desk.listCustomers(actor, q);
  }

  @Get('customers/lookup')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'Find a customer by exact mobile number (null when new)' })
  async lookup(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(lookupQuery)) q: z.output<typeof lookupQuery>) {
    return { customer: await this.desk.findCustomerByMobile(actor, q.mobile) };
  }

  @Post('customers')
  @RequirePermissions('agent.desk.write')
  @ApiOperation({ summary: 'Add a customer' })
  @ApiZodBody(agentCustomerSchema)
  createCustomer(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(agentCustomerSchema)) body: z.output<typeof agentCustomerSchema>) {
    return this.desk.createCustomer(actor, body);
  }

  @Get('customers/:id')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'A customer with their beneficiaries' })
  customer(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentCustomerIdSchema)) id: string) {
    return this.desk.getCustomer(actor, id);
  }

  @Patch('customers/:id')
  @RequirePermissions('agent.desk.write')
  @ApiOperation({ summary: 'Edit a customer' })
  @ApiZodBody(agentCustomerUpdateSchema)
  updateCustomer(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentCustomerIdSchema)) id: string, @Body(new ZodValidationPipe(agentCustomerUpdateSchema)) body: z.output<typeof agentCustomerUpdateSchema>) {
    return this.desk.updateCustomer(actor, id, body);
  }

  @Get('customers/:id/id-number')
  @RequirePermissions('agent.desk.write')
  @ApiOperation({ summary: 'Show the customer’s full ID number (audited)' })
  revealId(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentCustomerIdSchema)) id: string) {
    return this.desk.revealCustomerId(actor, id);
  }

  @Post('customers/:id/beneficiaries')
  @RequirePermissions('agent.desk.write')
  @ApiOperation({ summary: 'Add a beneficiary (bank account and/or UPI id) for a customer' })
  @ApiZodBody(agentBeneficiarySchema)
  addBeneficiary(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentCustomerIdSchema)) id: string, @Body(new ZodValidationPipe(agentBeneficiarySchema)) body: z.output<typeof agentBeneficiarySchema>) {
    return this.desk.addBeneficiary(actor, id, body);
  }

  @Delete('beneficiaries/:id')
  @RequirePermissions('agent.desk.write')
  @ApiOperation({ summary: 'Remove a beneficiary (past receipts keep its details)' })
  removeBeneficiary(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentBeneficiaryIdSchema)) id: string) {
    return this.desk.removeBeneficiary(actor, id);
  }

  // ---- Transactions -------------------------------------------------------------------------------

  @Get('transactions')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'Recorded transactions, newest first, with filters' })
  transactions(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(agentTransactionListQuerySchema)) q: z.output<typeof agentTransactionListQuerySchema>) {
    return this.desk.listTransactions(actor, q);
  }

  @Post('transactions')
  @RequirePermissions('agent.desk.write')
  @ApiOperation({ summary: 'Record a transaction. Send an Idempotency-Key so a retried tap never records it twice' })
  @ApiZodBody(agentTransactionCreateSchema)
  async record(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(agentTransactionCreateSchema)) body: z.output<typeof agentTransactionCreateSchema>,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const agentId = agentOnly(actor);
    if (!key) return this.desk.createTransaction(actor, body);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new AppError(ErrorCode.INVALID_REQUEST, 'Idempotency-Key must be 8–64 letters, digits, - or _');
    const slot = `agent-idem:${agentId}:${key}`;
    const claimed = await this.redis.set(slot, 'pending', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    if (!claimed) {
      const existing = await this.redis.get(slot);
      if (existing && existing !== 'pending') return this.desk.getTransaction(actor, existing);
      throw new AppError(ErrorCode.CONFLICT, 'This transaction is still being recorded');
    }
    try {
      const t = await this.desk.createTransaction(actor, body);
      await this.redis.set(slot, t.id, 'EX', IDEMPOTENCY_TTL_SECONDS);
      return t;
    } catch (err) {
      await this.redis.del(slot);
      throw err;
    }
  }

  @Get('transactions/:id')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'One transaction' })
  transaction(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentTransactionIdSchema)) id: string) {
    return this.desk.getTransaction(actor, id);
  }

  @Post('transactions/:id/status')
  @HttpCode(200)
  @RequirePermissions('agent.txn.manage')
  @ApiOperation({ summary: 'Mark a transaction successful, failed or refunded' })
  @ApiZodBody(agentTransactionStatusSchema)
  status(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentTransactionIdSchema)) id: string, @Body(new ZodValidationPipe(agentTransactionStatusSchema)) body: z.output<typeof agentTransactionStatusSchema>) {
    return this.desk.changeStatus(actor, id, body);
  }

  @Get('transactions/:id/receipt')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'Everything a printed or shared receipt shows' })
  receipt(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentTransactionIdSchema)) id: string) {
    return this.receipts.forAgent(actor, id);
  }

  @Post('transactions/:id/send-receipt')
  @HttpCode(200)
  @RequirePermissions('agent.desk.write')
  @ApiOperation({ summary: 'Send the receipt link to the customer by SMS or WhatsApp (plans with messaging)' })
  @ApiZodBody(agentSendReceiptSchema)
  sendReceipt(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentTransactionIdSchema)) id: string, @Body(new ZodValidationPipe(agentSendReceiptSchema)) body: z.output<typeof agentSendReceiptSchema>) {
    return this.receipts.send(actor, id, body);
  }

  // ---- Reports ------------------------------------------------------------------------------------

  @Get('reports/summary')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'Totals by day, type, mode and status for a date range (IST)' })
  summary(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(agentReportQuerySchema)) q: z.output<typeof agentReportQuerySchema>) {
    return this.receipts.summary(actor, q);
  }

  @Get('reports/export')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'Download transactions for a date range as CSV' })
  async export(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(agentReportQuerySchema)) q: z.output<typeof agentReportQuerySchema>, @Res() res: Response) {
    await this.receipts.exportCsv(actor, q, res);
  }

  // ---- Staff --------------------------------------------------------------------------------------

  @Get('staff')
  @RequirePermissions('agent.settings.manage')
  @ApiOperation({ summary: 'Logins on this account and the plan’s limit' })
  staffList(@CurrentActor() actor: Actor) {
    return this.staff.list(actor);
  }

  @Post('staff')
  @RequirePermissions('agent.settings.manage')
  @ApiOperation({ summary: 'Create a counter operator login' })
  @ApiZodBody(agentStaffCreateSchema)
  staffCreate(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(agentStaffCreateSchema)) body: z.output<typeof agentStaffCreateSchema>) {
    return this.staff.create(actor, body);
  }

  @Post('staff/:userId/status')
  @HttpCode(200)
  @RequirePermissions('agent.settings.manage')
  @ApiOperation({ summary: 'Enable or disable a counter operator login' })
  @ApiZodBody(agentStaffStatusSchema)
  staffStatus(@CurrentActor() actor: Actor, @Param('userId', userIdParam) userId: string, @Body(new ZodValidationPipe(agentStaffStatusSchema)) body: z.output<typeof agentStaffStatusSchema>) {
    return this.staff.setActive(actor, userId, body.active);
  }

  // ---- Plan & billing -----------------------------------------------------------------------------

  @Get('billing')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'Current plan, usage, available plans and past orders' })
  billingOverview(@CurrentActor() actor: Actor) {
    return this.billing.overview(actor);
  }

  @Post('billing/checkout')
  @RequirePermissions('agent.billing.manage')
  @ApiOperation({ summary: 'Start paying for a plan: returns an order with a checkout URL' })
  @ApiZodBody(agentCheckoutSchema)
  checkout(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(agentCheckoutSchema)) body: z.output<typeof agentCheckoutSchema>) {
    return this.billing.checkout(actor, body);
  }

  @Get('billing/orders/:id')
  @RequirePermissions('agent.desk.read')
  @ApiOperation({ summary: 'An order (checks the payment again while it is pending)' })
  order(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentPlanOrderIdSchema)) id: string) {
    return this.billing.getOrder(actor, id);
  }

  @Post('billing/orders/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('agent.billing.manage')
  @ApiOperation({ summary: 'Cancel an unpaid order' })
  cancelOrder(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(agentPlanOrderIdSchema)) id: string) {
    return this.billing.cancelOrder(actor, id);
  }

  // ---- Google Drive -------------------------------------------------------------------------------

  @Get('drive')
  @RequirePermissions('agent.settings.manage')
  @ApiOperation({ summary: 'Google Drive backup status' })
  driveStatus(@CurrentActor() actor: Actor) {
    return this.drive.status(actor);
  }

  @Post('drive/connect')
  @HttpCode(200)
  @RequirePermissions('agent.settings.manage')
  @ApiOperation({ summary: 'Start connecting Google Drive: open the returned URL in a browser' })
  driveConnect(@CurrentActor() actor: Actor) {
    return this.drive.connect(actor);
  }

  @Post('drive/backup')
  @HttpCode(200)
  @RequirePermissions('agent.settings.manage')
  @ApiOperation({ summary: 'Back up to Google Drive now' })
  driveBackup(@CurrentActor() actor: Actor) {
    return this.drive.backupNow(actor);
  }

  @Put('drive/settings')
  @RequirePermissions('agent.settings.manage')
  @ApiOperation({ summary: 'Turn the daily automatic backup on or off' })
  @ApiZodBody(agentDriveSettingsSchema)
  driveSettings(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(agentDriveSettingsSchema)) body: z.output<typeof agentDriveSettingsSchema>) {
    return this.drive.setAutoBackup(actor, body.auto_backup);
  }

  @Delete('drive')
  @RequirePermissions('agent.settings.manage')
  @ApiOperation({ summary: 'Disconnect Google Drive (files already there stay)' })
  driveDisconnect(@CurrentActor() actor: Actor) {
    return this.drive.disconnect(actor);
  }
}
