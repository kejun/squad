import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelFixture } from './panel-fixture.js';
import { assertTypographyFloor } from './typography-audit.js';
import { Logo } from '../web/src/Logo.js';

const open: PanelFixture[] = [];
afterEach(async () => { for (const fixture of open.splice(0).reverse()) await fixture.close(); });

// Static design checks belong here, independent of Gherkin behaviour identities.
describe('UI style contract (docs/ui-style.md)', () => {
  it('keeps ordinary and user message base typography across stylesheet overrides', () => {
    const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');
    const sizes = [...css.matchAll(/\.message-text\s*\{([^}]+)\}/g)]
      .flatMap(rule => [...rule[1]!.matchAll(/font-size:\s*([^;]+);/g)].map(size => size[1]!.trim()));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every(size => size === '16px')).toBe(true);
    for (const selector of [/^\.message-text\s*\{([^}]+)\}/m, /^\.from-user \.message-text\s*\{([^}]+)\}/m]) {
      const body = selector.exec(css)?.[1];
      expect(body).toBeDefined();
      expect(/(?:^|;)\s*color:\s*([^;]+);/.exec(body!)?.[1]?.trim()).toBe('#273142');
    }
  });

  it('audits the text floor across every stylesheet, including native smaller-text defaults', () => {
    const audited = assertTypographyFloor();
    expect(audited.files).toBeGreaterThan(0); expect(audited.declarations).toBeGreaterThan(0);
  });

  it.each([1440, 1100, 800, 390])('keeps equal fixed headers at a %ipx viewport', async width => {
    const f = new PanelFixture(width); open.push(f); await f.mount(); await f.openDetails();
    // The details header belongs to a lazy component; wait for its real module and render.
    await act(async () => { await import('../web/src/Details.js'); });
    for (const selector of ['.chat-header', '.details-header']) {
      const style = f.window.getComputedStyle(f.query(selector) as never);
      expect(style.height).toBe('64px'); expect(style.minHeight).toBe('64px'); expect(style.flexShrink).toBe('0');
    }
  });

  it('uses a square SVG viewport and places the collapsed-navigation brand before navigation', async () => {
    const svg = readFileSync(new URL('../web/public/logo.svg', import.meta.url), 'utf8');
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]?.split(/\s+/).map(Number);
    expect(viewBox).toHaveLength(4); expect(viewBox![2]).toBeGreaterThan(0); expect(viewBox![2]).toBe(viewBox![3]);
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(createElement(Logo, { compact }));
      expect(html.replace(/<[^>]+>/g, '')).toBe(compact ? '' : 'squad.');
      expect(html).toMatch(compact ? /alt="Squad"/ : /alt=""/);
    }
    const f = new PanelFixture(); open.push(f); await f.mount(); await f.click('收起导航');
    const header = f.query('.chat-header');
    expect(header.firstElementChild).toBe(f.query('.topbar-brand'));
    expect(header.children[1]).toBe(f.query('.navigation-toggle'));
  });
});
