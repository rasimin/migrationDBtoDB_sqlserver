/* ============================================================================
   CORE DB MIGRATOR FRONTEND SYSTEM - app.js
   ============================================================================ */

const API_BASE = '/api';
let activeJob = null;
let sourceTables = [];
let targetTables = [];
let sourceColumnsCache = {}; // tableName -> columns[{name, type}]
let targetColumnsCache = {}; // tableName -> columns[{name, type}]
let activeTableMappingId = null;
let activeColumnSourceTable = null;
let activeColumnTargetTable = null;

let dataMappingsCache = [];
let objItemsCache = [];
let cleanTablesCache = [];
let whiteboardDrawingsCache = [];
let activeWhiteboardId = null;
let excalidrawReactRef = null;
let excalidrawReactRoot = null;
let activeViewMode = 'list';

let migrationTotalTables = 0;
let migrationProcessedTables = {}; // TableName -> Status ('Completed' or 'Failed')
let isCancellationRequested = false;

// Hub SignalR
let connection = null;
let queryConsoleAbortController = null;

document.addEventListener('DOMContentLoaded', async () => {
    if (window.__partialsReady) {
        try {
            await window.__partialsReady;
        } catch {
            return;
        }
    }

    loadJobs();
    loadSavedConnections();
    initSignalR();
    // Load view mode preference from localStorage on startup
    activeViewMode = localStorage.getItem('activeViewMode') || 'list';
    setViewMode(activeViewMode);

    // Switch to active tab if saved
    const savedTab = localStorage.getItem('dbmigrator_active_tab');
    if (savedTab) {
        switchMainTab(savedTab);
    }

    // Auto-select last active job if saved
    const savedJobId = localStorage.getItem('dbmigrator_active_job_id');
    if (savedJobId) {
        selectJob(parseInt(savedJobId));
    }

    // Silent auto-reconnect if query console was previously connected
    const wasConnected = localStorage.getItem('queryConsoleConnected') === 'true';
    if (wasConnected) {
        const savedServer = localStorage.getItem('queryConsoleServerName');
        const savedAuth = localStorage.getItem('queryConsoleAuthType');
        const savedLogin = localStorage.getItem('queryConsoleLogin') || '';
        const savedPassword = localStorage.getItem('queryConsolePassword') || '';
        const savedDb = localStorage.getItem('queryConsoleActiveDatabase');
        
        if (savedServer) {
            // Pre-fill connection inputs
            if (document.getElementById('query-server-name')) document.getElementById('query-server-name').value = savedServer;
            if (document.getElementById('query-auth-type')) {
                document.getElementById('query-auth-type').value = savedAuth;
                toggleQueryAuthFields();
            }
            if (document.getElementById('query-login')) document.getElementById('query-login').value = savedLogin;
            if (document.getElementById('query-password')) document.getElementById('query-password').value = savedPassword;
            
            // Execute silent reconnect
            connectQueryConsole(true, savedDb);
        }
    }
});

// ============================================================================
// 1. SIGNALR Hub handlers
// ============================================================================
function initSignalR() {
    connection = new signalR.HubConnectionBuilder()
        .withUrl('/migrationHub')
        .withAutomaticReconnect()
        .build();

    connection.on('ReceiveProgress', (progressData) => {
        if (!progressData) return;

        // Bulletproof: Normalize casing to PascalCase (support both camelCase and PascalCase payload)
        const progress = {
            JobId: progressData.JobId !== undefined ? progressData.JobId : progressData.jobId,
            TableName: progressData.TableName !== undefined ? progressData.TableName : progressData.tableName,
            TotalRows: progressData.TotalRows !== undefined ? progressData.TotalRows : progressData.totalRows,
            RowsMigrated: progressData.RowsMigrated !== undefined ? progressData.RowsMigrated : progressData.rowsMigrated,
            Status: progressData.Status !== undefined ? progressData.Status : progressData.status,
            ErrorMessage: progressData.ErrorMessage !== undefined ? progressData.ErrorMessage : progressData.errorMessage
        };

        // Abaikan jika bukan untuk job aktif saat ini
        if (activeJob && progress.JobId && progress.JobId !== (activeJob.Id || activeJob.id)) {
            return;
        }

        // Tampilkan panel runner jika tersembunyi
        document.getElementById('active-runner-panel').style.display = 'block';

        // Bulletproof Fallback: Tentukan total tabel jika belum terinisialisasi
        if (migrationTotalTables === 0) {
            const enabledTables = dataMappingsCache.filter(m => {
                const val = m.IsEnabled !== undefined ? m.IsEnabled : m.isEnabled;
                return val === true || val === 1 || val === '1';
            });
            migrationTotalTables = enabledTables.length || 1;
        }

        const logsBox = document.getElementById('console-logs');

        // 1. Hitung Persentase Progress untuk Tabel Aktif
        let pct = 0;
        if (progress.TotalRows > 0) {
            pct = Math.round((progress.RowsMigrated / progress.TotalRows) * 100);
        }

        // 2. Update Tampilan Tabel Aktif (Active Table Card)
        const activeTableName = document.getElementById('active-table-name');
        const activeTableText = document.getElementById('active-table-text');
        const activeTableBar = document.getElementById('active-table-bar');

        if (activeTableName) activeTableName.innerText = progress.TableName;
        if (activeTableText) activeTableText.innerText = `${(progress.RowsMigrated || 0).toLocaleString()} / ${(progress.TotalRows || 0).toLocaleString()} (${pct}%)`;
        if (activeTableBar) {
            activeTableBar.style.width = `${pct}%`;

            if (progress.Status === 'InProgress') {
                activeTableBar.className = 'progress-bar-fill active';
            } else if (progress.Status === 'Completed') {
                activeTableBar.className = 'progress-bar-fill completed';
            } else if (progress.Status === 'Failed') {
                activeTableBar.className = 'progress-bar-fill failed';
            }
        }

        // 3. Catat status tabel jika selesai (terminal state)
        if (progress.Status === 'Completed' || progress.Status === 'Failed') {
            migrationProcessedTables[progress.TableName] = progress.Status;
        }

        // 4. Update Tampilan Kemajuan Global (Global Progress Card)
        const processedCount = Object.keys(migrationProcessedTables).length;
        const globalPct = migrationTotalTables > 0 ? Math.round((processedCount / migrationTotalTables) * 100) : 0;

        const globalText = document.getElementById('global-progress-text');
        const globalBar = document.getElementById('global-progress-bar');

        if (globalText) {
            globalText.innerText = `${processedCount} / ${migrationTotalTables} Tabel (${globalPct}%)`;
        }
        if (globalBar) {
            globalBar.style.width = `${globalPct}%`;
            if (globalPct >= 100) {
                globalBar.className = 'progress-bar-fill completed';
            } else {
                globalBar.className = 'progress-bar-fill active';
            }
        }

        // 5. Tambahkan Log ke Console Box
        const logLine = document.createElement('div');
        logLine.className = 'console-line';

        if (progress.Status === 'InProgress') {
            logLine.innerText = `[${new Date().toLocaleTimeString()}] Memindahkan data ${progress.TableName}: ${progress.RowsMigrated} dari ${progress.TotalRows} baris...`;
        } else if (progress.Status === 'Completed') {
            logLine.className = 'console-line success';
            if (progress.ErrorMessage && progress.ErrorMessage.includes('Skipped')) {
                logLine.innerText = `[${new Date().toLocaleTimeString()}] LEWAT: Tabel ${progress.TableName} dilewati (${progress.ErrorMessage}).`;
            } else {
                logLine.innerText = `[${new Date().toLocaleTimeString()}] KELAR: Tabel ${progress.TableName} sukses dimigrasi (${progress.RowsMigrated} baris).`;
            }

            // Refresh table mapping view untuk memperbarui logs/tampilan jika ada
            if (activeJob) loadTableMappings(activeJob.Id || activeJob.id);
        } else if (progress.Status === 'Failed') {
            logLine.className = 'console-line error';
            logLine.innerText = `[${new Date().toLocaleTimeString()}] ERROR: Tabel ${progress.TableName} gagal! Detail: ${progress.ErrorMessage}`;
            
            // Refresh table mapping view untuk memperbarui logs/tampilan jika gagal agar langsung muncul di grid
            if (activeJob) loadTableMappings(activeJob.Id || activeJob.id);
        }

        logsBox.appendChild(logLine);
        logsBox.scrollTop = logsBox.scrollHeight;

        // 6. Cek apakah seluruh rangkaian migrasi job telah selesai
        if (processedCount >= migrationTotalTables) {
            setTimeout(() => {
                const hasFailed = Object.values(migrationProcessedTables).includes('Failed');
                const statusText = document.getElementById('runner-status-text');
                const cancelBtn = document.getElementById('btn-cancel-migration');

                if (hasFailed) {
                    if (statusText) {
                        statusText.innerText = 'FAILED';
                        statusText.style.color = 'var(--color-error)';
                    }
                } else {
                    if (statusText) {
                        statusText.innerText = 'COMPLETED';
                        statusText.style.color = 'var(--color-success)';
                    }
                }

                if (cancelBtn) cancelBtn.style.display = 'none';
            }, 200);
        }
    });

    connection.on('ReceiveError', (errorObj) => {
        if (!errorObj) return;
        const message = typeof errorObj === 'object' ? (errorObj.Message || errorObj.message) : errorObj;
        const jobId = typeof errorObj === 'object' ? (errorObj.JobId || errorObj.jobId) : null;

        // Abaikan jika bukan untuk job aktif saat ini
        if (activeJob && jobId && jobId !== (activeJob.Id || activeJob.id)) {
            return;
        }

        const logsBox = document.getElementById('console-logs');
        const logLine = document.createElement('div');
        logLine.className = 'console-line error';
        logLine.innerText = `[${new Date().toLocaleTimeString()}] FATAL JOB ERROR: ${message}`;
        logsBox.appendChild(logLine);
        logsBox.scrollTop = logsBox.scrollHeight;

        document.getElementById('runner-status-text').innerText = 'FAILED';
        document.getElementById('runner-status-text').style.color = 'var(--color-error)';
        document.getElementById('btn-cancel-migration').style.display = 'none';

        // Refresh table mapping view untuk memperbarui logs/tampilan jika terjadi error fatal
        if (activeJob) loadTableMappings(activeJob.Id || activeJob.id);
    });

    // Re-join active job group on automatic reconnection
    connection.onreconnected((connectionId) => {
        console.log(`SignalR terhubung kembali (ConnectionId: ${connectionId}).`);
        if (activeJob) {
            joinJobGroupSignalR(activeJob.Id || activeJob.id);
        }
    });

    connection.start()
        .then(() => {
            console.log('SignalR terhubung.');
            if (activeJob) {
                joinJobGroupSignalR(activeJob.Id || activeJob.id);
            }
        })
        .catch(err => {
            console.error('SignalR gagal tersambung: ', err);
            const logsBox = document.getElementById('console-logs');
            if (logsBox) {
                const logLine = document.createElement('div');
                logLine.className = 'console-line error';
                logLine.innerText = `[${new Date().toLocaleTimeString()}] [System] Gagal terhubung ke signal server! Silakan refresh halaman.`;
                logsBox.appendChild(logLine);
                logsBox.scrollTop = logsBox.scrollHeight;
            }
        });
}

function joinJobGroupSignalR(jobId) {
    if (!connection) return;

    if (connection.state === signalR.HubConnectionState.Connected) {
        connection.invoke("JoinJobGroup", jobId.toString())
            .then(() => console.log(`Joined SignalR group for Job: ${jobId}`))
            .catch(err => console.error("Gagal join group SignalR: ", err));
    } else {
        console.log(`SignalR belum terhubung (State: ${connection.state}). Menunggu untuk bergabung ke group Job: ${jobId}`);
        setTimeout(() => {
            joinJobGroupSignalR(jobId);
        }, 500);
    }
}

// ============================================================================
// TOP NAVIGATION TAB SWITCHING & NEW SCREENS LOGIC
// ============================================================================
function switchMainTab(tabId) {
    // Redirect legacy settings tab to new beautifier tool
    if (tabId === 'settings') {
        tabId = 'beautifier';
    }

    // 1. Remove active class from all main nav items
    document.querySelectorAll('.top-nav .nav-item').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // 2. Add active class to selected nav item
    const activeNav = document.getElementById(`main-nav-${tabId}`);
    if (activeNav) {
        activeNav.classList.add('active');
    }
    
    // 3. Hide all main screens
    document.querySelectorAll('.main-screen').forEach(screen => {
        screen.style.display = 'none';
    });
    
    // 4. Show selected main screen
    const targetScreen = document.getElementById(`main-screen-${tabId}`);
    if (targetScreen) {
        targetScreen.style.display = 'block';
    }

    // Persist active tab in localStorage
    localStorage.setItem('dbmigrator_active_tab', tabId);

    // Cancel running query when switching tabs
    if (tabId !== 'query') {
        cancelQueryConsole();
    }

    // 5. Populate jobs in Query Console connection panel
    if (tabId === 'query') {
        populateQueryConnJobs();
        loadSavedConnections();
        // Refresh Monaco Editor layout if already connected and initialized
        if (localStorage.getItem('queryConsoleConnected') === 'true') {
            initMonacoQueryEditor();
        }
    } else if (tabId === 'beautifier') {
        initMonacoBeautifierEditor();
        setTimeout(() => {
            if (beautifierLeftEditor) beautifierLeftEditor.layout();
            if (beautifierRightEditor) beautifierRightEditor.layout();
        }, 120);
    } else if (tabId === 'whiteboard') {
        initWhiteboardTab();
    }
}

// ============================================================================
// SHARED UTILITY FUNCTIONS
// ============================================================================
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getDbName(connStr) {
    if (!connStr) return '-';
    const match = connStr.match(/Database=([^;]+)/i) || connStr.match(/Initial Catalog=([^;]+)/i);
    return match ? match[1] : 'UnknownDB';
}

function parseConnectionStringDb(connStr) {
    if (!connStr) return "Unknown DB";
    const parts = connStr.split(';');
    let server = '';
    let db = '';
    parts.forEach(part => {
        const eqIdx = part.indexOf('=');
        if (eqIdx < 0) return;
        const key = part.substring(0, eqIdx).trim().toLowerCase();
        const val = part.substring(eqIdx + 1).trim();
        if (key === 'server' || key === 'data source') server = val;
        else if (key === 'database' || key === 'initial catalog') db = val;
    });
    if (server && db) return `${db} (Server: ${server})`;
    if (db) return db;
    return server || "Unknown DB";
}
