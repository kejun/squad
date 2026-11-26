export interface ArtifactRequest { name: string; explicit: boolean; purpose?: 'extract' }

const quotedFilename = /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”|「([^」\n]+)」/;
const revisionCommand = new RegExp(/^(?:修改|修订|更新|改写)\s*(产物\s*)?/.source
  + `(?:${quotedFilename.source}|${/([^\s，,。；;！!？?]+)/.source})`);
const bareFilenameCharacter = /[^\s，,。；;！!？?`"'“”「」《》:]/.source;
const markdownSuffix = /\.(?:markdown|md)/.source;
// A locative or full-width colon can mark the end of a compact filename.
const markedFilename = `(${bareFilenameCharacter}+?${markdownSuffix})${/(?=\s*[中里内：])/.source}`;
// The lookahead fixes the longest Markdown prefix before matching the operation.
const bareFilename = `(?=(?<filename>${bareFilenameCharacter}+${markdownSuffix}))\\k<filename>`;
const extractionCommand = new RegExp(
  /^(?:从|基于|根据)\s*(?:上一轮|上轮|上一次|上次|前一轮)(?:\s*(?:已交付|交付)?的)?\s*(?:(?:Markdown(?:\s+产物)?|产物)\s+)?/.source
  + `(?:${quotedFilename.source}|${/《([^》\n]+)》/.source}|${markedFilename}|${bareFilename})`
  + /\s*(?:[中里内]\s*)?[，,:：]?\s*(?:提炼|提取|摘录|归纳|总结|概括)/.source, 'i');

/** Only the target of a direct user command can select a delivered artifact. */
export function parseArtifactRequest(text: string): ArtifactRequest | undefined {
  const direct = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .split('\n').filter(line => !/^\s*>|^(?: {4}|\t)/.test(line)).join('\n').trim()
    .replace(/^(?:@[\w-]+\s+)?(?:(?:请|麻烦)\s*)?/, '');
  const revision = revisionCommand.exec(direct);
  const extraction = revision ? null : extractionCommand.exec(direct);
  const target = revision?.slice(2) ?? extraction?.slice(1);
  const name = target?.find(value => value !== undefined)?.trim();
  const explicit = !!revision?.[1] || !!extraction;
  if (!name || /[/\\:]/.test(name)
    || ((!explicit || extraction) && !/\.(?:md|markdown)$/i.test(name))) return undefined;
  return { name, explicit, ...(extraction ? { purpose: 'extract' } : {}) };
}
