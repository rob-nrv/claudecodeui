import { randomUUID } from 'node:crypto';

import {
  normalizeRegistryDisplayName,
  type ProjectNodeAssociation,
  type ProjectRegistry,
  type RegisteredProject,
} from '@/modules/project-registry/project-registry.contract.js';

/**
 * In-memory ProjectRegistry. Runs the same contract suite as the SQLite
 * adapter, so a future hosted adapter has an executable definition to meet,
 * and lets consumers be tested without a database.
 */
export function createInMemoryProjectRegistry(seed: {
  projects?: RegisteredProject[];
  associations?: ProjectNodeAssociation[];
  createProjectId?: () => string;
} = {}): ProjectRegistry {
  const projects = new Map((seed.projects ?? []).map((project) => [project.projectId, structuredClone(project)]));
  const associations = (seed.associations ?? []).map((association) => structuredClone(association));
  const createProjectId = seed.createProjectId ?? randomUUID;

  return {
    async listProjects(filter = 'active') {
      return [...projects.values()]
        .filter((project) => filter === 'all' || project.isArchived === (filter === 'archived'))
        .map((project) => structuredClone(project));
    },

    async getProject(projectId) {
      const project = projects.get(projectId);
      return project ? structuredClone(project) : null;
    },

    async registerProject(input) {
      const project: RegisteredProject = {
        projectId: createProjectId(),
        displayName: normalizeRegistryDisplayName(input.displayName),
        isStarred: false,
        isArchived: false,
        latestCheckpoint: null,
      };
      projects.set(project.projectId, project);
      return structuredClone(project);
    },

    async listNodeAssociations(projectId) {
      return associations
        .filter((association) => association.projectId === projectId)
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
        .map((association) => structuredClone(association));
    },
  };
}
