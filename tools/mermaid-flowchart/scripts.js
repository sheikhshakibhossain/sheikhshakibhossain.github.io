/* =============================================================================
   Mermaid Flowchart Editor
   -----------------------------------------------------------------------------
   Left pane  : Mermaid source (textarea)
   Right pane : rendered SVG, with draggable nodes

   How drag -> code works
   ---------------------
   Mermaid's layout engine (ELK / Dagre) computes every node position, and
   Mermaid has no syntax for explicit coordinates. To make dragging meaningful
   AND keep the source valid Mermaid, manual offsets are stored in the source
   as a trailing directive block:

       %% layout: {"A":[12,40],"B":[130,40]}

   That block is a Mermaid comment, so the diagram still renders correctly in
   any other Mermaid viewer (positions are simply ignored there). Inside this
   tool the block is parsed back out and applied as a translate() offset on the
   matching SVG node, so a re-render restores what the user drew.

   Reordering is expressed by rewriting the order of the statements in the
   source, which is the only layout control Mermaid actually exposes.
   ========================================================================== */

(function () {
  'use strict';

  /* ----------------------------------------------------------------------
     Element references
     ---------------------------------------------------------------------- */
  const mermaidInput = document.getElementById('mermaid-input');
  const diagramContainer = document.getElementById('diagram-container');
  const diagramCanvas = document.getElementById('diagram-canvas');
  const diagramViewport = document.getElementById('diagram-viewport');
  const previewPlaceholder = document.getElementById('preview-placeholder');
  const errorBox = document.getElementById('error-box');
  const errorTitle = document.getElementById('error-title');
  const errorMessage = document.getElementById('error-message');
  const fixErrorBtn = document.getElementById('fix-error-btn');
  const parseStatusBadge = document.getElementById('parse-status-badge');
  const renderStatus = document.getElementById('render-status');
  const nodeCount = document.getElementById('node-count');
  const charCount = document.getElementById('char-count');
  const positionState = document.getElementById('position-state');
  const zoomLevelLabel = document.getElementById('zoom-level');
  const directionSelect = document.getElementById('direction-select');
  const themeSelect = document.getElementById('theme-select');
  const exportMenu = document.getElementById('export-menu');
  const exportBtn = document.getElementById('export-btn');
  const exportTransparent = document.getElementById('export-transparent');
  const exportScale = document.getElementById('export-scale');
  const toast = document.getElementById('toast');

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
        // "Auto" theme follows the site, so the diagram needs a re-render.
        if (themeSelect.value === 'auto') {
          mermaid.initialize(mermaidConfig());
          renderDiagram();
        }
      });
    }

    // Follow OS changes only while the user has not made an explicit choice.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('theme-mode')) applyTheme(e.matches);
    });
  })();

  /* ----------------------------------------------------------------------
     Mermaid setup
     ---------------------------------------------------------------------- */
  const SAMPLE = `flowchart TD
    A[Start] --> B{Is it valid?}
    B -->|Yes| C[Process the data]
    B -->|No| D[Show an error]
    C --> E{Run another check}
    E -->|Yes| C
    E -->|No| F[(Save to database)]
    F --> G([End])
    D --> G
`;

  const state = {
    zoom: 1,
    positions: {},      // nodeId -> [dx, dy]
    renderToken: 0,     // guards against out-of-order async renders
    pendingFix: null,   // auto-repair offered for the current error
  };

  function mermaidConfig() {
    const isDark = document.documentElement.classList.contains('dark');
    const choice = themeSelect.value;
    // "auto" follows the site theme; the rest pin an explicit Mermaid theme.
    const theme = choice === 'auto' ? (isDark ? 'dark' : 'default') : choice;
    const useDarkTheme = theme === 'dark';

    return {
      startOnLoad: false,
      securityLevel: 'loose',
      theme: theme === 'base' ? 'base' : theme,
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      flowchart: {
        useMaxWidth: false,
        htmlLabels: true,
        curve: 'basis',
        nodeSpacing: 55,
        rankSpacing: 60,
        padding: 12,
      },
      themeVariables: useDarkTheme ? {
        background: '#131316',
        primaryColor: '#27272a',
        primaryTextColor: '#fafafa',
        primaryBorderColor: '#3f3f46',
        lineColor: '#a1a1aa',
        textColor: '#fafafa',
        mainBkg: '#27272a',
        nodeBorder: '#3f3f46',
        clusterBkg: '#18181b',
        clusterBorder: '#3f3f46',
        edgeLabelBackground: '#131316',
      } : {},
    };
  }

  /* ----------------------------------------------------------------------
     Layout directive: reading / writing the %% layout block
     ---------------------------------------------------------------------- */
  const LAYOUT_RE = /^\s*%%\s*layout:\s*(\{.*\})\s*$/;

  function splitLayoutBlock(source) {
    const lines = source.split('\n');
    let block = null;
    const body = [];
    for (const line of lines) {
      const m = LAYOUT_RE.exec(line);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]);
          if (parsed && typeof parsed === 'object') {
            block = parsed;
            continue; // drop it from the body
          }
        } catch (_) {
          // Not valid JSON — treat the line as ordinary source.
        }
      }
      body.push(line);
    }
    return { body: body.join('\n'), positions: block || {} };
  }

  function serializePositions(positions) {
    const entries = Object.keys(positions)
      .filter((id) => {
        const p = positions[id];
        return Array.isArray(p) && (Math.abs(p[0]) > 0.5 || Math.abs(p[1]) > 0.5);
      })
      .map((id) => `"${id}":[${Math.round(positions[id][0])},${Math.round(positions[id][1])}]`);
    if (!entries.length) return null;
    return `%% layout: {${entries.join(',')}}`;
  }

  /**
   * Rebuild the source with an updated layout block.
   * The block is appended at the end so it never interrupts the diagram body.
   */
  function withLayoutBlock(source, positions) {
    const { body } = splitLayoutBlock(source);
    const serialized = serializePositions(positions);
    const trimmed = body.replace(/\s+$/, '');
    return serialized ? `${trimmed}\n${serialized}\n` : `${trimmed}\n`;
  }

  /* ----------------------------------------------------------------------
     Source helpers
     ---------------------------------------------------------------------- */
  function getSource() {
    return mermaidInput.value;
  }

  function setSource(value, { preserveSelection = false } = {}) {
    const start = mermaidInput.selectionStart;
    const end = mermaidInput.selectionEnd;
    mermaidInput.value = value;
    if (preserveSelection) {
      try {
        mermaidInput.setSelectionRange(start, end);
      } catch (_) { /* selection not applicable */ }
    }
  }

  function currentFlowDirection(source) {
    const m = /^\s*(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)\b/im.exec(source);
    return m ? m[1].toUpperCase() : null;
  }

  function setFlowDirection(source, direction) {
    if (currentFlowDirection(source) === direction) return source;
    // Replace an existing direction, or insert one after the header.
    if (/^\s*(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)\b/im.test(source)) {
      return source.replace(/^(\s*(?:flowchart|graph)\s+)(TB|TD|BT|LR|RL)\b/im, `$1${direction}`);
    }
    const header = /^\s*(?:flowchart|graph)\b/im.exec(source);
    if (header) {
      const insertAt = header.index + header[0].length;
      return source.slice(0, insertAt) + ` ${direction}` + source.slice(insertAt);
    }
    return `flowchart ${direction}\n${source}`;
  }

  /* ----------------------------------------------------------------------
     Node discovery in the rendered SVG
     ----------------------------------------------------------------------
     Mermaid emits flowchart nodes as <g class="node"> elements with an id
     of the shape "flowchart-<nodeId>-<counter>". We map those back to the
     node ids used in the source.
     ---------------------------------------------------------------------- */
  function extractNodeId(el) {
    // Prefer an explicit data-id if the renderer ever provides one.
    const dataId = el.getAttribute('data-id');
    if (dataId) return dataId;

    const raw = el.id || '';
    if (!raw) return null;
    // Mermaid prefixes the render id, e.g. "mmd-3-1700000000000-flowchart-A-0".
    // Strip everything up to and including the last "flowchart-" segment, then
    // drop the trailing "-<counter>".
    const m = /flowchart-(.+?)-\d+$/.exec(raw);
    if (m) return m[1];
    // Fallback for shapes whose id does not follow the pattern.
    return raw.replace(/^.*?flowchart-/, '').replace(/-\d+$/, '') || null;
  }

  function collectNodes(svg) {
    const nodes = [];
    const seen = new Map();
    svg.querySelectorAll('g.node').forEach((el) => {
      const id = extractNodeId(el);
      if (!id) return;
      // Mermaid can emit several groups per node (label + shape) — dedupe by id.
      if (seen.has(id)) {
        const existing = seen.get(id);
        // Merge: keep the element that actually holds the drawn shape.
        if (!existing.querySelector('rect, polygon, circle, ellipse, path')) {
          seen.set(id, el);
        }
        return;
      }
      seen.set(id, el);
      nodes.push({ id, el });
    });
    return nodes;
  }

  /* ----------------------------------------------------------------------
     Rendering
     ---------------------------------------------------------------------- */
  let renderTimer = null;

  function scheduleRender(delay = 260) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderDiagram(), delay);
  }

  async function renderDiagram() {
    const token = ++state.renderToken;
    const rawSource = getSource();
    const { body, positions } = splitLayoutBlock(rawSource);
    state.positions = positions;

    if (!body.trim()) {
      diagramContainer.innerHTML = '';
      previewPlaceholder.hidden = false;
      setError(null);
      setParseStatus('Ready', 'badge-outline');
      updateStats(body, positions);
      return;
    }

    renderStatus.textContent = 'Rendering…';

    try {
      const { svg } = await mermaid.render(`mmd-${token}-${Date.now()}`, body);
      if (token !== state.renderToken) return; // a newer render superseded this one

      diagramContainer.innerHTML = svg;
      previewPlaceholder.hidden = true;

      const svgEl = diagramContainer.querySelector('svg');
      if (svgEl) {
        // Strip Mermaid's hard-coded max-width so zoom/pan behaves predictably,
        // then restore an explicit pixel size from the viewBox. Without a size
        // the SVG collapses to 0x0 and never receives pointer events.
        svgEl.removeAttribute('width');
        svgEl.removeAttribute('height');
        svgEl.style.maxWidth = 'none';
        sizeSvgToViewBox(svgEl);
        applyPositionsToSvg(svgEl, positions);
        enableDragging(svgEl);
      }

      setError(null);
      setParseStatus('Valid', 'badge-success');
      updateStats(body, positions);
      renderStatus.textContent = 'Live';
    } catch (err) {
      if (token !== state.renderToken) return;
      const raw = (err && (err.str || err.message)) || String(err);
      const fix = suggestFix(raw, body);
      setError(formatParseError(raw, body), fix);
      setParseStatus('Error', 'badge-error');
      renderStatus.textContent = 'Failed';
      updateStats(body, positions);
    }
  }

  /**
   * Turn Mermaid's raw parser output into something a human can act on.
   *
   * Mermaid reports errors like:
   *   Parse error on line 1:
   *   flowchart TD q0["q0 (start)"] -->
   *   -------------^
   *   Expecting 'NEWLINE', got 'NODE_STRING'
   *
   * The line Mermaid echoes back is truncated, and the caret position is
   * relative to that truncated string, so the pointer is often confusing.
   * We re-point it at the real line in the editor and, where we recognise the
   * failure, add a plain-English explanation.
   */
  /**
   * Pull the "Expecting ..., got 'X'" detail out of Mermaid's error text.
   *
   * Mermaid sometimes lists a single expected token ("Expecting 'NEWLINE',
   * got 'NODE_STRING'") and sometimes many ("Expecting 'SQE',
   * 'DOUBLECIRCLEEND', ..., got 'SQS'"). We return every expected token plus
   * the one it actually found.
   */
  function parseExpectation(text) {
    const match = /Expecting (.*?), got '([^']*)'/s.exec(text);
    if (!match) return { expected: [], got: null };
    const expected = (match[1].match(/'([^']+)'/g) || []).map((t) => t.slice(1, -1));
    return { expected, got: match[2] };
  }

  function formatParseError(raw, source) {
    const lines = source.split('\n');
    const text = String(raw || '');

    const lineMatch = /Parse error on line (\d+)/.exec(text);
    const lineNo = lineMatch ? parseInt(lineMatch[1], 10) : null;

    const { expected, got } = parseExpectation(text);
    // The first expected token drives our specific hints; "NEWLINE" is the
    // one that means "you forgot to start a new statement".
    const expecting = expected.length ? expected[0] : null;

    // Mermaid echoes back a possibly truncated version of the offending line
    // (it may start with "..."), so the caret column it prints does not map
    // onto the real source line. We therefore ignore its column and point at
    // the first non-space character of the real line instead.
    const parts = [];

    // 1. A plain-English explanation for the mistakes people actually hit.
    const hint = explainParseError(expecting, got, lines, lineNo);
    if (hint) parts.push(hint);

    // 2. The offending line from the real source, with a caret.
    //    Mermaid sometimes reports a line beyond the end of the source (it
    //    counts the trailing newline), so clamp to the last real line.
    if (lineNo) {
      const idx = Math.min(lineNo, lines.length) - 1;
      if (idx >= 0 && lines[idx] !== undefined) {
        const sourceLine = lines[idx];
        parts.push(`Line ${Math.min(lineNo, lines.length)}:`);
        parts.push(sourceLine);
        parts.push(' '.repeat(Math.max(0, caretColumn(sourceLine, expecting))) + '^');
      }
    }

    // 3. Mermaid's technical detail, kept but clearly secondary.
    if (expected.length) {
      const expectedText = expected.length > 3
        ? `${expected.slice(0, 3).join(', ')} and ${expected.length - 3} more`
        : expected.join(', ');
      parts.push(`Mermaid expected ${expectedText} but found ${got}.`);
    }

    return parts.join('\n');
  }

  /**
   * True when every bracket, brace, paren and quote on the line is closed and
   * properly nested.
   *
   * Counting is not enough: "A[Start --> B[End]" contains one "[" and one "]",
   * yet the "[" is never closed — the "]" belongs to a different node. So we
   * track the nesting order with a stack.
   */
  function bracketsBalanced(line) {
    const pairs = { ')': '(', ']': '[', '}': '{' };
    const stack = [];
    let inQuote = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // A doubled quote ("") is an escaped quote, not a toggle.
        if (inQuote && line[i + 1] === '"') { i++; continue; }
        inQuote = !inQuote;
        continue;
      }
      if (inQuote) continue;
      if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (stack.pop() !== pairs[ch]) return false;
      }
    }

    return !inQuote && stack.length === 0;
  }

  /**
   * True when every double quote on the line is closed.
   *
   * A doubled quote ("") is an escaped quote, not a toggle, so it is skipped
   * rather than counted as a pair.
   */
  function hasBalancedQuotes(line) {
    let inQuote = false;

    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '"') continue;
      if (inQuote && line[i + 1] === '"') { i++; continue; }
      inQuote = !inQuote;
    }

    return !inQuote;
  }

  /**
   * Try to repair the source automatically.
   *
   * The most common Mermaid mistake is gluing a statement onto the diagram
   * header line ("flowchart TD A[Start] --> B"). That has an unambiguous
   * repair: put a line break after the header. We return the corrected source
   * plus a short description of what changed, or null when we cannot fix it.
   */
  function suggestFix(raw, source) {
    const lines = source.split('\n');
    const text = String(raw || '');

    const lineMatch = /Parse error on line (\d+)/.exec(text);
    if (!lineMatch) return null;
    const lineNo = parseInt(lineMatch[1], 10);

    const { expected } = parseExpectation(text);
    // Only the "missing line break" failure has an unambiguous repair.
    if (!expected.length || expected[0] !== 'NEWLINE') return null;

    const idx = Math.min(lineNo, lines.length) - 1;
    if (idx < 0) return null;

    const line = lines[idx];
    const header = /^\s*((?:flowchart|graph)\s+[A-Za-z]{2})\b/.exec(line);
    if (!header) return null;

    const afterHeader = line.slice(header[0].length);
    if (!afterHeader.trim()) return null; // nothing glued on — not this bug

    // An unbalanced bracket or quote is the real fault, not the missing
    // newline — Mermaid reports both as "Expecting 'NEWLINE'". Only offer the
    // repair when the line's brackets and quotes balance out. A plain count
    // is not enough: "A[Start --> B[End]" has one "[" and one "]" but the
    // first bracket is never closed, so we track the nesting order.
    if (!bracketsBalanced(line)) return null;

    // Indent the statement to match the other statements in the diagram.
    // The header line itself may be unindented while its siblings are not,
    // so prefer the indentation used by the following lines.
    let indent = ' '.repeat(Math.max(0, line.search(/\S/)));
    for (let i = idx + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      indent = ' '.repeat(Math.max(0, lines[i].search(/\S/)));
      break;
    }
    const fixedLine = header[1] + '\n' + indent + afterHeader.replace(/^\s+/, '');

    const fixed = lines.slice();
    fixed[idx] = fixedLine;

    return {
      source: fixed.join('\n'),
      description: `Moved "${afterHeader.trim().split(/\s+/)[0]}" to its own line after "${header[1].trim()}".`,
    };
  }

  /**
   * Work out which column of the offending line the caret should sit under.
   *
   * Mermaid's own caret column refers to a truncated echo of the line, so it
   * cannot be used directly. Instead we look for the token the parser choked
   * on: for the common "header and statement on one line" mistake that is
   * the first token after the diagram header.
   */
  function caretColumn(sourceLine, expecting) {
    const firstNonSpace = sourceLine.search(/\S/);
    if (firstNonSpace < 0) return 0;

    if (expecting === 'NEWLINE') {
      const header = /^\s*(?:flowchart|graph)\s+[A-Za-z]{2}\b/.exec(sourceLine);
      if (header) {
        const afterHeader = sourceLine.slice(header[0].length);
        const offset = afterHeader.search(/\S/);
        if (offset >= 0) return header[0].length + offset;
      }
    }

    return firstNonSpace;
  }

  /**
   * Recognise common Mermaid mistakes and explain them in plain English.
   * Returns null when nothing specific is recognised.
   */
  function explainParseError(expecting, got, lines, lineNo) {
    // A diagram header with content on the same line:
    //   "flowchart TD q0[...]"  ->  Mermaid wants a newline after the header.
    if (expecting === 'NEWLINE' && lineNo) {
      const headerLine = lines[lineNo - 1] || '';
      const header = /^\s*(?:flowchart|graph)\s+[A-Za-z]{2}\b/.exec(headerLine);
      if (header) {
        const headerText = header[0].trim();
        const rest = headerLine.slice(header[0].length).trim();
        if (rest) {
          const firstToken = rest.split(/\s+/)[0];
          return `Each statement needs its own line. "${headerText}" must be followed by a line break before "${firstToken}".`;
        }
      }
      return 'Each Mermaid statement must be on its own line.';
    }

    // Unclosed bracket / quote on the line. Mermaid sometimes points past the
    // end of the source, so scan the reported line and the one before it.
    if (lineNo) {
      const idx = Math.min(lineNo, lines.length) - 1;
      const candidates = [lines[idx], lines[idx - 1]].filter(Boolean);
      for (const line of candidates) {
        if (bracketsBalanced(line)) continue;
        // Distinguish a stray quote from an unclosed bracket.
        const hasOddQuotes = !hasBalancedQuotes(line);
        if (hasOddQuotes) {
          return 'A double quote is not closed on this line.';
        }
        return 'A bracket is not closed on this line.';
      }
    }

    if (expecting === 'NEWLINE') {
      return 'Each Mermaid statement must be on its own line.';
    }
    return null;
  }

  function setError(text, fix) {
    if (!text) {
      errorBox.hidden = true;
      errorMessage.textContent = '';
      state.pendingFix = null;
      fixErrorBtn.hidden = true;
      return;
    }
    errorBox.hidden = false;
    errorTitle.textContent = 'Syntax error';
    errorMessage.textContent = text;

    // Offer a one-click repair when we recognise the mistake.
    state.pendingFix = fix || null;
    fixErrorBtn.hidden = !fix;
    if (fix) {
      fixErrorBtn.title = fix.description;
    }
  }

  function setParseStatus(label, cls) {
    parseStatusBadge.textContent = label;
    parseStatusBadge.className = 'badge ' + cls;
  }

  function updateStats(body, positions) {
    const ids = collectNodeIdsFromSource(body);
    nodeCount.textContent = `${ids.size} node${ids.size === 1 ? '' : 's'}`;
    charCount.textContent = `${getSource().length} characters`;

    const manual = Object.keys(positions).filter((id) => {
      const p = positions[id];
      return Array.isArray(p) && (Math.abs(p[0]) > 0.5 || Math.abs(p[1]) > 0.5);
    });
    positionState.textContent = manual.length
      ? `${manual.length} positioned node${manual.length === 1 ? '' : 's'}`
      : 'No manual positions';
  }

  /**
   * Collect the distinct node ids declared in the source. This mirrors the
   * shape syntax Mermaid accepts: a bare id, or an id followed by one of the
   * bracket/paren shapes.
   */
  function collectNodeIdsFromSource(body) {
    const ids = new Set();
    // id optionally followed by a shape opener.
    const pattern = /(?:^|\n|-->|---|-\.->|==>|\|[^|]*\|)\s*([A-Za-z_][\w]*)\s*(?=\[\(|\[|\(|\{|\[\/|\[\*|>|\[\[|\(\[)/g;
    let m;
    while ((m = pattern.exec(body)) !== null) {
      ids.add(m[1]);
    }
    // Bare ids declared on their own line (e.g. "A" alone) still count.
    const bare = /(?:^|\n)\s*([A-Za-z_][\w]*)\s*$/gm;
    while ((m = bare.exec(body)) !== null) {
      if (!/^(?:flowchart|graph|subgraph|end|direction|classDef|class|style|click|linkStyle)$/i.test(m[1])) {
        ids.add(m[1]);
      }
    }
    return ids;
  }

  /**
   * Give the SVG an explicit pixel size matching its viewBox.
   * Mermaid emits a viewBox but no width/height; with the attributes stripped
   * the element would collapse to 0x0 and stop receiving pointer events.
   */
  function sizeSvgToViewBox(svg) {
    const viewBox = svg.viewBox && svg.viewBox.baseVal;
    const width = viewBox && viewBox.width ? viewBox.width : 0;
    const height = viewBox && viewBox.height ? viewBox.height : 0;
    if (!width || !height) return;
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    // The viewBox origin may be non-zero (Mermaid pads by ~0.5); keep the
    // content from being clipped.
    svg.style.overflow = 'visible';
  }

  /* ----------------------------------------------------------------------
     Applying stored positions to a freshly rendered SVG
     ---------------------------------------------------------------------- */
  function applyPositionsToSvg(svg, positions) {
    if (!positions || !Object.keys(positions).length) return;
    collectNodes(svg).forEach(({ id, el }) => {
      const offset = positions[id];
      if (!Array.isArray(offset)) return;
      const [dx, dy] = offset;
      if (!dx && !dy) return;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.style.transformBox = 'fill-box';
      el.style.transformOrigin = 'center';
      el.dataset.dragged = 'true';
    });
  }

  /* ----------------------------------------------------------------------
     Dragging
     ---------------------------------------------------------------------- */
  function svgPointToLocal(svg, clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox && svg.viewBox.baseVal;
    const vbWidth = viewBox && viewBox.width ? viewBox.width : rect.width;
    const vbHeight = viewBox && viewBox.height ? viewBox.height : rect.height;
    const scaleX = rect.width ? vbWidth / rect.width : 1;
    const scaleY = rect.height ? vbHeight / rect.height : 1;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function enableDragging(svg) {
    const nodes = collectNodes(svg);

    nodes.forEach(({ id, el }) => {
      // Mermaid sometimes renders a node as several sibling groups; make the
      // one holding the drawn shape the drag handle and neutralise the rest.
      const isShapeHolder = !!el.querySelector('rect, polygon, circle, ellipse, path');
      el.classList.add('node');
      if (!isShapeHolder) {
        el.style.pointerEvents = 'none';
        return;
      }
      el.style.cursor = 'grab';

      let dragging = false;
      let startPointer = null;
      let startOffset = null;
      let moved = false;

      el.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        moved = false;
        el.classList.add('dragging');
        el.setPointerCapture(ev.pointerId);

        const point = svgPointToLocal(svg, ev.clientX, ev.clientY);
        startPointer = point;
        const existing = state.positions[id];
        startOffset = Array.isArray(existing) ? existing.slice() : [0, 0];
      });

      el.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const point = svgPointToLocal(svg, ev.clientX, ev.clientY);
        const dx = startOffset[0] + (point.x - startPointer.x);
        const dy = startOffset[1] + (point.y - startPointer.y);
        if (Math.abs(point.x - startPointer.x) > 1 || Math.abs(point.y - startPointer.y) > 1) {
          moved = true;
        }
        state.positions[id] = [dx, dy];
        el.style.transform = `translate(${dx}px, ${dy}px)`;
      });

      const finish = (ev) => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('dragging');
        try { el.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }

        if (moved) {
          commitPositionsToSource();
        } else {
          // A click without movement: nothing to persist.
          updateStats(splitLayoutBlock(getSource()).body, state.positions);
        }
      };

      el.addEventListener('pointerup', finish);
      el.addEventListener('pointercancel', finish);
    });
  }

  /**
   * Write the current positions back into the source as the %% layout block,
   * then refresh the stats. The diagram is NOT re-rendered here — the SVG
   * already shows the new positions and a re-render would fight the drag.
   */
  function commitPositionsToSource() {
    const updated = withLayoutBlock(getSource(), state.positions);
    setSource(updated);
    // updateStats also refreshes the "positioned nodes" counter.
    updateStats(splitLayoutBlock(updated).body, state.positions);
  }

  /* ----------------------------------------------------------------------
     Zoom & pan
     ---------------------------------------------------------------------- */
  function setZoom(next, { announce = true } = {}) {
    state.zoom = Math.min(3, Math.max(0.25, next));
    diagramCanvas.style.transform = `scale(${state.zoom})`;
    if (announce) {
      zoomLevelLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    }
  }

  function fitDiagram() {
    const svg = diagramContainer.querySelector('svg');
    if (!svg) return;
    const viewBox = svg.viewBox && svg.viewBox.baseVal;
    const vbWidth = viewBox && viewBox.width ? viewBox.width : 0;
    const vbHeight = viewBox && viewBox.height ? viewBox.height : 0;
    if (!vbWidth || !vbHeight) return;

    const available = diagramViewport.getBoundingClientRect();
    const padding = 64; // 2rem of canvas padding on each side
    const scale = Math.min(
      (available.width - padding) / vbWidth,
      (available.height - padding) / vbHeight
    );
    if (!isFinite(scale) || scale <= 0) return;
    setZoom(Math.min(2, Math.max(0.25, scale)));
  }

  /* ----------------------------------------------------------------------
     Export
     ---------------------------------------------------------------------- */
  function inlineSvgForExport() {
    const svg = diagramContainer.querySelector('svg');
    if (!svg) return null;

    // Parse a fresh copy rather than cloneNode()ing it: a detached SVG has no
    // layout box, so getBBox() would return zeros and the labels would all
    // pile up in the corner.
    const clone = new DOMParser()
      .parseFromString(svg.outerHTML, 'image/svg+xml')
      .documentElement;

    // Carry the manual offsets into the copy so the exported file matches what
    // the user sees on screen. Nodes are matched by their extracted id rather
    // than by index, because the two trees can order them differently.
    const liveNodes = new Map();
    collectNodes(svg).forEach(({ id, el }) => liveNodes.set(id, el));
    collectNodes(clone).forEach(({ id, el }) => {
      const live = liveNodes.get(id);
      if (!live) return;
      const transform = live.style.transform;
      if (transform) {
        el.style.transform = transform;
        el.style.transformBox = 'fill-box';
        el.style.transformOrigin = 'center';
      }
    });

    // Mermaid renders inside a wrapper div with a background colour; make the
    // exported SVG standalone and sized to its content.
    const viewBox = clone.getAttribute('viewBox');
    const vbParts = (viewBox || '').split(/[\s,]+/).map(Number);
    const width = vbParts.length === 4 && vbParts[2] ? vbParts[2] : 1200;
    const height = vbParts.length === 4 && vbParts[3] ? vbParts[3] : 800;

    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.removeAttribute('style');

    // Swap HTML labels for SVG text so the canvas is not tainted and PNG/JPG
    // export works.
    convertForeignObjectsToText(svg, clone);

    return { clone, width, height };
  }

  /**
   * Replace every <foreignObject> label with a native SVG <text> element.
   *
   * Chromium taints a canvas when it draws an SVG that contains a
   * foreignObject, which makes `canvas.toBlob()` throw ("Tainted canvases may
   * not be exported") and breaks PNG/JPG export entirely. Mermaid renders
   * every node and edge label as a foreignObject, so we swap them for plain
   * SVG text — the result is vector-crisp and exportable.
   *
   * The foreignObject itself carries no x/y; its position comes from the
   * parent <g>'s transform, so we read the position from the live DOM before
   * the clone is detached.
   */
  function convertForeignObjectsToText(sourceSvg, cloneSvg) {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    // Geometry must come from the LIVE svg: a detached copy has no layout, so
    // its getBBox() returns zeros. The two trees hold the same foreignObjects
    // in the same order, so we zip the two lists.
    const liveBoxes = [...sourceSvg.querySelectorAll('foreignObject')].map((fo) => {
      const parent = fo.parentElement;
      let box = null;
      try {
        if (parent && parent.getBBox) box = parent.getBBox();
      } catch (_) { box = null; }
      if (!box || (!box.width && !box.height)) {
        // Fall back to the screen rect mapped back into viewBox space.
        const r = fo.getBoundingClientRect();
        const svgRect = sourceSvg.getBoundingClientRect();
        const vb = (sourceSvg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
        const scaleX = vb.length === 4 && svgRect.width ? vb[2] / svgRect.width : 1;
        const scaleY = vb.length === 4 && svgRect.height ? vb[3] / svgRect.height : 1;
        box = {
          x: (r.left - svgRect.left) * scaleX,
          y: (r.top - svgRect.top) * scaleY,
          width: r.width * scaleX,
          height: r.height * scaleY,
        };
      }
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        fill: parent && parent.getAttribute ? parent.getAttribute('fill') : null,
      };
    });

    const foList = [...cloneSvg.querySelectorAll('foreignObject')];
    foList.forEach((fo, i) => {
      const text = (fo.textContent || '').trim();
      if (!text) {
        fo.parentNode.removeChild(fo);
        return;
      }

      const box = liveBoxes[i] || { x: 0, y: 0, width: 0, height: 0 };
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;

      const doc = cloneSvg.ownerDocument || document;
      const textEl = doc.createElementNS(SVG_NS, 'text');
      textEl.setAttribute('x', String(x));
      textEl.setAttribute('y', String(y + 4));
      textEl.setAttribute('text-anchor', 'middle');
      textEl.setAttribute('font-family', '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif');
      textEl.setAttribute('font-size', '12');
      textEl.setAttribute('fill', 'currentColor');
      textEl.textContent = text;

      // Inherit the fill of the group the label lived in, when it has one.
      const parentFill = box.fill;
      if (parentFill && parentFill !== 'none') textEl.setAttribute('fill', parentFill);

      fo.parentNode.replaceChild(textEl, fo);
    });

    // Any leftover inline styles referencing foreignObject layout can go.
    cloneSvg.querySelectorAll('style').forEach((s) => {
      if (s.textContent.includes('foreignObject')) s.textContent = '';
    });
  }

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

  function timestampName(ext) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `mermaid-diagram-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
  }

  function exportSvg() {
    const data = inlineSvgForExport();
    if (!data) {
      showToast('Nothing to export yet');
      return;
    }
    const source = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(data.clone);
    downloadBlob(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }), timestampName('svg'));
    showToast('SVG downloaded');
  }

  function exportRaster(format) {
    const data = inlineSvgForExport();
    if (!data) {
      showToast('Nothing to export yet');
      return;
    }

    const scale = parseFloat(exportScale.value) || 2;
    const transparent = exportTransparent.checked;
    const width = Math.max(1, Math.round(data.width));
    const height = Math.max(1, Math.round(data.height));
    const pixelWidth = Math.round(width * scale);
    const pixelHeight = Math.round(height * scale);

    // Render the SVG at the target pixel size first, then rasterise.
    const svgMarkup = new XMLSerializer().serializeToString(data.clone);
    const svgUrl = URL.createObjectURL(new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' }));

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const ctx = canvas.getContext('2d');

      if (!transparent) {
        ctx.fillStyle = document.documentElement.classList.contains('dark') ? '#131316' : '#ffffff';
        ctx.fillRect(0, 0, pixelWidth, pixelHeight);
      }

      ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight);
      URL.revokeObjectURL(svgUrl);

      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
      const quality = format === 'jpg' ? 0.92 : undefined;
      canvas.toBlob((blob) => {
        if (!blob) {
          showToast('Export failed');
          return;
        }
        downloadBlob(blob, timestampName(format));
        showToast(`${format.toUpperCase()} downloaded (${pixelWidth}×${pixelHeight})`);
      }, mime, quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(svgUrl);
      showToast('Export failed');
    };
    img.src = svgUrl;
  }

  function exportMermaidFile() {
    const source = getSource();
    if (!source.trim()) {
      showToast('Nothing to export yet');
      return;
    }
    downloadBlob(new Blob([source], { type: 'text/plain;charset=utf-8' }), timestampName('mmd'));
    showToast('Mermaid file downloaded');
  }

  /* ----------------------------------------------------------------------
     Toast
     ---------------------------------------------------------------------- */
  let toastTimer = null;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  /* ----------------------------------------------------------------------
     Event wiring
     ---------------------------------------------------------------------- */
  /** Re-sync the derived UI state after the source changes. */
  function syncSourceState() {
    // Keep the direction dropdown in sync with the source.
    const dir = currentFlowDirection(getSource());
    if (dir && directionSelect.value !== dir) directionSelect.value = dir;
    const { body, positions } = splitLayoutBlock(getSource());
    state.positions = positions;
    updateStats(body, positions);
  }

  mermaidInput.addEventListener('input', () => {
    scheduleRender();
    syncSourceState();
  });

  // One-click repair for the mistakes we know how to undo.
  fixErrorBtn.addEventListener('click', () => {
    const fix = state.pendingFix;
    if (!fix) return;
    setSource(fix.source);
    state.pendingFix = null;
    syncSourceState();
    renderDiagram();
    showToast(fix.description);
  });

  document.getElementById('sample-btn').addEventListener('click', () => {
    setSource(SAMPLE);
    state.positions = {};
    directionSelect.value = 'TD';
    renderDiagram();
  });

  document.getElementById('clear-btn').addEventListener('click', () => {
    setSource('');
    state.positions = {};
    diagramContainer.innerHTML = '';
    previewPlaceholder.hidden = false;
    setError(null);
    setParseStatus('Ready', 'badge-outline');
    updateStats('', {});
  });

  document.getElementById('copy-btn').addEventListener('click', async () => {
    const source = getSource();
    if (!source.trim()) {
      showToast('Nothing to copy');
      return;
    }
    try {
      await navigator.clipboard.writeText(source);
      showToast('Mermaid code copied');
    } catch (_) {
      // Clipboard API needs a secure context — fall back to a selection copy.
      mermaidInput.focus();
      mermaidInput.select();
      try {
        document.execCommand('copy');
        showToast('Mermaid code copied');
      } catch (__) {
        showToast('Copy failed — select the code manually');
      }
    }
  });

  directionSelect.addEventListener('change', () => {
    const updated = setFlowDirection(getSource(), directionSelect.value);
    setSource(updated);
    renderDiagram();
  });

  document.getElementById('layout-btn').addEventListener('click', () => {
    // Drop the manual offsets and let Mermaid lay the diagram out again.
    const { body } = splitLayoutBlock(getSource());
    setSource(body.replace(/\s+$/, '') + '\n');
    state.positions = {};
    renderDiagram();
    showToast('Layout reset');
  });

  themeSelect.addEventListener('change', () => {
    mermaid.initialize(mermaidConfig());
    renderDiagram();
  });

  document.getElementById('zoom-in-btn').addEventListener('click', () => setZoom(state.zoom * 1.2));
  document.getElementById('zoom-out-btn').addEventListener('click', () => setZoom(state.zoom / 1.2));
  document.getElementById('fit-btn').addEventListener('click', fitDiagram);

  // Export menu
  exportBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const isOpen = !exportMenu.hidden;
    exportMenu.hidden = isOpen;
    exportBtn.setAttribute('aria-expanded', String(!isOpen));
  });

  exportMenu.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-export]');
    if (!item) return;
    const kind = item.dataset.export;
    if (kind === 'png') exportRaster('png');
    else if (kind === 'jpg') exportRaster('jpg');
    else if (kind === 'svg') exportSvg();
    else if (kind === 'mermaid') exportMermaidFile();
    exportMenu.hidden = true;
    exportBtn.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('click', () => {
    if (!exportMenu.hidden) {
      exportMenu.hidden = true;
      exportBtn.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !exportMenu.hidden) {
      exportMenu.hidden = true;
      exportBtn.setAttribute('aria-expanded', 'false');
    }
  });

  /* ----------------------------------------------------------------------
     Boot
     ---------------------------------------------------------------------- */
  mermaid.initialize(mermaidConfig());
  setSource(SAMPLE);
  directionSelect.value = 'TD';
  setZoom(1, { announce: false });
  renderDiagram().then(() => {
    // Fit once the first diagram has its dimensions.
    requestAnimationFrame(fitDiagram);
  });

  window.addEventListener('resize', () => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      const svg = diagramContainer.querySelector('svg');
      if (svg) fitDiagram();
    }, 200);
  });
})();
