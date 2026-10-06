'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { OwnApplication } from '@/features/merchants/own-application';
import { PeopleSection } from '@/features/merchants/people-section';
import { ProfileForm } from '@/features/merchants/profile-form';

export default function BusinessProfilePage() {
  return (
    <OwnApplication title="Business profile" description="Tell us about your business. Our compliance team reviews it before you go live." showRequirements>
      {(app, { canEdit }) => (
        <Tabs defaultValue="business">
          <TabsList>
            <TabsTrigger value="business">Business details</TabsTrigger>
            <TabsTrigger value="people">Directors & owners ({app.persons.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="business" className="mt-4"><ProfileForm key={app.version} app={app} readOnly={!canEdit} /></TabsContent>
          <TabsContent value="people" className="mt-4"><PeopleSection app={app} canEdit={canEdit} /></TabsContent>
        </Tabs>
      )}
    </OwnApplication>
  );
}
