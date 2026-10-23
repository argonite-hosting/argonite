import type { Notification } from '../../../shared/types';
import { t } from './i18n';

const STATUS: Record<string, string> = {
  'scan.clean': '{project} {version} is live',
  'version.approve': '{project} {version} was approved and is live',
  'version.restore': '{project} {version} was restored',
  'scan.review': '{project} {version} is waiting for a moderator',
  'scan.malicious': '{project} {version} was rejected by the scanner',
  'scan.duplicate': '{project} {version} was rejected as a duplicate',
  'version.reject': '{project} {version} was rejected by a moderator',
  'version.revoke': '{project} {version} was revoked by a moderator',
  'version.publish_failed': '{project} {version} could not be published on GitHub yet',
  'version.integrity_failed': '{project} {version} no longer matches its scanned file',
};

export function notificationText(n: Notification): { title: string; body: string } {
  const p = n.params ?? {};
  switch (n.kind) {
    case 'version':
      return { title: t('{project} {version}', p), body: t('New version of a project you follow') };
    case 'invite':
      return { title: t('Invite to {project}', p), body: t('You were invited to join the project team') };
    case 'org_invite':
      return { title: t('Invite to {org}', p), body: t('You were invited to join the organisation') };
    case 'comment':
      return { title: t('{user} commented on {project}', p), body: t('New comment on your project') };
    case 'reply':
      return { title: t('{user} replied to you', p), body: t('On {project}', p) };
    case 'mod_message':
      return { title: t('Message from the moderators'), body: t('About {project}', p) };
    case 'version_status':
      return { title: t(STATUS[p.action] ?? '{project} {version} changed', p), body: t('Update on your upload') };
    default:
      return { title: n.title, body: n.body };
  }
}
