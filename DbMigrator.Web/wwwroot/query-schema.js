/* ============================================================================
   DATABASE SCHEMA EXPLORER & QUICK ACTIONS MODULE - query-schema.js
   ============================================================================ */

let schemaExplorerShowAllDbs = localStorage.getItem('schemaExplorerShowAllDbs') === 'true';

function toggleSchemaShowAllDbs(checked) {
    schemaExplorerShowAllDbs = checked;
    localStorage.setItem('schemaExplorerShowAllDbs', checked ? 'true' : 'false');
    rebuildSchemaExplorerTree();
}

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
 * Toggle database folder node (with lazy loading)
 * @param {HTMLElement} node - The database folder node element
 */
async function toggleDatabaseNode(node) {
    if (!node) return;
    const children = node.nextElementSibling;
    if (!children || !children.classList.contains('se-children')) return;
    
    const serverName = node.getAttribute('data-server');
    const dbName = node.getAttribute('data-db');
    
    const isOpen = node.classList.contains('open');
    if (isOpen) {
        node.classList.remove('open');
        children.classList.remove('open');
    } else {
        node.classList.add('open');
        children.classList.add('open');
        
        // Lazy load database objects if not already loaded or cached
        const conn = activeConnections[serverName];
        if (conn) {
            const cachedSchema = conn.schemaCache && conn.schemaCache[dbName];
            if (!cachedSchema) {
                await loadDatabaseSchemaNode(serverName, dbName, children, node);
            }
        }
    }
}

/**
 * Lazy load database schema objects from endpoint
 */
async function loadDatabaseSchemaNode(serverName, dbName, childrenContainer, folderNode) {
    const conn = activeConnections[serverName];
    if (!conn) {
        childrenContainer.innerHTML = `<div style="padding: 0.5rem 1rem; font-size: 0.75rem; color: #f43f5e;">Sesi koneksi server tidak ditemukan.</div>`;
        return;
    }
    
    childrenContainer.innerHTML = `<div style="padding: 0.5rem 1rem; font-size: 0.75rem; color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Memuat objek...</div>`;
    
    try {
        const payload = {
            ServerName: conn.serverName,
            Authentication: conn.authType,
            Login: conn.login,
            Password: conn.password,
            Database: dbName,
            ObjectType: 'ALL',
            SearchTerm: '',
            SearchInContent: false
        };
        
        const res = await fetch(`${API_BASE}/query/schema-objects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) throw new Error("Gagal terhubung ke database.");
        const data = await res.json();
        
        if (!data.Success) {
            throw new Error(data.Message || "Gagal memproses daftar objek.");
        }
        
        const objects = data.Objects || [];
        
        // Cache this database's objects
        conn.schemaCache = conn.schemaCache || {};
        conn.schemaCache[dbName] = objects;
        
        renderDatabaseObjects(serverName, dbName, childrenContainer, objects);
    } catch (err) {
        childrenContainer.innerHTML = `<div style="padding: 0.5rem 1rem; font-size: 0.75rem; color: #f43f5e;"><i class="fa-solid fa-circle-exclamation"></i> Error: ${escapeHtml(err.message)}</div>`;
    }
}

/**
 * Render standard folders (Tables, Views, SPs, Functions) under database children container
 */
function renderDatabaseObjects(serverName, dbName, container, objects) {
    container.innerHTML = getDatabaseObjectsHtml(serverName, dbName, objects);
}

/**
 * Generate objects folder list HTML inside a database node
 */
function getDatabaseObjectsHtml(serverName, dbName, objects) {
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

    let html = '';
    const typeKeys = ['TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION'];

    typeKeys.forEach(typeKey => {
        const grp = groups[typeKey];
        if (grp.items.length === 0) return; // skip empty groups

        const folderId = `folder-${serverName}-${dbName}-${typeKey}`.replace(/[^a-zA-Z0-9-]/g, '_');
        
        html += `
            <div class="se-folder" data-type="${typeKey}" onclick="toggleSchemaFolder(this)">
                <i class="fa-solid fa-chevron-right se-folder-chevron"></i>
                <i class="fa-solid ${grp.icon} se-folder-icon"></i>
                <span class="se-folder-label">${grp.label}</span>
                <span class="se-folder-count">${grp.items.length}</span>
            </div>
            <div class="se-children" id="${folderId}">`;

        grp.items.forEach(obj => {
            const createDate = obj.CreatedDate ? new Date(obj.CreatedDate).toLocaleString('id-ID') : '-';
            const modifyDate = obj.ModifiedDate ? new Date(obj.ModifiedDate).toLocaleString('id-ID') : '-';
            const jsName     = obj.Name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const jsType     = typeKey;
            const jsCreated  = createDate.replace(/'/g, "\\'");
            const jsModified = modifyDate.replace(/'/g, "\\'");
            const jsServer   = serverName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const jsDb       = dbName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const escapedName = escapeHtml(obj.Name);

            const actionsHtml = (typeKey === 'TABLE' || typeKey === 'VIEW') ? `
                <div class="se-item-actions" onclick="event.stopPropagation()">
                    <div class="se-item-dropdown">
                        <button onclick="toggleSchemaItemDropdown(event)" title="Pilihan Script" class="se-action-btn"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                        <div class="se-item-dropdown-menu">
                            <button onclick="scriptSelectTop50('${jsName}', '${jsServer}', '${jsDb}'); closeAllSchemaItemDropdowns();" class="se-dropdown-item"><i class="fa-solid fa-play"></i> Select Top 50</button>
                            ${typeKey === 'TABLE' ? `
                            <button onclick="scriptInsertToTable('${jsName}', '${jsServer}', '${jsDb}'); closeAllSchemaItemDropdowns();" class="se-dropdown-item"><i class="fa-solid fa-file-import"></i> Script INSERT To</button>
                            <button onclick="scriptUpdateToTable('${jsName}', '${jsServer}', '${jsDb}'); closeAllSchemaItemDropdowns();" class="se-dropdown-item"><i class="fa-solid fa-pen-to-square"></i> Script UPDATE To</button>
                            <button onclick="openInsertToWithDataModal('${jsName}', '${jsServer}', '${jsDb}'); closeAllSchemaItemDropdowns();" class="se-dropdown-item"><i class="fa-solid fa-database"></i> Script INSERT To (with data)</button>
                            ` : ''}
                        </div>
                    </div>
                </div>
            ` : '';

            html += `
                <div class="se-item" data-name="${escapedName.toLowerCase()}" onclick="showSchemaDefinition('${jsName}','${jsType}','${jsCreated}','${jsModified}','${jsServer}','${jsDb}')" title="${escapedName}">
                    <i class="fa-solid ${grp.icon} se-item-icon ${grp.typeClass}"></i>
                    <span class="se-item-name">${escapedName}</span>
                    ${actionsHtml}
                </div>`;
        });

        html += `</div>`;
    });

    if (html === '') {
        return `<div style="padding: 0.5rem 1rem; font-size: 0.75rem; color: var(--text-muted); text-align: center;">Tidak ada objek.</div>`;
    }
    return html;
}

/**
 * Rebuild the multi-server Schema Explorer Object Tree
 */
function rebuildSchemaExplorerTree() {
    const listContainer = document.getElementById('schema-exp-list');
    if (!listContainer) return;
    
    // Sync checkbox state
    const chk = document.getElementById('schema-exp-show-all');
    if (chk) {
        chk.checked = schemaExplorerShowAllDbs;
    }
    
    const serverKeys = Object.keys(activeConnections);
    if (serverKeys.length === 0) {
        listContainer.innerHTML = `
            <div style="padding: 1.5rem; font-size: 0.8rem; color: var(--text-muted); text-align: center;">
                <i class="fa-solid fa-folder-tree" style="font-size: 1.5rem; margin-bottom: 0.5rem; display: block; opacity: 0.3;"></i>
                Klik <strong>Muat</strong> untuk memuat daftar objek skema.
            </div>
        `;
        return;
    }
    
    let html = '';
    serverKeys.forEach(serverName => {
        const conn = activeConnections[serverName];
        const databases = conn.databases || [];
        
        // Server node starts expanded if matches the active query console server
        const isServerActive = (serverName === queryConsoleActiveServer);
        
        if (!schemaExplorerShowAllDbs && !isServerActive) {
            return; // Skip rendering other servers when not showing all
        }
        
        html += `
            <div class="se-folder se-server-folder ${isServerActive ? 'open' : ''}" data-server="${escapeHtml(serverName)}" onclick="toggleSchemaFolder(this)">
                <i class="fa-solid fa-chevron-right se-folder-chevron"></i>
                <i class="fa-solid fa-server se-folder-icon" style="color: var(--accent-teal);"></i>
                <span class="se-folder-label" style="color: #ffffff; font-weight: 700;">${escapeHtml(serverName)}</span>
            </div>
            <div class="se-children ${isServerActive ? 'open' : ''}">`;
            
        if (schemaExplorerShowAllDbs) {
            html += `
                <div class="se-folder se-databases-folder open" onclick="toggleSchemaFolder(this)">
                    <i class="fa-solid fa-chevron-right se-folder-chevron"></i>
                    <i class="fa-solid fa-folder se-folder-icon" style="color: #fcd34d;"></i>
                    <span class="se-folder-label">Databases</span>
                </div>
                <div class="se-children open">`;
        
            databases.forEach(dbName => {
                const isDbActive = (serverName === queryConsoleActiveServer && dbName === queryConsoleActiveDatabase);
                const cachedSchema = conn.schemaCache && conn.schemaCache[dbName];
                
                html += `
                    <div class="se-folder se-db-folder ${isDbActive ? 'open' : ''}" 
                         data-server="${escapeHtml(serverName)}" 
                         data-db="${escapeHtml(dbName)}" 
                         onclick="toggleDatabaseNode(this)">
                        <i class="fa-solid fa-chevron-right se-folder-chevron"></i>
                        <i class="fa-solid fa-database se-folder-icon" style="color: #60a5fa;"></i>
                        <span class="se-folder-label">${escapeHtml(dbName)}</span>
                    </div>
                    <div class="se-children se-db-children ${isDbActive ? 'open' : ''}" id="db-children-${escapeHtml(serverName)}-${escapeHtml(dbName)}">`;
                
                if (cachedSchema) {
                    html += getDatabaseObjectsHtml(serverName, dbName, cachedSchema);
                } else if (isDbActive) {
                    // Placeholder to trigger deferred lazy loading of active database
                    html += `<div style="padding: 0.5rem 1rem; font-size: 0.75rem; color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Memuat...</div>`;
                    setTimeout(() => {
                        const childrenEl = document.getElementById(`db-children-${serverName}-${dbName}`);
                        if (childrenEl) {
                            loadDatabaseSchemaNode(serverName, dbName, childrenEl, null);
                        }
                    }, 50);
                } else {
                    html += `<div style="padding: 0.5rem 1rem; font-size: 0.75rem; color: var(--text-muted);">Expand untuk memuat objek</div>`;
                }
                
                html += `
                    </div>`;
            });
            
            html += `
                    </div>`;
        } else {
            // Render ONLY the active database directly
            const dbName = queryConsoleActiveDatabase;
            if (dbName) {
                const isDbActive = true;
                const cachedSchema = conn.schemaCache && conn.schemaCache[dbName];
                
                html += `
                    <div class="se-folder se-db-folder ${isDbActive ? 'open' : ''}" 
                         data-server="${escapeHtml(serverName)}" 
                         data-db="${escapeHtml(dbName)}" 
                         onclick="toggleDatabaseNode(this)">
                        <i class="fa-solid fa-chevron-right se-folder-chevron"></i>
                        <i class="fa-solid fa-database se-folder-icon" style="color: #60a5fa;"></i>
                        <span class="se-folder-label">${escapeHtml(dbName)}</span>
                    </div>
                    <div class="se-children se-db-children ${isDbActive ? 'open' : ''}" id="db-children-${escapeHtml(serverName)}-${escapeHtml(dbName)}">`;
                
                if (cachedSchema) {
                    html += getDatabaseObjectsHtml(serverName, dbName, cachedSchema);
                } else {
                    html += `<div style="padding: 0.5rem 1rem; font-size: 0.75rem; color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Memuat...</div>`;
                    setTimeout(() => {
                        const childrenEl = document.getElementById(`db-children-${serverName}-${dbName}`);
                        if (childrenEl) {
                            loadDatabaseSchemaNode(serverName, dbName, childrenEl, null);
                        }
                    }, 50);
                }
                
                html += `
                    </div>`;
            } else {
                html += `<div style="padding: 0.5rem 1rem; font-size: 0.75rem; color: var(--text-muted);">Pilih database di atas untuk memuat objek.</div>`;
            }
        }
        
        html += `
            </div>`;
    });
    
    listContainer.innerHTML = html;
}

/**
 * Async helper to lookup table columns on demand using full autocomplete API, caching results
 */
async function getColumnsForTable(serverName, dbName, tableName) {
    if (serverName === queryConsoleActiveServer && dbName === queryConsoleActiveDatabase && queryConsoleSchema && queryConsoleSchema.Columns) {
        const cleanT = cleanQueryTableName(tableName).toLowerCase();
        return queryConsoleSchema.Columns.filter(c => cleanQueryTableName(c.TableName || c.tableName || '').toLowerCase() === cleanT);
    }
    
    const conn = activeConnections[serverName];
    if (!conn) return [];
    
    conn.columnsCache = conn.columnsCache || {};
    const cacheKey = `${dbName}`;
    
    if (conn.columnsCache[cacheKey]) {
        const cleanT = cleanQueryTableName(tableName).toLowerCase();
        return conn.columnsCache[cacheKey].filter(c => cleanQueryTableName(c.TableName || c.tableName || '').toLowerCase() === cleanT);
    }
    
    try {
        const payload = {
            ServerName: conn.serverName,
            Authentication: conn.authType,
            Login: conn.login,
            Password: conn.password,
            Database: dbName
        };
        const res = await fetch(`${API_BASE}/query/schema`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            const data = await res.json();
            conn.columnsCache[cacheKey] = data.Columns || [];
            
            if (serverName === queryConsoleActiveServer && dbName === queryConsoleActiveDatabase) {
                queryConsoleSchema = data;
                queryConsoleSchemaCache[dbName] = data;
            }
            
            const cleanT = cleanQueryTableName(tableName).toLowerCase();
            return (data.Columns || []).filter(c => cleanQueryTableName(c.TableName || c.tableName || '').toLowerCase() === cleanT);
        }
    } catch (err) {
        console.error("Gagal mengambil kolom untuk script:", err);
    }
    return [];
}

/**
 * Filter tree nodes in the browser (live searching / input listener)
 */
function filterSchemaTree(keyword) {
    const listContainer = document.getElementById('schema-exp-list');
    if (!listContainer) return;

    const term = (keyword || '').toLowerCase().trim();
    const items = listContainer.querySelectorAll('.se-item');
    const foldersToReveal = new Set();

    items.forEach(item => {
        const name = item.getAttribute('data-name') || '';
        const match = !term || name.includes(term);
        item.style.display = match ? '' : 'none';
        
        if (match && term) {
            let parent = item.parentElement;
            while (parent && parent !== listContainer) {
                if (parent.classList.contains('se-children')) {
                    const folderSibling = parent.previousElementSibling;
                    if (folderSibling && folderSibling.classList.contains('se-folder')) {
                        foldersToReveal.add(folderSibling);
                    }
                }
                parent = parent.parentElement;
            }
        }
    });

    const allFolders = listContainer.querySelectorAll('.se-folder');
    allFolders.forEach(folder => {
        const children = folder.nextElementSibling;
        if (!children || !children.classList.contains('se-children')) return;
        
        const visibleItems = children.querySelectorAll('.se-item:not([style*="display: none"])');
        
        if (!term) {
            folder.style.display = '';
            children.style.display = '';
        } else {
            const hasVisibleContent = visibleItems.length > 0;
            folder.style.display = hasVisibleContent ? '' : 'none';
            children.style.display = hasVisibleContent ? '' : 'none';
            
            if (foldersToReveal.has(folder)) {
                folder.classList.add('open');
                children.classList.add('open');
            }
        }
        
        const typeAttr = folder.getAttribute('data-type');
        if (typeAttr) {
            const allItems = children.querySelectorAll('.se-item');
            const countBadge = folder.querySelector('.se-folder-count');
            if (countBadge) {
                countBadge.textContent = term ? `${visibleItems.length}/${allItems.length}` : allItems.length;
            }
        }
    });
}

/**
 * Expand or collapse all folders in the explorer
 */
function expandCollapseAllSchemaFolders(expand) {
    const listContainer = document.getElementById('schema-exp-list');
    if (!listContainer) return;
    listContainer.querySelectorAll('.se-folder').forEach(folder => {
        const children = folder.nextElementSibling;
        if (!children || !children.classList.contains('se-children')) return;
        
        if (expand && folder.classList.contains('se-db-folder')) {
            const serverName = folder.getAttribute('data-server');
            const dbName = folder.getAttribute('data-db');
            const conn = activeConnections[serverName];
            if (conn) {
                const cachedSchema = conn.schemaCache && conn.schemaCache[dbName];
                if (!cachedSchema) {
                    loadDatabaseSchemaNode(serverName, dbName, children, folder);
                }
            }
        }
        
        if (expand) {
            folder.classList.add('open');
            children.classList.add('open');
        } else {
            folder.classList.remove('open');
            children.classList.remove('open');
        }
    });
}

/**
 * Force refresh active database schema objects from server, or execute deep server-side content query
 */
async function searchSchemaObjects() {
    if (!queryConsoleActiveServer) {
        await uiAlert("Hubungkan ke database server terlebih dahulu!");
        return;
    }

    const searchInput = document.getElementById('schema-exp-search');
    const searchContentChk = document.getElementById('schema-exp-search-content');
    
    const searchTerm = searchInput ? searchInput.value.trim() : '';
    const searchInContent = searchContentChk ? searchContentChk.checked : false;

    const conn = activeConnections[queryConsoleActiveServer];
    if (!conn) return;
    
    const targetDb = queryConsoleActiveDatabase;
    if (!targetDb) return;
    
    const loadBtn = document.getElementById('btn-schema-exp-load');
    if (loadBtn) {
        loadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memuat...';
        loadBtn.disabled = true;
    }
    
    const childrenEl = document.getElementById(`db-children-${queryConsoleActiveServer}-${targetDb}`);
    
    try {
        if (!searchTerm && !searchInContent) {
            // Force refresh active database context: wipe cache and reload
            if (conn.schemaCache) delete conn.schemaCache[targetDb];
            
            rebuildSchemaExplorerTree();
            
            // Expand the active server and database nodes explicitly
            const dbNode = document.querySelector(`.se-db-folder[data-server="${escapeHtml(queryConsoleActiveServer)}"][data-db="${escapeHtml(targetDb)}"]`);
            if (dbNode) {
                dbNode.classList.add('open');
                const children = dbNode.nextElementSibling;
                if (children) children.classList.add('open');
            }
        } else {
            // Run server-side SQL matching lookup for the active database
            if (childrenEl) {
                childrenEl.innerHTML = `<div style="padding: 0.5rem 1rem; font-size: 0.75rem; color: var(--text-muted);"><i class="fa-solid fa-magnifying-glass fa-spin"></i> Mencari...</div>`;
            }
            
            const payload = {
                ServerName: conn.serverName,
                Authentication: conn.authType,
                Login: conn.login,
                Password: conn.password,
                Database: targetDb,
                ObjectType: 'ALL',
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
            if (childrenEl) {
                renderDatabaseObjects(conn.serverName, targetDb, childrenEl, objects);
                
                // Reset visibility and open parent folders/containers
                childrenEl.style.display = '';
                childrenEl.classList.add('open');
                
                const dbFolder = childrenEl.previousElementSibling;
                if (dbFolder && dbFolder.classList.contains('se-folder')) {
                    dbFolder.style.display = '';
                    dbFolder.classList.add('open');
                }
                
                let parentServerChildren = childrenEl.parentElement;
                if (parentServerChildren && parentServerChildren.classList.contains('se-children')) {
                    parentServerChildren.style.display = '';
                    parentServerChildren.classList.add('open');
                    
                    const serverFolder = parentServerChildren.previousElementSibling;
                    if (serverFolder && serverFolder.classList.contains('se-server-folder')) {
                        serverFolder.style.display = '';
                        serverFolder.classList.add('open');
                    }
                }
                
                // Force all category folders and items to be visible and open for server search results
                childrenEl.querySelectorAll('.se-folder').forEach(folder => {
                    folder.style.display = '';
                    folder.classList.add('open');
                    const folderChildren = folder.nextElementSibling;
                    if (folderChildren && folderChildren.classList.contains('se-children')) {
                        folderChildren.style.display = '';
                        folderChildren.classList.add('open');
                    }
                });
                
                childrenEl.querySelectorAll('.se-item').forEach(item => {
                    item.style.display = '';
                });
            }
        }
    } catch (err) {
        console.error(err);
        if (childrenEl) {
            childrenEl.innerHTML = `<div style="padding: 0.5rem 1rem; font-size: 0.75rem; color: #f43f5e;"><i class="fa-solid fa-circle-exclamation"></i> Error: ${escapeHtml(err.message)}</div>`;
        }
    } finally {
        if (loadBtn) {
            loadBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Muat';
            loadBtn.disabled = false;
        }
    }
}

/**
 * Copy visible tree schema object names list to clipboard
 */
async function copySchemaObjectList() {
    const listContainer = document.getElementById('schema-exp-list');
    if (!listContainer) return;
    
    const visibleItems = listContainer.querySelectorAll('.se-item:not([style*="display: none"])');
    if (visibleItems.length === 0) {
        await uiAlert("Tidak ada daftar objek hasil pencarian untuk disalin!");
        return;
    }
    
    let textContent = "Object Name\tObject Type\n";
    visibleItems.forEach(item => {
        const name = item.getAttribute('title') || item.querySelector('.se-item-name')?.textContent || '';
        let type = "Object";
        const icon = item.querySelector('.se-item-icon');
        if (icon) {
            if (icon.classList.contains('type-table')) type = "TABLE";
            else if (icon.classList.contains('type-view')) type = "VIEW";
            else if (icon.classList.contains('type-procedure')) type = "PROCEDURE";
            else if (icon.classList.contains('type-function')) type = "FUNCTION";
        }
        textContent += `${name}\t${type}\n`;
    });
    
    navigator.clipboard.writeText(textContent)
        .then(async () => {
            await uiAlert(`Daftar objek (${visibleItems.length} item) berhasil disalin ke clipboard!`);
        })
        .catch(async (err) => {
            console.error("Gagal menyalin daftar objek: ", err);
            await uiAlert("Gagal menyalin data: " + err.message);
        });
}

/**
 * Fetch and show DDL schema viewer using appropriate connection parameters from connection key
 */
let schemaViewerActiveCode = "";
let schemaViewerActiveObjName = "";

async function showSchemaDefinition(objName, objType, createDate, modifyDate, serverName = null, dbName = null) {
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
        const sName = serverName || queryConsoleActiveServer;
        const dName = dbName || queryConsoleActiveDatabase;
        const conn = activeConnections[sName] || {
            serverName: queryConsoleActiveServer,
            authType: queryConsoleActiveAuth,
            login: queryConsoleActiveLogin,
            password: queryConsoleActivePassword
        };

        const payload = {
            ServerName: conn.serverName,
            Authentication: conn.authType,
            Login: conn.login,
            Password: conn.password,
            Database: dName,
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
        
        if (schemaViewerEditor) {
            setTimeout(() => {
                schemaViewerEditor.layout();
            }, 210);
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
        return parts[parts.length - 1];
    }
    return clean;
}

function scriptSelectTop50(tableName, serverName = null, dbName = null) {
    const sName = serverName || queryConsoleActiveServer;
    const dName = dbName || queryConsoleActiveDatabase;
    const cleanTName = tableName.trim();
    const query = `SELECT TOP 50 *\nFROM ${cleanTName};`;
    addNewQueryTab(query, `Select_${cleanQueryTableName(cleanTName)}`, sName, dName);
}

async function scriptInsertToTable(tableName, serverName = null, dbName = null) {
    const sName = serverName || queryConsoleActiveServer;
    const dName = dbName || queryConsoleActiveDatabase;
    const cleanTName = tableName.trim();
    
    const columns = await getColumnsForTable(sName, dName, cleanTName);

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

    addNewQueryTab(query, `Insert_${cleanQueryTableName(cleanTName)}`, sName, dName);
}

async function scriptUpdateToTable(tableName, serverName = null, dbName = null) {
    const sName = serverName || queryConsoleActiveServer;
    const dName = dbName || queryConsoleActiveDatabase;
    const cleanTName = tableName.trim();
    
    const columns = await getColumnsForTable(sName, dName, cleanTName);

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

    addNewQueryTab(query, `Update_${cleanQueryTableName(cleanTName)}`, sName, dName);
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
