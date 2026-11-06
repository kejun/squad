import nodeAssert from 'node:assert/strict';
import { createTeamConfig } from '../team.config.js';
import { configureModelsFromEnv, resolveModel, validateConfig, findSkills, WorkFailure, CloudflareWebTools, type TeamConfig } from '../src/index.js';
import { webFixture, sourceUrl, webEnv } from './web-tools-fixture.js';
import { configuration } from './helpers.js';
import { mixedSourceSkills } from './skill-search-fixture.js';
import { requestedReviewTargets } from '../src/conversation.js';

/** Saves values and failures from the public call; Then performs these exact assertions without repeating I/O. */
export interface ContractObservation { verify(expected?: string): void }
function contractObservation(expected?: string): ContractObservation & { assert: typeof nodeAssert } {
  const checks: (() => void)[] = [];
  const snapshot = (value: unknown) => {
    try { return structuredClone(value); } catch { return value; }
  };
  const assert: typeof nodeAssert = ((value: unknown, message?: string) => {
    const observed = snapshot(value); checks.push(() => nodeAssert(observed, message));
  }) as typeof nodeAssert;
  for (const method of ['equal', 'notEqual', 'deepEqual', 'partialDeepStrictEqual'] as const) {
    Object.assign(assert, { [method]: (...args: unknown[]) => {
      const observed = args.map(snapshot);
      checks.push(() => Reflect.apply(nodeAssert[method], nodeAssert, observed));
    } });
  }
  assert.throws = ((action: () => unknown, ...expected: unknown[]) => {
    let failed = false; let failure: unknown;
    try { action(); } catch (error) { failed = true; failure = error; }
    checks.push(() => Reflect.apply(nodeAssert.throws, nodeAssert, [() => { if (failed) throw failure; }, ...expected]));
  }) as typeof nodeAssert.throws;
  assert.rejects = (async (action: (() => Promise<unknown>) | Promise<unknown>, ...expected: unknown[]) => {
    let failed = false; let failure: unknown;
    try { await (typeof action === 'function' ? action() : action); } catch (error) { failed = true; failure = error; }
    checks.push(() => {
      nodeAssert(failed, 'The public operation must reject');
      if (expected.length) Reflect.apply(nodeAssert.throws, nodeAssert, [() => { throw failure; }, ...expected]);
    });
  }) as typeof nodeAssert.rejects;
  return { assert, verify(expectedFromStep?: string) { if (expectedFromStep !== undefined) nodeAssert.equal(expectedFromStep, expected); nodeAssert(checks.length > 0, 'Then needs concrete observed values'); for (const check of checks) check(); } };
}

const configurationExpectations: Record<string, string> = {
  "离线配置": "五名成员且不启用模型服务",
  "成员模型覆盖": "A用planner，B用reviewer，三个builder分别用dev1、dev2、dev3；连接继承默认且密钥不入配置",
  "独立供应商凭据": "builder-3用other-model和独立地址凭据，A仍用default-model，配置不含密钥",
  "本地免密服务": "本地A无需密钥，改用其他地址的builder-3必须使用独立密钥",
  "角色请求参数": "协调用coordinator，检查用checker并采用温度0.2、输出8192和非JSON模式",
  "角色上下文额度": "负责人窗口64000，检查窗口16000",
  "换模型不继承窗口": "换用checker后不继承其他模型的64000窗口",
  "配置解析不改原对象": "原团队配置逐字段保持原样",
  "空地址": "拒绝配置且不回显敏感输入",
  "非法JSON模式": "拒绝配置且不回显敏感输入",
  "无限温度": "拒绝配置且不回显敏感输入",
  "负输出额度": "拒绝配置且不回显敏感输入",
  "畸形附加JSON": "拒绝配置且不回显敏感输入",
  "覆盖消息字段": "拒绝配置且不回显敏感输入",
  "意图独立模型": "理解输入用parser且改用独立INTENT_MODEL_API_KEY",
  "非法意图开关": "拒绝非布尔的输入理解开关",
  "网页默认配置": "默认启用网页能力且配置不保存令牌",
  "网页显式关闭": "网页能力明确关闭",
  "非法网页开关": "拒绝非布尔的网页开关",
  "独立角色服务映射": "负责人用main，B协助和协调用fast，检查用review",
  "缺省角色服务回退": "未配置协调和检查服务时检查使用main"
};
const searchExpectations: Record<string, string> = {
  "合法空结果": "成功返回空数组",
  "HTTP503": "明确失败并保留503",
  "畸形结果": "明确报技能搜索结果格式错误",
  "空查询": "报查询不能为空且不请求供应商",
  "预先取消": "拒绝执行且不请求供应商",
  "仓库和域名混合结果": "按安装量71和14排序，域名技能保留标识、来源、名称和规范链接"
};
const webExpectations: Record<string, string> = {
  "搜索返回九项长摘要": "返回五项且可读摘要有界，同时保留请求标识和供应商",
  "网页为PDF": "按multipart提交原PDF，保留文件类型和内容，返回带不可信标记的转换正文",
  "无凭据读取Markdown": "无需密钥返回协商得到的正文",
  "无凭据读取原始HTML": "按用户要求返回原始HTML",
  "无凭据转换HTML": "报转换未配置且不向其他地址发送请求",
  "正文51字节而上限50": "拒绝并报正文过大",
  "服务器返回404正文": "保留404状态与原正文，不冒充成功页面",
  "拒绝私网 http://10.0.0.1/": "拒绝地址且不请求目标",
  "拒绝私网 http://192.168.1.1/": "拒绝地址且不请求目标",
  "拒绝私网 http://169.254.169.254/": "拒绝地址且不请求目标",
  "拒绝私网 http://[::ffff:127.0.0.1]/": "拒绝地址且不请求目标",
  "拒绝私网 https://host.internal/": "拒绝地址且不请求目标",
  "地址不在允许域名中": "拒绝地址且不请求目标",
  "HTTPS重定向到HTTP": "拒绝降级且只请求原HTTPS地址",
  "搜索返回合法空数组": "返回合法空资料",
  "搜索返回畸形对象": "报搜索不可用，不把畸形响应当空资料",
  "请求中令牌被轮换且原请求鉴权失败": "保留HTTP401并移除原令牌及供应商回显",
  "转换返回HTTP401": "报安全401错误且不自动重试",
  "转换返回HTTP429": "报安全429错误并标明可按额度重试",
  "转换返回HTTP500": "报安全500错误并标明可按额度重试",
  "转换请求尚未返回时取消": "取消信号传到转换请求且原操作拒绝",
  "搜索抓取前已经取消": "两种操作均拒绝且不请求供应商"
};

const defaults = { MODEL_BASE_URL: 'https://provider.example/v1', MODEL_NAME: 'default-model', MODEL_API_KEY: 'test-private-key' };
const invalidEnvironment: Record<string, Record<string, string>> = {
  '空地址': { MODEL_BASE_URL: '' }, '非法JSON模式': { MODEL_JSON_MODE: 'sometimes' },
  '无限温度': { MODEL_TEMPERATURE: 'Infinity' }, '负输出额度': { MODEL_MAX_TOKENS: '-1' },
  '畸形附加JSON': { MODEL_EXTRA_BODY: '{private-invalid-value' }, '覆盖消息字段': { MODEL_EXTRA_BODY: '{"messages":[]}' },
};
export function verifyConfigurationContract(rule: string, expected: string) {
  const observation = contractObservation(expected); const assert: typeof nodeAssert = observation.assert;
  assert.equal(expected, configurationExpectations[rule], "场景预期必须对应实际断言的配置结果");
  const invalid = invalidEnvironment[rule];
  if (invalid) {
    assert.throws(() => createTeamConfig({ ...defaults, ...invalid }), error => error instanceof Error && !error.message.includes('private-invalid-value'));
    return observation;
  }
  switch (rule) {
    case '离线配置': {
      const c = createTeamConfig({}); assert.equal(c.bots.length, 5); assert.equal(c.models, undefined); break;
    }
    case '成员模型覆盖': {
      const c = createTeamConfig({ ...defaults, A_MODEL_NAME: 'planner', B_MODEL_NAME: 'reviewer', BUILDER_1_MODEL_NAME: 'dev1', BUILDER_2_MODEL_NAME: 'dev2', BUILDER_3_MODEL_NAME: 'dev3' });
      assert.deepEqual(['A', 'B', 'builder-1', 'builder-2', 'builder-3'].map(id => {
        const service = resolveModel(c, 'owner', id)?.service;
        return { baseUrl: service?.baseUrl, model: service?.model, apiKeyEnv: service?.apiKeyEnv };
      }), [
        { baseUrl: defaults.MODEL_BASE_URL, model: 'planner', apiKeyEnv: 'MODEL_API_KEY' },
        { baseUrl: defaults.MODEL_BASE_URL, model: 'reviewer', apiKeyEnv: 'MODEL_API_KEY' },
        { baseUrl: defaults.MODEL_BASE_URL, model: 'dev1', apiKeyEnv: 'MODEL_API_KEY' },
        { baseUrl: defaults.MODEL_BASE_URL, model: 'dev2', apiKeyEnv: 'MODEL_API_KEY' },
        { baseUrl: defaults.MODEL_BASE_URL, model: 'dev3', apiKeyEnv: 'MODEL_API_KEY' },
      ]); assert(!JSON.stringify(c).includes(defaults.MODEL_API_KEY)); break;
    }
    case '独立供应商凭据': {
      const c = createTeamConfig({ ...defaults, BUILDER_3_MODEL_BASE_URL: 'https://other.example/v1', BUILDER_3_MODEL_NAME: 'other-model', BUILDER_3_MODEL_API_KEY: 'other-private-key' });
      assert.partialDeepStrictEqual(resolveModel(c, 'owner', 'builder-3')?.service, { baseUrl: 'https://other.example/v1', model: 'other-model', apiKeyEnv: 'BUILDER_3_MODEL_API_KEY' });
      assert(!JSON.stringify(c).includes('other-private-key')); assert.equal(resolveModel(c, 'owner', 'A')?.service.model, 'default-model'); break;
    }
    case '本地免密服务': {
      const c = createTeamConfig({ MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', MODEL_NAME: 'local', MODEL_NO_AUTH: 'true', BUILDER_3_MODEL_BASE_URL: 'https://other.example/v1' });
      assert.equal(resolveModel(c, 'owner', 'A')?.service.apiKeyEnv, undefined);
      assert.equal(resolveModel(c, 'owner', 'builder-3')?.service.apiKeyEnv, 'BUILDER_3_MODEL_API_KEY'); break;
    }
    case '角色请求参数': {
      const c = createTeamConfig({ ...defaults, FACILITATOR_MODEL_NAME: 'coordinator', CHECK_MODEL_NAME: 'checker', MODEL_TEMPERATURE: '0.2', MODEL_MAX_TOKENS: '8192', MODEL_EXTRA_BODY: '{"enable_thinking":false}', CHECK_MODEL_JSON_MODE: 'false' });
      assert.equal(resolveModel(c, 'facilitator', 'facilitator')?.service.model, 'coordinator');
      assert.partialDeepStrictEqual(resolveModel(c, 'check', 'facilitator')?.service, { model: 'checker', jsonMode: false, temperature: 0.2, maxTokens: 8192, extraBody: { enable_thinking: false } }); break;
    }
    case '角色上下文额度': {
      const c = createTeamConfig({ ...defaults, MODEL_CONTEXT_WINDOW_TOKENS: '64000', CHECK_MODEL_NAME: 'checker', CHECK_MODEL_CONTEXT_WINDOW_TOKENS: '16000' });
      assert.equal(resolveModel(c, 'owner', 'A')?.service.contextWindowTokens, 64000);
      assert.equal(resolveModel(c, 'check', 'facilitator')?.service.contextWindowTokens, 16000); break;
    }
    case '换模型不继承窗口': {
      const c = createTeamConfig({ ...defaults, MODEL_CONTEXT_WINDOW_TOKENS: '64000', CHECK_MODEL_NAME: 'checker' });
      assert.equal(resolveModel(c, 'check', 'facilitator')?.service.contextWindowTokens, undefined); break;
    }
    case '配置解析不改原对象': {
      const base = createTeamConfig({}); const before = structuredClone(base);
      configureModelsFromEnv(base, { ...defaults, A_MODEL_NAME: 'planner' }); assert.deepEqual(base, before); break;
    }
    case '意图独立模型': {
      const c = createTeamConfig({ MODEL_BASE_URL: 'https://default.example/v1', MODEL_NAME: 'base', MODEL_API_KEY: 'private',
        FACILITATOR_MODEL_NAME: 'coordinator', INTENT_MODEL_NAME: 'parser', INTENT_MODEL_BASE_URL: 'https://parser.example/v1' });
      assert.partialDeepStrictEqual(resolveModel(c, 'interpretation', 'facilitator')?.service, { model: 'parser', apiKeyEnv: 'INTENT_MODEL_API_KEY' }); break;
    }
    case '非法意图开关': assert.throws(() => createTeamConfig({ SQUAD_INTENT_ANALYSIS_ENABLED: 'sometimes' })); break;
    case '网页默认配置': {
      const c = createTeamConfig(webEnv); assert.deepEqual(c.webTools, { enabled: true }); assert(!JSON.stringify(c).includes(webEnv.CLOUDFLARE_API_TOKEN)); break;
    }
    case '网页显式关闭': assert.deepEqual(createTeamConfig({ ...webEnv, SQUAD_WEB_TOOLS_ENABLED: 'false' }).webTools, { enabled: false }); break;
    case '非法网页开关': assert.throws(() => createTeamConfig({ SQUAD_WEB_TOOLS_ENABLED: 'perhaps' })); break;
    case '独立角色服务映射': case '缺省角色服务回退': {
      const c = configuration(); c.models = { default: 'main', facilitator: 'fast', check: 'review', services: {
        main: { baseUrl: 'https://models.example/v1', model: 'main-model', apiKeyEnv: 'TEST_MODEL_KEY' },
        fast: { baseUrl: 'https://models.example/compatible-mode/v1/', model: 'fast-model' },
        review: { baseUrl: 'https://review.example/api/v1', model: 'review-model', jsonMode: false },
      } }; c.bots[1]!.model = 'fast';
      if (rule === '缺省角色服务回退') {
        delete c.models.check; delete c.models.facilitator; assert.equal(resolveModel(c, 'check', 'facilitator')?.serviceId, 'main');
      } else {
        assert.equal(resolveModel(c, 'owner', 'A')?.serviceId, 'main'); assert.equal(resolveModel(c, 'assistance', 'B')?.serviceId, 'fast');
        assert.equal(resolveModel(c, 'facilitator', 'facilitator')?.serviceId, 'fast'); assert.equal(resolveModel(c, 'check', 'facilitator')?.serviceId, 'review');
      }
      break;
    }
    default: throw new Error(`Unknown configuration contract ${rule}`);
  }
  return observation;
}

export function verifyInvalidServiceConfiguration(kind: string) {
  const observation = contractObservation(); const assert: typeof nodeAssert = observation.assert;
  const c = configuration(); c.models = { default: 'main', services: { main: { baseUrl: 'https://provider.example/v1', model: 'main' } } };
  const changes: Record<string, (config: TeamConfig) => void> = {
    '缺少普通额度': config => { (config.limits as unknown as Record<string, unknown>).ordinary = undefined; },
    '无限普通额度': config => { config.limits.ordinary = Infinity; },
    '未知成员模型': config => { config.bots[0]!.model = 'missing'; },
    '地址内嵌凭据': config => { config.models!.services.main!.baseUrl = 'https://user:password@provider.example/v1'; },
    '请求覆盖消息': config => { config.models!.services.main!.extraBody = { messages: [] }; },
    '负token上限': config => { config.models!.services.main!.maxTokens = -1; },
    '未知意图模型': config => { config.models!.intent = 'unknown'; },
    '网页开关为字符串': config => { config.webTools = { enabled: 'true' as unknown as boolean }; },
  };
  const change = changes[kind]; assert(change); change(c);
  if (kind === '缺少普通额度') assert.throws(() => validateConfig(c), /Missing finite limit/);
  else if (kind === '未知意图模型') assert.throws(() => validateConfig(c), /Unknown model service/);
  else if (kind === '网页开关为字符串') assert.throws(() => validateConfig(c), /Invalid web tools configuration/);
  else assert.throws(() => validateConfig(c));
  return observation;
}

export async function verifySearchFailureContract(kind: string, expected: string) {
  const observation = contractObservation(expected); const assert: typeof nodeAssert = observation.assert;
  assert.equal(expected, searchExpectations[kind], "场景预期必须对应实际断言的发现结果");
  const signal = new AbortController().signal;
  if (kind === '仓库和域名混合结果') {
    const skills = await findSkills('general purpose assistant skills', signal, async () => Response.json({ skills: mixedSourceSkills }));
    assert.deepEqual(skills.map(skill => skill.installs), [71, 14]);
    assert.deepEqual(skills[1], { id: 'skills.volces.com/gemini-assistant', source: 'skills.volces.com', name: 'gemini-assistant', installs: 14,
      url: 'https://skills.sh/skills.volces.com/gemini-assistant' }); return observation;
  }
  if (kind === '合法空结果') { assert.deepEqual(await findSkills('review', signal, async () => Response.json({ skills: [] })), []); return observation; }
  if (kind === 'HTTP503') { await assert.rejects(findSkills('review', signal, async () => new Response('', { status: 503 })), /503/); return observation; }
  if (kind === '畸形结果') { await assert.rejects(findSkills('review', signal, async () => Response.json({ skills: [{}] })), /Invalid skill search result/); return observation; }
  let calls = 0; const transport: typeof fetch = async () => { calls++; return Response.json({ skills: [] }); };
  if (kind === '空查询') await assert.rejects(findSkills(' ', signal, transport), /requires a query/);
  else if (kind === '预先取消') { const controller = new AbortController(); controller.abort(); await assert.rejects(findSkills('review', controller.signal, transport)); }
  else throw new Error(`Unknown search contract ${kind}`);
  assert.equal(calls, 0);
  return observation;
}

export function verifyNonAuthorizingReviewText(text: string, expression: string) {
  const format = expression === '普通正文' ? text : expression === '引用行' ? `> ${text}` : expression === '代码块' ? `\`\`\`\n${text}\n\`\`\`` : undefined;
  nodeAssert.notEqual(format, undefined);
  return { targets: requestedReviewTargets(format!, [], configuration().bots, 'A') };
}

export async function verifyWebBoundaryContract(kind: string, expected: string) {
  const observation = contractObservation(expected); const assert: typeof nodeAssert = observation.assert;
  assert.equal(expected, webExpectations[kind], "场景预期必须对应实际断言的网页结果");
  const signal = new AbortController().signal;
  if (kind.startsWith('拒绝私网 ')) {
    const f = webFixture(); await assert.rejects(f.tools.fetch({ url: kind.slice(5) }, signal), /web_fetch_disallowed_url/); assert.equal(f.calls.length, 0); return observation;
  }
  const f = webFixture();
  switch (kind) {
    case '搜索返回九项长摘要': {
      f.state.searchItems = Array.from({ length: 9 }, () => ({ url: sourceUrl, title: 'Source', description: 'Long source '.repeat(1000) }));
      const result = await f.tools.search({ query: 'SDK', limit: 99 }, signal);
      assert.equal(result.output.items.length, 5); assert(result.text.length < 4000); assert(result.output.items[0]!.description!.length > 600);
      assert.equal(result.output.metadata.requestId, 'search-1'); assert.equal(result.output.provider, 'exa'); break;
    }
    case '网页为PDF': {
      f.state.type = 'application/pdf'; f.state.content = '%PDF fixture';
      const result = await f.tools.fetch({ url: sourceUrl }, signal);
      const conversion = f.calls[1]!; const file = (conversion.init!.body as FormData).get('files') as File;
      assert.equal(conversion.url, `https://api.cloudflare.com/client/v4/accounts/${webEnv.CLOUDFLARE_ACCOUNT_ID}/ai/tomarkdown`);
      assert.equal(conversion.init!.redirect, 'error'); assert.equal(file.name, 'document.pdf'); assert.equal(file.type, 'application/pdf');
      assert.equal(await file.text(), '%PDF fixture'); assert.equal(result.output.via, 'converted'); assert(result.text.includes('<untrusted_web_content>')); break;
    }
    case '无凭据读取Markdown': case '无凭据读取原始HTML': case '无凭据转换HTML': {
      const local = webFixture({ env: {} });
      if (kind === '无凭据读取Markdown') { assert.equal((await local.tools.fetch({ url: sourceUrl }, signal)).output.via, 'markdown-negotiated'); break; }
      local.state.type = 'text/html'; local.state.content = '<p>raw</p>';
      if (kind === '无凭据读取原始HTML') { assert.equal((await local.tools.fetch({ url: sourceUrl, format: 'raw' }, signal)).output.content, '<p>raw</p>'); break; }
      await assert.rejects(local.tools.fetch({ url: sourceUrl }, signal), /WEB_TOOLS_NOT_CONFIGURED/); assert(local.calls.every(call => call.url === sourceUrl)); break;
    }
    case '正文51字节而上限50': case '服务器返回404正文': {
      const small = webFixture({ maxBytes: 50 }); small.state.content = 'x'.repeat(51);
      if (kind === '正文51字节而上限50') { await assert.rejects(small.tools.fetch({ url: sourceUrl }, signal), /web_fetch_too_large/); break; }
      small.state.content = 'not found'; small.state.status = 404;
      const result = await small.tools.fetch({ url: sourceUrl }, signal); assert.equal(result.output.status, 404); assert(result.text.includes('404')); assert.equal(result.output.content, 'not found'); break;
    }
    case '地址不在允许域名中': case 'HTTPS重定向到HTTP': {
      const restricted = new CloudflareWebTools({ transport: f.transport, allowedHosts: ['docs.example'] });
      if (kind === '地址不在允许域名中') { await assert.rejects(restricted.fetch({ url: sourceUrl }, signal), /web_fetch_disallowed_url/); assert.equal(f.calls.length, 0); break; }
      f.state.redirect = 'http://public.example/'; await assert.rejects(f.tools.fetch({ url: sourceUrl }, signal), /web_fetch_disallowed_redirect/); assert.equal(f.calls.length, 1); break;
    }
    case '搜索返回合法空数组': case '搜索返回畸形对象': {
      if (kind === '搜索返回合法空数组') { f.state.searchItems = []; assert.deepEqual((await f.tools.search({ query: 'SDK' }, signal)).output.items, []); break; }
      f.state.custom = async () => Response.json({ message: webEnv.CLOUDFLARE_API_TOKEN }); await assert.rejects(f.tools.search({ query: 'SDK' }, signal), /web_search_unavailable/); break;
    }
    case '请求中令牌被轮换且原请求鉴权失败': {
      const env = { ...webEnv, CLOUDFLARE_API_TOKEN: 'old_file_token' }; const changing = webFixture({ env });
      changing.state.custom = async () => { env.CLOUDFLARE_API_TOKEN = 'new_file_token'; return Response.json({ ok: false, error: { category: 'auth', code: 'web_search_old_file_token', status: 401, retryable: false } }, { status: 401 }); };
      await assert.rejects(changing.tools.search({ query: 'SDK' }, signal), error => error instanceof WorkFailure && error.message === 'web_search_failed (HTTP 401)'); break;
    }
    case '转换请求尚未返回时取消': {
      let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
      const controller = new AbortController(); let aborted = false;
      f.state.custom = async (url, init) => String(url).endsWith('/ai/tomarkdown') ? new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true }); started();
      }) : new Response('<p>convert</p>', { headers: { 'content-type': 'text/html' } });
      const result = f.tools.fetch({ url: sourceUrl }, controller.signal); await start; controller.abort(); await assert.rejects(result); assert(aborted); break;
    }
    case '搜索抓取前已经取消': {
      const controller = new AbortController(); controller.abort(); await assert.rejects(f.tools.search({ query: 'SDK' }, controller.signal)); await assert.rejects(f.tools.fetch({ url: sourceUrl }, controller.signal)); assert.equal(f.calls.length, 0); break;
    }
    case '转换返回HTTP401': case '转换返回HTTP429': case '转换返回HTTP500': {
      const status = Number(kind.slice('转换返回HTTP'.length));
      f.state.custom = async url => String(url).endsWith('/ai/tomarkdown') ? new Response(webEnv.CLOUDFLARE_API_TOKEN, { status }) : new Response('<h1>test</h1>', { headers: { 'content-type': 'text/html' } });
      await assert.rejects(f.tools.fetch({ url: sourceUrl }, signal), error => error instanceof WorkFailure && error.message === `web_fetch_conversion_failed (HTTP ${status})` && error.transient === (status !== 401) && !error.message.includes(webEnv.CLOUDFLARE_API_TOKEN)); break;
    }
    default: throw new Error(`Unknown web boundary ${kind}`);
  }
  return observation;
}

export async function verifyHistoricalMessageBudget() {
  const { initialTask } = await import('../src/task.machine.js');
  const { localModelInput } = await import('./local-model-fixture.js');
  const { conversationHistory } = await import('../src/conversation.js');
  const base = initialTask(localModelInput()).context;
  const original = { ...base, messages: Array.from({ length: 150 }, (_, index) => ({ ...base.messages[0]!, id: `m${index}`, at: index, text: 'x'.repeat(2000) })) };
  const before = structuredClone(original.messages); const history = conversationHistory([original]);
  return { history, originalMessages: original.messages, before };
}
