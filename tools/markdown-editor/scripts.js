/* ==========================================================================
   Markdown Editor — Live two-way sync between a Markdown source pane and a
   Google Docs-style WYSIWYG document pane.
   All processing happens client-side; nothing is ever uploaded.
   ========================================================================== */

(function () {
  'use strict';

  /* ----------------------------------------------------------------------
     Element references
     ---------------------------------------------------------------------- */
  const mdInput = document.getElementById('markdown-input');
  const docEditor = document.getElementById('doc-editor');
  const toolbar = document.getElementById('docs-toolbar');
  const dropzoneOverlay = document.getElementById('dropzone-overlay');

  const mdStatsBadge = document.getElementById('md-stats-badge');
  const mdLinesCount = document.getElementById('md-lines-count');
  const mdCharsCount = document.getElementById('md-chars-count');
  const docStatsBadge = document.getElementById('doc-stats-badge');
  const docWordsCount = document.getElementById('doc-words-count');
  const syncStatus = document.getElementById('sync-status');

  /* ----------------------------------------------------------------------
     Theme handling (matches the pattern used across the rest of the site)
     ---------------------------------------------------------------------- */
  const themeBtn = document.getElementById('theme-toggle-btn');
  const themeIconLight = document.getElementById('theme-icon-light');
  const themeIconDark = document.getElementById('theme-icon-dark');

  function applyTheme(isDark) {
    document.documentElement.classList.toggle('dark', isDark);
    if (themeIconLight) themeIconLight.style.display = isDark ? 'none' : 'block';
    if (themeIconDark) themeIconDark.style.display = isDark ? 'block' : 'none';
  }

  (function initTheme() {
    const savedTheme = localStorage.getItem('theme-mode');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(savedTheme ? savedTheme === 'dark' : prefersDark);

    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const isDark = document.documentElement.classList.contains('dark');
        applyTheme(!isDark);
        localStorage.setItem('theme-mode', !isDark ? 'dark' : 'light');
      });
    }

    // Follow OS changes only while the user has not made an explicit choice.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('theme-mode')) applyTheme(e.matches);
    });
  })();

  /* ----------------------------------------------------------------------
     Markdown <-> HTML conversion
     ---------------------------------------------------------------------- */
  marked.setOptions({ gfm: true, breaks: true });

  const PURIFY_CONFIG = {
    ADD_ATTR: ['style', 'data-color', 'target', 'colspan', 'rowspan', 'align', 'start', 'type', 'checked', 'class'],
  };

  function markdownToHtml(md) {
    const raw = marked.parse(md || '');
    return DOMPurify.sanitize(raw, PURIFY_CONFIG);
  }

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
  });

  turndown.use(turndownPluginGfm.gfm);

  // The GFM plugin drops <u> and emits single-tilde strikethrough, so both are
  // restored explicitly.
  turndown.addRule('underline', {
    filter: 'u',
    replacement: (content) => '<u>' + content + '</u>',
  });

  turndown.addRule('strike', {
    filter: ['del', 's', 'strike'],
    replacement: (content) => '~~' + content + '~~',
  });

  // Preserve inline styles applied by the toolbar (color, highlight, font).
  turndown.addRule('spanStyled', {
    filter: (node) =>
      node.nodeName === 'SPAN' &&
      (node.getAttribute('style') || node.getAttribute('data-color')),
    replacement: (content, node) => {
      let attrs = '';
      const style = node.getAttribute('style');
      const color = node.getAttribute('data-color');
      if (style) attrs += ' style="' + style + '"';
      if (color) attrs += ' data-color="' + color + '"';
      return '<span' + attrs + '>' + content + '</span>';
    },
  });

  // Preserve block alignment applied via the toolbar.
  turndown.addRule('alignBlock', {
    filter: (node) =>
      ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(node.nodeName) &&
      node.getAttribute('style') &&
      /text-align/.test(node.getAttribute('style')),
    replacement: (content, node) => {
      const match = /text-align:\s*([a-z]+)/.exec(node.getAttribute('style'));
      const tag = node.nodeName === 'DIV' ? 'div' : 'p';
      return '<' + tag + ' style="text-align:' + (match ? match[1] : 'left') + '">' +
        content + '</' + tag + '>\n';
    },
  });

  // Turndown's default rule writes "<hr>" as "* * *"; "---" is the canonical
  // GFM thematic break and matches the sample document.
  turndown.addRule('horizontalRule', {
    filter: 'hr',
    replacement: () => '\n---\n',
  });

  // Turndown's image rule drops the inline width, which would silently undo
  // every resize the user makes. Markdown has no syntax for image dimensions,
  // so a resized image is written as raw HTML instead — which markdown renders
  // and parses back unchanged.
  turndown.addRule('imageWithSize', {
    filter: (node) => {
      const style = node.getAttribute('style') || '';
      return /width:\s*[\d.]+px|height:\s*[\d.]+px/.test(style);
    },
    replacement: (content, node) => {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      const title = node.getAttribute('title');
      const style = node.getAttribute('style') || '';

      let attrs = 'src="' + src.replace(/"/g, '&quot;') + '"';
      if (alt) attrs += ' alt="' + alt.replace(/"/g, '&quot;') + '"';
      if (title) attrs += ' title="' + title.replace(/"/g, '&quot;') + '"';
      if (style) attrs += ' style="' + style.replace(/"/g, '&quot;') + '"';

      return '<img ' + attrs + '>';
    },
  });

  // A table whose columns were resized keeps an HTML <colgroup> so the widths
  // survive the round-trip. Tables without explicit widths stay GFM tables.
  turndown.addRule('tableWithColgroup', {
    filter: (node) =>
      node.nodeName === 'TABLE' && node.querySelector('colgroup col[style]'),
    replacement: (content, node) => {
      // Every column has to be emitted, not just the resized ones, otherwise
      // the colgroup would come back with fewer columns than the table has.
      const cols = Array.prototype.map.call(
        node.querySelectorAll('colgroup col'),
        (col) => {
          const width = /width:\s*([\d.]+)px/.exec(col.getAttribute('style') || '');
          return width ? '<col style="width:' + width[1] + 'px">' : '<col>';
        }
      ).join('');

      const rows = Array.prototype.map.call(
        node.querySelectorAll('tr'),
        (tr) => {
          const cells = Array.prototype.map.call(
            tr.children,
            (cell) => {
              const tag = cell.nodeName === 'TH' ? 'th' : 'td';
              const inner = cell.innerHTML.replace(/^\s+|\s+$/g, '');
              return '<' + tag + '>' + inner + '</' + tag + '>';
            }
          ).join('');
          return '<tr>' + cells + '</tr>';
        }
      ).join('');

      return '\n<table>\n<colgroup>' + cols + '</colgroup>\n' + rows + '\n</table>\n';
    },
  });

  function htmlToMarkdown(html) {
    return turndown.turndown(html || '');
  }

  // The GFM plugin writes list items as "-   item" (three spaces) and ordered
  // items as "1.  item" (two spaces), and indents nested items by four spaces.
  // These are all valid GFM, but they drift away from the canonical source form.
  // Normalising afterwards keeps the source stable across round-trips without
  // disturbing nesting or ordered-list numbering.
  function normalizeListMarkers(md) {
    return md
      // "-   item" / "*   item" / "+   item" -> "- item"
      .replace(/^(\s*)([-*+])\s{2,}(?=\S)/gm, '$1$2 ')
      // "1.  item" -> "1. item"
      .replace(/^(\s*)(\d+)\.\s{2,}(?=\S)/gm, '$1$2. ')
      // Task list items keep their "[x] " prefix: "- [x]  task" -> "- [x] task"
      .replace(/^(\s*)([-*+])\s(\[[ xX]\]) {2,}(?=\S)/gm, '$1$2 $3 ')
      // Nested items are indented by four spaces by the plugin; two spaces is
      // the canonical indent for "-" bullets and parses identically.
      .replace(/^(\s{4,})([-*+]|\d+\.)\s/gm, (match, indent, marker) =>
        '  '.repeat(Math.floor(indent.length / 4)) + (indent.length % 4 ? '  ' : '') + marker + ' ');
  }

  /* ----------------------------------------------------------------------
     Caret preservation across innerHTML rewrites
     ---------------------------------------------------------------------- */
  function getSelectionOffset(root) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return 0;
    const pre = range.cloneRange();
    pre.selectNodeContents(root);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }

  function setSelectionOffset(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    let remaining = offset;
    let found = null;

    while ((node = walker.nextNode())) {
      if (remaining <= node.textContent.length) {
        found = { node: node, offset: remaining };
        break;
      }
      remaining -= node.textContent.length;
    }

    const range = document.createRange();
    if (found) {
      range.setStart(found.node, found.offset);
      range.collapse(true);
    } else {
      range.selectNodeContents(root);
      range.collapse(false);
    }

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* ----------------------------------------------------------------------
     Two-way sync
     ---------------------------------------------------------------------- */
  const SYNC_DEBOUNCE_MS = 150;
  let mdTimer = null;
  let suppressMdInput = false;
  let suppressDocInput = false;

  function setSyncStatus(text) {
    if (syncStatus) syncStatus.textContent = text;
  }

  function updateStats() {
    const md = mdInput.value;
    const mdWords = md.trim() ? md.trim().split(/\s+/).length : 0;
    const mdLines = md ? md.split('\n').length : 0;

    mdStatsBadge.textContent = mdWords + (mdWords === 1 ? ' word' : ' words');
    mdLinesCount.textContent = mdLines + (mdLines === 1 ? ' line' : ' lines');
    mdCharsCount.textContent = md.length + ' chars';

    const docText = (docEditor.innerText || '').trim();
    const docWords = docText ? docText.split(/\s+/).length : 0;

    docStatsBadge.textContent = docWords + (docWords === 1 ? ' word' : ' words');
    docWordsCount.textContent = docWords + ' words displayed';
  }

  // State for the image / table resize handles. Declared up here so the
  // rendering helpers below can reference it without running into the
  // temporal dead zone.
  let resizeTarget = null;
  let resizeHandles = [];
  let isDragging = false;
  let positionFrame = null;

  // Markdown source -> document
  function renderFromMarkdown() {
    const html = markdownToHtml(mdInput.value);
    if (html === docEditor.innerHTML) {
      updateStats();
      return;
    }

    const caret = getSelectionOffset(docEditor);
    docEditor.innerHTML = html;
    setSelectionOffset(docEditor, caret);
    updateStats();

    // The re-render replaced the selected image/table; point the resize
    // handles at the new element.
    if (typeof reanchorResizeTarget === 'function') {
      reanchorResizeTarget();
      if (resizeTarget) positionHandles();
    }
  }

  // Document -> markdown source
  function syncFromDocument() {
    const md = normalizeListMarkers(htmlToMarkdown(docEditor.innerHTML));
    if (md !== mdInput.value) {
      suppressMdInput = true;
      mdInput.value = md;
      // Release the guard on the next task so programmatic assignment never
      // re-enters the debounce handler.
      setTimeout(() => { suppressMdInput = false; }, 0);
    }
    updateStats();
  }

  mdInput.addEventListener('input', () => {
    if (suppressMdInput) return;
    setSyncStatus('Syncing…');
    clearTimeout(mdTimer);
    mdTimer = setTimeout(() => {
      renderFromMarkdown();
      setSyncStatus('Synced');
    }, SYNC_DEBOUNCE_MS);
  });

  docEditor.addEventListener('input', () => {
    if (suppressDocInput) return;
    syncFromDocument();
    setSyncStatus('Synced');
  });

  // Paste as plain text so Word/Docs formatting doesn't leak into the markdown.
  docEditor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  /* ----------------------------------------------------------------------
     Toolbar
     ---------------------------------------------------------------------- */
  const TEXT_COLORS = [
    '#202124', '#3c4043', '#5f6368', '#80868b', '#9aa0a6', '#dadce0',
    '#4285f4', '#1a73e8', '#1967d2', '#0b57d0', '#d93025', '#e8710a',
    '#f9ab00', '#188038', '#e2e3e3',
  ];

  const HIGHLIGHT_COLORS = [
    '#ffffff', '#fdd663', '#fbbc04', '#ffd8e4', '#f28b82', '#d7f8d0',
    '#a8c7fa', '#c58af9', '#b6e3f4', '#a4a2ad',
  ];

  function buildSwatches(container, colors, command) {
    container.innerHTML = '';
    colors.forEach((color) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'tb-swatch';
      swatch.style.background = color;
      swatch.title = color;
      swatch.setAttribute('aria-label', 'Apply color ' + color);
      swatch.addEventListener('mousedown', (e) => e.preventDefault());
      swatch.addEventListener('click', () => {
        document.execCommand('styleWithCSS', false, true);
        document.execCommand(command, false, color);
        document.execCommand('styleWithCSS', false, false);
        closePopovers();
        syncFromDocument();
      });
      container.appendChild(swatch);
    });
  }

  const textcolorSwatches = document.getElementById('textcolor-swatches');
  const highlightSwatches = document.getElementById('highlight-swatches');
  if (textcolorSwatches) buildSwatches(textcolorSwatches, TEXT_COLORS, 'foreColor');
  if (highlightSwatches) buildSwatches(highlightSwatches, HIGHLIGHT_COLORS, 'hiliteColor');

  function closePopovers() {
    document.querySelectorAll('.tb-popover').forEach((p) => { p.hidden = true; });
  }

  function togglePopover(popover) {
    const willOpen = popover.hidden;
    closePopovers();
    if (willOpen) popover.hidden = false;
  }

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.tb-popover') && !e.target.closest('#textcolor-btn') &&
        !e.target.closest('#highlight-btn')) {
      closePopovers();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopovers();
  });

  const textcolorBtn = document.getElementById('textcolor-btn');
  const textcolorPopover = document.getElementById('textcolor-popover');
  const highlightBtn = document.getElementById('highlight-btn');
  const highlightPopover = document.getElementById('highlight-popover');

  if (textcolorBtn && textcolorPopover) {
    textcolorBtn.addEventListener('mousedown', (e) => e.preventDefault());
    textcolorBtn.addEventListener('click', () => togglePopover(textcolorPopover));
  }
  if (highlightBtn && highlightPopover) {
    highlightBtn.addEventListener('mousedown', (e) => e.preventDefault());
    highlightBtn.addEventListener('click', () => togglePopover(highlightPopover));
  }

  // Generic execCommand buttons
  toolbar.querySelectorAll('[data-cmd]').forEach((btn) => {
    // Keep the document selection when the button is pressed.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const spec = btn.getAttribute('data-cmd');
      const [command, value] = spec.split(':');
      if (command === 'formatBlock') {
        document.execCommand('formatBlock', false, value || 'p');
      } else {
        document.execCommand(command, false, value || null);
      }
      syncFromDocument();
    });
  });

  // Paragraph style select
  const styleSelect = document.getElementById('style-select');
  if (styleSelect) {
    styleSelect.addEventListener('mousedown', () => {
      // Preserve selection when the select grabs focus.
      const sel = window.getSelection();
      if (sel && sel.rangeCount && docEditor.contains(sel.anchorNode)) {
        styleSelect.dataset.restoreFocus = '1';
      }
    });
    styleSelect.addEventListener('change', () => {
      document.execCommand('formatBlock', false, styleSelect.value);
      syncFromDocument();
    });
  }

  // Font family
  const fontSelect = document.getElementById('font-select');
  if (fontSelect) {
    fontSelect.addEventListener('change', () => {
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('fontName', false, fontSelect.value);
      document.execCommand('styleWithCSS', false, false);
      syncFromDocument();
    });
  }

  // Font size
  const fontsizeSelect = document.getElementById('fontsize-select');
  if (fontsizeSelect) {
    fontsizeSelect.addEventListener('change', () => {
      const pt = parseFloat(fontsizeSelect.value);
      // `execCommand('fontSize')` only understands the legacy 1-7 scale, which
      // maps to keywords such as "xxx-large". The size is therefore applied
      // directly as a px value so it round-trips through Turndown intact.
      applyFontSize(pt * (96 / 72));
      syncFromDocument();
    });
  }

  // Wraps the current selection in a span carrying an explicit font-size.
  function applyFontSize(px) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;

    const range = sel.getRangeAt(0);
    if (!docEditor.contains(range.commonAncestorContainer)) return;

    const wrapper = document.createElement('span');
    wrapper.style.fontSize = px + 'px';

    try {
      range.surroundContents(wrapper);
    } catch (err) {
      // The selection spans multiple blocks, so surroundContents fails. In that
      // case each text node inside the range is wrapped individually.
      const textNodes = [];
      const walker = document.createTreeWalker(
        docEditor,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) =>
            range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
        }
      );
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);
      textNodes.forEach((tn) => {
        const span = document.createElement('span');
        span.style.fontSize = px + 'px';
        tn.parentNode.insertBefore(span, tn);
        span.appendChild(tn);
      });
    }
  }

  // Line spacing
  const spacingSelect = document.getElementById('spacing-select');
  if (spacingSelect) {
    spacingSelect.addEventListener('change', () => {
      const block = getCurrentBlock();
      if (!block) return;
      block.style.lineHeight = spacingSelect.value;
      syncFromDocument();
    });
  }

  // Zoom
  const zoomSelect = document.getElementById('zoom-select');
  if (zoomSelect) {
    zoomSelect.addEventListener('change', () => {
      document.documentElement.style.setProperty('--doc-zoom', zoomSelect.value);
    });
  }

  function getCurrentBlock() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.anchorNode;
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    while (node && node !== docEditor) {
      if (node.nodeType === Node.ELEMENT_NODE &&
          /^(P|DIV|H1|H2|H3|H4|H5|H6|LI|BLOCKQUOTE|PRE)$/.test(node.nodeName)) {
        return node;
      }
      node = node.parentNode;
    }
    return docEditor;
  }

  // Checklist
  const checklistBtn = document.getElementById('checklist-btn');
  if (checklistBtn) {
    checklistBtn.addEventListener('mousedown', (e) => e.preventDefault());
    checklistBtn.addEventListener('click', () => {
      document.execCommand('insertHTML', false,
        '<ul class="checklist"><li><input type="checkbox" checked> New task</li></ul><p><br></p>');
      syncFromDocument();
    });
  }

  // Insert link
  const linkBtn = document.getElementById('link-btn');
  if (linkBtn) {
    linkBtn.addEventListener('mousedown', (e) => e.preventDefault());
    linkBtn.addEventListener('click', () => {
      const sel = window.getSelection();
      const selected = sel && sel.toString();
      const url = window.prompt('Link URL', 'https://');
      if (!url) return;
      if (selected) {
        document.execCommand('createLink', false, url);
      } else {
        document.execCommand('insertHTML', false,
          '<a href="' + url.replace(/"/g, '&quot;') + '">' + url + '</a>');
      }
      syncFromDocument();
    });
  }

  // Insert image
  const imageBtn = document.getElementById('image-btn');
  const imageFileInput = document.getElementById('image-file-input');
  const imageUrlBtn = document.getElementById('image-url-btn');

  if (imageBtn && imageFileInput) {
    imageBtn.addEventListener('mousedown', (e) => e.preventDefault());
    imageBtn.addEventListener('click', () => imageFileInput.click());

    imageFileInput.addEventListener('change', () => {
      const file = imageFileInput.files && imageFileInput.files[0];
      if (file) insertImageFile(file);
      imageFileInput.value = '';
    });
  }

  if (imageUrlBtn) {
    imageUrlBtn.addEventListener('mousedown', (e) => e.preventDefault());
    imageUrlBtn.addEventListener('click', () => {
      const url = window.prompt('Image URL', 'https://');
      if (!url) return;
      ensureCaret();
      document.execCommand('insertImage', false, url);
      syncFromDocument();
    });
  }

  // Ensures the document has focus and a caret, so that an insertion command
  // has somewhere to place the new node.
  function ensureCaret() {
    const sel = window.getSelection();
    const hasCaretInDoc =
      sel &&
      sel.rangeCount &&
      docEditor.contains(sel.getRangeAt(0).commonAncestorContainer);

    if (hasCaretInDoc) return true;

    docEditor.focus();

    // Fall back to the end of the last block.
    const blocks = docEditor.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td');
    const target = blocks.length ? blocks[blocks.length - 1] : docEditor;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  // Reads an image from disk and embeds it as a data URL so the document stays
  // self-contained (and keeps working when the file is saved alongside it).
  function insertImageFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      showToast('Please choose an image file');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = String(e.target.result || '');
      ensureCaret();
      document.execCommand('insertImage', false, dataUrl);
      syncFromDocument();
      showToast('Image inserted');
    };
    reader.onerror = () => showToast('Could not read the image');
    reader.readAsDataURL(file);
  }

  // Insert table
  const tableBtn = document.getElementById('table-btn');
  if (tableBtn) {
    tableBtn.addEventListener('mousedown', (e) => e.preventDefault());
    tableBtn.addEventListener('click', () => {
      const rows = 3;
      const cols = 3;
      let html = '<table><thead><tr>';
      for (let c = 0; c < cols; c++) html += '<th>Header ' + (c + 1) + '</th>';
      html += '</tr></thead><tbody>';
      for (let r = 0; r < rows - 1; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) html += '<td>Cell</td>';
        html += '</tr>';
      }
      html += '</tbody></table><p><br></p>';
      document.execCommand('insertHTML', false, html);
      syncFromDocument();
    });
  }

  // Horizontal rule
  const hrBtn = document.getElementById('hr-btn');
  if (hrBtn) {
    hrBtn.addEventListener('mousedown', (e) => e.preventDefault());
    hrBtn.addEventListener('click', () => {
      document.execCommand('insertHorizontalRule');
      syncFromDocument();
    });
  }

  // Print
  const printBtn = document.getElementById('print-btn');
  if (printBtn) {
    printBtn.addEventListener('mousedown', (e) => e.preventDefault());
    printBtn.addEventListener('click', () => window.print());
  }

  /* ----------------------------------------------------------------------
     Source pane actions
     ---------------------------------------------------------------------- */
  const SAMPLE_MARKDOWN = [
    '# Markdown Editor',
    '',
    'Write **Markdown** on the left, edit it like a Google Doc on the right.',
    '',
    '## Formatting',
    '',
    'This text is **bold**, this is *italic*, this is <u>underlined</u>, and this is ~~struck through~~.',
    '',
    'You can also use inline styles like <span style="color:#d93025">red text</span> and ' +
      '<span style="background-color:#fdd663">highlighted text</span>.',
    '',
    '<p style="text-align:center">This paragraph is center-aligned.</p>',
    '',
    '## Lists',
    '',
    '- First bullet item',
    '- Second bullet item',
    '  - Nested bullet item',
    '',
    '1. First numbered step',
    '2. Second numbered step',
    '',
    '- [x] Completed task',
    '- [ ] Pending task',
    '',
    '## Table',
    '',
    '| Tool | Purpose | Status |',
    '| --- | --- | --- |',
    '| Bulk Gmail Filter | Extract emails by domain | Live |',
    '| QR Generator | Create payment and contact codes | Live |',
    '| Markdown Editor | Write and format documents | Live |',
    '',
    '## Code',
    '',
    '```js',
    'const greet = (name) => `Hello, ${name}!`;',
    'console.log(greet("world"));',
    '```',
    '',
    '## Quote',
    '',
    '> The best way to predict the future is to invent it.',
    '',
    '---',
    '',
    'A [link to the tools directory](../index.html) and an image:',
    '',
    '![Logo](../../images/favicon.png)',
    '',
    '> Tip: click the image or the table above to get resize handles.',
    '',
  ].join('\n');

  const sampleBtn = document.getElementById('sample-btn');
  if (sampleBtn) {
    sampleBtn.addEventListener('click', () => {
      mdInput.value = SAMPLE_MARKDOWN;
      renderFromMarkdown();
      setSyncStatus('Synced');
      showToast('Sample document loaded');
    });
  }

  const clearBtn = document.getElementById('clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      mdInput.value = '';
      docEditor.innerHTML = '<p><br></p>';
      updateStats();
      setSyncStatus('Synced');
      showToast('Cleared');
    });
  }

  /* ----------------------------------------------------------------------
     Export — .docx / .pdf / .html / .md / .txt
     ---------------------------------------------------------------------- */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const exportBtn = document.getElementById('export-btn');
  const exportMenu = document.getElementById('export-menu');

  function closeExportMenu() {
    if (!exportMenu) return;
    exportMenu.hidden = true;
    if (exportBtn) exportBtn.setAttribute('aria-expanded', 'false');
  }

  if (exportBtn && exportMenu) {
    exportBtn.addEventListener('mousedown', (e) => e.preventDefault());
    exportBtn.addEventListener('click', () => {
      const willOpen = exportMenu.hidden;
      exportMenu.hidden = !willOpen;
      exportBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });

    exportMenu.querySelectorAll('[data-export]').forEach((item) => {
      item.addEventListener('click', () => {
        closeExportMenu();
        runExport(item.getAttribute('data-export'));
      });
    });

    document.addEventListener('mousedown', (e) => {
      if (!exportMenu.hidden && !e.target.closest('.export-wrapper')) closeExportMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeExportMenu();
    });
  }

  function runExport(format) {
    switch (format) {
      case 'docx': return exportDocx();
      case 'pdf': return exportPdf();
      case 'html': return exportHtml();
      case 'md': return exportMarkdown();
      case 'txt': return exportText();
      default: return undefined;
    }
  }

  function exportMarkdown() {
    downloadBlob(new Blob([mdInput.value], { type: 'text/markdown;charset=utf-8' }), 'document.md');
    showToast('Markdown file downloaded');
  }

  function exportText() {
    const text = (docEditor.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'document.txt');
    showToast('Plain text file downloaded');
  }

  function exportHtml() {
    const html = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '<title>Document</title>',
      '<style>',
      'body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.5;',
      'max-width:816px;margin:48px auto;padding:0 24px;color:#202124;}',
      'h1{font-size:20pt;font-weight:400;} h2{font-size:16pt;font-weight:400;} h3{font-size:14pt;font-weight:400;}',
      'table{border-collapse:collapse;width:100%;} th,td{border:1px solid #dadce0;padding:6px 10px;text-align:left;}',
      'th{background:#f1f3f4;font-weight:500;} code{background:rgba(0,0,0,.06);padding:1px 4px;border-radius:3px;}',
      'pre{background:#f1f3f4;padding:12px 14px;border-radius:6px;overflow-x:auto;}',
      'blockquote{border-left:3px solid #dadce0;padding-left:14px;color:#5f6368;}',
      '</style>',
      '</head>',
      '<body>',
      docEditor.innerHTML,
      '</body>',
      '</html>',
    ].join('\n');

    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), 'document.html');
    showToast('HTML file downloaded');
  }

  /* ---------------------------- .docx ---------------------------------- */
  function collectDocxBlocks(root) {
    const D = window.docx;
    const blocks = [];
    const nodes = Array.from((root || docEditor).childNodes);

    const alignmentOf = (node) => {
      const style = (node.getAttribute && node.getAttribute('style')) || '';
      const match = /text-align:\s*(left|center|right|justify)/.exec(style);
      if (!match) return D.AlignmentType.LEFT;
      if (match[1] === 'center') return D.AlignmentType.CENTER;
      if (match[1] === 'right') return D.AlignmentType.RIGHT;
      if (match[1] === 'justify') return D.AlignmentType.JUSTIFIED;
      return D.AlignmentType.LEFT;
    };

    // Converts inline nodes into docx TextRun objects, honouring bold, italic,
    // underline, strike, colour and highlight.
    function inlineRuns(container, inherited) {
      const runs = [];
      container.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent;
          if (!text) return;
          const opts = Object.assign({}, inherited);
          if (!inherited.link && text.trim().length) opts.text = text;
          else opts.text = text;
          runs.push(new D.TextRun(opts));
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.nodeName;
        const style = node.getAttribute('style') || '';
        const opts = Object.assign({}, inherited);

        if (tag === 'BR') {
          runs.push(new D.TextRun({ break: 1 }));
          return;
        }
        if (tag === 'B' || tag === 'STRONG') opts.bold = true;
        if (tag === 'I' || tag === 'EM') opts.italic = true;
        if (tag === 'U') opts.underline = {};
        if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') opts.strike = true;

        const colorMatch = /color:\s*([^;"]+)/.exec(style);
        if (colorMatch) opts.color = toHexColor(colorMatch[1].trim());
        const bgMatch = /background-color:\s*([^;"]+)/.exec(style);
        if (bgMatch) opts.highlight = toHexColor(bgMatch[1].trim());
        const sizeMatch = /font-size:\s*([\d.]+)px/.exec(style);
        // docx expresses font size in half-points.
        if (sizeMatch) opts.size = Math.round(parseFloat(sizeMatch[1]) * 0.75 * 2);
        const familyMatch = /font-family:\s*([^;"]+)/.exec(style);
        if (familyMatch) opts.font = familyMatch[1].trim();

        if (tag === 'A') {
          const href = node.getAttribute('href');
          if (href) {
            opts.link = href;
            opts.style = 'Hyperlink';
          }
        }

        runs.push.apply(runs, inlineRuns(node, opts));
      });
      return runs;
    }

    function toHexColor(value) {
      const v = value.trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(v)) return v.slice(1).toUpperCase();
      if (/^#[0-9a-f]{3}$/.test(v)) {
        return (v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toUpperCase();
      }
      const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
      if (rgb) {
        return (
          Number(rgb[1]).toString(16).padStart(2, '0') +
          Number(rgb[2]).toString(16).padStart(2, '0') +
          Number(rgb[3]).toString(16).padStart(2, '0')
        ).toUpperCase();
      }
      return undefined;
    }

    function buildRuns(node) {
      return inlineRuns(node, {});
    }

    nodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim()) {
          blocks.push(new D.Paragraph({ children: buildRuns(node) }));
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.nodeName;

      if (/^H[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        const headingMap = {
          1: D.HeadingLevel.TITLE,
          2: D.HeadingLevel.HEADING_1,
          3: D.HeadingLevel.HEADING_2,
          4: D.HeadingLevel.HEADING_3,
          5: D.HeadingLevel.HEADING_4,
          6: D.HeadingLevel.HEADING_5,
        };
        blocks.push(new D.Paragraph({
          heading: headingMap[level] || D.HeadingLevel.HEADING_1,
          alignment: alignmentOf(node),
          children: buildRuns(node),
        }));
        return;
      }

      if (tag === 'P') {
        const runs = buildRuns(node);
        blocks.push(new D.Paragraph({
          alignment: alignmentOf(node),
          children: runs.length ? runs : [new D.TextRun('')],
        }));
        return;
      }

      if (tag === 'BLOCKQUOTE') {
        blocks.push(new D.Paragraph({
          indent: { left: 720 },
          children: buildRuns(node),
        }));
        return;
      }

      if (tag === 'PRE') {
        const codeText = node.textContent.replace(/\n$/, '');
        codeText.split('\n').forEach((line) => {
          blocks.push(new D.Paragraph({
            shading: { type: D.ShadingType.CLEAR, fill: 'F1F3F4' },
            children: [new D.TextRun({ text: line, font: 'Courier New', size: 20 })],
          }));
        });
        return;
      }

      if (tag === 'HR') {
        blocks.push(new D.Paragraph({
          border: { bottom: { color: 'DADCE0', style: D.BorderStyle.SINGLE, size: 6 } },
          children: [new D.TextRun('')],
        }));
        return;
      }

      if (tag === 'UL' || tag === 'OL') {
        const ordered = tag === 'OL';
        let counter = Number(node.getAttribute('start') || 1);
        Array.from(node.children).forEach((li) => {
          if (li.nodeName !== 'LI') return;
          const children = buildRuns(li);
          if (ordered) {
            children.unshift(new D.TextRun({ text: counter + '. ' }));
            counter++;
          }
          blocks.push(new D.Paragraph({
            bullet: ordered ? undefined : { level: 0 },
            indent: { left: 720, hanging: 360 },
            children: children.length ? children : [new D.TextRun('')],
          }));
        });
        return;
      }

      if (tag === 'TABLE') {
        const rows = [];
        Array.from(node.querySelectorAll('tr')).forEach((tr) => {
          const cells = Array.from(tr.children).map((cell) => {
            const isHeader = cell.nodeName === 'TH';
            return new D.TableCell({
              children: [new D.Paragraph({
                children: buildRuns(cell).length ? buildRuns(cell) : [new D.TextRun('')],
              })],
              shading: isHeader ? { type: D.ShadingType.CLEAR, fill: 'F1F3F4' } : undefined,
            });
          });
          rows.push(new D.TableRow({ children: cells }));
        });
        if (rows.length) {
          blocks.push(new D.Table({
            width: { size: 100, type: D.WidthType.PERCENTAGE },
            rows: rows,
          }));
        }
        return;
      }

      if (tag === 'IMG') {
        const src = node.getAttribute('src') || '';
        blocks.push(new D.Paragraph({
          children: [new D.TextRun({ text: '[Image: ' + src + ']', italics: true, color: '5F6368' })],
        }));
        return;
      }

      // Unknown container: recurse into its children.
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const wrapper = document.createElement('div');
          wrapper.appendChild(child.cloneNode(true));
          blocks.push.apply(blocks, collectDocxBlocks(wrapper));
        }
      });
    });

    return blocks;
  }

  function exportDocx() {
    const D = window.docx;
    if (!D || !D.Packer) {
      showToast('DOCX export is unavailable');
      return;
    }

    let blocks;
    try {
      blocks = collectDocxBlocks();
    } catch (err) {
      showToast('Could not build the DOCX file');
      return;
    }

    const doc = new D.Document({
      sections: [{
        properties: {},
        children: blocks.length ? blocks : [new D.Paragraph({ children: [new D.TextRun('')] })],
      }],
    });

    D.Packer.toBlob(doc).then((blob) => {
      downloadBlob(blob, 'document.docx');
      showToast('Word document downloaded');
    }).catch(() => {
      showToast('Could not build the DOCX file');
    });
  }

  /* ---------------------------- .pdf ----------------------------------- */
  // Removes fully white rows from the bottom of a rendered canvas so the PDF
  // is not padded with empty space.
  function trimCanvas(source) {
    const ctx = source.getContext('2d');
    const { width, height } = source;
    const data = ctx.getImageData(0, 0, width, height).data;

    let lastContent = 0;
    for (let y = height - 1; y >= 0; y--) {
      let hasContent = false;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        // Anything that is not pure white counts as content.
        if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
          hasContent = true;
          break;
        }
      }
      if (hasContent) {
        lastContent = y;
        break;
      }
    }

    const trimmedHeight = Math.min(height, lastContent + 1);
    if (trimmedHeight >= height) return source;

    const out = document.createElement('canvas');
    out.width = width;
    out.height = trimmedHeight;
    out.getContext('2d').drawImage(
      source,
      0, 0, width, trimmedHeight,
      0, 0, width, trimmedHeight
    );
    return out;
  }

  function exportPdf() {
    const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDFCtor || typeof window.html2canvas !== 'function') {
      showToast('PDF export is unavailable');
      return;
    }

    showToast('Rendering PDF…');

    // The document surface is cloned so the on-screen zoom and scroll position
    // do not affect the captured output.
    const source = docEditor;
    const clone = source.cloneNode(true);
    clone.style.width = '816px';
    clone.style.maxWidth = 'none';
    clone.style.minHeight = '0';
    clone.style.zoom = '1';
    clone.style.boxShadow = 'none';
    clone.style.padding = '56px 72px';

    const stage = document.createElement('div');
    stage.style.cssText =
      'position:fixed;left:-10000px;top:0;background:#ffffff;color:#202124;';
    stage.appendChild(clone);
    document.body.appendChild(stage);

    window.html2canvas(clone, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: clone.scrollWidth,
      windowHeight: clone.scrollHeight,
    }).then((rawCanvas) => {
      document.body.removeChild(stage);

      // Trim any trailing whitespace so a short document does not spill onto a
      // second, nearly empty page.
      const canvas = trimCanvas(rawCanvas);

      // US Letter dimensions in points.
      const pageWidth = 612;
      const pageHeight = 792;
      const margin = 40;
      const usableWidth = pageWidth - margin * 2;

      // The page format follows the document: a short document produces a
      // single custom-sized page instead of spilling a few lines onto a second,
      // nearly empty sheet.
      const contentHeight = (canvas.height * usableWidth) / canvas.width;
      const pdfHeight = contentHeight + margin * 2 <= pageHeight
        ? contentHeight + margin * 2
        : pageHeight;

      const pdf = new jsPDFCtor({
        unit: 'pt',
        format: [pageWidth, pdfHeight],
        orientation: 'portrait',
      });

      const imgWidth = usableWidth;
      const pxPerPage = ((pdfHeight - margin * 2) * canvas.width) / imgWidth;

      let y = 0;
      let page = 0;

      while (y < canvas.height) {
        if (page > 0) pdf.addPage([pageWidth, pdfHeight], 'portrait');

        const sliceHeight = Math.min(pxPerPage, canvas.height - y);

        const slice = document.createElement('canvas');
        slice.width = canvas.width;
        slice.height = Math.ceil(sliceHeight);

        const ctx = slice.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(
          canvas,
          0,
          Math.floor(y),
          canvas.width,
          Math.ceil(sliceHeight),
          0,
          0,
          canvas.width,
          Math.ceil(sliceHeight)
        );

        pdf.addImage(
          slice.toDataURL('image/jpeg', 0.95),
          'JPEG',
          margin,
          margin,
          imgWidth,
          (sliceHeight * imgWidth) / canvas.width,
          undefined,
          'FAST'
        );

        y += sliceHeight;
        page++;
      }

      pdf.save('document.pdf');
      showToast('PDF downloaded');
    }).catch(() => {
      document.body.removeChild(stage);
      showToast('Could not render the PDF');
    });
  }

  const copyBtn = document.getElementById('copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = mdInput.value;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        showToast('Markdown copied to clipboard!');
      } catch (err) {
        showToast('Copy failed — select and copy manually');
      }
    });
  }

  // Upload
  const uploadBtn = document.getElementById('upload-btn');
  const fileInput = document.getElementById('file-input');
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) readMarkdownFile(file);
      fileInput.value = '';
    });
  }

  function readMarkdownFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      mdInput.value = String(e.target.result || '');
      renderFromMarkdown();
      setSyncStatus('Synced');
      showToast('Loaded ' + file.name);
    };
    reader.onerror = () => showToast('Could not read the file');
    reader.readAsText(file);
  }

  // Drag & drop
  if (dropzoneOverlay) {
    let dragDepth = 0;
    const panel = dropzoneOverlay.parentElement;

    panel.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      dropzoneOverlay.classList.add('active');
    });
    panel.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    panel.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropzoneOverlay.classList.remove('active');
    });
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropzoneOverlay.classList.remove('active');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) readMarkdownFile(file);
    });
  }

  /* Drag & drop images straight onto the document ---------------------- */
  const docSurface = document.getElementById('doc-surface');
  const imageDropOverlay = document.getElementById('image-dropzone-overlay');

  if (docSurface && imageDropOverlay) {
    let imageDragDepth = 0;

    const carriesImage = (e) => {
      const types = e.dataTransfer && e.dataTransfer.types;
      if (!types) return false;
      return Array.prototype.indexOf.call(types, 'Files') !== -1;
    };

    docSurface.addEventListener('dragenter', (e) => {
      if (!carriesImage(e)) return;
      e.preventDefault();
      imageDragDepth++;
      imageDropOverlay.classList.add('active');
    });

    docSurface.addEventListener('dragover', (e) => {
      if (!carriesImage(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    docSurface.addEventListener('dragleave', (e) => {
      if (!carriesImage(e)) return;
      e.preventDefault();
      imageDragDepth = Math.max(0, imageDragDepth - 1);
      if (imageDragDepth === 0) imageDropOverlay.classList.remove('active');
    });

    docSurface.addEventListener('drop', (e) => {
      if (!carriesImage(e)) return;
      e.preventDefault();
      e.stopPropagation();
      imageDragDepth = 0;
      imageDropOverlay.classList.remove('active');

      const files = Array.prototype.slice.call(e.dataTransfer.files || []);
      const image = files.find((f) => /^image\//.test(f.type));
      if (!image) {
        showToast('Drop an image file to insert it');
        return;
      }

      // Insert at the drop position when the caret can be placed there.
      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (range && docEditor.contains(range.commonAncestorContainer)) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }

      insertImageFile(image);
    });
  }

  /* ----------------------------------------------------------------------
     Resize handles for images and tables
     ---------------------------------------------------------------------- */
  const resizeLayer = document.createElement('div');
  resizeLayer.className = 'resize-layer';
  resizeLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:14;';
  resizeLayer.hidden = true;

  if (docSurface) docSurface.appendChild(resizeLayer);

  function clearResize() {
    if (isDragging) return;
    resizeTarget = null;
    resizeHandles.forEach((h) => h.remove());
    resizeHandles = [];
    resizeLayer.hidden = true;
    docEditor.querySelectorAll('.resize-selected').forEach((el) => {
      el.classList.remove('resize-selected');
    });
  }

  // Positions the handles over the selected element. Rebuilding the handles
  // is destructive, so it only ever happens when no drag is in flight —
  // otherwise the handle that owns the drag would be pulled out from under
  // the pointer and the browser would lose the event target.
  function positionHandles() {
    if (!resizeTarget || isDragging) return;

    resizeHandles.forEach((h) => h.remove());
    resizeHandles = [];

    const surfaceRect = docSurface.getBoundingClientRect();
    const rect = resizeTarget.getBoundingClientRect();

    const top = rect.top - surfaceRect.top;
    const left = rect.left - surfaceRect.left;

    if (resizeTarget.nodeName === 'IMG') {
      const handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.style.top = top + rect.height - 6 + 'px';
      handle.style.left = left + rect.width - 6 + 'px';
      resizeLayer.appendChild(handle);
      resizeHandles.push(handle);
      attachImageResize(handle);
      return;
    }

    // Table: a divider between every pair of columns, and one under each row.
    const table = resizeTarget;
    const rows = Array.prototype.slice.call(table.querySelectorAll('tr'));
    if (!rows.length) return;

    const firstRow = rows[0];
    const cells = Array.prototype.slice.call(firstRow.children);

    cells.forEach((cell, index) => {
      if (index === cells.length - 1) return;
      const cellRect = cell.getBoundingClientRect();
      const handle = document.createElement('div');
      handle.className = 'col-resize-handle';
      handle.style.left = (cellRect.right - surfaceRect.left) + 'px';
      handle.style.top = top + 'px';
      handle.style.height = rect.height + 'px';
      resizeLayer.appendChild(handle);
      resizeHandles.push(handle);
      attachColumnResize(handle, table, index);
    });

    rows.forEach((row) => {
      const rowRect = row.getBoundingClientRect();
      const handle = document.createElement('div');
      handle.className = 'row-resize-handle';
      handle.style.top = (rowRect.bottom - surfaceRect.top) + 'px';
      handle.style.left = left + 'px';
      handle.style.width = rect.width + 'px';
      resizeLayer.appendChild(handle);
      resizeHandles.push(handle);
      attachRowResize(handle, table, row);
    });
  }

  // Cheap, non-destructive reposition used while a drag is in flight.
  function repositionHandles() {
    if (!resizeTarget || !resizeTarget.isConnected) return;

    const surfaceRect = docSurface.getBoundingClientRect();
    const rect = resizeTarget.getBoundingClientRect();

    if (resizeTarget.nodeName === 'IMG') {
      const handle = resizeHandles[0];
      if (!handle) return;
      handle.style.top = (rect.top - surfaceRect.top + rect.height - 6) + 'px';
      handle.style.left = (rect.left - surfaceRect.left + rect.width - 6) + 'px';
      return;
    }

    const table = resizeTarget;
    const rows = Array.prototype.slice.call(table.querySelectorAll('tr'));
    const cells = rows.length
      ? Array.prototype.slice.call(rows[0].children)
      : [];

    const top = rect.top - surfaceRect.top;
    const left = rect.left - surfaceRect.left;

    let colIndex = 0;
    cells.forEach((cell, index) => {
      if (index === cells.length - 1) return;
      const handle = resizeHandles[colIndex++];
      if (!handle) return;
      const cellRect = cell.getBoundingClientRect();
      handle.style.left = (cellRect.right - surfaceRect.left) + 'px';
      handle.style.top = top + 'px';
      handle.style.height = rect.height + 'px';
    });

    rows.forEach((row, index) => {
      const handle = resizeHandles[colIndex + index];
      if (!handle) return;
      const rowRect = row.getBoundingClientRect();
      handle.style.top = (rowRect.bottom - surfaceRect.top) + 'px';
      handle.style.left = left + 'px';
      handle.style.width = rect.width + 'px';
    });
  }

  // Coalesces repositioning into a single frame so a burst of scroll or
  // mousemove events cannot pile up layout work.
  function scheduleReposition() {
    if (positionFrame !== null) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = null;
      repositionHandles();
    });
  }

  function attachImageResize(handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const img = resizeTarget;
      const startX = e.clientX;
      const startRect = img.getBoundingClientRect();
      const startWidth = startRect.width;
      const startHeight = startRect.height;
      // Only lock the aspect ratio when the intrinsic size of the image is
      // known — a broken or unscaled image would otherwise be squashed.
      const ratio = img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0;

      handle.classList.add('dragging');
      isDragging = true;

      const onMove = (ev) => {
        const delta = ev.clientX - startX;
        const width = Math.max(40, Math.round(startWidth + delta));
        img.style.width = width + 'px';
        if (ratio) {
          img.style.height = Math.round(width * ratio) + 'px';
        } else if (startHeight && startWidth) {
          // Keep the on-screen proportions when the intrinsic size is unknown.
          img.style.height = Math.round((startHeight / startWidth) * width) + 'px';
        }
        scheduleReposition();
      };

      const onUp = () => {
        handle.classList.remove('dragging');
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        syncFromDocument();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Column widths are stored on a <colgroup>, which keeps them in the
  // markdown source when the document is converted back.
  function ensureColgroup(table) {
    let colgroup = table.querySelector('colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    // querySelectorAll returns a static NodeList, so the count has to be
    // tracked separately — re-reading cols.length would never change and the
    // loop would never end.
    const columnCount = table.rows[0].cells.length;
    let existing = colgroup.querySelectorAll('col').length;
    while (existing < columnCount) {
      colgroup.appendChild(document.createElement('col'));
      existing += 1;
    }
    return colgroup;
  }

  function attachColumnResize(handle, table, columnIndex) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // The colgroup has to exist before the drag starts, otherwise the table
      // would re-layout mid-gesture and the handle would slide out from under
      // the pointer.
      const colgroup = ensureColgroup(table);
      const cols = colgroup.querySelectorAll('col');
      const startX = e.clientX;
      const startWidth = table.rows[0].cells[columnIndex].getBoundingClientRect().width;

      // Fixed layout lets the <col> widths take effect deterministically.
      // The table keeps its intrinsic width so the fixed layout never has to
      // reconcile a column total against the container width — that
      // reconciliation is what makes Chrome's table layout spin.
      table.style.tableLayout = 'fixed';
      table.style.width = '100%';
      cols[columnIndex].style.width = startWidth + 'px';

      handle.classList.add('dragging');
      isDragging = true;

      const onMove = (ev) => {
        const width = Math.max(40, Math.round(startWidth + (ev.clientX - startX)));
        cols[columnIndex].style.width = width + 'px';
        scheduleReposition();
      };

      const onUp = () => {
        handle.classList.remove('dragging');
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        syncFromDocument();
        positionHandles();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function attachRowResize(handle, table, row) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startY = e.clientY;
      const startHeight = row.getBoundingClientRect().height;

      handle.classList.add('dragging');
      isDragging = true;

      const onMove = (ev) => {
        const height = Math.max(24, Math.round(startHeight + (ev.clientY - startY)));
        row.style.height = height + 'px';
        scheduleReposition();
      };

      const onUp = () => {
        handle.classList.remove('dragging');
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        syncFromDocument();
        positionHandles();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Clicking an image or a table selects it for resizing.
  docEditor.addEventListener('click', (e) => {
    const img = e.target.closest('img');
    const table = e.target.closest('table');

    if (img && docEditor.contains(img)) {
      clearResize();
      resizeTarget = img;
      img.classList.add('resize-selected');
      resizeLayer.hidden = false;
      positionHandles();
      return;
    }

    if (table && docEditor.contains(table)) {
      clearResize();
      resizeTarget = table;
      table.classList.add('resize-selected');
      resizeLayer.hidden = false;
      positionHandles();
      return;
    }

    clearResize();
  });

  // The document is re-rendered whenever the markdown changes, which detaches
  // the selected element. Re-anchor onto the equivalent element in the new
  // markup so the handles keep pointing at the right thing.
  function reanchorResizeTarget() {
    if (!resizeTarget || resizeTarget.isConnected) return;
    if (!docEditor.contains(resizeTarget)) {
      const kind = resizeTarget.nodeName;
      const next = kind === 'IMG'
        ? docEditor.querySelector('img')
        : docEditor.querySelector('table');
      if (!next) {
        clearResize();
        return;
      }
      resizeTarget = next;
      next.classList.add('resize-selected');
    }
  }

  docEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearResize();
  });

  // Keep the handles aligned when the pane is scrolled or resized. Scrolling
  // only repositions the existing handles — rebuilding them would destroy the
  // handle that is currently being dragged.
  if (docSurface) {
    docSurface.addEventListener('scroll', scheduleReposition, { passive: true });
    window.addEventListener('resize', scheduleReposition, { passive: true });
  }

  /* ----------------------------------------------------------------------
     Toast
     ---------------------------------------------------------------------- */
  const toast = document.getElementById('toast-notification');
  const toastMessage = document.getElementById('toast-message');
  let toastTimer = null;

  function showToast(message) {
    if (!toast || !toastMessage) return;
    toastMessage.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  /* ----------------------------------------------------------------------
     Keyboard shortcuts
     ---------------------------------------------------------------------- */
  document.addEventListener('keydown', (e) => {
    const inDoc = docEditor.contains(document.activeElement) ||
      document.activeElement === docEditor;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && inDoc) {
      e.preventDefault();
      if (linkBtn) linkBtn.click();
      return;
    }

    if (inDoc && (e.ctrlKey || e.metaKey)) {
      const key = e.key.toLowerCase();
      if (key === 'b' || key === 'i' || key === 'u') {
        // Let the browser handle the native shortcut inside contenteditable.
        setTimeout(() => syncFromDocument(), 0);
      }
    }
  });

  /* ----------------------------------------------------------------------
     Boot
     ---------------------------------------------------------------------- */
  docEditor.innerHTML = '<p><br></p>';
  updateStats();
  setSyncStatus('Synced');
})();
