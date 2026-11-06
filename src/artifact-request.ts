export interface ArtifactRequest { name: string; explicit: boolean }

/** Only the target of a direct user command can select a delivered artifact. */
export function parseArtifactRequest(text: string): ArtifactRequest | undefined {
  const direct = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .split('\n').filter(line => !/^\s*>|^(?: {4}|\t)/.test(line)).join('\n').trim();
  const command = /^(?:@[\w-]+\s+)?(?:(?:请|麻烦)\s*)?(?:修改|修订|更新|改写)\s*(产物\s*)?(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”|「([^」\n]+)」|([^\s，,。；;！!？?]+))/.exec(direct);
  if (!command) return undefined;
  const name = command.slice(2).find(value => value !== undefined)?.trim();
  const explicit = !!command[1];
  if (!name || /[/\\:]/.test(name)
    || (!explicit && !/\.(?:md|markdown)$/i.test(name))) return undefined;
  return { name, explicit };
}
