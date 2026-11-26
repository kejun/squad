export interface ArtifactRequest { name: string; explicit: boolean; purpose?: 'extract' }

const quotedFilename = /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”|「([^」\n]+)」/;
const revisionCommand = new RegExp(/^(?:修改|修订|更新|改写)\s*(产物\s*)?/.source
  + `(?:${quotedFilename.source}|${/([^\s，,。；;！!？?]+)/.source})`);
const bareFilenameCharacter = /[^\s，,。；;！!？?`"'“”「」《》:]/.source;
const markdownSuffix = /\.(?:markdown|md)/.source;
const unquotedMarkdown = `${bareFilenameCharacter}+${markdownSuffix}`;
// Prefer a complete filename followed by punctuation or whitespace.
const separatedFilename = `(${unquotedMarkdown})${/(?=\s|[，,:：])/.source}`;
const locativeFilename = `(${bareFilenameCharacter}+?${markdownSuffix})${/(?=[中里内])/.source}`;
// The lookahead fixes the longest Markdown prefix before matching the operation.
const bareFilename = `(?=(?<filename>${unquotedMarkdown}))\\k<filename>`;
const extractionCommand = new RegExp(
  /^(?:从|基于|根据)\s*(?:上一轮|上轮|上一次|上次|前一轮)(?:\s*(?:已交付|交付)?的)?\s*(?:(?:Markdown(?:\s+产物)?|产物)\s+)?/.source
  + `(?:${quotedFilename.source}|${/《([^》\n]+)》/.source}|${separatedFilename}|${locativeFilename}|${bareFilename})`
  + /\s*(?:[中里内]\s*)?[，,:：]?\s*(?:提炼|提取|摘录|归纳|总结|概括)/.source, 'i');

function directArtifactText(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .split('\n').filter(line => !/^\s*>|^(?: {4}|\t)/.test(line)).join('\n').trim();
}

/** Only the target of a direct user command can select a delivered artifact. */
export function parseArtifactRequest(text: string): ArtifactRequest | undefined {
  const direct = directArtifactText(text).replace(/^(?:@[\w-]+\s+)?(?:(?:请|麻烦)\s*)?/, '');
  const revision = revisionCommand.exec(direct);
  const extraction = revision ? null : extractionCommand.exec(direct);
  const target = revision?.slice(2) ?? extraction?.slice(1);
  const name = target?.find(value => value !== undefined)?.trim();
  const explicit = !!revision?.[1] || !!extraction;
  if (!name || /[/\\:]/.test(name)
    || ((!explicit || extraction) && !/\.(?:md|markdown)$/i.test(name))) return undefined;
  return { name, explicit, ...(extraction ? { purpose: 'extract' } : {}) };
}

export type RequestedFile = { kind: 'attachment' }
  | { kind: 'name'; name: string }
  | { kind: 'format'; format: 'html' | 'markdown' };

const outputCommand = /输出(?:为|到)?|另存为|保存为|发布为|导出为|写入|命名为|附上(?:文件)?|\b(?:export|save|write)\s+(?:as|to)\b|\battach(?: the file)?\b/i;
const outputName = new RegExp(/^\s*[:：]?\s*/.source
  + `(?:${quotedFilename.source}|([^\\s，,。；;！？!?]+))`);
const attachmentRequest = /附上|附带|附在|另附|作为附件|以附件|\battach\b|\bas an attachment\b/i;
const fileOutput = /(?:交付|输出|提供|生成|发送|给我|导出|转成|转换[成为]|\b(?:deliver|return|provide|generate|send|export)\b)[^。；;]{0,32}(?:文件(?!的|内容|概要|说明)|附件|\b(?:file|attachment)s?\b)/i;
const conversionFormat = /(?:转成|转为|转换[成为]|\bconvert\b[^,，]{0,24}\bto\b)\s*(网页|html?|markdown)/i;
const filename = /\.[a-z][a-z0-9]{0,9}$/i;

/** Bind file delivery only from an explicit instruction in current user input. */
export function requestedFiles(text: string): RequestedFile[] {
  const clauses = directArtifactText(text).split(/[\n，。；！？;!?]|\.(?=\s|$)/);
  const requirements: RequestedFile[] = [];
  const quotes = new RegExp(quotedFilename.source, 'g');
  let converted: 'html' | 'markdown' | undefined;
  for (const clause of clauses) {
    const direct = clause.replace(quotes, quoted => ' '.repeat(quoted.length));
    if (/说明如何|解释如何|\bhow to\b/i.test(direct)
      || /(?:不要|不用|无需|不需要|不必|禁止|\b(?:do not|don't|no need to|without)\b).{0,24}(?:附件|文件|附上|附带|输出|另存|保存|写入|\b(?:file|attachment|attach|save|export|write)\b)/i.test(direct)) continue;
    const conversion = conversionFormat.exec(direct);
    if (conversion) converted = conversion[1]?.toLowerCase() === 'markdown' ? 'markdown' : 'html';
    const command = outputCommand.exec(direct);
    const name = command && outputName.exec(clause.slice(command.index + command[0].length))?.slice(1).find(value => value !== undefined)?.trim();
    if (name && !/[/\\:\x00-\x1f]/.test(name) && filename.test(name)) {
      requirements.push({ kind: 'name', name });
    } else if (attachmentRequest.test(direct) || fileOutput.test(direct)) {
      const format = /网页|\bhtml?\b/i.test(direct) ? 'html' : /\bmarkdown\b/i.test(direct) && !conversion ? 'markdown' : converted;
      requirements.push(format ? { kind: 'format', format } : { kind: 'attachment' });
    }
  }
  return requirements;
}
