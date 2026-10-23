// Project permissions, stored as bit flags on each team member. Organisation members get project
// permissions from their organisation row for every project the organisation owns.
export const PERM = {
  UPLOAD_VERSION: 1,
  DELETE_VERSION: 2,
  EDIT_DETAILS: 4,
  EDIT_BODY: 8,
  MANAGE_INVITES: 16,
  REMOVE_MEMBER: 32,
  EDIT_MEMBER: 64,
  DELETE_PROJECT: 128,
  VIEW_ANALYTICS: 256,
  MODERATE_COMMENTS: 512,
  MANAGE_SETTINGS: 1024,
} as const;

export type PermName = keyof typeof PERM;
export const PERM_ALL = Object.values(PERM).reduce((a, b) => a | b, 0);
export const PERM_DEFAULT_MEMBER = PERM.UPLOAD_VERSION | PERM.DELETE_VERSION | PERM.EDIT_DETAILS | PERM.EDIT_BODY | PERM.VIEW_ANALYTICS;

export const PERM_LABELS: Record<PermName, string> = {
  UPLOAD_VERSION: 'Upload versions',
  DELETE_VERSION: 'Delete versions',
  EDIT_DETAILS: 'Edit details, links and images',
  EDIT_BODY: 'Edit the description',
  MANAGE_INVITES: 'Invite members',
  REMOVE_MEMBER: 'Remove members',
  EDIT_MEMBER: 'Change member permissions',
  DELETE_PROJECT: 'Delete the project',
  VIEW_ANALYTICS: 'View analytics',
  MODERATE_COMMENTS: 'Moderate comments',
  MANAGE_SETTINGS: 'Manage publishing and comment settings',
};

export const ORG_PERM = {
  EDIT_DETAILS: 1,
  MANAGE_INVITES: 2,
  REMOVE_MEMBER: 4,
  EDIT_MEMBER: 8,
  ADD_PROJECT: 16,
  REMOVE_PROJECT: 32,
  DELETE_ORG: 64,
} as const;

export type OrgPermName = keyof typeof ORG_PERM;
export const ORG_PERM_ALL = Object.values(ORG_PERM).reduce((a, b) => a | b, 0);

export const ORG_PERM_LABELS: Record<OrgPermName, string> = {
  EDIT_DETAILS: 'Edit the organisation profile',
  MANAGE_INVITES: 'Invite members',
  REMOVE_MEMBER: 'Remove members',
  EDIT_MEMBER: 'Change member permissions',
  ADD_PROJECT: 'Move projects into the organisation',
  REMOVE_PROJECT: 'Move projects out of the organisation',
  DELETE_ORG: 'Delete the organisation',
};

export function has(perms: number, flag: number): boolean {
  return (perms & flag) === flag;
}

// API token scopes.
export const SCOPE = {
  VERSIONS_WRITE: 1,
  PROJECTS_WRITE: 2,
  NOTIFICATIONS_READ: 4,
} as const;
export type ScopeName = keyof typeof SCOPE;
export const SCOPE_ALL = Object.values(SCOPE).reduce((a, b) => a | b, 0);
export const SCOPE_LABELS: Record<ScopeName, string> = {
  VERSIONS_WRITE: 'Create, upload and edit versions',
  PROJECTS_WRITE: 'Edit project details',
  NOTIFICATIONS_READ: 'Read your notifications',
};
