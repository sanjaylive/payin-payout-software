import { redirect } from 'next/navigation';

// Providers are now payment services of API vendors (Settings → API Vendors).
export default function Page() {
  redirect('/admin/settings/vendors');
}
