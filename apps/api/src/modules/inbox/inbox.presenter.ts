import type { InboxNotification } from '@pay2all/database';

export function presentInbox(n: InboxNotification) {
  return {
    id: n.id,
    category: n.category,
    severity: n.severity,
    title: n.title,
    body: n.body,
    link: n.link,
    resource_type: n.resourceType,
    resource_id: n.resourceId,
    read: n.readAt !== null,
    read_at: n.readAt,
    created_at: n.createdAt,
  };
}
