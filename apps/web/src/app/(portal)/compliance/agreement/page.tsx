'use client';

import { DocumentsSection } from '@/features/merchants/documents-section';
import { OwnApplication } from '@/features/merchants/own-application';

export default function AgreementPage() {
  return (
    <OwnApplication title="Agreement" description="Your signed merchant agreement with Pay2All.">
      {(app, { canUpload }) => (
        <DocumentsSection
          app={app}
          canUpload={canUpload}
          onlyType="AGREEMENT"
          title="Merchant agreement"
          description="Download, sign and upload the agreement shared by your account manager. Pay2All countersigns during review."
        />
      )}
    </OwnApplication>
  );
}
