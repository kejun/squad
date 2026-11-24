import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { SummaryArtifactSelectionCase, referenceVariants } from '../summary-artifact-selection-model-fixture.js';
import type { SpecWorld } from './steps.js';

const cases = new WeakMap<SpecWorld, SummaryArtifactSelectionCase>();

Given('普通交付任务要求一个新文件且已有本轮成果，来源类型为{string}', function (this: SpecWorld, source: string) {
  const test = new SummaryArtifactSelectionCase(source === '固定原文');
  cases.set(this, test);
  test.prepareCurrentArtifact();
});

When('负责人提交本轮成果并在清单中误列{string}', function (this: SpecWorld, variant: string) {
  assert(Object.hasOwn(referenceVariants, variant));
  cases.get(this)!.submitReferences(variant as keyof typeof referenceVariants);
});

Then('群内只交付本轮成果且不报告文件缺失', function (this: SpecWorld) {
  cases.get(this)!.assertCurrentOutput();
});

Given('普通交付任务要求一个新文件但尚无本轮成果', function (this: SpecWorld) {
  cases.set(this, new SummaryArtifactSelectionCase());
});

When('负责人仅提交文字结果和跨任务旧文件引用', function (this: SpecWorld) {
  cases.get(this)!.submitOldAttachmentOnly();
});

Then('群内保留文字结果并指出缺少文件且不提供旧文件下载', function (this: SpecWorld) {
  cases.get(this)!.assertMissingOutput();
});

Given('普通交付任务正在继续一份本轮已发布的报告', function (this: SpecWorld) {
  const test = new SummaryArtifactSelectionCase();
  cases.set(this, test);
  test.preparePublishedRevision();
});

When('负责人提交新稿并声明{string}', function (this: SpecWorld, base: string) {
  assert(base === '本轮发布稿' || base === '跨任务旧报告');
  cases.get(this)!.submitRevision(base);
});

Then('群内只交付新稿且新稿应为{string}', function (this: SpecWorld, relation: string) {
  assert(relation === '原报告的下一修订' || relation === '独立文档');
  cases.get(this)!.assertRevision(relation);
});
