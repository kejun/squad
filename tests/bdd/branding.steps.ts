import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Given, When, Then } from '@cucumber/cucumber';
import { Logo } from '../../web/src/Logo.js';
import type { SpecWorld } from './steps.js';

const branding = new WeakMap<SpecWorld, { compact: boolean; html?: string; source?: string }>();
function state(world: SpecWorld) {
  const value = branding.get(world);
  assert(value);
  return value;
}

Given('品牌图标展示在{string}', function (this: SpecWorld, location: string) {
  assert(['侧栏', '欢迎区'].includes(location));
  branding.set(this, { compact: location === '欢迎区' });
});
When('渲染该品牌标识', function (this: SpecWorld) {
  const value = state(this);
  value.html = renderToStaticMarkup(createElement(Logo, { compact: value.compact }));
});
Then('应使用随应用提供的品牌资源并能识别应用名称', function (this: SpecWorld) {
  const value = state(this);
  const source = value.html!.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1];
  assert(source);
  assert.equal(source, '/logo.svg');
  value.source = source;
  assert.equal(value.html!.replace(/<[^>]+>/g, ''), value.compact ? '' : 'squad.');
  assert.match(value.html!, value.compact ? /alt="Squad"/ : /alt=""/);
});
Then('浏览器图标应引用同一份品牌资源', function (this: SpecWorld) {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const icon = html.match(/<link\b[^>]*\brel="icon"[^>]*>/)?.[0];
  assert(icon);
  assert.equal(icon.match(/\bhref="([^"]+)"/)?.[1], state(this).source);
});
