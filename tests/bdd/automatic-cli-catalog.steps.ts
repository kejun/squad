import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { automaticCatalogAcceptance, automaticCatalogRefreshAcceptance, largeDiscoveryAcceptance, unlimitedCatalogAcceptance } from '../automatic-cli-catalog-acceptance.js';

interface State { documented?: boolean; unrelatedManual?: boolean; report?: Awaited<ReturnType<typeof automaticCatalogAcceptance>>; complete?: boolean }
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => { let value = states.get(world); if (!value) { value = {}; states.set(world, value); } return value; };
Given('宿主PATH中有附带安装包说明的可执行工具且未配置CLI目录', function(this: SpecWorld) { state(this).documented = true; });
Given('宿主PATH中可执行工具的资料情况为{string}', function(this: SpecWorld, condition: string) { state(this).documented = false; state(this).unrelatedManual = condition === '只有其他安装位置的同名man'; });
When('服务生成自动工具目录并交给成员', async function(this: SpecWorld) { state(this).report = await automaticCatalogAcceptance(state(this).documented!, state(this).unrelatedManual); });
Then('目录应包含该工具的用途适用场景和静态资料来源', function(this: SpecWorld) { assert.equal(state(this).report?.entry.documentation?.state, 'documented'); });
Then('已发现路径应按执行环境提供存在观测且同名不同工具的用途不得混用', function(this: SpecWorld) {
  const report = state(this).report; assert(report); assert.equal(report.entry.discovery?.length, 2);
  assert.notEqual(report.entry.discovery?.[0]?.path, report.entry.discovery?.[1]?.path);
});
Then('目录生成不得启动工具或取得宿主授权', function(this: SpecWorld) { assert.equal(state(this).report?.executions, 0); assert.equal(state(this).report?.authority, false); });
Then('该工具应保持可见且明确用途未知认证网络和授权状态未知', function(this: SpecWorld) { assert.equal(state(this).report?.entry.documentation?.state, 'unknown'); });
Given('工具目录包含超过200个条目且每条说明超过2000字符', function(this: SpecWorld) { state(this); });
When('成员查询全部工具和本地技能目录', async function(this: SpecWorld) { await unlimitedCatalogAcceptance(); state(this).complete = true; });
Then('所有匹配条目和完整说明应一次返回而没有隐藏分页上限', function(this: SpecWorld) { assert(state(this).complete); });
Given('成员需要查询超过20个显式命令且目录内容超过96000字符', function(this: SpecWorld) { state(this); });
When('真实任务保存领取并回传完整工具发现结果', async function(this: SpecWorld) { await largeDiscoveryAcceptance(); state(this).complete = true; });
Then('所有查询命令和目录条目应进入检查点及下一次模型输入', function(this: SpecWorld) { assert(state(this).complete); });
Then('目录查询不得启动命令或消耗命令执行额度', function(this: SpecWorld) { assert(state(this).complete); });
Given('已发布的自动目录对应可变的宿主工具安装位置', function(this: SpecWorld) { state(this); });
When('工具及说明新增修改移除后触发目录刷新', async function(this: SpecWorld) { await automaticCatalogRefreshAcceptance(); state(this).complete = true; });
Then('后续观察应取得一致的新目录而已读取的旧快照保持原样', function(this: SpecWorld) { assert(state(this).complete); });
Then('安装存在性应采用较新观测而保留未知认证和网络状态', function(this: SpecWorld) { assert(state(this).complete); });
Then('目录刷新不得执行工具或帮助', function(this: SpecWorld) { assert(state(this).complete); });
