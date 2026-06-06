import crypto from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import type { AppDb } from '@main/db/client';
import { projectSettings, projects, sshConnections, workspaces } from '@main/db/schema';

export type UpsertSshConnectionOptions = {
  id?: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  authType?: 'agent' | 'key';
  privateKeyPath?: string;
  useAgent?: boolean;
  sshConfigAlias?: string;
};

export type AddSshProjectOptions = {
  id?: string;
  name: string;
  path: string;
  connectionId: string;
  baseRef?: string;
  settings?: Record<string, unknown>;
  shareableSettings?: Record<string, unknown>;
};

function metadataFor(opts: Pick<UpsertSshConnectionOptions, 'sshConfigAlias'>): string {
  return JSON.stringify({ sshConfigAlias: opts.sshConfigAlias || undefined });
}

export async function upsertSshConnection(db: AppDb, opts: UpsertSshConnectionOptions) {
  const id = opts.id?.trim() || crypto.randomUUID();
  const port = opts.port ?? 22;
  const authType = opts.authType ?? (opts.privateKeyPath ? 'key' : 'agent');

  await db
    .insert(sshConnections)
    .values({
      id,
      name: opts.name,
      host: opts.host,
      port,
      username: opts.username,
      authType,
      privateKeyPath: opts.privateKeyPath ?? null,
      useAgent: opts.useAgent ? 1 : 0,
      metadata: metadataFor(opts),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .onConflictDoUpdate({
      target: sshConnections.id,
      set: {
        name: opts.name,
        host: opts.host,
        port,
        username: opts.username,
        authType,
        privateKeyPath: opts.privateKeyPath ?? null,
        useAgent: opts.useAgent ? 1 : 0,
        metadata: metadataFor(opts),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });

  const [row] = await db.select().from(sshConnections).where(eq(sshConnections.id, id)).limit(1);
  if (!row) throw new Error(`Failed to upsert SSH connection ${id}`);
  return row;
}

export async function listSshConnections(db: AppDb) {
  return db.select().from(sshConnections).orderBy(asc(sshConnections.name));
}

export async function addSshProject(db: AppDb, opts: AddSshProjectOptions) {
  const [connection] = await db
    .select()
    .from(sshConnections)
    .where(eq(sshConnections.id, opts.connectionId))
    .limit(1);
  if (!connection) {
    throw new Error(`SSH connection not found: ${opts.connectionId}`);
  }

  const id = opts.id?.trim() || crypto.randomUUID();
  const baseRef = opts.baseRef?.trim() || 'main';
  const workspaceKey = computeWorkspaceKey('project-ssh', opts.path, opts.connectionId);
  const workspaceId = `project-root-${id}`;
  let projectId = id;

  db.transaction((tx) => {
    tx
      .insert(projects)
      .values({
        id,
        name: opts.name,
        path: opts.path,
        workspaceProvider: 'ssh',
        baseRef,
        sshConnectionId: opts.connectionId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .onConflictDoUpdate({
        target: projects.path,
        set: {
          name: opts.name,
          workspaceProvider: 'ssh',
          baseRef,
          sshConnectionId: opts.connectionId,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      })
      .run();

    const [project] = tx
      .select()
      .from(projects)
      .where(and(eq(projects.path, opts.path), eq(projects.sshConnectionId, opts.connectionId)))
      .limit(1)
      .all();
    if (!project) throw new Error(`Failed to upsert SSH project ${opts.name}`);
    projectId = project.id;

    const [existingWorkspace] = tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.key, workspaceKey))
      .limit(1)
      .all();

    if (existingWorkspace) {
      tx
        .update(workspaces)
        .set({
          type: 'project-ssh',
          kind: 'project-root',
          location: 'remote',
          sshConnectionId: opts.connectionId,
          path: opts.path,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(workspaces.id, existingWorkspace.id))
        .run();
    } else {
      tx
        .insert(workspaces)
        .values({
          id: workspaceId,
          key: workspaceKey,
          type: 'project-ssh',
          kind: 'project-root',
          location: 'remote',
          sshConnectionId: opts.connectionId,
          path: opts.path,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .run();
    }

    const [workspace] = tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.key, workspaceKey))
      .limit(1)
      .all();
    if (!workspace) throw new Error(`Failed to upsert SSH project workspace ${opts.name}`);

    tx
      .update(projects)
      .set({ repositoryWorkspaceId: workspace.id, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(projects.id, project.id))
      .run();

    tx
      .insert(projectSettings)
      .values({
        projectId: project.id,
        baseProjectSettingsJson: JSON.stringify(opts.settings ?? {}),
        shareableProjectSettingsJson: JSON.stringify(opts.shareableSettings ?? {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .onConflictDoUpdate({
        target: projectSettings.projectId,
        set: {
          baseProjectSettingsJson: JSON.stringify(opts.settings ?? {}),
          shareableProjectSettingsJson: JSON.stringify(opts.shareableSettings ?? {}),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      })
      .run();
  });

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error(`Failed to read SSH project ${opts.name}`);
  return project;
}

export async function listSshProjects(db: AppDb) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.workspaceProvider, 'ssh'))
    .orderBy(asc(projects.name));
}
