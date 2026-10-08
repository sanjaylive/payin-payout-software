# Branding (white label)

Super admins (`system.settings.manage`, platform staff) set the brand under **Admin → Settings → Brand**. A change applies to everyone as soon as it is saved: the dashboard, sign-in page, browser tab and new emails. Until anything is saved, the built-in Pay2All brand is used.

## 1. What can be set

| Setting | Where it shows |
| --- | --- |
| **Logo** (light backgrounds) | Mobile sign-in header, and any light surface. In dark mode, the dark logo is used instead when one is set. |
| **Logo on dark** | Sidebar, sign-in brand panel. |
| **Icon** (square) | Browser favicon and Apple touch icon. Shown next to the product name when there is no logo. |
| Product name | Browser title (`Page · Product`), emails, and the sidebar when there is no logo. |
| Short name | Sentences such as "Sign in to your Acme account" and email subjects. |
| Company legal name | Copyright line in the dashboard footer and sign-in panel. |
| Tagline | Page `<meta name="description">`. |
| Brand colour | Buttons, links, focus rings and the active menu item. In dark mode a lighter shade is used. Text on the colour is black or white, whichever contrasts more; the page shows the contrast ratio. |
| Sign-in headline and text | The panel beside the sign-in form. |
| Support email and phone | Dashboard footer, under the sign-in form, and the signature of every email. |
| Website and footer note | Sign-in panel and dashboard footer. |

**Editing:**
- **Batched publish:** all changes, including image uploads and removals, are published together with one **Publish** and one reason.
- **Live preview:** shows the result in light and dark mode before you publish.
- **Built-in defaults:** **Load built-in defaults** fills in the original brand; it still has to be published.

## 2. Images

- **Accepted formats:** PNG, JPEG, WebP, SVG, and ICO for icons only. Each image can be up to 1 MB and up to 4096 × 4096 px.
- **Type check:** the type is detected from the file's bytes, never from its name or the browser-supplied MIME type.
- **Size rules:**
  - Icons must be roughly square (aspect ratio up to 1.25); raster icons must be at least 32 px.
  - Raster logos must be at least 24 px tall.
- **SVG:** an SVG must be a plain drawing. The upload is refused if it contains:
  - scripts or event handlers;
  - `javascript:` URLs;
  - embedded content such as `foreignObject`, `iframe` or `use`;
  - external `href` / `url()` references or `@import`;
  - DTDs or entities.
- **Storage:** images are stored in the database (`brand_assets`) and served by `GET /v1/brand/assets/:kind?v=<hash>`.
- **Response headers:**
  - `Cache-Control: immutable` when the `v` hash matches, and an `ETag`;
  - `X-Content-Type-Options: nosniff`;
  - `Content-Security-Policy: default-src 'none'; …; sandbox`, so an SVG opened directly can run nothing;
  - `Cross-Origin-Resource-Policy: cross-origin`, so the web app can show it.
- **Web CSP:** the web app's `img-src` allows the API origin.

## 3. How it reaches each place

- **Server-rendered parts:** the title template, description and favicon are produced by `generateMetadata` in the root layout. The layout also writes the brand colour as CSS variables on `<html>` (`data-brand-color`), so the first paint is already branded.
  - **Fallback:** the server read times out after 1.5 s and falls back to the built-in brand, so a slow API never blocks pages.
  - **Internal address:** set `API_INTERNAL_URL` when the web server should reach the API on an internal address.
- **Client:** `BrandProvider` keeps the brand in React Query and updates the sidebar, footer and colour immediately after a save. It then calls `router.refresh()` to update the title and favicon.
- **API cache:** the API caches the brand for 15 s per node. The node that saved the change clears its cache at once.
- **Emails:** message text uses `{{product}}`, `{{short}}` and `{{company}}`. `NotificationsService` fills these in when the message is queued, and appends a signature with the product name and support contact.

## 4. API

| Route | Access | |
| --- | --- | --- |
| `GET /v1/brand` | Public | Names, colour, contact, sign-in text, `version`, and asset URLs with dimensions |
| `GET /v1/brand/assets/:kind` | Public | `LOGO` \| `LOGO_DARK` \| `ICON` |
| `PUT /v1/brand` | `system.settings.manage` | All text fields, `primary_color` (`#rrggbb` or null), optional `version` for an optimistic check (409 if stale), `reason` |
| `POST /v1/brand/assets/:kind` | `system.settings.manage` | multipart `file` + `reason` |
| `POST /v1/brand/assets/:kind/remove` | `system.settings.manage` | `{ reason }` |

**Text rules:** text fields are plain text; `<`, `>` and control characters are rejected. Every change is audited as `brand.updated`, `brand.asset_uploaded` or `brand.asset_removed`.

## 5. Not yet included

- **Per-reseller branding:** resellers and their merchants see the platform brand.
- **Custom email HTML templates and domains:** emails are text with the brand name and signature, sent from the configured sender address.
- **Custom fonts.**
