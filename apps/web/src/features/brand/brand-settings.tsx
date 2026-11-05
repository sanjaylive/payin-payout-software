'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@pay2all/ui/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { cn } from '@pay2all/ui/lib/utils';
import { BRAND_DEFAULTS } from '@pay2all/validation';
import { useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ImageUp,
  Loader2,
  Mail,
  Monitor,
  Moon,
  Palette,
  Phone,
  RotateCcw,
  Save,
  Sun,
  Trash2,
  Type,
  Undo2,
  UploadCloud,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { type CSSProperties, type ReactNode, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DefaultMark } from '@/components/shell/brand';
import { apiRequest, apiUpload } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { assetUrl, type Brand, contrast } from '@/lib/brand/brand';
import { BRAND_KEY, useBrand } from '@/lib/brand/brand-provider';

type Kind = 'LOGO' | 'LOGO_DARK' | 'ICON';
const ASSET_KEY: Record<Kind, keyof Brand['assets']> = {
  LOGO: 'logo',
  LOGO_DARK: 'logo_dark',
  ICON: 'icon',
};
const ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,.ico,.svg';
const MAX = 1024 * 1024;

const SWATCHES = [
  '#2b55c9',
  '#4f46e5',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#0f766e',
  '#059669',
  '#0284c7',
  '#334155',
];

type Fields = Omit<Brand, 'version' | 'updated_at' | 'assets' | 'owner' | 'landing_variant'>;
type Pending =
  { file: File; url: string; width: number | null; height: number | null } | 'REMOVE' | null;

const fieldsOf = (b: Brand): Fields => ({
  product_name: b.product_name,
  short_name: b.short_name,
  company_name: b.company_name,
  tagline: b.tagline,
  primary_color: b.primary_color,
  support_email: b.support_email,
  support_phone: b.support_phone,
  website_url: b.website_url,
  login_headline: b.login_headline,
  login_subtext: b.login_subtext,
  footer_text: b.footer_text,
});

/** Image dimensions in the browser, for an early warning (the server checks again). */
function measure(url: string): Promise<{ width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth || null, height: img.naturalHeight || null });
    img.onerror = () => resolve({ width: null, height: null });
    img.src = url;
  });
}

// ---- Small pieces --------------------------------------------------------------------------------

function Field({
  id,
  label,
  hint,
  count,
  max,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  count?: number;
  max?: number;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {max !== undefined && (
          <span
            className={cn(
              'text-[11px] tabular-nums',
              (count ?? 0) > max ? 'text-destructive' : 'text-muted-foreground',
            )}
          >{`${count ?? 0}/${max}`}</span>
        )}
      </div>
      {children}
      {hint && <p className="text-muted-foreground text-[11px] leading-relaxed">{hint}</p>}
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Type;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="bg-primary/10 text-primary flex size-7 items-center justify-center rounded-md">
            <Icon className="size-4" />
          </span>
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function AssetTile({
  kind,
  title,
  hint,
  current,
  pending,
  onPick,
  onRemove,
  onUndo,
}: {
  kind: Kind;
  title: string;
  hint: string;
  current: string | null;
  pending: Pending;
  onPick: (f: File) => void;
  onRemove: () => void;
  onUndo: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const shown = pending === 'REMOVE' ? null : pending ? pending.url : current;
  const darkBg = kind === 'LOGO_DARK';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        {pending && (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-semibold',
              pending === 'REMOVE'
                ? 'bg-destructive/10 text-destructive'
                : 'bg-primary/10 text-primary',
            )}
          >
            {pending === 'REMOVE' ? 'Will be removed' : 'New'}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) onPick(f);
        }}
        aria-label={`Upload ${title.toLowerCase()}`}
        className={cn(
          'group relative flex h-32 items-center justify-center overflow-hidden rounded-xl border-2 border-dashed p-4 transition-colors',
          // The logo tile is always light and the dark-logo tile always dark, whatever the dashboard theme.
          darkBg
            ? 'border-white/15 bg-[#0f172a]'
            : 'border-slate-300 bg-white bg-[length:16px_16px] [background-image:linear-gradient(45deg,#eef1f5_25%,transparent_25%,transparent_75%,#eef1f5_75%),linear-gradient(45deg,#eef1f5_25%,transparent_25%,transparent_75%,#eef1f5_75%)] [background-position:0_0,8px_8px]',
          over ? 'border-primary bg-primary/5' : 'hover:border-primary/60',
        )}
      >
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shown}
            alt=""
            className={cn(
              'max-h-full max-w-full object-contain',
              kind === 'ICON' && 'size-16 rounded-lg',
            )}
          />
        ) : (
          <span
            className={cn(
              'flex flex-col items-center gap-1.5 text-xs',
              darkBg ? 'text-white/60' : 'text-slate-500',
            )}
          >
            <UploadCloud className="size-6" />
            Drop an image or click
          </span>
        )}
        {shown && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
            <ImageUp className="mr-1.5 size-4" /> Replace
          </span>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
      <div className="flex min-h-7 items-center justify-between gap-2">
        <p className="text-muted-foreground text-[11px] leading-snug">
          {pending && pending !== 'REMOVE' && pending.width
            ? `${pending.width} × ${pending.height} px · ${(pending.file.size / 1024).toFixed(0)} KB`
            : hint}
        </p>
        {pending ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onUndo}
          >
            <Undo2 className="size-3.5" /> Undo
          </Button>
        ) : (
          current && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive h-7 px-2 text-xs"
              onClick={onRemove}
            >
              <Trash2 className="size-3.5" /> Remove
            </Button>
          )
        )}
      </div>
    </div>
  );
}

// ---- Live preview --------------------------------------------------------------------------------

function previewVars(hex: string | null): CSSProperties {
  if (!hex) return {};
  const fg = contrast(hex, '#ffffff') >= contrast(hex, '#0b1220') ? '#ffffff' : '#0b1220';
  return {
    '--primary': hex,
    '--primary-foreground': fg,
    '--ring': hex,
    '--sidebar-primary': hex,
    '--sidebar-primary-foreground': fg,
  } as CSSProperties;
}

function MiniBrand({
  f,
  logo,
  icon,
  inverted,
}: {
  f: Fields;
  logo: string | null;
  icon: string | null;
  inverted?: boolean;
}) {
  if (logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logo} alt={f.product_name} className="h-6 w-auto max-w-[140px] object-contain" />
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-semibold">
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={icon} alt="" className="size-5 rounded object-contain" />
      ) : (
        <DefaultMark className="size-5" />
      )}
      <span className={cn('truncate', inverted ? 'text-white' : 'text-foreground')}>
        {f.product_name || 'Product name'}
      </span>
    </span>
  );
}

function Preview({ f, images }: { f: Fields; images: Record<Kind, string | null> }) {
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  // Dark tokens live on <html>; a light preview inside a dark dashboard isn't possible, so the
  // toggle is offered only while the dashboard itself is light.
  const appDark = useTheme().resolvedTheme === 'dark';
  const dark = appDark || mode === 'dark';
  return (
    <Card className="gap-0 overflow-hidden pt-0 shadow-none">
      <CardHeader className="border-b pt-4 [.border-b]:pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Monitor className="size-4" /> Live preview
          </CardTitle>
          {appDark ? (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <Moon className="size-3.5" /> Dark mode
            </span>
          ) : (
            <div
              className="bg-muted inline-flex rounded-md p-0.5"
              role="radiogroup"
              aria-label="Preview theme"
            >
              {(['light', 'dark'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={cn(
                    'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium',
                    mode === m ? 'bg-background shadow-sm' : 'text-muted-foreground',
                  )}
                >
                  {m === 'light' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
                  {m === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent
        className={cn('space-y-4 p-4', dark && 'dark')}
        style={previewVars(f.primary_color)}
      >
        {/* Browser tab */}
        <div className="bg-muted/60 rounded-lg border p-1.5">
          <div className="bg-background text-foreground flex max-w-[260px] items-center gap-2 rounded-md px-2.5 py-1.5 text-xs shadow-sm">
            {images.ICON ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={images.ICON} alt="" className="size-4 shrink-0 rounded-sm object-contain" />
            ) : (
              <DefaultMark className="size-4" />
            )}
            <span className="truncate">Dashboard · {f.product_name || 'Product name'}</span>
          </div>
        </div>

        {/* App */}
        <div className="bg-background text-foreground overflow-hidden rounded-lg border">
          <div className="flex h-40">
            <div className="bg-sidebar flex w-[42%] flex-col gap-2 p-2.5">
              <div className="border-sidebar-border mb-1 border-b pb-2">
                <MiniBrand f={f} logo={images.LOGO_DARK} icon={images.ICON} inverted />
              </div>
              <div className="bg-sidebar-primary text-sidebar-primary-foreground rounded px-2 py-1 text-[10px] font-medium">
                Dashboard
              </div>
              <div className="text-sidebar-foreground/70 px-2 text-[10px]">Payments</div>
              <div className="text-sidebar-foreground/70 px-2 text-[10px]">Payouts</div>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-3">
              <p className="text-xs font-semibold">Payments</p>
              <div className="flex gap-1.5">
                <span className="bg-primary text-primary-foreground rounded px-2 py-1 text-[10px] font-medium">
                  New payment
                </span>
                <span className="rounded border px-2 py-1 text-[10px]">Export</span>
              </div>
              <div className="bg-muted h-2 w-full rounded" />
              <div className="bg-muted h-2 w-4/5 rounded" />
              <p className="text-muted-foreground mt-auto truncate border-t pt-1.5 text-[9px]">
                © {new Date().getFullYear()} {f.company_name}
                {f.support_email ? ` · ${f.support_email}` : ''}
              </p>
            </div>
          </div>
        </div>

        {/* Sign-in */}
        <div className="overflow-hidden rounded-lg border">
          <div className="flex">
            <div className="bg-sidebar flex w-1/2 flex-col justify-between gap-3 p-3">
              <MiniBrand f={f} logo={images.LOGO_DARK} icon={images.ICON} inverted />
              <div>
                <p className="line-clamp-3 text-[11px] leading-snug font-semibold text-white">
                  {f.login_headline}
                </p>
                <p className="text-sidebar-muted mt-1 line-clamp-2 text-[9px]">{f.login_subtext}</p>
              </div>
            </div>
            <div className="bg-background text-foreground flex w-1/2 flex-col gap-1.5 p-3">
              <p className="text-[11px] font-semibold">Sign in</p>
              <div className="h-4 rounded border" />
              <div className="h-4 rounded border" />
              <div className="bg-primary text-primary-foreground rounded py-1 text-center text-[9px] font-medium">
                Sign in
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- Page ----------------------------------------------------------------------------------------

export function BrandSettings() {
  const saved = useBrand();
  // Remount on every saved version so the form resets to what the server now holds.
  return <Editor key={saved.version} saved={saved} />;
}

function Editor({ saved }: { saved: Brand }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [f, setF] = useState<Fields>(() => fieldsOf(saved));
  const [pending, setPending] = useState<Record<Kind, Pending>>({
    LOGO: null,
    LOGO_DARK: null,
    ICON: null,
  });
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [hex, setHex] = useState(saved.primary_color ?? '');

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const fieldsDirty = JSON.stringify(f) !== JSON.stringify(fieldsOf(saved));
  const assetsDirty = Object.values(pending).some(Boolean);
  const dirty = fieldsDirty || assetsDirty;

  const current = (k: Kind) => assetUrl(saved.assets[ASSET_KEY[k]]);
  const images: Record<Kind, string | null> = {
    LOGO: pending.LOGO === 'REMOVE' ? null : pending.LOGO ? pending.LOGO.url : current('LOGO'),
    LOGO_DARK:
      pending.LOGO_DARK === 'REMOVE'
        ? null
        : pending.LOGO_DARK
          ? pending.LOGO_DARK.url
          : current('LOGO_DARK'),
    ICON: pending.ICON === 'REMOVE' ? null : pending.ICON ? pending.ICON.url : current('ICON'),
  };

  const problems: string[] = [];
  if (f.product_name.trim().length < 2) problems.push('Product name is required');
  if (f.short_name.trim().length < 2) problems.push('Short name is required');
  if (f.company_name.trim().length < 2) problems.push('Company name is required');
  if (f.login_headline.trim().length < 2) problems.push('Sign-in headline is required');
  if (f.primary_color && !/^#[0-9a-f]{6}$/.test(f.primary_color))
    problems.push('Colour must look like #2563eb');
  if (f.support_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.support_email))
    problems.push('Support email is not valid');
  if (f.website_url && !/^https?:\/\/\S+$/.test(f.website_url))
    problems.push('Website must start with https://');
  if (Object.values(f).some((v) => typeof v === 'string' && /[<>]/.test(v)))
    problems.push('Text can’t contain < or >');

  async function pick(kind: Kind, file: File) {
    if (file.size > MAX) return toast.error('Images can be at most 1 MB');
    if (
      !/^image\/(png|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(file.type) &&
      !/\.(ico|svg)$/i.test(file.name)
    )
      return toast.error('Use a PNG, JPEG, WebP, SVG or ICO image');
    const url = URL.createObjectURL(file);
    const { width, height } = await measure(url);
    if (
      kind === 'ICON' &&
      width &&
      height &&
      Math.max(width, height) / Math.min(width, height) > 1.25
    )
      toast.warning(`The icon should be square (this one is ${width} × ${height})`);
    setPending((p) => {
      if (p[kind] && p[kind] !== 'REMOVE') URL.revokeObjectURL((p[kind] as { url: string }).url);
      return { ...p, [kind]: { file, url, width, height } };
    });
  }

  function resetDefaults() {
    setF({ ...BRAND_DEFAULTS });
    setHex('');
    setPending({
      LOGO: saved.assets.logo ? 'REMOVE' : null,
      LOGO_DARK: saved.assets.logo_dark ? 'REMOVE' : null,
      ICON: saved.assets.icon ? 'REMOVE' : null,
    });
    toast.info('Defaults loaded — save to apply');
  }

  async function save() {
    setSaving(true);
    const r = reason.trim();
    try {
      if (fieldsDirty)
        await apiRequest('/v1/brand', {
          method: 'PUT',
          body: { ...f, version: saved.version, reason: r },
        });
      for (const kind of ['LOGO', 'LOGO_DARK', 'ICON'] as const) {
        const p = pending[kind];
        if (p === 'REMOVE')
          await apiRequest(`/v1/brand/assets/${kind}/remove`, {
            method: 'POST',
            body: { reason: r },
          });
        else if (p) {
          const form = new FormData();
          form.append('reason', r);
          form.append('file', p.file);
          await apiUpload(`/v1/brand/assets/${kind}`, form);
        }
      }
      toast.success('Brand saved — it’s live for everyone');
      setConfirm(false);
      await qc.invalidateQueries({ queryKey: BRAND_KEY });
      router.refresh(); // title and favicon come from the server
    } catch (err) {
      toast.error(errorMessage(err));
      await qc.invalidateQueries({ queryKey: BRAND_KEY }); // keep whatever did save
    } finally {
      setSaving(false);
    }
  }

  const fg = f.primary_color
    ? contrast(f.primary_color, '#ffffff') >= contrast(f.primary_color, '#0b1220')
      ? '#ffffff'
      : '#0b1220'
    : null;
  const ratio = f.primary_color && fg ? contrast(f.primary_color, fg) : null;

  return (
    <div className="space-y-6 pb-24">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          <Section
            icon={ImageUp}
            title="Logo & icon"
            description="PNG, SVG, WebP, JPEG or ICO, up to 1 MB. Use transparent backgrounds. Without a logo, the icon and product name are shown."
          >
            <div className="grid gap-5 sm:grid-cols-3">
              {(
                [
                  ['LOGO', 'Logo', 'For light backgrounds · at least 24 px tall'],
                  ['LOGO_DARK', 'Logo on dark', 'Sidebar, sign-in panel, dark mode'],
                  ['ICON', 'Icon & favicon', 'Square · 64 × 64 or larger'],
                ] as const
              ).map(([kind, title, hint]) => (
                <AssetTile
                  key={kind}
                  kind={kind}
                  title={title}
                  hint={hint}
                  current={current(kind)}
                  pending={pending[kind]}
                  onPick={(file) => void pick(kind, file)}
                  onRemove={() => setPending((p) => ({ ...p, [kind]: 'REMOVE' }))}
                  onUndo={() => setPending((p) => ({ ...p, [kind]: null }))}
                />
              ))}
            </div>
          </Section>

          <Section
            icon={Type}
            title="Names"
            description="Used in the browser tab title, the sidebar, sign-in page and every email."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="b-product"
                label="Product name"
                hint="Browser title and emails, e.g. “Acme Payments”"
                count={f.product_name.length}
                max={60}
              >
                <Input
                  id="b-product"
                  value={f.product_name}
                  onChange={(e) => set('product_name', e.target.value)}
                  maxLength={60}
                />
              </Field>
              <Field
                id="b-short"
                label="Short name"
                hint="In sentences: “Sign in to your Acme account”"
                count={f.short_name.length}
                max={30}
              >
                <Input
                  id="b-short"
                  value={f.short_name}
                  onChange={(e) => set('short_name', e.target.value)}
                  maxLength={30}
                />
              </Field>
              <Field
                id="b-company"
                label="Company legal name"
                hint="Copyright line in the footer"
                count={f.company_name.length}
                max={160}
              >
                <Input
                  id="b-company"
                  value={f.company_name}
                  onChange={(e) => set('company_name', e.target.value)}
                  maxLength={160}
                />
              </Field>
              <Field
                id="b-tagline"
                label="Tagline"
                hint="Page description for browsers and link previews"
                count={f.tagline.length}
                max={160}
              >
                <Input
                  id="b-tagline"
                  value={f.tagline}
                  onChange={(e) => set('tagline', e.target.value)}
                  maxLength={160}
                />
              </Field>
            </div>
          </Section>

          <Section
            icon={Palette}
            title="Brand colour"
            description="Buttons, links, highlights and the active menu item, in light and dark mode."
          >
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  set('primary_color', null);
                  setHex('');
                }}
                className={cn(
                  'flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium',
                  !f.primary_color ? 'border-primary ring-primary/20 ring-2' : 'hover:bg-muted',
                )}
              >
                {!f.primary_color && <Check className="size-3.5" />} Default
              </button>
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Use ${c}`}
                  onClick={() => {
                    set('primary_color', c);
                    setHex(c);
                  }}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110',
                    f.primary_color === c && 'ring-foreground ring-2',
                  )}
                  style={{ backgroundColor: c }}
                >
                  {f.primary_color === c && <Check className="size-4 text-white" />}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Field id="b-hex" label="Custom colour">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Pick a colour"
                    value={f.primary_color ?? '#2b55c9'}
                    onChange={(e) => {
                      set('primary_color', e.target.value.toLowerCase());
                      setHex(e.target.value.toLowerCase());
                    }}
                    className="size-9 cursor-pointer rounded-md border bg-transparent p-0.5"
                  />
                  <Input
                    id="b-hex"
                    value={hex}
                    placeholder="#2563eb"
                    className="w-32 font-mono"
                    onChange={(e) => {
                      const v = e.target.value.trim().toLowerCase();
                      setHex(v);
                      if (/^#[0-9a-f]{6}$/.test(v)) set('primary_color', v);
                      else if (v === '') set('primary_color', null);
                    }}
                  />
                </div>
              </Field>
              {ratio !== null && (
                <div
                  className={cn(
                    'flex h-9 items-center gap-2 rounded-md border px-3 text-xs',
                    ratio >= 4.5
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-amber-700 dark:text-amber-400',
                  )}
                >
                  <span
                    className="rounded px-2 py-0.5 font-medium"
                    style={{ backgroundColor: f.primary_color!, color: fg! }}
                  >
                    Button
                  </span>
                  Contrast {ratio.toFixed(1)}:1{' '}
                  {ratio >= 4.5 ? '· readable' : '· low — pick a darker colour'}
                </div>
              )}
            </div>
          </Section>

          <Section
            icon={Monitor}
            title="Sign-in page"
            description="The panel beside the sign-in form."
          >
            <Field id="b-headline" label="Headline" count={f.login_headline.length} max={120}>
              <Input
                id="b-headline"
                value={f.login_headline}
                onChange={(e) => set('login_headline', e.target.value)}
                maxLength={120}
              />
            </Field>
            <Field id="b-subtext" label="Supporting text" count={f.login_subtext.length} max={300}>
              <Textarea
                id="b-subtext"
                rows={2}
                value={f.login_subtext}
                onChange={(e) => set('login_subtext', e.target.value)}
                maxLength={300}
              />
            </Field>
          </Section>

          <Section
            icon={Mail}
            title="Contact & footer"
            description="Shown in the footer, on the sign-in page and at the end of every email."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="b-email" label="Support email">
                <div className="relative">
                  <Mail className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                  <Input
                    id="b-email"
                    type="email"
                    className="pl-9"
                    value={f.support_email ?? ''}
                    onChange={(e) => set('support_email', e.target.value.trim() || null)}
                    placeholder="support@example.com"
                  />
                </div>
              </Field>
              <Field id="b-phone" label="Support phone">
                <div className="relative">
                  <Phone className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                  <Input
                    id="b-phone"
                    className="pl-9"
                    value={f.support_phone ?? ''}
                    onChange={(e) => set('support_phone', e.target.value || null)}
                    placeholder="+91 80 4000 0000"
                  />
                </div>
              </Field>
              <Field id="b-web" label="Website">
                <Input
                  id="b-web"
                  value={f.website_url ?? ''}
                  onChange={(e) => set('website_url', e.target.value.trim() || null)}
                  placeholder="https://example.com"
                />
              </Field>
              <Field
                id="b-footer"
                label="Footer note"
                hint="e.g. a regulatory or ownership line"
                count={(f.footer_text ?? '').length}
                max={200}
              >
                <Input
                  id="b-footer"
                  value={f.footer_text ?? ''}
                  onChange={(e) => set('footer_text', e.target.value || null)}
                  maxLength={200}
                />
              </Field>
            </div>
          </Section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <Preview f={f} images={images} />
          <Button variant="outline" className="w-full" onClick={resetDefaults}>
            <RotateCcw className="size-4" /> Load built-in defaults
          </Button>
        </aside>
      </div>

      {dirty && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="bg-background/95 supports-[backdrop-filter]:bg-background/80 flex w-full max-w-2xl flex-wrap items-center gap-3 rounded-xl border p-3 shadow-lg backdrop-blur">
            <span className="bg-primary size-2 animate-pulse rounded-full" />
            <span className="text-sm font-medium">Unsaved brand changes</span>
            {problems.length > 0 && <span className="text-destructive text-xs">{problems[0]}</span>}
            <div className="ml-auto flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setF(fieldsOf(saved));
                  setHex(saved.primary_color ?? '');
                  setPending({ LOGO: null, LOGO_DARK: null, ICON: null });
                }}
              >
                Discard
              </Button>
              <Button size="sm" disabled={problems.length > 0} onClick={() => setConfirm(true)}>
                <Save className="size-4" /> Save brand
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish brand changes?</DialogTitle>
            <DialogDescription>
              Everyone sees the new brand straight away: the dashboard, the sign-in page, browser
              tabs and new emails.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="b-reason">Reason (recorded in the audit log)</Label>
            <Textarea
              id="b-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button disabled={saving || reason.trim().length < 5} onClick={() => void save()}>
              {saving && <Loader2 className="size-4 animate-spin" />} Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
