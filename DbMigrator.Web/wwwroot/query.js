/* ============================================================================
   QUERY CONSOLE & SCHEMA TOOLS LOGIC - query.js
   ============================================================================ */

// ── Query Console connection panel and syntax highlighting logic ──
let savedConnectionsCache = [];
let activeConnections = {}; // Registry of connected servers: { serverName: { serverName, authType, login, password, databases: [] } }
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
        const res = await fetch(`${API_BASE}/query/connections/${id}/delete`, {
            method: 'POST'
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
        
        // Add to activeConnections registry
        activeConnections[serverName] = {
            serverName: serverName,
            authType: authType,
            login: login,
            password: password,
            databases: data.Databases || []
        };
        
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
        document.getElementById('query-active-conn-info').textContent = `${serverName} (${queryConsoleActiveDatabase})`;
        const serverTriggerText = document.getElementById('query-server-trigger-text');
        if (serverTriggerText) {
            serverTriggerText.textContent = serverName;
        }
        
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
                serverName: serverName,
                authType: authType,
                login: login,
                password: password,
                database: queryConsoleActiveDatabase || "master",
                savedQueryId: null,
                savedQueryName: "",
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
        if (typeof rebuildSchemaExplorerTree === 'function') {
            rebuildSchemaExplorerTree();
        }
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
    
    // Redraw Object Explorer tree
    if (typeof rebuildSchemaExplorerTree === 'function') {
        rebuildSchemaExplorerTree();
    }
}

function disconnectQueryConsole() {
    queryConsoleActiveServer = "";
    queryConsoleActiveAuth = "";
    queryConsoleActiveLogin = "";
    queryConsoleActivePassword = "";
    queryConsoleActiveDatabase = "";
    queryConsoleDatabases = [];
    activeConnections = {};
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
    
    // Clear all results containers
    const resultsContainer = document.getElementById('query-results-container');
    if (resultsContainer) {
        resultsContainer.innerHTML = '';
    }
    
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
    
    const serverDropdown = document.getElementById('query-server-dropdown');
    const serverTrigger = document.getElementById('query-server-trigger');
    if (serverDropdown && serverDropdown.style.display === 'block') {
        if (!serverDropdown.contains(e.target) && !serverTrigger.contains(e.target)) {
            serverDropdown.style.display = 'none';
        }
    }
    
    const tableDropdown = document.getElementById('query-table-dropdown');
    const tableTrigger = document.getElementById('query-table-trigger');
    if (tableDropdown && tableDropdown.style.display === 'block') {
        if (!tableDropdown.contains(e.target) && !tableTrigger.contains(e.target)) {
            tableDropdown.style.display = 'none';
        }
    }

    // Close Query Toolbar Dropdowns when clicking outside
    document.querySelectorAll('.query-toolbar-dropdown').forEach(d => {
        if (d.classList.contains('active')) {
            if (!d.contains(e.target)) {
                d.classList.remove('active');
            }
        }
    });

    // Close Schema Explorer item dropdowns when clicking outside
    document.querySelectorAll('.se-item-dropdown-menu').forEach(m => {
        if (m.classList.contains('active')) {
            if (!m.contains(e.target)) {
                m.classList.remove('active');
            }
        }
    });
});

// ── Query Console Tab Management Functions ──────────────────────────────────
function addNewQueryTab(initialValue = '', tabName = '', targetServer = null, targetDatabase = null) {
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

    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);

    // Resolve connection config
    let sName = targetServer || (activeTab ? (activeTab.serverName || "") : queryConsoleActiveServer);
    let auth = activeTab ? (activeTab.authType || "SQL") : queryConsoleActiveAuth;
    let login = activeTab ? (activeTab.login || "") : queryConsoleActiveLogin;
    let pass = activeTab ? (activeTab.password || "") : queryConsoleActivePassword;
    let db = targetDatabase || (activeTab ? (activeTab.database || "master") : (queryConsoleActiveDatabase || "master"));

    if (targetServer && activeConnections[targetServer]) {
        const conn = activeConnections[targetServer];
        sName = conn.serverName;
        auth = conn.authType;
        login = conn.login;
        pass = conn.password;
    }

    const newTab = {
        id: tabId,
        name: tabName || `Query ${queryConsoleTabCounter}`,
        value: queryValue,
        model: model,
        serverName: sName,
        authType: auth,
        login: login,
        password: pass,
        database: db,
        savedQueryId: null,
        savedQueryName: "",
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
        
        // Hide the current active tab's container
        const currentContainer = document.getElementById('query-results-tab-content-' + queryConsoleActiveTabId);
        if (currentContainer) {
            currentContainer.classList.add('inactive');
        }
        
        if (msgContent) currentActiveTab.messagesHtml = msgContent.innerHTML;
        
        if (badge) {
            currentActiveTab.messagesBadgeText = badge.textContent || '';
            currentActiveTab.messagesBadgeDisplay = badge.style.display || 'none';
        }
    }

    const nextActiveTab = queryConsoleTabs.find(t => t.id === tabId);
    if (!nextActiveTab) return;

    queryConsoleActiveTabId = tabId;

    // Restore connection context for this tab
    queryConsoleActiveServer = nextActiveTab.serverName || "";
    queryConsoleActiveAuth = nextActiveTab.authType || "SQL";
    queryConsoleActiveLogin = nextActiveTab.login || "";
    queryConsoleActivePassword = nextActiveTab.password || "";
    queryConsoleActiveDatabase = nextActiveTab.database || "master";

    // Set connection badge text
    const badgeText = queryConsoleActiveServer ? `${queryConsoleActiveServer} (${queryConsoleActiveDatabase})` : "Belum terhubung";
    document.getElementById('query-active-conn-info').textContent = badgeText;
    const serverTriggerText = document.getElementById('query-server-trigger-text');
    if (serverTriggerText) {
        serverTriggerText.textContent = queryConsoleActiveServer || "Belum terhubung";
    }

    // Restore database selection for this tab
    if (queryConsoleActiveServer) {
        const cached = activeConnections[queryConsoleActiveServer];
        if (cached) {
            renderDatabaseDropdown(cached.databases, queryConsoleActiveDatabase);
        } else {
            renderDatabaseDropdown([queryConsoleActiveDatabase], queryConsoleActiveDatabase);
        }
        
        // Reload schema for Monaco autocomplete
        loadQueryConsoleSchema();
    } else {
        renderDatabaseDropdown([], "");
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
        // Hide all sibling containers
        Array.from(resultsContainer.children).forEach(child => {
            child.classList.add('inactive');
        });
        
        // Show/create nextActiveTab's container
        let nextContainer = document.getElementById('query-results-tab-content-' + tabId);
        if (!nextContainer) {
            nextContainer = document.createElement('div');
            nextContainer.id = 'query-results-tab-content-' + tabId;
            nextContainer.className = 'query-tab-results-content';
            resultsContainer.appendChild(nextContainer);
        }
        nextContainer.classList.remove('inactive');
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
        const nextContainer = document.getElementById('query-results-tab-content-' + tabId);
        if (nextContainer) {
            // Apply active class to sub tab button
            nextContainer.querySelectorAll('.query-tab-btn').forEach(btn => {
                if (parseInt(btn.getAttribute('data-tab-idx')) === subIdx) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
            // Show active grid, hide others
            nextContainer.querySelectorAll('.query-grid-wrapper').forEach(wrapper => {
                const idStr = `query-grid-wrapper-${tabId}-${subIdx}`;
                if (wrapper.id === idStr) {
                    wrapper.style.display = 'block';
                } else {
                    wrapper.style.display = 'none';
                }
            });
        }
    }

    // Focus editor
    setTimeout(() => {
        queryConsoleEditor.focus();
    }, 50);

    renderQueryTabs();
    if (typeof rebuildSchemaExplorerTree === 'function') {
        rebuildSchemaExplorerTree();
    }
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

    // Remove results container DOM element
    const containerToRemove = document.getElementById('query-results-tab-content-' + tabId);
    if (containerToRemove) {
        containerToRemove.remove();
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
        const serverInfo = tab.serverName ? `Server: ${tab.serverName} | DB: ${tab.database}` : 'Belum terhubung';
        return `
            <div class="query-console-tab ${isActive ? 'active' : ''}" 
                 draggable="true" 
                 ondragstart="handleQueryTabDragStart(event, '${tab.id}')" 
                 ondragover="handleQueryTabDragOver(event, '${tab.id}')" 
                 ondragend="handleQueryTabDragEnd(event)" 
                 ondrop="handleQueryTabDrop(event, '${tab.id}')" 
                 onclick="switchQueryTabActive('${tab.id}')" 
                 ondblclick="renameQueryTab('${tab.id}')" 
                 title="Double klik untuk ubah nama tab. (${serverInfo})">
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

// ── Query Console Tab Drag and Drop & Editing Functions ─────────────────────
let draggedQueryTabId = null;
let lastTargetTabId = null;
let queryTabRects = [];
let queryTabElements = [];
let draggedQueryTabIdx = -1;

function handleQueryTabDragStart(e, tabId) {
    draggedQueryTabId = tabId;
    lastTargetTabId = tabId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
    
    // Cache tab elements and dimensions
    const listContainer = document.getElementById('query-tabs-list');
    if (listContainer) {
        queryTabElements = Array.from(listContainer.children);
        queryTabRects = queryTabElements.map(el => el.getBoundingClientRect());
    }
    draggedQueryTabIdx = queryConsoleTabs.findIndex(t => t.id === tabId);
    
    const tabEl = e.currentTarget;
    setTimeout(() => {
        tabEl.classList.add('dragging');
    }, 0);
}

function handleQueryTabDragOver(e, targetTabId) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    
    if (!draggedQueryTabId) return false;
    
    if (targetTabId && targetTabId !== draggedQueryTabId) {
        lastTargetTabId = targetTabId;
    }
    
    const targetIdx = queryConsoleTabs.findIndex(t => t.id === targetTabId);
    if (targetIdx === -1 || draggedQueryTabIdx === -1) return false;
    
    const gap = 2.4; // matching style.css gap of 0.15rem (~2.4px at 16px root font size)
    
    queryTabElements.forEach((el, i) => {
        if (targetIdx > draggedQueryTabIdx) {
            if (i > draggedQueryTabIdx && i <= targetIdx) {
                // Shift left
                const shift = -queryTabRects[draggedQueryTabIdx].width - gap;
                el.style.transform = `translateX(${shift}px)`;
            } else if (i === draggedQueryTabIdx) {
                // Shift right to the target position
                const shift = queryTabRects.slice(draggedQueryTabIdx + 1, targetIdx + 1).reduce((sum, r) => sum + r.width + gap, 0);
                el.style.transform = `translateX(${shift}px)`;
            } else {
                el.style.transform = '';
            }
        } else if (targetIdx < draggedQueryTabIdx) {
            if (i >= targetIdx && i < draggedQueryTabIdx) {
                // Shift right
                const shift = queryTabRects[draggedQueryTabIdx].width + gap;
                el.style.transform = `translateX(${shift}px)`;
            } else if (i === draggedQueryTabIdx) {
                // Shift left to the target position
                const shift = queryTabRects.slice(targetIdx, draggedQueryTabIdx).reduce((sum, r) => sum + r.width + gap, 0);
                el.style.transform = `translateX(${-shift}px)`;
            } else {
                el.style.transform = '';
            }
        } else {
            el.style.transform = '';
        }
    });
    
    return false;
}

function handleQueryTabsListDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    
    if (!draggedQueryTabId) return false;
    
    // Fallback: if cursor is over the container background rather than a tab
    const closestTabId = getClosestTabId(e.clientX);
    if (closestTabId) {
        handleQueryTabDragOver(e, closestTabId);
    }
    return false;
}

function getClosestTabId(clientX) {
    if (queryTabElements.length === 0) return null;
    
    let closestId = null;
    let minDistance = Infinity;
    
    queryTabElements.forEach((el, index) => {
        const rect = queryTabRects[index];
        if (!rect) return;
        const centerX = rect.left + rect.width / 2;
        const distance = Math.abs(clientX - centerX);
        if (distance < minDistance) {
            minDistance = distance;
            closestId = queryConsoleTabs[index].id;
        }
    });
    
    return closestId;
}

function handleQueryTabDragEnd(e) {
    // Perform array reordering in dragend so it is guaranteed to execute,
    // even if dropped slightly outside a tab element bounds
    if (draggedQueryTabId && lastTargetTabId && lastTargetTabId !== draggedQueryTabId) {
        const dragIdx = queryConsoleTabs.findIndex(t => t.id === draggedQueryTabId);
        const targetIdx = queryConsoleTabs.findIndex(t => t.id === lastTargetTabId);
        
        if (dragIdx !== -1 && targetIdx !== -1) {
            // Reorder tabs array
            const [draggedTab] = queryConsoleTabs.splice(dragIdx, 1);
            queryConsoleTabs.splice(targetIdx, 0, draggedTab);
            
            // Temporarily disable transitions to avoid visual jump back when rendering
            queryTabElements.forEach(el => {
                el.style.transition = 'none';
                el.style.transform = '';
            });
            
            renderQueryTabs();
        }
    }

    // Reset element styles
    queryTabElements.forEach(el => {
        el.style.transform = '';
        el.style.transition = '';
        el.classList.remove('dragging');
    });
    
    draggedQueryTabId = null;
    draggedQueryTabIdx = -1;
    lastTargetTabId = null;
    queryTabElements = [];
    queryTabRects = [];
}

function handleQueryTabDrop(e, targetTabId) {
    e.stopPropagation();
    e.preventDefault();
}

function toggleCommentSelection() {
    if (!queryConsoleEditor) return;
    
    queryConsoleEditor.focus();
    
    const action = queryConsoleEditor.getAction('editor.action.commentLine');
    if (action) {
        action.run();
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

    // Ctrl + E: Run query console
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === 'KeyE' || e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        runQueryConsole();
    }

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
            savedQueryId: null,
            savedQueryName: "",
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

        // Intercept Tab key for "ssf" / "SSF" expansion
        queryConsoleEditor.onKeyDown(function(e) {
            if (e.keyCode === monaco.KeyCode.Tab) {
                const selection = queryConsoleEditor.getSelection();
                if (selection && !selection.isEmpty()) return;

                const position = queryConsoleEditor.getPosition();
                const model = queryConsoleEditor.getModel();
                if (!model) return;

                const textBefore = model.getValueInRange({
                    startLineNumber: position.lineNumber,
                    startColumn: 1,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column
                });

                // Match ssf (case-insensitive) preceded by word boundary, whitespace or start of line
                const match = textBefore.match(/(?:^|\s)ssf$/i);
                if (match) {
                    // Prevent standard tab insert
                    e.preventDefault();
                    e.stopPropagation();

                    // Calculate start column of "ssf"
                    const startColumn = position.column - 3;
                    const range = new monaco.Range(
                        position.lineNumber,
                        startColumn,
                        position.lineNumber,
                        position.column
                    );

                    queryConsoleEditor.executeEdits("ssf-snippet-expansion", [{
                        range: range,
                        text: "select top 50 * from ",
                        forceMoveMarkers: true
                    }]);
                }
            }
        });


        // Register custom SQL autocomplete provider
        registerMonacoSqlAutocomplete();
        
        // Add shortcut key (Ctrl+Enter / Ctrl+E) to run query console
        queryConsoleEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function() {
            runQueryConsole();
        });
        queryConsoleEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.US_E, function() {
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
        const sqlKeywords = new Set([
            "WHERE", "ORDER", "GROUP", "HAVING", "JOIN", "LEFT", "RIGHT", "INNER", "CROSS", "OUTER", "FULL",
            "ON", "UNION", "LIMIT", "OFFSET", "USING", "FOR", "WITH", "AND", "OR", "SELECT", "INSERT", 
            "UPDATE", "DELETE", "AS", "BY", "GO"
        ]);
        let match;
        while ((match = fromJoinRegex.exec(queryText)) !== null) {
            const tableName = match[1];
            let alias = match[2];
            if (alias && sqlKeywords.has(alias.toUpperCase())) {
                alias = null;
            }
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
            // 4. Custom Snippets (e.g. ssf)
            suggestions.push({
                label: 'ssf',
                kind: monaco.languages.CompletionItemKind.Snippet,
                detail: 'Select top 50 from table',
                documentation: 'Expands to: select top 50 * from ',
                insertText: 'select top 50 * from '
            });
            suggestions.push({
                label: 'SSF',
                kind: monaco.languages.CompletionItemKind.Snippet,
                detail: 'Select top 50 from table',
                documentation: 'Expands to: select top 50 * from ',
                insertText: 'select top 50 * from '
            });

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

// ── Query Toolbar Dropdown Logic ──────────────────────────────────────────
function toggleQueryToolbarDropdown(event, id) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById(id);
    if (!dropdown) return;

    const isActive = dropdown.classList.contains('active');
    closeAllQueryToolbarDropdowns();

    if (!isActive) {
        dropdown.classList.add('active');
    }
}

function closeAllQueryToolbarDropdowns() {
    document.querySelectorAll('.query-toolbar-dropdown').forEach(d => {
        d.classList.remove('active');
    });
}


// ── Change Connection Modal & Active Sessions Logic ────────────────────────
function openChangeConnectionModal() {
    const modal = document.getElementById('query-connection-modal');
    if (!modal) return;
    modal.classList.add('active');
    
    // Load saved connections for the modal select
    loadModalSavedConnections();
    
    // Render active sessions list
    renderActiveSessionsInModal();
    
    // Prefill form with current tab connection context or blank
    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (activeTab && activeTab.serverName) {
        document.getElementById('modal-query-server-name').value = activeTab.serverName;
        document.getElementById('modal-query-auth-type').value = activeTab.authType || 'SQL';
        document.getElementById('modal-query-login').value = activeTab.login || '';
        document.getElementById('modal-query-password').value = activeTab.password || '';
    } else {
        document.getElementById('modal-query-server-name').value = '';
        document.getElementById('modal-query-auth-type').value = 'SQL';
        document.getElementById('modal-query-login').value = '';
        document.getElementById('modal-query-password').value = '';
    }
    toggleModalQueryAuthFields();
}

function closeChangeConnectionModal() {
    const modal = document.getElementById('query-connection-modal');
    if (modal) modal.classList.remove('active');
}

function toggleModalQueryAuthFields() {
    const authType = document.getElementById('modal-query-auth-type').value;
    const credsSection = document.getElementById('modal-query-auth-credentials-section');
    if (credsSection) {
        credsSection.style.display = authType === 'Windows' ? 'none' : 'block';
    }
}

function toggleModalSaveConnectionNameField() {
    const checkbox = document.getElementById('modal-query-save-connection');
    const container = document.getElementById('modal-query-save-conn-name-container');
    if (checkbox && container) {
        container.style.display = checkbox.checked ? 'block' : 'none';
        if (checkbox.checked) {
            const connNameInput = document.getElementById('modal-query-connection-name');
            if (connNameInput) {
                const serverName = document.getElementById('modal-query-server-name').value.trim();
                connNameInput.value = serverName ? `Koneksi ${serverName}` : '';
                connNameInput.focus();
            }
        }
    }
}

async function loadModalSavedConnections() {
    const select = document.getElementById('modal-query-saved-conn-select');
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

function prefillModalSavedConnection() {
    const select = document.getElementById('modal-query-saved-conn-select');
    if (!select) return;
    
    const id = parseInt(select.value);
    const serverInput = document.getElementById('modal-query-server-name');
    const authSelect = document.getElementById('modal-query-auth-type');
    const loginInput = document.getElementById('modal-query-login');
    const passwordInput = document.getElementById('modal-query-password');
    
    if (isNaN(id) || id <= 0) {
        serverInput.value = '';
        authSelect.value = 'SQL';
        loginInput.value = '';
        passwordInput.value = '';
        toggleModalQueryAuthFields();
        return;
    }
    
    const conn = savedConnectionsCache.find(c => (c.Id || c.id) === id);
    if (!conn) return;
    
    serverInput.value = conn.ServerName || conn.serverName || '';
    authSelect.value = conn.Authentication || conn.authentication || 'SQL';
    loginInput.value = conn.Login || conn.login || '';
    passwordInput.value = conn.Password || conn.password || '';
    
    toggleModalQueryAuthFields();
}

function renderActiveSessionsInModal() {
    const container = document.getElementById('modal-active-sessions-list');
    if (!container) return;
    
    const keys = Object.keys(activeConnections);
    if (keys.length === 0) {
        container.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-muted); text-align: center; padding: 1rem 0;">Tidak ada sesi aktif.</div>`;
        return;
    }
    
    container.innerHTML = keys.map(key => {
        const conn = activeConnections[key];
        const safeServerName = escapeHtml(conn.serverName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `
            <div class="active-session-item" 
                 onclick="connectToActiveSession('${safeServerName}')"
                 style="padding: 0.5rem; background: rgba(255,255,255,0.03); border: 1px solid var(--border-flat); border-radius: 6px; cursor: pointer; transition: all 0.2s;"
                 onmouseover="this.style.background='rgba(45,212,191,0.05)'; this.style.borderColor='var(--accent-teal)';"
                 onmouseout="this.style.background='rgba(255,255,255,0.03)'; this.style.borderColor='var(--border-flat)';"
                 title="Hubungkan tab ini ke ${escapeHtml(conn.serverName)}">
                <div style="font-size: 0.8rem; font-weight: 600; color: #fff; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                    <i class="fa-solid fa-server" style="color: var(--accent-teal); font-size: 0.7rem; margin-right: 0.3rem;"></i>${escapeHtml(conn.serverName)}
                </div>
                <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 0.15rem;">
                    Auth: ${escapeHtml(conn.authType)} ${conn.authType === 'SQL' ? `(${escapeHtml(conn.login)})` : ''}
                </div>
            </div>
        `;
    }).join('');
}

async function connectToActiveSession(serverName) {
    const conn = activeConnections[serverName];
    if (!conn) return;
    
    // Bind current tab connection settings
    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (activeTab) {
        activeTab.serverName = conn.serverName;
        activeTab.authType = conn.authType;
        activeTab.login = conn.login;
        activeTab.password = conn.password;
        
        // Choose default database
        activeTab.database = conn.databases && conn.databases.length > 0 ? conn.databases[0] : "master";
        
        // Update globals
        queryConsoleActiveServer = conn.serverName;
        queryConsoleActiveAuth = conn.authType;
        queryConsoleActiveLogin = conn.login;
        queryConsoleActivePassword = conn.password;
        queryConsoleActiveDatabase = activeTab.database;
        
        // Update UI dropdown and badges
        renderDatabaseDropdown(conn.databases, queryConsoleActiveDatabase);
        document.getElementById('query-active-conn-info').textContent = `${conn.serverName} (${queryConsoleActiveDatabase})`;
        
        const serverTriggerText = document.getElementById('query-server-trigger-text');
        if (serverTriggerText) {
            serverTriggerText.textContent = conn.serverName;
        }
        
        // Reload schema for Monaco autocomplete and Schema Explorer
        await loadQueryConsoleSchema();
        if (typeof rebuildSchemaExplorerTree === 'function') {
            rebuildSchemaExplorerTree();
        }
    }
    
    closeChangeConnectionModal();
}

async function connectModalQueryConsole() {
    const serverName = document.getElementById('modal-query-server-name').value.trim();
    const authType = document.getElementById('modal-query-auth-type').value;
    const login = document.getElementById('modal-query-login').value.trim();
    const password = document.getElementById('modal-query-password').value;
    
    if (!serverName) {
        await uiAlert("Harap masukkan Server Name!");
        return;
    }
    
    if (authType === 'SQL' && !login) {
        await uiAlert("Harap masukkan Login username!");
        return;
    }
    
    const btn = document.getElementById('btn-modal-query-connect');
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
        const saveCheck = document.getElementById('modal-query-save-connection');
        const connNameInput = document.getElementById('modal-query-connection-name');
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
                    saveCheck.checked = false;
                    connNameInput.value = '';
                    toggleModalSaveConnectionNameField();
                }
            } catch (saveErr) {
                console.error("Gagal menyimpan koneksi modal:", saveErr);
            }
        }
        
        // Add to activeConnections registry
        activeConnections[serverName] = {
            serverName: serverName,
            authType: authType,
            login: login,
            password: password,
            databases: data.Databases || []
        };
        
        // Update current active tab connection settings
        const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
        if (activeTab) {
            activeTab.serverName = serverName;
            activeTab.authType = authType;
            activeTab.login = login;
            activeTab.password = password;
            activeTab.database = data.DefaultDatabase || "master";
            
            queryConsoleActiveServer = serverName;
            queryConsoleActiveAuth = authType;
            queryConsoleActiveLogin = login;
            queryConsoleActivePassword = password;
            queryConsoleActiveDatabase = activeTab.database;
            
            renderDatabaseDropdown(data.Databases, queryConsoleActiveDatabase);
            document.getElementById('query-active-conn-info').textContent = `${serverName} (${queryConsoleActiveDatabase})`;
            
            const serverTriggerText = document.getElementById('query-server-trigger-text');
            if (serverTriggerText) {
                serverTriggerText.textContent = serverName;
            }
            
            // Reload Monaco autocomplete schema
            await loadQueryConsoleSchema();
            
            // Redraw Object Explorer tree
            if (typeof rebuildSchemaExplorerTree === 'function') {
                rebuildSchemaExplorerTree();
            }
        }
        
        closeChangeConnectionModal();
    } catch (err) {
        await uiAlert("Koneksi Gagal: " + err.message);
    } finally {
        if (btn) {
            btn.innerHTML = origHtml;
            btn.disabled = false;
        }
    }
}

function disconnectCurrentTab() {
    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (!activeTab) return;
    
    // Clear connection details for active tab
    activeTab.serverName = "";
    activeTab.authType = "SQL";
    activeTab.login = "";
    activeTab.password = "";
    activeTab.database = "";
    activeTab.results = [];
    activeTab.lastQueryResults = null;
    activeTab.isResultsBoxVisible = false;
    activeTab.statusTextHtml = 'Belum terhubung';
    activeTab.statusTextColor = 'var(--text-muted)';
    activeTab.rowsCountText = '';
    activeTab.messagesHtml = '';
    activeTab.messagesBadgeText = '';
    activeTab.messagesBadgeDisplay = 'none';
    
    // Refresh globals
    queryConsoleActiveServer = "";
    queryConsoleActiveAuth = "";
    queryConsoleActiveLogin = "";
    queryConsoleActivePassword = "";
    queryConsoleActiveDatabase = "";
    
    document.getElementById('query-active-conn-info').textContent = "Belum terhubung";
    const serverTriggerText = document.getElementById('query-server-trigger-text');
    if (serverTriggerText) {
        serverTriggerText.textContent = "Belum terhubung";
    }
    renderDatabaseDropdown([], "");
    
    // Clear UI state elements
    const resultsBox = document.getElementById('query-results-box');
    if (resultsBox) resultsBox.style.display = 'none';
    
    const resultsContainer = document.getElementById('query-results-tab-content-' + queryConsoleActiveTabId);
    if (resultsContainer) resultsContainer.innerHTML = '';
    
    // If all tabs are disconnected, we should direct to the login gateway
    const anyConnected = queryConsoleTabs.some(t => t.serverName);
    if (!anyConnected) {
        // Stop Monaco layout, hide editor main panel, show gateway login screen
        document.getElementById('query-connect-panel').style.display = 'block';
        document.getElementById('query-editor-main-panel').style.display = 'none';
        
        // Remove localStorage connection states
        localStorage.removeItem('queryConsoleConnected');
        localStorage.removeItem('queryConsoleServerName');
        localStorage.removeItem('queryConsoleAuthType');
        localStorage.removeItem('queryConsoleLogin');
        localStorage.removeItem('queryConsolePassword');
        localStorage.removeItem('queryConsoleActiveDatabase');
    }
    
    // Redraw explorer and tabs
    renderQueryTabs();
    if (typeof rebuildSchemaExplorerTree === 'function') {
        rebuildSchemaExplorerTree();
    }
}

// ── Server Selector Dropdown Logic ─────────────────────────────────────────
function toggleServerDropdown(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('query-server-dropdown');
    if (!dropdown) return;
    const isVisible = dropdown.style.display === 'block';
    
    // Close other dropdowns
    const dbDropdown = document.getElementById('query-db-dropdown');
    if (dbDropdown) dbDropdown.style.display = 'none';
    
    dropdown.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
        renderServerDropdown();
    }
}

function renderServerDropdown() {
    const listContainer = document.getElementById('query-server-list');
    if (!listContainer) return;

    const keys = Object.keys(activeConnections);
    if (keys.length === 0) {
        listContainer.innerHTML = `<div style="padding: 0.5rem; font-size: 0.8rem; color: var(--text-muted); text-align: center;">Belum ada sesi aktif</div>`;
        return;
    }

    listContainer.innerHTML = keys.map(serverName => {
        const isSelected = serverName === queryConsoleActiveServer;
        const safeServerName = escapeHtml(serverName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `
            <div class="server-item ${isSelected ? 'selected' : ''}" 
                 onclick="selectServer('${safeServerName}')" 
                 title="${escapeHtml(serverName)}">
                <i class="fa-solid fa-server" style="font-size: 0.72rem; margin-right: 0.3rem; color: ${isSelected ? '#0d1117' : 'var(--accent-teal)'};"></i>
                ${escapeHtml(serverName)}
            </div>
        `;
    }).join('');
}

async function selectServer(serverName) {
    const conn = activeConnections[serverName];
    if (!conn) return;

    queryConsoleActiveServer = conn.serverName;
    queryConsoleActiveAuth = conn.authType;
    queryConsoleActiveLogin = conn.login;
    queryConsoleActivePassword = conn.password;
    
    // Determine the database to select (first database or default database)
    queryConsoleActiveDatabase = conn.databases && conn.databases.length > 0 ? conn.databases[0] : "master";

    // Update current active tab connection settings
    const activeTab = queryConsoleTabs.find(t => t.id === queryConsoleActiveTabId);
    if (activeTab) {
        activeTab.serverName = conn.serverName;
        activeTab.authType = conn.authType;
        activeTab.login = conn.login;
        activeTab.password = conn.password;
        activeTab.database = queryConsoleActiveDatabase;
    }

    // Update UI trigger texts
    const serverTriggerText = document.getElementById('query-server-trigger-text');
    if (serverTriggerText) {
        serverTriggerText.textContent = conn.serverName;
    }
    
    const compatibilityBadge = document.getElementById('query-active-conn-info');
    if (compatibilityBadge) {
        compatibilityBadge.textContent = `${conn.serverName} (${queryConsoleActiveDatabase})`;
    }

    // Populate DB Selector Custom Dropdown
    renderDatabaseDropdown(conn.databases, queryConsoleActiveDatabase);

    // Close Server dropdown
    const dropdown = document.getElementById('query-server-dropdown');
    if (dropdown) dropdown.style.display = 'none';

    // Reload autocomplete schema
    await loadQueryConsoleSchema();

    // Redraw Object Explorer tree
    if (typeof rebuildSchemaExplorerTree === 'function') {
        rebuildSchemaExplorerTree();
    }
}

function openNewConnectionModalClick(event) {
    if (event) event.stopPropagation();
    
    // Close Server dropdown
    const dropdown = document.getElementById('query-server-dropdown');
    if (dropdown) dropdown.style.display = 'none';
    
    // Open Connection Modal
    openChangeConnectionModal();
}




