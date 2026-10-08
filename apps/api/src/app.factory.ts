import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { type NextFunction, type Request, type Response, text, urlencoded } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { metrics, statusClass } from '@pay2all/telemetry';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import type { ApiConfig } from './config/api-config';
import { BrandService } from './infra/brand.service';

const DOCS_PATH = 'docs';

export async function createApp(config: ApiConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    bufferLogs: true,
    bodyParser: false,
    // Keep the exact request bytes (req.rawBody) for webhook signature verification.
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  app.flushLogs();

  app.set('trust proxy', config.env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  // Strict CSP for the JSON API; Swagger UI needs inline scripts/styles so it gets a relaxed policy.
  const apiHelmet = helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.isProduction,
  });
  const docsHelmet = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) =>
    req.path.startsWith(`/${DOCS_PATH}`) ? docsHelmet(req, res, next) : apiHelmet(req, res, next),
  );

  // RED metrics per route template (never the raw path: ids would explode label cardinality).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const route = req.route ? `${req.baseUrl}${(req.route as { path: string }).path}` : 'unmatched';
      const labels = { method: req.method, route, status_class: statusClass(res.statusCode) };
      metrics.httpRequests.inc(labels);
      metrics.httpDuration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
    });
    next();
  });

  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  // Indian payment gateways post form-encoded callbacks. Parse forms only on those paths (keeping the
  // raw bytes for signature checks); everywhere else the API accepts JSON only.
  const gatewayForms = urlencoded({ extended: false, limit: '256kb', verify: (req: Request & { rawBody?: Buffer }, _res, buf) => void (req.rawBody = buf) });
  app.use(['/v1/webhooks/providers', '/v1/checkout/return'], gatewayForms);
  // Amazon SNS posts JSON with Content-Type text/plain; keep its bytes for the receipt endpoint only.
  app.use('/v1/webhooks/messaging/ses', text({ type: 'text/plain', limit: '256kb', verify: (req: Request & { rawBody?: Buffer }, _res, buf) => void (req.rawBody = buf) }));
  // Configured origins, plus resellers' verified custom domains (white-label, docs/BRANDING.md §5).
  const brand = app.get(BrandService);
  const staticOrigins = new Set(config.env.CORS_ALLOWED_ORIGINS);
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || staticOrigins.has(origin)) return cb(null, true);
      brand.customOrigins().then((o) => cb(null, o.has(origin)), () => cb(null, false));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id', 'X-Pay2All-CSRF'],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'Idempotent-Replayed'],
    maxAge: 600,
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.enableShutdownHooks();

  if (config.env.SWAGGER_ENABLED) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Pay2All Payments API')
        .setDescription(
          'Dashboard and merchant APIs. All responses use the envelope { success, data, meta } / { success:false, error }.',
        )
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup(DOCS_PATH, app, document, { jsonDocumentUrl: `${DOCS_PATH}/openapi.json` });
  }

  return app;
}
