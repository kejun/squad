import { Given, When, Then } from '@cucumber/cucumber';
import { SandboxPolicyContract } from '../core-sandbox-policy-fixture.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, SandboxPolicyContract>();
Given('当前宿主准备独立任务工作区的生产沙箱', function (this: SpecWorld) { runs.set(this, new SandboxPolicyContract()); });
When('构造该工作区的文件网络和最小命令环境', function (this: SpecWorld) { runs.get(this)!.construct(); });
Then('默认拒绝工作区外读取网络和宿主密钥且不扩大命名空间权限', function (this: SpecWorld) { runs.get(this)!.verifyDefaultDenial(); });
Then('只按支持的平台开放只读辅助程序且不暴露其安装目录', function (this: SpecWorld) { runs.get(this)!.verifyTrustedHelper(); });
