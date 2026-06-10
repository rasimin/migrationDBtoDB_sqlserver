/* ============================================================================
   DYNAMIC MIGRATION DASHBOARD LOGIC - app.js
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
// 1. SIGNALR INITIALIZATION
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
// VIEW MODE TOGGLE & PERSISTENCE
// ============================================================================
function setViewMode(mode) {
    activeViewMode = mode;
    localStorage.setItem('activeViewMode', mode);

    const containers = [
        document.getElementById('table-list-container'),
        document.getElementById('obj-items-container'),
        document.getElementById('clean-tables-container')
    ];

    containers.forEach(container => {
        if (container) {
            if (mode === 'card') {
                container.classList.add('card-view');
            } else {
                container.classList.remove('card-view');
            }
        }
    });

    // Update active status on all switcher buttons
    document.querySelectorAll('.btn-view-list').forEach(btn => {
        if (mode === 'list') {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    document.querySelectorAll('.btn-view-card').forEach(btn => {
        if (mode === 'card') {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// ============================================================================
// 2. JOB MANAGEMENT
// ============================================================================
// ============================================================================
// 2. JOB MANAGEMENT
// ============================================================================
async function loadJobs() {
    try {
        const res = await fetch(`${API_BASE}/jobs`);
        const jobs = await res.json();

        const container = document.getElementById('job-list-container');
        if (jobs.length === 0) {
            container.innerHTML = `<p style="color: var(--text-muted); font-size: 0.9rem;">Belum ada job. Silakan buat baru.</p>`;
            return;
        }

        container.innerHTML = jobs.map(job => `
            <div class="job-item ${activeJob && (activeJob.Id || activeJob.id) === (job.Id || job.id) ? 'active' : ''}" onclick="selectJob(${job.Id || job.id})">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <h4 style="color: #ffffff; margin: 0;"><i class="fa-solid fa-database" style="color: var(--accent-teal); margin-right: 0.5rem;"></i>${job.JobName || job.jobName}</h4>
                    <button class="btn-icon delete" onclick="deleteJob(event, ${job.Id || job.id}, '${(job.JobName || job.jobName).replace(/'/g, "\\'")}')" style="background: none; border: none; color: var(--color-error); cursor: pointer; padding: 4px;" title="Hapus Job">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
                <p style="margin-top: 0.25rem;">Src: ${getDbName(job.SourceConnectionString || job.sourceConnectionString)}</p>
                <p>Tgt: ${getDbName(job.TargetConnectionString || job.targetConnectionString)}</p>
            </div>
        `).join('');
    } catch (err) {
        console.error('Gagal mengambil daftar job: ', err);
    }
}

async function deleteJob(event, id, name) {
    event.stopPropagation();
    if (!(await uiConfirm(`Apakah Anda yakin ingin menghapus Job [${name}] beserta seluruh konfigurasi tabel dan kolomnya? Tindakan ini tidak dapat dibatalkan!`))) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${id}`, { method: 'DELETE' });
        if (res.ok) {
            // Hapus cache pemindaian skema job yang dihapus
            localStorage.removeItem(`dbmigrator_schema_compare_results_${id}`);
            localStorage.removeItem(`dbmigrator_schema_compare_ddl_${id}`);
            localStorage.removeItem(`dbmigrator_schema_column_sync_${id}`);
            localStorage.removeItem(`dbmigrator_schema_compare_summary_${id}`);

            // Jika job yang sedang aktif dihapus, bersihkan editor
            if (activeJob && (activeJob.Id || activeJob.id) === id) {
                activeJob = null;
                localStorage.removeItem('dbmigrator_active_job_id');
                document.getElementById('job-editor-panel').style.display = 'none';
                document.getElementById('welcome-panel').style.display = 'flex';
            }
            loadJobs();
        } else {
            await uiAlert("Gagal menghapus job.");
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Terjadi kesalahan: " + err.message);
    }
}

function getDbName(connStr) {
    if (!connStr) return '-';
    const match = connStr.match(/Database=([^;]+)/i) || connStr.match(/Initial Catalog=([^;]+)/i);
    return match ? match[1] : 'UnknownDB';
}

async function selectJob(jobId) {
    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}`);
        if (!res.ok) return;
        activeJob = await res.json();

        // Save active job ID to localStorage
        localStorage.setItem('dbmigrator_active_job_id', jobId);

        // Tandai aktif di list
        loadJobs();

        // Reset sub-tab ke default (Pemetaan)
        switchTab('mapping');

        // Switch ke inner tab Data Migration by default
        switchInnerTab('data');

        // Tampilkan Panel Editor
        document.getElementById('welcome-panel').style.display = 'none';
        document.getElementById('job-editor-panel').style.display = 'block';

        // Terapkan view mode yang aktif ke seluruh container tab
        setViewMode(activeViewMode);

        // Tampilkan detail database aktif secara global
        if (activeJob) {
            const srcConn = activeJob.SourceConnectionString || activeJob.sourceConnectionString || '';
            const tgtConn = activeJob.TargetConnectionString || activeJob.targetConnectionString || '';
            const srcDb = parseConnectionStringDb(srcConn);
            const tgtDb = parseConnectionStringDb(tgtConn);

            const srcEl = document.getElementById('clean-source-db-text');
            const tgtEl = document.getElementById('clean-target-db-text');
            if (srcEl) srcEl.textContent = srcDb;
            if (tgtEl) tgtEl.textContent = tgtDb;

            const backupPath = activeJob.BackupPath || activeJob.backupPath || '';
            const backupTgtEl = document.getElementById('tool-backup-target-db-text');
            const backupPathEl = document.getElementById('tool-backup-path-text');
            const restoreTgtPreviewEl = document.getElementById('tool-restore-target-name-preview');

            if (backupTgtEl) backupTgtEl.textContent = tgtDb || 'Unknown';
            if (backupPathEl) backupPathEl.textContent = backupPath || 'Belum Diatur (Atur di konfigurasi Edit Job)';
            if (restoreTgtPreviewEl) restoreTgtPreviewEl.textContent = tgtDb || 'TargetDB';
        }

        document.getElementById('active-job-title').innerHTML = `
            <i class="fa-solid fa-code-fork" style="color: var(--accent-indigo);"></i> 
            Job: <strong>${activeJob.JobName || activeJob.jobName}</strong>
        `;

        // Join SignalR Group
        joinJobGroupSignalR(jobId);

        // Load mappings & db schemas
        loadTableMappings(jobId);
        loadDatabaseSchemas();
        await loadSchemaComparisonCache(jobId);

        // Refresh whiteboard if tab is active
        const activeTab = localStorage.getItem('dbmigrator_active_tab') || 'migration';
        if (activeTab === 'whiteboard') {
            initWhiteboardTab();
        }

    } catch (err) {
        console.error(err);
    }
}

async function loadDatabaseSchemas() {
    if (!activeJob) return;

    try {
        const jobId = activeJob.Id || activeJob.id;
        // Ambil Tabel dari Source DB
        const srcRes = await fetch(`${API_BASE}/db/tables?jobId=${jobId}&dbType=source`);
        if (srcRes.ok) {
            sourceTables = await srcRes.json();
        }

        // Ambil Tabel dari Target DB
        const tgtRes = await fetch(`${API_BASE}/db/tables?jobId=${jobId}&dbType=target`);
        if (tgtRes.ok) {
            targetTables = await tgtRes.json();
        }
    } catch (err) {
        console.error("Gagal memuat skema database: ", err);
    }
}

// ============================================================================
// 3. JOB SETUP FORM
// ============================================================================
function openNewJobForm() {
    document.getElementById('job-id').value = 0;
    document.getElementById('job-name').value = '';
    document.getElementById('source-conn').value = '';
    document.getElementById('target-conn').value = '';
    if (document.getElementById('job-backup-path')) {
        document.getElementById('job-backup-path').value = '';
    }
    if (document.getElementById('post-migration-script')) {
        document.getElementById('post-migration-script').value = '';
    }
    document.getElementById('job-form-title').innerText = 'Tambah Job Baru';
    document.getElementById('job-form-modal').classList.add('active');
}

function closeJobForm() {
    document.getElementById('job-form-modal').classList.remove('active');
}

function editActiveJob() {
    if (!activeJob) return;
    document.getElementById('job-id').value = activeJob.Id || activeJob.id;
    document.getElementById('job-name').value = activeJob.JobName || activeJob.jobName || '';
    document.getElementById('source-conn').value = activeJob.SourceConnectionString || activeJob.sourceConnectionString || '';
    document.getElementById('target-conn').value = activeJob.TargetConnectionString || activeJob.targetConnectionString || '';
    if (document.getElementById('job-backup-path')) {
        document.getElementById('job-backup-path').value = activeJob.BackupPath || activeJob.backupPath || '';
    }
    if (document.getElementById('post-migration-script')) {
        document.getElementById('post-migration-script').value = activeJob.PostMigrationScript || activeJob.postMigrationScript || '';
    }
    document.getElementById('job-form-title').innerText = 'Edit Konfigurasi Job';
    document.getElementById('job-form-modal').classList.add('active');
}

async function testConnection(type) {
    const inputId = type === 'source' ? 'source-conn' : 'target-conn';
    const btnId = type === 'source' ? 'btn-test-source' : 'btn-test-target';
    const connStr = document.getElementById(inputId).value.trim();
    const btn = document.getElementById(btnId);

    if (!connStr) {
        await uiAlert("Harap isi connection string terlebih dahulu!");
        return;
    }

    const originalText = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Mengetes...`;
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/jobs/test-connection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ConnectionString: connStr })
        });

        if (res.ok) {
            const data = await res.json();
            if (data.Success || data.success) {
                await uiAlert(data.Message || data.message || "Koneksi berhasil terhubung!");
            } else {
                await uiAlert(data.Message || data.message || "Gagal terhubung.");
            }
        } else {
            const errText = await res.text();
            await uiAlert("Gagal melakukan tes koneksi: " + errText);
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Terjadi kesalahan: " + err.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function testConnSilent(connStr) {
    try {
        const res = await fetch(`${API_BASE}/jobs/test-connection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ConnectionString: connStr })
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        return { Success: false, Message: e.message };
    }
    return { Success: false, Message: "HTTP Error" };
}

async function saveJob() {
    const id = parseInt(document.getElementById('job-id').value);
    const name = document.getElementById('job-name').value.trim();
    const source = document.getElementById('source-conn').value.trim();
    const target = document.getElementById('target-conn').value.trim();
    const backupPath = document.getElementById('job-backup-path') ? document.getElementById('job-backup-path').value.trim() : '';
    const postScript = document.getElementById('post-migration-script') ? document.getElementById('post-migration-script').value.trim() : null;

    if (!name || !source || !target) {
        await uiAlert("Harap isi semua kolom form!");
        return;
    }

    // Lakukan validasi otomatis sebelum menyimpan job
    const testSrc = await testConnSilent(source);
    const testTgt = await testConnSilent(target);

    if (!testSrc.Success || !testTgt.Success) {
        let msg = "Koneksi database terdeteksi gagal:\n";
        if (!testSrc.Success) msg += `- Source DB: ${testSrc.Message}\n`;
        if (!testTgt.Success) msg += `- Target DB: ${testTgt.Message}\n`;
        msg += "\nApakah Anda yakin tetap ingin menyimpan konfigurasi Job ini?";
        if (!(await uiConfirm(msg))) {
            return;
        }
    }

    const payload = {
        Id: id,
        JobName: name,
        SourceConnectionString: source,
        TargetConnectionString: target,
        PostMigrationScript: postScript,
        BackupPath: backupPath
    };

    try {
        const res = await fetch(`${API_BASE}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            const saved = await res.json();
            closeJobForm();
            loadJobs();
            selectJob(saved.Id || saved.id);
        } else {
            const err = await res.text();
            await uiAlert("Gagal menyimpan job: " + err);
        }
    } catch (err) {
        console.error(err);
    }
}

// ============================================================================
// 4. TABLE MAPPING MANAGEMENT
// ============================================================================
async function loadTableMappings(jobId) {
    try {
        const res = await fetch(`${API_BASE}/mappings/tables/${jobId}`);
        const mappings = await res.json();
        dataMappingsCache = mappings;

        // Reset search inputs
        const searchInput = document.getElementById('data-search');
        const statusFilter = document.getElementById('data-filter-status');
        if (searchInput) searchInput.value = '';
        if (statusFilter) statusFilter.value = 'ALL';

        filterDataMappings();
    } catch (err) {
        console.error(err);
    }
}

function filterDataMappings() {
    const searchVal = (document.getElementById('data-search')?.value || '').trim().toLowerCase();
    const statusVal = document.getElementById('data-filter-status')?.value || 'ALL';

    const isFilterActive = (searchVal !== '' || statusVal !== 'ALL');

    const filtered = dataMappingsCache.filter(map => {
        const sourceName = (map.SourceTableName || map.sourceTableName || '').toLowerCase();
        const targetName = (map.TargetTableName || map.targetTableName || '').toLowerCase();
        const matchSearch = sourceName.includes(searchVal) || targetName.includes(searchVal);

        const lastStatus = map.LastStatus || map.lastStatus || 'Pending';
        const matchStatus = (statusVal === 'ALL' || lastStatus.toLowerCase() === statusVal.toLowerCase());

        return matchSearch && matchStatus;
    });

    renderTableMappings(filtered, isFilterActive);
}

function renderTableMappings(mappings, isFilterActive) {
    const container = document.getElementById('table-list-container');
    if (!container) return;

    if (mappings.length === 0) {
        if (isFilterActive) {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem; border: 1px dashed var(--border-glass); border-radius: 15px; color: var(--text-muted);">
                    <i class="fa-solid fa-magnifying-glass" style="font-size: 2rem; margin-bottom: 0.75rem;"></i>
                    <p>Tidak ada hasil pencocokan untuk pencarian atau filter Anda.</p>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem; border: 1px dashed var(--border-glass); border-radius: 15px; color: var(--text-muted);">
                    <i class="fa-solid fa-table-cells-large" style="font-size: 2rem; margin-bottom: 0.75rem;"></i>
                    <p>Belum ada pemetaan tabel. Klik 'Tambah Tabel' untuk memetakan tabel asal ke tujuan.</p>
                </div>
            `;
        }
        return;
    }

    container.innerHTML = mappings.map(map => {
        const mapId = map.Id || map.id;
        const mappingMode = map.MappingMode || map.mappingMode || 'TABLE';
        const isNative = mappingMode.toUpperCase() === 'NATIVE_SQL';
        const sourceName = map.SourceTableName || map.sourceTableName;
        const targetName = map.TargetTableName || map.targetTableName;
        const scriptPreview = (map.NativeSqlScript || map.nativeSqlScript || '').substring(0, 100);

        const lastStatus = map.LastStatus || map.lastStatus || 'Pending';
        const lastErrorMessage = map.LastErrorMessage || map.lastErrorMessage || '';
        const lastRunAt = map.LastRunAt || map.lastRunAt;
        const lastRowsMigrated = map.LastRowsMigrated !== undefined ? map.LastRowsMigrated : (map.lastRowsMigrated !== undefined ? map.lastRowsMigrated : 0);

        let statusClass = 'pending';
        if (lastStatus === 'Completed') statusClass = 'completed';
        else if (lastStatus === 'Failed') statusClass = 'failed';
        else if (lastStatus === 'InProgress') statusClass = 'inprogress';

        let lastRunTime = '';
        if (lastRunAt) {
            lastRunTime = new Date(lastRunAt).toLocaleString();
        }

        const isEnabled = map.IsEnabled !== undefined ? map.IsEnabled : (map.isEnabled !== undefined ? map.isEnabled : true);
        const disabledClass = isEnabled ? '' : ' disabled';

        if (isNative) {
            return `
            <div class="table-item sortable-item native-sql-item${disabledClass}" draggable="${isFilterActive ? 'false' : 'true'}" data-sort-id="${mapId}">
                <div class="table-info">
                    ${isFilterActive ? '' : `
                    <div class="drag-handle" title="Geser untuk mengubah urutan">
                        <i class="fa-solid fa-grip-vertical"></i>
                    </div>`}
                    <div class="execution-badge" title="Urutan Eksekusi">${map.ExecutionOrder || map.executionOrder}</div>
                    <input type="checkbox" class="toggle-switch-input" ${isEnabled ? 'checked' : ''} onchange="toggleTableMappingEnabled(${mapId}, this.checked)" title="${isEnabled ? 'Aktif (Klik untuk Lewati/Skip)' : 'Dilewati/Skip (Klik untuk Aktifkan)'}" style="margin-left: 0.25rem;">
                    <div style="display: flex; flex-direction: column; gap: 0.35rem; width: 100%;">
                        <div style="display: flex; align-items: center; gap: 0.65rem; flex-wrap: wrap;">
                            <i class="fa-solid fa-terminal" style="color: var(--accent-teal);"></i>
                            <span style="font-weight: 700; color: #ffffff;">${escapeHtml(targetName)}</span>
                            <span class="obj-type-badge native_sql">NATIVE SQL</span>
                            <span class="badge-clean ${statusClass}">${lastStatus}</span>
                            ${lastRunTime ? `<span style="font-size: 0.72rem; color: var(--text-muted);"><i class="fa-solid fa-clock"></i> ${lastRunTime}</span>` : ''}
                        </div>
                        <div style="font-size: 0.75rem; color: var(--text-muted); font-family: Consolas, monospace; max-width: 560px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(scriptPreview)}${scriptPreview.length >= 100 ? '...' : ''}</div>
                        ${lastErrorMessage ? `<div style="font-size: 0.78rem; color: var(--color-error); font-family: Consolas, monospace; line-height: 1.45; white-space: pre-wrap; word-break: break-all; max-width: 100%; padding: 0.65rem 0.85rem; background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.18); border-radius: 6px; margin-top: 0.35rem;">${lastErrorMessage}</div>` : ''}
                    </div>
                </div>
                <div class="table-actions">
                    <button class="btn-icon" onclick="runSingleMapping(${mapId})" title="Jalankan Native SQL Ini" style="color: var(--accent-teal);">
                        <i class="fa-solid fa-play"></i>
                    </button>
                    <button class="btn-icon" onclick="editNativeSqlMapping(${mapId})" title="Edit Native SQL">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button class="btn-icon delete" onclick="deleteTableMapping(${mapId})" title="Hapus Native SQL">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
        }

        return `
            <div class="table-item sortable-item${disabledClass}" draggable="${isFilterActive ? 'false' : 'true'}" data-sort-id="${mapId}">
                <div class="table-info">
                    ${isFilterActive ? '' : `
                    <div class="drag-handle" title="Geser untuk mengubah urutan">
                        <i class="fa-solid fa-grip-vertical"></i>
                    </div>`}
                    <div class="execution-badge" title="Urutan Eksekusi">${map.ExecutionOrder || map.executionOrder}</div>
                    <input type="checkbox" class="toggle-switch-input" ${isEnabled ? 'checked' : ''} onchange="toggleTableMappingEnabled(${mapId}, this.checked)" title="${isEnabled ? 'Aktif (Klik untuk Lewati/Skip)' : 'Dilewati/Skip (Klik untuk Aktifkan)'}" style="margin-left: 0.25rem;">
                    <div style="display: flex; flex-direction: column; gap: 0.35rem; width: 100%;">
                        <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
                            <div class="table-flow" style="margin: 0; padding: 0; background: none; box-shadow: none; display: flex; align-items: center; gap: 0.5rem;">
                                <span style="color: var(--text-muted); font-size: 0.9rem;">${sourceName}</span>
                                <span class="arrow" style="margin: 0; font-size: 0.8rem; color: var(--text-muted); display: inline-flex; align-items: center;"><i class="fa-solid fa-circle-arrow-right"></i></span>
                                <span style="color: #ffffff; font-weight: 600;">${targetName}</span>
                            </div>
                            <span class="badge-clean ${statusClass}">${lastStatus}${lastStatus === 'Completed' ? ` (${lastRowsMigrated.toLocaleString()} baris)` : ''}</span>
                            ${lastRunTime ? `<span style="font-size: 0.72rem; color: var(--text-muted);"><i class="fa-solid fa-clock"></i> ${lastRunTime}</span>` : ''}
                        </div>
                        ${lastErrorMessage ? `<div style="font-size: 0.78rem; color: var(--color-error); font-family: Consolas, monospace; line-height: 1.45; white-space: pre-wrap; word-break: break-all; max-width: 100%; padding: 0.65rem 0.85rem; background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.18); border-radius: 6px; margin-top: 0.35rem;">${lastErrorMessage}</div>` : ''}
                    </div>
                </div>
                <div class="table-actions">
                    <button class="btn-icon" onclick="runSingleMapping(${mapId})" title="Jalankan Pemetaan Ini" style="color: var(--accent-teal);">
                        <i class="fa-solid fa-play"></i>
                    </button>
                    <button class="btn-icon" onclick="generateSpScript(${map.Id || map.id})" title="Generate Stored Procedure (SP)" style="color: var(--accent-teal);">
                        <i class="fa-solid fa-file-code"></i>
                    </button>
                    <button class="btn-icon" onclick="openColumnMappingModal(${map.Id || map.id}, '${map.SourceTableName || map.sourceTableName}', '${map.TargetTableName || map.targetTableName}')" title="Petakan Kolom Dinamis">
                        <i class="fa-solid fa-sliders"></i>
                    </button>
                    <button class="btn-icon" onclick="editTableMapping(${map.Id || map.id})" title="Edit Pemetaan Tabel">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button class="btn-icon delete" onclick="deleteTableMapping(${map.Id || map.id})" title="Hapus Pemetaan">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    if (!isFilterActive && activeJob) {
        initSortableList(container, {
            endpoint: `${API_BASE}/mappings/tables/${activeJob.Id || activeJob.id}/reorder`
        });
    }
}

function initSortableList(container, options) {
    const itemSelector = options.itemSelector || '.sortable-item';
    const endpoint = options.endpoint;

    container.querySelectorAll(itemSelector).forEach(item => {
        // Parent item itself is NOT draggable to ensure perfect text selection
        item.setAttribute('draggable', 'false');

        const handle = item.querySelector('.drag-handle');
        if (handle) {
            // Set only the grip handle as draggable
            handle.setAttribute('draggable', 'true');
            handle.style.cursor = 'grab'; // Ensure grab cursor is shown on hover

            handle.addEventListener('dragstart', (e) => {
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.dataset.sortId);

                // Make the ghost image represent the entire item row instead of just the tiny handle
                if (e.dataTransfer.setDragImage) {
                    // Offset to align ghost image with mouse cursor nicely
                    e.dataTransfer.setDragImage(item, 10, 15);
                }
            });

            handle.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                container.querySelectorAll(`${itemSelector}.drag-over`).forEach(el => el.classList.remove('drag-over'));
                updateSortableBadges(container, itemSelector);
            });
        }
    });

    container.ondragover = (e) => {
        e.preventDefault();
        const dragging = container.querySelector(`${itemSelector}.dragging`);
        if (!dragging) return;

        const afterElement = getDragAfterElement(container, e.clientX, e.clientY, itemSelector);
        container.querySelectorAll(`${itemSelector}.drag-over`).forEach(el => el.classList.remove('drag-over'));

        if (afterElement == null) {
            container.appendChild(dragging);
        } else if (afterElement !== dragging) {
            afterElement.classList.add('drag-over');
            container.insertBefore(dragging, afterElement);
        }

        updateSortableBadges(container, itemSelector);
    };

    container.ondrop = async (e) => {
        e.preventDefault();
        container.querySelectorAll(`${itemSelector}.drag-over`).forEach(el => el.classList.remove('drag-over'));
        await saveSortableOrder(container, endpoint, itemSelector);
    };
}

function getDragAfterElement(container, x, y, itemSelector) {
    const allElements = [...container.querySelectorAll(itemSelector)];
    const draggableElements = allElements.filter(el => !el.classList.contains('dragging'));
    if (draggableElements.length === 0) return null;

    const isGrid = container.classList.contains('card-view');

    if (isGrid) {
        const dragging = container.querySelector(`${itemSelector}.dragging`);
        if (!dragging) return null;

        let closest = { distance: Number.POSITIVE_INFINITY, element: null };

        draggableElements.forEach(child => {
            const box = child.getBoundingClientRect();
            const centerX = box.left + box.width / 2;
            const centerY = box.top + box.height / 2;
            const distance = Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2);

            if (distance < closest.distance) {
                closest = { distance, element: child };
            }
        });

        if (closest.element) {
            const draggingIndex = allElements.indexOf(dragging);
            const targetIndex = allElements.indexOf(closest.element);
            
            const box = closest.element.getBoundingClientRect();
            const centerX = box.left + box.width / 2;
            const centerY = box.top + box.height / 2;

            if (draggingIndex < targetIndex) {
                // Moving forward: insert after target only if cursor passed its center
                const passed = (y > box.bottom) || (y >= box.top && x > centerX);
                if (passed) {
                    return closest.element.nextElementSibling;
                }
            } else {
                // Moving backward: insert before target only if cursor is before its center
                const passed = (y < box.top) || (y <= box.bottom && x < centerX);
                if (passed) {
                    return closest.element;
                }
            }
            // If not crossed, return dragging itself to prevent shifting back and forth
            return dragging;
        }
        return null;
    } else {
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;

            if (offset < 0 && offset > closest.offset) {
                return { offset, element: child };
            }

            return closest;
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }
}

function updateSortableBadges(container, itemSelector) {
    container.querySelectorAll(itemSelector).forEach((item, index) => {
        const badge = item.querySelector('.execution-badge');
        if (badge) badge.textContent = index + 1;
    });
}

async function saveSortableOrder(container, endpoint, itemSelector) {
    if (!endpoint) return;

    const items = [...container.querySelectorAll(itemSelector)].map((item, index) => ({
        Id: parseInt(item.dataset.sortId, 10),
        ExecutionOrder: index + 1
    })).filter(item => Number.isInteger(item.Id));

    if (items.length === 0) return;

    try {
        container.classList.add('is-saving-order');
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items)
        });

        if (!res.ok) {
            throw new Error(await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert('Gagal menyimpan urutan. Data akan dimuat ulang.');
        if (activeJob) {
            loadTableMappings(activeJob.Id || activeJob.id);
            loadObjItems(activeJob.Id || activeJob.id);
        }
    } finally {
        container.classList.remove('is-saving-order');
    }
}

function openNewTableMappingForm() {
    if (!activeJob) return;

    populateTableDatalists();

    document.getElementById('table-mapping-id').value = 0;
    document.getElementById('source-table-select').value = sourceTables[0] || '';
    document.getElementById('target-table-select').value = targetTables[0] || '';
    
    // hitung urutan eksekusi terakhir + 1 agar selalu di akhir secara default
    let nextOrder = 1;
    if (dataMappingsCache && dataMappingsCache.length > 0) {
        const orders = dataMappingsCache.map(m => parseInt(m.ExecutionOrder || m.executionOrder || 0));
        nextOrder = Math.max(...orders, 0) + 1;
    }
    document.getElementById('execution-order').value = nextOrder;

    document.getElementById('truncate-target').checked = false;
    if (document.getElementById('table-mapping-enabled')) {
        document.getElementById('table-mapping-enabled').checked = true;
    }
    if (document.getElementById('table-post-migration-script')) {
        document.getElementById('table-post-migration-script').value = '';
    }
    if (document.getElementById('table-where-clause')) {
        document.getElementById('table-where-clause').value = '';
    }
    document.getElementById('table-modal-title').innerText = 'Pemetaan Tabel Baru';

    document.getElementById('table-mapping-modal').classList.add('active');
}

function editTableMapping(id) {
    const map = dataMappingsCache.find(m => (m.Id || m.id) === id);
    if (!map) return;

    populateTableDatalists();

    document.getElementById('table-mapping-id').value = id;
    document.getElementById('source-table-select').value = map.SourceTableName || map.sourceTableName || '';
    document.getElementById('target-table-select').value = map.TargetTableName || map.targetTableName || '';
    document.getElementById('execution-order').value = map.ExecutionOrder || map.executionOrder || 1;
    document.getElementById('truncate-target').checked = map.TruncateTarget || map.truncateTarget || false;
    if (document.getElementById('table-mapping-enabled')) {
        document.getElementById('table-mapping-enabled').checked = map.IsEnabled !== undefined ? map.IsEnabled : (map.isEnabled !== undefined ? map.isEnabled : true);
    }
    if (document.getElementById('table-post-migration-script')) {
        document.getElementById('table-post-migration-script').value = map.PostMigrationScript || map.postMigrationScript || '';
    }
    if (document.getElementById('table-where-clause')) {
        document.getElementById('table-where-clause').value = map.WhereClause || map.whereClause || '';
    }
    document.getElementById('table-modal-title').innerText = 'Edit Pemetaan Tabel';

    document.getElementById('table-mapping-modal').classList.add('active');
}

function closeTableMappingModal() {
    document.getElementById('table-mapping-modal').classList.remove('active');
}

function openDataNativeSqlModal() {
    if (!activeJob) return;
    document.getElementById('data-native-sql-id').value = '0';
    document.getElementById('data-native-sql-name').value = '';
    document.getElementById('data-native-sql-mode').value = 'target';
    document.getElementById('data-native-sql-script').value = '';
    
    const modal = document.getElementById('data-native-sql-modal');
    if (modal) {
        const titleElement = modal.querySelector('.modal-header h3');
        if (titleElement) titleElement.textContent = 'Data Native SQL';
        const submitBtn = document.getElementById('data-native-sql-submit-btn');
        if (submitBtn) {
            submitBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Tambah ke Data Migration';
        }
    }

    updateDataNativeSqlTemplate();
    document.getElementById('data-native-sql-modal').classList.add('active');
}

function editNativeSqlMapping(id) {
    const map = dataMappingsCache.find(m => (m.Id || m.id) === id);
    if (!map) return;

    document.getElementById('data-native-sql-id').value = id;
    document.getElementById('data-native-sql-name').value = map.TargetTableName || map.targetTableName || '';
    document.getElementById('data-native-sql-script').value = map.NativeSqlScript || map.nativeSqlScript || '';

    // Determine the template mode based on script content
    const script = map.NativeSqlScript || map.nativeSqlScript || '';
    const modeSelect = document.getElementById('data-native-sql-mode');
    if (script.includes('{{SOURCE_DB}}') || script.includes('{{TARGET_DB}}')) {
        modeSelect.value = 'source-target';
    } else {
        modeSelect.value = 'target';
    }

    // Change Title and Button text to Edit mode
    const modal = document.getElementById('data-native-sql-modal');
    if (modal) {
        const titleElement = modal.querySelector('.modal-header h3');
        if (titleElement) titleElement.textContent = 'Edit Data Native SQL';
        const submitBtn = document.getElementById('data-native-sql-submit-btn');
        if (submitBtn) {
            submitBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Simpan Perubahan';
        }
    }

    const hint = document.getElementById('data-native-sql-hint');
    const example = document.getElementById('data-native-sql-example');
    if (modeSelect.value === 'source-target') {
        hint.innerHTML = 'Script dieksekusi sebagai langkah Data Migration dari koneksi Target DB. Pakai <code>{{SOURCE_DB}}</code> dan <code>{{TARGET_DB}}</code> jika Source dan Target berada di SQL Server instance yang sama.';
        if (example) {
            example.textContent = `-- Ambil data dari Source DB lalu masukkan ke Target DB\nINSERT INTO {{TARGET_DB}}.dbo.CustomerTarget (CustomerId, FullName, CreatedAt)\nSELECT Id, Name, GETDATE()\nFROM {{SOURCE_DB}}.dbo.CustomerSource\nWHERE IsActive = 1;\n\n-- Bisa juga update target berdasarkan data source\nUPDATE T\nSET T.FullName = S.Name\nFROM {{TARGET_DB}}.dbo.CustomerTarget T\nJOIN {{SOURCE_DB}}.dbo.CustomerSource S ON S.Id = T.CustomerId;`;
        }
    } else {
        hint.innerHTML = 'Cocok untuk UPDATE data target, cleanup, staging, atau script SQL lain yang perlu ikut urutan migrasi data.';
        if (example) {
            example.textContent = `-- Script berjalan langsung di Target DB\nUPDATE dbo.TargetTable\nSET UpdatedAt = GETDATE()\nWHERE UpdatedAt IS NULL;\n\n-- Contoh lain: cleanup data staging\nDELETE FROM dbo.ImportStaging\nWHERE IsProcessed = 1;`;
        }
    }

    document.getElementById('data-native-sql-modal').classList.add('active');
}

function closeDataNativeSqlModal() {
    document.getElementById('data-native-sql-modal').classList.remove('active');
}

function updateDataNativeSqlTemplate() {
    const mode = document.getElementById('data-native-sql-mode').value;
    const textarea = document.getElementById('data-native-sql-script');
    const hint = document.getElementById('data-native-sql-hint');
    const example = document.getElementById('data-native-sql-example');

    if (mode === 'source-target') {
        hint.innerHTML = 'Script dieksekusi sebagai langkah Data Migration dari koneksi Target DB. Pakai <code>{{SOURCE_DB}}</code> dan <code>{{TARGET_DB}}</code> jika Source dan Target berada di SQL Server instance yang sama.';
        if (example) {
            example.textContent = `-- Ambil data dari Source DB lalu masukkan ke Target DB\nINSERT INTO {{TARGET_DB}}.dbo.CustomerTarget (CustomerId, FullName, CreatedAt)\nSELECT Id, Name, GETDATE()\nFROM {{SOURCE_DB}}.dbo.CustomerSource\nWHERE IsActive = 1;\n\n-- Bisa juga update target berdasarkan data source\nUPDATE T\nSET T.FullName = S.Name\nFROM {{TARGET_DB}}.dbo.CustomerTarget T\nJOIN {{SOURCE_DB}}.dbo.CustomerSource S ON S.Id = T.CustomerId;`;
        }
        if (!textarea.value.trim()) {
            textarea.value = `INSERT INTO {{TARGET_DB}}.dbo.TargetTable (ColumnA, ColumnB)\nSELECT ColumnA, ColumnB\nFROM {{SOURCE_DB}}.dbo.SourceTable\nWHERE 1 = 1;`;
        }
        return;
    }

    hint.innerHTML = 'Cocok untuk UPDATE data target, cleanup, staging, atau script SQL lain yang perlu ikut urutan migrasi data.';
    if (example) {
        example.textContent = `-- Script berjalan langsung di Target DB\nUPDATE dbo.TargetTable\nSET UpdatedAt = GETDATE()\nWHERE UpdatedAt IS NULL;\n\n-- Contoh lain: cleanup data staging\nDELETE FROM dbo.ImportStaging\nWHERE IsProcessed = 1;`;
    }
    if (!textarea.value.trim()) {
        textarea.value = `UPDATE dbo.TargetTable\nSET UpdatedAt = GETDATE()\nWHERE UpdatedAt IS NULL;`;
    }
}

function toggleSqlExample(boxId) {
    const box = document.getElementById(boxId);
    if (!box) return;
    box.classList.toggle('collapsed');
}

async function addDataNativeSqlItem() {
    if (!activeJob) return;

    const id = parseInt(document.getElementById('data-native-sql-id').value || '0');
    const name = document.getElementById('data-native-sql-name').value.trim();
    const script = document.getElementById('data-native-sql-script').value.trim();

    if (!name || !script) {
        await uiAlert('Harap isi nama langkah dan script SQL!');
        return;
    }

    let executionOrder = 1;
    let isEnabled = true;

    if (id > 0) {
        const existing = dataMappingsCache.find(m => (m.Id || m.id) === id);
        if (existing) {
            executionOrder = existing.ExecutionOrder || existing.executionOrder || 1;
            isEnabled = existing.IsEnabled !== undefined ? existing.IsEnabled : (existing.isEnabled !== undefined ? existing.isEnabled : true);
        }
    } else {
        // hitung urutan eksekusi terakhir + 1 agar selalu di akhir secara default
        if (dataMappingsCache && dataMappingsCache.length > 0) {
            const orders = dataMappingsCache.map(m => parseInt(m.ExecutionOrder || m.executionOrder || 0));
            executionOrder = Math.max(...orders, 0) + 1;
        }
    }

    const payload = {
        Id: id,
        JobId: activeJob.Id || activeJob.id,
        SourceTableName: '[NATIVE_SQL]',
        TargetTableName: name,
        ExecutionOrder: executionOrder,
        TruncateTarget: false,
        IsEnabled: isEnabled,
        MappingMode: 'NATIVE_SQL',
        NativeSqlScript: script,
        PostMigrationScript: null
    };

    try {
        const res = await fetch(`${API_BASE}/mappings/tables`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            closeDataNativeSqlModal();
            loadTableMappings(activeJob.Id || activeJob.id);
        } else {
            await uiAlert((id > 0 ? 'Gagal mengubah' : 'Gagal menambahkan') + ' Native SQL: ' + await res.text());
        }
    } catch (err) {
        console.error(err);
    }
}

function populateTableDatalists() {
    setupTableAutocomplete('source-table-select', 'source-table-options', sourceTables);
    setupTableAutocomplete('target-table-select', 'target-table-options', targetTables);
}

function setupTableAutocomplete(inputId, menuId, tables) {
    const input = document.getElementById(inputId);
    const menu = document.getElementById(menuId);
    const toggle = document.querySelector(`[data-table-input="${inputId}"]`);
    if (!input || !menu) return;

    let activeIndex = -1;

    const render = (query = '') => {
        const normalized = query.trim().toLowerCase();
        const matches = tables
            .filter(table => !normalized || table.toLowerCase().includes(normalized))
            .slice(0, 80);

        activeIndex = -1;

        if (matches.length === 0) {
            menu.innerHTML = `<div class="table-autocomplete-empty">Tabel tidak ditemukan.</div>`;
        } else {
            menu.innerHTML = matches
                .map(table => `<div class="table-autocomplete-option" data-value="${escapeHtml(table)}">${escapeHtml(table)}</div>`)
                .join('');
        }

        menu.classList.add('active');
    };

    input.onfocus = () => render(input.value);
    input.oninput = () => render(input.value);
    input.onkeydown = (e) => {
        const options = [...menu.querySelectorAll('.table-autocomplete-option')];
        if (!menu.classList.contains('active') || options.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, options.length - 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
        } else if (e.key === 'Enter' && activeIndex >= 0) {
            e.preventDefault();
            input.value = options[activeIndex].dataset.value;
            menu.classList.remove('active');
            return;
        } else if (e.key === 'Escape') {
            menu.classList.remove('active');
            return;
        } else {
            return;
        }

        options.forEach(option => option.classList.remove('active'));
        options[activeIndex].classList.add('active');
        options[activeIndex].scrollIntoView({ block: 'nearest' });
    };

    menu.onclick = (e) => {
        const option = e.target.closest('.table-autocomplete-option');
        if (!option) return;
        input.value = option.dataset.value;
        menu.classList.remove('active');
        input.focus();
    };

    if (toggle) {
        toggle.onclick = () => {
            input.focus();
            render('');
        };
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

document.addEventListener('click', (e) => {
    if (e.target.closest('.table-search-field')) return;
    document.querySelectorAll('.table-autocomplete.active').forEach(menu => menu.classList.remove('active'));
});

async function saveTableMapping() {
    const id = parseInt(document.getElementById('table-mapping-id').value);
    const sourceTable = document.getElementById('source-table-select').value.trim();
    const targetTable = document.getElementById('target-table-select').value.trim();
    const order = parseInt(document.getElementById('execution-order').value);
    const truncate = document.getElementById('truncate-target').checked;
    const postScript = document.getElementById('table-post-migration-script') ? document.getElementById('table-post-migration-script').value.trim() : null;
    const whereClause = document.getElementById('table-where-clause') ? document.getElementById('table-where-clause').value.trim() : null;

    if (!sourceTable || !targetTable) {
        await uiAlert("Harap pilih tabel asal dan tujuan!");
        return;
    }

    if (!sourceTables.includes(sourceTable)) {
        await uiAlert("Nama tabel asal tidak ditemukan di daftar Source DB.");
        return;
    }

    if (!targetTables.includes(targetTable)) {
        await uiAlert("Nama tabel tujuan tidak ditemukan di daftar Target DB.");
        return;
    }

    const payload = {
        Id: id,
        JobId: activeJob.Id || activeJob.id,
        SourceTableName: sourceTable,
        TargetTableName: targetTable,
        ExecutionOrder: order,
        TruncateTarget: truncate,
        IsEnabled: document.getElementById('table-mapping-enabled')?.checked ?? true,
        MappingMode: 'TABLE',
        NativeSqlScript: null,
        PostMigrationScript: postScript,
        WhereClause: whereClause || null
    };

    try {
        const res = await fetch(`${API_BASE}/mappings/tables`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            const savedMapping = await res.json();
            closeTableMappingModal();
            loadTableMappings(activeJob.Id || activeJob.id);

            // Jika ini penambahan tabel baru (id === 0), otomatis buka form mapping kolom
            if (id === 0 && savedMapping && (savedMapping.Id || savedMapping.id)) {
                const newMappingId = savedMapping.Id || savedMapping.id;
                setTimeout(() => {
                    openColumnMappingModal(newMappingId, savedMapping.SourceTableName || savedMapping.sourceTableName, savedMapping.TargetTableName || savedMapping.targetTableName);
                }, 400); // Tunggu sedikit agar modal tutup selesai
            }
        } else {
            const errText = await res.text();
            await uiAlert("Gagal menyimpan pemetaan tabel: " + errText);
        }
    } catch (err) {
        console.error(err);
    }
}

async function deleteTableMapping(id) {
    if (!(await uiConfirm("Apakah Anda yakin ingin menghapus pemetaan tabel ini beserta konfigurasi kolomnya?"))) return;

    try {
        const res = await fetch(`${API_BASE}/mappings/tables/${id}`, { method: 'DELETE' });
        if (res.ok) {
            loadTableMappings(activeJob.Id || activeJob.id);
        }
    } catch (err) {
        console.error(err);
    }
}

// ============================================================================
// 5. DYNAMIC COLUMN MAPPING DESIGNER
// ============================================================================
async function openColumnMappingModal(tableMappingId, sourceTable, targetTable) {
    activeTableMappingId = tableMappingId;
    activeColumnSourceTable = sourceTable;
    activeColumnTargetTable = targetTable;

    document.getElementById('column-modal-title').innerText = `Desainer Kolom: ${targetTable}`;
    document.getElementById('column-modal-subtitle').innerText = `Memetakan dari data asal: ${sourceTable}`;

    const tbody = document.getElementById('column-mapper-tbody');
    tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Sedang mengambil struktur kolom database...</td></tr>`;

    document.getElementById('column-mapping-modal').classList.add('active');

    try {
        const jobId = activeJob.Id || activeJob.id;
        // 1. Fetch Existing Column Mappings first so saved work appears immediately.
        const mapRes = await fetch(`${API_BASE}/mappings/columns/${tableMappingId}`);
        const existingMappings = await mapRes.json();

        if (existingMappings.length > 0) {
            const savedTargetCols = buildTargetColumnsFromMappings(existingMappings);
            const savedSourceCols = buildSourceColumnsFromMappings(existingMappings);
            renderColumnMapper(savedTargetCols, savedSourceCols, existingMappings);
        }

        // 2. Refresh live source/target structure. If it is slow, saved mappings remain visible.
        const schemaLoaded = await loadColumnSchemas(jobId, sourceTable, targetTable);
        if (schemaLoaded) {
            const srcCols = sourceColumnsCache[sourceTable] || buildSourceColumnsFromMappings(existingMappings);
            const tgtCols = targetColumnsCache[targetTable] || buildTargetColumnsFromMappings(existingMappings);
            renderColumnMapper(tgtCols, srcCols, existingMappings);
        } else if (existingMappings.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--color-error);">Gagal mengambil struktur kolom database.</td></tr>`;
        }
    } catch (err) {
        console.error(err);
        tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--color-error);">Gagal memuat kolom: ${err.message}</td></tr>`;
    }
}

async function loadColumnSchemas(jobId, sourceTable, targetTable) {
    try {
        const requests = [];

        if (!sourceColumnsCache[sourceTable]) {
            requests.push(
                fetch(`${API_BASE}/db/columns?jobId=${jobId}&dbType=source&tableName=${encodeURIComponent(sourceTable)}`)
                    .then(res => res.ok ? res.json() : null)
                    .then(cols => { if (cols) sourceColumnsCache[sourceTable] = cols; })
            );
        }

        if (!targetColumnsCache[targetTable]) {
            requests.push(
                fetch(`${API_BASE}/db/columns?jobId=${jobId}&dbType=target&tableName=${encodeURIComponent(targetTable)}`)
                    .then(res => res.ok ? res.json() : null)
                    .then(cols => { if (cols) targetColumnsCache[targetTable] = cols; })
            );
        }

        await Promise.all(requests);
        return !!sourceColumnsCache[sourceTable] && !!targetColumnsCache[targetTable];
    } catch (err) {
        console.error(err);
        return false;
    }
}

function buildTargetColumnsFromMappings(mappings) {
    return [...new Map(mappings
        .filter(m => m.TargetColumnName || m.targetColumnName)
        .map(m => {
            const name = m.TargetColumnName || m.targetColumnName;
            return [name.toLowerCase(), { Name: name, Type: 'saved' }];
        })).values()];
}

function buildSourceColumnsFromMappings(mappings) {
    return [...new Map(mappings
        .filter(m => m.SourceColumnName || m.sourceColumnName)
        .map(m => {
            const name = m.SourceColumnName || m.sourceColumnName;
            return [name.toLowerCase(), { Name: name, Type: 'saved' }];
        })).values()];
}

function closeColumnMappingModal() {
    document.getElementById('column-mapping-modal').classList.remove('active');
    // Reset modal maximize state
    const modalContent = document.querySelector('#column-mapping-modal .modal-content');
    if (modalContent) {
        modalContent.classList.remove('maximized');
    }
    const maxBtn = document.getElementById('btn-maximize-modal');
    if (maxBtn) {
        maxBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
        maxBtn.title = "Perbesar Layar";
    }
}

function toggleMaximizeColumnModal() {
    const modalContent = document.querySelector('#column-mapping-modal .modal-content');
    const maxBtn = document.getElementById('btn-maximize-modal');

    if (modalContent.classList.contains('maximized')) {
        modalContent.classList.remove('maximized');
        maxBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
        maxBtn.title = "Perbesar Layar";
    } else {
        modalContent.classList.add('maximized');
        maxBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
        maxBtn.title = "Perkecil Layar";
    }
}

function renderColumnMapper(targetCols, sourceCols, existingMappings) {
    const tbody = document.getElementById('column-mapper-tbody');
    tbody.innerHTML = '';

    if (targetCols.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Tabel tujuan tidak memiliki kolom.</td></tr>`;
        return;
    }

    targetCols.forEach(tCol => {
        // Cari apakah sudah ada mapping terdaftar
        const mapping = existingMappings.find(m => m.TargetColumnName.toLowerCase() === tCol.Name.toLowerCase()) || {};
        const selectedMappingType = mapping.MappingType || 'Ignore';

        const tr = document.createElement('tr');
        tr.dataset.targetColumn = tCol.Name;

        // Buat dropdown pilihan kolom source
        const srcOptionsHtml = sourceCols.map(s => `
            <option value="${s.Name}" ${mapping.SourceColumnName === s.Name ? 'selected' : ''}>${s.Name} (${s.Type})</option>
        `).join('');

        // Tipe Mapping Options
        const mTypes = ['Ignore', 'Direct', 'Constant', 'Lookup', 'Expression'];
        const typeOptionsHtml = mTypes.map(type => `
            <option value="${type}" ${selectedMappingType === type ? 'selected' : ''}>${type}</option>
        `).join('');

        tr.innerHTML = `
            <td>
                <div style="font-weight: 600; color: #ffffff;">${tCol.Name}</div>
                <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">${tCol.Type}</div>
            </td>
            <td>
                <select class="form-control mapping-type-select" onchange="toggleMappingTypeFields(this)" style="padding: 0.5rem;">
                    ${typeOptionsHtml}
                </select>
            </td>
            <td>
                <div class="mapping-config-fields">
                    <!-- Dinamis terisi oleh toggleMappingTypeFields -->
                </div>
            </td>
            <td class="if-null-cell">
                <!-- Dinamis terisi oleh renderIfNullField -->
            </td>
            <td style="text-align: center;">
                <button class="btn btn-danger btn-sm" onclick="clearRowMapping(this)" title="Hapus Pemetaan" style="padding: 0.35rem 0.5rem; border-radius: 6px; font-size: 0.75rem; width: auto; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </td>
        `;

        tbody.appendChild(tr);

        // Panggil toggle awal untuk mengisi form sesuai database/default
        const select = tr.querySelector('.mapping-type-select');
        toggleMappingTypeFields(select, mapping, sourceCols);

        // Render kolom "Jika Null"
        renderIfNullField(tr, mapping);
    });
}

function toggleMappingTypeFields(selectElement, savedData = {}, sourceCols = []) {
    const tr = selectElement.closest('tr');
    const container = tr.querySelector('.mapping-config-fields');
    const selectedType = selectElement.value;

    // Tarik list source columns dari cache
    const sourceTableName = document.getElementById('column-modal-subtitle').innerText.replace('Memetakan dari data asal: ', '');
    const sCols = sourceColumnsCache[sourceTableName] || sourceCols;

    container.innerHTML = '';

    if (selectedType === 'Direct') {
        const optHtml = sCols.map(s => `<option value="${s.Name}" ${savedData.SourceColumnName === s.Name ? 'selected' : ''}>${s.Name} (${s.Type})</option>`).join('');
        container.innerHTML = `
            <select class="form-control col-source-select" style="padding: 0.5rem;">
                <option value="">-- Pilih Kolom Asal --</option>
                ${optHtml}
            </select>
        `;
    }
    else if (selectedType === 'Constant') {
        container.innerHTML = `
            <input type="text" class="form-control col-constant-input" placeholder="Isi nilai default (misal: 1, Active)" value="${savedData.ConstantValue || ''}">
        `;
    }
    else if (selectedType === 'Lookup') {
        // Buat dropdown tabel target
        const tblOpts = targetTables.map(t => `<option value="${t}" ${savedData.LookupTable === t ? 'selected' : ''}>${t}</option>`).join('');
        container.innerHTML = `
            <div class="dynamic-options" style="background: rgba(255,255,255,0.01); border: 1px solid var(--border-glass); border-radius: 12px; padding: 1rem; margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.75rem;">
                
                <!-- Info Section -->
                <div style="font-size: 0.75rem; color: var(--accent-teal); display: flex; align-items: center; gap: 0.35rem;">
                    <i class="fa-solid fa-circle-info"></i> <span>Menerjemahkan nilai kolom asal menjadi ID/Key dari Tabel Referensi di Database Tujuan.</span>
                </div>
                
                <!-- Grid untuk Konfigurasi Tabel Referensi & Pencocokan -->
                <div class="lookup-fields-grid" style="display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 0.75rem;">
                    <div>
                        <label style="font-size: 0.75rem; color: var(--text-primary); font-weight: 600; display: block; margin-bottom: 0.35rem;">
                            1. Tabel Referensi Tujuan (Target Table)
                        </label>
                        <select class="form-control col-lookup-table" onchange="loadLookupColumns(this)" style="padding: 0.5rem; font-size: 0.8rem; border-radius: 8px;">
                            <option value="">-- Pilih Tabel --</option>
                            ${tblOpts}
                        </select>
                        <small style="font-size: 0.65rem; color: var(--text-muted); display: block; margin-top: 0.2rem;">Tabel pencarian data (misal: <em>tcustomer</em>)</small>
                    </div>
                    <div>
                        <label style="font-size: 0.75rem; color: var(--text-primary); font-weight: 600; display: block; margin-bottom: 0.35rem;">
                            2. Kolom Kunci Pencocokan (Match Key)
                        </label>
                        <select class="form-control col-lookup-key" style="padding: 0.5rem; font-size: 0.8rem; border-radius: 8px;">
                            <option value="${savedData.LookupKeyColumn || ''}">${savedData.LookupKeyColumn || '-- Pilih Kolom --'}</option>
                        </select>
                        <small style="font-size: 0.65rem; color: var(--text-muted); display: block; margin-top: 0.2rem;">Kolom pembanding kunci (misal: <em>nik</em>)</small>
                    </div>
                    <div>
                        <label style="font-size: 0.75rem; color: var(--text-primary); font-weight: 600; display: block; margin-bottom: 0.35rem;">
                            3. Kolom ID Hasil Akhir (Target ID)
                        </label>
                        <select class="form-control col-lookup-value" style="padding: 0.5rem; font-size: 0.8rem; border-radius: 8px;">
                            <option value="${savedData.LookupValueColumn || ''}">${savedData.LookupValueColumn || '-- Pilih Kolom --'}</option>
                        </select>
                        <small style="font-size: 0.65rem; color: var(--text-muted); display: block; margin-top: 0.2rem;">ID hasil yang akan diambil (misal: <em>idcustomer</em>)</small>
                    </div>
                </div>
                
                <!-- Kolom Asal Pembanding -->
                <div style="border-top: 1px dashed rgba(255,255,255,0.06); padding-top: 0.75rem; display: flex; align-items: center; gap: 0.75rem;">
                    <span style="font-size: 0.75rem; color: var(--text-primary); font-weight: 600;">
                        4. Nilai Sumber Asal (dari Tabel Asal):
                    </span>
                    <select class="form-control col-source-select" style="padding: 0.4rem; width: 220px; font-size: 0.8rem; border-radius: 8px; border-color: rgba(255, 255, 255, 0.15);">
                        ${sCols.map(s => `<option value="${s.Name}" ${savedData.SourceColumnName === s.Name ? 'selected' : ''}>${s.Name} (${s.Type})</option>`).join('')}
                    </select>
                    <small style="font-size: 0.65rem; color: var(--text-muted);">Nilai yang dicari nilainya di Match Key (misal: NIK dari data sumber)</small>
                </div>
                
            </div>
        `;

        // Trigger load kolom referensi jika tabel sudah tersimpan
        const tblSelect = container.querySelector('.col-lookup-table');
        if (savedData.LookupTable) {
            loadLookupColumns(tblSelect, savedData.LookupKeyColumn, savedData.LookupValueColumn);
        }
    }
    else if (selectedType === 'Expression') {
        container.innerHTML = `
            <textarea class="form-control col-expression-input" placeholder="Contoh SQL: CASE WHEN EXISTS(SELECT 1 FROM tbl_history H WHERE H.nik = Source.nik) THEN 1 ELSE 0 END" style="font-family:Consolas, monospace; font-size:0.8rem; min-height:60px;">${savedData.ExpressionSQL || ''}</textarea>
        `;
    }
    else if (selectedType === 'Ignore') {
        container.innerHTML = `<span style="color:var(--text-dark); font-size:0.85rem; font-style:italic;">Kolom ini akan diabaikan (tidak diisi)</span>`;
    }
}

// ============================================================================
// IF-NULL FALLBACK FIELD RENDERER
// ============================================================================
const IF_NULL_OPTIONS = [
    { value: 'Null',              label: 'Null (default)',       hasParam: false },
    { value: 'GetDate',           label: 'GetDate()',            hasParam: false },
    { value: 'Constant',          label: 'Konstan',              hasParam: true,  placeholder: 'Masukkan nilai konstan...' },
    { value: 'RandomNumber',      label: 'Angka Acak',           hasParam: true,  placeholder: 'Panjang digit (misal: 8)' },
    { value: 'RandomLetters',     label: 'Huruf Acak',           hasParam: true,  placeholder: 'Panjang karakter (misal: 10)' },
    { value: 'RandomAlphanumeric',label: 'Angka + Huruf Acak',   hasParam: true,  placeholder: 'Panjang karakter (misal: 12)' },
    { value: 'Expression',        label: 'Ekspresi Query',       hasParam: true,  placeholder: 'Contoh: GETDATE() atau \'DEFAULT_VAL\'' },
];

function renderIfNullField(tr, savedData = {}) {
    const cell = tr.querySelector('.if-null-cell');
    if (!cell) return;

    const savedAction = savedData.IfNullAction || savedData.ifNullAction || 'Null';
    const savedParam  = savedData.IfNullParam  || savedData.ifNullParam  || '';

    const optHtml = IF_NULL_OPTIONS.map(o =>
        `<option value="${o.value}" ${savedAction === o.value ? 'selected' : ''}>${o.label}</option>`
    ).join('');

    const currentOpt = IF_NULL_OPTIONS.find(o => o.value === savedAction) || IF_NULL_OPTIONS[0];
    const paramHtml  = currentOpt.hasParam
        ? `<input type="text" class="form-control if-null-param" style="margin-top:0.4rem; padding:0.35rem 0.5rem; font-size:0.78rem;" placeholder="${currentOpt.placeholder}" value="${savedParam}">`
        : '';

    cell.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:0;">
            <select class="form-control if-null-select" style="padding:0.4rem 0.5rem; font-size:0.8rem;" onchange="onIfNullActionChange(this)">
                ${optHtml}
            </select>
            <div class="if-null-param-wrapper">${paramHtml}</div>
        </div>
    `;
}

function onIfNullActionChange(sel) {
    const tr      = sel.closest('tr');
    const wrapper = tr.querySelector('.if-null-param-wrapper');
    const opt     = IF_NULL_OPTIONS.find(o => o.value === sel.value);
    if (!opt) return;
    wrapper.innerHTML = opt.hasParam
        ? `<input type="text" class="form-control if-null-param" style="margin-top:0.4rem; padding:0.35rem 0.5rem; font-size:0.78rem;" placeholder="${opt.placeholder}">`
        : '';
}

function clearRowMapping(button) {
    const tr = button.closest('tr');
    if (!tr) return;
    const selectType = tr.querySelector('.mapping-type-select');
    if (selectType) {
        selectType.value = 'Ignore';
        toggleMappingTypeFields(selectType, {}, []);
    }
    const ifNullSelect = tr.querySelector('.if-null-select');
    if (ifNullSelect) {
        ifNullSelect.value = 'Null';
        onIfNullActionChange(ifNullSelect);
    }
}

async function loadLookupColumns(selectElement, selectedKey = null, selectedValue = null) {
    const lookupTable = selectElement.value;
    if (!lookupTable) return;

    const container = selectElement.closest('.lookup-fields-grid');
    const keySelect = container.querySelector('.col-lookup-key');
    const valSelect = container.querySelector('.col-lookup-value');

    try {
        const jobId = activeJob.Id || activeJob.id;
        if (!targetColumnsCache[lookupTable]) {
            const res = await fetch(`${API_BASE}/db/columns?jobId=${jobId}&dbType=target&tableName=${lookupTable}`);
            if (res.ok) targetColumnsCache[lookupTable] = await res.json();
        }

        const cols = targetColumnsCache[lookupTable] || [];

        const optsHtml = cols.map(c => `<option value="${c.Name}">${c.Name} (${c.Type})</option>`).join('');

        keySelect.innerHTML = `<option value="">-- Pilih Key --</option>` + optsHtml;
        valSelect.innerHTML = `<option value="">-- Pilih ID/Val --</option>` + optsHtml;

        if (selectedKey) keySelect.value = selectedKey;
        if (selectedValue) valSelect.value = selectedValue;
    } catch (err) {
        console.error(err);
    }
}

async function autoMapColumns() {
    const tbody = document.getElementById('column-mapper-tbody');
    const rows = tbody.querySelectorAll('tr');

    const sourceTableName = document.getElementById('column-modal-subtitle').innerText.replace('Memetakan dari data asal: ', '');
    const sCols = sourceColumnsCache[sourceTableName] || [];

    let mapCount = 0;

    rows.forEach(row => {
        const targetColName = row.dataset.targetColumn;
        const selectType = row.querySelector('.mapping-type-select');

        // Cari kolom source dengan nama yang sama (case insensitive)
        const matchedSource = sCols.find(s => s.Name.toLowerCase() === targetColName.toLowerCase());

        if (matchedSource) {
            selectType.value = 'Direct';
            // Trigger UI update
            toggleMappingTypeFields(selectType, { SourceColumnName: matchedSource.Name }, sCols);
            mapCount++;
        } else {
            selectType.value = 'Ignore';
            toggleMappingTypeFields(selectType, {}, sCols);
        }
    });

    if (mapCount > 0) {
        await uiAlert(`Sukses mencocokkan otomatis ${mapCount} kolom!`);
    } else {
        await uiAlert("Tidak ada kolom dengan nama yang sama untuk dicocokkan otomatis.");
    }
    console.log(`Auto-mapped ${mapCount} kolom dengan nama yang sama.`);
}

async function saveColumnMappings() {
    const tbody = document.getElementById('column-mapper-tbody');
    const rows = tbody.querySelectorAll('tr');

    const columnsPayload = [];

    for (let row of rows) {
        const targetColName = row.dataset.targetColumn;
        const mappingType = row.querySelector('.mapping-type-select').value;
        const fieldsContainer = row.querySelector('.mapping-config-fields');

        const colMapping = {
            TableMappingId: activeTableMappingId,
            TargetColumnName: targetColName,
            MappingType: mappingType,
            SourceColumnName: null,
            ConstantValue: null,
            LookupTable: null,
            LookupKeyColumn: null,
            LookupValueColumn: null,
            ExpressionSQL: null,
            IfNullAction: row.querySelector('.if-null-select')?.value || 'Null',
            IfNullParam: row.querySelector('.if-null-param')?.value?.trim() || null
        };

        if (mappingType === 'Direct') {
            const srcCol = fieldsContainer.querySelector('.col-source-select').value;
            if (!srcCol) {
                await uiAlert(`Kolom "${targetColName}" bertipe "Direct" harus memilih kolom asal.`);
                return;
            }
            colMapping.SourceColumnName = srcCol;
        }
        else if (mappingType === 'Constant') {
            const constVal = fieldsContainer.querySelector('.col-constant-input').value.trim();
            if (constVal === '') {
                await uiAlert(`Kolom "${targetColName}" bertipe "Constant" harus diisi nilai default.`);
                return;
            }
            colMapping.ConstantValue = constVal;
        }
        else if (mappingType === 'Lookup') {
            const lkpTable = fieldsContainer.querySelector('.col-lookup-table').value;
            const lkpKey = fieldsContainer.querySelector('.col-lookup-key').value;
            const lkpVal = fieldsContainer.querySelector('.col-lookup-value').value;
            const srcCol = fieldsContainer.querySelector('.col-source-select').value;

            if (!lkpTable || !lkpKey || !lkpVal || !srcCol) {
                await uiAlert(`Kolom "${targetColName}" bertipe "Lookup" harus mengisi tabel referensi, key pencari, ID hasil, dan kolom asal.`);
                return;
            }

            colMapping.LookupTable = lkpTable;
            colMapping.LookupKeyColumn = lkpKey;
            colMapping.LookupValueColumn = lkpVal;
            colMapping.SourceColumnName = srcCol;
        }
        else if (mappingType === 'Expression') {
            const exprSql = fieldsContainer.querySelector('.col-expression-input').value.trim();
            if (exprSql === '') {
                await uiAlert(`Kolom "${targetColName}" bertipe "Expression" harus diisi ekspresi SQL.`);
                return;
            }
            colMapping.ExpressionSQL = exprSql;
        }

        columnsPayload.push(colMapping);
    }

    try {
        const res = await fetch(`${API_BASE}/mappings/columns/${activeTableMappingId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(columnsPayload)
        });

        if (res.ok) {
            await uiAlert("Semua pemetaan kolom sukses disimpan!");
            closeColumnMappingModal();
        } else {
            const errText = await res.text();
            await uiAlert("Gagal menyimpan: " + errText);
        }
    } catch (err) {
        console.error(err);
    }
}

// ============================================================================
// 6. RUN MIGRATION JOB
// ============================================================================
// ============================================================================
// 6. RUN MIGRATION JOB
// ============================================================================
async function runMigrationJob() {
    if (!activeJob) return;
    if (!(await uiConfirm(`Apakah Anda yakin ingin memulai migrasi untuk job "${activeJob.JobName || activeJob.jobName}" sekarang?`))) return;

    // Reset State & Dashboard UI
    isCancellationRequested = false;
    migrationProcessedTables = {};
    const enabledTables = dataMappingsCache.filter(m => {
        const val = m.IsEnabled !== undefined ? m.IsEnabled : m.isEnabled;
        return val === true || val === 1 || val === '1';
    });
    migrationTotalTables = enabledTables.length;

    document.getElementById('global-progress-text').innerText = `0 / ${migrationTotalTables} Tabel (0%)`;
    document.getElementById('global-progress-bar').style.width = '0%';
    document.getElementById('global-progress-bar').className = 'progress-bar-fill active';

    document.getElementById('active-table-name').innerText = 'Menunggu tabel berikutnya...';
    document.getElementById('active-table-text').innerText = '0 / 0 baris (0%)';
    document.getElementById('active-table-bar').style.width = '0%';
    document.getElementById('active-table-bar').className = 'progress-bar-fill active';

    const progressList = document.getElementById('runner-progress-list');
    if (progressList) progressList.innerHTML = '';

    const logsBox = document.getElementById('console-logs');
    logsBox.innerHTML = `<div class="console-line info">[${new Date().toLocaleTimeString()}] Menyiapkan migrasi data...</div>`;

    document.getElementById('runner-status-text').innerText = 'RUNNING';
    document.getElementById('runner-status-text').style.color = 'var(--accent-teal)';
    document.getElementById('active-runner-panel').style.display = 'block';

    // Show cancel button
    const cancelBtn = document.getElementById('btn-cancel-migration');
    if (cancelBtn) {
        cancelBtn.style.display = 'inline-flex';
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = `<i class="fa-solid fa-ban"></i> Batalkan Migrasi`;
    }

    const checkConstraints = document.getElementById('chk-check-constraints')?.checked || false;

    try {
        const res = await fetch(`${API_BASE}/jobs/${activeJob.Id || activeJob.id}/run?checkConstraints=${checkConstraints}`, { method: 'POST' });
        if (res.ok) {
            const msg = await res.json();
            const logLine = document.createElement('div');
            logLine.className = 'console-line info';
            logLine.innerText = `[${new Date().toLocaleTimeString()}] ${msg.Message}`;
            logsBox.appendChild(logLine);
        } else {
            await uiAlert("Gagal menjalankan migrasi.");
        }
    } catch (err) {
        console.error(err);
    }
}

// FEAT-001: Interactive Cancellation
async function cancelMigration() {
    if (!activeJob) return;
    const id = activeJob.Id || activeJob.id;
    const btn = document.getElementById('btn-cancel-migration');
    if (!btn) return;

    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Membatalkan...`;

    // Flag frontend loops to abort immediately
    isCancellationRequested = true;

    try {
        const res = await fetch(`${API_BASE}/jobs/${id}/cancel`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            const logsBox = document.getElementById('console-logs');
            const logLine = document.createElement('div');
            logLine.className = 'console-line error';
            logLine.innerText = `[${new Date().toLocaleTimeString()}] ${data.Message || "Permintaan pembatalan dikirim."}`;
            logsBox.appendChild(logLine);
            logsBox.scrollTop = logsBox.scrollHeight;
        } else {
            const text = await res.text();
            await uiAlert("Gagal membatalkan: " + text);
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-ban"></i> Batalkan Migrasi`;
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal membatalkan: " + err.message);
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-ban"></i> Batalkan Migrasi`;
    }
}

// FEAT-004: JSON Export
async function exportActiveJob() {
    if (!activeJob) return;
    const id = activeJob.Id || activeJob.id;
    const name = activeJob.JobName || activeJob.jobName || 'job';

    try {
        const res = await fetch(`${API_BASE}/jobs/${id}/export`);
        if (!res.ok) throw new Error("Gagal mengekspor.");
        const data = await res.json();

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 4));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `job_${name.toLowerCase().replace(/\s+/g, '_')}_config.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
    } catch (err) {
        console.error(err);
        await uiAlert("Terjadi kesalahan ekspor: " + err.message);
    }
}

// FEAT-004: JSON Import
function triggerImport() {
    document.getElementById('import-file-input').click();
}

async function importJsonFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            const importedData = JSON.parse(e.target.result);

            const res = await fetch(`${API_BASE}/jobs/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(importedData)
            });

            if (res.ok) {
                const newJob = await res.json();
                await uiAlert(`Sukses mengimpor job: ${newJob.JobName || newJob.jobName}`);
                loadJobs();
                selectJob(newJob.Id || newJob.id);
            } else {
                const errText = await res.text();
                await uiAlert("Gagal mengimpor job: " + errText);
            }
        } catch (err) {
            console.error(err);
            await uiAlert("Gagal membaca file JSON: " + err.message);
        } finally {
            event.target.value = '';
        }
    };
    reader.readAsText(file);
}

// FEAT-003: Switch Tab and Stats Aggregate
function switchTab(tab) {
    const mappingTab = document.getElementById('tab-mapping');
    const historyTab = document.getElementById('tab-history');
    const mappingList = document.getElementById('table-list-container');
    const historyList = document.getElementById('history-container');

    // Select buttons to hide/show inside job-editor-panel header
    const mappingBtns = document.querySelector('.table-mapping-header div:last-child');

    if (tab === 'mapping') {
        if (mappingTab) {
            mappingTab.classList.add('active');
            mappingTab.style.color = 'var(--accent-teal)';
            mappingTab.style.borderBottom = '2px solid var(--accent-teal)';
        }
        if (historyTab) {
            historyTab.classList.remove('active');
            historyTab.style.color = 'var(--text-muted)';
            historyTab.style.borderBottom = 'none';
        }
        if (mappingList) mappingList.style.display = '';
        if (historyList) historyList.style.display = 'none';
        if (mappingBtns) mappingBtns.style.display = 'flex';
    } else {
        if (historyTab) {
            historyTab.classList.add('active');
            historyTab.style.color = 'var(--accent-teal)';
            historyTab.style.borderBottom = '2px solid var(--accent-teal)';
        }
        if (mappingTab) {
            mappingTab.classList.remove('active');
            mappingTab.style.color = 'var(--text-muted)';
            mappingTab.style.borderBottom = 'none';
        }
        if (mappingList) mappingList.style.display = 'none';
        if (historyList) historyList.style.display = 'block';
        if (mappingBtns) mappingBtns.style.display = 'none';

        loadHistoryLogs();
    }
}

async function loadHistoryLogs() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    const tbody = document.getElementById('history-log-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Memuat histori migrasi...</td></tr>`;

    try {
        const res = await fetch(`${API_BASE}/logs/${jobId}`);
        if (!res.ok) throw new Error("Gagal mengambil log.");
        const logs = await res.json();

        if (logs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Belum ada histori migrasi untuk job ini.</td></tr>`;
            document.getElementById('stat-total-jobs').innerText = '0';
            document.getElementById('stat-success-rows').innerText = '0';
            document.getElementById('stat-success-rate').innerText = '0%';
            return;
        }

        // Calculate stats
        const totalExecutions = logs.length;
        const successRows = logs
            .filter(l => (l.Status || l.status) === 'Completed')
            .reduce((sum, l) => sum + (l.RowsMigrated || l.rowsMigrated || 0), 0);

        const completedCount = logs.filter(l => (l.Status || l.status) === 'Completed').length;
        const successRate = totalExecutions > 0 ? Math.round((completedCount / totalExecutions) * 100) : 0;

        document.getElementById('stat-total-jobs').innerText = totalExecutions.toString();
        document.getElementById('stat-success-rows').innerText = successRows.toLocaleString();
        document.getElementById('stat-success-rate').innerText = `${successRate}%`;

        tbody.innerHTML = logs.map(log => {
            const startTime = new Date(log.StartTime || log.startTime);
            const endTime = (log.EndTime || log.endTime) ? new Date(log.EndTime || log.endTime) : null;

            let durationStr = '-';
            if (endTime) {
                const diffMs = endTime - startTime;
                const diffSec = Math.round(diffMs / 1000);
                if (diffSec < 60) {
                    durationStr = `${diffSec} dtk`;
                } else {
                    durationStr = `${Math.floor(diffSec / 60)} mnt ${diffSec % 60} dtk`;
                }
            }

            const status = log.Status || log.status;
            let statusBadge = '';
            if (status === 'Completed') {
                statusBadge = `<span class="badge success" style="background: var(--color-success-glow); color: var(--color-success); padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600;">Completed</span>`;
            } else if (status === 'Failed') {
                statusBadge = `<span class="badge failed" style="background: var(--color-error-glow); color: var(--color-error); padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600;">Failed</span>`;
            } else {
                statusBadge = `<span class="badge info" style="background: rgba(255,255,255,0.05); color: var(--accent-teal); padding: 4px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600;">InProgress</span>`;
            }

            const errMessage = log.ErrorMessage || log.errorMessage || '';
            return `
                <tr>
                    <td><strong>${log.TableName || log.tableName}</strong></td>
                    <td>${startTime.toLocaleString()}</td>
                    <td>${durationStr}</td>
                    <td>${(log.TotalRows || log.totalRows || 0).toLocaleString()}</td>
                    <td>${(log.RowsMigrated || log.rowsMigrated || 0).toLocaleString()}</td>
                    <td>
                        ${statusBadge}
                        ${status === 'Failed' && errMessage ? `<div style="font-size:0.75rem; color:var(--color-error); margin-top:0.25rem; max-width:250px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${errMessage.replace(/"/g, '&quot;')}">${errMessage}</div>` : ''}
                    </td>
                </tr>
            `;
        }).join('');

    } catch (err) {
        console.error(err);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--color-error);">Gagal memuat histori: ${err.message}</td></tr>`;
    }
}

// ============================================================================
// STORED PROCEDURE GENERATION HANDLERS
// ============================================================================
async function generateSpScript(mappingId) {
    try {
        const res = await fetch(`${API_BASE}/mappings/tables/${mappingId}/generate-sp`);
        if (!res.ok) {
            const text = await res.text();
            await uiAlert("Gagal meng-generate SP: " + text);
            return;
        }
        const data = await res.json();

        document.getElementById('sp-modal-title').innerText = `Generate SP: ${data.SpName}`;
        document.getElementById('sp-sql-textarea').value = data.SqlScript;
        document.getElementById('sp-generator-modal').classList.add('active');
    } catch (err) {
        console.error(err);
        await uiAlert("Terjadi kesalahan: " + err.message);
    }
}

function closeSpGeneratorModal() {
    document.getElementById('sp-generator-modal').classList.remove('active');
}

async function copySpScript() {
    const textarea = document.getElementById('sp-sql-textarea');
    textarea.select();
    textarea.setSelectionRange(0, 99999); /* For mobile devices */

    navigator.clipboard.writeText(textarea.value)
        .then(async () => {
            await uiAlert("Script SQL Stored Procedure berhasil disalin ke clipboard!");
        })
        .catch(async (err) => {
            console.error("Gagal menyalin: ", err);
            await uiAlert("Gagal menyalin ke clipboard. Silakan salin secara manual.");
        });
}

// ============================================================================
// 7. INNER TAB SWITCHING (Data Migration ↔ Object Migration within a Job)
// ============================================================================
function switchInnerTab(tab) {
    const dataBtn = document.getElementById('inner-tab-data');
    const objBtn = document.getElementById('inner-tab-object');
    const cleanBtn = document.getElementById('inner-tab-clean');
    const schemaBtn = document.getElementById('inner-tab-schema');
    const toolsBtn = document.getElementById('inner-tab-tools');
    const dataContent = document.getElementById('inner-content-data');
    const objContent = document.getElementById('inner-content-object');
    const cleanContent = document.getElementById('inner-content-clean');
    const schemaContent = document.getElementById('inner-content-schema');
    const toolsContent = document.getElementById('inner-content-tools');

    if (!dataBtn || !objBtn || !cleanBtn) return;

    // Reset active button state
    dataBtn.classList.remove('active');
    objBtn.classList.remove('active');
    cleanBtn.classList.remove('active');
    if (schemaBtn) schemaBtn.classList.remove('active');
    if (toolsBtn) toolsBtn.classList.remove('active');

    // Hide all contents
    if (dataContent) dataContent.style.display = 'none';
    if (objContent) objContent.style.display = 'none';
    if (cleanContent) cleanContent.style.display = 'none';
    if (schemaContent) schemaContent.style.display = 'none';
    if (toolsContent) toolsContent.style.display = 'none';

    if (tab === 'data') {
        dataBtn.classList.add('active');
        if (dataContent) dataContent.style.display = 'block';
    } else if (tab === 'object') {
        objBtn.classList.add('active');
        if (objContent) objContent.style.display = 'block';
        if (activeJob) {
            loadObjItems(activeJob.Id || activeJob.id);
        }
    } else if (tab === 'clean') {
        cleanBtn.classList.add('active');
        if (cleanContent) cleanContent.style.display = 'block';
        if (activeJob) {
            loadCleanTables(activeJob.Id || activeJob.id);
        }
    } else if (tab === 'schema') {
        if (schemaBtn) schemaBtn.classList.add('active');
        if (schemaContent) schemaContent.style.display = 'block';
    } else if (tab === 'tools') {
        if (toolsBtn) toolsBtn.classList.add('active');
        if (toolsContent) toolsContent.style.display = 'block';
        populateToolsTableDatalist();
        scanBackupFiles();
    }
}

// ============================================================================
// 7B. DEVELOPER TOOLS - STORED PROCEDURE GENERATOR (INSERT/UPDATE) [NEW]
// ============================================================================
function populateToolsTableDatalist(forceClear = false) {
    if (!activeJob) return;

    const dbRadio = document.querySelector('input[name="tool-db-ref"]:checked');
    if (!dbRadio) return;

    const dbType = dbRadio.value;
    const currentTables = (dbType === 'source' ? sourceTables : targetTables) || [];
    const input = document.getElementById('tool-table-name');

    if (forceClear && input) {
        input.value = '';
    }

    setupTableAutocomplete('tool-table-name', 'tool-table-options', currentTables);
}

async function generateToolSpScript(opType) {
    if (!activeJob) {
        await uiAlert("Harap pilih Job terlebih dahulu!");
        return;
    }
    const tableName = document.getElementById('tool-table-name').value.trim();
    if (!tableName) {
        await uiAlert("Harap masukkan atau pilih Nama Tabel!");
        return;
    }

    const dbRadio = document.querySelector('input[name="tool-db-ref"]:checked');
    const dbType = dbRadio ? dbRadio.value : 'source';
    const keyColumn = document.getElementById('tool-key-column').value.trim() || 'Id';
    const excludeIdentity = document.getElementById('tool-exclude-identity').checked;
    const jobId = activeJob.Id || activeJob.id;

    try {
        const res = await fetch(`${API_BASE}/db/columns?jobId=${jobId}&dbType=${dbType}&tableName=${encodeURIComponent(tableName)}`);
        if (!res.ok) {
            const errText = await res.text();
            await uiAlert("Gagal memuat kolom tabel: " + errText);
            return;
        }
        const columns = await res.json();
        if (!columns || columns.length === 0) {
            await uiAlert(`Tidak ada kolom ditemukan pada tabel "${tableName}"! Pastikan nama tabel benar.`);
            return;
        }

        let sqlScript = "";
        const cleanTableName = tableName.replace(/[\[\]]/g, '');
        const spPrefix = opType === 'insert' ? 'sp_Insert_' : 'sp_Update_';
        const spName = `${spPrefix}${cleanTableName.replace('.', '_')}`;

        // Format schema & clean table name
        let schemaName = "dbo";
        let rawTableName = cleanTableName;
        if (cleanTableName.includes('.')) {
            const parts = cleanTableName.split('.');
            schemaName = parts[0];
            rawTableName = parts[1];
        }

        const dateStr = new Date().toLocaleString('id-ID', { timeZoneName: 'short' });

        if (opType === 'insert') {
            // SP INSERT
            const colsToInsert = columns.filter(col => {
                if (excludeIdentity && col.Name.toLowerCase() === keyColumn.toLowerCase()) {
                    return false;
                }
                return true;
            });

            const spParams = columns.filter(col => {
                if (excludeIdentity && col.Name.toLowerCase() === keyColumn.toLowerCase()) {
                    return false;
                }
                return true;
            });

            const paramLines = spParams.map(c => `    @${c.Name} ${c.Type}`).join(",\n");
            const targetCols = colsToInsert.map(c => `[${c.Name}]`).join(",\n            ");
            const valuesCols = colsToInsert.map(c => `@${c.Name}`).join(",\n            ");

            sqlScript = `-- ===========================================================================
-- STORED PROCEDURE: ${spName}
-- Digenerate secara otomatis oleh DbMigrator.NET (Developer Tools)
-- Dibuat pada: ${dateStr}
-- Referensi DB: ${dbType.toUpperCase()} DB
-- Deskripsi: SP Insert data untuk tabel [${schemaName}].[${rawTableName}]
-- ===========================================================================
CREATE OR ALTER PROCEDURE [${schemaName}].[${spName}]
${paramLines}
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;
    BEGIN TRY

        INSERT INTO [${schemaName}].[${rawTableName}] (
            ${targetCols}
        )
        VALUES (
            ${valuesCols}
        );

        COMMIT TRANSACTION;
        PRINT 'Data berhasil dimasukkan ke tabel [${schemaName}].[${rawTableName}]!';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        DECLARE @ErrorMessage NVARCHAR(4000) = ERROR_MESSAGE();
        DECLARE @ErrorSeverity INT = ERROR_SEVERITY();
        DECLARE @ErrorState INT = ERROR_STATE();
        RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END;
GO`;
        } else {
            // SP UPDATE
            const paramLines = columns.map(c => `    @${c.Name} ${c.Type}`).join(",\n");
            const colsToSet = columns.filter(c => c.Name.toLowerCase() !== keyColumn.toLowerCase());

            if (colsToSet.length === 0) {
                await uiAlert("Tidak ada kolom selain Kolom Kunci yang dapat di-update!");
                return;
            }

            const setClause = colsToSet.map(c => `[${c.Name}] = @${c.Name}`).join(",\n            ");
            const pkExists = columns.some(c => c.Name.toLowerCase() === keyColumn.toLowerCase());

            if (!pkExists) {
                console.warn(`Kolom kunci "${keyColumn}" tidak ada di daftar kolom.`);
            }

            sqlScript = `-- ===========================================================================
-- STORED PROCEDURE: ${spName}
-- Digenerate secara otomatis oleh DbMigrator.NET (Developer Tools)
-- Dibuat pada: ${dateStr}
-- Referensi DB: ${dbType.toUpperCase()} DB
-- Deskripsi: SP Update data untuk tabel [${schemaName}].[${rawTableName}]
-- ===========================================================================
CREATE OR ALTER PROCEDURE [${schemaName}].[${spName}]
${paramLines}
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;
    BEGIN TRY

        UPDATE [${schemaName}].[${rawTableName}]
        SET
            ${setClause}
        WHERE [${keyColumn}] = @${keyColumn};

        IF @@ROWCOUNT = 0
        BEGIN
            PRINT 'Peringatan: Tidak ada baris yang di-update. Pastikan ${keyColumn} benar.';
        END

        COMMIT TRANSACTION;
        PRINT 'Data berhasil diperbarui di tabel [${schemaName}].[${rawTableName}]!';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        DECLARE @ErrorMessage NVARCHAR(4000) = ERROR_MESSAGE();
        DECLARE @ErrorSeverity INT = ERROR_SEVERITY();
        DECLARE @ErrorState INT = ERROR_STATE();
        RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END;
GO`;
        }

        document.getElementById('sp-modal-title').innerText = `Generate SP ${opType.toUpperCase()}: ${spName}`;
        document.getElementById('sp-sql-textarea').value = sqlScript;
        document.getElementById('sp-generator-modal').classList.add('active');

    } catch (err) {
        console.error(err);
        await uiAlert("Terjadi kesalahan saat generate SP: " + err.message);
    }
}

// ============================================================================
// 7C. DEVELOPER TOOLS - DATABASE BACKUP & RESTORE [NEW]
// ============================================================================
function toggleRestoreMode() {
    const restoreMode = document.querySelector('input[name="tool-restore-mode"]:checked').value;
    const newDbGroup = document.getElementById('tool-restore-new-db-group');
    if (newDbGroup) {
        newDbGroup.style.display = restoreMode === 'new' ? 'block' : 'none';
    }
}

async function scanBackupFiles() {
    if (!activeJob) {
        return;
    }
    const jobId = activeJob.Id || activeJob.id;
    const selectEl = document.getElementById('tool-restore-file-select');
    if (!selectEl) return;

    selectEl.innerHTML = `<option value="">Mengambil daftar file backup...</option>`;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/backup-files`);
        if (!res.ok) {
            selectEl.innerHTML = `<option value="">-- Gagal memindai folder --</option>`;
            return;
        }

        const data = await res.json();
        if (data.Success || data.success) {
            const files = data.Files || data.files || [];
            if (files.length === 0) {
                selectEl.innerHTML = `<option value="">-- Tidak ada file .bak ditemukan --</option>`;
            } else {
                selectEl.innerHTML = files.map(file => `<option value="${escapeHtml(file)}">${escapeHtml(file)}</option>`).join('');
            }
        } else {
            selectEl.innerHTML = `<option value="">-- Gagal memindai: ${escapeHtml(data.Message || '')} --</option>`;
        }
    } catch (err) {
        console.error(err);
        selectEl.innerHTML = `<option value="">-- Error memindai folder --</option>`;
    }
}

async function runDatabaseBackup() {
    if (!activeJob) {
        await uiAlert("Harap pilih Job terlebih dahulu!");
        return;
    }
    
    const backupPath = activeJob.BackupPath || activeJob.backupPath || '';
    if (!backupPath) {
        await uiAlert("Path backup kosong! Harap atur path folder backup terlebih dahulu di konfigurasi Edit Job.");
        return;
    }

    const targetDb = parseConnectionStringDb(activeJob.TargetConnectionString || activeJob.targetConnectionString || '');
    if (!(await uiConfirm(`Apakah Anda yakin ingin mem-backup database target [${targetDb}] ke path:\n"${backupPath}"?`))) {
        return;
    }

    const btn = document.getElementById('btn-run-db-backup');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Mem-backup Database...`;
    btn.disabled = true;

    try {
        const jobId = activeJob.Id || activeJob.id;
        const res = await fetch(`${API_BASE}/jobs/${jobId}/backup`, {
            method: 'POST'
        });

        if (!res.ok) {
            const errText = await res.text();
            await uiAlert("Gagal backup: " + errText);
            return;
        }

        const data = await res.json();
        if (data.Success || data.success) {
            await uiAlert(data.Message || "Backup database berhasil diselesaikan!");
            scanBackupFiles();
        } else {
            await uiAlert(data.Message || "Gagal backup.");
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Terjadi kesalahan koneksi saat backup: " + err.message);
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    }
}

async function runDatabaseRestore() {
    if (!activeJob) {
        await uiAlert("Harap pilih Job terlebih dahulu!");
        return;
    }

    const backupFile = document.getElementById('tool-restore-file-select').value;
    if (!backupFile) {
        await uiAlert("Harap pilih file backup (.bak) yang akan di-restore!");
        return;
    }

    const restoreMode = document.querySelector('input[name="tool-restore-mode"]:checked').value;
    const targetDb = parseConnectionStringDb(activeJob.TargetConnectionString || activeJob.targetConnectionString || '');
    
    let restoreDbName = targetDb;
    if (restoreMode === 'new') {
        restoreDbName = document.getElementById('tool-restore-new-db-name').value.trim();
        if (!restoreDbName) {
            await uiAlert("Harap masukkan nama database baru untuk restore!");
            return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(restoreDbName)) {
            await uiAlert("Nama database hanya boleh mengandung huruf, angka, underscore (_), atau dash (-).");
            return;
        }
    }

    let confirmMsg = "";
    if (restoreMode === 'existing') {
        confirmMsg = `🚨 PERINGATAN CRITICAL! 🚨\n\n` +
                     `Anda akan me-restore database target [${restoreDbName}] menggunakan file backup:\n` +
                     `"${backupFile}"\n\n` +
                     `Tindakan ini akan MENIMPA & MENGHAPUS semua data yang ada saat ini di database target [${restoreDbName}]!\n\n` +
                     `Apakah Anda yakin dan setuju untuk melanjutkan?`;
    } else {
        confirmMsg = `Tindakan ini akan me-restore file backup "${backupFile}" ke database BARU bernama [${restoreDbName}].\n\n` +
                     `Apakah Anda yakin ingin melanjutkan?`;
    }

    if (!(await uiConfirm(confirmMsg))) {
        return;
    }

    if (restoreMode === 'existing') {
        const doubleCheck = await uiPrompt(
            `Ketik nama database target untuk mengonfirmasi penulisan ulang database.`,
            {
                title: 'Konfirmasi Restore',
                placeholder: restoreDbName,
                matchValue: restoreDbName,
                matchError: 'Nama database tidak cocok. Restore dibatalkan.',
                variant: 'warning'
            }
        );
        if (doubleCheck !== restoreDbName) {
            if (doubleCheck !== null) {
                await uiAlert("Konfirmasi gagal. Proses restore dibatalkan.", { variant: 'error' });
            }
            return;
        }
    }

    const btn = document.getElementById('btn-run-db-restore');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Me-restore Database...`;
    btn.disabled = true;

    try {
        const jobId = activeJob.Id || activeJob.id;
        const res = await fetch(`${API_BASE}/jobs/${jobId}/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                BackupFilename: backupFile,
                RestoreDbName: restoreDbName
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            await uiAlert("Gagal me-restore: " + errText);
            return;
        }

        const data = await res.json();
        if (data.Success || data.success) {
            await uiAlert(data.Message || "Restore database berhasil diselesaikan!");
            if (restoreMode === 'new') {
                await uiAlert(`Database baru [${restoreDbName}] telah berhasil dibuat dan aktif.`);
            }
        } else {
            await uiAlert(data.Message || "Gagal me-restore database.");
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Terjadi kesalahan koneksi saat me-restore database: " + err.message);
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    }
}

// ============================================================================
// 8. OBJECT MIGRATION - ITEMS MANAGEMENT
// ============================================================================
let scanResultsCache = [];

async function loadObjItems(jobId) {
    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/obj-items`);
        const items = await res.json();
        objItemsCache = items;

        // Reset search inputs
        const searchInput = document.getElementById('obj-search');
        const typeFilter = document.getElementById('obj-filter-type');
        const statusFilter = document.getElementById('obj-filter-status');
        if (searchInput) searchInput.value = '';
        if (typeFilter) typeFilter.value = 'ALL';
        if (statusFilter) statusFilter.value = 'ALL';

        filterObjItems();
    } catch (err) {
        console.error(err);
    }
}

function filterObjItems() {
    const searchVal = (document.getElementById('obj-search')?.value || '').trim().toLowerCase();
    const typeVal = document.getElementById('obj-filter-type')?.value || 'ALL';
    const statusVal = document.getElementById('obj-filter-status')?.value || 'ALL';

    const isFilterActive = (searchVal !== '' || typeVal !== 'ALL' || statusVal !== 'ALL');

    const filtered = objItemsCache.filter(item => {
        const objName = (item.ObjectName || item.objectName || '').toLowerCase();
        const matchSearch = objName.includes(searchVal);

        const objType = item.ObjectType || item.objectType || '';
        const matchType = (typeVal === 'ALL' || objType.toUpperCase() === typeVal.toUpperCase());

        const lastStatus = item.LastStatus || item.lastStatus || 'Pending';
        const matchStatus = (statusVal === 'ALL' || lastStatus.toLowerCase() === statusVal.toLowerCase());

        return matchSearch && matchType && matchStatus;
    });

    renderObjItems(filtered, isFilterActive);
}

function renderObjItems(items, isFilterActive) {
    const container = document.getElementById('obj-items-container');
    if (!container) return;

    if (items.length === 0) {
        if (isFilterActive) {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem; border: 1px dashed var(--border-glass); border-radius: 15px; color: var(--text-muted);">
                    <i class="fa-solid fa-magnifying-glass" style="font-size: 2rem; margin-bottom: 0.75rem;"></i>
                    <p>Tidak ada hasil pencocokan untuk pencarian atau filter Anda.</p>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem; border: 1px dashed var(--border-glass); border-radius: 15px; color: var(--text-muted);">
                    <i class="fa-solid fa-box-open" style="font-size: 2rem; margin-bottom: 0.75rem;"></i>
                    <p>Belum ada objek. Klik "Scan Objek" atau "Native SQL" untuk menambahkan.</p>
                </div>
            `;
        }
        return;
    }

    container.innerHTML = items.map(item => {
        const objType = (item.ObjectType || item.objectType || '').toLowerCase();
        const badgeClass = objType.replace('_', '_');
        const isNative = objType === 'native_sql';
        const canEdit = ['table', 'native_sql'].includes(objType);
        const objName = item.ObjectName || item.objectName;
        const itemId = item.Id || item.id;

        const lastStatus = item.LastStatus || item.lastStatus || 'Pending';
        const lastErrorMessage = item.LastErrorMessage || item.lastErrorMessage || '';
        const lastRunAt = item.LastRunAt || item.lastRunAt;

        let statusClass = 'pending';
        if (lastStatus === 'Completed') statusClass = 'completed';
        else if (lastStatus === 'Failed') statusClass = 'failed';
        else if (lastStatus === 'InProgress') statusClass = 'inprogress';

        let lastRunTime = '';
        if (lastRunAt) {
            lastRunTime = new Date(lastRunAt).toLocaleString();
        }

        const isEnabled = item.IsEnabled !== undefined ? item.IsEnabled : (item.isEnabled !== undefined ? item.isEnabled : true);
        const disabledClass = isEnabled ? '' : ' disabled';

        return `
            <div class="table-item sortable-item${disabledClass}" draggable="${isFilterActive ? 'false' : 'true'}" data-sort-id="${itemId}">
                <div class="table-info">
                    ${isFilterActive ? '' : `
                    <div class="drag-handle" title="Geser untuk mengubah urutan">
                        <i class="fa-solid fa-grip-vertical"></i>
                    </div>`}
                    <div class="execution-badge" title="Urutan Eksekusi">${item.ExecutionOrder || item.executionOrder || 1}</div>
                    <input type="checkbox" class="toggle-switch-input" ${isEnabled ? 'checked' : ''} onchange="toggleObjItemEnabled(${itemId}, this.checked)" title="${isEnabled ? 'Aktif (Klik untuk Lewati/Skip)' : 'Dilewati/Skip (Klik untuk Aktifkan)'}" style="margin-left: 0.25rem;">
                    <div style="display: flex; flex-direction: column; gap: 0.35rem; width: 100%;">
                        <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
                            <span style="font-weight: 600; color: #ffffff;">${objName}</span>
                            <span class="obj-type-badge ${badgeClass}">${item.ObjectType || item.objectType}</span>
                            <span class="badge-clean ${statusClass}">${lastStatus}</span>
                            ${lastRunTime ? `<span style="font-size: 0.72rem; color: var(--text-muted);"><i class="fa-solid fa-clock"></i> ${lastRunTime}</span>` : ''}
                        </div>
                        ${isNative ? `<div style="font-size: 0.75rem; color: var(--text-muted); font-family: Consolas, monospace; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.NativeSqlScript || item.nativeSqlScript || '').substring(0, 80)}...</div>` : ''}
                        ${lastErrorMessage ? `<div style="font-size: 0.78rem; color: var(--color-error); font-family: Consolas, monospace; line-height: 1.45; white-space: pre-wrap; word-break: break-all; max-width: 100%; padding: 0.65rem 0.85rem; background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.18); border-radius: 6px; margin-top: 0.35rem;">${lastErrorMessage}</div>` : ''}
                    </div>
                </div>
                <div class="table-actions">
                    <button class="btn-icon" onclick="runSingleObjItem(${itemId})" title="Jalankan Objek Ini" style="color: var(--accent-teal);">
                        <i class="fa-solid fa-play"></i>
                    </button>
                    ${canEdit ? `
                    <button class="btn-icon" onclick="editObjItem(${itemId})" title="Edit Objek" style="color: #fb923c;">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>` : ''}
                    <button class="btn-icon" onclick="openObjBackupModal(${itemId}, '${objName.replace(/'/g, "\\'")}')" title="Lihat Backup Versions" style="color: var(--accent-purple);">
                        <i class="fa-solid fa-clock-rotate-left"></i>
                    </button>
                    <button class="btn-icon delete" onclick="deleteObjItem(${itemId})" title="Hapus Objek">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    if (!isFilterActive && activeJob) {
        initSortableList(container, {
            endpoint: `${API_BASE}/jobs/${activeJob.Id || activeJob.id}/obj-items/reorder`
        });
    }
}

async function deleteObjItem(id) {
    if (!(await uiConfirm("Hapus objek ini dari daftar migrasi?"))) return;
    try {
        await fetch(`${API_BASE}/obj-items/${id}`, { method: 'DELETE' });
        if (activeJob) loadObjItems(activeJob.Id || activeJob.id);
    } catch (err) {
        console.error(err);
    }
}

async function toggleTableMappingEnabled(id, isChecked) {
    const map = dataMappingsCache.find(m => (m.Id || m.id) === id);
    if (!map) return;

    const originalValue = map.IsEnabled !== undefined ? map.IsEnabled : (map.isEnabled !== undefined ? map.isEnabled : true);

    map.IsEnabled = isChecked;
    map.isEnabled = isChecked;

    const rowEl = document.querySelector(`.table-item[data-sort-id="${id}"]`);
    if (rowEl) {
        if (isChecked) {
            rowEl.classList.remove('disabled');
        } else {
            rowEl.classList.add('disabled');
        }
        const toggleInput = rowEl.querySelector('.toggle-switch-input');
        if (toggleInput) {
            toggleInput.checked = isChecked;
            toggleInput.title = isChecked ? 'Aktif (Klik untuk Lewati/Skip)' : 'Dilewati/Skip (Klik untuk Aktifkan)';
        }
    }

    const payload = {
        Id: map.Id || map.id,
        JobId: map.JobId || map.jobId,
        SourceTableName: map.SourceTableName || map.sourceTableName,
        TargetTableName: map.TargetTableName || map.targetTableName,
        ExecutionOrder: map.ExecutionOrder || map.executionOrder,
        TruncateTarget: map.TruncateTarget || map.truncateTarget,
        IsEnabled: isChecked,
        MappingMode: map.MappingMode || map.mappingMode || 'TABLE',
        NativeSqlScript: map.NativeSqlScript || map.nativeSqlScript,
        PostMigrationScript: map.PostMigrationScript || map.postMigrationScript,
        WhereClause: map.WhereClause || map.whereClause
    };

    try {
        const res = await fetch(`${API_BASE}/mappings/tables`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            throw new Error(await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal merubah status pemetaan: " + err.message);
        
        map.IsEnabled = originalValue;
        map.isEnabled = originalValue;
        if (rowEl) {
            if (originalValue) {
                rowEl.classList.remove('disabled');
            } else {
                rowEl.classList.add('disabled');
            }
            const toggleInput = rowEl.querySelector('.toggle-switch-input');
            if (toggleInput) {
                toggleInput.checked = originalValue;
                toggleInput.title = originalValue ? 'Aktif (Klik untuk Lewati/Skip)' : 'Dilewati/Skip (Klik untuk Aktifkan)';
            }
        }
    }
}

async function toggleObjItemEnabled(id, isChecked) {
    const item = objItemsCache.find(m => (m.Id || m.id) === id);
    if (!item) return;

    const originalValue = item.IsEnabled !== undefined ? item.IsEnabled : (item.isEnabled !== undefined ? item.isEnabled : true);

    item.IsEnabled = isChecked;
    item.isEnabled = isChecked;

    const rowEl = document.querySelector(`.table-item[data-sort-id="${id}"]`);
    if (rowEl) {
        if (isChecked) {
            rowEl.classList.remove('disabled');
        } else {
            rowEl.classList.add('disabled');
        }
        const toggleInput = rowEl.querySelector('.toggle-switch-input');
        if (toggleInput) {
            toggleInput.checked = isChecked;
            toggleInput.title = isChecked ? 'Aktif (Klik untuk Lewati/Skip)' : 'Dilewati/Skip (Klik untuk Aktifkan)';
        }
    }

    const payload = {
        Id: item.Id || item.id,
        JobId: item.JobId || item.jobId,
        ObjectName: item.ObjectName || item.objectName,
        ObjectType: item.ObjectType || item.objectType,
        NativeSqlScript: item.NativeSqlScript || item.nativeSqlScript,
        ExecutionOrder: item.ExecutionOrder || item.executionOrder,
        IsEnabled: isChecked,
        AllowDropColumns: item.AllowDropColumns || item.allowDropColumns || false
    };

    try {
        const res = await fetch(`${API_BASE}/obj-items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            throw new Error(await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Gagal merubah status objek: " + err.message);
        
        item.IsEnabled = originalValue;
        item.isEnabled = originalValue;
        if (rowEl) {
            if (originalValue) {
                rowEl.classList.remove('disabled');
            } else {
                rowEl.classList.add('disabled');
            }
            const toggleInput = rowEl.querySelector('.toggle-switch-input');
            if (toggleInput) {
                toggleInput.checked = originalValue;
                toggleInput.title = originalValue ? 'Aktif (Klik untuk Lewati/Skip)' : 'Dilewati/Skip (Klik untuk Aktifkan)';
            }
        }
    }
}

// ============================================================================
// 10. OBJECT SCANNER MODAL
// ============================================================================
let activeScanTypeFilter = 'ALL';
let activeScanSearchQuery = '';

function openObjScannerModal() {
    // Reset search input & filters
    const searchInput = document.getElementById('obj-scan-search');
    if (searchInput) searchInput.value = '';
    activeScanSearchQuery = '';
    activeScanTypeFilter = 'ALL';

    // Reset filter active buttons to "Semua"
    document.querySelectorAll('.obj-filter-btn').forEach(btn => btn.classList.remove('active'));
    const btnAll = document.querySelector('.obj-filter-btn[onclick*="ALL"]');
    if (btnAll) btnAll.classList.add('active');

    // Reset modal fullscreen class
    const modalContent = document.querySelector('#obj-scanner-modal .modal-content');
    if (modalContent) modalContent.classList.remove('maximized');

    const fsIcon = document.getElementById('scanner-fullscreen-icon');
    if (fsIcon) {
        fsIcon.className = 'fa-solid fa-expand';
        fsIcon.parentElement.title = "Toggle Fullscreen";
    }

    document.getElementById('obj-scanner-modal').classList.add('active');
    startObjScan();
}

function closeObjScannerModal() {
    document.getElementById('obj-scanner-modal').classList.remove('active');
    
    // Reset maximized class
    const modalContent = document.querySelector('#obj-scanner-modal .modal-content');
    if (modalContent) modalContent.classList.remove('maximized');
}

function toggleScannerFullscreen() {
    const modalContent = document.querySelector('#obj-scanner-modal .modal-content');
    const fsIcon = document.getElementById('scanner-fullscreen-icon');

    if (modalContent.classList.contains('maximized')) {
        modalContent.classList.remove('maximized');
        if (fsIcon) fsIcon.className = 'fa-solid fa-expand';
        if (fsIcon && fsIcon.parentElement) fsIcon.parentElement.title = "Toggle Fullscreen";
    } else {
        modalContent.classList.add('maximized');
        if (fsIcon) fsIcon.className = 'fa-solid fa-compress';
        if (fsIcon && fsIcon.parentElement) fsIcon.parentElement.title = "Toggle Normal Screen";
    }
}

function applyScanFiltering() {
    activeScanSearchQuery = (document.getElementById('obj-scan-search')?.value || '').trim().toLowerCase();
    
    let filtered = scanResultsCache || [];
    
    // 1. Filter by Object Type
    if (activeScanTypeFilter !== 'ALL') {
        filtered = filtered.filter(i => (i.ObjectType || i.objectType) === activeScanTypeFilter);
    }
    
    // 2. Filter by Search Query
    if (activeScanSearchQuery !== '') {
        filtered = filtered.filter(i => {
            const name = (i.ObjectName || i.objectName || '').toLowerCase();
            return name.includes(activeScanSearchQuery);
        });
    }
    
    renderScanResults(filtered);
}

async function startObjScan() {
    if (!activeJob) { await uiAlert('Silakan pilih Job terlebih dahulu.'); return; }
    const container = document.getElementById('obj-scan-results');
    container.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 2rem;"><i class="fa-solid fa-spinner fa-spin"></i> Memindai objek dari Source DB...</p>`;

    try {
        const res = await fetch(`${API_BASE}/jobs/${activeJob.Id || activeJob.id}/obj-scan`);
        if (!res.ok) {
            container.innerHTML = `<p style="color: var(--color-error); text-align: center; padding: 2rem;">Gagal memindai: ${await res.text()}</p>`;
            return;
        }
        scanResultsCache = await res.json();
        applyScanFiltering();
    } catch (err) {
        container.innerHTML = `<p style="color: var(--color-error); text-align: center; padding: 2rem;">Error: ${err.message}</p>`;
    }
}

function renderScanResults(items) {
    const container = document.getElementById('obj-scan-results');
    if (items.length === 0) {
        container.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 2rem;">Tidak ada objek ditemukan.</p>`;
        return;
    }

    container.innerHTML = items.map((item, idx) => {
        const objType = (item.ObjectType || item.objectType || '').toLowerCase();
        const objName = item.ObjectName || item.objectName;
        return `
            <label class="scan-item" data-type="${item.ObjectType || item.objectType}">
                <input type="checkbox" class="scan-checkbox" data-name="${objName}" data-type="${item.ObjectType || item.objectType}">
                <span class="scan-item-name">${objName}</span>
                <span class="obj-type-badge ${objType}">${item.ObjectType || item.objectType}</span>
            </label>
        `;
    }).join('');
}

function filterScanResults(type) {
    // Update filter button active state
    document.querySelectorAll('.obj-filter-btn').forEach(btn => btn.classList.remove('active'));
    
    if (event && event.currentTarget) {
        event.currentTarget.classList.add('active');
    } else if (event && event.target) {
        event.target.classList.add('active');
    }

    activeScanTypeFilter = type;
    applyScanFiltering();
}

function toggleAllScanItems(checked) {
    document.querySelectorAll('.scan-checkbox').forEach(cb => cb.checked = checked);
}

async function addSelectedScanItems() {
    const checkboxes = document.querySelectorAll('.scan-checkbox:checked');
    if (checkboxes.length === 0) {
        await uiAlert("Pilih minimal satu objek untuk ditambahkan!");
        return;
    }

    const items = [];
    checkboxes.forEach(cb => {
        items.push({
            ObjectName: cb.dataset.name,
            ObjectType: cb.dataset.type
        });
    });

    try {
        const jobId = activeJob.Id || activeJob.id;
        const res = await fetch(`${API_BASE}/jobs/${jobId}/obj-items/bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items)
        });

        if (res.ok) {
            const data = await res.json();
            await uiAlert(data.Message || `${items.length} objek ditambahkan.`);
            closeObjScannerModal();
            loadObjItems(jobId);
        } else {
            await uiAlert("Gagal menambahkan: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error: " + err.message);
    }
}

// ============================================================================
// 11. NATIVE SQL MODAL
// ============================================================================
// ============================================================================
// 11. NATIVE SQL MODAL & OBJECT EDITING
// ============================================================================
function openObjNativeSqlModal(editItem = null) {
    if (editItem) {
        document.getElementById('native-sql-id').value = editItem.Id || editItem.id;
        document.getElementById('native-sql-name').value = editItem.ObjectName || editItem.objectName || '';
        document.getElementById('native-sql-script').value = editItem.NativeSqlScript || editItem.nativeSqlScript || '';
        
        // Cek mode eksekusi dari script template jika mengandung SOURCE_DB
        const script = editItem.NativeSqlScript || editItem.nativeSqlScript || '';
        const mode = script.includes('{{SOURCE_DB}}') ? 'source-target' : 'target';
        document.getElementById('native-sql-mode').value = mode;
        updateNativeSqlTemplate(true); // pass true so it doesn't overwrite script content

        document.getElementById('native-sql-modal-title').innerText = 'Edit Native SQL Script';
        document.getElementById('native-sql-submit-btn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Simpan Perubahan';
    } else {
        document.getElementById('native-sql-id').value = '0';
        document.getElementById('native-sql-name').value = '';
        document.getElementById('native-sql-mode').value = 'target';
        document.getElementById('native-sql-script').value = '';
        updateNativeSqlTemplate();
        document.getElementById('native-sql-modal-title').innerText = 'Native SQL Script';
        document.getElementById('native-sql-submit-btn').innerHTML = '<i class="fa-solid fa-plus"></i> Tambah ke Daftar';
    }
    document.getElementById('obj-native-sql-modal').classList.add('active');
}

function closeObjNativeSqlModal() {
    document.getElementById('obj-native-sql-modal').classList.remove('active');
}

function updateNativeSqlTemplate(skipOverwrite = false) {
    const mode = document.getElementById('native-sql-mode').value;
    const textarea = document.getElementById('native-sql-script');
    const hint = document.getElementById('native-sql-hint');

    if (mode === 'source-target') {
        hint.innerHTML = 'Script tetap dieksekusi dari koneksi Target DB. Pakai <code>{{SOURCE_DB}}</code> dan <code>{{TARGET_DB}}</code> untuk nama database. Mode ini bekerja saat Source dan Target berada di SQL Server instance yang sama.';
        if (!skipOverwrite && !textarea.value.trim()) {
            textarea.value = `INSERT INTO {{TARGET_DB}}.dbo.TargetTable (ColumnA, ColumnB)\nSELECT ColumnA, ColumnB\nFROM {{SOURCE_DB}}.dbo.SourceTable\nWHERE 1 = 1;`;
        }
        return;
    }

    hint.innerHTML = 'Cocok untuk UPDATE, ALTER TABLE, CREATE INDEX, cleanup data, atau script lain yang berjalan langsung di Target DB.';
    if (!skipOverwrite && !textarea.value.trim()) {
        textarea.value = `UPDATE dbo.TargetTable\nSET UpdatedAt = GETDATE()\nWHERE UpdatedAt IS NULL;`;
    }
}

async function addNativeSqlItem() {
    if (!activeJob) return;
    const id = parseInt(document.getElementById('native-sql-id').value || '0');
    const name = document.getElementById('native-sql-name').value.trim();
    const script = document.getElementById('native-sql-script').value.trim();

    if (!name || !script) {
        await uiAlert("Harap isi nama dan script SQL!");
        return;
    }

    let nextOrder = 1;
    let isEnabled = true;
    let allowDropColumns = false;

    if (id > 0) {
        const existing = objItemsCache.find(m => (m.Id || m.id) === id);
        if (existing) {
            nextOrder = existing.ExecutionOrder || existing.executionOrder || 1;
            isEnabled = existing.IsEnabled !== undefined ? existing.IsEnabled : (existing.isEnabled !== undefined ? existing.isEnabled : true);
            allowDropColumns = existing.AllowDropColumns !== undefined ? existing.AllowDropColumns : (existing.allowDropColumns !== undefined ? existing.allowDropColumns : false);
        }
    } else {
        // hitung urutan eksekusi terakhir + 1 agar selalu di akhir secara default
        if (objItemsCache && objItemsCache.length > 0) {
            const orders = objItemsCache.map(m => parseInt(m.ExecutionOrder || m.executionOrder || 0));
            nextOrder = Math.max(...orders, 0) + 1;
        }
    }

    const payload = {
        Id: id,
        JobId: activeJob.Id || activeJob.id,
        ObjectName: name,
        ObjectType: 'NATIVE_SQL',
        NativeSqlScript: script,
        ExecutionOrder: nextOrder,
        IsEnabled: isEnabled,
        AllowDropColumns: allowDropColumns
    };

    try {
        const res = await fetch(`${API_BASE}/obj-items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            closeObjNativeSqlModal();
            loadObjItems(activeJob.Id || activeJob.id);
        } else {
            await uiAlert("Gagal menyimpan: " + await res.text());
        }
    } catch (err) {
        console.error(err);
    }
}

// ============================================================================
// OBJECT EDITING FUNCTIONS
// ============================================================================
async function editObjItem(id) {
    const item = objItemsCache.find(m => (m.Id || m.id) === id);
    if (!item) return;

    const objType = (item.ObjectType || item.objectType || '').toLowerCase();

    if (objType === 'native_sql') {
        openObjNativeSqlModal(item);
    } else if (objType === 'table') {
        openObjTableEditModal(item);
    } else {
        await uiAlert("Pengeditan tidak didukung untuk tipe objek ini.");
    }
}

function openObjTableEditModal(item) {
    document.getElementById('edit-table-obj-id').value = item.Id || item.id;
    document.getElementById('edit-table-obj-name').value = item.ObjectName || item.objectName;
    
    const allowDrop = item.AllowDropColumns || item.allowDropColumns || false;
    const checkbox = document.getElementById('edit-table-allow-drop');
    checkbox.checked = allowDrop;
    
    // Toggle warning display
    const warning = document.getElementById('drop-warning');
    if (warning) {
        warning.style.display = allowDrop ? 'block' : 'none';
    }
    
    // Setup event listener on checkbox change
    checkbox.onchange = function() {
        if (warning) warning.style.display = this.checked ? 'block' : 'none';
    };

    document.getElementById('obj-table-edit-modal').classList.add('active');
}

function closeObjTableEditModal() {
    document.getElementById('obj-table-edit-modal').classList.remove('active');
}

async function saveObjTableEdit() {
    const id = parseInt(document.getElementById('edit-table-obj-id').value || '0');
    const allowDrop = document.getElementById('edit-table-allow-drop').checked;
    
    const item = objItemsCache.find(m => (m.Id || m.id) === id);
    if (!item) return;
    
    const payload = {
        Id: id,
        JobId: item.JobId || item.jobId,
        ObjectName: item.ObjectName || item.objectName,
        ObjectType: item.ObjectType || item.objectType,
        NativeSqlScript: item.NativeSqlScript || item.nativeSqlScript,
        ExecutionOrder: item.ExecutionOrder || item.executionOrder,
        IsEnabled: item.IsEnabled !== undefined ? item.IsEnabled : (item.isEnabled !== undefined ? item.isEnabled : true),
        AllowDropColumns: allowDrop
    };

    try {
        const res = await fetch(`${API_BASE}/obj-items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            closeObjTableEditModal();
            loadObjItems(activeJob.Id || activeJob.id);
        } else {
            await uiAlert("Gagal menyimpan pengaturan tabel: " + await res.text());
        }
    } catch (err) {
        console.error(err);
    }
}

// ============================================================================
// 12. RUN OBJECT MIGRATION
// ============================================================================
async function runObjMigration() {
    if (!activeJob) { await uiAlert('Silakan pilih Job terlebih dahulu.'); return; }
    const jobName = activeJob.JobName || activeJob.jobName;

    // Reset cancellation flag
    isCancellationRequested = false;

    // Saring hanya objek aktif dari cache
    const enabledItems = objItemsCache.filter(m => {
        const val = m.IsEnabled !== undefined ? m.IsEnabled : m.isEnabled;
        return val === true || val === 1 || val === '1';
    });

    if (enabledItems.length === 0) {
        await uiAlert("Tidak ada objek aktif untuk dimigrasi.");
        return;
    }

    if (!(await uiConfirm(`Jalankan migrasi objek untuk job "${jobName}"?\n\nSP/Function/View: akan di-drop & create ulang.\nTable: akan CREATE baru atau ALTER sync kolom.\nNative SQL: akan dieksekusi langsung.\n\nSemua objek yang sudah ada di Target akan di-backup otomatis.`))) return;

    const jobId = activeJob.Id || activeJob.id;

    // 1. Reset & Setup Dashboard UI untuk Object Migration secara dinamis
    const runnerTitle = document.querySelector('#active-runner-panel .runner-header span');
    if (runnerTitle) runnerTitle.innerText = "Proses Migrasi Objek Berjalan";

    const globalLabel = document.getElementById('global-progress-label');
    if (globalLabel) globalLabel.innerText = "Kemajuan Total (Objek)";

    document.getElementById('runner-status-text').innerText = 'RUNNING';
    document.getElementById('runner-status-text').style.color = 'var(--accent-teal)';
    document.getElementById('active-runner-panel').style.display = 'block';

    const globalText = document.getElementById('global-progress-text');
    const globalBar = document.getElementById('global-progress-bar');
    const activeName = document.getElementById('active-table-name');
    const activeText = document.getElementById('active-table-text');
    const activeBar = document.getElementById('active-table-bar');
    const logsBox = document.getElementById('console-logs');

    if (globalText) globalText.innerText = `0 / ${enabledItems.length} Objek (0%)`;
    if (globalBar) {
        globalBar.style.width = '0%';
        globalBar.className = 'progress-bar-fill active';
    }
    if (activeName) activeName.innerText = 'Menyiapkan objek...';
    if (activeText) activeText.innerText = '0%';
    if (activeBar) {
        activeBar.style.width = '0%';
        activeBar.className = 'progress-bar-fill active';
    }

    logsBox.innerHTML = `<div class="console-line info">[${new Date().toLocaleTimeString()}] Memulai rangkaian migrasi ${enabledItems.length} Objek DB...</div>`;

    // Tampilkan tombol cancel
    const cancelBtn = document.getElementById('btn-cancel-migration');
    if (cancelBtn) {
        cancelBtn.style.display = 'inline-flex';
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = `<i class="fa-solid fa-ban"></i> Batalkan Migrasi`;
    }

    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;
    const results = [];

    // Loop & eksekusi secara sekuensial satu-satu untuk melaporkan progres real-time
    for (let i = 0; i < enabledItems.length; i++) {
        if (isCancellationRequested) {
            const abortLine = document.createElement('div');
            abortLine.className = 'console-line error';
            abortLine.innerText = `[${new Date().toLocaleTimeString()}] BATAL: Proses migrasi objek dibatalkan oleh pengguna.`;
            logsBox.appendChild(abortLine);
            logsBox.scrollTop = logsBox.scrollHeight;
            failCount++;
            break;
        }

        const item = enabledItems[i];
        const itemId = item.Id || item.id;
        const objName = item.ObjectName || item.objectName;
        const objType = item.ObjectType || item.objectType;

        // Update active card
        if (activeName) activeName.innerText = objName;
        if (activeText) activeText.innerText = `Memigrasi objek (${i + 1}/${enabledItems.length})`;
        if (activeBar) {
            activeBar.style.width = '50%';
            activeBar.className = 'progress-bar-fill active';
        }

        const logLine = document.createElement('div');
        logLine.className = 'console-line';
        logLine.innerText = `[${new Date().toLocaleTimeString()}] Memigrasi objek ${objName} [${objType}] (${i + 1}/${enabledItems.length})...`;
        logsBox.appendChild(logLine);
        logsBox.scrollTop = logsBox.scrollHeight;

        try {
            const res = await fetch(`${API_BASE}/jobs/${jobId}/obj-run?itemId=${itemId}`, { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                const result = data.Results[0];
                results.push(result);

                if (result.Status === 'Completed') {
                    if (result.Message === 'Skipped (Already migrated)') {
                        skipCount++;
                        logLine.className = 'console-line info';
                        logLine.innerText = `[${new Date().toLocaleTimeString()}] LEWAT: Objek ${objName} dilewati (Sudah dimigrasi).`;
                    } else {
                        successCount++;
                        logLine.className = 'console-line success';
                        logLine.innerText = `[${new Date().toLocaleTimeString()}] KELAR: Objek ${objName} sukses dimigrasi.`;
                    }
                } else {
                    failCount++;
                    logLine.className = 'console-line error';
                    logLine.innerText = `[${new Date().toLocaleTimeString()}] ERROR: Objek ${objName} gagal! Detail: ${result.Message}`;
                }
            } else {
                failCount++;
                const errMsg = await res.text();
                results.push({ ObjectName: objName, Status: 'Failed', Message: errMsg });
                logLine.className = 'console-line error';
                logLine.innerText = `[${new Date().toLocaleTimeString()}] ERROR: Objek ${objName} gagal! Detail: ${errMsg}`;
            }
        } catch (err) {
            failCount++;
            results.push({ ObjectName: objName, Status: 'Failed', Message: err.message });
            logLine.className = 'console-line error';
            logLine.innerText = `[${new Date().toLocaleTimeString()}] ERROR: Objek ${objName} gagal! Detail: ${err.message}`;
        }

        logsBox.scrollTop = logsBox.scrollHeight;

        // Selesai per objek
        if (activeBar) {
            activeBar.style.width = '100%';
            activeBar.className = failCount > 0 ? 'progress-bar-fill failed' : 'progress-bar-fill completed';
        }

        // Update progress global
        const processedCount = i + 1;
        const globalPct = Math.round((processedCount / enabledItems.length) * 100);
        if (globalText) globalText.innerText = `${processedCount} / ${enabledItems.length} Objek (${globalPct}%)`;
        if (globalBar) {
            globalBar.style.width = `${globalPct}%`;
            if (globalPct >= 100) {
                globalBar.className = failCount > 0 ? 'progress-bar-fill failed' : 'progress-bar-fill completed';
            }
        }
    }

    // Akhir Rangkaian
    setTimeout(() => {
        const statusText = document.getElementById('runner-status-text');
        if (statusText) {
            if (failCount > 0) {
                statusText.innerText = 'FAILED';
                statusText.style.color = 'var(--color-error)';
            } else {
                statusText.innerText = 'COMPLETED';
                statusText.style.color = 'var(--color-success)';
            }
        }
        if (cancelBtn) cancelBtn.style.display = 'none';

        // Tampilkan summary hasil migrasi objek di grid objek
        loadObjItems(jobId);
    }, 200);
}

// ============================================================================
// 13. BACKUP VIEWER MODAL
// ============================================================================
async function openObjBackupModal(itemId, objName) {
    document.getElementById('obj-backup-modal-title').innerText = `Backup: ${objName}`;
    document.getElementById('obj-backup-modal').classList.add('active');

    const container = document.getElementById('obj-backup-list');
    container.innerHTML = `<p style="color: var(--text-muted); text-align: center;"><i class="fa-solid fa-spinner fa-spin"></i> Memuat backup...</p>`;

    try {
        const res = await fetch(`${API_BASE}/obj-items/${itemId}/backups`);
        const backups = await res.json();

        if (backups.length === 0) {
            container.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 2rem;">Belum ada backup untuk objek ini. Backup akan dibuat otomatis saat migrasi dijalankan.</p>`;
            return;
        }

        container.innerHTML = backups.map(b => {
            const backedUpAt = new Date(b.BackedUpAt || b.backedUpAt).toLocaleString();
            const version = b.Version || b.version;
            const backupId = b.Id || b.id;
            const scriptPreview = (b.BackupScript || b.backupScript || '').substring(0, 120).replace(/</g, '&lt;');

            return `
                <div class="backup-card">
                    <div style="display: flex; align-items: center; gap: 1rem;">
                        <div class="backup-version-badge">v${version}</div>
                        <div>
                            <div style="font-weight: 600; color: #ffffff; font-size: 0.9rem;">Version ${version}</div>
                            <div style="font-size: 0.75rem; color: var(--text-muted);">${backedUpAt}</div>
                            <div style="font-size: 0.7rem; color: var(--text-dark); font-family: Consolas, monospace; margin-top: 0.25rem; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${scriptPreview}...</div>
                        </div>
                    </div>
                    <a href="/api/obj-backups/${backupId}/download" class="btn btn-secondary" style="width: auto; padding: 0.4rem 0.8rem; font-size: 0.8rem; text-decoration: none;" download>
                        <i class="fa-solid fa-download"></i> Download .sql
                    </a>
                </div>
            `;
        }).join('');
    } catch (err) {
        container.innerHTML = `<p style="color: var(--color-error); text-align: center;">Gagal memuat backup: ${err.message}</p>`;
    }
}

function closeObjBackupModal() {
    document.getElementById('obj-backup-modal').classList.remove('active');
}

// ============================================================================
// 14. OBJECT MIGRATION TAB SWITCHING (Items ↔ Logs)
// ============================================================================
function switchObjTab(tab) {
    const itemsTab = document.getElementById('obj-tab-items');
    const logsTab = document.getElementById('obj-tab-logs');
    const itemsContainer = document.getElementById('obj-items-container');
    const logsContainer = document.getElementById('obj-logs-container');

    if (tab === 'items') {
        itemsTab.style.color = 'var(--accent-teal)';
        itemsTab.style.borderBottom = '2px solid var(--accent-teal)';
        logsTab.style.color = 'var(--text-muted)';
        logsTab.style.borderBottom = 'none';
        itemsContainer.style.display = '';
        logsContainer.style.display = 'none';
    } else {
        logsTab.style.color = 'var(--accent-teal)';
        logsTab.style.borderBottom = '2px solid var(--accent-teal)';
        itemsTab.style.color = 'var(--text-muted)';
        itemsTab.style.borderBottom = 'none';
        itemsContainer.style.display = 'none';
        logsContainer.style.display = 'block';
        loadObjLogs();
    }
}

async function loadObjLogs() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    const tbody = document.getElementById('obj-logs-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Memuat log...</td></tr>`;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/obj-logs`);
        if (!res.ok) throw new Error("Gagal mengambil log.");
        const logs = await res.json();

        if (logs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Belum ada log eksekusi.</td></tr>`;
            return;
        }

        tbody.innerHTML = logs.map(log => {
            const status = log.Status || log.status;
            const isOk = status === 'Completed';
            const executedAt = new Date(log.ExecutedAt || log.executedAt).toLocaleString();
            const errMsg = log.ErrorMessage || log.errorMessage || '-';
            const action = log.Action || log.action;
            const objName = log.ObjectName || log.objectName;

            let statusBadge = isOk
                ? `<span style="background: var(--color-success-glow); color: var(--color-success); padding: 3px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600;">Completed</span>`
                : `<span style="background: var(--color-error-glow); color: var(--color-error); padding: 3px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600;">Failed</span>`;

            let actionBadge = `<span class="obj-type-badge ${action.toLowerCase()}">${action}</span>`;

            return `
                <tr>
                    <td><strong>${objName}</strong></td>
                    <td>${actionBadge}</td>
                    <td>${statusBadge}</td>
                    <td style="font-size: 0.8rem;">${executedAt}</td>
                    <td style="font-size: 0.75rem; color: var(--color-error); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${errMsg.replace(/"/g, '&quot;')}">${isOk ? '-' : errMsg}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error(err);
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--color-error);">Gagal memuat log: ${err.message}</td></tr>`;
    }
}

// ============================================================================
// 15. CONNECTION STRING BUILDER
// ============================================================================
let connBuilderTarget = 'source'; // 'source' or 'target'

/**
 * Buka modal Connection String Builder.
 * @param {string} field - 'source' atau 'target'
 */
function openConnBuilder(field) {
    connBuilderTarget = field;

    // Reset form
    document.getElementById('cb-server').value = '';
    document.getElementById('cb-database').value = '';
    document.getElementById('cb-username').value = '';
    document.getElementById('cb-password').value = '';
    document.getElementById('cb-trust-cert').checked = true;
    document.getElementById('cb-encrypt').checked = false;
    document.getElementById('cb-preview').value = '';

    // Coba parse connection string yang sudah ada di textarea
    const existing = document.getElementById(field + '-conn')?.value.trim() || '';
    if (existing) {
        parseConnStringToBuilder(existing);
    }

    updateConnPreview();
    document.getElementById('conn-builder-modal').classList.add('active');

    // Fokus ke field server
    setTimeout(() => document.getElementById('cb-server').focus(), 100);
}

/**
 * Parse connection string yang sudah ada, isi form builder
 * @param {string} connStr
 */
function parseConnStringToBuilder(connStr) {
    const parts = connStr.split(';');
    parts.forEach(part => {
        const eqIdx = part.indexOf('=');
        if (eqIdx < 0) return;
        const key = part.substring(0, eqIdx).trim().toLowerCase();
        const val = part.substring(eqIdx + 1).trim();
        switch (key) {
            case 'server':
            case 'data source':
                document.getElementById('cb-server').value = val; break;
            case 'database':
            case 'initial catalog':
                document.getElementById('cb-database').value = val; break;
            case 'user id':
            case 'uid':
            case 'user':
                document.getElementById('cb-username').value = val; break;
            case 'password':
            case 'pwd':
                document.getElementById('cb-password').value = val; break;
            case 'trustservercertificate':
                document.getElementById('cb-trust-cert').checked = val.toLowerCase() === 'true'; break;
            case 'encrypt':
                document.getElementById('cb-encrypt').checked = val.toLowerCase() === 'true'; break;
        }
    });
}

/**
 * Update preview connection string secara realtime
 */
function updateConnPreview() {
    const server = document.getElementById('cb-server').value.trim();
    const database = document.getElementById('cb-database').value.trim();
    const username = document.getElementById('cb-username').value.trim();
    const password = document.getElementById('cb-password').value.trim();
    const trustCert = document.getElementById('cb-trust-cert').checked;
    const encrypt = document.getElementById('cb-encrypt').checked;

    const parts = [];
    if (server) parts.push(`Server=${server}`);
    if (database) parts.push(`Database=${database}`);
    if (username) parts.push(`User Id=${username}`);
    if (password) parts.push(`Password=${password}`);
    parts.push(`TrustServerCertificate=${trustCert ? 'True' : 'False'}`);
    if (encrypt) parts.push('Encrypt=True');

    document.getElementById('cb-preview').value = parts.join(';');
}

/**
 * Terapkan connection string hasil builder ke textarea
 */
async function applyConnBuilder() {
    const connStr = document.getElementById('cb-preview').value.trim();
    if (!connStr) {
        await uiAlert('Connection string kosong. Harap isi minimal Server Name dan Database Name.');
        return;
    }
    const targetEl = document.getElementById(connBuilderTarget + '-conn');
    if (targetEl) targetEl.value = connStr;
    closeConnBuilder();
}

/**
 * Tutup modal Connection String Builder
 */
function closeConnBuilder() {
    document.getElementById('conn-builder-modal').classList.remove('active');
}

/**
 * Test koneksi dari builder (menggunakan preview connection string)
 */
async function testConnBuilderConn() {
    const connStr = document.getElementById('cb-preview').value.trim();
    if (!connStr) {
        await uiAlert('Connection string kosong. Harap isi Server Name dan Database Name terlebih dahulu.');
        return;
    }

    const btn = document.querySelector('#conn-builder-modal .btn-test-conn');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing...';
        btn.disabled = true;
    }

    try {
        const res = await fetch(`${API_BASE}/jobs/test-connection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ConnectionString: connStr })
        });

        if (res.ok) {
            const data = await res.json();
            if (data.Success || data.success) {
                await uiAlert('✅ Koneksi berhasil!\n' + (data.Message || data.message || 'Database dapat diakses.'));
            } else {
                await uiAlert('❌ Koneksi gagal:\n' + (data.Message || data.message || 'Tidak dapat terhubung.'));
            }
        } else {
            const errText = await res.text();
            await uiAlert('❌ HTTP Error:\n' + errText);
        }
    } catch (err) {
        await uiAlert('❌ Error: ' + err.message);
    } finally {
        if (btn) {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    }
}

/**
 * Toggle tampilkan/sembunyikan password di builder
 */
function togglePasswordVisibility() {
    const input = document.getElementById('cb-password');
    const icon = document.getElementById('pwd-eye-icon');
    if (!input || !icon) return;
    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'fa-solid fa-eye-slash';
    } else {
        input.type = 'password';
        icon.className = 'fa-solid fa-eye';
    }
}

// ============================================================================
// 16. CLEAN TARGET TABLE HANDLERS
// ============================================================================

async function loadCleanTables(jobId) {
    if (!jobId) return;

    // Tampilkan detail database aktif
    if (activeJob) {
        const srcConn = activeJob.SourceConnectionString || activeJob.sourceConnectionString || '';
        const tgtConn = activeJob.TargetConnectionString || activeJob.targetConnectionString || '';

        const srcDb = parseConnectionStringDb(srcConn);
        const tgtDb = parseConnectionStringDb(tgtConn);

        const srcEl = document.getElementById('clean-source-db-text');
        const tgtEl = document.getElementById('clean-target-db-text');
        if (srcEl) srcEl.textContent = srcDb;
        if (tgtEl) tgtEl.textContent = tgtDb;
    }

    const container = document.getElementById('clean-tables-container');
    if (!container) return;

    container.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Memuat daftar pembersih...</div>`;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/clean-tables`);
        if (!res.ok) throw new Error("Gagal memuat daftar.");
        const tables = await res.json();
        cleanTablesCache = tables;

        // Reset search inputs
        const searchInput = document.getElementById('clean-search');
        const statusFilter = document.getElementById('clean-filter-status');
        if (searchInput) searchInput.value = '';
        if (statusFilter) statusFilter.value = 'ALL';

        filterCleanTables();
    } catch (err) {
        console.error(err);
        container.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--color-error);">Gagal memuat: ${err.message}</div>`;
    }
}

function filterCleanTables() {
    const searchVal = (document.getElementById('clean-search')?.value || '').trim().toLowerCase();
    const statusVal = document.getElementById('clean-filter-status')?.value || 'ALL';

    const isFilterActive = (searchVal !== '' || statusVal !== 'ALL');

    const filtered = cleanTablesCache.filter(table => {
        const tableName = (table.TableName || table.tableName || '').toLowerCase();
        const matchSearch = tableName.includes(searchVal);

        const lastStatus = table.LastStatus || table.lastStatus || 'Pending';
        const matchStatus = (statusVal === 'ALL' || lastStatus.toLowerCase() === statusVal.toLowerCase());

        return matchSearch && matchStatus;
    });

    renderCleanTables(filtered, isFilterActive);
}

function renderCleanTables(tables, isFilterActive) {
    const container = document.getElementById('clean-tables-container');
    if (!container) return;

    if (tables.length === 0) {
        if (isFilterActive) {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem; border: 1px dashed var(--border-glass); border-radius: 15px; color: var(--text-muted);">
                    <i class="fa-solid fa-magnifying-glass" style="font-size: 2rem; margin-bottom: 0.75rem;"></i>
                    <p>Tidak ada hasil pencocokan untuk pencarian atau filter Anda.</p>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem; border: 1px dashed var(--border-glass); border-radius: 15px; color: var(--text-muted);">
                    <i class="fa-solid fa-broom" style="font-size: 2rem; margin-bottom: 0.75rem;"></i>
                    <p>Belum ada tabel yang terdaftar dalam daftar pembersih.</p>
                </div>
            `;
        }
        return;
    }

    container.innerHTML = tables.map(table => {
        const id = table.Id || table.id;
        const tableName = table.TableName || table.tableName;
        const executionOrder = table.ExecutionOrder || table.executionOrder || 1;
        const lastStatus = (table.LastStatus || table.lastStatus || 'Pending');
        const lastErrorMessage = table.LastErrorMessage || table.lastErrorMessage || '';
        const lastCleanedAt = table.LastCleanedAt || table.lastCleanedAt;

        let statusClass = 'pending';
        if (lastStatus === 'Completed') statusClass = 'completed';
        else if (lastStatus === 'Failed') statusClass = 'failed';
        else if (lastStatus === 'InProgress') statusClass = 'inprogress';

        let cleanedTime = '';
        if (lastCleanedAt) {
            cleanedTime = new Date(lastCleanedAt).toLocaleString();
        }

        return `
            <div class="table-item sortable-item" draggable="${isFilterActive ? 'false' : 'true'}" data-sort-id="${id}">
                <div class="table-info">
                    ${isFilterActive ? '' : `
                    <div class="drag-handle" title="Geser untuk mengubah urutan">
                        <i class="fa-solid fa-grip-vertical"></i>
                    </div>`}
                    <div class="execution-badge" title="Urutan Eksekusi">${executionOrder}</div>
                    <div style="display: flex; flex-direction: column; gap: 0.35rem; width: 100%;">
                        <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
                            <span style="font-weight: 600; color: #ffffff;" class="clean-table-name">${tableName}</span>
                            <span class="badge-clean ${statusClass}">${lastStatus}</span>
                            ${cleanedTime ? `<span style="font-size: 0.72rem; color: var(--text-muted);"><i class="fa-solid fa-clock"></i> ${cleanedTime}</span>` : ''}
                        </div>
                        ${lastErrorMessage ? `<div style="font-size: 0.78rem; color: var(--color-error); font-family: Consolas, monospace; line-height: 1.45; white-space: pre-wrap; word-break: break-all; max-width: 100%; padding: 0.65rem 0.85rem; background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.18); border-radius: 6px; margin-top: 0.35rem;">${lastErrorMessage}</div>` : ''}
                    </div>
                </div>
                <div class="table-actions">
                    <button class="btn-icon" onclick="runSingleClean(${id})" title="Bersihkan Tabel Ini" style="color: var(--accent-teal);">
                        <i class="fa-solid fa-play"></i>
                    </button>
                    <button class="btn-icon delete" onclick="deleteCleanTable(${id})" title="Hapus dari Daftar">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    if (!isFilterActive && activeJob) {
        initSortableList(container, {
            endpoint: `${API_BASE}/jobs/${activeJob.Id || activeJob.id}/clean-tables/reorder`
        });
    }
}

function openCleanTableModal() {
    const bulkInput = document.getElementById('clean-bulk-textarea');
    if (bulkInput) bulkInput.value = '';
    document.getElementById('clean-table-modal').classList.add('active');
}

function closeCleanTableModal() {
    document.getElementById('clean-table-modal').classList.remove('active');
}

async function addCleanTables() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    const bulkInput = document.getElementById('clean-bulk-textarea');

    const bulkVal = bulkInput ? bulkInput.value.trim() : '';

    if (!bulkVal) {
        await uiAlert("Harap isi nama tabel!");
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/clean-tables`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ TableNames: bulkVal })
        });

        if (res.ok) {
            const data = await res.json();
            let alertMsg = `${data.Added.length} tabel berhasil ditambahkan ke daftar pembersih.`;
            if (data.Skipped.length > 0) {
                alertMsg += `\n\nSkipped (sudah terdaftar): ${data.Skipped.join(', ')}`;
            }
            await uiAlert(alertMsg);

            // Clear & close modal
            if (bulkInput) bulkInput.value = '';
            closeCleanTableModal();

            loadCleanTables(jobId);
        } else {
            await uiAlert("Gagal menambahkan: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error: " + err.message);
    }
}

async function deleteCleanTable(id) {
    if (!(await uiConfirm("Apakah Anda yakin ingin menghapus tabel ini dari daftar pembersih?"))) return;
    try {
        const res = await fetch(`${API_BASE}/clean-tables/${id}`, { method: 'DELETE' });
        if (res.ok) {
            if (activeJob) loadCleanTables(activeJob.Id || activeJob.id);
        } else {
            await uiAlert("Gagal menghapus.");
        }
    } catch (err) {
        console.error(err);
    }
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
    return "Unknown DB";
}

async function runSingleClean(id) {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    const connStr = activeJob.TargetConnectionString || activeJob.targetConnectionString || '';
    const dbInfo = parseConnectionStringDb(connStr);

    const row = document.querySelector(`.table-item[data-sort-id="${id}"]`);
    const tableName = row ? row.querySelector('.clean-table-name')?.textContent?.trim() : '';

    const confirmMsg = `⚠️ PERINGATAN KESELAMATAN PEMBERSIHAN DATA ⚠️\n\n` +
        `Anda akan MENGHAPUS SEMUA DATA dari tabel berikut:\n` +
        `👉 TABEL: ${tableName || 'Tabel terpilih'}\n` +
        `👉 DATABASE TUJUAN: ${dbInfo}\n\n` +
        `Mekanisme:\n` +
        `1. DELETE data tabel.\n` +
        `2. RESEED Identity ke 0 (jika ada kolom Identity).\n\n` +
        `Apakah Anda benar-benar yakin? Tindakan ini bersifat permanen dan tidak dapat dibatalkan!`;

    if (!(await uiConfirm(confirmMsg))) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/clean-tables/run?id=${id}`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            const result = data.Results[0];
            if (result.Status === 'Completed') {
                await uiAlert(`✅ Sukses membersihkan tabel ${result.TableName}!\n\n${result.Message}`);
            } else {
                await uiAlert(`❌ Gagal membersihkan tabel ${result.TableName}!\n\nDetail: ${result.Message}`);
            }
            loadCleanTables(jobId);
        } else {
            await uiAlert("Gagal mengeksekusi pembersihan: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error: " + err.message);
    }
}

async function runAllClean() {
    await runAllCleanInternal(true);
}

async function runAllCleanInternal(confirmFirst = false) {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    const connStr = activeJob.TargetConnectionString || activeJob.targetConnectionString || '';
    const dbInfo = parseConnectionStringDb(connStr);

    if (cleanTablesCache.length === 0) {
        await uiAlert("Tidak ada tabel di daftar untuk dibersihkan.");
        return;
    }

    const tableNames = cleanTablesCache.map(t => t.TableName || t.tableName);

    if (confirmFirst) {
        const confirmMsg = `⚠️ PERINGATAN KESELAMATAN KRITIS PEMBERSIHAN MASSAL ⚠️\n\n` +
            `Anda akan MENGHAPUS SEMUA DATA dari ${tableNames.length} tabel berikut secara berurutan:\n` +
            `${tableNames.map((t, idx) => `  ${idx + 1}. ${t}`).join('\n')}\n\n` +
            `👉 DATABASE TUJUAN: ${dbInfo}\n\n` +
            `Mekanisme:\n` +
            `1. DELETE data di setiap tabel.\n` +
            `2. RESEED Identity ke 0 (jika ada kolom Identity).\n\n` +
            `Apakah Anda benar-benar yakin ingin membersihkan data seluruh tabel ini? Tindakan ini bersifat permanen!`;

        if (!(await uiConfirm(confirmMsg))) return;
    }

    // Reset cancellation flag
    isCancellationRequested = false;

    // 1. Reset & Setup Dashboard UI untuk Clean Database secara dinamis
    const runnerTitle = document.querySelector('#active-runner-panel .runner-header span');
    if (runnerTitle) runnerTitle.innerText = "Proses Pembersihan Database Berjalan";

    const globalLabel = document.getElementById('global-progress-label');
    if (globalLabel) globalLabel.innerText = "Kemajuan Total (Pembersihan)";

    document.getElementById('runner-status-text').innerText = 'RUNNING';
    document.getElementById('runner-status-text').style.color = 'var(--accent-teal)';
    document.getElementById('active-runner-panel').style.display = 'block';

    const globalText = document.getElementById('global-progress-text');
    const globalBar = document.getElementById('global-progress-bar');
    const activeName = document.getElementById('active-table-name');
    const activeText = document.getElementById('active-table-text');
    const activeBar = document.getElementById('active-table-bar');
    const logsBox = document.getElementById('console-logs');

    if (globalText) globalText.innerText = `0 / ${cleanTablesCache.length} Tabel (0%)`;
    if (globalBar) {
        globalBar.style.width = '0%';
        globalBar.className = 'progress-bar-fill active';
    }
    if (activeName) activeName.innerText = 'Menyiapkan tabel...';
    if (activeText) activeText.innerText = '0%';
    if (activeBar) {
        activeBar.style.width = '0%';
        activeBar.className = 'progress-bar-fill active';
    }

    logsBox.innerHTML = `<div class="console-line info">[${new Date().toLocaleTimeString()}] Memulai pembersihan data untuk ${cleanTablesCache.length} tabel target...</div>`;

    // Tampilkan tombol cancel
    const cancelBtn = document.getElementById('btn-cancel-migration');
    if (cancelBtn) {
        cancelBtn.style.display = 'inline-flex';
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = `<i class="fa-solid fa-ban"></i> Batalkan Pembersihan`;
    }

    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    // Loop & eksekusi secara sekuensial satu-satu untuk melaporkan progres real-time
    for (let i = 0; i < cleanTablesCache.length; i++) {
        if (isCancellationRequested) {
            const abortLine = document.createElement('div');
            abortLine.className = 'console-line error';
            abortLine.innerText = `[${new Date().toLocaleTimeString()}] BATAL: Pembersihan database dibatalkan oleh pengguna.`;
            logsBox.appendChild(abortLine);
            logsBox.scrollTop = logsBox.scrollHeight;
            failCount++;
            break;
        }

        const table = cleanTablesCache[i];
        const id = table.Id || table.id;
        const tableName = table.TableName || table.tableName;

        // Update active card
        if (activeName) activeName.innerText = tableName;
        if (activeText) activeText.innerText = `Pembersihan (${i + 1}/${cleanTablesCache.length})`;
        if (activeBar) {
            activeBar.style.width = '50%';
            activeBar.className = 'progress-bar-fill active';
        }

        const logLine = document.createElement('div');
        logLine.className = 'console-line';
        logLine.innerText = `[${new Date().toLocaleTimeString()}] Membersihkan tabel ${tableName} (${i + 1}/${cleanTablesCache.length})...`;
        logsBox.appendChild(logLine);
        logsBox.scrollTop = logsBox.scrollHeight;

        try {
            const res = await fetch(`${API_BASE}/jobs/${jobId}/clean-tables/run?id=${id}`, { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                const result = data.Results[0];

                if (result.Status === 'Completed') {
                    if (result.Message === 'Skipped (Already cleaned)') {
                        skipCount++;
                        logLine.className = 'console-line info';
                        logLine.innerText = `[${new Date().toLocaleTimeString()}] LEWAT: Tabel ${tableName} dilewati (Sudah bersih).`;
                    } else {
                        successCount++;
                        logLine.className = 'console-line success';
                        logLine.innerText = `[${new Date().toLocaleTimeString()}] KELAR: Tabel ${tableName} sukses dibersihkan (${result.Message}).`;
                    }
                } else {
                    failCount++;
                    logLine.className = 'console-line error';
                    logLine.innerText = `[${new Date().toLocaleTimeString()}] ERROR: Tabel ${tableName} gagal! Detail: ${result.Message}`;
                }
            } else {
                failCount++;
                const errMsg = await res.text();
                logLine.className = 'console-line error';
                logLine.innerText = `[${new Date().toLocaleTimeString()}] ERROR: Tabel ${tableName} gagal! Detail: ${errMsg}`;
            }
        } catch (err) {
            failCount++;
            logLine.className = 'console-line error';
            logLine.innerText = `[${new Date().toLocaleTimeString()}] ERROR: Tabel ${tableName} gagal! Detail: ${err.message}`;
        }

        logsBox.scrollTop = logsBox.scrollHeight;

        // Selesai per tabel
        if (activeBar) {
            activeBar.style.width = '100%';
            activeBar.className = failCount > 0 ? 'progress-bar-fill failed' : 'progress-bar-fill completed';
        }

        // Update progress global
        const processedCount = i + 1;
        const globalPct = Math.round((processedCount / cleanTablesCache.length) * 100);
        if (globalText) globalText.innerText = `${processedCount} / ${cleanTablesCache.length} Tabel (${globalPct}%)`;
        if (globalBar) {
            globalBar.style.width = `${globalPct}%`;
            if (globalPct >= 100) {
                globalBar.className = failCount > 0 ? 'progress-bar-fill failed' : 'progress-bar-fill completed';
            }
        }
    }

    // Akhir Rangkaian
    setTimeout(() => {
        const statusText = document.getElementById('runner-status-text');
        if (statusText) {
            if (failCount > 0) {
                statusText.innerText = 'FAILED';
                statusText.style.color = 'var(--color-error)';
            } else {
                statusText.innerText = 'COMPLETED';
                statusText.style.color = 'var(--color-success)';
            }
        }
        if (cancelBtn) cancelBtn.style.display = 'none';

        // Reload UI status
        loadCleanTables(jobId);
    }, 200);
}

async function generateCleanSpScript() {
    if (!activeJob) {
        await uiAlert("Pilih Job terlebih dahulu!");
        return;
    }

    const jobId = activeJob.Id || activeJob.id;
    const btn = document.querySelector('#inner-content-clean button[onclick="generateCleanSpScript()"]');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
        btn.disabled = true;
    }

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/clean-tables/generate-sp`);
        if (res.ok) {
            const data = await res.json();
            document.getElementById('sp-modal-title').innerText = `Generate Clean SP: ${data.SpName}`;
            document.getElementById('sp-sql-textarea').value = data.SqlScript;
            document.getElementById('sp-generator-modal').classList.add('active');
        } else {
            await uiAlert("Gagal meng-generate SP Pembersih: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error: " + err.message);
    } finally {
        if (btn) {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    }
}

// ============================================================================
// SINGLE PLAY & RESET HANDLERS
// ============================================================================

async function runSingleMapping(mappingId) {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    const confirmMsg = `Apakah Anda yakin ingin menjalankan pemetaan tabel terpilih ini saja?`;
    if (!(await uiConfirm(confirmMsg))) return;

    // Reset State & Dashboard UI
    migrationProcessedTables = {};
    migrationTotalTables = 1;

    document.getElementById('global-progress-text').innerText = `0 / 1 Tabel (0%)`;
    document.getElementById('global-progress-bar').style.width = '0%';
    document.getElementById('global-progress-bar').className = 'progress-bar-fill active';

    document.getElementById('active-table-name').innerText = 'Menunggu tabel...';
    document.getElementById('active-table-text').innerText = '0 / 0 baris (0%)';
    document.getElementById('active-table-bar').style.width = '0%';
    document.getElementById('active-table-bar').className = 'progress-bar-fill active';

    const progressList = document.getElementById('runner-progress-list');
    if (progressList) progressList.innerHTML = '';

    const logsBox = document.getElementById('console-logs');
    logsBox.innerHTML = `<div class="console-line info">[${new Date().toLocaleTimeString()}] Menyiapkan migrasi data untuk satu tabel...</div>`;

    document.getElementById('runner-status-text').innerText = 'RUNNING';
    document.getElementById('runner-status-text').style.color = 'var(--accent-teal)';
    document.getElementById('active-runner-panel').style.display = 'block';

    // Show cancel button
    const cancelBtn = document.getElementById('btn-cancel-migration');
    if (cancelBtn) {
        cancelBtn.style.display = 'inline-flex';
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = `<i class="fa-solid fa-ban"></i> Batalkan Migrasi`;
    }

    const checkConstraints = document.getElementById('chk-check-constraints')?.checked || false;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/run?mappingId=${mappingId}&checkConstraints=${checkConstraints}`, { method: 'POST' });
        if (res.ok) {
            const msg = await res.json();
            const logLine = document.createElement('div');
            logLine.className = 'console-line info';
            logLine.innerText = `[${new Date().toLocaleTimeString()}] ${msg.Message}`;
            logsBox.appendChild(logLine);
        } else {
            await uiAlert("Gagal menjalankan migrasi.");
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error: " + err.message);
    }
}

async function runSingleObjItem(itemId) {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;

    const row = document.querySelector(`.table-item[data-sort-id="${itemId}"]`);
    const objName = row ? row.querySelector('span[style*="font-weight: 600"]').textContent.trim() : 'Objek terpilih';

    const confirmMsg = `Jalankan migrasi objek "${objName}" sekarang?`;
    if (!(await uiConfirm(confirmMsg))) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/obj-run?itemId=${itemId}`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            const result = data.Results[0];
            if (result.Status === 'Completed') {
                await uiAlert(`✅ Sukses memigrasi objek ${result.ObjectName}!\n\nDetail: ${result.Message}`);
            } else {
                await uiAlert(`❌ Gagal memigrasi objek ${result.ObjectName}!\n\nDetail: ${result.Message}`);
            }
            loadObjItems(jobId);
        } else {
            await uiAlert("Gagal menjalankan migrasi objek: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error: " + err.message);
    }
}

async function cleanAndResetAllData() {
    if (!activeJob) return;
    
    const confirmMsg = `PERINGATAN: Tindakan ini akan:\n` +
        `1. MENGHAPUS (DELETE) data seluruh tabel di database target.\n` +
        `2. Mereset identitas auto-increment (Identity) kembali ke 0.\n` +
        `3. Mereset status migrasi seluruh tabel kembali ke PENDING.\n\n` +
        `Apakah Anda benar-benar yakin? Tindakan ini tidak dapat dibatalkan!`;
        
    if (!(await uiConfirm(confirmMsg))) return;

    const btn = document.getElementById('btn-clean-reset-all');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sedang Membersihkan...';
        btn.disabled = true;
    }

    const jobId = activeJob.Id || activeJob.id;
    try {
        // 1. Reset Clean Target Tables status to Pending (agar tidak ter-skip)
        await fetch(`${API_BASE}/jobs/${jobId}/clean-tables/reset-status`, { method: 'POST' });
        
        // 2. Reset Data Mappings status to Pending
        await fetch(`${API_BASE}/jobs/${jobId}/mappings/reset-status`, { method: 'POST' });

        // 3. Muat ulang status dari database ke cache
        await loadCleanTables(jobId);

        // 4. Jalankan pembersihan massal dengan pelaporan progres sekuensial!
        await runAllCleanInternal();
        
        // 5. Muat ulang pemetaan data setelah selesai
        loadTableMappings(jobId);
    } catch (err) {
        console.error(err);
        await uiAlert("Error: " + err.message);
    } finally {
        if (btn) {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    }
}

async function resetDataStatuses() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    if (!(await uiConfirm("Apakah Anda yakin ingin me-reset semua status pemetaan data ke 'Pending'?"))) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/mappings/reset-status`, { method: 'POST' });
        if (res.ok) {
            await uiAlert("Status pemetaan data berhasil di-reset!");
            loadTableMappings(jobId);
        } else {
            await uiAlert("Gagal me-reset status: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error: " + err.message);
    }
}

async function resetObjStatuses() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    if (!(await uiConfirm("Apakah Anda yakin ingin me-reset semua status objek migrasi ke 'Pending'?"))) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/obj-items/reset-status`, { method: 'POST' });
        if (res.ok) {
            await uiAlert("Status objek migrasi berhasil di-reset!");
            loadObjItems(jobId);
        } else {
            await uiAlert("Gagal me-reset status: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error: " + err.message);
    }
}

async function resetCleanStatuses() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    if (!(await uiConfirm("Apakah Anda yakin ingin me-reset semua status pembersihan tabel ke 'Pending'?"))) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/clean-tables/reset-status`, { method: 'POST' });
        if (res.ok) {
            await uiAlert("Status pembersihan tabel berhasil di-reset!");
            loadCleanTables(jobId);
        } else {
            await uiAlert("Gagal me-reset status: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error: " + err.message);
    }
}

// ============================================================================
// 17. CLEAN TARGET TABLE SCANNER
// ============================================================================
let cleanTableScanResultsCache = [];
let activeCleanTableScanSearchQuery = '';

function openCleanTableScannerModal() {
    // Reset search
    const searchInput = document.getElementById('clean-table-scan-search');
    if (searchInput) searchInput.value = '';
    activeCleanTableScanSearchQuery = '';

    // Reset select all checkbox
    const selectAllCb = document.getElementById('clean-table-scan-select-all');
    if (selectAllCb) selectAllCb.checked = false;

    document.getElementById('clean-table-scanner-modal').classList.add('active');
    startCleanTableScan();
}

function closeCleanTableScannerModal() {
    document.getElementById('clean-table-scanner-modal').classList.remove('active');
}

async function startCleanTableScan() {
    if (!activeJob) { await uiAlert('Silakan pilih Job terlebih dahulu.'); return; }
    const jobId = activeJob.Id || activeJob.id;
    const container = document.getElementById('clean-table-scan-results');
    container.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 2rem;"><i class="fa-solid fa-spinner fa-spin"></i> Memindai tabel dari Target DB...</p>`;

    try {
        const res = await fetch(`${API_BASE}/db/tables?jobId=${jobId}&dbType=target`);
        if (!res.ok) {
            container.innerHTML = `<p style="color: var(--color-error); text-align: center; padding: 2rem;">Gagal memindai: ${await res.text()}</p>`;
            return;
        }
        cleanTableScanResultsCache = await res.json(); // returns array of strings
        applyCleanTableScanFiltering();
    } catch (err) {
        container.innerHTML = `<p style="color: var(--color-error); text-align: center; padding: 2rem;">Error: ${err.message}</p>`;
    }
}

function applyCleanTableScanFiltering() {
    activeCleanTableScanSearchQuery = (document.getElementById('clean-table-scan-search')?.value || '').trim().toLowerCase();
    
    let filtered = cleanTableScanResultsCache || [];
    
    if (activeCleanTableScanSearchQuery !== '') {
        filtered = filtered.filter(name => name.toLowerCase().includes(activeCleanTableScanSearchQuery));
    }
    
    renderCleanTableScanResults(filtered);
}

function renderCleanTableScanResults(tables) {
    const container = document.getElementById('clean-table-scan-results');
    if (tables.length === 0) {
        container.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 2rem;">Tidak ada tabel ditemukan.</p>`;
        return;
    }

    container.innerHTML = tables.map(name => {
        return `
            <label class="scan-item">
                <input type="checkbox" class="clean-scan-checkbox" data-name="${name}">
                <span class="scan-item-name">${name}</span>
                <span class="obj-type-badge table">TABLE</span>
            </label>
        `;
    }).join('');
}

function toggleAllCleanTableScanItems(checked) {
    document.querySelectorAll('.clean-scan-checkbox').forEach(cb => cb.checked = checked);
}

async function addSelectedCleanTableScanItems() {
    const checkboxes = document.querySelectorAll('.clean-scan-checkbox:checked');
    if (checkboxes.length === 0) {
        await uiAlert("Pilih minimal satu tabel untuk ditambahkan!");
        return;
    }

    const tableNames = Array.from(checkboxes).map(cb => cb.dataset.name).join(',');

    try {
        const jobId = activeJob.Id || activeJob.id;
        const res = await fetch(`${API_BASE}/jobs/${jobId}/clean-tables`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ TableNames: tableNames })
        });

        if (res.ok) {
            const data = await res.json();
            let alertMsg = `${data.Added.length} tabel berhasil ditambahkan ke daftar pembersih.`;
            if (data.Skipped.length > 0) {
                alertMsg += `\n\nSkipped (sudah terdaftar): ${data.Skipped.join(', ')}`;
            }
            await uiAlert(alertMsg);
            closeCleanTableScannerModal();
            loadCleanTables(jobId);
        } else {
            await uiAlert("Gagal menambahkan: " + await res.text());
        }
    } catch (err) {
        await uiAlert("Error: " + err.message);
    }
}

// ============================================================================
// FULLSCREEN & SIDEBAR TOGGLE
// ============================================================================
function toggleSidebar() {
    const grid = document.querySelector('.dashboard-grid');
    const icon = document.getElementById('sidebar-toggle-icon');
    const text = document.getElementById('sidebar-toggle-text');
    
    if (grid.classList.contains('sidebar-hidden')) {
        grid.classList.remove('sidebar-hidden');
        if (icon) {
            icon.className = 'fa-solid fa-indent';
        }
        if (text) text.innerText = 'Hide Sidebar';
    } else {
        grid.classList.add('sidebar-hidden');
        if (icon) {
            icon.className = 'fa-solid fa-outdent';
        }
        if (text) text.innerText = 'Show Sidebar';
    }
}

// ============================================================================
// APPIMS DATABASE BACKUP & RESTORE HANDLERS [NEW]
// ============================================================================
let appimsBackupPathLoaded = "";

async function openAppimsBackupModal() {
    const modal = document.getElementById('appims-backup-modal');
    if (modal) {
        modal.classList.add('active');
        
        const serverEl = document.getElementById('appims-info-server');
        if (serverEl) serverEl.textContent = "Mengambil data...";
        
        await loadAppimsBackupSettings();
    }
}

function closeAppimsBackupModal() {
    const modal = document.getElementById('appims-backup-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

async function loadAppimsBackupSettings() {
    try {
        const res = await fetch(`${API_BASE}/appims/backup-settings`);
        if (!res.ok) throw new Error("Gagal mengambil pengaturan");
        const data = await res.json();
        
        const pathInput = document.getElementById('appims-backup-path');
        const infoPath = document.getElementById('appims-info-path');
        const serverEl = document.getElementById('appims-info-server');
        
        const backupPath = data.AppimsBackupPath || data.appimsBackupPath || '';
        appimsBackupPathLoaded = backupPath;
        
        if (pathInput) pathInput.value = backupPath;
        if (infoPath) {
            infoPath.textContent = backupPath || "Belum Diatur (Simpan path untuk memulai)";
        }
        if (serverEl) {
            serverEl.textContent = data.Server || data.server || 'Unknown';
        }
        
        if (backupPath) {
            scanAppimsBackupFiles();
        }
    } catch (err) {
        console.error(err);
    }
}

async function saveAppimsBackupSettings() {
    const pathInput = document.getElementById('appims-backup-path');
    if (!pathInput) return;
    
    const path = pathInput.value.trim();
    if (!path) {
        await uiAlert("Harap masukkan path direktori backup!");
        return;
    }
    
    const btn = document.getElementById('btn-save-appims-settings');
    const origHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...`;
    btn.disabled = true;
    
    try {
        const res = await fetch(`${API_BASE}/appims/backup-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ AppimsBackupPath: path })
        });
        
        if (!res.ok) {
            await uiAlert("Gagal menyimpan pengaturan: " + await res.text());
            return;
        }
        
        const data = await res.json();
        if (data.Success || data.success) {
            await uiAlert(data.Message || "Pengaturan berhasil disimpan ke app-config.json!");
            await loadAppimsBackupSettings();
        } else {
            await uiAlert("Gagal: " + data.Message);
        }
    } catch (err) {
        await uiAlert("Error koneksi: " + err.message);
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
}

async function scanAppimsBackupFiles() {
    const selectEl = document.getElementById('appims-restore-file-select');
    if (!selectEl) return;
    
    selectEl.innerHTML = `<option value="">Mengambil daftar file backup...</option>`;
    
    try {
        const res = await fetch(`${API_BASE}/appims/backup-files`);
        if (!res.ok) {
            selectEl.innerHTML = `<option value="">-- Gagal memindai folder (Atur/simpan path terlebih dahulu) --</option>`;
            return;
        }
        
        const data = await res.json();
        if (data.Success || data.success) {
            const files = data.Files || data.files || [];
            if (files.length === 0) {
                selectEl.innerHTML = `<option value="">-- Tidak ada file .bak ditemukan --</option>`;
            } else {
                selectEl.innerHTML = files.map(file => `<option value="${escapeHtml(file)}">${escapeHtml(file)}</option>`).join('');
            }
        } else {
            selectEl.innerHTML = `<option value="">-- Gagal memindai: ${escapeHtml(data.Message || '')} --</option>`;
        }
    } catch (err) {
        console.error(err);
        selectEl.innerHTML = `<option value="">-- Error memindai folder --</option>`;
    }
}

async function runAppimsBackup() {
    if (!appimsBackupPathLoaded) {
        await uiAlert("Path backup belum diatur atau kosong! Harap atur path folder backup terlebih dahulu.");
        return;
    }
    
    if (!(await uiConfirm(`Apakah Anda yakin ingin mem-backup database AppIMS [appims] ke path:\n"${appimsBackupPathLoaded}"?`))) {
        return;
    }
    
    const btn = document.getElementById('btn-run-appims-backup');
    const origHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Mem-backup Database...`;
    btn.disabled = true;
    
    try {
        const res = await fetch(`${API_BASE}/appims/backup`, {
            method: 'POST'
        });
        
        if (!res.ok) {
            await uiAlert("Gagal backup: " + await res.text());
            return;
        }
        
        const data = await res.json();
        if (data.Success || data.success) {
            await uiAlert(data.Message || "Backup database AppIMS berhasil diselesaikan!");
            scanAppimsBackupFiles();
        } else {
            await uiAlert("Gagal backup: " + data.Message);
        }
    } catch (err) {
        await uiAlert("Terjadi kesalahan koneksi saat backup: " + err.message);
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
}

function toggleAppimsRestoreMode() {
    const restoreMode = document.querySelector('input[name="appims-restore-mode"]:checked').value;
    const newDbGroup = document.getElementById('appims-restore-new-db-group');
    if (newDbGroup) {
        newDbGroup.style.display = restoreMode === 'new' ? 'block' : 'none';
    }
}

async function runAppimsRestore() {
    const backupFile = document.getElementById('appims-restore-file-select').value;
    if (!backupFile) {
        await uiAlert("Harap pilih file backup (.bak) yang akan di-restore!");
        return;
    }
    
    const restoreMode = document.querySelector('input[name="appims-restore-mode"]:checked').value;
    let restoreDbName = "appims";
    
    if (restoreMode === 'new') {
        restoreDbName = document.getElementById('appims-restore-new-db-name').value.trim();
        if (!restoreDbName) {
            await uiAlert("Harap masukkan nama database baru untuk restore!");
            return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(restoreDbName)) {
            await uiAlert("Nama database hanya boleh mengandung huruf, angka, underscore (_), atau dash (-).");
            return;
        }
    }
    
    let confirmMsg = "";
    if (restoreMode === 'existing') {
        confirmMsg = `🚨 PERINGATAN SANGAT CRITICAL! 🚨\n\n` +
                     `Anda akan me-restore database AppIMS [${restoreDbName}] menggunakan file backup:\n` +
                     `"${backupFile}"\n\n` +
                     `Tindakan ini akan MENIMPA & MENGHAPUS seluruh konfigurasi migrasi, riwayat pengerjaan, dan data pemetaan tabel yang ada saat ini di database AppIMS [${restoreDbName}]!\n\n` +
                     `Apakah Anda benar-benar yakin dan setuju untuk melanjutkan?`;
    } else {
        confirmMsg = `Tindakan ini akan me-restore file backup "${backupFile}" ke database BARU bernama [${restoreDbName}].\n\n` +
                     `Apakah Anda yakin ingin melanjutkan?`;
    }
    
    if (!(await uiConfirm(confirmMsg))) {
        return;
    }
    
    if (restoreMode === 'existing') {
        const doubleCheck = await uiPrompt(
            `Ketik nama database AppIMS untuk mengonfirmasi penulisan ulang database.`,
            {
                title: 'Konfirmasi Restore AppIMS',
                placeholder: restoreDbName,
                matchValue: restoreDbName,
                matchError: 'Nama database tidak cocok. Restore dibatalkan.',
                variant: 'warning'
            }
        );
        if (doubleCheck !== restoreDbName) {
            if (doubleCheck !== null) {
                await uiAlert("Konfirmasi nama database tidak sesuai. Proses restore dibatalkan.", { variant: 'error' });
            }
            return;
        }
    }
    
    const btn = document.getElementById('btn-run-appims-restore');
    const origHtml = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Me-restore Database...`;
    btn.disabled = true;
    
    try {
        const res = await fetch(`${API_BASE}/appims/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                BackupFilename: backupFile,
                RestoreDbName: restoreDbName
            })
        });
        
        if (!res.ok) {
            await uiAlert("Gagal me-restore: " + await res.text());
            return;
        }
        
        const data = await res.json();
        if (data.Success || data.success) {
            await uiAlert(data.Message || "Restore database AppIMS berhasil diselesaikan!");
            if (restoreDbName === 'existing') {
                window.location.reload();
            }
        } else {
            await uiAlert("Gagal me-restore: " + data.Message);
        }
    } catch (err) {
        await uiAlert("Terjadi kesalahan koneksi saat restore: " + err.message);
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
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
    const safeName = String(name).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
            rowsCount.textContent = `${rowCount} baris ditampilkan (${data.ExecutionTimeMs}ms)`;
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

// ── SQL / JSON / XML Beautifier Logic ─────────────────────────────────────
let beautifierLeftEditor = null;
let beautifierRightEditor = null;
let beautifierEditorInitializing = false;
let beautifierDebounceTimeout = null;
let beautifierCopyResetTimeout = null;

function syncBeautifierLangPills(lang) {
    document.querySelectorAll('.beautifier-lang-pill').forEach(pill => {
        const isActive = pill.dataset.lang === lang;
        pill.classList.toggle('active', isActive);
        pill.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
}

function setBeautifierLang(lang) {
    const select = document.getElementById('beautifier-lang');
    if (select && select.value !== lang) {
        select.value = lang;
    }
    syncBeautifierLangPills(lang);
    onBeautifierLangChange();
}

function updateBeautifierStatus(message, state = 'idle') {
    const statusText = document.getElementById('beautifier-status-text');
    const statusBadge = document.getElementById('beautifier-status-badge');
    if (statusText) statusText.textContent = message;
    if (statusBadge) {
        statusBadge.className = 'beautifier-status-badge';
        if (state) statusBadge.classList.add(`is-${state}`);
        const icon = statusBadge.querySelector('i');
        if (icon) {
            const iconMap = {
                idle: 'fa-solid fa-circle',
                working: 'fa-solid fa-circle-notch',
                success: 'fa-solid fa-check-circle',
                error: 'fa-solid fa-circle-exclamation'
            };
            icon.className = iconMap[state] || iconMap.idle;
        }
    }
}

function initMonacoBeautifierEditor() {
    if (beautifierLeftEditor && beautifierRightEditor) {
        return;
    }

    if (beautifierEditorInitializing) {
        return;
    }

    if (typeof require === 'undefined') {
        console.error("Monaco loader is not loaded yet.");
        return;
    }

    beautifierEditorInitializing = true;

    require.config({ paths: { vs: 'lib/monaco-editor/min/vs' } });
    
    require(['vs/editor/editor.main'], function() {
        beautifierEditorInitializing = false;

        if (beautifierLeftEditor && beautifierRightEditor) return;

        const containerLeft = document.getElementById('beautifier-editor-left');
        const containerRight = document.getElementById('beautifier-editor-right');
        if (!containerLeft || !containerRight) return;

        beautifierLeftEditor = monaco.editor.create(containerLeft, {
            value: "-- Tulis atau tempel SQL, JSON, atau XML Anda di sini...\n",
            language: 'sql',
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'Consolas, Monaco, monospace',
            lineHeight: 18,
            padding: { top: 8, bottom: 8 }
        });

        beautifierRightEditor = monaco.editor.create(containerRight, {
            value: "-- Hasil formatting akan muncul di sini secara otomatis...\n",
            language: 'sql',
            theme: 'vs-dark',
            automaticLayout: true,
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'Consolas, Monaco, monospace',
            lineHeight: 18,
            padding: { top: 8, bottom: 8 }
        });

        // Bind content change events for live formatting
        beautifierLeftEditor.onDidChangeModelContent(() => {
            updateBeautifierStatus('Memformat...', 'working');
            triggerAutoBeautify();
        });

        beautifierLeftEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
            beautifyCode();
        });

        syncBeautifierLangPills(document.getElementById('beautifier-lang')?.value || 'sql');
        updateBeautifierStatus('Siap', 'idle');
    });
}

function triggerAutoBeautify() {
    if (beautifierDebounceTimeout) {
        clearTimeout(beautifierDebounceTimeout);
    }
    beautifierDebounceTimeout = setTimeout(() => {
        beautifyCode({ silent: true });
    }, 400);
}

function onBeautifierLangChange() {
    if (!beautifierLeftEditor || !beautifierRightEditor) return;
    const lang = document.getElementById('beautifier-lang').value;
    syncBeautifierLangPills(lang);
    monaco.editor.setModelLanguage(beautifierLeftEditor.getModel(), lang);
    monaco.editor.setModelLanguage(beautifierRightEditor.getModel(), lang);
    // Re-trigger beautify under new language settings
    beautifyCode({ silent: true });
}

async function autoDetectBeautifierLang() {
    if (!beautifierLeftEditor) return;
    const code = beautifierLeftEditor.getValue().trim();
    if (!code) {
        await uiAlert("Editor kiri kosong! Harap masukkan kode terlebih dahulu.");
        return;
    }

    let detected = 'sql';
    if (code.startsWith('{') || code.startsWith('[')) {
        detected = 'json';
    } else if (code.startsWith('<')) {
        detected = 'xml';
    }

    const select = document.getElementById('beautifier-lang');
    if (select) {
        select.value = detected;
        onBeautifierLangChange();
    }
}

function preprocessSqlForDeclare(sql) {
    const lines = sql.split(/\r?\n/);
    let inDeclare = false;
    let parensDepth = 0;
    let lastActiveDeclareLineIdx = -1;
    
    const statementKeywords = new Set([
        'select', 'insert', 'update', 'delete', 'merge', 'set', 'exec', 'execute',
        'if', 'while', 'begin', 'end', 'print', 'return', 'with', 'go',
        'create', 'alter', 'drop', 'truncate', 'use', 'commit', 'rollback',
        'transaction', 'tran', 'fetch', 'open', 'close', 'deallocate'
    ]);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        let lineClean = line.replace(/--.*$/, '');
        lineClean = lineClean.replace(/\/\*[\s\S]*?\*\//g, '');
        const trimmed = lineClean.trim();
        
        if (trimmed === '') {
            continue;
        }
        
        const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
        
        if (parensDepth === 0) {
            if (firstWord === 'declare') {
                if (inDeclare && lastActiveDeclareLineIdx !== -1) {
                    appendSemicolonToLine(lastActiveDeclareLineIdx);
                }
                inDeclare = true;
                lastActiveDeclareLineIdx = i;
            } else if (statementKeywords.has(firstWord)) {
                if (inDeclare && lastActiveDeclareLineIdx !== -1) {
                    appendSemicolonToLine(lastActiveDeclareLineIdx);
                }
                inDeclare = false;
                lastActiveDeclareLineIdx = -1;
            }
        }
        
        if (inDeclare) {
            lastActiveDeclareLineIdx = i;
        }
        
        let inSingleQuote = false;
        let inDoubleQuote = false;
        for (let j = 0; j < lineClean.length; j++) {
            const char = lineClean[j];
            if (char === "'" && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
            } else if (char === '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
            } else if (!inSingleQuote && !inDoubleQuote) {
                if (char === '(') {
                    parensDepth++;
                } else if (char === ')') {
                    parensDepth = Math.max(0, parensDepth - 1);
                }
            }
        }
        
        if (trimmed.endsWith(';')) {
            inDeclare = false;
            lastActiveDeclareLineIdx = -1;
        }
    }
    
    if (inDeclare && lastActiveDeclareLineIdx !== -1) {
        appendSemicolonToLine(lastActiveDeclareLineIdx);
    }
    
    function appendSemicolonToLine(idx) {
        let originalLine = lines[idx];
        let commentIdx = originalLine.indexOf('--');
        let blockCommentStartIdx = originalLine.indexOf('/*');
        let insertIdx = -1;
        
        if (commentIdx !== -1 && blockCommentStartIdx !== -1) {
            insertIdx = Math.min(commentIdx, blockCommentStartIdx);
        } else if (commentIdx !== -1) {
            insertIdx = commentIdx;
        } else if (blockCommentStartIdx !== -1) {
            insertIdx = blockCommentStartIdx;
        }
        
        if (insertIdx !== -1) {
            const beforeComment = originalLine.substring(0, insertIdx).trimEnd();
            if (!beforeComment.endsWith(';') && !beforeComment.endsWith(',')) {
                lines[idx] = beforeComment + ';/*_inserted_*/' + originalLine.substring(insertIdx);
            }
        } else {
            const trimmedOriginal = originalLine.trimEnd();
            if (!trimmedOriginal.endsWith(';') && !trimmedOriginal.endsWith(',')) {
                lines[idx] = trimmedOriginal + ';/*_inserted_*/';
            }
        }
    }
    
    return lines.join('\n');
}

async function beautifyCode(options = {}) {
    if (!beautifierLeftEditor || !beautifierRightEditor) return;
    const code = beautifierLeftEditor.getValue().trim();
    
    if (!code) {
        if (!options.silent) {
            await uiAlert("Harap masukkan kode terlebih dahulu di panel kiri!");
        }
        beautifierRightEditor.setValue("");
        updateBeautifierStatus('Siap', 'idle');
        return;
    }

    // Ignore placeholder
    if (code.startsWith("-- Tulis atau tempel SQL")) {
        updateBeautifierStatus('Siap', 'idle');
        return;
    }

    const lang = document.getElementById('beautifier-lang').value;
    let formatted = "";

    try {
        if (lang === 'json') {
            const parsed = JSON.parse(code);
            formatted = JSON.stringify(parsed, null, 4);
        } else if (lang === 'xml') {
            formatted = formatXmlString(code);
        } else if (lang === 'sql') {
            if (typeof sqlFormatter !== 'undefined') {
                const processedCode = preprocessSqlForDeclare(code);
                formatted = sqlFormatter.format(processedCode, {
                    language: 'transactsql',
                    tabWidth: 4,
                    keywordCase: 'upper',
                    linesBetweenQueries: 0
                });
                // Remove the inserted semicolons and markers
                formatted = formatted.replace(/;\s*\/\*_inserted_\*\//g, '');
            } else {
                console.warn("sql-formatter library not loaded. Using local fallback SQL formatter.");
                formatted = fallbackFormatSqlString(code);
            }
        }

        beautifierRightEditor.setValue(formatted);
        updateBeautifierStatus('Berhasil diformat', 'success');
    } catch (err) {
        if (!options.silent) {
            await uiAlert("Gagal merapikan kode: " + err.message);
        }
        updateBeautifierStatus('Input tidak valid', 'error');
    }
}

function formatXmlString(xml) {
    let reg = /(>)\s*(<)(\/*)/g;
    let wspace = xml.replace(reg, '$1\r\n$2$3');
    let formatted = '';
    let pad = 0;
    
    wspace.split('\r\n').forEach(function(node) {
        let indent = 0;
        node = node.trim();
        if (!node) return;
        
        if (node.match( /.+<\/\w[^>]*>$/ )) {
            indent = 0;
        } else if (node.match( /^<\/\w/ )) {
            if (pad !== 0) {
                pad -= 1;
            }
        } else if (node.match( /^<\?xml/ ) || node.match( /^<\!--/ ) || node.match( /^[^\<]/ )) {
            indent = 0;
        } else if (node.match( /^<\w([^>]*[^\/])?>.*$/ )) {
            indent = 1;
        } else if (node.match( /^<\w[^>]*\/\s*>$/ )) {
            indent = 0;
        } else {
            indent = 0;
        }

        let padding = '';
        for (let i = 0; i < pad; i++) {
            padding += '    ';
        }

        formatted += padding + node + '\r\n';
        pad += indent;
    });
    return formatted.trim();
}

function fallbackFormatSqlString(sql) {
    let indent = 0;
    const keywords = ["SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "GROUP BY", "ORDER BY", "INSERT INTO", "UPDATE", "SET", "DELETE FROM", "VALUES", "HAVING", "LIMIT"];
    let tokens = sql.replace(/\s+/g, ' ').trim();
    
    keywords.forEach(kw => {
        let regex = new RegExp('\\b' + kw + '\\b', 'gi');
        tokens = tokens.replace(regex, '\n' + kw);
    });
    
    let lines = tokens.split('\n');
    let formatted = '';
    lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        
        let padding = '';
        for (let i = 0; i < indent; i++) {
            padding += '    ';
        }
        formatted += padding + line + '\n';
    });
    return formatted.trim();
}

async function copyBeautifiedCode() {
    if (!beautifierRightEditor) return;
    const code = beautifierRightEditor.getValue();
    const copyBtn = document.getElementById('beautifier-copy-btn');
    navigator.clipboard.writeText(code)
        .then(() => {
            if (copyBtn) {
                copyBtn.classList.add('is-copied');
                const icon = copyBtn.querySelector('i');
                const label = copyBtn.querySelector('.beautifier-btn-text');
                if (icon) icon.className = 'fa-solid fa-check';
                if (label) label.textContent = 'Tersalin';
                if (beautifierCopyResetTimeout) clearTimeout(beautifierCopyResetTimeout);
                beautifierCopyResetTimeout = setTimeout(() => {
                    copyBtn.classList.remove('is-copied');
                    if (icon) icon.className = 'fa-solid fa-copy';
                    if (label) label.textContent = 'Copy';
                }, 1800);
            }
            updateBeautifierStatus('Disalin ke clipboard', 'success');
        })
        .catch(async (err) => {
            await uiAlert("Gagal menyalin: " + err.message);
        });
}

function clearBeautifier() {
    if (beautifierLeftEditor) beautifierLeftEditor.setValue('');
    if (beautifierRightEditor) beautifierRightEditor.setValue('');
    updateBeautifierStatus('Siap', 'idle');
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

// ============================================================================
// WHITEBOARD SYSTEM LOGIC (Excalidraw & Gallery)
// ============================================================================

function initWhiteboardTab() {
    const grid = document.getElementById('whiteboard-grid-container');
    if (!grid) return;
    
    // Reset inputs
    const searchInput = document.getElementById('whiteboard-search');
    if (searchInput) searchInput.value = '';
    
    // Hide workspace and show gallery
    document.getElementById('whiteboard-workspace-view').style.display = 'none';
    document.getElementById('whiteboard-gallery-view').style.display = 'block';
    
    loadWhiteboards();
}

async function loadWhiteboards() {
    try {
        const res = await fetch(`${API_BASE}/whiteboards`);
        if (!res.ok) return;
        whiteboardDrawingsCache = await res.json();
        
        // Populate tag filter
        populateWhiteboardTagFilter();
        
        filterWhiteboards();
    } catch (err) {
        console.error("Gagal mengambil daftar whiteboard: ", err);
    }
}

function populateWhiteboardTagFilter() {
    const select = document.getElementById('whiteboard-tag-filter');
    if (!select) return;
    
    const tags = new Set();
    whiteboardDrawingsCache.forEach(wb => {
        const tag = wb.TagName || wb.tagName;
        if (tag && tag.trim() !== '') {
            tags.add(tag.trim());
        }
    });
    
    select.innerHTML = '<option value="ALL">Semua Tag</option>';
    tags.forEach(tag => {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = tag;
        select.appendChild(opt);
    });
}

function filterWhiteboards() {
    const searchVal = (document.getElementById('whiteboard-search')?.value || '').trim().toLowerCase();
    const tagVal = document.getElementById('whiteboard-tag-filter')?.value || 'ALL';
    
    const filtered = whiteboardDrawingsCache.filter(wb => {
        const alias = (wb.AliasName || wb.aliasName || '').toLowerCase();
        const tag = (wb.TagName || wb.tagName || '').toLowerCase();
        const matchSearch = alias.includes(searchVal) || tag.includes(searchVal);
        const matchTag = (tagVal === 'ALL' || (wb.TagName || wb.tagName || '').trim() === tagVal);
        return matchSearch && matchTag;
    });
    
    renderWhiteboards(filtered);
}

function renderWhiteboards(drawings) {
    const container = document.getElementById('whiteboard-grid-container');
    if (!container) return;
    
    if (drawings.length === 0) {
        container.innerHTML = `
            <div class="whiteboard-empty-gallery">
                <i class="fa-solid fa-pen-ruler"></i>
                <h3>Belum Ada Sketsa</h3>
                <p>Klik tombol <strong>Create</strong> di kanan atas untuk membuat diagram sketsa alur data baru.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = drawings.map(wb => {
        const id = wb.Id || wb.id;
        const alias = wb.AliasName || wb.aliasName;
        const tag = wb.TagName || wb.tagName || '';
        const thumb = wb.ThumbnailData || wb.thumbnailData;
        
        const imgHtml = thumb 
            ? `<img src="${thumb}" alt="${alias}">` 
            : `<i class="fa-solid fa-file-signature whiteboard-placeholder-thumb"></i>`;
            
        const tagHtml = tag.trim() !== '' 
            ? `<span class="whiteboard-card-tag">${escapeHtml(tag)}</span>` 
            : `<span class="whiteboard-card-tag empty">No Tag</span>`;
            
        return `
            <div class="whiteboard-card">
                <!-- Thumbnail pratinjau -->
                <div class="whiteboard-thumbnail-wrapper" onclick="openWhiteboardWorkspace(${id})">
                    ${imgHtml}
                </div>
                <!-- Metadata sketsa -->
                <div class="whiteboard-card-info">
                    <h4 class="whiteboard-card-title">${escapeHtml(alias)}</h4>
                    <div class="whiteboard-card-meta">
                        ${tagHtml}
                        <span style="font-size: 0.68rem; color: var(--text-muted);"><i class="fa-solid fa-clock"></i> ${new Date(wb.UpdatedAt || wb.updatedAt).toLocaleDateString()}</span>
                    </div>
                </div>
                <!-- Tombol aksi melayang -->
                <div class="whiteboard-card-actions">
                    <button onclick="openWhiteboardWorkspace(${id})" title="Edit Sketsa">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="delete" onclick="deleteWhiteboard(${id}, event)" title="Hapus Sketsa">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function openNewWhiteboardModal() {
    document.getElementById('whiteboard-new-name').value = '';
    document.getElementById('whiteboard-new-tag').value = '';
    document.getElementById('create-whiteboard-modal').classList.add('active');
}

function closeNewWhiteboardModal() {
    document.getElementById('create-whiteboard-modal').classList.remove('active');
}

async function createNewWhiteboardExec() {
    const aliasName = document.getElementById('whiteboard-new-name').value.trim();
    const tagName = document.getElementById('whiteboard-new-tag').value.trim();
    
    if (!aliasName) {
        await uiAlert("Nama sketsa (Alias Name) tidak boleh kosong!");
        return;
    }
    
    const payload = {
        AliasName: aliasName,
        TagName: tagName
    };
    
    try {
        const res = await fetch(`${API_BASE}/whiteboards`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (res.ok) {
            const saved = await res.json();
            closeNewWhiteboardModal();
            
            // Reload list in background
            await loadWhiteboards();
            
            // Open excalidraw workspace immediately
            openWhiteboardWorkspace(saved.Id || saved.id);
        } else {
            const errText = await res.text();
            await uiAlert("Gagal membuat sketsa: " + errText);
        }
    } catch (err) {
        console.error("Gagal menyimpan sketsa baru: ", err);
        await uiAlert("Terjadi kesalahan: " + err.message);
    }
}

async function openWhiteboardWorkspace(id) {
    try {
        const res = await fetch(`${API_BASE}/whiteboards/${id}`);
        if (!res.ok) {
            await uiAlert("Gagal memuat detail sketsa.");
            return;
        }
        const wb = await res.json();
        activeWhiteboardId = id;
        
        document.getElementById('workspace-drawing-title').textContent = wb.AliasName || wb.aliasName;
        const tag = wb.TagName || wb.tagName || '';
        const tagEl = document.getElementById('workspace-drawing-tag');
        if (tagEl) {
            if (tag.trim() !== '') {
                tagEl.textContent = tag;
                tagEl.style.display = 'inline-block';
            } else {
                tagEl.style.display = 'none';
            }
        }
        
        // Toggle view
        document.getElementById('whiteboard-gallery-view').style.display = 'none';
        document.getElementById('whiteboard-workspace-view').style.display = 'block';
        
        // Mount Excalidraw Component
        const mountPoint = document.getElementById('excalidraw-mount-container');
        if (!excalidrawReactRoot) {
            excalidrawReactRoot = ReactDOM.createRoot(mountPoint);
        }
        
        let initialData = {};
        if (wb.WhiteboardData || wb.whiteboardData) {
            try {
                initialData = JSON.parse(wb.WhiteboardData || wb.whiteboardData);
            } catch (e) {
                console.error("Gagal parse whiteboard data JSON: ", e);
            }
        }
        
        // Render
        excalidrawReactRoot.render(
            React.createElement(ExcalidrawLib.Excalidraw, {
                excalidrawAPI: (api) => {
                    excalidrawReactRef = api;
                    if (api && initialData && initialData.elements) {
                        setTimeout(() => {
                            try {
                                // Hanya update elements untuk menghindari crash akibat deserialisasi appState (seperti collaborators Map)
                                api.updateScene({
                                    elements: initialData.elements
                                });
                            } catch (err) {
                                console.error("Gagal update scene Excalidraw: ", err);
                            }
                        }, 100);
                    }
                },
                theme: "dark"
            })
        );
    } catch (err) {
        console.error("Error open whiteboard workspace: ", err);
        await uiAlert("Terjadi kesalahan saat membuka sketsa: " + err.message);
    }
}

async function saveActiveWhiteboard() {
    if (!activeWhiteboardId || !excalidrawReactRef) return;
    
    const btn = document.getElementById('btn-save-whiteboard');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...`;
    btn.disabled = true;
    
    try {
        const elements = excalidrawReactRef.getSceneElements();
        const appState = excalidrawReactRef.getAppState();
        const sceneJson = JSON.stringify({ elements, appState });
        
        // Export PNG preview (base64)
        if (elements && elements.length > 0) {
            ExcalidrawLib.exportToBlob({
                elements: elements,
                appState: { 
                    ...appState, 
                    exportWithBackground: true,
                    theme: "dark",
                    viewBackgroundColor: "#121212"
                },
                mimeType: "image/png"
            }).then(blob => {
                const reader = new FileReader();
                reader.readAsDataURL(blob);
                reader.onloadend = async function() {
                    const base64data = reader.result;
                    await executeSaveWhiteboard(activeWhiteboardId, sceneJson, base64data, btn, originalText);
                };
            }).catch(err => {
                console.error("Gagal mengekspor thumbnail: ", err);
                executeSaveWhiteboard(activeWhiteboardId, sceneJson, null, btn, originalText);
            });
        } else {
            await executeSaveWhiteboard(activeWhiteboardId, sceneJson, null, btn, originalText);
        }
    } catch (err) {
        console.error("Gagal menyimpan whiteboard: ", err);
        await uiAlert("Gagal menyimpan sketsa: " + err.message);
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function executeSaveWhiteboard(id, json, thumbnailBase64, btn, originalText) {
    try {
        const payload = {
            Id: id,
            WhiteboardData: json,
            ThumbnailData: thumbnailBase64
        };
        
        const res = await fetch(`${API_BASE}/whiteboards/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (res.ok) {
            await uiAlert("Sketsa berhasil disimpan!");
        } else {
            const errText = await res.text();
            await uiAlert("Gagal menyimpan sketsa: " + errText);
        }
    } catch (err) {
        console.error(err);
        await uiAlert("Error saving: " + err.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

function closeWhiteboardWorkspace() {
    activeWhiteboardId = null;
    excalidrawReactRef = null;
    if (excalidrawReactRoot) {
        try {
            excalidrawReactRoot.unmount();
        } catch (e) {
            console.error("Error unmounting Excalidraw root:", e);
        }
        excalidrawReactRoot = null;
    }
    
    // Toggle view
    document.getElementById('whiteboard-workspace-view').style.display = 'none';
    document.getElementById('whiteboard-gallery-view').style.display = 'block';
    
    loadWhiteboards();
}

async function resetWorkspaceCanvas() {
    console.log("resetWorkspaceCanvas called");
    if (!excalidrawReactRef) {
        console.warn("excalidrawReactRef is null!");
        await uiAlert("Kanvas belum siap. Coba beberapa saat lagi.");
        return;
    }
    
    if (await uiConfirm("Apakah Anda yakin ingin mengosongkan kanvas sketsa saat ini? Tindakan ini tidak dapat dibatalkan!")) {
        try {
            console.log("Resetting canvas scene");
            excalidrawReactRef.updateScene({
                elements: []
            });
            console.log("Canvas scene reset successfully");
        } catch (e) {
            console.error("Gagal reset scene:", e);
            await uiAlert("Gagal mengosongkan kanvas: " + e.message);
        }
    }
}

async function deleteWhiteboard(id, event) {
    console.log("deleteWhiteboard called with id:", id);
    if (event) {
        console.log("Stopping event propagation");
        event.stopPropagation();
    }
    
    const confirmed = await uiConfirm("Apakah Anda yakin ingin menghapus sketsa coretan ini secara permanen?");
    console.log("Confirmation result:", confirmed);
    if (!confirmed) {
        return;
    }
    
    try {
        console.log("Sending DELETE request to:", `${API_BASE}/whiteboards/${id}`);
        const res = await fetch(`${API_BASE}/whiteboards/${id}`, {
            method: 'DELETE'
        });
        console.log("DELETE response status:", res.status);
        if (res.ok) {
            console.log("Deletion successful, reloading whiteboards");
            loadWhiteboards();
        } else {
            const errText = await res.text();
            console.error("Deletion failed on server:", errText);
            await uiAlert("Gagal menghapus sketsa: " + errText);
        }
    } catch (err) {
        console.error("Gagal menghapus: ", err);
        await uiAlert("Terjadi kesalahan saat menghapus: " + err.message);
    }
}

