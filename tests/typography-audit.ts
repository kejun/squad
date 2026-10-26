import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith('.css') ? [path] : [];
  });
}

function isAtLeast14(value: string): boolean {
  if (value === 'inherit') return true;
  const absolute = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (absolute) return Number(absolute[1]) >= 14;
  const relative = /^(\d+(?:\.\d+)?)(?:r?em|%)$/.exec(value);
  if (relative) return Number(relative[1]) >= (value.endsWith('%') ? 100 : 1);
  // Preserve a relative hierarchy when the parent grows, while enforcing the floor.
  return /^max\(\s*(?:1[4-9]|[2-9]\d|\d{3,})(?:\.\d+)?px\s*,[^;{}]+\)$/.test(value);
}

/** Audits every stylesheet and breakpoint, including Markdown and native smaller text. */
export function assertTypographyFloor(): { files: number; declarations: number } {
  const files = cssFiles(fileURLToPath(new URL('../web/src/', import.meta.url)));
  let declarations = 0;
  const inheritedElements = new Set<string>();
  const nativeSmallerElements = new Set<string>();
  let rootFloor = false;
  for (const file of files) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/g, '');
    for (const match of css.matchAll(/font-size\s*:\s*([^;{}]+)[;}]/g)) {
      const value = match[1]!.trim();
      declarations += 1;
      assert(isAtLeast14(value), `${file}: font-size ${value} may render below 14px`);
    }
    for (const match of css.matchAll(/(?:^|[;{])\s*font\s*:\s*([^;{}]+)[;}]/g)) {
      assert.equal(match[1]!.trim(), 'inherit', `${file}: review font shorthand for a smaller size`);
    }
    for (const match of css.matchAll(/scale(?:X|Y)?\(\s*([\d.]+)/g)) {
      assert(Number(match[1]) >= 1, `${file}: scale(${match[1]}) reduces rendered text below its declared size`);
    }
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1]!.trim().split(',').map((selector) => selector.trim());
      const body = rule[2]!;
      const size = /font-size\s*:\s*([^;{}]+)/.exec(body)?.[1]?.trim();
      if (selectors.includes(':root') && size && isAtLeast14(size) && size !== 'inherit') rootFloor = true;
      if (/font\s*:\s*inherit\s*[;}]/.test(`${body}}`)) {
        for (const selector of selectors) inheritedElements.add(selector);
      }
      if (size === 'inherit' || size && isAtLeast14(size)) {
        for (const selector of selectors) nativeSmallerElements.add(selector);
      }
    }
  }
  assert(declarations > 0, 'No font rules were audited');
  assert(rootFloor, 'The inherited page font must be at least 14px');
  for (const element of ['button', 'input', 'select', 'textarea']) {
    assert(inheritedElements.has(element), `${element} must inherit the page font instead of a smaller browser default`);
  }
  for (const element of ['small', 'sub', 'sup']) {
    assert(nativeSmallerElements.has(element), `${element} must override the browser smaller-text default`);
  }
  return { files: files.length, declarations };
}
