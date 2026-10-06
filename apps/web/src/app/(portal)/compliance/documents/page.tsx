'use client';

import { DocumentsSection } from '@/features/merchants/documents-section';
import { OwnApplication } from '@/features/merchants/own-application';

export default function DocumentsPage() {
  return (
    <OwnApplication title="Documents" description="KYC/KYB documents for your business and its directors.">
      {(app, { canUpload }) => <DocumentsSection app={app} canUpload={canUpload} />}
    </OwnApplication>
  );
}
