import React, { memo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { api } from '../api.js';
import { t } from '../i18n.js';

function PreBlock({ children, ...props }) {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.current?.innerText || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  };
  return (
    <div className="code-wrap">
      <button type="button" className="code-copy" onClick={copy} title={t('Copy code')}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? t('Copied') : t('Copy')}
      </button>
      <pre ref={ref} {...props}>{children}</pre>
    </div>
  );
}

function Markdown({ children }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: PreBlock,
          a: ({ href, children: linkChildren, ...props }) => (
            <a
              href={href}
              {...props}
              onClick={(event) => {
                event.preventDefault();
                if (/^https?:\/\//i.test(href || '')) api.openExternal(href);
              }}
            >
              {linkChildren}
              <ExternalLink size={11} className="link-out" />
            </a>
          ),
          input: (props) => <input {...props} disabled />,
        }}
      >
        {children || ''}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
