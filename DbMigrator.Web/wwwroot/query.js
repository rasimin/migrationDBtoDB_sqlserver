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
let queryConsoleActiveTables = [];

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

async function prefillQueryConnection() {
    const jobSelect = document.getElementById('query-conn-job-select');
    if (!jobSelect) return;
    const jobId = jobSelect.value;
    
    // Clear saved connection selection
    const savedSelect = document.getElementById('query-saved-conn-select');
    if (savedSelect) savedSelect.value = '';
    
    const serverInput = document.getElementById('query-server-name');
    const authSelect = document.getElementById('query-auth-type');
    const loginInput = document.getElementById('query-login');
    const passwordInput = document.getElementById('query-password');
    
    if (!jobId) {
        serverInput.value = '';
        authSelect.value = 'SQL';
        loginInput.value = '';
        passwordInput.value = '';
        toggleQueryAuthFields();
        return;
    }
    
    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}`);
        if (!res.ok) throw new Error("Gagal memuat detail job");
        const job = await res.json();
        
        // Default to Target connection string first
        const connStr = job.TargetConnectionString || job.targetConnectionString || job.SourceConnectionString || job.sourceConnectionString;
        const connObj = parseConnectionString(connStr);
        
        const server = connObj['server'] || connObj['data source'] || connObj['datasource'] || '';
        const userId = connObj['user id'] || connObj['uid'] || '';
        const pwd = connObj['password'] || connObj['pwd'] || '';
        const integratedSec = connObj['integrated security'] || '';
        
        serverInput.value = server;
        if (integratedSec.toLowerCase() === 'true' || integratedSec.toLowerCase() === 'sspi') {
            authSelect.value = 'Windows';
        } else {
            authSelect.value = 'SQL';
        }
        
        loginInput.value = userId;
        passwordInput.value = pwd;
        
        toggleQueryAuthFields();
    } catch (err) {
        console.error("Error prefilling connection:", err);
    }
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

async function populateQueryConnJobs() {
    const select = document.getElementById('query-conn-job-select');
    if (!select) return;
    
    select.innerHTML = '<option value="">-- Memuat Migration Job... --</option>';
    
    try {
        const res = await fetch(`${API_BASE}/jobs`);
        if (!res.ok) throw new Error("Gagal mengambil data");
        const jobs = await res.json();
        
        if (jobs.length === 0) {
            select.innerHTML = '<option value="">-- Belum ada Migration Job --</option>';
            return;
        }
        
        select.innerHTML = '<option value="">-- Pilih Job untuk isi otomatis --</option>' + 
            jobs.map(job => `<option value="${job.Id || job.id}">${escapeHtml(job.JobName || job.jobName)}</option>`).join('');
    } catch (err) {
        console.error(err);
        select.innerHTML = '<option value="">-- Error memuat Migration Job --</option>';
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

async function loadQueryConsoleSchema() {
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
        console.log("Database schema autocomplete reloaded:", queryConsoleSchema);
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

function filterDatabaseList(searchQuery) {
    const listContainer = document.getElementById('query-db-list');
    if (!listContainer) return;
    
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
                 style="color: ${isSelected ? '#0d1117' : '#cbd5e1'}; background: ${isSelected ? 'var(--accent-teal)' : 'transparent'}; font-weight: ${isSelected ? '600' : 'normal'};"
                 title="${escapeHtml(db)}">
                ${escapeHtml(db)}
            </div>
        `;
    }).join('');
}

async function selectDatabase(dbName) {
    queryConsoleActiveDatabase = dbName;
    
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

        queryConsoleEditor = monaco.editor.create(container, {
            value: initialValue,
            language: 'sql',
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'Consolas, Monaco, monospace',
            lineHeight: 18,
            padding: { top: 8, bottom: 8 }
        });

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

        // Listen for content changes to auto-save to localStorage
        queryConsoleEditor.onDidChangeModelContent(() => {
            localStorage.setItem('queryConsoleLastQuery', queryConsoleEditor.getValue());
        });

        // Register custom SQL autocomplete provider
        registerMonacoSqlAutocomplete();
        
        // Add shortcut key (Ctrl+Enter) to run query console
        queryConsoleEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function() {
            runQueryConsole();
        });
    });
}

function registerMonacoSqlAutocomplete() {
    if (monacoSqlCompletionProvider) return; // Prevent double registration

    const sqlKeywordsList = [
        "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "JOIN", "ON",
        "ORDER BY", "GROUP BY", "IN", "AND", "OR", "AS", "INTO", "VALUES", "SET",
        "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "CROSS JOIN", "TOP", "DISTINCT", 
        "COUNT", "SUM", "AVG", "MIN", "MAX", "HAVING", "LIKE", "IS NULL", "IS NOT NULL"
    ];

    monacoSqlCompletionProvider = monaco.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: ['.'],
        provideCompletionItems: function(model, position) {
            const textUntilPosition = model.getValueInRange({
                startLineNumber: position.lineNumber,
                startColumn: 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column
            });

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
    const queryText = (queryConsoleEditor ? queryConsoleEditor.getValue() : '').trim();
    if (!queryText) {
        await uiAlert("Harap masukkan query SQL!");
        return;
    }

    const resultsBox = document.getElementById('query-results-box');
    const resultsContainer = document.getElementById('query-results-container');
    const statusText = document.getElementById('query-status-text');
    const rowsCount = document.getElementById('query-rows-count');
    const executeBtn = document.getElementById('btn-execute-query');

    // Set up Cancel button inside status line
    statusText.innerHTML = `
        <span style="display: inline-flex; align-items: center; gap: 0.5rem;">
            <i class="fa-solid fa-spinner fa-spin"></i> Mengeksekusi kueri...
            <button class="btn" onclick="cancelQueryConsole()" style="background: rgba(244, 63, 94, 0.15); border: 1px solid rgba(244, 63, 94, 0.4); color: #f43f5e; height: 22px; padding: 0 0.5rem; font-size: 0.72rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 0.25rem; cursor: pointer; transition: all 0.15s ease;" onmouseover="this.style.background='rgba(244,63,94,0.3)'" onmouseout="this.style.background='rgba(244,63,94,0.15)'" title="Batalkan eksekusi kueri yang sedang berjalan">
                <i class="fa-solid fa-circle-stop" style="font-size: 0.7rem;"></i> Cancel
            </button>
        </span>
    `;
    statusText.style.color = 'var(--accent-teal)';
    rowsCount.textContent = "";
    resultsBox.style.display = 'block';

    if (resultsContainer) {
        resultsContainer.innerHTML = "";
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
            statusText.textContent = "Error: " + (data.Message || "Kesalahan eksekusi SQL");
            statusText.style.color = '#f43f5e';
            rowsCount.textContent = "Gagal (0 baris)";
            return;
        }

        const tables = data.Tables || [];
        if (tables.length === 0 && data.Headers && data.Rows) {
            tables.push({ Headers: data.Headers, Rows: data.Rows });
        }

        window.queryConsoleAllResults = tables;

        let containerHtml = "";
        
        if (tables.length > 1) {
            containerHtml += `<div class="query-results-tabs">`;
            tables.forEach((table, index) => {
                const rowCountText = table.Rows.length === 0 ? "0 baris" : `${table.Rows.length} baris`;
                const isFirst = index === 0 ? "active" : "";
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

        if (resultsContainer) {
            resultsContainer.innerHTML = containerHtml;
        }

        // Initialize drag-resize columns on all rendered tables
        document.querySelectorAll('.query-results-table').forEach(tbl => {
            initTableResizers(tbl);
        });

        statusText.textContent = "Kueri berhasil dijalankan.";
        statusText.style.color = 'var(--accent-teal)';

        if (tables.length > 1) {
            const totalRows = tables.reduce((acc, t) => acc + t.Rows.length, 0);
            rowsCount.textContent = `${tables.length} tabel dikembalikan (total ${totalRows} baris) dalam ${data.ExecutionTimeMs}ms`;
        } else {
            const rowCount = tables[0]?.Rows.length ?? 0;
            rowsCount.textContent = `${rowCount} baris displayed (${data.ExecutionTimeMs}ms)`;
        }

        // Initialize active tab as the export target
        if (tables.length > 0) {
            window.lastQueryResults = {
                Headers: tables[0].Headers,
                Rows: tables[0].Rows
            };
        } else {
            window.lastQueryResults = null;
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            statusText.textContent = "Eksekusi kueri dibatalkan oleh pengguna.";
            statusText.style.color = 'var(--text-muted, #5d7290)';
            rowsCount.textContent = "Dibatalkan";
        } else {
            console.error(err);
            statusText.textContent = "Error: " + err.message;
            statusText.style.color = '#f43f5e';
            rowsCount.textContent = "Gagal";
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
            rowsCount.textContent = `Tabel ${index + 1}: ${activeTable.Rows.length} baris ditampilkan${msStr}`;
        }
    }
}

function clearQueryConsole() {
    if (queryConsoleEditor) {
        queryConsoleEditor.setValue('');
    }
    document.getElementById('query-results-box').style.display = 'none';
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
                 style="color: ${isSelected ? '#0d1117' : '#cbd5e1'}; background: ${isSelected ? 'var(--accent-teal)' : 'transparent'}; font-weight: ${isSelected ? '600' : 'normal'};"
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

// ── Schema Explorer Logic ──
let schemaViewerActiveCode = "";

async function searchSchemaObjects() {
    if (!queryConsoleActiveServer) {
        await uiAlert("Hubungkan ke database server terlebih dahulu!");
        return;
    }

    const typeSelect = document.getElementById('schema-exp-type');
    const searchInput = document.getElementById('schema-exp-search');
    const listContainer = document.getElementById('schema-exp-list');
    const searchContentChk = document.getElementById('schema-exp-search-content');

    const objType = typeSelect ? typeSelect.value : 'ALL';
    const searchTerm = searchInput ? searchInput.value.trim() : '';
    const searchInContent = searchContentChk ? searchContentChk.checked : false;

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

        listContainer.innerHTML = objects.map(obj => {
            const createDate = obj.CreatedDate ? new Date(obj.CreatedDate).toLocaleString('id-ID') : '-';
            const modifyDate = obj.ModifiedDate ? new Date(obj.ModifiedDate).toLocaleString('id-ID') : '-';
            const badgeClass = (obj.Type || '').toLowerCase();
            const escapedName = escapeHtml(obj.Name);
            const escapedType = escapeHtml(obj.Type);

            const jsName = obj.Name.replace(/'/g, "\\'");
            const jsType = obj.Type.replace(/'/g, "\\'");
            const jsCreated = createDate.replace(/'/g, "\\'");
            const jsModified = modifyDate.replace(/'/g, "\\'");

            return `
                <div class="schema-exp-item" onclick="showSchemaDefinition('${jsName}', '${jsType}', '${jsCreated}', '${jsModified}')" style="cursor: pointer;">
                    <div class="schema-exp-header" style="pointer-events: none;">
                        <span class="schema-exp-name" title="${escapedName}">${escapedName}</span>
                        <span class="schema-exp-badge ${badgeClass}">${escapedType}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error(err);
        window.lastSchemaObjects = [];
        if (listContainer) {
            listContainer.innerHTML = `<div style="padding: 1.5rem; font-size: 0.8rem; color: #f43f5e; text-align: center;"><i class="fa-solid fa-circle-exclamation"></i> Error: ${escapeHtml(err.message)}</div>`;
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
