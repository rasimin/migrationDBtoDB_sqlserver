/* ============================================================================
   QUERY CONSOLE HELPER MODALS & PERSISTENCE MODULE - query-modals.js
   ============================================================================ */

// ── INSERT Statement Mapper Modal Logic ────────────────────────────────────
let mapperTableName = '[RDO_TTransaction]';
let mapperColumns = [];
let mapperOriginalValues = [];
let mapperCurrentValues = [];

function openInsertMapperModal() {
    const modal = document.getElementById('insert-mapper-modal');
    if (!modal) return;

    modal.classList.add('active');

    // Prefill with selection from active Monaco Editor if it contains an INSERT statement
    if (queryConsoleEditor) {
        const selectionVal = queryConsoleEditor.getModel().getValueInRange(queryConsoleEditor.getSelection()).trim();
        if (selectionVal && /INSERT\s+INTO/i.test(selectionVal)) {
            document.getElementById('mapper-sql-input').value = selectionVal;
        }
    }

    parseMapperSQL();
}

function closeInsertMapperModal() {
    const modal = document.getElementById('insert-mapper-modal');
    if (modal) {
        modal.classList.remove('active');
        const content = modal.querySelector('.modal-content');
        if (content) {
            content.classList.remove('maximized');
        }
        const icon = document.getElementById('insert-mapper-maximize-icon');
        if (icon) {
            icon.className = 'fa-solid fa-expand';
        }
    }
}

function toggleInsertMapperMaximize() {
    const modal = document.getElementById('insert-mapper-modal');
    if (!modal) return;
    const content = modal.querySelector('.modal-content');
    const icon = document.getElementById('insert-mapper-maximize-icon');
    
    if (content) {
        const isMaximized = content.classList.toggle('maximized');
        if (icon) {
            icon.className = isMaximized ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
        }
    }
}

function splitMapperSqlList(str) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === "'") {
            if (inQ && str[i+1] === "'") {
                cur += "''";
                i++;
                continue;
            }
            inQ = !inQ;
            cur += ch;
        } else if (ch === ',' && !inQ) {
            out.push(cur.trim());
            cur = '';
        } else {
            cur += ch;
        }
    }
    if (cur.trim().length || out.length) out.push(cur.trim());
    return out;
}

function parseMapperSQL() {
    const sqlInputVal = document.getElementById('mapper-sql-input').value;
    if (!sqlInputVal.trim()) return;

    const m = sqlInputVal.match(/INSERT\s+INTO\s+(\[[^\]]+\]|[\w\.]+)\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*;?/i);
    if (!m) {
        uiAlert('Format INSERT tidak dikenali. Pastikan struktur kueri memiliki pola: INSERT INTO NamaTabel (Kolom) VALUES (Nilai);');
        return;
    }

    mapperTableName = m[1].trim();
    const colsStr = m[2];
    const valsStr = m[3];
    const cols = splitMapperSqlList(colsStr).map(s => s.replace(/^\[|\]$/g, '').trim());
    const vals = splitMapperSqlList(valsStr);

    mapperColumns = cols;
    mapperOriginalValues = vals.slice(0, cols.length);
    mapperCurrentValues = vals.slice(0, cols.length);

    renderMapperTable();
    generateMapperSQL();
    applyMapperFilter();
}

function getTypeInfoMapper(v) {
    const s = String(v).trim();
    if (/^null$/i.test(s)) return { label: 'NULL', cls: 'null' };
    if (/^@[\w\.]+$/.test(s)) return { label: 'Variable', cls: 'variable' };
    if (/^'.*'$/s.test(s)) {
        const inner = s.slice(1, -1);
        if (/^\d{4}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/.test(inner)) return { label: 'Date', cls: 'date' };
        return { label: 'String', cls: 'string' };
    }
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return { label: 'Number', cls: 'number' };
    if (s === '') return { label: 'String', cls: 'string' };
    return { label: 'String', cls: 'string' };
}

function renderMapperTable() {
    const tbody = document.getElementById('mapper-tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    
    // Add input listener if not already there, using delegation
    if (!tbody.dataset.listenerAttached) {
        tbody.addEventListener('input', (e) => {
            if (e.target.tagName !== 'INPUT') return;
            const tr = e.target.closest('tr');
            const idx = parseInt(tr.dataset.index);
            const val = e.target.value;
            
            mapperCurrentValues[idx] = val;
            const t = getTypeInfoMapper(val);
            const badge = tr.querySelector('.mapper-badge');
            if (badge) {
                badge.className = 'mapper-badge ' + t.cls;
                badge.textContent = t.label;
            }
            const changed = val !== mapperOriginalValues[idx];
            tr.classList.toggle('changed', changed);
            
            generateMapperSQL();
        });
        tbody.dataset.listenerAttached = 'true';
    }

    mapperColumns.forEach((col, i) => {
        const val = mapperCurrentValues[i] ?? '';
        const t = getTypeInfoMapper(val);
        const changed = val !== mapperOriginalValues[i];
        const tr = document.createElement('tr');
        tr.dataset.index = i;
        if (changed) tr.classList.add('changed');
        tr.innerHTML = `
            <td class="num">${i + 1}</td>
            <td class="field"><code>[${escapeHtml(col)}]</code></td>
            <td class="value"><input type="text" spellcheck="false" value="${escapeHtml(val)}" /></td>
            <td><span class="mapper-badge ${t.cls}">${t.label}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

function formatMapperList(arr, per = 5) {
    const lines = [];
    for (let i = 0; i < arr.length; i += per) {
        lines.push('    ' + arr.slice(i, i + per).join(', '));
    }
    return lines.join(',\n');
}

function generateMapperSQL() {
    if (!mapperColumns.length) return;
    const cols = mapperColumns.map(c => `[${c}]`);
    const vals = mapperCurrentValues.map(v => v);
    const sql = `INSERT INTO ${mapperTableName} (\n${formatMapperList(cols)}\n)\nVALUES (\n${formatMapperList(vals)}\n);`;
    
    const outputArea = document.getElementById('mapper-sql-output');
    if (outputArea) {
        outputArea.value = sql;
    }
}

function applyMapperFilter() {
    const searchVal = document.getElementById('mapper-search');
    const onlyChangedVal = document.getElementById('mapper-only-changed');
    const tbody = document.getElementById('mapper-tbody');
    const counter = document.getElementById('mapper-counter');
    if (!tbody) return;

    const q = searchVal ? searchVal.value.toLowerCase().trim() : '';
    const only = onlyChangedVal ? onlyChangedVal.checked : false;
    let visible = 0;
    
    tbody.querySelectorAll('tr').forEach(tr => {
        const idx = parseInt(tr.dataset.index);
        const field = mapperColumns[idx].toLowerCase();
        const changed = mapperCurrentValues[idx] !== mapperOriginalValues[idx];
        const match = !q || field.includes(q);
        const show = match && (!only || changed);
        tr.style.display = show ? '' : 'none';
        if (show) visible++;
    });

    if (counter) {
        counter.textContent = `${visible} dari ${mapperColumns.length} field${visible !== mapperColumns.length ? ' (filter)' : ''}`;
    }
}

function resetMapperToOriginal() {
    mapperCurrentValues = mapperOriginalValues.slice();
    renderMapperTable();
    generateMapperSQL();
    applyMapperFilter();
}

async function copyMapperOutputToClipboard() {
    const outputArea = document.getElementById('mapper-sql-output');
    if (!outputArea || !outputArea.value.trim()) return;

    try {
        await navigator.clipboard.writeText(outputArea.value);
        uiAlert("SQL hasil berhasil disalin ke clipboard!");
    } catch (e) {
        uiAlert("Gagal menyalin output: " + e.message);
    }
}

function applyMapperToEditor() {
    const outputArea = document.getElementById('mapper-sql-output');
    if (!outputArea || !outputArea.value.trim()) return;

    const textToInsert = outputArea.value;

    const insertToActive = document.getElementById('mapper-insert-active-tab').checked;

    if (insertToActive && queryConsoleEditor) {
        queryConsoleEditor.focus();
        const selection = queryConsoleEditor.getSelection();
        const range = new monaco.Range(
            selection.startLineNumber,
            selection.startColumn,
            selection.endLineNumber,
            selection.endColumn
        );
        const op = {
            range: range,
            text: textToInsert,
            forceMoveMarkers: true
        };
        queryConsoleEditor.executeEdits("insert-mapper", [op]);
        closeInsertMapperModal();
    } else {
        // Fallback or explicit request to open in a new tab
        insertMapperToNewTab();
    }
}

function insertMapperToNewTab() {
    const outputArea = document.getElementById('mapper-sql-output');
    if (!outputArea || !outputArea.value.trim()) return;

    const textToInsert = outputArea.value;
    addNewQueryTab(textToInsert);
    closeInsertMapperModal();
}

// ── Generate INSERT Script Logic ───────────────────────────────────────────
async function openGenerateInsertModal() {
    if (!queryConsoleActiveServer) {
        await uiAlert("Hubungkan ke database server terlebih dahulu!");
        return;
    }
    
    // Reset selections
    const selectHidden = document.getElementById('insert-table-select');
    if (selectHidden) selectHidden.value = '';
    
    const triggerText = document.getElementById('query-table-trigger-text');
    if (triggerText) triggerText.textContent = '-- Pilih Tabel --';
    
    // Clear search
    const searchInput = document.getElementById('query-table-search');
    if (searchInput) searchInput.value = '';
    
    // Extract and sort table list
    queryConsoleActiveTables = (queryConsoleSchema.Objects || queryConsoleSchema.objects || [])
        .filter(obj => (obj.Type || obj.type) === 'TABLE')
        .map(obj => obj.Name || obj.name)
        .sort();
        
    // Render list
    filterTableList('');
    
    const modal = document.getElementById('generate-insert-modal');
    if (modal) modal.classList.add('active');
}

function closeGenerateInsertModal() {
    const modal = document.getElementById('generate-insert-modal');
    if (modal) modal.classList.remove('active');
    
    const tableSelect = document.getElementById('insert-table-select');
    if (tableSelect) tableSelect.value = '';
    
    const triggerText = document.getElementById('query-table-trigger-text');
    if (triggerText) triggerText.textContent = '-- Pilih Tabel --';
    
    const whereInput = document.getElementById('insert-where-clause');
    if (whereInput) whereInput.value = '';
    
    const useVarsCheckbox = document.getElementById('insert-use-variables');
    if (useVarsCheckbox) useVarsCheckbox.checked = false;
    
    const statusDiv = document.getElementById('generate-insert-status');
    if (statusDiv) {
        statusDiv.style.display = 'none';
        statusDiv.innerHTML = '';
    }
    
    const dropdown = document.getElementById('query-table-dropdown');
    if (dropdown) dropdown.style.display = 'none';
}

function toggleTableDropdown(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('query-table-dropdown');
    if (!dropdown) return;
    const isVisible = dropdown.style.display === 'block';
    dropdown.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
        const searchInput = document.getElementById('query-table-search');
        if (searchInput) {
            searchInput.value = '';
            filterTableList('');
            searchInput.focus();
        }
    }
}

function filterTableList(searchQuery) {
    const listContainer = document.getElementById('query-table-list');
    if (!listContainer) return;
    
    const query = (searchQuery || '').toLowerCase().trim();
    const filtered = queryConsoleActiveTables.filter(t => t.toLowerCase().includes(query));
    
    const activeTableSelect = document.getElementById('insert-table-select');
    const selectedTableVal = activeTableSelect ? activeTableSelect.value : '';
    
    if (filtered.length === 0) {
        listContainer.innerHTML = `<div style="padding: 0.5rem; font-size: 0.8rem; color: var(--text-muted); text-align: center;">Tidak ditemukan</div>`;
        return;
    }
    
    listContainer.innerHTML = filtered.map(t => {
        const isSelected = t === selectedTableVal;
        return `
            <div class="table-select-item ${isSelected ? 'selected' : ''}" 
                 onclick="selectTableForInsert('${escapeHtml(t)}')" 
                 title="${escapeHtml(t)}">
                ${escapeHtml(t)}
            </div>
        `;
    }).join('');
}

function selectTableForInsert(tableName) {
    const tableSelectInput = document.getElementById('insert-table-select');
    if (tableSelectInput) {
        tableSelectInput.value = tableName;
    }
    
    const triggerText = document.getElementById('query-table-trigger-text');
    if (triggerText) {
        triggerText.textContent = tableName;
    }
    
    // Close dropdown
    const dropdown = document.getElementById('query-table-dropdown');
    if (dropdown) {
        dropdown.style.display = 'none';
    }
}

async function executeGenerateInsertScript() {
    const tableSelect = document.getElementById('insert-table-select');
    if (!tableSelect || !tableSelect.value) {
        await uiAlert("Pilih tabel terlebih dahulu!");
        return;
    }
    
    const tableName = tableSelect.value;
    const whereClause = document.getElementById('insert-where-clause').value.trim();
    const useVariables = document.getElementById('insert-use-variables')?.checked ?? false;
    const statusDiv = document.getElementById('generate-insert-status');
    const btn = document.getElementById('btn-generate-insert-exec');
    
    if (statusDiv) {
        statusDiv.style.display = 'block';
        statusDiv.style.background = 'rgba(0, 173, 181, 0.1)';
        statusDiv.style.color = 'var(--accent-teal)';
        statusDiv.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menghasilkan script...';
    }
    
    let origHtml = "";
    if (btn) {
        origHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
        btn.disabled = true;
    }
    
    try {
        const payload = {
            ServerName: queryConsoleActiveServer,
            Authentication: queryConsoleActiveAuth,
            Login: queryConsoleActiveLogin,
            Password: queryConsoleActivePassword,
            Database: queryConsoleActiveDatabase,
            TableName: tableName,
            WhereClause: whereClause,
            UseVariables: useVariables
        };
        
        const res = await fetch(`${API_BASE}/query/generate-inserts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) throw new Error("API Error: " + await res.text());
        const data = await res.json();
        
        if (!data.Success) {
            throw new Error(data.Message || "Gagal menghasilkan script");
        }
        
        // Insert the generated script into Monaco Editor at cursor position
        if (queryConsoleEditor) {
            const script = data.Script;
            const position = queryConsoleEditor.getPosition();
            const range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
            const id = { major: 1, minor: 1 };
            const textEdit = { identifier: id, range: range, text: script, forceMoveMarkers: true };
            queryConsoleEditor.executeEdits("generate-insert", [textEdit]);
            queryConsoleEditor.focus();
        }
        
        await uiAlert(`Script INSERT berhasil digenerate (${data.RowCount} baris) dan dimasukkan ke editor!`);
        closeGenerateInsertModal();
    } catch (err) {
        console.error(err);
        if (statusDiv) {
            statusDiv.style.background = 'rgba(244, 63, 94, 0.1)';
            statusDiv.style.color = '#f43f5e';
            statusDiv.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Error: ' + err.message;
        }
        await uiAlert("Gagal memproses pembuatan script: " + err.message);
    } finally {
        if (btn) {
            btn.innerHTML = origHtml;
            btn.disabled = false;
        }
    }
}

// ── Save & Save As Query Console Logic ──────────────────────────────────────
async function saveQueryConsole() {
    if (!queryConsoleEditor) return;
    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (!activeTab) return;

    const queryText = queryConsoleEditor.getValue();
    if (!queryText.trim()) {
        await uiAlert("Script kueri kosong, tidak ada yang bisa disimpan!");
        return;
    }

    if (activeTab.savedQueryId) {
        // Update existing saved query in DB
        try {
            const payload = {
                Id: activeTab.savedQueryId,
                QueryName: activeTab.savedQueryName,
                QueryText: queryText
            };
            const res = await fetch(`${API_BASE}/query/saved-queries`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error("Gagal mengupdate query di database.");
            
            // Save current value to tab value
            activeTab.value = queryText;
            await uiAlert(`Kueri "${activeTab.savedQueryName}" berhasil diperbarui!`, { variant: 'success' });
        } catch (err) {
            await uiAlert("Gagal menyimpan kueri: " + err.message, { variant: 'error' });
        }
    } else {
        // Save as new query
        await saveAsQueryConsole();
    }
}

async function saveAsQueryConsole() {
    if (!queryConsoleEditor) return;
    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (!activeTab) return;

    const queryText = queryConsoleEditor.getValue();
    if (!queryText.trim()) {
        await uiAlert("Script kueri kosong, tidak ada yang bisa disimpan!");
        return;
    }

    // Generate auto name using YYYYMMDD_HHMMSS
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const autoName = `Query_${YYYY}${MM}${DD}_${hh}${mm}${ss}`;

    const chosenName = await uiPrompt("Masukkan nama untuk kueri ini:", {
        title: "Simpan Kueri Baru",
        defaultValue: activeTab.savedQueryName || autoName,
        placeholder: "Contoh: SELECT Transaksi Hari Ini"
    });

    if (chosenName === null) return; // User cancelled

    const queryName = chosenName.trim() || autoName;

    try {
        const payload = {
            Id: 0,
            QueryName: queryName,
            QueryText: queryText
        };
        const res = await fetch(`${API_BASE}/query/saved-queries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error("Gagal menyimpan query baru ke database.");
        const data = await res.json();

        // Update active tab state
        activeTab.savedQueryId = data.Id;
        activeTab.savedQueryName = queryName;
        activeTab.name = queryName;
        activeTab.value = queryText;

        renderQueryTabs();
        await uiAlert(`Kueri "${queryName}" berhasil disimpan!`, { variant: 'success' });
    } catch (err) {
        await uiAlert("Gagal menyimpan kueri: " + err.message, { variant: 'error' });
    }
}

// ── Query History Modal & Functions ──────────────────────────────────────────
let historyPreviewEditor = null;
let activeHistoryQuery = null;

function openQueryHistoryModal() {
    const modal = document.getElementById('query-history-modal');
    if (!modal) return;
    
    // Clear previous state
    activeHistoryQuery = null;
    document.getElementById('history-preview-title').textContent = 'Preview: (Pilih query)';
    document.getElementById('history-preview-placeholder').style.display = 'flex';
    document.getElementById('history-preview-actions').style.display = 'none';
    
    // Reset filters
    document.getElementById('history-search-term').value = '';
    document.getElementById('history-start-date').value = '';
    document.getElementById('history-end-date').value = '';

    modal.classList.add('active');

    // Lazy load Monaco preview editor after modal display transition
    setTimeout(() => {
        initHistoryPreviewEditor();
    }, 100);

    // Initial fetch of query history
    searchQueryHistory();
}

function closeQueryHistoryModal() {
    const modal = document.getElementById('query-history-modal');
    if (modal) {
        modal.classList.remove('active');
        const content = modal.querySelector('.modal-content');
        if (content) {
            content.classList.remove('maximized');
        }
        const icon = document.getElementById('query-history-maximize-icon');
        if (icon) {
            icon.className = 'fa-solid fa-expand';
        }
    }
    
    // Reset preview editor value to release memory
    if (historyPreviewEditor) {
        historyPreviewEditor.setValue('');
    }
}

function toggleQueryHistoryMaximize() {
    const modal = document.getElementById('query-history-modal');
    if (!modal) return;
    const content = modal.querySelector('.modal-content');
    const icon = document.getElementById('query-history-maximize-icon');
    
    if (content) {
        const isMaximized = content.classList.toggle('maximized');
        if (icon) {
            icon.className = isMaximized ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
        }
        
        // Monaco editor layout trigger to fill the container size
        if (historyPreviewEditor) {
            setTimeout(() => {
                historyPreviewEditor.layout();
            }, 210); // match transition speed
        }
    }
}

function initHistoryPreviewEditor() {
    if (historyPreviewEditor) {
        historyPreviewEditor.layout();
        return;
    }
    const container = document.getElementById('history-preview-monaco-container');
    if (!container) return;

    if (typeof require === 'undefined') {
        console.error("Monaco loader is missing in history modal.");
        return;
    }

    require(['vs/editor/editor.main'], function() {
        if (historyPreviewEditor) return;
        historyPreviewEditor = monaco.editor.create(container, {
            value: '',
            language: 'sql',
            theme: 'vs-dark',
            readOnly: true,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: 'Consolas, Monaco, monospace',
            lineHeight: 16,
            padding: { top: 6, bottom: 6 }
        });
    });
}

async function searchQueryHistory() {
    const searchTerm = document.getElementById('history-search-term').value;
    const startDate = document.getElementById('history-start-date').value;
    const endDate = document.getElementById('history-end-date').value;

    let url = `${API_BASE}/query/saved-queries?searchTerm=${encodeURIComponent(searchTerm)}`;
    if (startDate) url += `&startDate=${startDate}`;
    if (endDate) url += `&endDate=${endDate}`;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Gagal mengambil histori query dari server.");
        const queries = await res.json();
        renderQueryHistoryList(queries);
    } catch (err) {
        console.error("Error fetching query history:", err);
    }
}

function resetQueryHistoryFilters() {
    document.getElementById('history-search-term').value = '';
    document.getElementById('history-start-date').value = '';
    document.getElementById('history-end-date').value = '';
    searchQueryHistory();
}

function renderQueryHistoryList(queries) {
    const listBody = document.getElementById('history-queries-list');
    const emptyDiv = document.getElementById('history-queries-empty');
    if (!listBody) return;

    listBody.innerHTML = '';
    
    if (!queries || queries.length === 0) {
        if (emptyDiv) emptyDiv.style.display = 'block';
        return;
    }
    if (emptyDiv) emptyDiv.style.display = 'none';

    queries.forEach(q => {
        const row = document.createElement('tr');
        row.style.cursor = 'pointer';
        row.style.borderBottom = '1px solid var(--border-flat)';
        
        // Format CreatedAt to localized string
        const dateObj = new Date(q.CreatedAt || q.createdAt);
        const dateStr = dateObj.toLocaleDateString('id-ID') + ' ' + dateObj.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

        row.innerHTML = `
            <td style="padding: 0.6rem 0.75rem; color: #ffffff; font-weight: 500; word-break: break-all;">${escapeHtml(q.QueryName || q.queryName)}</td>
            <td style="padding: 0.6rem 0.75rem; color: var(--text-muted); font-size: 0.75rem;">${dateStr}</td>
            <td style="padding: 0.6rem 0.75rem; text-align: center;">
                <button type="button" class="btn btn-secondary" onclick="deleteHistoryQuery(${q.Id || q.id}, event)" title="Hapus Kueri" style="height: 26px; width: 26px; min-width: 26px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.25); color: #ef4444; border-radius: 4px;">
                    <i class="fa-solid fa-trash-can" style="font-size: 0.75rem;"></i>
                </button>
            </td>
        `;

        row.addEventListener('click', (e) => {
            // Check if user clicked the delete button or inside it
            if (e.target.closest('button')) return;
            selectHistoryQuery(q, row);
        });

        listBody.appendChild(row);
    });
}

function selectHistoryQuery(query, rowEl) {
    activeHistoryQuery = query;

    // Highlight selected row
    const tbody = document.getElementById('history-queries-list');
    tbody.querySelectorAll('tr').forEach(r => r.style.background = 'transparent');
    rowEl.style.background = 'rgba(0, 173, 181, 0.08)';

    // Set preview value
    if (historyPreviewEditor) {
        historyPreviewEditor.setValue(query.QueryText || query.queryText || '');
    }

    // Hide placeholder, show actions
    document.getElementById('history-preview-placeholder').style.display = 'none';
    document.getElementById('history-preview-title').textContent = `Preview: ${query.QueryName || query.queryName}`;
    document.getElementById('history-preview-actions').style.display = 'flex';
}

async function copyHistoryPreviewToClipboard() {
    if (!activeHistoryQuery) return;
    const text = activeHistoryQuery.QueryText || activeHistoryQuery.queryText || '';
    try {
        await navigator.clipboard.writeText(text);
        await uiAlert("Script kueri berhasil disalin ke clipboard!", { variant: 'success' });
    } catch (err) {
        await uiAlert("Gagal menyalin script: " + err.message, { variant: 'error' });
    }
}

async function openHistoryInNewTab() {
    if (!activeHistoryQuery) return;

    const queryText = activeHistoryQuery.QueryText || activeHistoryQuery.queryText || '';
    const queryName = activeHistoryQuery.QueryName || activeHistoryQuery.queryName || 'Query';
    const queryId = activeHistoryQuery.Id || activeHistoryQuery.id;

    // Create a new tab and focus it
    addNewQueryTab(queryText, queryName);

    // Link new tab to database record
    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (activeTab) {
        activeTab.savedQueryId = queryId;
        activeTab.savedQueryName = queryName;
        activeTab.name = queryName;
    }

    renderQueryTabs();
    closeQueryHistoryModal();
}

async function deleteHistoryQuery(id, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    const confirmDel = await uiConfirm("Apakah Anda yakin ingin menghapus kueri ini dari riwayat?", {
        title: "Hapus Kueri"
    });

    if (!confirmDel) return;

    try {
        const res = await fetch(`${API_BASE}/query/saved-queries/${id}`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error("Gagal menghapus kueri di database.");

        // If active query was deleted, clear preview
        if (activeHistoryQuery && (activeHistoryQuery.Id === id || activeHistoryQuery.id === id)) {
            activeHistoryQuery = null;
            document.getElementById('history-preview-title').textContent = 'Preview: (Pilih query)';
            document.getElementById('history-preview-placeholder').style.display = 'flex';
            document.getElementById('history-preview-actions').style.display = 'none';
            if (historyPreviewEditor) historyPreviewEditor.setValue('');
        }

        // Also check if any open tabs are referencing this saved query, if so, detach them
        queryConsoleTabs.forEach(tab => {
            if (tab.savedQueryId === id) {
                tab.savedQueryId = null;
                tab.savedQueryName = "";
            }
        });

        await searchQueryHistory();
        await uiAlert("Kueri berhasil dihapus dari riwayat!", { variant: 'success' });
    } catch (err) {
        await uiAlert("Gagal menghapus kueri: " + err.message, { variant: 'error' });
    }
}

// ── Create Stored Procedure Modal Logic ──────────────────────────────────────
function openCreateSpModal() {
    const nameInput = document.getElementById('sp-name-input');
    if (nameInput) {
        nameInput.value = 'dbo.usp_MyStoredProcedure';
    }

    const tbody = document.getElementById('sp-params-tbody');
    if (tbody) {
        tbody.innerHTML = '';
    }

    const emptyMsg = document.getElementById('sp-params-empty');
    if (emptyMsg) {
        emptyMsg.style.display = 'block';
    }

    const modal = document.getElementById('create-sp-modal');
    if (modal) {
        modal.classList.add('active');
    }
}

function closeCreateSpModal() {
    const modal = document.getElementById('create-sp-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

function addSpParameterRow() {
    const tbody = document.getElementById('sp-params-tbody');
    const emptyMsg = document.getElementById('sp-params-empty');
    if (!tbody) return;

    if (emptyMsg) {
        emptyMsg.style.display = 'none';
    }

    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border-flat)';
    tr.innerHTML = `
        <td style="padding: 0.4rem 0.5rem; vertical-align: middle;">
            <input type="text" class="form-control sp-param-name" placeholder="@ParameterName" oninput="sanitizeParamName(this)" style="font-size: 0.82rem; height: 30px; border-radius: 4px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-flat); width: 100%; color: #ffffff; padding: 0 0.5rem;">
        </td>
        <td style="padding: 0.4rem 0.5rem; vertical-align: middle; width: 150px;">
            <select class="form-control sp-param-type" onchange="toggleParamSizeField(this)" style="font-size: 0.82rem; height: 30px; border-radius: 4px; background: #07090d; border: 1px solid var(--border-flat); width: 100%; color: #ffffff; padding: 0 0.25rem;">
                <option value="INT">INT</option>
                <option value="BIGINT">BIGINT</option>
                <option value="VARCHAR" selected>VARCHAR</option>
                <option value="NVARCHAR">NVARCHAR</option>
                <option value="CHAR">CHAR</option>
                <option value="NCHAR">NCHAR</option>
                <option value="DECIMAL">DECIMAL</option>
                <option value="NUMERIC">NUMERIC</option>
                <option value="DATETIME">DATETIME</option>
                <option value="DATE">DATE</option>
                <option value="TIME">TIME</option>
                <option value="BIT">BIT</option>
                <option value="TEXT">TEXT</option>
                <option value="NTEXT">NTEXT</option>
                <option value="FLOAT">FLOAT</option>
                <option value="REAL">REAL</option>
                <option value="VARBINARY">VARBINARY</option>
                <option value="UNIQUEIDENTIFIER">UNIQUEIDENTIFIER</option>
            </select>
        </td>
        <td style="padding: 0.4rem 0.5rem; vertical-align: middle; width: 100px;">
            <input type="text" class="form-control sp-param-size" placeholder="50" style="font-size: 0.82rem; height: 30px; border-radius: 4px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-flat); width: 100%; color: #ffffff; padding: 0 0.5rem;" value="50">
        </td>
        <td style="padding: 0.4rem 0.5rem; vertical-align: middle; text-align: center; width: 70px;">
            <input type="checkbox" class="sp-param-output" style="width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent-teal);">
        </td>
        <td style="padding: 0.4rem 0.5rem; vertical-align: middle; text-align: center; width: 50px;">
            <button class="btn btn-secondary" onclick="removeSpParameterRow(this)" style="height: 30px; width: 30px; min-width: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; color: #f43f5e; border-color: rgba(244,63,94,0.2); background: rgba(244,63,94,0.05);">
                <i class="fa-solid fa-trash"></i>
            </button>
        </td>
    `;
    tbody.appendChild(tr);

    // Auto focus name field
    const nameInput = tr.querySelector('.sp-param-name');
    if (nameInput) {
        nameInput.focus();
    }
}

function removeSpParameterRow(btn) {
    const tr = btn.closest('tr');
    if (tr) {
        tr.remove();
    }

    const tbody = document.getElementById('sp-params-tbody');
    const emptyMsg = document.getElementById('sp-params-empty');
    if (tbody && tbody.children.length === 0) {
        if (emptyMsg) {
            emptyMsg.style.display = 'block';
        }
    }
}

function sanitizeParamName(inputEl) {
    let val = inputEl.value;
    
    // Auto-prepend @ if there is value and it doesn't start with it
    if (val.length > 0 && !val.startsWith('@')) {
        val = '@' + val;
    }
    
    // Keep only @ followed by word characters (letters, numbers, underscore)
    if (val.length > 1) {
        const at = val[0];
        const body = val.slice(1).replace(/[^\w]/g, '');
        val = at + body;
    }
    
    if (inputEl.value !== val) {
        inputEl.value = val;
    }
}

function toggleParamSizeField(selectEl) {
    const tr = selectEl.closest('tr');
    if (!tr) return;

    const sizeInput = tr.querySelector('.sp-param-size');
    if (!sizeInput) return;

    const selectedType = selectEl.value;
    
    // Enable/disable based on type
    if (['VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR', 'VARBINARY'].includes(selectedType)) {
        sizeInput.disabled = false;
        sizeInput.value = '50';
        sizeInput.placeholder = '50';
        sizeInput.style.background = 'rgba(255,255,255,0.03)';
        sizeInput.style.opacity = '1';
    } else if (['DECIMAL', 'NUMERIC'].includes(selectedType)) {
        sizeInput.disabled = false;
        sizeInput.value = '18, 2';
        sizeInput.placeholder = '18, 2';
        sizeInput.style.background = 'rgba(255,255,255,0.03)';
        sizeInput.style.opacity = '1';
    } else {
        sizeInput.disabled = true;
        sizeInput.value = '';
        sizeInput.placeholder = 'N/A';
        sizeInput.style.background = 'rgba(255,255,255,0.01)';
        sizeInput.style.opacity = '0.5';
    }
}

async function insertSpTemplateToNewTab() {
    const nameInput = document.getElementById('sp-name-input');
    let spName = nameInput ? nameInput.value.trim() : '';
    if (!spName) {
        spName = 'dbo.usp_MyStoredProcedure';
    }

    // Read parameter rows
    const tbody = document.getElementById('sp-params-tbody');
    const paramRows = tbody ? tbody.querySelectorAll('tr') : [];
    
    const paramsList = [];
    let hasInvalidName = false;

    paramRows.forEach(tr => {
        const nameEl = tr.querySelector('.sp-param-name');
        const typeEl = tr.querySelector('.sp-param-type');
        const sizeEl = tr.querySelector('.sp-param-size');
        const outputEl = tr.querySelector('.sp-param-output');

        let name = nameEl ? nameEl.value.trim() : '';
        const type = typeEl ? typeEl.value : 'INT';
        const size = sizeEl ? sizeEl.value.trim() : '';
        const isOutput = outputEl ? outputEl.checked : false;

        if (name) {
            // Check name format (must start with @)
            if (!name.startsWith('@')) {
                name = '@' + name;
            }
            
            let sizeSpec = '';
            if (size && !['N/A'].includes(size.toUpperCase())) {
                sizeSpec = `(${size})`;
            }

            paramsList.push({
                name: name,
                type: type,
                sizeSpec: sizeSpec,
                isOutput: isOutput
            });
        } else {
            hasInvalidName = true;
        }
    });

    if (hasInvalidName && paramRows.length > 0) {
        const confirmEmptyName = await uiConfirm("Ada parameter yang namanya kosong. Lanjutkan tanpa menyertakan parameter kosong tersebut?", {
            title: "Parameter Kosong"
        });
        if (!confirmEmptyName) return;
    }

    // Format parameter lines
    let paramsSql = '';
    if (paramsList.length > 0) {
        paramsSql = '\n    ' + paramsList.map(p => {
            let line = `${p.name} ${p.type}${p.sizeSpec}`;
            if (p.isOutput) {
                line += ' OUTPUT';
            }
            return line;
        }).join(',\n    ') + '\n';
    } else {
        paramsSql = '\n';
    }

    // Generate date and author
    const now = new Date();
    const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

    // T-SQL SP Template
    const template = 
`-- =============================================
-- Author:      System (DbMigrator Perancang SP)
-- Create date: ${dateStr}
-- Description: Template Stored Procedure otomatis
-- =============================================
CREATE OR ALTER PROCEDURE ${spName}${paramsSql}AS
BEGIN
    -- SET NOCOUNT ON ditambahkan untuk mencegah kumpulan hasil tambahan
    -- mengganggu pernyataan SELECT.
    SET NOCOUNT ON;

    -- Tulis kueri / logika bisnis Anda di bawah ini
    -- Contoh:
    SELECT 'Stored Procedure Berhasil Dipanggil' AS Status;
END
GO
`;

    // Extract tab name candidate
    let tabName = spName;
    if (tabName.includes('.')) {
        const parts = tabName.split('.');
        tabName = parts[parts.length - 1];
    }
    tabName = `Create_${tabName}`;

    addNewQueryTab(template, tabName);
    closeCreateSpModal();
}
