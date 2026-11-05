import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { nativeStartupAcceptance, nativeIdentityAcceptance, nativePathAcceptance, nativeSandboxAcceptance } from '../native-local-acceptance.js';
import type { SpecWorld } from './steps.js';
const completed = new WeakSet<SpecWorld>();
Given('当前宿主具备对应平台的沙箱和进程身份依赖', function () {});
When('隔离服务开启本地工具并加载技能后执行真实命令', async function (this: SpecWorld) { await nativeStartupAcceptance(); completed.add(this); });
Then('应获取原生进程身份且服务锁不得依赖其他平台的接口', function (this: SpecWorld) { assert(completed.has(this)); });
Then('CLI 应经已持久化领取的子操作返回真实输出和回执', function (this: SpecWorld) { assert(completed.has(this)); });
Given('宿主持有含启动时间和开机标识的服务锁', function () {});
When('核对活跃、已退出、复用标识与未知平台的身份', async function (this: SpecWorld) { await nativeIdentityAcceptance(); completed.add(this); });
Then('只应确认匹配身份仍活跃且不得接管活跃或不确定的锁', function (this: SpecWorld) { assert(completed.has(this)); });
Then('身份探测失败不得留下本次新建的空锁', function (this: SpecWorld) { assert(completed.has(this)); });
Given('技能与快照目录通过同一真实目录的别名访问', function () {});
When('激活技能并读取包内资源', async function (this: SpecWorld) { await nativePathAcceptance(); completed.add(this); });
Then('应读取固定版本且不把系统目录别名误判为路径逃逸', function (this: SpecWorld) { assert(completed.has(this)); });
Then('包内链接逃逸和路径穿越仍应拒绝', function (this: SpecWorld) { assert(completed.has(this)); });
Given('当前宿主的生产沙箱可用', function () {});
When('在真实沙箱验证工作区写入和外部访问并取消长命令', { timeout: 20_000 }, async function (this: SpecWorld) { await nativeSandboxAcceptance(); completed.add(this); });
Then('工作区可写而服务密钥、包外文件、技能快照写入和网络均应被拒绝', function (this: SpecWorld) { assert(completed.has(this)); });
Then('最终检查源文件只读且输出目录可写', function (this: SpecWorld) { assert(completed.has(this)); });
Then('取消应结算真实进程会话并对未知写入效果保持待核对', function (this: SpecWorld) { assert(completed.has(this)); });

Then('可信沙箱运行时辅助程序应可执行且只读而其安装目录仍不可读取', function (this: SpecWorld) { assert(completed.has(this)); });

Then('输出目录内和其祖先的显式拒写限制仍应优先', function (this: SpecWorld) { assert(completed.has(this)); });
