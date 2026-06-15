/* ============================================================================
   QUERY CONSOLE & SCHEMA TOOLS LOGIC - query.js
   ============================================================================ */

// ── Query Console connection panel and syntax highlighting logic ──
let savedConnectionsCache = [];
let queryConsoleActiveServer = "";
let queryConsoleActiveAuth = "";
let queryConsoleActiveLogin = "";
let queryConsoleActivePassword = "";
let queryConsoleActiveDatabase = "";
let queryConsoleDatabases = [];
let queryConsoleEditor = null;
let queryConsoleEditorInitializing = false;
let monacoSqlCompletionProvider = null;
let schemaDiffEditor = null;
let schemaDiffEditorInitializing = false;
let queryConsoleSchema = { Objects: [], Columns: [] };
let queryConsoleSchemaCache = {};
let queryConsoleActiveTables = [];
let queryConsoleTabs = [];
let queryConsoleActiveTabId = null;
let queryConsoleTabCounter = 0;

function parseConnectionString(connStr) {
    if (!connStr) return {};
    const parts = connStr.split(';');
    const result = {};
    parts.forEach(part => {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) {
            const key = part.substring(0, eqIdx).trim().toLowerCase();
            const val = part.substring(eqIdx + 1).trim();
            result[key] = val;
        }
    });
    return result;
}

function toggleQueryAuthFields() {
    const authType = document.getElementById('query-auth-type').value;
    const credsSection = document.getElementById('query-auth-credentials-section');
    if (authType === 'Windows') {
        credsSection.style.display = 'none';
    } else {
        credsSection.style.display = 'block';
    }
}

async function loadSavedConnections() {
    const select = document.getElementById('query-saved-conn-select');
    if (!select) return;
    
    select.innerHTML = '<option value="">-- Memuat Histori... --</option>';
    
    try {
        const res = await fetch(`${API_BASE}/query/connections`);
        if (!res.ok) throw new Error("Gagal mengambil histori koneksi");
        const connections = await res.json();
        
        savedConnectionsCache = connections || [];
        
        if (savedConnectionsCache.length === 0) {
            select.innerHTML = '<option value="">-- Belum ada Histori --</option>';
            return;
        }
        
        select.innerHTML = '<option value="">-- Pilih Histori --</option>' + 
            savedConnectionsCache.map(conn => `<option value="${conn.Id || conn.id}">${escapeHtml(conn.ConnectionName || conn.connectionName)}</option>`).join('');
    } catch (err) {
        console.error(err);
        select.innerHTML = '<option value="">-- Error memuat Histori --</option>';
    }
}

function prefillSavedConnection() {
    const select = document.getElementById('query-saved-conn-select');
    if (!select) return;
    
    const id = parseInt(select.value);
    const serverInput = document.getElementById('query-server-name');
    const authSelect = document.getElementById('query-auth-type');
    const loginInput = document.getElementById('query-login');
    const passwordInput = document.getElementById('query-password');
    
    if (isNaN(id) || id <= 0) {
        serverInput.value = '';
        authSelect.value = 'SQL';
        loginInput.value = '';
        passwordInput.value = '';
        toggleQueryAuthFields();
        return;
    }
    
    const conn = savedConnectionsCache.find(c => (c.Id || c.id) === id);
    if (!conn) return;
    
    // Clear job selection if using saved connection history
    const jobSelect = document.getElementById('query-conn-job-select');
    if (jobSelect) jobSelect.value = '';
    
    serverInput.value = conn.ServerName || conn.serverName || '';
    authSelect.value = conn.Authentication || conn.authentication || 'SQL';
    loginInput.value = conn.Login || conn.login || '';
    passwordInput.value = conn.Password || conn.password || '';
    
    toggleQueryAuthFields();
}

function toggleSaveConnectionNameField() {
    const checkbox = document.getElementById('query-save-connection');
    const container = document.getElementById('query-save-conn-name-container');
    if (checkbox && container) {
        container.style.display = checkbox.checked ? 'block' : 'none';
        if (checkbox.checked) {
            const connNameInput = document.getElementById('query-connection-name');
            if (connNameInput) {
                const serverName = document.getElementById('query-server-name').value.trim();
                connNameInput.value = serverName ? `Koneksi ${serverName}` : '';
                connNameInput.focus();
            }
        }
    }
}

async function deleteSavedConnectionClick() {
    const select = document.getElementById('query-saved-conn-select');
    if (!select) return;
    
    const id = parseInt(select.value);
    if (isNaN(id) || id <= 0) {
        await uiAlert("Pilih histori koneksi yang ingin dihapus terlebih dahulu!");
        return;
    }
    
    const conn = savedConnectionsCache.find(c => (c.Id || c.id) === id);
    const connName = conn ? (conn.ConnectionName || conn.connectionName) : "koneksi";
    
    if (!(await uiConfirm(`Apakah Anda yakin ingin menghapus "${connName}" dari histori bersama?`))) {
        return;
    }
    
    try {
        const res = await fetch(`${API_BASE}/query/connections/${id}`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error("Gagal menghapus koneksi");
        
        await uiAlert("Koneksi berhasil dihapus dari histori bersama.");
        await loadSavedConnections();
        
        // Reset connection fields
        const serverInput = document.getElementById('query-server-name');
        const authSelect = document.getElementById('query-auth-type');
        const loginInput = document.getElementById('query-login');
        const passwordInput = document.getElementById('query-password');
        
        serverInput.value = '';
        authSelect.value = 'SQL';
        loginInput.value = '';
        passwordInput.value = '';
        toggleQueryAuthFields();
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal menghapus histori koneksi: " + err.message);
    }
}

async function connectQueryConsole(isSilent = false, targetDatabase = null) {
    const serverName = document.getElementById('query-server-name').value.trim();
    const authType = document.getElementById('query-auth-type').value;
    const login = document.getElementById('query-login').value.trim();
    const password = document.getElementById('query-password').value;
    
    if (!serverName) {
        if (!isSilent) await uiAlert("Harap masukkan Server Name!");
        return;
    }
    
    if (authType === 'SQL' && !login) {
        if (!isSilent) await uiAlert("Harap masukkan Login username!");
        return;
    }
    
    const btn = document.getElementById('btn-query-connect');
    let origHtml = "";
    if (btn) {
        origHtml = btn.innerHTML;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Connecting...`;
        btn.disabled = true;
    }
    
    try {
        const payload = {
            ServerName: serverName,
            Authentication: authType,
            Login: login,
            Password: password
        };
        
        const res = await fetch(`${API_BASE}/query/connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) throw new Error("Gagal terhubung: " + await res.text());
        const data = await res.json();
        
        if (!data.Success) {
            throw new Error(data.Message || "Gagal terhubung ke server");
        }
        
        // Save connection to history if checked
        const saveCheck = document.getElementById('query-save-connection');
        const connNameInput = document.getElementById('query-connection-name');
        if (saveCheck && saveCheck.checked && connNameInput && connNameInput.value.trim()) {
            const savePayload = {
                ConnectionName: connNameInput.value.trim(),
                ServerName: serverName,
                Authentication: authType,
                Login: login,
                Password: password
            };
            try {
                const saveRes = await fetch(`${API_BASE}/query/connections`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(savePayload)
                });
                if (saveRes.ok) {
                    await loadSavedConnections();
                    saveCheck.checked = false;
                    connNameInput.value = '';
                    toggleSaveConnectionNameField();
                } else {
                    console.error("Gagal menyimpan histori koneksi ke database config");
                }
            } catch (saveErr) {
                console.error("Gagal menyimpan koneksi:", saveErr);
            }
        }
        
        // Save active connection state
        queryConsoleActiveServer = serverName;
        queryConsoleActiveAuth = authType;
        queryConsoleActiveLogin = login;
        queryConsoleActivePassword = password;
        
        // Determine the database to select
        if (targetDatabase && data.Databases.includes(targetDatabase)) {
            queryConsoleActiveDatabase = targetDatabase;
        } else {
            queryConsoleActiveDatabase = data.DefaultDatabase || "master";
        }
        
        // Save connection state to localStorage
        localStorage.setItem('queryConsoleConnected', 'true');
        localStorage.setItem('queryConsoleServerName', serverName);
        localStorage.setItem('queryConsoleAuthType', authType);
        localStorage.setItem('queryConsoleLogin', login);
        localStorage.setItem('queryConsolePassword', password);
        localStorage.setItem('queryConsoleActiveDatabase', queryConsoleActiveDatabase);
        
        // Populate DB Custom Searchable Dropdown
        renderDatabaseDropdown(data.Databases, queryConsoleActiveDatabase);
        
        // Hide connection panel, show editor panel
        document.getElementById('query-connect-panel').style.display = 'none';
        document.getElementById('query-editor-main-panel').style.display = 'block';
        
        // Set connection badge text
        document.getElementById('query-active-conn-info').textContent = serverName;
        
        // Initialize Monaco Editor
        initMonacoQueryEditor();
        
        // Re-initialize tabs if they were cleared after a disconnect
        if (queryConsoleTabs.length === 0 && queryConsoleEditor) {
            const savedQuery = localStorage.getItem('queryConsoleLastQuery');
            const initialValue = savedQuery !== null ? savedQuery : "SELECT TOP 10 * FROM dbo.Customers ORDER BY Id DESC;";
            
            const model = monaco.editor.createModel(initialValue, 'sql');
            queryConsoleEditor.setModel(model);
            
            queryConsoleTabs = [];
            queryConsoleTabCounter = 1;
            const defaultTab = {
                id: 'query_tab_1',
                name: 'Query 1',
                value: initialValue,
                model: model,
                database: queryConsoleActiveDatabase || "master",
                results: [],
                lastQueryResults: null,
                statusTextHtml: '',
                statusTextColor: '',
                rowsCountText: '',
                resultsContainerHtml: '',
                messagesHtml: '',
                messagesBadgeText: '',
                messagesBadgeDisplay: 'none',
                activeConsoleTab: 'results',
                activeSubResultTabIdx: 0,
                isResultsBoxVisible: false
            };
            queryConsoleTabs.push(defaultTab);
            queryConsoleActiveTabId = 'query_tab_1';
            
            renderQueryTabs();
        }
        
        // Load initial autocomplete schema
        await loadQueryConsoleSchema();
    } catch (err) {
        if (!isSilent) {
            await uiAlert("Koneksi Gagal: " + err.message);
        } else {
            console.error("Auto-connect failed:", err.message);
            disconnectQueryConsole();
        }
    } finally {
        if (btn) {
            btn.innerHTML = origHtml;
            btn.disabled = false;
        }
    }
}

async function loadQueryConsoleSchema(forceRefresh = false) {
    const db = queryConsoleActiveDatabase;
    
    if (!forceRefresh && queryConsoleSchemaCache[db]) {
        queryConsoleSchema = queryConsoleSchemaCache[db];
        return;
    }

    const loader = document.getElementById('query-schema-loader');
    if (loader) loader.style.display = 'inline-block';
    
    try {
        const payload = {
            ServerName: queryConsoleActiveServer,
            Authentication: queryConsoleActiveAuth,
            Login: queryConsoleActiveLogin,
            Password: queryConsoleActivePassword,
            Database: queryConsoleActiveDatabase
        };
        
        const res = await fetch(`${API_BASE}/query/schema`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) throw new Error("Gagal mengambil skema database");
        queryConsoleSchema = await res.json();
        queryConsoleSchemaCache[db] = queryConsoleSchema;
        console.log("Database schema autocomplete reloaded for:", db);
    } catch (err) {
        console.error("Gagal memuat autocomplete:", err);
    } finally {
        if (loader) loader.style.display = 'none';
    }
}

async function changeQueryDatabase() {
    // Reload autocomplete schema for this database
    await loadQueryConsoleSchema();
}

function toggleDatabaseDropdown(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('query-db-dropdown');
    if (!dropdown) return;
    const isVisible = dropdown.style.display === 'block';
    dropdown.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
        const searchInput = document.getElementById('query-db-search');
        if (searchInput) {
            searchInput.value = '';
            filterDatabaseList('');
            searchInput.focus();
        }
    }
}

function renderDatabaseDropdown(databases, selectedDb) {
    queryConsoleDatabases = databases || [];
    queryConsoleActiveDatabase = selectedDb || "master";
    
    // Update hidden input compatibility
    const dbSelect = document.getElementById('query-db-select');
    if (dbSelect) {
        dbSelect.value = queryConsoleActiveDatabase;
    }
    
    // Update trigger text
    const triggerText = document.getElementById('query-db-trigger-text');
    if (triggerText) {
        triggerText.textContent = queryConsoleActiveDatabase;
    }
    
    // Clear search input
    const searchInput = document.getElementById('query-db-search');
    if (searchInput) {
        searchInput.value = '';
    }
    
    // Render list items
    filterDatabaseList('');
}

let queryConsoleDbNavIndex = -1;

function handleDbDropdownKeydown(e) {
    const listContainer = document.getElementById('query-db-list');
    if (!listContainer) return;
    const items = listContainer.querySelectorAll('.db-item');
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        queryConsoleDbNavIndex++;
        if (queryConsoleDbNavIndex >= items.length) queryConsoleDbNavIndex = items.length - 1;
        updateDbDropdownHighlight(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        queryConsoleDbNavIndex--;
        if (queryConsoleDbNavIndex < 0) queryConsoleDbNavIndex = 0;
        updateDbDropdownHighlight(items);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (queryConsoleDbNavIndex >= 0 && queryConsoleDbNavIndex < items.length) {
            items[queryConsoleDbNavIndex].click();
        }
    }
}

function updateDbDropdownHighlight(items) {
    items.forEach((item, idx) => {
        if (idx === queryConsoleDbNavIndex) {
            item.classList.add('nav-highlight');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('nav-highlight');
        }
    });
}

function filterDatabaseList(searchQuery) {
    const listContainer = document.getElementById('query-db-list');
    if (!listContainer) return;
    
    queryConsoleDbNavIndex = -1;

    const query = (searchQuery || '').toLowerCase().trim();
    const filtered = queryConsoleDatabases.filter(db => db.toLowerCase().includes(query));
    
    if (filtered.length === 0) {
        listContainer.innerHTML = `<div style="padding: 0.5rem; font-size: 0.8rem; color: var(--text-muted); text-align: center;">Tidak ditemukan</div>`;
        return;
    }
    
    listContainer.innerHTML = filtered.map(db => {
        const isSelected = db === queryConsoleActiveDatabase;
        return `
            <div class="db-item ${isSelected ? 'selected' : ''}" 
                 onclick="selectDatabase('${escapeHtml(db)}')" 
                 title="${escapeHtml(db)}">
                ${escapeHtml(db)}
            </div>
        `;
    }).join('');
}

async function selectDatabase(dbName) {
    queryConsoleActiveDatabase = dbName;
    
    // Save to active tab
    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (activeTab) {
        activeTab.database = dbName;
    }
    
    // Update trigger text
    const triggerText = document.getElementById('query-db-trigger-text');
    if (triggerText) {
        triggerText.textContent = dbName;
    }
    
    // Update hidden input compatibility
    const dbSelect = document.getElementById('query-db-select');
    if (dbSelect) {
        dbSelect.value = dbName;
    }
    
    // Save to localStorage
    localStorage.setItem('queryConsoleActiveDatabase', dbName);
    
    // Close dropdown
    const dropdown = document.getElementById('query-db-dropdown');
    if (dropdown) {
        dropdown.style.display = 'none';
    }
    
    // Reload autocomplete schema for this database
    await changeQueryDatabase();
}

function disconnectQueryConsole() {
    queryConsoleActiveServer = "";
    queryConsoleActiveAuth = "";
    queryConsoleActiveLogin = "";
    queryConsoleActivePassword = "";
    queryConsoleActiveDatabase = "";
    queryConsoleDatabases = [];
    queryConsoleSchema = { Objects: [], Columns: [] };
    queryConsoleSchemaCache = {};
    
    // Clear all tab models to avoid memory leaks
    if (queryConsoleTabs && queryConsoleTabs.length > 0) {
        queryConsoleTabs.forEach(tab => {
            if (tab.model) {
                try {
                    tab.model.dispose();
                } catch (e) {
                    console.error("Error disposing model on disconnect:", e);
                }
            }
        });
    }
    queryConsoleTabs = [];
    queryConsoleActiveTabId = null;
    queryConsoleTabCounter = 0;

    // Clear UI tabs list
    const listContainer = document.getElementById('query-tabs-list');
    if (listContainer) listContainer.innerHTML = '';
    
    // Clear LocalStorage connection values
    localStorage.removeItem('queryConsoleConnected');
    localStorage.removeItem('queryConsoleServerName');
    localStorage.removeItem('queryConsoleAuthType');
    localStorage.removeItem('queryConsoleLogin');
    localStorage.removeItem('queryConsolePassword');
    localStorage.removeItem('queryConsoleActiveDatabase');
    localStorage.removeItem('queryConsoleLastQuery');
    
    // Reset selectors & inputs
    const jobSelect = document.getElementById('query-conn-job-select');
    if (jobSelect) jobSelect.value = '';
    const savedSelect = document.getElementById('query-saved-conn-select');
    if (savedSelect) savedSelect.value = '';
    const saveCheck = document.getElementById('query-save-connection');
    if (saveCheck) saveCheck.checked = false;
    const connNameInput = document.getElementById('query-connection-name');
    if (connNameInput) connNameInput.value = '';
    const saveContainer = document.getElementById('query-save-conn-name-container');
    if (saveContainer) saveContainer.style.display = 'none';
    
    document.getElementById('query-connect-panel').style.display = 'block';
    document.getElementById('query-editor-main-panel').style.display = 'none';
    document.getElementById('query-active-conn-info').textContent = "Belum terhubung";

    const schemaExpList = document.getElementById('schema-exp-list');
    if (schemaExpList) {
        schemaExpList.innerHTML = `<div style="padding: 1.5rem; font-size: 0.8rem; color: var(--text-muted); text-align: center;">Hubungkan database dan klik Cari untuk memuat daftar objek skema.</div>`;
    }
}

// Add global click listener to close dropdown on clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('query-db-dropdown');
    const trigger = document.getElementById('query-db-trigger');
    if (dropdown && dropdown.style.display === 'block') {
        if (!dropdown.contains(e.target) && !trigger.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    }
    
    const tableDropdown = document.getElementById('query-table-dropdown');
    const tableTrigger = document.getElementById('query-table-trigger');
    if (tableDropdown && tableDropdown.style.display === 'block') {
        if (!tableDropdown.contains(e.target) && !tableTrigger.contains(e.target)) {
            tableDropdown.style.display = 'none';
        }
    }
});

// ── Query Console Tab Management Functions ──────────────────────────────────
function addNewQueryTab(initialValue = '', tabName = '') {
    if (!queryConsoleEditor) {
        console.warn("Monaco editor is not initialized yet.");
        return;
    }

    queryConsoleTabCounter++;
    const tabId = 'query_tab_' + queryConsoleTabCounter;
    
    // Fallback to default template query if no initialValue is provided
    let queryValue = initialValue;
    if (!queryValue) {
        // If it's the very first tab, try loading from localStorage
        if (queryConsoleTabs.length === 0) {
            const savedQuery = localStorage.getItem('queryConsoleLastQuery');
            queryValue = savedQuery !== null ? savedQuery : "SELECT TOP 10 * FROM dbo.Customers ORDER BY Id DESC;";
        } else {
            queryValue = "SELECT TOP 10 * FROM dbo.Customers ORDER BY Id DESC;";
        }
    }

    // Create a new Monaco model for this tab
    const model = monaco.editor.createModel(queryValue, 'sql');

    const newTab = {
        id: tabId,
        name: tabName || `Query ${queryConsoleTabCounter}`,
        value: queryValue,
        model: model,
        database: queryConsoleActiveDatabase || "master",
        results: [],
        lastQueryResults: null,
        statusTextHtml: '',
        statusTextColor: '',
        rowsCountText: '',
        resultsContainerHtml: '',
        messagesHtml: '',
        messagesBadgeText: '',
        messagesBadgeDisplay: 'none',
        activeConsoleTab: 'results',
        activeSubResultTabIdx: 0,
        isResultsBoxVisible: false
    };

    queryConsoleTabs.push(newTab);
    switchQueryTabActive(tabId);
}

function switchQueryTabActive(tabId) {
    if (!queryConsoleEditor) return;

    const currentActiveTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (currentActiveTab) {
        // Save current UI state
        currentActiveTab.value = queryConsoleEditor.getValue();
        const resultsBox = document.getElementById('query-results-box');
        const resultsContainer = document.getElementById('query-results-container');
        const statusText = document.getElementById('query-status-text');
        const rowsCount = document.getElementById('query-rows-count');
        const msgContent = document.getElementById('query-messages-content');
        const badge = document.getElementById('query-tab-messages-badge');

        currentActiveTab.isResultsBoxVisible = resultsBox && resultsBox.style.display !== 'none';
        if (statusText) {
            currentActiveTab.statusTextHtml = statusText.innerHTML;
            currentActiveTab.statusTextColor = statusText.style.color || '';
        }
        if (rowsCount) currentActiveTab.rowsCountText = rowsCount.innerHTML;
        if (resultsContainer) currentActiveTab.resultsContainerHtml = resultsContainer.innerHTML;
        if (msgContent) currentActiveTab.messagesHtml = msgContent.innerHTML;
        
        if (badge) {
            currentActiveTab.messagesBadgeText = badge.textContent || '';
            currentActiveTab.messagesBadgeDisplay = badge.style.display || 'none';
        }
    }

    const nextActiveTab = queryConsoleTabs.find(t => t.id === tabId);
    if (!nextActiveTab) return;

    queryConsoleActiveTabId = tabId;

    // Restore database selection for this tab
    if (nextActiveTab.database) {
        const prevDb = queryConsoleActiveDatabase;
        queryConsoleActiveDatabase = nextActiveTab.database;
        
        // Update trigger text in dropdown UI
        const triggerText = document.getElementById('query-db-trigger-text');
        if (triggerText) {
            triggerText.textContent = queryConsoleActiveDatabase;
        }
        // Update hidden select input
        const dbSelect = document.getElementById('query-db-select');
        if (dbSelect) {
            dbSelect.value = queryConsoleActiveDatabase;
        }
        localStorage.setItem('queryConsoleActiveDatabase', queryConsoleActiveDatabase);
        
        // Reload schema for Monaco autocomplete asynchronously ONLY if db changed
        if (prevDb !== queryConsoleActiveDatabase) {
            loadQueryConsoleSchema();
        }
    }

    // Swap model in Monaco Editor
    queryConsoleEditor.setModel(nextActiveTab.model);

    // Restore UI elements from tab state
    const resultsBox = document.getElementById('query-results-box');
    const resultsContainer = document.getElementById('query-results-container');
    const statusText = document.getElementById('query-status-text');
    const rowsCount = document.getElementById('query-rows-count');
    const msgContent = document.getElementById('query-messages-content');
    const badge = document.getElementById('query-tab-messages-badge');

    if (resultsBox) {
        resultsBox.style.display = nextActiveTab.isResultsBoxVisible ? 'block' : 'none';
    }
    if (statusText) {
        statusText.innerHTML = nextActiveTab.statusTextHtml || 'Tekan Jalankan SQL untuk mengeksekusi';
        statusText.style.color = nextActiveTab.statusTextColor || 'var(--text-muted)';
    }
    if (rowsCount) {
        rowsCount.innerHTML = nextActiveTab.rowsCountText || '';
    }
    if (resultsContainer) {
        resultsContainer.innerHTML = nextActiveTab.resultsContainerHtml || '';
    }
    if (msgContent) {
        msgContent.innerHTML = nextActiveTab.messagesHtml || '';
    }
    if (badge) {
        badge.textContent = nextActiveTab.messagesBadgeText || '';
        badge.style.display = nextActiveTab.messagesBadgeDisplay || 'none';
    }

    // Sync global cache variables
    window.queryConsoleAllResults = nextActiveTab.results || [];
    window.lastQueryResults = nextActiveTab.lastQueryResults || null;

    // Restore results vs messages tab active selection
    switchQueryResultsTab(nextActiveTab.activeConsoleTab || 'results');

    // Restore active sub-tab for multi-result sets
    if (nextActiveTab.results && nextActiveTab.results.length > 1) {
        const subIdx = nextActiveTab.activeSubResultTabIdx || 0;
        // Apply active class to sub tab button
        document.querySelectorAll('.query-tab-btn').forEach(btn => {
            if (parseInt(btn.getAttribute('data-tab-idx')) === subIdx) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        // Show active grid, hide others
        document.querySelectorAll('.query-grid-wrapper').forEach(wrapper => {
            const idStr = `query-grid-wrapper-${subIdx}`;
            if (wrapper.id === idStr) {
                wrapper.style.display = 'block';
            } else {
                wrapper.style.display = 'none';
            }
        });
    }

    // Refresh layout and focus
    setTimeout(() => {
        queryConsoleEditor.layout();
        queryConsoleEditor.focus();
    }, 50);

    renderQueryTabs();
}

function closeQueryTab(tabId, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    if (queryConsoleTabs.length <= 1) {
        uiAlert("Tidak dapat menutup tab terakhir! Silakan buat tab baru terlebih dahulu.");
        return;
    }

    const targetIdx = queryConsoleTabs.findIndex(t => t.id === tabId);
    if (targetIdx === -1) return;

    const tabToClose = queryConsoleTabs[targetIdx];

    // Dispose model
    if (tabToClose.model) {
        try {
            tabToClose.model.dispose();
        } catch(e) {
            console.error("Error disposing model:", e);
        }
    }

    // Remove from array
    queryConsoleTabs.splice(targetIdx, 1);

    // If closing active tab, switch to another
    if (queryConsoleActiveTabId === tabId) {
        const nextActiveIdx = Math.max(0, targetIdx - 1);
        const nextActiveTab = queryConsoleTabs[nextActiveIdx];
        switchQueryTabActive(nextActiveTab.id);
    } else {
        renderQueryTabs();
    }
}

function renderQueryTabs() {
    const listContainer = document.getElementById('query-tabs-list');
    if (!listContainer) return;

    listContainer.innerHTML = queryConsoleTabs.map(tab => {
        const isActive = tab.id === queryConsoleActiveTabId;
        return `
            <div class="query-console-tab ${isActive ? 'active' : ''}" onclick="switchQueryTabActive('${tab.id}')" ondblclick="renameQueryTab('${tab.id}')" title="Klik dua kali untuk mengubah nama tab">
                <i class="fa-solid fa-code" style="font-size: 0.75rem; opacity: 0.8;"></i>
                <span>${escapeHtml(tab.name)}</span>
                <span class="query-console-tab-close" onclick="closeQueryTab('${tab.id}', event)" title="Tutup Tab">
                    <i class="fa-solid fa-xmark"></i>
                </span>
            </div>
        `;
    }).join('');
}

async function renameQueryTab(tabId) {
    const tab = queryConsoleTabs.find(t => t.id === tabId);
    if (!tab) return;

    const newName = await uiPrompt(`Ubah nama tab kueri:`, {
        title: "Ubah Nama Tab",
        defaultValue: tab.name,
        placeholder: "Contoh: Cari Transaksi"
    });

    if (newName && newName.trim()) {
        tab.name = newName.trim();
        renderQueryTabs();
    }
}

function saveQueryRunResult(tabId, data) {
    const tab = queryConsoleTabs.find(t => t.id === tabId);
    if (!tab) return;

    tab.results = data.results;
    tab.lastQueryResults = data.lastQueryResults;
    tab.isResultsBoxVisible = data.isResultsBoxVisible;
    tab.statusTextHtml = data.statusTextHtml;
    tab.statusTextColor = data.statusTextColor;
    tab.rowsCountText = data.rowsCountText;
    tab.resultsContainerHtml = data.resultsContainerHtml;
    tab.messagesHtml = data.messagesHtml;
    tab.messagesBadgeText = data.messagesBadgeText;
    tab.messagesBadgeDisplay = data.messagesBadgeDisplay;
    tab.activeConsoleTab = data.activeConsoleTab || 'results';
    tab.activeSubResultTabIdx = 0;
}

function getQueryMessagesHtml(messages, executionTimeMs, isError) {
    const timestamp = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let html = '';
    if (messages && messages.length > 0) {
        messages.forEach(msg => {
            const color = isError ? '#f87171' : '#e2e8f0';
            const icon = isError 
                ? '<span style="color:#f87171;">⊗</span> ' 
                : '<span style="color:#6ee7b7;">ℹ</span> ';
            html += `<div style="color: ${color}; padding: 1px 0;">${icon}${escapeHtml(msg)}</div>`;
        });
    }
    if (executionTimeMs !== undefined && executionTimeMs !== null) {
        html += `<div style="color: var(--text-muted); margin-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 0.4rem; font-size: 0.78rem;">── Selesai pada ${timestamp} (${executionTimeMs}ms) ──</div>`;
    }
    return html || `<span style="color: var(--text-muted); font-style: italic;">Tidak ada pesan.</span>`;
}

// Global keyboard shortcuts listener for Tab Management
document.addEventListener('keydown', (e) => {
    // Only handle shortcuts when connected
    if (!queryConsoleActiveServer) return;
    const queryTab = document.getElementById('main-screen-query');
    if (queryTab && queryTab.style.display === 'none') return;

    // Ctrl + Alt + T: New Query Tab
    if (e.ctrlKey && e.altKey && (e.code === 'KeyT' || e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        addNewQueryTab();
    }
    // Ctrl + Alt + W: Close Active Query Tab
    if (e.ctrlKey && e.altKey && (e.code === 'KeyW' || e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        closeQueryTab(queryConsoleActiveTabId);
    }
    // Ctrl + PageUp: Switch to previous tab
    if (e.ctrlKey && e.key === 'PageUp') {
        e.preventDefault();
        const idx = queryConsoleTabs.findIndex(t => t.id === queryConsoleActiveTabId);
        if (idx > 0) {
            switchQueryTabActive(queryConsoleTabs[idx - 1].id);
        }
    }
    // Ctrl + PageDown: Switch to next tab
    if (e.ctrlKey && e.key === 'PageDown') {
        e.preventDefault();
        const idx = queryConsoleTabs.findIndex(t => t.id === queryConsoleActiveTabId);
        if (idx >= 0 && idx < queryConsoleTabs.length - 1) {
            switchQueryTabActive(queryConsoleTabs[idx + 1].id);
        }
    }
});




function initMonacoQueryEditor() {
    if (queryConsoleEditor) {
        // Refresh layout if editor already exists
        setTimeout(() => {
            queryConsoleEditor.layout();
        }, 50);
        return;
    }

    if (queryConsoleEditorInitializing) {
        return;
    }

    if (typeof require === 'undefined') {
        console.error("Monaco loader is not loaded yet.");
        return;
    }

    queryConsoleEditorInitializing = true;

    require.config({ paths: { vs: 'lib/monaco-editor/min/vs' } });
    
    require(['vs/editor/editor.main'], function() {
        queryConsoleEditorInitializing = false;

        // Double check in case it was created concurrently
        if (queryConsoleEditor) return;

        const container = document.getElementById('query-editor');
        if (!container) return;

        // Double check if the container has already been initialized with Monaco child nodes
        if (container.firstElementChild) {
            console.warn("Monaco editor container already populated.");
            return;
        }

        const savedQuery = localStorage.getItem('queryConsoleLastQuery');
        const initialValue = savedQuery !== null ? savedQuery : "SELECT TOP 10 * FROM dbo.Customers ORDER BY Id DESC;";

        const initialModel = monaco.editor.createModel(initialValue, 'sql');

        queryConsoleEditor = monaco.editor.create(container, {
            model: initialModel,
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'Consolas, Monaco, monospace',
            lineHeight: 18,
            padding: { top: 8, bottom: 8 }
        });

        // Initialize tabs state
        queryConsoleTabs = [];
        queryConsoleTabCounter = 1;
        const defaultTab = {
            id: 'query_tab_1',
            name: 'Query 1',
            value: initialValue,
            model: initialModel,
            database: queryConsoleActiveDatabase || "master",
            results: [],
            lastQueryResults: null,
            statusTextHtml: '',
            statusTextColor: '',
            rowsCountText: '',
            resultsContainerHtml: '',
            messagesHtml: '',
            messagesBadgeText: '',
            messagesBadgeDisplay: 'none',
            activeConsoleTab: 'results',
            activeSubResultTabIdx: 0,
            isResultsBoxVisible: false
        };
        queryConsoleTabs.push(defaultTab);
        queryConsoleActiveTabId = 'query_tab_1';

        // Render tab headers
        renderQueryTabs();

        // Setup vertical resizer for query editor
        const resizer = document.getElementById('query-editor-resizer');
        const editorDiv = document.getElementById('query-editor');
        if (resizer && editorDiv) {
            let startY, startHeight;
            const onMouseMove = (e) => {
                let newHeight = startHeight + e.clientY - startY;
                if (newHeight < 150) newHeight = 150;
                if (newHeight > 1200) newHeight = 1200;
                editorDiv.style.height = newHeight + 'px';
            };
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                resizer.style.background = '#111520';
            };
            resizer.addEventListener('mousedown', (e) => {
                startY = e.clientY;
                startHeight = editorDiv.offsetHeight;
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
                resizer.style.background = 'rgba(20, 184, 166, 0.25)';
                e.preventDefault();
            });
        }

        // Listen for content changes to auto-save to active tab and localStorage
        queryConsoleEditor.onDidChangeModelContent(() => {
            const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
            if (activeTab) {
                activeTab.value = queryConsoleEditor.getValue();
                localStorage.setItem('queryConsoleLastQuery', activeTab.value);
            }
        });

        // Register custom SQL autocomplete provider
        registerMonacoSqlAutocomplete();
        
        // Add shortcut key (Ctrl+Enter) to run query console
        queryConsoleEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function() {
            runQueryConsole();
        });

        // Add tab management command shortcuts inside Monaco Editor
        queryConsoleEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.US_T, function() {
            addNewQueryTab();
        });
        queryConsoleEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.US_W, function() {
            closeQueryTab(queryConsoleActiveTabId);
        });
        queryConsoleEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.PageUp, function() {
            const idx = queryConsoleTabs.findIndex(t => t.id === queryConsoleActiveTabId);
            if (idx > 0) {
                switchQueryTabActive(queryConsoleTabs[idx - 1].id);
            }
        });
        queryConsoleEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.PageDown, function() {
            const idx = queryConsoleTabs.findIndex(t => t.id === queryConsoleActiveTabId);
            if (idx >= 0 && idx < queryConsoleTabs.length - 1) {
                switchQueryTabActive(queryConsoleTabs[idx + 1].id);
            }
        });
    });
}

function registerMonacoSqlAutocomplete() {
    if (monacoSqlCompletionProvider) return; // Prevent double registration

    function cleanTableName(name) {
        if (!name) return "";
        let clean = name.replace(/[\[\]]/g, ""); // Remove brackets
        if (clean.includes('.')) {
            const parts = clean.split('.');
            return parts[parts.length - 1]; // Return the last part
        }
        return clean;
    }

    function getReferencedTables(queryText) {
        const tables = [];
        const fromJoinRegex = /(?:from|join)\s+([a-zA-Z0-9_\[\]\.]+)(?:\s+(?:as\s+)?([a-zA-Z0-9_]+))?/gi;
        let match;
        while ((match = fromJoinRegex.exec(queryText)) !== null) {
            const tableName = match[1];
            const alias = match[2];
            const isDuplicate = tables.some(t => 
                cleanTableName(t.tableName).toLowerCase() === cleanTableName(tableName).toLowerCase() && 
                (t.alias || '').toLowerCase() === (alias || '').toLowerCase()
            );
            if (!isDuplicate) {
                tables.push({
                    tableName: tableName,
                    alias: alias || null
                });
            }
        }
        return tables;
    }

    function getCurrentStatement(model, position) {
        const lines = model.getLinesContent();
        const lineCount = model.getLineCount();
        const cursorLine = position.lineNumber;
        
        let startLine = cursorLine;
        while (startLine > 1) {
            const line = lines[startLine - 2];
            if (line.toLowerCase().includes('select') && !line.trim().startsWith('--')) {
                break;
            }
            if (line.includes(';')) {
                break;
            }
            startLine--;
        }
        
        let endLine = cursorLine;
        while (endLine < lineCount) {
            const line = lines[endLine];
            if (line.includes(';')) {
                break;
            }
            if (line.toLowerCase().includes('select') && !line.trim().startsWith('--')) {
                break;
            }
            endLine++;
        }
        
        return lines.slice(startLine - 1, endLine).join('\n');
    }

    const sqlKeywordsList = [
        "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "JOIN", "ON",
        "ORDER BY", "GROUP BY", "IN", "AND", "OR", "AS", "INTO", "VALUES", "SET",
        "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "CROSS JOIN", "TOP", "DISTINCT", 
        "COUNT", "SUM", "AVG", "MIN", "MAX", "HAVING", "LIKE", "IS NULL", "IS NOT NULL"
    ];

    monacoSqlCompletionProvider = monaco.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: ['.', '*'],
        provideCompletionItems: function(model, position) {
            const textUntilPosition = model.getValueInRange({
                startLineNumber: position.lineNumber,
                startColumn: 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column
            });
            // Check if cursor is right after '*' (wildcard)
            const matchAsterisk = textUntilPosition.match(/\*\s*$/);
            if (matchAsterisk) {
                const fullQuery = model.getValue();
                const currentQuery = getCurrentStatement(model, position);
                const tables = getReferencedTables(currentQuery);
                if (tables.length > 0 && queryConsoleSchema && queryConsoleSchema.Columns) {
                    const expandedColumns = [];
                    tables.forEach(t => {
                        const cleanTName = cleanTableName(t.tableName);
                        const columns = queryConsoleSchema.Columns.filter(c => {
                            const cTable = cleanTableName(c.TableName || c.tableName);
                            return cTable.toLowerCase() === cleanTName.toLowerCase();
                        });

                        columns.forEach(c => {
                            const colName = c.ColumnName || c.columnName;
                            if (t.alias) {
                                expandedColumns.push(`${t.alias}.[${colName}]`);
                            } else {
                                if (tables.length > 1) {
                                    expandedColumns.push(`${cleanTName}.[${colName}]`);
                                } else {
                                    expandedColumns.push(`[${colName}]`);
                                }
                            }
                        });
                    });

                    if (expandedColumns.length > 0) {
                        const insertText = expandedColumns.join(', ');
                        const tablesList = tables.map(t => t.tableName + (t.alias ? ' ' + t.alias : '')).join(', ');
                        
                        return {
                            suggestions: [{
                                label: `* (Expand to columns of ${tablesList})`,
                                kind: monaco.languages.CompletionItemKind.Snippet,
                                detail: `Expand asterisk wildcard`,
                                documentation: `Replaces * with:\n${insertText}`,
                                insertText: insertText,
                                range: new monaco.Range(
                                    position.lineNumber,
                                    position.column - 1,
                                    position.lineNumber,
                                    position.column
                                )
                            }]
                        };
                    }
                }
            }

            // Check if user is typing table.column notation (e.g. Customers. or Customers.Name)
            const matchDot = textUntilPosition.match(/([\w\[\]\.]+)\.$/);
            
            if (matchDot) {
                const fullPrefix = matchDot[1].replace(/[\[\]]/g, '').toLowerCase();
                const parts = fullPrefix.split('.');
                const tableName = parts[parts.length - 1];
                
                if (queryConsoleSchema && queryConsoleSchema.Columns) {
                    const tableColumns = queryConsoleSchema.Columns.filter(c => {
                        const cTable = (c.TableName || c.tableName || '').replace(/[\[\]]/g, '').toLowerCase();
                        return cTable === tableName || (parts.length > 1 && cTable === fullPrefix);
                    });

                    const suggestions = tableColumns.map(c => {
                        const name = c.ColumnName || c.columnName;
                        const dataType = c.DataType || c.dataType || 'column';
                        return {
                            label: name,
                            kind: monaco.languages.CompletionItemKind.Field,
                            detail: dataType,
                            insertText: name
                        };
                    });

                    return { suggestions: suggestions };
                }
            }

            // General suggestions (Keywords, Tables, Views, Generic Columns)
            const suggestions = [];

            // 1. Keywords
            sqlKeywordsList.forEach(kw => {
                suggestions.push({
                    label: kw,
                    kind: monaco.languages.CompletionItemKind.Keyword,
                    insertText: kw
                });
            });

            // 2. Tables & Views
            if (queryConsoleSchema && queryConsoleSchema.Objects) {
                queryConsoleSchema.Objects.forEach(obj => {
                    const name = obj.Name || obj.name;
                    const type = (obj.Type || obj.type || 'TABLE').toUpperCase();
                    let kind = monaco.languages.CompletionItemKind.Class;
                    if (type === 'VIEW') kind = monaco.languages.CompletionItemKind.Interface;
                    else if (type === 'PROCEDURE') kind = monaco.languages.CompletionItemKind.Method;
                    else if (type === 'FUNCTION') kind = monaco.languages.CompletionItemKind.Function;

                    suggestions.push({
                        label: name,
                        kind: kind,
                        detail: type,
                        insertText: name
                    });
                });
            }

            // 3. Generic Columns
            if (queryConsoleSchema && queryConsoleSchema.Columns) {
                const uniqueCols = new Set();
                queryConsoleSchema.Columns.forEach(c => {
                    const colName = c.ColumnName || c.columnName;
                    if (colName) uniqueCols.add(colName);
                });
                
                uniqueCols.forEach(colName => {
                    suggestions.push({
                        label: colName,
                        kind: monaco.languages.CompletionItemKind.Field,
                        detail: 'Column',
                        insertText: colName
                    });
                });
            }

            return { suggestions: suggestions };
        }
    });
}

// ── Schema Comparison Mock Logic & Diff Viewer ──────────────────────────────
const schemaDummyDdl = {
    "dbo.Customers": {
        source: `CREATE TABLE dbo.Customers (
    Id INT PRIMARY KEY IDENTITY(1,1),
    CustomerName VARCHAR(100) NOT NULL,
    EmailAddress VARCHAR(255) NULL, -- BARU (Ditambahkan di Source)
    Balance DECIMAL(18,2) DEFAULT 0,
    IsActive BIT DEFAULT 1,
    CreatedAt DATETIME DEFAULT GETDATE()
);`,
        target: `CREATE TABLE dbo.Customers (
    Id INT PRIMARY KEY IDENTITY(1,1),
    CustomerName VARCHAR(100) NOT NULL,
    -- EmailAddress KOLOM HILANG DI SINI!
    Balance DECIMAL(18,2) DEFAULT 0,
    IsActive BIT DEFAULT 1,
    CreatedAt DATETIME DEFAULT GETDATE()
);`,
        sourceHighlights: { 3: "diff-added" },
        targetHighlights: { 3: "diff-deleted" }
    },
    "dbo.Orders": {
        source: `CREATE TABLE dbo.Orders (
    OrderId INT PRIMARY KEY IDENTITY(100,1),
    CustomerId INT NOT NULL,
    OrderDate DATETIME DEFAULT GETDATE(),
    TotalAmount DECIMAL(18,2) DEFAULT 0,
    PromoCode VARCHAR(50) NULL, -- BARU (Ditambahkan di Source)
    Status VARCHAR(20) DEFAULT 'PENDING'
);`,
        target: `CREATE TABLE dbo.Orders (
    OrderId INT PRIMARY KEY IDENTITY(100,1),
    CustomerId INT NOT NULL,
    OrderDate DATETIME DEFAULT GETDATE(),
    TotalAmount DECIMAL(18,2) DEFAULT 0,
    -- PromoCode KOLOM HILANG DI SINI!
    Status VARCHAR(20) DEFAULT 'PENDING'
);`,
        sourceHighlights: { 5: "diff-added" },
        targetHighlights: { 5: "diff-deleted" }
    },
    "dbo.sp_GetCustomerReport": {
        source: `CREATE PROCEDURE dbo.sp_GetCustomerReport
AS
BEGIN
    SET NOCOUNT ON;
    -- Menggunakan query baru dengan performa teroptimasi
    SELECT c.Id, c.CustomerName, c.EmailAddress, 
           ISNULL(SUM(o.TotalAmount), 0) AS TotalSpent
    FROM dbo.Customers c
    LEFT JOIN dbo.Orders o ON c.Id = o.CustomerId
    WHERE c.IsActive = 1
    GROUP BY c.Id, c.CustomerName, c.EmailAddress;
END;`,
        target: `CREATE PROCEDURE dbo.sp_GetCustomerReport
AS
BEGIN
    SET NOCOUNT ON;
    -- Query lama lambat tanpa filter IsActive & field EmailAddress
    SELECT c.Id, c.CustomerName, 
           ISNULL(SUM(o.TotalAmount), 0) AS TotalSpent
    FROM dbo.Customers c
    LEFT JOIN dbo.Orders o ON c.Id = o.CustomerId
    GROUP BY c.Id, c.CustomerName;
END;`,
        sourceHighlights: { 5: "diff-added", 6: "diff-added", 9: "diff-added" },
        targetHighlights: { 5: "diff-deleted", 8: "diff-deleted" }
    },
    "dbo.fn_CalculateTax": {
        source: `CREATE FUNCTION dbo.fn_CalculateTax (
    @Amount DECIMAL(18,2),
    @TaxRate DECIMAL(5,2)
)
RETURNS DECIMAL(18,2)
AS
BEGIN
    RETURN @Amount * (@TaxRate / 100.0);
END;`,
        target: `-- Objek tidak ditemukan di Target DB --`,
        sourceHighlights: { 0: "diff-added", 1: "diff-added", 2: "diff-added", 3: "diff-added", 4: "diff-added", 5: "diff-added", 6: "diff-added", 7: "diff-added", 8: "diff-added", 9: "diff-added" },
        targetHighlights: { 0: "diff-deleted" }
    },
    "dbo.CustomerAddresses": {
        source: `CREATE TABLE dbo.CustomerAddresses (
    AddressId INT PRIMARY KEY IDENTITY(1,1),
    CustomerId INT NOT NULL,
    StreetAddress VARCHAR(255) NOT NULL,
    City VARCHAR(100) NOT NULL,
    PostalCode VARCHAR(20) NULL
);`,
        target: `-- Objek tidak ditemukan di Target DB --`,
        sourceHighlights: { 0: "diff-added", 1: "diff-added", 2: "diff-added", 3: "diff-added", 4: "diff-added", 5: "diff-added" },
        targetHighlights: { 0: "diff-deleted" }
    },
    "dbo.InventoryLogs": {
        source: `CREATE TABLE dbo.InventoryLogs (
    LogId INT PRIMARY KEY IDENTITY(1,1),
    ProductId INT NOT NULL,
    ChangeQty INT NOT NULL,
    LogDate DATETIME DEFAULT GETDATE()
);`,
        target: `-- Objek tidak ditemukan di Target DB --`,
        sourceHighlights: { 0: "diff-added", 1: "diff-added", 2: "diff-added", 3: "diff-added", 4: "diff-added" },
        targetHighlights: { 0: "diff-deleted" }
    },
    "dbo.SessionTokens": {
        source: `CREATE TABLE dbo.SessionTokens (
    TokenId INT PRIMARY KEY IDENTITY(1,1),
    UserId INT NOT NULL,
    Token VARCHAR(500) NOT NULL,
    ExpiryDate DATETIME NOT NULL
);`,
        target: `-- Objek tidak ditemukan di Target DB --`,
        sourceHighlights: { 0: "diff-added", 1: "diff-added", 2: "diff-added", 3: "diff-added", 4: "diff-added" },
        targetHighlights: { 0: "diff-deleted" }
    },
    "dbo.sp_ProcessOrder": {
        source: `CREATE PROCEDURE dbo.sp_ProcessOrder
    @OrderId INT
AS
BEGIN
    -- Validasi status dan kurangi stock produk
    UPDATE dbo.Products 
    SET Price = Price * 0.95 -- Diskon otomatis saat proses
    WHERE ProductId IN (SELECT ProductId FROM dbo.Orders WHERE OrderId = @OrderId);
END;`,
        target: `CREATE PROCEDURE dbo.sp_ProcessOrder
    @OrderId INT
AS
BEGIN
    -- Query lama hanya melakukan update status order
    UPDATE dbo.Orders SET Status = 'PROCESSED' WHERE OrderId = @OrderId;
END;`,
        sourceHighlights: { 4: "diff-added", 5: "diff-added", 6: "diff-added" },
        targetHighlights: { 5: "diff-deleted" }
    },
    "dbo.sp_SyncInventory": {
        source: `CREATE PROCEDURE dbo.sp_SyncInventory
AS
BEGIN
    SET NOCOUNT ON;
    -- Menggunakan join tabel log terbaru
    UPDATE p SET p.Price = p.Price * 1.05
    FROM dbo.Products p
    JOIN dbo.InventoryLogs i ON p.ProductId = i.ProductId;
END;`,
        target: `CREATE PROCEDURE dbo.sp_SyncInventory
AS
BEGIN
    SET NOCOUNT ON;
    -- Kosong / belum terimplementasi logika sinkronisasinya
END;`,
        sourceHighlights: { 4: "diff-added", 5: "diff-added", 6: "diff-added" },
        targetHighlights: { 4: "diff-deleted" }
    },
    "dbo.Products": {
        source: `CREATE TABLE dbo.Products (
    ProductId INT PRIMARY KEY IDENTITY(1,1),
    ProductName VARCHAR(150) NOT NULL,
    Price DECIMAL(18,2) NOT NULL
);`,
        target: `CREATE TABLE dbo.Products (
    ProductId INT PRIMARY KEY IDENTITY(1,1),
    ProductName VARCHAR(150) NOT NULL,
    Price DECIMAL(18,2) NOT NULL
);`,
        sourceHighlights: {},
        targetHighlights: {}
    },
    "dbo.Users": {
        source: `CREATE TABLE dbo.Users (
    UserId INT PRIMARY KEY IDENTITY(1,1),
    Username VARCHAR(50) NOT NULL,
    PasswordHash VARCHAR(256) NOT NULL,
    IsActive BIT DEFAULT 1
);`,
        target: `CREATE TABLE dbo.Users (
    UserId INT PRIMARY KEY IDENTITY(1,1),
    Username VARCHAR(50) NOT NULL,
    PasswordHash VARCHAR(256) NOT NULL,
    IsActive BIT DEFAULT 1
);`,
        sourceHighlights: {},
        targetHighlights: {}
    },
    "dbo.Payments": {
        source: `CREATE TABLE dbo.Payments (
    PaymentId INT PRIMARY KEY IDENTITY(1,1),
    OrderId INT NOT NULL,
    Amount DECIMAL(18,2) NOT NULL,
    PaymentDate DATETIME DEFAULT GETDATE()
);`,
        target: `CREATE TABLE dbo.Payments (
    PaymentId INT PRIMARY KEY IDENTITY(1,1),
    OrderId INT NOT NULL,
    Amount DECIMAL(18,2) NOT NULL,
    PaymentDate DATETIME DEFAULT GETDATE()
);`,
        sourceHighlights: {},
        targetHighlights: {}
    },
    "dbo.vw_ActiveCustomers": {
        source: `CREATE VIEW dbo.vw_ActiveCustomers AS
SELECT Id, CustomerName, EmailAddress 
FROM dbo.Customers 
WHERE IsActive = 1;`,
        target: `CREATE VIEW dbo.vw_ActiveCustomers AS
SELECT Id, CustomerName, EmailAddress 
FROM dbo.Customers 
WHERE IsActive = 1;`,
        sourceHighlights: {},
        targetHighlights: {}
    },
    "dbo.vw_MonthlySales": {
        source: `CREATE VIEW dbo.vw_MonthlySales AS
SELECT YEAR(OrderDate) AS SalesYear, MONTH(OrderDate) AS SalesMonth, SUM(TotalAmount) AS TotalRevenue
FROM dbo.Orders
GROUP BY YEAR(OrderDate), MONTH(OrderDate);`,
        target: `CREATE VIEW dbo.vw_MonthlySales AS
SELECT YEAR(OrderDate) AS SalesYear, MONTH(OrderDate) AS SalesMonth, SUM(TotalAmount) AS TotalRevenue
FROM dbo.Orders
GROUP BY YEAR(OrderDate), MONTH(OrderDate);`,
        sourceHighlights: {},
        targetHighlights: {}
    },
    "dbo.fn_GetDateOnly": {
        source: `CREATE FUNCTION dbo.fn_GetDateOnly (@DateTime DATETIME)
RETURNS DATE
AS
BEGIN
    RETURN CONVERT(DATE, @DateTime);
END;`,
        target: `CREATE FUNCTION dbo.fn_GetDateOnly (@DateTime DATETIME)
RETURNS DATE
AS
BEGIN
    RETURN CONVERT(DATE, @DateTime);
END;`,
        sourceHighlights: {},
        targetHighlights: {}
    }
};

const schemaDummyResults = [
    // Mismatch Tables (Exists on both, columns mismatch)
    { name: "dbo.Customers", type: "Table", status: "Mismatch", info: "Kolom <code style='color: #f43f5e; font-family: Consolas;'>EmailAddress VARCHAR(255)</code> tidak ditemukan di Target DB.", action: `<div style="display: flex; gap: 0.4rem;"><button class="btn btn-secondary" onclick="openColumnSyncModal('dbo.Customers')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-teal); color: var(--accent-teal); background: rgba(0,173,181,0.05);"><i class="fa-solid fa-wand-magic-sparkles"></i> Sinkronisasi Kolom</button><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.Customers')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.05);"><i class="fa-solid fa-code-compare"></i> Compare DDL</button></div>` },
    { name: "dbo.Orders", type: "Table", status: "Mismatch", info: "Kolom <code style='color: #f43f5e; font-family: Consolas;'>PromoCode VARCHAR(50)</code> tidak ditemukan di Target DB.", action: `<div style="display: flex; gap: 0.4rem;"><button class="btn btn-secondary" onclick="openColumnSyncModal('dbo.Orders')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-teal); color: var(--accent-teal); background: rgba(0,173,181,0.05);"><i class="fa-solid fa-wand-magic-sparkles"></i> Sinkronisasi Kolom</button><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.Orders')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.05);"><i class="fa-solid fa-code-compare"></i> Compare DDL</button></div>` },
    
    // Missing Tables (3 items as shown in stats card)
    { name: "dbo.CustomerAddresses", type: "Table", status: "Missing", info: "Objek tidak ditemukan sama sekali di Target DB.", action: `<div style="display: flex; gap: 0.4rem;"><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.CustomerAddresses')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-indigo); color: var(--accent-indigo); background: rgba(99,102,241,0.06);"><i class="fa-solid fa-plus"></i> Buat Baru</button><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.CustomerAddresses')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.05);"><i class="fa-solid fa-code-compare"></i> Compare DDL</button></div>` },
    { name: "dbo.InventoryLogs", type: "Table", status: "Missing", info: "Objek tidak ditemukan sama sekali di Target DB.", action: `<div style="display: flex; gap: 0.4rem;"><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.InventoryLogs')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-indigo); color: var(--accent-indigo); background: rgba(99,102,241,0.06);"><i class="fa-solid fa-plus"></i> Buat Baru</button><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.InventoryLogs')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.05);"><i class="fa-solid fa-code-compare"></i> Compare DDL</button></div>` },
    { name: "dbo.SessionTokens", type: "Table", status: "Missing", info: "Objek tidak ditemukan sama sekali di Target DB.", action: `<div style="display: flex; gap: 0.4rem;"><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.SessionTokens')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-indigo); color: var(--accent-indigo); background: rgba(99,102,241,0.06);"><i class="fa-solid fa-plus"></i> Buat Baru</button><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.SessionTokens')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.05);"><i class="fa-solid fa-code-compare"></i> Compare DDL</button></div>` },

    // Outdated SPs (3 items as shown in stats card)
    { name: "dbo.sp_GetCustomerReport", type: "Stored Procedure", status: "Outdated", info: "Hash DDL berbeda (Script source memiliki modifikasi terbaru).", action: `<div style="display: flex; gap: 0.4rem;"><button class="btn btn-secondary" onclick="await uiAlert('Pembaruan Stored Procedure berhasil dieksekusi!')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.06);"><i class="fa-solid fa-arrows-spin"></i> Update SP</button><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.sp_GetCustomerReport')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.05);"><i class="fa-solid fa-code-compare"></i> Compare DDL</button></div>` },
    { name: "dbo.sp_ProcessOrder", type: "Stored Procedure", status: "Outdated", info: "Hash DDL berbeda (Script source memiliki modifikasi terbaru).", action: `<div style="display: flex; gap: 0.4rem;"><button class="btn btn-secondary" onclick="await uiAlert('Pembaruan Stored Procedure berhasil dieksekusi!')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.06);"><i class="fa-solid fa-arrows-spin"></i> Update SP</button><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.sp_ProcessOrder')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.05);"><i class="fa-solid fa-code-compare"></i> Compare DDL</button></div>` },
    { name: "dbo.sp_SyncInventory", type: "Stored Procedure", status: "Outdated", info: "Hash DDL berbeda (Script source memiliki modifikasi terbaru).", action: `<div style="display: flex; gap: 0.4rem;"><button class="btn btn-secondary" onclick="await uiAlert('Pembaruan Stored Procedure berhasil dieksekusi!')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.06);"><i class="fa-solid fa-arrows-spin"></i> Update SP</button><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.sp_SyncInventory')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.05);"><i class="fa-solid fa-code-compare"></i> Compare DDL</button></div>` },

    // Missing Function (1 item as shown in stats card)
    { name: "dbo.fn_CalculateTax", type: "Function", status: "Missing", info: "Objek tidak ditemukan sama sekali di Target DB.", action: `<div style="display: flex; gap: 0.4rem;"><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.fn_CalculateTax')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-indigo); color: var(--accent-indigo); background: rgba(99,102,241,0.06);"><i class="fa-solid fa-plus"></i> Buat Baru</button><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.fn_CalculateTax')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.05);"><i class="fa-solid fa-code-compare"></i> Compare DDL</button></div>` },

    // Match Objects (Identical structures)
    { name: "dbo.Products", type: "Table", status: "Match", info: "Struktur skema identik 100%.", action: `<div style="display: flex; gap: 0.4rem; align-items: center;"><span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.Products')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--text-muted); color: var(--text-muted); background: transparent;"><i class="fa-solid fa-code-compare"></i> View DDL</button></div>` },
    { name: "dbo.Users", type: "Table", status: "Match", info: "Struktur skema identik 100%.", action: `<div style="display: flex; gap: 0.4rem; align-items: center;"><span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.Users')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--text-muted); color: var(--text-muted); background: transparent;"><i class="fa-solid fa-code-compare"></i> View DDL</button></div>` },
    { name: "dbo.Payments", type: "Table", status: "Match", info: "Struktur skema identik 100%.", action: `<div style="display: flex; gap: 0.4rem; align-items: center;"><span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.Payments')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--text-muted); color: var(--text-muted); background: transparent;"><i class="fa-solid fa-code-compare"></i> View DDL</button></div>` },
    { name: "dbo.vw_ActiveCustomers", type: "View", status: "Match", info: "Struktur skema identik 100%.", action: `<div style="display: flex; gap: 0.4rem; align-items: center;"><span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.vw_ActiveCustomers')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--text-muted); color: var(--text-muted); background: transparent;"><i class="fa-solid fa-code-compare"></i> View DDL</button></div>` },
    { name: "dbo.vw_MonthlySales", type: "View", status: "Match", info: "Struktur skema identik 100%.", action: `<div style="display: flex; gap: 0.4rem; align-items: center;"><span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.vw_MonthlySales')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--text-muted); color: var(--text-muted); background: transparent;"><i class="fa-solid fa-code-compare"></i> View DDL</button></div>` },
    { name: "dbo.fn_GetDateOnly", type: "Function", status: "Match", info: "Struktur skema identik 100%.", action: `<div style="display: flex; gap: 0.4rem; align-items: center;"><span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span><button class="btn btn-secondary" onclick="openSchemaDiffModal('dbo.fn_GetDateOnly')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--text-muted); color: var(--text-muted); background: transparent;"><i class="fa-solid fa-code-compare"></i> View DDL</button></div>` }
];

// Dynamically generate the remaining objects to match the stats cards
(function generateRemainingDummyObjects() {
    // 1. Tables (Total: 45, 3 Missing, 2 Mismatch -> 40 Match)
    const currentTables = schemaDummyResults.filter(o => o.type === 'Table');
    const matchTablesNeeded = 40 - currentTables.filter(o => o.status === 'Match').length;
    const additionalTables = [
        "dbo.Logs", "dbo.AuditTrail", "dbo.Categories", "dbo.Settings", "dbo.Permissions", 
        "dbo.Vendors", "dbo.Branches", "dbo.Departments", "dbo.Employees", "dbo.Salaries", 
        "dbo.Transactions", "dbo.Accounts", "dbo.Ledgers", "dbo.Vouchers", "dbo.TaxRates", 
        "dbo.Currencies", "dbo.Rates", "dbo.Invoices", "dbo.InvoiceItems", "dbo.Shipments", 
        "dbo.ShipmentDetails", "dbo.Deliveries", "dbo.Suppliers", "dbo.Warehouse", "dbo.Stock", 
        "dbo.StockHistory", "dbo.Notifications", "dbo.SystemConfig", "dbo.EmailTemplates", "dbo.JobQueue", 
        "dbo.ErrorLogs", "dbo.Reports", "dbo.ReportSchedules", "dbo.Analytics", "dbo.UserFeedback", 
        "dbo.ApiTokens", "dbo.ProductReviews", "dbo.AppLogs", "dbo.Metadata", "dbo.LookupValues"
    ];
    for (let i = 0; i < matchTablesNeeded && i < additionalTables.length; i++) {
        const tableName = additionalTables[i];
        if (!schemaDummyResults.find(o => o.name === tableName)) {
            schemaDummyResults.push({
                name: tableName,
                type: "Table",
                status: "Match",
                info: "Struktur skema identik 100%.",
                action: `<div style="display: flex; gap: 0.4rem; align-items: center;"><span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span><button class="btn btn-secondary" onclick="openSchemaDiffModal('${tableName}')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--text-muted); color: var(--text-muted); background: transparent;"><i class="fa-solid fa-code-compare"></i> View DDL</button></div>`
            });
            schemaDummyDdl[tableName] = {
                source: `CREATE TABLE ${tableName} (\n    Id INT PRIMARY KEY IDENTITY(1,1),\n    Code VARCHAR(50) NOT NULL,\n    IsActive BIT DEFAULT 1,\n    ModifiedAt DATETIME DEFAULT GETDATE()\n);`,
                target: `CREATE TABLE ${tableName} (\n    Id INT PRIMARY KEY IDENTITY(1,1),\n    Code VARCHAR(50) NOT NULL,\n    IsActive BIT DEFAULT 1,\n    ModifiedAt DATETIME DEFAULT GETDATE()\n);`,
                sourceHighlights: {},
                targetHighlights: {}
            };
        }
    }

    // 2. Views (Total: 12, 12 Match)
    const currentViews = schemaDummyResults.filter(o => o.type === 'View');
    const matchViewsNeeded = 12 - currentViews.filter(o => o.status === 'Match').length;
    for (let i = 1; i <= matchViewsNeeded; i++) {
        const viewName = `dbo.vw_Report_Summary_0${i}`;
        schemaDummyResults.push({
            name: viewName,
            type: "View",
            status: "Match",
            info: "Struktur skema identik 100%.",
            action: `<div style="display: flex; gap: 0.4rem; align-items: center;"><span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span><button class="btn btn-secondary" onclick="openSchemaDiffModal('${viewName}')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--text-muted); color: var(--text-muted); background: transparent;"><i class="fa-solid fa-code-compare"></i> View DDL</button></div>`
        });
        schemaDummyDdl[viewName] = {
            source: `CREATE VIEW ${viewName} AS\nSELECT COUNT(*) AS TotalCount FROM dbo.Customers;`,
            target: `CREATE VIEW ${viewName} AS\nSELECT COUNT(*) AS TotalCount FROM dbo.Customers;`,
            sourceHighlights: {},
            targetHighlights: {}
        };
    }

    // 3. Stored Procedures (Total: 18, 3 Outdated -> 15 Match)
    const currentSps = schemaDummyResults.filter(o => o.type === 'Stored Procedure');
    const matchSpsNeeded = 15 - currentSps.filter(o => o.status === 'Match').length;
    for (let i = 1; i <= matchSpsNeeded; i++) {
        const spName = `dbo.sp_Get_Data_Utility_0${i}`;
        schemaDummyResults.push({
            name: spName,
            type: "Stored Procedure",
            status: "Match",
            info: "Struktur skema identik 100%.",
            action: `<div style="display: flex; gap: 0.4rem; align-items: center;"><span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span><button class="btn btn-secondary" onclick="openSchemaDiffModal('${spName}')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--text-muted); color: var(--text-muted); background: transparent;"><i class="fa-solid fa-code-compare"></i> View DDL</button></div>`
        });
        schemaDummyDdl[spName] = {
            source: `CREATE PROCEDURE ${spName}\nAS\nBEGIN\n    SET NOCOUNT ON;\n    SELECT 1;\nEND;`,
            target: `CREATE PROCEDURE ${spName}\nAS\nBEGIN\n    SET NOCOUNT ON;\n    SELECT 1;\nEND;`,
            sourceHighlights: {},
            targetHighlights: {}
        };
    }

    // 4. Functions (Total: 8, 1 Missing -> 7 Match)
    const currentFuncs = schemaDummyResults.filter(o => o.type === 'Function');
    const matchFuncsNeeded = 7 - currentFuncs.filter(o => o.status === 'Match').length;
    for (let i = 1; i <= matchFuncsNeeded; i++) {
        const funcName = `dbo.fn_Get_Formatted_Date_0${i}`;
        schemaDummyResults.push({
            name: funcName,
            type: "Function",
            status: "Match",
            info: "Struktur skema identik 100%.",
            action: `<div style="display: flex; gap: 0.4rem; align-items: center;"><span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span><button class="btn btn-secondary" onclick="openSchemaDiffModal('${funcName}')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--text-muted); color: var(--text-muted); background: transparent;"><i class="fa-solid fa-code-compare"></i> View DDL</button></div>`
        });
        schemaDummyDdl[funcName] = {
            source: `CREATE FUNCTION ${funcName} (@InputDate DATETIME)\nRETURNS VARCHAR(50)\nAS\nBEGIN\n    RETURN CONVERT(VARCHAR(50), @InputDate, 120);\nEND;`,
            target: `CREATE FUNCTION ${funcName} (@InputDate DATETIME)\nRETURNS VARCHAR(50)\nAS\nBEGIN\n    RETURN CONVERT(VARCHAR(50), @InputDate, 120);\nEND;`,
            sourceHighlights: {},
            targetHighlights: {}
        };
    }
})();

let schemaComparisonResults = [];
let schemaComparisonDdl = {};
let schemaColumnSyncDetails = {};
let schemaComparisonSummary = null;

// IndexedDB Helper for Schema Comparison Caching
const dbMigratorDb = {
    dbName: "DbMigratorCacheDb",
    storeName: "SchemaCache",
    version: 1,

    open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    },

    async set(key, value) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.storeName, "readwrite");
                const store = transaction.objectStore(this.storeName);
                const request = store.put(value, key);
                request.onsuccess = () => resolve();
                request.onerror = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.error("IndexedDB set error:", err);
        }
    },

    async get(key) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.storeName, "readonly");
                const store = transaction.objectStore(this.storeName);
                const request = store.get(key);
                request.onsuccess = (e) => resolve(e.target.result);
                request.onerror = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.error("IndexedDB get error:", err);
            return null;
        }
    },

    async delete(key) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.storeName, "readwrite");
                const store = transaction.objectStore(this.storeName);
                const request = store.delete(key);
                request.onsuccess = () => resolve();
                request.onerror = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.error("IndexedDB delete error:", err);
        }
    }
};

async function loadSchemaComparisonCache(jobId) {
    const cachedResults = await dbMigratorDb.get(`results_${jobId}`);
    const cachedDdl = await dbMigratorDb.get(`ddl_${jobId}`);
    const cachedSync = await dbMigratorDb.get(`sync_${jobId}`);
    const cachedSummary = await dbMigratorDb.get(`summary_${jobId}`);

    const clearBtn = document.getElementById('btn-schema-clear');
    const scanBtn = document.getElementById('btn-schema-scan');

    let results = cachedResults;
    let ddl = cachedDdl;
    let sync = cachedSync;
    let summary = cachedSummary;

    // Fallback & Migration from localStorage if IndexedDB is empty
    if (!results) {
        const localResults = localStorage.getItem(`dbmigrator_schema_compare_results_${jobId}`);
        const localDdl = localStorage.getItem(`dbmigrator_schema_compare_ddl_${jobId}`);
        const localSync = localStorage.getItem(`dbmigrator_schema_column_sync_${jobId}`);
        const localSummary = localStorage.getItem(`dbmigrator_schema_compare_summary_${jobId}`);

        if (localResults) {
            try {
                results = JSON.parse(localResults);
                ddl = localDdl ? JSON.parse(localDdl) : {};
                sync = localSync ? JSON.parse(localSync) : {};
                summary = localSummary ? JSON.parse(localSummary) : null;
                
                // Migrate to IndexedDB
                await dbMigratorDb.set(`results_${jobId}`, results);
                await dbMigratorDb.set(`ddl_${jobId}`, ddl);
                await dbMigratorDb.set(`sync_${jobId}`, sync);
                if (summary) await dbMigratorDb.set(`summary_${jobId}`, summary);
            } catch (e) {
                console.error("Error migrating localStorage cache to IndexedDB:", e);
            }
        }
    }

    if (results) {
        try {
            schemaComparisonResults = results;
            schemaComparisonDdl = ddl || {};
            schemaColumnSyncDetails = sync || {};
            schemaComparisonSummary = summary || null;
            
            updateSchemaSummaryCards(schemaComparisonSummary);
            renderSchemaComparisonTable();

            if (scanBtn) {
                scanBtn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Memindai Ulang`;
            }
            if (clearBtn) {
                clearBtn.style.display = 'inline-block';
            }
            return;
        } catch (e) {
            console.error("Gagal memuat cache schema comparison dari IndexedDB:", e);
        }
    }

    // Fallback if no cache or error
    schemaComparisonResults = [];
    schemaComparisonDdl = {};
    schemaColumnSyncDetails = {};
    schemaComparisonSummary = null;
    
    updateSchemaSummaryCards(null);
    renderSchemaComparisonTable();

    if (scanBtn) {
        scanBtn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Jalankan Pemindaian Skema`;
    }
    if (clearBtn) {
        clearBtn.style.display = 'none';
    }
}

async function persistSchemaCompareCache(jobId) {
    if (!jobId) return;

    try {
        await dbMigratorDb.set(`results_${jobId}`, schemaComparisonResults);
        await dbMigratorDb.set(`ddl_${jobId}`, schemaComparisonDdl);
        await dbMigratorDb.set(`sync_${jobId}`, schemaColumnSyncDetails);
        if (schemaComparisonSummary) {
            await dbMigratorDb.set(`summary_${jobId}`, schemaComparisonSummary);
        }
    } catch (e) {
        console.error("Failed to save schema comparison cache to IndexedDB:", e);
    }
}

async function clearSchemaComparison() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;

    if (!(await uiConfirm("Apakah Anda yakin ingin menghapus hasil pemindaian skema yang tersimpan?"))) {
        return;
    }

    // Remove from IndexedDB
    await dbMigratorDb.delete(`results_${jobId}`);
    await dbMigratorDb.delete(`ddl_${jobId}`);
    await dbMigratorDb.delete(`sync_${jobId}`);
    await dbMigratorDb.delete(`summary_${jobId}`);

    // Remove from localStorage just in case
    localStorage.removeItem(`dbmigrator_schema_compare_results_${jobId}`);
    localStorage.removeItem(`dbmigrator_schema_compare_ddl_${jobId}`);
    localStorage.removeItem(`dbmigrator_schema_column_sync_${jobId}`);
    localStorage.removeItem(`dbmigrator_schema_compare_summary_${jobId}`);

    // Reset variables
    schemaComparisonResults = [];
    schemaComparisonDdl = {};
    schemaColumnSyncDetails = {};
    schemaComparisonSummary = null;

    // Reset UI
    updateSchemaSummaryCards(null);
    renderSchemaComparisonTable();

    // Toggle button state
    const scanBtn = document.getElementById('btn-schema-scan');
    const clearBtn = document.getElementById('btn-schema-clear');
    if (scanBtn) {
        scanBtn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Jalankan Pemindaian Skema`;
    }
    if (clearBtn) {
        clearBtn.style.display = 'none';
    }
}

async function runSchemaComparison() {
    const btn = document.getElementById('btn-schema-scan') || document.querySelector('#inner-content-schema button[onclick="runSchemaComparison()"]');
    if (!btn) return;
    if (!activeJob) {
        await uiAlert("Pilih job terlebih dahulu sebelum menjalankan pemindaian skema.");
        return;
    }
    
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Memindai Skema...`;
    btn.disabled = true;

    const tbody = document.getElementById('schema-comparison-tbody');
    if (tbody) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="color: var(--text-muted); text-align: center; padding: 3rem;">
                    <i class="fa-solid fa-spinner fa-spin" style="font-size: 2.2rem; margin-bottom: 0.75rem; display: block; color: var(--accent-teal);"></i>
                    Sedang membandingkan skema database... Harap tunggu...
                </td>
            </tr>
        `;
    }

    try {
        const jobId = activeJob.Id || activeJob.id;
        const res = await fetch(`${API_BASE}/db/schema-comparison?jobId=${jobId}`);
        if (!res.ok) {
            const msg = await res.text();
            throw new Error(msg || "Gagal membandingkan skema database.");
        }

        const data = await res.json();
        schemaComparisonResults = data.Items || data.items || [];
        schemaComparisonDdl = {};
        schemaColumnSyncDetails = {};

        schemaComparisonResults.forEach(item => {
            const name = item.Name || item.name;
            schemaComparisonDdl[name] = {
                source: item.SourceDdl || item.sourceDdl || "-- DDL Source tidak tersedia --",
                target: item.TargetDdl || item.targetDdl || "-- DDL Target tidak tersedia --",
                sourceHighlights: {},
                targetHighlights: {}
            };

            const columnSync = item.ColumnSync || item.columnSync;
            if (columnSync) {
                schemaColumnSyncDetails[name] = {
                    before: columnSync.Before || columnSync.before || [],
                    after: columnSync.After || columnSync.after || [],
                    sql: columnSync.Sql || columnSync.sql || ''
                };
            }
        });

        // Store summary in global variable
        schemaComparisonSummary = data.Summary || data.summary;

        // Persist to localStorage
        if (activeJob) {
            await persistSchemaCompareCache(jobId);
        }

        // Toggle clear button
        const clearBtn = document.getElementById('btn-schema-clear');
        if (clearBtn) {
            clearBtn.style.display = 'inline-block';
        }

        updateSchemaSummaryCards(schemaComparisonSummary);
        renderSchemaComparisonTable();
    } catch (err) {
        console.error(err);
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="color: var(--color-error); text-align: center; padding: 2rem;">
                        <i class="fa-solid fa-circle-exclamation" style="font-size: 1.8rem; margin-bottom: 0.5rem; display: block;"></i>
                        ${escapeHtml(err.message || "Gagal membandingkan skema database.")}
                    </td>
                </tr>
            `;
        }
        await uiAlert("Pemindaian skema gagal: " + (err.message || err));
    } finally {
        if (btn.id === 'btn-schema-scan' && schemaComparisonResults.length > 0) {
            btn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Memindai Ulang`;
        } else {
            btn.innerHTML = originalText;
        }
        btn.disabled = false;
    }
}

function renderSchemaComparisonTable() {
    const tbody = document.getElementById('schema-comparison-tbody');
    if (!tbody) return;

    if (!schemaComparisonResults.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="color: var(--text-muted); text-align: center; padding: 2rem;">
                    Klik tombol <strong>Jalankan Pemindaian Skema</strong> untuk membandingkan skema Source DB vs Target DB.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = schemaComparisonResults.map(item => {
        const name = item.Name || item.name;
        const type = item.Type || item.type;
        const status = item.Status || item.status;
        const info = item.Info || item.info || '-';
        let statusBadge = `<span class="schema-card-status match"><i class="fa-solid fa-circle-check"></i> Match</span>`;
        if (status === 'Mismatch') {
            statusBadge = `<span class="schema-card-status mismatch"><i class="fa-solid fa-circle-exclamation"></i> Mismatch</span>`;
        } else if (status === 'Outdated') {
            statusBadge = `<span class="schema-card-status mismatch" style="background: rgba(139,92,246,0.1); color: var(--accent-purple);"><i class="fa-solid fa-circle-exclamation"></i> Outdated</span>`;
        } else if (status === 'Missing') {
            statusBadge = `<span class="schema-card-status mismatch" style="background: rgba(99,102,241,0.1); color: var(--accent-indigo);"><i class="fa-solid fa-circle-exclamation"></i> Missing</span>`;
        }

        const action = buildSchemaAction(name, type, status);
        return `
            <tr data-status="${status}">
                <td class="row-num" style="text-align: center; font-size: 0.8rem;"></td>
                <td><strong>${escapeHtml(name)}</strong></td>
                <td>${escapeHtml(type)}</td>
                <td>${statusBadge}</td>
                <td>${info}</td>
                <td>${action}</td>
            </tr>
        `;
    }).join('');

    // Apply filter immediately after rendering
    toggleSchemaMatchVisibility();
}

function buildSchemaAction(name, type, status) {
    const safeName = String(name).replace(/\\/g, "\\\\\\\\").replace(/'/g, "\\'");
    const diffLabel = status === 'Match' ? 'View DDL' : 'Compare DDL';
    const buttons = [];

    if (status === 'Mismatch' && schemaColumnSyncDetails[name]) {
        buttons.push(`<button class="btn btn-secondary" onclick="openColumnSyncModal('${safeName}')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-teal); color: var(--accent-teal); background: rgba(0,173,181,0.05);"><i class="fa-solid fa-wand-magic-sparkles"></i> Sinkronisasi Kolom</button>`);
    } else if (status === 'Missing') {
        buttons.push(`<button class="btn btn-secondary" onclick="openSchemaDiffModal('${safeName}')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-indigo); color: var(--accent-indigo); background: rgba(99,102,241,0.06);"><i class="fa-solid fa-plus"></i> Buat Baru</button>`);
    } else if (status === 'Outdated') {
        const label = type === 'Stored Procedure' ? 'Update SP' : 'Update DDL';
        buttons.push(`<button class="btn btn-secondary" onclick="openSchemaDiffModal('${safeName}')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.06);"><i class="fa-solid fa-arrows-spin"></i> ${label}</button>`);
    } else if (status === 'Match') {
        buttons.push(`<span style="color: var(--text-muted); font-size: 0.8rem; margin-right: 0.5rem;">Tidak butuh aksi</span>`);
    }

    buttons.push(`<button class="btn btn-secondary" onclick="openSchemaDiffModal('${safeName}')" style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.72rem; border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168,85,247,0.05);"><i class="fa-solid fa-code-compare"></i> ${diffLabel}</button>`);
    return `<div style="display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;">${buttons.join('')}</div>`;
}

async function markObjectAsSynced(objName) {
    const item = schemaComparisonResults.find(o => (o.Name || o.name) === objName);
    if (!item) return;

    const oldStatus = item.Status || item.status;
    const itemType = item.Type || item.type;

    item.Status = "Match";
    item.status = "Match";
    item.Info = "Struktur skema identik 100%.";
    item.info = "Struktur skema identik 100%.";

    if (schemaComparisonDdl[objName]) {
        schemaComparisonDdl[objName].target = schemaComparisonDdl[objName].source;
        schemaComparisonDdl[objName].targetHighlights = {};
        schemaComparisonDdl[objName].sourceHighlights = {};
    }

    // Update dynamic summary metrics
    if (schemaComparisonSummary && oldStatus !== 'Match') {
        const typeKey = Object.keys(schemaComparisonSummary).find(k => k.toLowerCase() === itemType.toLowerCase());
        if (typeKey) {
            const sumData = schemaComparisonSummary[typeKey];
            
            // Decrement corresponding issue counts and adjust target counts
            if (oldStatus === 'Missing') {
                if (sumData.MissingCount !== undefined) sumData.MissingCount = Math.max(0, sumData.MissingCount - 1);
                if (sumData.missingCount !== undefined) sumData.missingCount = Math.max(0, sumData.missingCount - 1);
                if (sumData.TargetCount !== undefined) sumData.TargetCount++;
                if (sumData.targetCount !== undefined) sumData.targetCount++;
            } else if (oldStatus === 'Mismatch') {
                if (sumData.MismatchCount !== undefined) sumData.MismatchCount = Math.max(0, sumData.MismatchCount - 1);
                if (sumData.mismatchCount !== undefined) sumData.mismatchCount = Math.max(0, sumData.mismatchCount - 1);
            } else if (oldStatus === 'Outdated') {
                if (sumData.OutdatedCount !== undefined) sumData.OutdatedCount = Math.max(0, sumData.OutdatedCount - 1);
                if (sumData.outdatedCount !== undefined) sumData.outdatedCount = Math.max(0, sumData.outdatedCount - 1);
            }
        }
        
        updateSchemaSummaryCards(schemaComparisonSummary);
    }

    // Persist to localStorage
    if (activeJob) {
        const jobId = activeJob.Id || activeJob.id;
        await persistSchemaCompareCache(jobId);
    }

    renderSchemaComparisonTable();
}

function updateSchemaSummaryCards(summary) {
    const types = ['Table', 'View', 'Stored Procedure', 'Function'];
    const cards = document.querySelectorAll('.schema-summary-card');
    if (!cards.length) return;

    types.forEach((type, index) => {
        const card = cards[index];
        if (!card) return;

        const data = summary ? (summary[type] || summary[type.replace(' ', '')] || {}) : {};
        const sourceCount = data.SourceCount ?? data.sourceCount ?? 0;
        const targetCount = data.TargetCount ?? data.targetCount ?? 0;
        const missing = data.MissingCount ?? data.missingCount ?? 0;
        const mismatch = data.MismatchCount ?? data.mismatchCount ?? 0;
        const outdated = data.OutdatedCount ?? data.outdatedCount ?? 0;
        const issueCount = missing + mismatch + outdated;

        const valueEl = card.querySelector('.schema-card-value');
        const statusEl = card.querySelector('.schema-card-status');
        if (valueEl) {
            valueEl.innerHTML = `${sourceCount} <span style="font-size: 0.9rem; color: var(--text-muted);">vs</span> ${targetCount}`;
        }
        if (!statusEl) return;

        if (!summary) {
            statusEl.className = 'schema-card-status match';
            statusEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> Belum Dipindai`;
        } else if (issueCount === 0) {
            statusEl.className = 'schema-card-status match';
            statusEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> Match`;
        } else {
            const parts = [];
            if (missing) parts.push(`${missing} Missing`);
            if (mismatch) parts.push(`${mismatch} Mismatch`);
            if (outdated) parts.push(`${outdated} Outdated`);
            statusEl.className = 'schema-card-status mismatch';
            statusEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${parts.join(', ')}`;
        }
    });
}

function updateSchemaStatsCards(oldStatus, itemType) {
    if (oldStatus === 'Match') return;

    const cards = document.querySelectorAll('.schema-summary-card');
    if (cards.length < 4) return;

    let cardIndex = -1;
    if (itemType === 'Table') cardIndex = 0;
    else if (itemType === 'View') cardIndex = 1;
    else if (itemType === 'Stored Procedure') cardIndex = 2;
    else if (itemType === 'Function') cardIndex = 3;

    if (cardIndex === -1) return;
    const card = cards[cardIndex];

    if (itemType === 'Table') {
        const valSpan = card.querySelector('.schema-card-value');
        const statusSpan = card.querySelector('.schema-card-status');
        if (oldStatus === 'Missing' && valSpan && statusSpan) {
            let text = valSpan.innerHTML;
            let match = text.match(/(\d+)\s*<span[^>]*>vs<\/span>\s*(\d+)/);
            if (match) {
                let src = parseInt(match[1]);
                let tgt = parseInt(match[2]) + 1;
                valSpan.innerHTML = `${src} <span style="font-size: 0.9rem; color: var(--text-muted);">vs</span> ${tgt}`;
                
                let missingCount = src - tgt;
                if (missingCount > 0) {
                    statusSpan.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${missingCount} Missing`;
                } else {
                    statusSpan.className = 'schema-card-status match';
                    statusSpan.innerHTML = `<i class="fa-solid fa-circle-check"></i> Match`;
                }
            }
        }
    } else if (itemType === 'Stored Procedure') {
        const statusSpan = card.querySelector('.schema-card-status');
        if (statusSpan) {
            let text = statusSpan.textContent.trim();
            let count = parseInt(text);
            if (!isNaN(count) && count > 0) {
                count--;
                if (count > 0) {
                    statusSpan.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${count} Outdated`;
                } else {
                    statusSpan.className = 'schema-card-status match';
                    statusSpan.innerHTML = `<i class="fa-solid fa-circle-check"></i> Match`;
                }
            }
        }
    } else if (itemType === 'Function') {
        const valSpan = card.querySelector('.schema-card-value');
        const statusSpan = card.querySelector('.schema-card-status');
        if (oldStatus === 'Missing' && valSpan && statusSpan) {
            valSpan.innerHTML = `8 <span style="font-size: 0.9rem; color: var(--text-muted);">vs</span> 8`;
            statusSpan.className = 'schema-card-status match';
            statusSpan.innerHTML = `<i class="fa-solid fa-circle-check"></i> Match`;
        }
    }
}

function toggleSchemaMatchVisibility() {
    applySchemaFilters();
}

function applySchemaFilters() {
    const searchInput = document.getElementById('schema-search');
    const typeFilter = document.getElementById('schema-filter-type');
    const statusFilter = document.getElementById('schema-filter-status');
    const matchCheckbox = document.getElementById('schema-filter-match');

    const searchVal = searchInput ? (searchInput.value || '').toLowerCase().trim() : '';
    const typeVal = typeFilter ? typeFilter.value : 'ALL';
    const statusVal = statusFilter ? statusFilter.value : 'ALL';
    const showMatch = matchCheckbox ? matchCheckbox.checked : true;

    const rows = document.querySelectorAll('#schema-comparison-tbody tr[data-status]');
    rows.forEach(row => {
        const name = (row.cells[1].textContent || '').toLowerCase();
        const type = row.cells[2].textContent;
        const status = row.getAttribute('data-status');

        let matchesSearch = name.includes(searchVal);
        let matchesType = (typeVal === 'ALL' || type === typeVal);
        let matchesStatus = (statusVal === 'ALL' || status === statusVal);
        
        // Respect the Show Match checkbox
        if (status === 'Match' && !showMatch) {
            matchesStatus = false;
        }

        if (matchesSearch && matchesType && matchesStatus) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// ── Column Sync Detail & Modal Logic ──────────────────────────────────────────
const columnSyncDetails = {
    "dbo.Customers": {
        before: [
            { name: "Id", type: "INT" },
            { name: "CustomerName", type: "VARCHAR(100)" },
            { name: "Balance", type: "DECIMAL(18,2)" },
            { name: "IsActive", type: "BIT" },
            { name: "CreatedAt", type: "DATETIME" }
        ],
        after: [
            { name: "Id", type: "INT" },
            { name: "CustomerName", type: "VARCHAR(100)" },
            { name: "EmailAddress", type: "VARCHAR(255)", isNew: true },
            { name: "Balance", type: "DECIMAL(18,2)" },
            { name: "IsActive", type: "BIT" },
            { name: "CreatedAt", type: "DATETIME" }
        ],
        sql: `ALTER TABLE dbo.Customers ADD EmailAddress VARCHAR(255) NULL;`
    },
    "dbo.Orders": {
        before: [
            { name: "OrderId", type: "INT" },
            { name: "CustomerId", type: "INT" },
            { name: "OrderDate", type: "DATETIME" },
            { name: "TotalAmount", type: "DECIMAL(18,2)" },
            { name: "Status", type: "VARCHAR(20)" }
        ],
        after: [
            { name: "OrderId", type: "INT" },
            { name: "CustomerId", type: "INT" },
            { name: "OrderDate", type: "DATETIME" },
            { name: "TotalAmount", type: "DECIMAL(18,2)" },
            { name: "PromoCode", type: "VARCHAR(50)", isNew: true },
            { name: "Status", type: "VARCHAR(20)" }
        ],
        sql: `ALTER TABLE dbo.Orders ADD PromoCode VARCHAR(50) NULL;`
    }
};

async function openColumnSyncModal(tableName) {
    const detail = schemaColumnSyncDetails[tableName];
    if (!detail) {
        await uiAlert("Detail sinkronisasi kolom untuk " + tableName + " tidak tersedia.");
        return;
    }

    const modal = document.getElementById('column-sync-modal');
    if (!modal) return;

    // Set title
    const titleEl = document.getElementById('column-sync-title');
    if (titleEl) {
        titleEl.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles" style="color: var(--accent-teal);"></i> Rencana Sinkronisasi Kolom: <span style="color: var(--accent-teal);">${tableName}</span>`;
    }

    // Populate Before Table
    const beforeTbody = document.getElementById('column-sync-before-tbody');
    if (beforeTbody) {
        beforeTbody.innerHTML = detail.before.map(col => `
            <tr>
                <td><code>${col.name}</code></td>
                <td><span style="color: var(--text-muted); font-size: 0.78rem;">${col.type}</span></td>
            </tr>
        `).join('');
    }

    // Populate After Table
    const afterTbody = document.getElementById('column-sync-after-tbody');
    if (afterTbody) {
        afterTbody.innerHTML = detail.after.map(col => {
            const style = col.isNew ? `style="background: rgba(46, 160, 67, 0.15); color: #3fb950; font-weight: bold;"` : '';
            const badge = col.isNew ? ` <span class="schema-card-status match" style="padding: 1px 4px; font-size: 0.65rem; margin-left: 0.25rem;"><i class="fa-solid fa-plus"></i> BARU</span>` : '';
            return `
                <tr ${style}>
                    <td><code>${col.name}</code>${badge}</td>
                    <td><span style="font-size: 0.78rem;">${col.type}</span></td>
                </tr>
            `;
        }).join('');
    }

    // Populate SQL Script
    const sqlCode = document.getElementById('column-sync-sql');
    if (sqlCode) {
        sqlCode.textContent = detail.sql;
        if (window.Prism) Prism.highlightElement(sqlCode);
    }

    // Configure execute button
    const execBtn = document.getElementById('btn-execute-column-sync');
    if (execBtn) {
        execBtn.onclick = async () => {
            await uiAlert('Sinkronisasi kolom untuk tabel ' + tableName + ' berhasil dieksekusi secara sukses!');
            closeColumnSyncModal();
            markObjectAsSynced(tableName);
        };
    }

    // Show modal
    modal.classList.add('active');
}

function closeColumnSyncModal() {
    const modal = document.getElementById('column-sync-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

async function openSchemaDiffModal(objName) {
    const ddl = schemaComparisonDdl[objName];
    if (!ddl) {
        await uiAlert("Data DDL untuk objek " + objName + " tidak ditemukan!");
        return;
    }

    const modal = document.getElementById('schema-diff-modal');
    if (!modal) return;

    // Set title
    const titleEl = document.getElementById('schema-diff-title');
    if (titleEl) {
        titleEl.innerHTML = `<i class="fa-solid fa-code-compare" style="color: var(--accent-purple);"></i> Perbandingan DDL: <span style="color: var(--accent-teal);">${objName}</span>`;
    }

    // Initialize/update Monaco Diff Editor
    initMonacoDiffEditor(ddl.source, ddl.target);

    // Apply button configuration
    const applyBtn = document.getElementById('btn-schema-diff-apply');
    if (applyBtn) {
        if (ddl.target.includes('tidak ditemukan')) {
            applyBtn.innerHTML = `<i class="fa-solid fa-plus"></i> Buat di Target DB`;
            applyBtn.onclick = async () => {
                await uiAlert('Objek ' + objName + ' berhasil dibuat di database target!');
                closeSchemaDiffModal();
                markObjectAsSynced(objName);
            };
            applyBtn.style.display = 'inline-block';
        } else if (ddl.source === ddl.target) {
            applyBtn.style.display = 'none'; // Identik
        } else {
            applyBtn.innerHTML = `<i class="fa-solid fa-arrows-spin"></i> Sinkronisasikan Target DDL`;
            applyBtn.onclick = async () => {
                await uiAlert('Definisi DDL target untuk ' + objName + ' berhasil disinkronkan dengan Source DB!');
                closeSchemaDiffModal();
                markObjectAsSynced(objName);
            };
            applyBtn.style.display = 'inline-block';
        }
    }

    // Show modal
    modal.classList.add('active');
}

function closeSchemaDiffModal() {
    const modal = document.getElementById('schema-diff-modal');
    if (modal) {
        modal.classList.remove('active');
        const modalContent = modal.querySelector('.modal-content');
        if (modalContent) modalContent.classList.remove('maximized');
        const maximizeBtn = document.getElementById('btn-schema-diff-maximize');
        if (maximizeBtn) {
            maximizeBtn.innerHTML = `<i class="fa-solid fa-maximize"></i>`;
            maximizeBtn.title = `Maksimalkan Ukuran`;
        }
    }
}

function toggleSchemaDiffMaximize() {
    const modal = document.getElementById('schema-diff-modal');
    if (!modal) return;
    const modalContent = modal.querySelector('.modal-content');
    const maximizeBtn = document.getElementById('btn-schema-diff-maximize');
    if (!modalContent || !maximizeBtn) return;

    modalContent.classList.toggle('maximized');
    
    if (modalContent.classList.contains('maximized')) {
        maximizeBtn.innerHTML = `<i class="fa-solid fa-minimize"></i>`;
        maximizeBtn.title = `Pulihkan Ukuran`;
    } else {
        maximizeBtn.innerHTML = `<i class="fa-solid fa-maximize"></i>`;
        maximizeBtn.title = `Maksimalkan Ukuran`;
    }

    // Force layout calculation for Monaco Diff Editor after the modal transition
    if (schemaDiffEditor) {
        setTimeout(() => {
            schemaDiffEditor.layout();
        }, 220);
    }
}

function initMonacoDiffEditor(originalCode, modifiedCode) {
    const container = document.getElementById('schema-diff-monaco-container');
    const hasEditorDom = container && container.querySelector('.monaco-editor');
    
    if (schemaDiffEditor && !hasEditorDom) {
        try {
            schemaDiffEditor.dispose();
        } catch (e) {}
        schemaDiffEditor = null;
    }

    if (schemaDiffEditor) {
        // Create new SQL models
        const originalModel = monaco.editor.createModel(originalCode, 'sql');
        const modifiedModel = monaco.editor.createModel(modifiedCode, 'sql');
        
        // Dispose old models to prevent memory leak
        const oldModels = schemaDiffEditor.getModel();
        if (oldModels) {
            if (oldModels.original) oldModels.original.dispose();
            if (oldModels.modified) oldModels.modified.dispose();
        }
        
        schemaDiffEditor.setModel({
            original: originalModel,
            modified: modifiedModel
        });
        
        setTimeout(() => {
            schemaDiffEditor.layout();
        }, 50);
        return;
    }

    if (schemaDiffEditorInitializing) {
        return;
    }

    if (typeof require === 'undefined') {
        console.error("Monaco loader is not loaded yet.");
        return;
    }

    schemaDiffEditorInitializing = true;

    require.config({ paths: { vs: 'lib/monaco-editor/min/vs' } });
    
    require(['vs/editor/editor.main'], function() {
        schemaDiffEditorInitializing = false;

        if (schemaDiffEditor) return;

        const container = document.getElementById('schema-diff-monaco-container');
        if (!container) return;

        container.innerHTML = ''; // Clear container

        const originalModel = monaco.editor.createModel(originalCode, 'sql');
        const modifiedModel = monaco.editor.createModel(modifiedCode, 'sql');

        schemaDiffEditor = monaco.editor.createDiffEditor(container, {
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'Consolas, Monaco, monospace',
            lineHeight: 18,
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            scrollbar: {
                vertical: 'auto',
                horizontal: 'auto'
            }
        });

        schemaDiffEditor.setModel({
            original: originalModel,
            modified: modifiedModel
        });
    });
}

// ── Query Console Mock Logic ──────────────────────────────────────────────
const queryConsoleDummyResults = {
    "dbo.Customers": {
        headers: ["Id", "CustomerName", "EmailAddress", "Balance", "IsActive"],
        rows: [
            [1, "Rasimin", "rasimin@hibank.co.id", 50000000.00, "True"],
            [2, "Budi", "budi@qnb.co.id", 12500000.50, "True"],
            [3, "Siti", "siti@bankqnb.co.id", 0.00, "False"],
            [4, "Agus", "agus@hibank.co.id", 8750000.00, "True"],
            [5, "Dewi", "dewi@hibank.co.id", 150000000.00, "True"]
        ]
    },
    "dbo.Orders": {
        headers: ["OrderId", "CustomerId", "OrderDate", "TotalAmount", "Status"],
        rows: [
            [101, 1, "2026-05-10 10:30:15", 1500000.00, "PAID"],
            [102, 2, "2026-05-12 14:22:10", 350000.00, "SHIPPED"],
            [103, 1, "2026-05-15 09:12:00", 2400000.00, "PAID"],
            [104, 4, "2026-05-18 16:45:30", 120000.00, "PENDING"],
            [105, 5, "2026-05-20 11:05:00", 890000.00, "CANCELLED"]
        ]
    }
};

async function runQueryConsole() {
    const runningTabId = queryConsoleActiveTabId;
    let queryText = '';
    if (queryConsoleEditor) {
        const selection = queryConsoleEditor.getSelection();
        if (selection && !selection.isEmpty()) {
            queryText = queryConsoleEditor.getModel().getValueInRange(selection);
        } else {
            queryText = queryConsoleEditor.getValue();
        }
    }
    queryText = (queryText || '').trim();
    if (!queryText) {
        await uiAlert("Harap masukkan query SQL!");
        return;
    }

    const resultsBox = document.getElementById('query-results-box');
    const resultsContainer = document.getElementById('query-results-container');
    const statusText = document.getElementById('query-status-text');
    const rowsCount = document.getElementById('query-rows-count');
    const executeBtn = document.getElementById('btn-execute-query');

    const loadingHtml = `
        <span style="display: inline-flex; align-items: center; gap: 0.5rem;">
            <i class="fa-solid fa-spinner fa-spin"></i> Mengeksekusi kueri...
            <button class="btn" onclick="cancelQueryConsole()" style="background: rgba(244, 63, 94, 0.15); border: 1px solid rgba(244, 63, 94, 0.4); color: #f43f5e; height: 22px; padding: 0 0.5rem; font-size: 0.72rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 0.25rem; cursor: pointer; transition: all 0.15s ease;" onmouseover="this.style.background='rgba(244,63,94,0.3)'" onmouseout="this.style.background='rgba(244,63,94,0.15)'" title="Batalkan eksekusi kueri yang sedang berjalan">
                <i class="fa-solid fa-circle-stop" style="font-size: 0.7rem;"></i> Cancel
            </button>
        </span>
    `;

    // Set loading state on active UI if it's the running tab
    if (queryConsoleActiveTabId === runningTabId) {
        if (statusText) {
            statusText.innerHTML = loadingHtml;
            statusText.style.color = 'var(--accent-teal)';
        }
        if (rowsCount) rowsCount.textContent = "";
        if (resultsBox) resultsBox.style.display = 'block';
        if (resultsContainer) resultsContainer.innerHTML = "";
    }

    // Save executing state to running tab
    const runningTab = queryConsoleTabs.find(t => t.id === runningTabId);
    if (runningTab) {
        runningTab.isResultsBoxVisible = true;
        runningTab.statusTextHtml = loadingHtml;
        runningTab.statusTextColor = 'var(--accent-teal)';
        runningTab.rowsCountText = '';
        runningTab.resultsContainerHtml = '';
    }

    if (executeBtn) {
        executeBtn.disabled = true;
        executeBtn.style.opacity = '0.6';
    }

    // Cancel any existing running query
    if (queryConsoleAbortController) {
        queryConsoleAbortController.abort();
    }
    queryConsoleAbortController = new AbortController();

    try {
        const payload = {
            ServerName: queryConsoleActiveServer,
            Authentication: queryConsoleActiveAuth,
            Login: queryConsoleActiveLogin,
            Password: queryConsoleActivePassword,
            Database: queryConsoleActiveDatabase,
            QueryText: queryText
        };

        const res = await fetch(`${API_BASE}/query/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: queryConsoleAbortController.signal
        });

        if (!res.ok) throw new Error("API Error: " + await res.text());
        const data = await res.json();

        if (!data.Success) {
            const errMsg = data.Message || 'Kesalahan eksekusi SQL';
            const msgs = [`Msg 0, Level 16, State 1\n${errMsg}`];
            const execTime = data.ExecutionTimeMs || 0;
            const msgHtml = getQueryMessagesHtml(msgs, execTime, true);

            const tabData = {
                results: [],
                lastQueryResults: null,
                isResultsBoxVisible: true,
                statusTextHtml: 'Error: ' + errMsg,
                statusTextColor: '#f43f5e',
                rowsCountText: 'Gagal',
                resultsContainerHtml: '',
                messagesHtml: msgHtml,
                messagesBadgeText: '1',
                messagesBadgeDisplay: 'inline',
                activeConsoleTab: 'messages'
            };

            saveQueryRunResult(runningTabId, tabData);

            if (queryConsoleActiveTabId === runningTabId) {
                if (statusText) {
                    statusText.textContent = tabData.statusTextHtml;
                    statusText.style.color = tabData.statusTextColor;
                }
                if (rowsCount) rowsCount.textContent = tabData.rowsCountText;
                if (resultsContainer) resultsContainer.innerHTML = '';
                renderQueryMessages(msgs, execTime, true);
                switchQueryResultsTab('messages');
            }
            return;
        }

        const tables = data.Tables || [];
        if (tables.length === 0 && data.Headers && data.Rows) {
            tables.push({ Headers: data.Headers, Rows: data.Rows });
        }

        // ── Handle PRINT messages ──────────────────────────────────────────
        const printMessages = data.PrintMessages || [];
        const msgHtml = getQueryMessagesHtml(printMessages, data.ExecutionTimeMs, false);

        let containerHtml = '';
        if (tables.length > 1) {
            containerHtml += `<div class="query-results-tabs">`;
            tables.forEach((table, index) => {
                const rowCountText = table.Rows.length === 0 ? '0 baris' : `${table.Rows.length} baris`;
                const isFirst = index === 0 ? 'active' : '';
                containerHtml += `
                    <button class="query-tab-btn ${isFirst}" data-tab-idx="${index}" onclick="switchQueryTab(${index})">
                        <i class="fa-solid fa-table"></i> Hasil ${index + 1} (${rowCountText})
                    </button>
                `;
            });
            containerHtml += `</div>`;
        }

        tables.forEach((table, index) => {
            const isHidden = (tables.length > 1 && index > 0) ? 'style="display: none;"' : '';
            containerHtml += `
                <div class="query-results-grid-wrapper query-grid-wrapper" id="query-grid-wrapper-${index}" ${isHidden}>
                    <table class="mapper-table query-results-table" id="query-results-table-${index}" style="margin-bottom: 0;">
                        <thead>
                            <tr>${table.Headers.map(h => `<th style="position: relative;">${escapeHtml(h)}<div class="resizer"></div></th>`).join('')}</tr>
                        </thead>
                        <tbody>
                            ${table.Rows.length === 0 
                                ? `<tr><td colspan="${table.Headers.length}" style="text-align: center; color: var(--text-muted);">Tidak ada baris yang dikembalikan.</td></tr>`
                                : table.Rows.map(row => 
                                    `<tr>${row.map(cell => {
                                        if (cell === null) {
                                            return `<td title="NULL"><span style="color: rgba(255,255,255,0.15); font-style: italic;">NULL</span></td>`;
                                        }
                                        const strVal = cell.toString();
                                        return `<td title="${escapeHtml(strVal)}">${escapeHtml(strVal)}</td>`;
                                    }).join('')}</tr>`
                                ).join('')
                            }
                        </tbody>
                    </table>
                </div>
            `;
        });

        const isTruncated = tables.some(t => t.IsTruncated || t.isTruncated);
        let statusTextHtml = '';
        let statusTextColor = '';
        if (isTruncated) {
            statusTextHtml = `<i class="fa-solid fa-triangle-exclamation" style="color: var(--accent-orange, #fb923c);"></i> Kueri dijalankan (Hasil dibatasi)`;
            statusTextColor = 'var(--accent-orange, #fb923c)';
        } else {
            statusTextHtml = 'Kueri berhasil dijalankan.';
            statusTextColor = 'var(--accent-teal)';
        }

        let rowsCountText = '';
        if (tables.length > 1) {
            const totalRows = tables.reduce((acc, t) => acc + t.Rows.length, 0);
            rowsCountText = `${tables.length} tabel dikembalikan (total ${totalRows} baris) dalam ${data.ExecutionTimeMs}ms`;
        } else if (tables.length === 1) {
            const rowCount = tables[0]?.Rows.length ?? 0;
            rowsCountText = `${rowCount} baris (${data.ExecutionTimeMs}ms)`;
        } else {
            rowsCountText = `${data.ExecutionTimeMs}ms`;
        }

        if (isTruncated) {
            rowsCountText += ` <span class="query-warning-badge" style="background: rgba(251, 146, 60, 0.15); color: #fb923c; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-left: 8px; font-weight: bold; border: 1px solid rgba(251, 146, 60, 0.3);" title="Hasil dibatasi untuk mencegah browser hang. Silakan tambahkan TOP atau filter WHERE pada kueri Anda."><i class="fa-solid fa-triangle-exclamation"></i> Hasil Dibatasi</span>`;
        }

        const activeConsoleTab = tables.length > 0 ? 'results' : (printMessages.length > 0 ? 'messages' : 'results');

        const tabData = {
            results: tables,
            lastQueryResults: tables[0] ? { Headers: tables[0].Headers, Rows: tables[0].Rows } : null,
            isResultsBoxVisible: true,
            statusTextHtml: statusTextHtml,
            statusTextColor: statusTextColor,
            rowsCountText: rowsCountText,
            resultsContainerHtml: containerHtml,
            messagesHtml: msgHtml,
            messagesBadgeText: printMessages.length > 0 ? printMessages.length : '',
            messagesBadgeDisplay: printMessages.length > 0 ? 'inline' : 'none',
            activeConsoleTab: activeConsoleTab
        };

        saveQueryRunResult(runningTabId, tabData);

        if (queryConsoleActiveTabId === runningTabId) {
            if (statusText) {
                statusText.innerHTML = tabData.statusTextHtml;
                statusText.style.color = tabData.statusTextColor;
            }
            if (rowsCount) rowsCount.innerHTML = tabData.rowsCountText;
            if (resultsContainer) resultsContainer.innerHTML = tabData.resultsContainerHtml;

            // Initialize drag-resize columns on all rendered tables
            document.querySelectorAll('.query-results-table').forEach(tbl => {
                initTableResizers(tbl);
            });

            // Sync global cache variables
            window.queryConsoleAllResults = tables;
            window.lastQueryResults = tabData.lastQueryResults;

            // Render messages
            renderQueryMessages(printMessages, data.ExecutionTimeMs, false);

            switchQueryResultsTab(activeConsoleTab);
        }
    } catch (err) {
        const isAbort = err.name === 'AbortError';
        const statusTextStr = isAbort ? 'Eksekusi kueri dibatalkan oleh pengguna.' : 'Error: ' + err.message;
        const statusColorStr = isAbort ? 'var(--text-muted, #5d7290)' : '#f43f5e';
        const rowsCountStr = isAbort ? 'Dibatalkan' : 'Gagal';
        const msgs = [isAbort ? 'Query dibatalkan oleh pengguna.' : err.message];
        const msgHtml = getQueryMessagesHtml(msgs, 0, !isAbort);

        const tabData = {
            results: [],
            lastQueryResults: null,
            isResultsBoxVisible: true,
            statusTextHtml: statusTextStr,
            statusTextColor: statusColorStr,
            rowsCountText: rowsCountStr,
            resultsContainerHtml: '',
            messagesHtml: msgHtml,
            messagesBadgeText: '1',
            messagesBadgeDisplay: 'inline',
            activeConsoleTab: 'messages'
        };

        saveQueryRunResult(runningTabId, tabData);

        if (queryConsoleActiveTabId === runningTabId) {
            if (statusText) {
                statusText.textContent = statusTextStr;
                statusText.style.color = statusColorStr;
            }
            if (rowsCount) rowsCount.textContent = rowsCountStr;
            if (resultsContainer) resultsContainer.innerHTML = '';
            renderQueryMessages(msgs, 0, !isAbort);
            switchQueryResultsTab('messages');
        }
    } finally {
        queryConsoleAbortController = null;
        if (executeBtn) {
            executeBtn.disabled = false;
            executeBtn.style.opacity = '1';
        }
    }
}

function cancelQueryConsole() {
    if (queryConsoleAbortController) {
        queryConsoleAbortController.abort();
        queryConsoleAbortController = null;
    }
}

function switchQueryTab(index) {
    document.querySelectorAll('.query-tab-btn').forEach(btn => {
        if (parseInt(btn.getAttribute('data-tab-idx')) === index) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    document.querySelectorAll('.query-grid-wrapper').forEach(wrapper => {
        const idStr = `query-grid-wrapper-${index}`;
        if (wrapper.id === idStr) {
            wrapper.style.display = 'block';
        } else {
            wrapper.style.display = 'none';
        }
    });

    if (window.queryConsoleAllResults && window.queryConsoleAllResults[index]) {
        const activeTable = window.queryConsoleAllResults[index];
        window.lastQueryResults = {
            Headers: activeTable.Headers,
            Rows: activeTable.Rows
        };
        
        const rowsCount = document.getElementById('query-rows-count');
        if (rowsCount) {
            const msMatch = rowsCount.textContent.match(/\((\d+ms)\)/);
            const msStr = msMatch ? ` (${msMatch[1]})` : "";
            rowsCount.innerHTML = `Tabel ${index + 1}: ${activeTable.Rows.length} baris ditampilkan${msStr}`;
            if (activeTable.IsTruncated || activeTable.isTruncated) {
                rowsCount.innerHTML += ` <span class="query-warning-badge" style="background: rgba(251, 146, 60, 0.15); color: #fb923c; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-left: 8px; font-weight: bold; border: 1px solid rgba(251, 146, 60, 0.3);" title="Hasil dibatasi untuk mencegah browser hang. Silakan tambahkan TOP atau filter WHERE pada kueri Anda."><i class="fa-solid fa-triangle-exclamation"></i> Hasil Dibatasi</span>`;
            }
        }

        // Sync to active tab state
        const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
        if (activeTab) {
            activeTab.activeSubResultTabIdx = index;
            activeTab.lastQueryResults = window.lastQueryResults;
            if (rowsCount) {
                activeTab.rowsCountText = rowsCount.innerHTML;
            }
        }
    }
}

function clearQueryConsole() {
    if (queryConsoleEditor) {
        queryConsoleEditor.setValue('');
    }
    const box = document.getElementById('query-results-box');
    if (box) box.style.display = 'none';
    // Reset messages tab
    const msgContent = document.getElementById('query-messages-content');
    if (msgContent) msgContent.innerHTML = '';
    const badge = document.getElementById('query-tab-messages-badge');
    if (badge) badge.style.display = 'none';
    window.lastQueryResults = null;
    window.queryConsoleAllResults = [];

    // Clear active tab's preserved results
    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (activeTab) {
        activeTab.value = '';
        activeTab.results = [];
        activeTab.lastQueryResults = null;
        activeTab.statusTextHtml = '';
        activeTab.statusTextColor = '';
        activeTab.rowsCountText = '';
        activeTab.resultsContainerHtml = '';
        activeTab.messagesHtml = '';
        activeTab.messagesBadgeText = '';
        activeTab.messagesBadgeDisplay = 'none';
        activeTab.activeConsoleTab = 'results';
        activeTab.activeSubResultTabIdx = 0;
        activeTab.isResultsBoxVisible = false;
    }
}

// ── Results / Messages tab switcher (SSMS-style) ──────────────────────────
function switchQueryResultsTab(tabName) {
    const resultsPanel = document.getElementById('query-results-container');
    const messagesPanel = document.getElementById('query-messages-container');
    const tabResults = document.getElementById('query-tab-results');
    const tabMessages = document.getElementById('query-tab-messages');

    if (!resultsPanel || !messagesPanel || !tabResults || !tabMessages) return;

    if (tabName === 'results') {
        resultsPanel.style.display = 'block';
        messagesPanel.style.display = 'none';
        // Active style for Results
        tabResults.style.background = 'rgba(45, 212, 191, 0.12)';
        tabResults.style.color = 'var(--accent-teal)';
        tabResults.style.borderTop = '2px solid var(--accent-teal)';
        // Inactive style for Messages
        tabMessages.style.background = 'transparent';
        tabMessages.style.color = 'var(--text-muted)';
        tabMessages.style.borderTop = '2px solid transparent';
    } else {
        resultsPanel.style.display = 'none';
        messagesPanel.style.display = 'block';
        // Active style for Messages
        tabMessages.style.background = 'rgba(251, 146, 60, 0.08)';
        tabMessages.style.color = '#fb923c';
        tabMessages.style.borderTop = '2px solid #fb923c';
        // Inactive style for Results
        tabResults.style.background = 'transparent';
        tabResults.style.color = 'var(--text-muted)';
        tabResults.style.borderTop = '2px solid transparent';
    }

    // Sync to active tab state
    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (activeTab) {
        activeTab.activeConsoleTab = tabName;
    }
}

// ── Render PRINT messages to Messages tab ─────────────────────────────────
function renderQueryMessages(messages, executionTimeMs, isError) {
    const msgContent = document.getElementById('query-messages-content');
    const badge = document.getElementById('query-tab-messages-badge');
    if (!msgContent) return;

    const html = getQueryMessagesHtml(messages, executionTimeMs, isError);
    msgContent.innerHTML = html;
    
    // Show badge with count if there are print messages
    if (badge) {
        if (messages && messages.length > 0) {
            badge.textContent = messages.length;
            badge.style.display = 'inline';
        } else {
            badge.style.display = 'none';
        }
    }
}

async function exportQueryResults() {
    const data = window.lastQueryResults;
    if (!data || !data.Headers || !data.Rows || data.Rows.length === 0) {
        await uiAlert("Tidak ada data hasil kueri untuk diekspor!");
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";
    // Headers
    csvContent += data.Headers.map(h => `"${h.replace(/"/g, '""')}"`).join(",") + "\n";
    // Rows
    data.Rows.forEach(row => {
        csvContent += row.map(cell => {
            const strVal = cell === null ? "" : cell.toString();
            return `"${strVal.replace(/"/g, '""')}"`;
        }).join(",") + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `query_results_${queryConsoleActiveDatabase}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

async function copyQueryResultGrid() {
    const data = window.lastQueryResults;
    if (!data || !data.Headers || !data.Rows || data.Rows.length === 0) {
        await uiAlert("Tidak ada data hasil kueri untuk disalin!");
        return;
    }

    // Mengonversi data ke format tab-separated (TSV) agar mudah ditempel di Excel / editor teks
    let textContent = "";
    
    // Headers
    textContent += data.Headers.join("\t") + "\n";
    
    // Rows
    data.Rows.forEach(row => {
        textContent += row.map(cell => cell === null ? "NULL" : cell.toString()).join("\t") + "\n";
    });

    navigator.clipboard.writeText(textContent)
        .then(async () => {
            await uiAlert("Hasil kueri berhasil disalin ke clipboard beserta header!");
        })
        .catch(async (err) => {
            console.error("Gagal menyalin hasil kueri: ", err);
            await uiAlert("Gagal menyalin data: " + err.message);
        });
}

function initTableResizers(table) {
    if (!table) return;

    // Cap initial column widths and freeze layout in fixed mode to enable ellipsis text-clipping
    const cols = table.querySelectorAll('th');
    cols.forEach(c => {
        const currentWidth = c.offsetWidth;
        c.style.width = Math.min(250, Math.max(80, currentWidth)) + 'px';
    });
    table.style.tableLayout = 'fixed';

    const resizers = table.querySelectorAll('.resizer');
    resizers.forEach(resizer => {
        resizer.addEventListener('mousedown', function(e) {
            e.preventDefault();
            e.stopPropagation();

            const th = e.target.parentElement;
            const startWidth = th.offsetWidth;
            const startX = e.clientX;

            resizer.classList.add('dragging');

            function onMouseMove(moveEvent) {
                const width = startWidth + (moveEvent.clientX - startX);
                th.style.width = Math.max(60, width) + 'px';
            }

            function onMouseUp() {
                resizer.classList.remove('dragging');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
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

                html += `
                    <div class="se-item" data-name="${escapedName.toLowerCase()}" onclick="showSchemaDefinition('${jsName}','${jsType}','${jsCreated}','${jsModified}')" title="${escapedName}">
                        <i class="fa-solid ${grp.icon} se-item-icon ${grp.typeClass}"></i>
                        <span class="se-item-name">${escapedName}</span>
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
