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
Then('应使用随应用提供的新版 SVG 且可按正方形视口缩放', function (this: SpecWorld) {
  const value = state(this);
  const source = value.html!.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1];
  assert(source);
  assert.equal(source, '/logo.svg');
  value.source = source;
  const svg = readFileSync(new URL('../../web/public/logo.svg', import.meta.url), 'utf8');
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]?.split(/\s+/).map(Number);
  assert(viewBox && viewBox.length === 4);
  assert(viewBox[2]! > 0);
  assert.equal(viewBox[2], viewBox[3]);
  assert.match(svg, /<svg\b/);
});
Then('浏览器图标应引用同一份品牌资源', function (this: SpecWorld) {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const icon = html.match(/<link\b[^>]*\brel="icon"[^>]*>/)?.[0];
  assert(icon);
  assert.equal(icon.match(/\bhref="([^"]+)"/)?.[1], state(this).source);
});
Then('品牌文字应{string}', function (this: SpecWorld, expected: string) {
  const value = state(this);
  const text = value.html!.replace(/<[^>]+>/g, '');
  if (expected === '保留 squad.') {
    assert.equal(text, 'squad.');
    assert.match(value.html!, /alt=""/);
  } else {
    assert.equal(expected, '仅显示品牌图标');
    assert.equal(text, '');
    assert.match(value.html!, /alt="Squad"/);
  }
});
