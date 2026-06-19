/* ============================================================================
   DATABASE SCHEMA EXPLORER & QUICK ACTIONS MODULE - query-schema.js
   ============================================================================ */

// ── Schema Explorer Tree View Helpers ──────────────────────────────────────

/**
 * Toggle expand/collapse for a folder node.
 * @param {HTMLElement} folderEl - The .se-folder element clicked
 * @param {boolean} forceOpen   - If true, always opens without toggling
 */
function toggleSchemaFolder(folderEl, forceOpen = false) {
    if (!folderEl) return;
    const children = folderEl.nextElementSibling;
    if (!children || !children.classList.contains('se-children')) return;

    const isOpen = folderEl.classList.contains('open');
    if (forceOpen && isOpen) return; // already open, nothing to do

    if (isOpen && !forceOpen) {
        folderEl.classList.remove('open');
        children.classList.remove('open');
    } else {
        folderEl.classList.add('open');
        children.classList.add('open');
    }
}

/**
 * Live filter the schema tree by keyword (called by the search input onkeydown=Enter or oninput).
 * Filters .se-item nodes by name; hides folders with 0 matching children.
 */
function filterSchemaTree(keyword) {
    const listContainer = document.getElementById('schema-exp-list');
    if (!listContainer) return;

    const term = (keyword || '').toLowerCase().trim();

    const folders = listContainer.querySelectorAll('.se-folder');
    folders.forEach(folder => {
        const children = folder.nextElementSibling;
        if (!children) return;

        const items = children.querySelectorAll('.se-item');
        let visibleCount = 0;

        items.forEach(item => {
            const name = item.getAttribute('data-name') || '';
            const match = !term || name.includes(term);
            item.style.display = match ? '' : 'none';
            if (match) visibleCount++;
        });

        // Show/hide the entire folder group based on matches
        const hide = visibleCount === 0 && !!term;
        folder.style.display = hide ? 'none' : '';
        children.style.display = hide ? 'none' : '';

        // Update count badge to show matched count
        const countBadge = folder.querySelector('.se-folder-count');
        if (countBadge) {
            countBadge.textContent = term ? `${visibleCount}/${items.length}` : items.length;
        }

        // Auto-open folder if there are matches (when filtering)
        if (term && visibleCount > 0) {
            folder.classList.add('open');
            children.classList.add('open');
        }
    });
}

/**
 * Expand or collapse all schema tree folders at once.
 * @param {boolean} expand - true = expand all, false = collapse all
 */
function expandCollapseAllSchemaFolders(expand) {
    const listContainer = document.getElementById('schema-exp-list');
    if (!listContainer) return;
    listContainer.querySelectorAll('.se-folder').forEach(folder => {
        const children = folder.nextElementSibling;
        if (!children || !children.classList.contains('se-children')) return;
        if (expand) {
            folder.classList.add('open');
            children.classList.add('open');
        } else {
            folder.classList.remove('open');
            children.classList.remove('open');
        }
    });
}

// ── Schema Explorer Logic ──

let schemaViewerActiveCode = "";
let schemaViewerActiveObjName = "";

async function searchSchemaObjects() {
    if (!queryConsoleActiveServer) {
        await uiAlert("Hubungkan ke database server terlebih dahulu!");
        return;
    }

    const searchInput = document.getElementById('schema-exp-search');
    const listContainer = document.getElementById('schema-exp-list');
    const searchContentChk = document.getElementById('schema-exp-search-content');

    // Always load ALL types — the tree-view groups them into folders
    const objType = 'ALL';
    const searchTerm = searchInput ? searchInput.value.trim() : '';
    const searchInContent = searchContentChk ? searchContentChk.checked : false;

    // Update load button state
    const loadBtn = document.getElementById('btn-schema-exp-load');
    if (loadBtn) {
        loadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memuat...';
        loadBtn.disabled = true;
    }

    if (listContainer) {
        listContainer.innerHTML = `<div style="padding: 1.5rem; font-size: 0.8rem; color: var(--text-muted); text-align: center;"><i class="fa-solid fa-spinner fa-spin"></i> Mencari objek...</div>`;
    }

    try {
        const payload = {
            ServerName: queryConsoleActiveServer,
            Authentication: queryConsoleActiveAuth,
            Login: queryConsoleActiveLogin,
            Password: queryConsoleActivePassword,
            Database: queryConsoleActiveDatabase,
            ObjectType: objType,
            SearchTerm: searchTerm,
            SearchInContent: searchInContent
        };

        const res = await fetch(`${API_BASE}/query/schema-objects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("API Error: " + await res.text());
        const data = await res.json();

        if (!data.Success) {
            throw new Error(data.Message || "Gagal memproses daftar objek.");
        }

        const objects = data.Objects || [];
        window.lastSchemaObjects = objects; // Simpan untuk disalin ke clipboard

        if (objects.length === 0) {
            listContainer.innerHTML = `<div style="padding: 1.5rem; font-size: 0.8rem; color: var(--text-muted); text-align: center;">Tidak ada objek ditemukan.</div>`;
            return;
        }

        // ── Group by type ─────────────────────────────────────────────────────
        const groups = {
            'TABLE':     { label: 'Tables',            icon: 'fa-table',        typeClass: 'type-table',     items: [] },
            'VIEW':      { label: 'Views',             icon: 'fa-eye',          typeClass: 'type-view',      items: [] },
            'PROCEDURE': { label: 'Stored Procedures', icon: 'fa-terminal',     typeClass: 'type-procedure', items: [] },
            'FUNCTION':  { label: 'Functions',         icon: 'fa-code',         typeClass: 'type-function',  items: [] },
        };

        objects.forEach(obj => {
            const t = (obj.Type || '').toUpperCase();
            if (groups[t]) groups[t].items.push(obj);
        });

        // ── Build tree HTML ───────────────────────────────────────────────────
        let html = '';
        const typeKeys = ['TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION'];

        typeKeys.forEach(typeKey => {
            const grp = groups[typeKey];
            if (grp.items.length === 0) return; // skip empty groups

            // Folder label + chevron
            html += `
                <div class="se-folder" data-type="${typeKey}" onclick="toggleSchemaFolder(this)">
                    <i class="fa-solid fa-chevron-right se-folder-chevron"></i>
                    <i class="fa-solid ${grp.icon} se-folder-icon"></i>
                    <span class="se-folder-label">${grp.label}</span>
                    <span class="se-folder-count">${grp.items.length}</span>
                </div>
                <div class="se-children">`;

            grp.items.forEach(obj => {
                const createDate = obj.CreatedDate ? new Date(obj.CreatedDate).toLocaleString('id-ID') : '-';
                const modifyDate = obj.ModifiedDate ? new Date(obj.ModifiedDate).toLocaleString('id-ID') : '-';
                const jsName     = obj.Name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const jsType     = typeKey;
                const jsCreated  = createDate.replace(/'/g, "\\'");
                const jsModified = modifyDate.replace(/'/g, "\\'");
                const escapedName = escapeHtml(obj.Name);

                const actionsHtml = (typeKey === 'TABLE' || typeKey === 'VIEW') ? `
                    <div class="se-item-actions" onclick="event.stopPropagation()">
                        <div class="se-item-dropdown">
                            <button onclick="toggleSchemaItemDropdown(event)" title="Pilihan Script" class="se-action-btn"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                            <div class="se-item-dropdown-menu">
                                <button onclick="scriptSelectTop50('${jsName}'); closeAllSchemaItemDropdowns();" class="se-dropdown-item"><i class="fa-solid fa-play"></i> Select Top 50</button>
                                ${typeKey === 'TABLE' ? `
                                <button onclick="scriptInsertToTable('${jsName}'); closeAllSchemaItemDropdowns();" class="se-dropdown-item"><i class="fa-solid fa-file-import"></i> Script INSERT To</button>
                                <button onclick="scriptUpdateToTable('${jsName}'); closeAllSchemaItemDropdowns();" class="se-dropdown-item"><i class="fa-solid fa-pen-to-square"></i> Script UPDATE To</button>
                                <button onclick="openInsertToWithDataModal('${jsName}'); closeAllSchemaItemDropdowns();" class="se-dropdown-item"><i class="fa-solid fa-database"></i> Script INSERT To (with data)</button>
                                ` : ''}
                            </div>
                        </div>
                    </div>
                ` : '';

                html += `
                    <div class="se-item" data-name="${escapedName.toLowerCase()}" onclick="showSchemaDefinition('${jsName}','${jsType}','${jsCreated}','${jsModified}')" title="${escapedName}">
                        <i class="fa-solid ${grp.icon} se-item-icon ${grp.typeClass}"></i>
                        <span class="se-item-name">${escapedName}</span>
                        ${actionsHtml}
                    </div>`;
            });

            html += `</div>`;
        });

        listContainer.innerHTML = html;

        // Auto-open first non-empty folder
        const firstFolder = listContainer.querySelector('.se-folder');
        if (firstFolder) toggleSchemaFolder(firstFolder, true);

    } catch (err) {
        console.error(err);
        window.lastSchemaObjects = [];
        if (listContainer) {
            listContainer.innerHTML = `<div style="padding: 1.5rem; font-size: 0.8rem; color: #f43f5e; text-align: center;"><i class="fa-solid fa-circle-exclamation"></i> Error: ${escapeHtml(err.message)}</div>`;
        }
    } finally {
        // Restore load button
        const loadBtn = document.getElementById('btn-schema-exp-load');
        if (loadBtn) {
            loadBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Muat';
            loadBtn.disabled = false;
        }
    }
}

async function copySchemaObjectList() {
    const objects = window.lastSchemaObjects;
    if (!objects || objects.length === 0) {
        await uiAlert("Tidak ada daftar objek hasil pencarian untuk disalin!");
        return;
    }

    // Mengonversi daftar objek ke format salinan (Nama Objek \t Tipe Objek \n)
    let textContent = "";
    textContent += "Object Name\tObject Type\n"; // Header
    objects.forEach(obj => {
        textContent += `${obj.Name || obj.name}\t${obj.Type || obj.type}\n`;
    });

    navigator.clipboard.writeText(textContent)
        .then(async () => {
            await uiAlert(`Daftar objek (${objects.length} item) berhasil disalin ke clipboard!`);
        })
        .catch(async (err) => {
            console.error("Gagal menyalin daftar objek: ", err);
            await uiAlert("Gagal menyalin data: " + err.message);
        });
}

async function showSchemaDefinition(objName, objType, createDate, modifyDate) {
    const modal = document.getElementById('schema-viewer-modal');
    if (!modal) return;

    // Reset checkbox
    const chk = document.getElementById('schema-insert-active-tab');
    if (chk) chk.checked = false;

    schemaViewerActiveObjName = objName;

    // Show loading state
    const titleEl = document.getElementById('schema-viewer-title');
    if (titleEl) {
        titleEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="color: var(--accent-teal);"></i> Memuat Skema: <span style="color: var(--accent-teal);">${escapeHtml(objName)}</span>`;
    }

    const createdEl = document.getElementById('schema-viewer-created');
    const modifiedEl = document.getElementById('schema-viewer-modified');
    if (createdEl) createdEl.textContent = createDate || '-';
    if (modifiedEl) modifiedEl.textContent = modifyDate || '-';

    modal.classList.add('active');
    initSchemaViewerEditor("-- Menghubungi server...");

    try {
        const payload = {
            ServerName: queryConsoleActiveServer,
            Authentication: queryConsoleActiveAuth,
            Login: queryConsoleActiveLogin,
            Password: queryConsoleActivePassword,
            Database: queryConsoleActiveDatabase,
            ObjectName: objName,
            ObjectType: objType
        };

        const res = await fetch(`${API_BASE}/query/schema-definition`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("API Error: " + await res.text());
        const data = await res.json();

        if (!data.Success) {
            throw new Error(data.Message || "Gagal memuat definisi skema.");
        }

        schemaViewerActiveCode = data.Ddl || "";
        
        if (titleEl) {
            titleEl.innerHTML = `<i class="fa-solid fa-code" style="color: var(--accent-teal);"></i> Skema: <span style="color: var(--accent-teal);">${escapeHtml(objName)}</span>`;
        }
        
        initSchemaViewerEditor(schemaViewerActiveCode);
    } catch (err) {
        console.error(err);
        schemaViewerActiveCode = `-- Error: ${err.message}`;
        if (titleEl) {
            titleEl.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="color: #f43f5e;"></i> Gagal Memuat Skema`;
        }
        initSchemaViewerEditor(schemaViewerActiveCode);
    }
}

let schemaViewerEditor = null;
function initSchemaViewerEditor(codeText) {
    const container = document.getElementById('schema-viewer-monaco-container');
    if (!container) return;

    if (schemaViewerEditor) {
        schemaViewerEditor.setValue(codeText);
        return;
    }

    if (typeof require === 'undefined') {
        console.error("Monaco loader is not loaded yet.");
        return;
    }

    require.config({ paths: { vs: 'lib/monaco-editor/min/vs' } });
    require(['vs/editor/editor.main'], function() {
        if (schemaViewerEditor) return;
        schemaViewerEditor = monaco.editor.create(container, {
            value: codeText,
            language: 'sql',
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'Consolas, Monaco, monospace',
            lineHeight: 18,
            readOnly: true,
            scrollbar: {
                vertical: 'auto',
                horizontal: 'auto'
            }
        });
    });
}

function closeSchemaViewerModal() {
    const modal = document.getElementById('schema-viewer-modal');
    if (modal) {
        modal.classList.remove('active');
        const content = modal.querySelector('.modal-content');
        if (content) {
            content.classList.remove('maximized');
        }
        const icon = document.getElementById('schema-viewer-maximize-icon');
        if (icon) {
            icon.className = 'fa-solid fa-expand';
        }
        // Reset checkbox
        const chk = document.getElementById('schema-insert-active-tab');
        if (chk) {
            chk.checked = false;
        }
    }
}

function toggleSchemaViewerMaximize() {
    const modal = document.getElementById('schema-viewer-modal');
    if (!modal) return;
    const content = modal.querySelector('.modal-content');
    const icon = document.getElementById('schema-viewer-maximize-icon');
    
    if (content) {
        const isMaximized = content.classList.toggle('maximized');
        if (icon) {
            if (isMaximized) {
                icon.className = 'fa-solid fa-compress';
            } else {
                icon.className = 'fa-solid fa-expand';
            }
        }
        
        // Monaco editor layout trigger to fill the container size
        if (schemaViewerEditor) {
            setTimeout(() => {
                schemaViewerEditor.layout();
            }, 210); // match transition speed
        }
    }
}

async function copySchemaToClipboard() {
    if (!schemaViewerActiveCode) {
        await uiAlert("Tidak ada kode untuk disalin!");
        return;
    }

    navigator.clipboard.writeText(schemaViewerActiveCode)
        .then(async () => {
            await uiAlert("Skema SQL berhasil disalin ke clipboard!");
        })
        .catch(async (err) => {
            console.error("Gagal menyalin: ", err);
            await uiAlert("Gagal menyalin teks.");
        });
}

async function insertSchemaToEditor() {
    if (!schemaViewerActiveCode) {
        await uiAlert("Tidak ada kode untuk dimasukkan!");
        return;
    }

    const insertToActive = document.getElementById('schema-insert-active-tab')?.checked || false;

    if (insertToActive) {
        if (queryConsoleEditor) {
            const position = queryConsoleEditor.getPosition();
            const range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
            const id = { major: 1, minor: 1 };
            const textEdit = { identifier: id, range: range, text: schemaViewerActiveCode + "\n", forceMoveMarkers: true };
            queryConsoleEditor.executeEdits("insert-schema", [textEdit]);
            queryConsoleEditor.focus();
            
            await uiAlert("Skema SQL berhasil dimasukkan ke SQL Editor!");
            closeSchemaViewerModal();
        } else {
            await uiAlert("SQL Editor tidak ditemukan!");
        }
    } else {
        // Default: Open in a new query tab
        const tabName = schemaViewerActiveObjName || "Skema Query";
        addNewQueryTab(schemaViewerActiveCode + "\n", tabName);
        await uiAlert(`Skema SQL berhasil dibuka di tab baru "${tabName}"!`);
        closeSchemaViewerModal();
    }
}

function toggleSchemaExplorer() {
    const explorer = document.getElementById('query-schema-explorer');
    const textEl = document.getElementById('toggle-schema-exp-text');
    const btn = document.getElementById('btn-toggle-schema-explorer');
    
    if (!explorer) return;
    
    if (explorer.style.display === 'none') {
        explorer.style.display = 'flex';
        if (textEl) textEl.textContent = 'Hide Explorer';
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-folder-minus"></i> <span id="toggle-schema-exp-text">Hide Explorer</span>';
        }
    } else {
        explorer.style.display = 'none';
        if (textEl) textEl.textContent = 'Show Explorer';
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-folder-plus"></i> <span id="toggle-schema-exp-text">Show Explorer</span>';
        }
    }
}

// ── Schema Explorer Quick Script Actions ───────────────────────────────────
function cleanQueryTableName(name) {
    if (!name) return "";
    let clean = name.replace(/[\[\]]/g, ""); // Remove brackets
    if (clean.includes('.')) {
        const parts = clean.split('.');
        return parts[parts.length - 1]; // Return the last part
    }
    return clean;
}

function scriptSelectTop50(tableName) {
    const cleanTName = tableName.trim();
    const query = `SELECT TOP 50 *\nFROM ${cleanTName};`;
    addNewQueryTab(query, `Select_${cleanQueryTableName(cleanTName)}`);
}

function scriptInsertToTable(tableName) {
    const cleanTName = tableName.trim();
    let columns = [];
    if (queryConsoleSchema && queryConsoleSchema.Columns) {
        columns = queryConsoleSchema.Columns.filter(c => {
            const cTable = cleanQueryTableName(c.TableName || c.tableName || '');
            return cTable.toLowerCase() === cleanQueryTableName(cleanTName).toLowerCase();
        });
    }

    let query = "";
    if (columns.length > 0) {
        const colList = columns.map(c => `    [${c.ColumnName || c.columnName}]`).join(',\n');
        const valList = columns.map((c, idx) => {
            const colName = c.ColumnName || c.columnName;
            const colType = c.DataType || c.dataType || 'column';
            const comma = idx === columns.length - 1 ? ' ' : ',';
            return `    NULL${comma} -- ${colName} (${colType})`;
        }).join('\n');
        query = `INSERT INTO ${cleanTName} (\n${colList}\n)\nVALUES (\n${valList}\n);`;
    } else {
        query = `INSERT INTO ${cleanTName} (\n    [Kolom1],\n    [Kolom2]\n)\nVALUES (\n    NULL, -- Kolom1 (int)\n    NULL  -- Kolom2 (varchar(50))\n);`;
    }

    addNewQueryTab(query, `Insert_${cleanQueryTableName(cleanTName)}`);
}

// Script UPDATE To dengan menyertakan tipe data di samping kolom set
function scriptUpdateToTable(tableName) {
    const cleanTName = tableName.trim();
    let columns = [];
    if (queryConsoleSchema && queryConsoleSchema.Columns) {
        columns = queryConsoleSchema.Columns.filter(c => {
            const cTable = cleanQueryTableName(c.TableName || c.tableName || '');
            return cTable.toLowerCase() === cleanQueryTableName(cleanTName).toLowerCase();
        });
    }

    let query = "";
    if (columns.length > 0) {
        const pkCandidate = columns.find(c => {
            const name = (c.ColumnName || c.columnName || '').toLowerCase();
            return name === 'id' || name === `${cleanQueryTableName(cleanTName).toLowerCase()}id` || name.endsWith('id');
        });

        const pkName = pkCandidate ? (pkCandidate.ColumnName || pkCandidate.columnName) : 'ID';
        const setColumns = columns.filter(c => (c.ColumnName || c.columnName) !== pkName);
        const setList = setColumns.map((c, idx) => {
            const colName = c.ColumnName || c.columnName;
            const colType = c.DataType || c.dataType || 'column';
            const comma = idx === setColumns.length - 1 ? ' ' : ',';
            return `    [${colName}] = NULL${comma} -- (${colType})`;
        }).join('\n');
        
        query = `UPDATE ${cleanTName}\nSET\n${setList}\nWHERE [${pkName}] = <Nilai>;`;
    } else {
        query = `UPDATE ${cleanTName}\nSET\n    [Kolom1] = NULL, -- (int)\n    [Kolom2] = NULL  -- (varchar(50))\nWHERE [ID] = <Nilai>;`;
    }

    addNewQueryTab(query, `Update_${cleanQueryTableName(cleanTName)}`);
}

function toggleSchemaItemDropdown(event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const btn = event.currentTarget;
    const menu = btn.nextElementSibling;
    if (!menu) return;

    const isActive = menu.classList.contains('active');
    closeAllSchemaItemDropdowns();

    if (!isActive) {
        menu.classList.add('active');
        const actionsContainer = btn.closest('.se-item-actions');
        if (actionsContainer) {
            actionsContainer.classList.add('menu-active');
        }
    }
}

function closeAllSchemaItemDropdowns() {
    document.querySelectorAll('.se-item-dropdown-menu').forEach(m => {
        m.classList.remove('active');
    });
    document.querySelectorAll('.se-item-actions').forEach(a => {
        a.classList.remove('menu-active');
    });
}
