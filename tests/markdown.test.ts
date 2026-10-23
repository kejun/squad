import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageText } from "../web/src/MessageText";

const agents = [
  { id: "A", name: "方案师", instructions: "", tools: [], model: null },
  { id: "B", name: "核查员", instructions: "", tools: [], model: null },
];
const render = (text: string) =>
  renderToStaticMarkup(
    createElement(MessageText, { text, agents, onAgent() {} }),
  );

describe("chat Markdown rendering", () => {
  it("[BT_U10] renders formatting, lists, quotes and ordinary chat line breaks", () => {
    const html = render(
      "# 实施方案\n\n**重点**和*说明*\n保留换行\n\n> 核查结论\n\n1. 连接开发板\n2. 验证结果",
    );
    expect(html).toContain("<h1>实施方案</h1>");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<em>说明</em>");
    expect(html).toContain("<br/>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>连接开发板</li>");
  });
  it("[BT_U10] renders GFM tables, task lists and strikethrough", () => {
    const html = render(
      "| 成员 | 工作 |\n| --- | --- |\n| A | 方案 |\n\n- [x] 已完成\n- [ ] 待验证\n\n~~旧方案~~",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>成员</th>");
    expect(html).toContain('aria-label="消息中的表格"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain("<del>旧方案</del>");
  });
  it("[BT_U11] preserves code whitespace and keeps code mentions literal", () => {
    const html = render(
      '`@A`\n\n```ts\nconst member = "@B";\n  console.log(member);\n```',
    );
    expect(html).toContain("<code>@A</code>");
    expect(html).toContain('class="language-ts"');
    expect(html).toContain("  console.log(member);");
    expect(html).not.toContain("<button");
  });
  it("[BT_U11] keeps prose mentions clickable without rewriting emails or links", () => {
    const html = render(
      "@A **@B** @unknown mail@A.com [@A](https://example.com)",
    );
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain("@方案师</button>");
    expect(html).toContain("@核查员</button>");
    expect(html).toContain("@unknown");
    expect(html).toContain('href="mailto:mail@A.com"');
    expect(html).toContain(
      'href="https://example.com" target="_blank" rel="noopener noreferrer">@A</a>',
    );
  });
  it("[BT_U12] blocks raw HTML and executable URLs in messages", () => {
    const html = render(
      '<script>alert("unsafe")</script>\n\n<img src=x onerror=alert(1)>\n\n[恶意链接](javascript:alert%281%29)\n\n![图片](https://example.com/image.png)',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span>恶意链接</span>");
    expect(html).toContain('loading="lazy"');
  });

  it("[BT_U13] preserves footnote targets and in-message navigation", () => {
    const html = render("结论[^source]\n\n[^source]: 依据说明");
    expect(html).toContain('href="#user-content-fn-source"');
    expect(html).toContain('id="user-content-fnref-source"');
    expect(html).toContain('href="#user-content-fnref-source"');
    expect(html).not.toContain('target="_blank"');
  });
});
