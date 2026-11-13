import type { Intent, TaskContext } from './types.js';
import type { ToolInventorySnapshot } from './tool-inventory.js';
import { withToolInventoryReadiness, type ToolInventoryView } from './cli-readiness.js';

function revealedCommands(c: TaskContext, work: Intent): Set<string> {
  const commands = new Set<string>();
  for (const intent of c.intents.filter(item => item.epoch === c.epoch && item.goalVersion === c.goalVersion)) {
    for (const operation of intent.localOperations ?? []) {
      if (operation.action.type === 'runCli') commands.add(operation.action.executable);
      if (operation.action.type !== 'discoverHost' || operation.status !== 'succeeded' || !operation.result?.ok) continue;
      const cli = operation.result.data.cli as { catalog?: { entries?: Array<{ command?: string }> } } | undefined;
      for (const entry of cli?.catalog?.entries ?? []) {
        if (typeof entry.command === 'string') commands.add(entry.command);
      }
    }
  }
  if (work.localOperations) {
    for (const operation of work.localOperations) {
      if (operation.action.type === 'runCli') commands.add(operation.action.executable);
    }
  }
  return commands;
}

function activatedSkillIds(c: TaskContext, work: Intent): Set<string> {
  const ids = new Set<string>();
  const intents = c.intents.filter(item => item.epoch === c.epoch && item.goalVersion === c.goalVersion);
  for (const intent of [...intents, work]) {
    for (const operation of intent.localOperations ?? []) {
      if (operation.action.type === 'loadSkill' && operation.status === 'succeeded' && operation.action.skillId) ids.add(operation.action.skillId);
      for (const binding of operation.skillBindings ?? []) ids.add(binding.skillId);
    }
  }
  return ids;
}

/** Progressive model view: interfaces and counts stay complete; metadata loads through discovery and activation. */
export function projectModelToolInventory(c: TaskContext, work: Intent, snapshot: ToolInventorySnapshot): ToolInventoryView {
  const commands = revealedCommands(c, work);
  const skills = activatedSkillIds(c, work);
  const includeConfiguredCatalog = snapshot.cli.configuration.source === 'configured'
    && snapshot.cli.entries.length > 0 && snapshot.cli.entries.length <= 64;
  const filtered = {
    ...snapshot,
    catalogProjection: 'progressive' as const,
    cli: {
      ...snapshot.cli,
      entryCount: snapshot.cli.entries.length,
      entries: includeConfiguredCatalog ? snapshot.cli.entries
        : snapshot.cli.entries.filter(entry => commands.has(entry.command)),
    },
    skills: {
      ...snapshot.skills,
      skillCount: snapshot.skills.skills.length,
      skills: snapshot.skills.skills.filter(skill => skills.has(skill.skillId)),
    },
  };
  return withToolInventoryReadiness(c, work, filtered);
}
