// 轻量 Markdown 渲染：GFM + 消毒（模型输出不可信，防 XSS）
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(src: string | undefined | null): string {
  if (!src) return '';
  const raw = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
