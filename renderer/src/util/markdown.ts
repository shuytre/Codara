// 轻量 Markdown 渲染：GFM + 消毒（模型输出不可信，防 XSS）
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(src: string | undefined | null): string {
  if (!src) return '';
  const raw = marked.parse(src, { async: false }) as string;
  // marked 对单行输入产出 "<p>…</p>\n"，末尾那个 \n 是 <p> 之外的文本节点。
  // 用户气泡用了 white-space: pre-wrap，这个尾随换行会被渲染成气泡内的第二个空行
  //（用户反馈「没打换行却总是显示两行」）。这里统一裁掉首尾空白 HTML 片段。
  return DOMPurify.sanitize(raw.trim(), { USE_PROFILES: { html: true } });
}
