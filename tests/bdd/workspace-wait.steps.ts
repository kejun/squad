import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { WorkspaceWaitModel, workspaceWaitBoundaries, assertWorkspaceWaitQualification, assertWorkspaceWaitBoundary,
  type WorkspaceWaitBoundary } from '../workspace-wait-model-fixture.js';
import type { SpecWorld } from './steps.js';

const cases = new WeakMap<SpecWorld, WorkspaceWaitModel>();
function state(world: SpecWorld) { const proof = cases.get(world); assert(proof); return proof; }
Given('当前工作的本地命令因资源被其他操作占用而拒绝领取', function (this: SpecWorld) { cases.set(this, new WorkspaceWaitModel()); });
When('资源等待经历{string}', function (this: SpecWorld, boundary: string) {
  assert(workspaceWaitBoundaries.includes(boundary as WorkspaceWaitBoundary));
  state(this).exercise(boundary as WorkspaceWaitBoundary);
});
Then('未领取命令不应被监督计为实际有效执行', function (this: SpecWorld) { assertWorkspaceWaitQualification(state(this)); });
Then('等待应保持原窗口和权限边界直到真实领取停止或到期', function (this: SpecWorld) { assertWorkspaceWaitBoundary(state(this)); });
