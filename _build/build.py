#!/usr/bin/env python3
"""Build edge-ai-docs: convert .md sources -> themed .html into dist/, copy static assets.
Run from repo root: python3 _build/build.py
.md sources are the editable truth; .html without a sibling .md (echarts docs, index) are copied as-is."""
import os, re, json, shutil, markdown

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, 'dist')
EXCLUDE_DIRS = {'.git', '.github', '_build', 'dist', 'node_modules'}

CSS = open(os.path.join(HERE, 'template.css'), encoding='utf-8').read()
EXTRA_CSS = """
blockquote{border-left:3px solid var(--accent);padding:8px 14px;margin:14px 0;color:var(--text2);background:var(--bg2);border-radius:0 6px 6px 0;font-size:13.5px}
blockquote p{margin-bottom:4px;color:var(--text2)}
blockquote strong{color:var(--text)}
details{margin:14px 0;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg)}
summary{padding:11px 14px;background:var(--bg2);cursor:pointer;font-weight:600;font-size:14px;color:var(--text);list-style:none;display:flex;justify-content:space-between;align-items:center;gap:10px}
summary::-webkit-details-marker{display:none}
summary:hover{background:var(--bg3)}
summary::after{content:'\\25BC';font-size:11px;color:var(--muted);flex:none}
details[open] summary::after{content:'\\25B2'}
details .q-body{padding:14px}
details .q-body p{margin-bottom:10px}
"""
TAIL = open(os.path.join(HERE, 'template_tail.html'), encoding='utf-8').read()
ALERT2VARIANT = {'NOTE': '', 'TIP': 'ok', 'IMPORTANT': 'warn', 'WARNING': 'warn', 'CAUTION': 'err'}

def md_to_html_fragment(text):
    return markdown.markdown(text, extensions=['tables', 'fenced_code', 'sane_lists'])

def normalize_list_indent(md_text):
    """python-markdown(sane_lists) 需 4 空格才识别嵌套列表；把 1~3 空格缩进的列表项
    归一为 4 空格（含引用块内的列表），跳过代码块。源 md 仍可用常见的 2 空格嵌套写法。"""
    lines = md_text.split('\n')
    out, in_code = [], False
    for ln in lines:
        if ln.lstrip().startswith('```'):
            in_code = not in_code
            out.append(ln); continue
        if in_code:
            out.append(ln); continue
        bq = re.match(r'^(\s*(?:>\s?)+)(.*)$', ln)
        if bq and bq.group(2):
            prefix, content = bq.group(1), bq.group(2)
            m = re.match(r'^(\s{1,3})([-*]\s+|\d+\.\s+)', content)
            if m:
                content = '    ' + m.group(2) + content[m.end():]
            out.append(prefix + content); continue
        m = re.match(r'^(\s{1,3})([-*]\s+|\d+\.\s+)', ln)
        if m:
            ln = '    ' + m.group(2) + ln[m.end():]
        out.append(ln)
    return '\n'.join(out)

def convert_alerts(md_text):
    lines = md_text.split('\n')
    out, i = [], 0
    while i < len(lines):
        m = re.match(r'^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$', lines[i])
        if not m:
            out.append(lines[i]); i += 1; continue
        variant = ALERT2VARIANT[m.group(1)]
        i += 1
        block = []
        while i < len(lines) and lines[i].lstrip().startswith('>'):
            block.append(re.sub(r'^\s*>\s?', '', lines[i])); i += 1
        body = '\n'.join(block).strip()
        title = ''
        tm = re.match(r'^\*\*(.+?)\*\*\s*\n', body + '\n')
        if tm:
            title = tm.group(1).strip()
            body = body[tm.end():].strip()
        body_html = md_to_html_fragment(body)
        cls = 'info-box' + ((' ' + variant) if variant else '')
        title_html = f'<div class="title">{title}</div>' if title else ''
        out.append(f'<div class="{cls}">{title_html}{body_html}</div>')
        out.append('')
    return '\n'.join(out)

def convert_details(md_text):
    def repl(m):
        summary = m.group(1).strip()
        body = m.group(2).strip()
        sum_html = re.sub(r'^<p>|</p>$', '', markdown.markdown(summary).strip())
        body_html = md_to_html_fragment(body)
        return f'<details><summary><span>{sum_html}</span></summary><div class="q-body">{body_html}</div></details>'
    return re.sub(r'<details(?:\s+markdown="1")?>\s*<summary>(.*?)</summary>(.*?)</details>',
                  repl, md_text, flags=re.DOTALL)

def render(md_text):
    mermaids = []
    def stash(m):
        mermaids.append(m.group(1)); return f'\n\n@@MM{len(mermaids)-1}@@\n\n'
    md_text = re.sub(r'```mermaid\n(.*?)```', stash, md_text, flags=re.DOTALL)
    md_text = normalize_list_indent(md_text)
    md_text = convert_alerts(md_text)
    md_text = convert_details(md_text)
    body = markdown.markdown(md_text, extensions=['tables', 'fenced_code', 'sane_lists'])
    toc, ctr = [], [0]
    def add_id(m):
        tag, content = m.group(1), m.group(2)
        ctr[0] += 1
        hid = f'sec-{ctr[0]}'
        plain = re.sub(r'<[^>]+>', '', content).strip()
        toc.append((tag, hid, plain))
        return f'<{tag} id="{hid}">{content}</{tag}>'
    body = re.sub(r'<(h2|h3)>(.*?)</\1>', add_id, body, flags=re.DOTALL)
    body = body.replace('<table>', '<div class="tbl-wrap"><table>').replace('</table>', '</table></div>')
    for idx, mm in enumerate(mermaids):
        div = f'<div class="mermaid-wrap"><div class="mermaid">\n{mm.strip()}\n</div></div>'
        body = body.replace(f'<p>@@MM{idx}@@</p>', div).replace(f'@@MM{idx}@@', div)
    return body, toc

def sidebar(toc_part, toc):
    links = [f'  <div class="toc-part">{toc_part}</div>']
    first = True
    for tag, hid, plain in toc:
        if tag == 'h2':
            cls = ' class="active"' if first else ''
            first = False
            links.append(f'  <a href="#{hid}"{cls}>{plain}</a>')
    return '\n'.join(links)

def load_titles():
    titles = {}
    try:
        d = json.load(open(os.path.join(ROOT, 'docs.json'), encoding='utf-8'))
        for cat in d.get('categories', []):
            for doc in cat.get('general', []):
                titles[doc['file']] = doc['title']
            for p in cat.get('projects', []):
                for doc in p.get('docs', []):
                    titles[doc['file']] = doc['title']
    except Exception as e:
        print('warn: docs.json titles unavailable:', e)
    return titles

def build_page(md_rel, titles):
    html_rel = md_rel[:-3] + '.html'
    md_text = open(os.path.join(ROOT, md_rel), encoding='utf-8').read()
    body, toc = render(md_text)
    # title: docs.json else first h1
    title = titles.get(html_rel)
    if not title:
        m = re.search(r'^#\s+(.+)$', md_text, re.MULTILINE)
        title = m.group(1).strip() if m else html_rel
    toc_part = title
    depth = md_rel.count('/')
    navpath = '../' * depth + 'nav.js'
    page = f'''<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} — 端侧 AI 学习文档</title>
<style>{CSS}{EXTRA_CSS}</style>
</head>
<body>

<!-- ===== Top Navigation ===== -->
<nav class="top-nav"></nav>
<script src="{navpath}" data-active="{html_rel}" data-edit="{md_rel}"></script>

<!-- ===== Sidebar TOC ===== -->
<aside class="sidebar">
{sidebar(toc_part, toc)}
</aside>

<!-- ===== Main Content ===== -->
<main class="main">

{body}

</main>

{TAIL}
</html>
'''
    outp = os.path.join(DIST, html_rel)
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    open(outp, 'w', encoding='utf-8').write(page)
    return html_rel

def main():
    if os.path.exists(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST)
    titles = load_titles()
    # Only build .md that docs.json references (docs.json = single source of truth for pages).
    md_files, html_with_md = [], set()
    for html_rel in titles:
        if not html_rel.endswith('.html'):
            continue
        md_rel = html_rel[:-5] + '.md'
        if os.path.exists(os.path.join(ROOT, md_rel)):
            md_files.append(md_rel)
            html_with_md.add(html_rel)
    built = [build_page(m, titles) for m in sorted(md_files)]
    # copy static: .html without sibling .md (echarts/index), nav.js, docs.json, other assets
    copied = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if fn == '.DS_Store':
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), ROOT)
            if rel.endswith('.md'):
                continue
            if rel.endswith('.html') and rel in html_with_md:
                continue  # generated from md
            dst = os.path.join(DIST, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(ROOT, rel), dst)
            copied.append(rel)
    print(f'built {len(built)} html from md; copied {len(copied)} static files')
    for c in sorted(copied):
        print('  copy:', c)

if __name__ == '__main__':
    main()
