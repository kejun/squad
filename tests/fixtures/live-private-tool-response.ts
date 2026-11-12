/** Original first response from the three-sample selection smoke. No live request
 * is made by this fixture; the task URL and tool directory were controlled data. */
export const originalPrivateToolResponse = '{"type":"runCli","executable":"yuque","args":["doc","get","--url","https://www.yuque.com/example-team/october-work"],"execution":"host","reason":"用户要求整理语雀私有文档内容，该文档需要宿主现有账号认证才能读取，沙箱无账号配置。","timeoutMs":120000,"skillId":""}';
export const originalPrivateToolAction: Record<string, unknown> = JSON.parse(originalPrivateToolResponse) as Record<string, unknown>;
export const privateToolResponseProvenance = {
  source: 'db7c5636679b5907c4b3674b311e3702dec65caf',
  model: 'deepseek-v4.1-flash', modelRequests: 1,
  firstResponseProtocolValid: false, invalidField: 'skillId:""',
  promptTokens: 8798, completionTokens: 169,
};
