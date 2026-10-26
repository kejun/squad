#!/usr/bin/env node
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

export const report = '# 验证报告\n\n这是通过真实模型 HTTP 边界返回的完整产物。\n\n| 步骤 | 结果 |\n| --- | --- |\n| 保存 | 已完成 |\n\n来源：https://example.org/squad-verification\n';

// Replace only the production provider boundary; the app still parses, budgets,
// persists and renders these responses through its normal execution path.
export async function startFixture(log) {
  const counts = new Map();
  const pending = new Set();
  let cancelled = 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw new Error('Unexpected fixture route');
      if (req.headers.authorization) throw new Error('Fixture must receive no credentials');
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw new Error('Request too large'); }
      const request = JSON.parse(raw);
      const initial = request.messages.find(m => m.role === 'user');
      const { workId, context } = JSON.parse(initial.content);
      const match = /^You are (.+?), executing (\w+) work\./.exec(request.messages[0].content);
      if (!match || !workId) throw new Error('Production model protocol drift');
      const [, target, kind] = match;
      const goal = context.goal?.text ?? '';
      const key = `${goal}:${kind}:${target}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      const repair = request.messages.some(m => m.content.includes('model_output_validation_error'));
      appendFileSync(log, JSON.stringify({ workId, goal, target, kind, count, repair }) + '\n');
      const respond = output => res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
      if (goal.includes('VERIFY_STOP') && kind === 'owner' && count === 1) {
        pending.add(res);
        res.on('close', () => {
          pending.delete(res);
          cancelled++;
          appendFileSync(log, JSON.stringify({ event: 'request-cancelled', workId, goal, target, kind }) + '\n');
        });
        return; // Deliberately wait for the user's Stop action to abort HTTP.
      }
      if (goal.includes('VERIFY_RETRY') && kind === 'assistance' && count === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'VerificationInterrupted' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (kind === 'check') return respond(goal.includes('VERIFY_REPAIR') && !repair
        ? { type: 'check', passed: 'true' } : { type: 'check', passed: true, gaps: [] });
      if (kind === 'facilitator') return respond({ type: 'decision', decision: context.review?.status === 'pending'
        ? { action: 'review', reason: '用户请求评审', question: '核查现有报告', expected: '给出依据与改进项' }
        : { action: 'continue', reason: '继续原目标' } });
      if (kind === 'assistance') return respond({ type: 'answer', text: `${target} 已核查完成`, summary: `${target} 已核查完成` });
      if (goal.includes('VERIFY_RETRY') && count === 1) return respond({ type: 'help', target: 'B', question: '核查报告', expected: '依据' });
      if (goal.includes('VERIFY_RETRY') && count === 2) return respond({ type: 'askUser', question: '核查中断，请重试 B' });
      return respond({ type: 'deliver', text: '完整结果已保存到验证报告。', summary: '验证任务已完成，请查看报告。',
        artifacts: [{ name: 'verification-report.md', content: report }], artifactIds: [] });
    } catch (error) {
      appendFileSync(log, JSON.stringify({ fixtureError: error.message }) + '\n');
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: { code: 'FixtureFailure' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    get cancelled() { return cancelled; },
    async close() {
      for (const response of pending) response.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
