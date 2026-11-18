/** UI-only compatibility projection for historical single-line coordinator reports.
 * It is deliberately role-gated so user and member-authored Markdown headings remain intact.
 */
export function normalizeCoordinatorReportText(text: string, coordinatorFinal: boolean): string {
  if (!coordinatorFinal) return text;
  return !text.includes('\n') && text.startsWith('# 任务处理报告 ')
    ? text.replace(/^# /, '')
    : text;
}
