/**
 * Bulk Email Domain Filter
 * shadcn/ui Inspired Black & White Theme Scheme
 */

(function () {
  'use strict';

  // --- State ---
  const state = {
    rawInput: '',
    parsedEntries: [],           // Array of { email, domain, rawLine, index }
    headerLine: null,            // If input has a CSV header row
    domains: new Map(),          // domain -> count
    selectedDomains: new Set(),
    hasInteractedWithDomains: false, // Tracks if user manually changed domain selection
    knownDomains: new Set(),     // Tracks previously seen domains
    domainSearchQuery: '',
    outputMode: 'emails',        // 'emails' | 'rows'
    delimiter: '\n',             // '\n' | ',' | ';'
    deduplicate: true,
    lowercase: true,
    sortMode: 'none',            // 'none' | 'asc' | 'domain'
  };

  // Robust email matching regex
  const EMAIL_REGEX = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;

  // --- DOM Elements ---
  const el = {
    // Theme
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    themeIconLight: document.getElementById('theme-icon-light'),
    themeIconDark: document.getElementById('theme-icon-dark'),

    // Input panel
    inputTextarea: document.getElementById('input-csv'),
    inputDropzone: document.getElementById('dropzone-overlay'),
    fileInput: document.getElementById('file-input'),
    uploadBtn: document.getElementById('upload-btn'),
    sampleBtn: document.getElementById('sample-btn'),
    clearBtn: document.getElementById('clear-btn'),
    inputLinesCount: document.getElementById('input-lines-count'),
    inputEmailsCount: document.getElementById('input-emails-count'),

    // Domain filters
    domainChipsContainer: document.getElementById('domain-chips-container'),
    domainSearchInput: document.getElementById('domain-search-input'),
    selectAllDomainsBtn: document.getElementById('select-all-domains-btn'),
    deselectAllDomainsBtn: document.getElementById('deselect-all-domains-btn'),
    invertDomainsBtn: document.getElementById('invert-domains-btn'),
    domainStatsBadge: document.getElementById('domain-stats-badge'),

    // Output panel
    outputTextarea: document.getElementById('output-csv'),
    copyBtn: document.getElementById('copy-btn'),
    downloadBtn: document.getElementById('download-btn'),
    outputCountBadge: document.getElementById('output-count-badge'),
    outputEmailsCount: document.getElementById('output-emails-count'),
    outputSelectedDomainsCount: document.getElementById('output-selected-domains-count'),

    // Options
    outputModeSelect: document.getElementById('output-mode-select'),
    delimiterSelect: document.getElementById('delimiter-select'),
    dedupCheckbox: document.getElementById('dedup-checkbox'),
    lowercaseCheckbox: document.getElementById('lowercase-checkbox'),
    sortSelect: document.getElementById('sort-select'),

    // Toast
    toast: document.getElementById('toast-notification'),
    toastMsg: document.getElementById('toast-message'),
  };

  // --- Sample Data ---
  const SAMPLE_CSV = `id,name,email,department
1,Sheikh Shakib,sakib@bscse.uiu.ac.bd,CSE
2,Prof. Tariqul Islam,tariqul@uiu.ac.bd,Faculty
3,John Doe,johndoe@gmail.com,Visitor
4,Ayman Sadiq,ayman@bscse.uiu.ac.bd,CSE
5,Dr. Sadia Rahman,sadia@uiu.ac.bd,Faculty
6,Dev Shakib,shakib.dev@gmail.com,Guest
7,Registrar Office,registrar@uiu.ac.bd,Staff
8,Fatima Zahra,fatima@bscse.uiu.ac.bd,CSE
9,Google Team,team@google.com,Partner
10,Michael Brown,michael.b@gmail.com,Guest
11,Exam Controller,exam@uiu.ac.bd,Staff
12,Alumni Association,alumni@bscse.uiu.ac.bd,Community
13,Microsoft Campus,campus@microsoft.com,Partner
14,Sarah Ahmed,sarah.a@gmail.com,Guest`;

  // --- Initialization ---
  function init() {
    initTheme();
    attachEventListeners();

    // Check if input already has content (e.g. reload)
    if (el.inputTextarea.value.trim().length > 0) {
      processInput();
    }
  }

  // --- Theme Management ---
  function initTheme() {
    const savedTheme = localStorage.getItem('theme-mode');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = savedTheme ? savedTheme === 'dark' : prefersDark;
    applyTheme(isDark);
  }

  function applyTheme(isDark) {
    if (isDark) {
      document.documentElement.classList.add('dark');
      if (el.themeIconLight) el.themeIconLight.style.display = 'none';
      if (el.themeIconDark) el.themeIconDark.style.display = 'block';
    } else {
      document.documentElement.classList.remove('dark');
      if (el.themeIconLight) el.themeIconLight.style.display = 'block';
      if (el.themeIconDark) el.themeIconDark.style.display = 'none';
    }
  }

  function toggleTheme() {
    const isCurrentlyDark = document.documentElement.classList.contains('dark');
    const nextDark = !isCurrentlyDark;
    applyTheme(nextDark);
    localStorage.setItem('theme-mode', nextDark ? 'dark' : 'light');
  }

  // --- Event Listeners ---
  function attachEventListeners() {
    // Theme toggle
    if (el.themeToggleBtn) {
      el.themeToggleBtn.addEventListener('click', toggleTheme);
    }

    // Input changes
    el.inputTextarea.addEventListener('input', () => {
      processInput();
    });

    // Sample button
    el.sampleBtn.addEventListener('click', () => {
      el.inputTextarea.value = SAMPLE_CSV;
      state.hasInteractedWithDomains = false;
      processInput();
      showToast('Loaded sample CSV data');
    });

    // Clear button
    el.clearBtn.addEventListener('click', () => {
      el.inputTextarea.value = '';
      state.hasInteractedWithDomains = false;
      state.knownDomains.clear();
      state.selectedDomains.clear();
      processInput();
      showToast('Cleared all data');
    });

    // File upload
    el.uploadBtn.addEventListener('click', () => {
      el.fileInput.click();
    });

    el.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      readFile(file);
      el.fileInput.value = '';
    });

    // Drag and drop
    setupDragAndDrop();

    // Domain actions
    el.selectAllDomainsBtn.addEventListener('click', selectAllDomains);
    el.deselectAllDomainsBtn.addEventListener('click', deselectAllDomains);
    el.invertDomainsBtn.addEventListener('click', invertDomainSelection);

    el.domainSearchInput.addEventListener('input', (e) => {
      state.domainSearchQuery = e.target.value.toLowerCase().trim();
      renderDomainChips();
    });

    // Options
    el.outputModeSelect.addEventListener('change', (e) => {
      state.outputMode = e.target.value;
      updateOutput();
    });

    el.delimiterSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val === 'newline') state.delimiter = '\n';
      else if (val === 'comma') state.delimiter = ', ';
      else if (val === 'semicolon') state.delimiter = '; ';
      updateOutput();
    });

    el.dedupCheckbox.addEventListener('change', (e) => {
      state.deduplicate = e.target.checked;
      updateOutput();
    });

    el.lowercaseCheckbox.addEventListener('change', (e) => {
      state.lowercase = e.target.checked;
      updateOutput();
    });

    el.sortSelect.addEventListener('change', (e) => {
      state.sortMode = e.target.value;
      updateOutput();
    });

    // Copy to clipboard
    el.copyBtn.addEventListener('click', copyOutputToClipboard);

    // Download CSV
    el.downloadBtn.addEventListener('click', downloadOutputCsv);
  }

  // --- Drag and Drop File Loading ---
  function setupDragAndDrop() {
    const target = el.inputTextarea;
    const overlay = el.inputDropzone;

    ['dragenter', 'dragover'].forEach(eventName => {
      target.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        overlay.classList.add('active');
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      overlay.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        overlay.classList.remove('active');
      }, false);
    });

    overlay.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const file = dt.files[0];
      if (file) {
        readFile(file);
      }
    });
  }

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      el.inputTextarea.value = e.target.result;
      state.hasInteractedWithDomains = false;
      processInput();
      showToast(`Loaded ${file.name}`);
    };
    reader.readAsText(file);
  }

  // --- Input Processing ---
  function processInput() {
    const text = el.inputTextarea.value;
    state.rawInput = text;

    const lines = text.split(/\r?\n/);
    const lineCount = text.trim().length === 0 ? 0 : lines.length;
    el.inputLinesCount.textContent = `${lineCount} line${lineCount === 1 ? '' : 's'}`;

    const newEntries = [];
    const domainCounts = new Map();
    let headerCandidate = null;

    if (lines.length > 0 && text.trim().length > 0) {
      // Check if first line might be a CSV header row without emails
      const firstLineMatches = lines[0].match(EMAIL_REGEX);
      if (!firstLineMatches && lines[0].includes(',')) {
        headerCandidate = lines[0];
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === 0 && headerCandidate) {
          continue; // Skip header line when extracting emails
        }

        const matches = line.match(EMAIL_REGEX);
        if (matches) {
          matches.forEach(email => {
            const domain = extractDomain(email);
            if (domain) {
              newEntries.push({
                email: email,
                domain: domain,
                rawLine: line,
                index: i
              });

              domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
            }
          });
        }
      }
    }

    state.headerLine = headerCandidate;
    state.parsedEntries = newEntries;
    state.domains = domainCounts;

    // Update Input Email Count Badge
    el.inputEmailsCount.textContent = `${newEntries.length} email${newEntries.length === 1 ? '' : 's'}`;

    // Manage Selected Domains
    const currentDomainKeys = Array.from(domainCounts.keys());
    if (!state.hasInteractedWithDomains) {
      // User hasn't made custom filter selections yet: select all discovered domains
      state.selectedDomains = new Set(currentDomainKeys);
    } else {
      // Preserve existing selections for known domains; auto-select newly appeared domains
      const nextSelected = new Set();
      currentDomainKeys.forEach(dom => {
        if (!state.knownDomains.has(dom) || state.selectedDomains.has(dom)) {
          nextSelected.add(dom);
        }
      });
      state.selectedDomains = nextSelected;
    }

    // Update known domains tracker
    state.knownDomains = new Set(currentDomainKeys);

    // Render chips and calculate output
    renderDomainChips();
    updateOutput();
  }

  function extractDomain(email) {
    if (!email || !email.includes('@')) return null;
    const parts = email.split('@');
    if (parts.length < 2) return null;
    return parts[1].toLowerCase().trim();
  }

  // --- Render Domain Filter Chips ---
  function renderDomainChips() {
    const container = el.domainChipsContainer;
    container.innerHTML = '';

    const allDomains = Array.from(state.domains.entries());

    if (allDomains.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-domains-msg';
      emptyMsg.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        <span>No email domains detected yet. Paste CSV data on the left to extract domains.</span>
      `;
      container.appendChild(emptyMsg);
      el.domainStatsBadge.textContent = '0 domains';
      return;
    }

    // Sort domains alphabetically
    allDomains.sort((a, b) => a[0].localeCompare(b[0]));

    // Search query filter
    const filteredDomains = allDomains.filter(([domain]) => {
      if (!state.domainSearchQuery) return true;
      return domain.includes(state.domainSearchQuery);
    });

    el.domainStatsBadge.textContent = `${state.selectedDomains.size} of ${allDomains.length} selected`;

    if (filteredDomains.length === 0) {
      const noMatchMsg = document.createElement('div');
      noMatchMsg.className = 'empty-domains-msg';
      noMatchMsg.textContent = `No domains match "${state.domainSearchQuery}"`;
      container.appendChild(noMatchMsg);
      return;
    }

    filteredDomains.forEach(([domain, count]) => {
      const isSelected = state.selectedDomains.has(domain);

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `domain-chip ${isSelected ? 'active' : ''}`;
      chip.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      chip.setAttribute('title', 'Click to toggle selection. Alt+Click to isolate this domain.');

      // Checkmark icon when active
      const checkIcon = isSelected
        ? `<svg class="icon chip-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>`
        : `<span class="chip-check"></span>`;

      chip.innerHTML = `
        ${checkIcon}
        <span class="chip-label">${escapeHtml(domain)}</span>
        <span class="chip-count">${count}</span>
      `;

      chip.addEventListener('click', (e) => {
        state.hasInteractedWithDomains = true;
        if (e.altKey || e.metaKey || e.ctrlKey) {
          // Alt/Cmd+Click: Isolate / Solo this domain
          state.selectedDomains.clear();
          state.selectedDomains.add(domain);
        } else {
          // Normal toggle
          if (state.selectedDomains.has(domain)) {
            state.selectedDomains.delete(domain);
          } else {
            state.selectedDomains.add(domain);
          }
        }
        renderDomainChips();
        updateOutput();
      });

      container.appendChild(chip);
    });
  }

  // --- Domain Selection Actions ---
  function selectAllDomains() {
    state.hasInteractedWithDomains = true;
    for (const domain of state.domains.keys()) {
      state.selectedDomains.add(domain);
    }
    renderDomainChips();
    updateOutput();
  }

  function deselectAllDomains() {
    state.hasInteractedWithDomains = true;
    state.selectedDomains.clear();
    renderDomainChips();
    updateOutput();
  }

  function invertDomainSelection() {
    state.hasInteractedWithDomains = true;
    for (const domain of state.domains.keys()) {
      if (state.selectedDomains.has(domain)) {
        state.selectedDomains.delete(domain);
      } else {
        state.selectedDomains.add(domain);
      }
    }
    renderDomainChips();
    updateOutput();
  }

  // --- Output Formatting ---
  function updateOutput() {
    const selectedDomains = state.selectedDomains;
    const isEmailMode = state.outputMode === 'emails';

    // Filter parsed entries
    let matchingEntries = state.parsedEntries.filter(entry =>
      selectedDomains.has(entry.domain)
    );

    let outputResult = '';
    let resultCount = 0;

    if (isEmailMode) {
      let emails = matchingEntries.map(e => e.email);

      // Lowercase normalization
      if (state.lowercase) {
        emails = emails.map(e => e.toLowerCase());
      }

      // Deduplication
      if (state.deduplicate) {
        emails = Array.from(new Set(emails));
      }

      // Sorting
      if (state.sortMode === 'asc') {
        emails.sort((a, b) => a.localeCompare(b));
      } else if (state.sortMode === 'domain') {
        emails.sort((a, b) => {
          const domA = extractDomain(a) || '';
          const domB = extractDomain(b) || '';
          const comp = domA.localeCompare(domB);
          return comp !== 0 ? comp : a.localeCompare(b);
        });
      }

      resultCount = emails.length;
      outputResult = emails.join(state.delimiter);
    } else {
      // 'rows' mode - preserve entire CSV lines
      const seenLines = new Set();
      const rows = [];

      if (state.headerLine) {
        rows.push(state.headerLine);
      }

      matchingEntries.forEach(entry => {
        if (!seenLines.has(entry.rawLine)) {
          seenLines.add(entry.rawLine);
          rows.push(entry.rawLine);
        }
      });

      resultCount = matchingEntries.length;
      outputResult = rows.join('\n');
    }

    el.outputTextarea.value = outputResult;

    // Badges & Counters
    el.outputCountBadge.textContent = `${resultCount} email${resultCount === 1 ? '' : 's'}`;
    el.outputEmailsCount.textContent = `${resultCount} email${resultCount === 1 ? '' : 's'} displayed`;
    el.outputSelectedDomainsCount.textContent = `${selectedDomains.size} domain${selectedDomains.size === 1 ? '' : 's'} active`;

    // Disable copy/download when output is empty
    const isEmpty = outputResult.trim().length === 0;
    el.copyBtn.disabled = isEmpty;
    el.downloadBtn.disabled = isEmpty;
  }

  // --- Copy to Clipboard ---
  function copyOutputToClipboard() {
    const text = el.outputTextarea.value;
    if (!text || text.trim().length === 0) {
      showToast('Nothing to copy');
      return;
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        setCopySuccess();
      }).catch(err => {
        fallbackCopyText(text);
      });
    } else {
      fallbackCopyText(text);
    }
  }

  function fallbackCopyText(text) {
    el.outputTextarea.select();
    try {
      const successful = document.execCommand('copy');
      if (successful) {
        setCopySuccess();
      } else {
        showToast('Unable to copy. Please select and copy manually.');
      }
    } catch (err) {
      showToast('Clipboard copy failed');
    }
  }

  function setCopySuccess() {
    const originalText = el.copyBtn.innerHTML;
    el.copyBtn.innerHTML = `
      <svg class="icon icon-md" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
      <span>Copied!</span>
    `;
    el.copyBtn.classList.add('btn-secondary');
    el.copyBtn.classList.remove('btn-primary');

    showToast(`Copied ${el.outputCountBadge.textContent} to clipboard`);

    setTimeout(() => {
      el.copyBtn.innerHTML = originalText;
      el.copyBtn.classList.remove('btn-secondary');
      el.copyBtn.classList.add('btn-primary');
    }, 2000);
  }

  // --- Download CSV File ---
  function downloadOutputCsv() {
    const text = el.outputTextarea.value;
    if (!text || text.trim().length === 0) return;

    const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().slice(0, 10);
    link.setAttribute('href', url);
    link.setAttribute('download', `filtered_emails_${timestamp}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast('Downloaded CSV file');
  }

  // --- Toast Notifications ---
  let toastTimeout = null;
  function showToast(message) {
    if (!el.toast || !el.toastMsg) return;
    el.toastMsg.textContent = message;
    el.toast.classList.add('show');

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      el.toast.classList.remove('show');
    }, 2800);
  }

  // Helper to escape HTML characters
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Bootstrap when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
