import { Given, When, Then } from '@cucumber/cucumber';
import { ArtifactReadContract } from '../core-artifact-read-fixture.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, ArtifactReadContract>();
Given('任务已有一份保存的报告且读取主体为{string}', function (this: SpecWorld, subject: string) { runs.set(this, new ArtifactReadContract(subject)); });
When('该主体请求读取{string}', function (this: SpecWorld, report: string) { runs.get(this)!.read(report); });
Then('读取应返回{string}且本次普通额度增加{int}', function (this: SpecWorld, code: string, cost: number) { runs.get(this)!.verify(code, cost); });
Then('已保存原文和当前候选的文档选择保持原样', function (this: SpecWorld) { runs.get(this)!.verifyUnchanged(); });
