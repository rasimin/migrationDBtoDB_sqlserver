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

let migrationTotalTables = 0;
let migrationProcessedTables = {}; // TableName -> Status ('Completed' or 'Failed')

// Hub SignalR
let connection = null;

document.addEventListener('DOMContentLoaded', () => {
    loadJobs();
    initSignalR();
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
    if (!confirm(`Apakah Anda yakin ingin menghapus Job [${name}] beserta seluruh konfigurasi tabel dan kolomnya? Tindakan ini tidak dapat dibatalkan!`)) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${id}`, { method: 'DELETE' });
        if (res.ok) {
            // Jika job yang sedang aktif dihapus, bersihkan editor
            if (activeJob && (activeJob.Id || activeJob.id) === id) {
                activeJob = null;
                document.getElementById('job-editor-panel').style.display = 'none';
                document.getElementById('welcome-panel').style.display = 'flex';
            }
            loadJobs();
        } else {
            alert("Gagal menghapus job.");
        }
    } catch (err) {
        console.error(err);
        alert("Terjadi kesalahan: " + err.message);
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

        // Tandai aktif di list
        loadJobs();

        // Reset sub-tab ke default (Pemetaan)
        switchTab('mapping');

        // Switch ke inner tab Data Migration by default
        switchInnerTab('data');

        // Tampilkan Panel Editor
        document.getElementById('welcome-panel').style.display = 'none';
        document.getElementById('job-editor-panel').style.display = 'block';

        document.getElementById('active-job-title').innerHTML = `
            <i class="fa-solid fa-code-fork" style="color: var(--accent-indigo);"></i> 
            Job: <strong>${activeJob.JobName || activeJob.jobName}</strong>
        `;

        // Join SignalR Group
        joinJobGroupSignalR(jobId);

        // Load mappings & db schemas
        loadTableMappings(jobId);
        loadDatabaseSchemas();

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
        alert("Harap isi connection string terlebih dahulu!");
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
                alert(data.Message || data.message || "Koneksi berhasil terhubung!");
            } else {
                alert(data.Message || data.message || "Gagal terhubung.");
            }
        } else {
            const errText = await res.text();
            alert("Gagal melakukan tes koneksi: " + errText);
        }
    } catch (err) {
        console.error(err);
        alert("Terjadi kesalahan: " + err.message);
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
    const postScript = document.getElementById('post-migration-script') ? document.getElementById('post-migration-script').value.trim() : null;

    if (!name || !source || !target) {
        alert("Harap isi semua kolom form!");
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
        if (!confirm(msg)) {
            return;
        }
    }

    const payload = {
        Id: id,
        JobName: name,
        SourceConnectionString: source,
        TargetConnectionString: target,
        PostMigrationScript: postScript
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
            alert("Gagal menyimpan job: " + err);
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

        let statusClass = 'pending';
        if (lastStatus === 'Completed') statusClass = 'completed';
        else if (lastStatus === 'Failed') statusClass = 'failed';
        else if (lastStatus === 'InProgress') statusClass = 'inprogress';

        let lastRunTime = '';
        if (lastRunAt) {
            lastRunTime = new Date(lastRunAt).toLocaleString();
        }

        if (isNative) {
            return `
            <div class="table-item sortable-item native-sql-item" draggable="${isFilterActive ? 'false' : 'true'}" data-sort-id="${mapId}">
                <div class="table-info">
                    ${isFilterActive ? '' : `
                    <div class="drag-handle" title="Geser untuk mengubah urutan">
                        <i class="fa-solid fa-grip-vertical"></i>
                    </div>`}
                    <div class="execution-badge" title="Urutan Eksekusi">${map.ExecutionOrder || map.executionOrder}</div>
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
                    <button class="btn-icon delete" onclick="deleteTableMapping(${mapId})" title="Hapus Native SQL">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
        }

        return `
            <div class="table-item sortable-item" draggable="${isFilterActive ? 'false' : 'true'}" data-sort-id="${mapId}">
                <div class="table-info">
                    ${isFilterActive ? '' : `
                    <div class="drag-handle" title="Geser untuk mengubah urutan">
                        <i class="fa-solid fa-grip-vertical"></i>
                    </div>`}
                    <div class="execution-badge" title="Urutan Eksekusi">${map.ExecutionOrder || map.executionOrder}</div>
                    <div style="display: flex; flex-direction: column; gap: 0.35rem; width: 100%;">
                        <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
                            <div class="table-flow" style="margin: 0; padding: 0; background: none; box-shadow: none; display: flex; align-items: center; gap: 0.5rem;">
                                <span style="color: var(--text-muted); font-size: 0.9rem;">${sourceName}</span>
                                <span class="arrow" style="margin: 0; font-size: 0.8rem; color: var(--text-muted); display: inline-flex; align-items: center;"><i class="fa-solid fa-circle-arrow-right"></i></span>
                                <span style="color: #ffffff; font-weight: 600;">${targetName}</span>
                            </div>
                            <span class="badge-clean ${statusClass}">${lastStatus}</span>
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
                    <button class="btn-icon" onclick="editTableMapping(${map.Id || map.id}, '${map.SourceTableName || map.sourceTableName}', '${map.TargetTableName || map.targetTableName}', ${map.ExecutionOrder || map.executionOrder}, ${map.TruncateTarget || map.truncateTarget || false}, '${(map.PostMigrationScript || map.postMigrationScript || '').replace(/'/g, "\\'")}')" title="Edit Pemetaan Tabel">
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

        const afterElement = getDragAfterElement(container, e.clientY, itemSelector);
        container.querySelectorAll(`${itemSelector}.drag-over`).forEach(el => el.classList.remove('drag-over'));

        if (afterElement == null) {
            container.appendChild(dragging);
        } else {
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

function getDragAfterElement(container, y, itemSelector) {
    const draggableElements = [...container.querySelectorAll(`${itemSelector}:not(.dragging)`)];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;

        if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
        }

        return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
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
        alert('Gagal menyimpan urutan. Data akan dimuat ulang.');
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
    document.getElementById('execution-order').value = 1;
    document.getElementById('truncate-target').checked = false;
    if (document.getElementById('table-post-migration-script')) {
        document.getElementById('table-post-migration-script').value = '';
    }
    document.getElementById('table-modal-title').innerText = 'Pemetaan Tabel Baru';

    document.getElementById('table-mapping-modal').classList.add('active');
}

function editTableMapping(id, sourceTable, targetTable, order, truncate, postScript) {
    populateTableDatalists();

    document.getElementById('table-mapping-id').value = id;
    document.getElementById('source-table-select').value = sourceTable || '';
    document.getElementById('target-table-select').value = targetTable || '';
    document.getElementById('execution-order').value = order;
    document.getElementById('truncate-target').checked = truncate;
    if (document.getElementById('table-post-migration-script')) {
        document.getElementById('table-post-migration-script').value = postScript || '';
    }
    document.getElementById('table-modal-title').innerText = 'Edit Pemetaan Tabel';

    document.getElementById('table-mapping-modal').classList.add('active');
}

function closeTableMappingModal() {
    document.getElementById('table-mapping-modal').classList.remove('active');
}

function openDataNativeSqlModal() {
    if (!activeJob) return;
    document.getElementById('data-native-sql-name').value = '';
    document.getElementById('data-native-sql-mode').value = 'target';
    document.getElementById('data-native-sql-script').value = '';
    updateDataNativeSqlTemplate();
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

    const name = document.getElementById('data-native-sql-name').value.trim();
    const script = document.getElementById('data-native-sql-script').value.trim();

    if (!name || !script) {
        alert('Harap isi nama langkah dan script SQL!');
        return;
    }

    const payload = {
        JobId: activeJob.Id || activeJob.id,
        SourceTableName: '[NATIVE_SQL]',
        TargetTableName: name,
        ExecutionOrder: 99,
        TruncateTarget: false,
        IsEnabled: true,
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
            alert('Gagal menambahkan Native SQL: ' + await res.text());
        }
    } catch (err) {
        console.error(err);
    }
}

function populateTableDatalists() {
    setupTableAutocomplete('source-table-select', 'source-table-options', sourceTables);
    setupTableAutocomplete('target-table-select', 'target-table-options', targetTables);
    setupTableAutocomplete('clean-table-select', 'clean-table-options', targetTables);
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

    if (!sourceTable || !targetTable) {
        alert("Harap pilih tabel asal dan tujuan!");
        return;
    }

    if (!sourceTables.includes(sourceTable)) {
        alert("Nama tabel asal tidak ditemukan di daftar Source DB.");
        return;
    }

    if (!targetTables.includes(targetTable)) {
        alert("Nama tabel tujuan tidak ditemukan di daftar Target DB.");
        return;
    }

    const payload = {
        Id: id,
        JobId: activeJob.Id || activeJob.id,
        SourceTableName: sourceTable,
        TargetTableName: targetTable,
        ExecutionOrder: order,
        TruncateTarget: truncate,
        IsEnabled: true,
        MappingMode: 'TABLE',
        NativeSqlScript: null,
        PostMigrationScript: postScript
    };

    try {
        const res = await fetch(`${API_BASE}/mappings/tables`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            closeTableMappingModal();
            loadTableMappings(activeJob.Id || activeJob.id);
        } else {
            const errText = await res.text();
            alert("Gagal menyimpan pemetaan tabel: " + errText);
        }
    } catch (err) {
        console.error(err);
    }
}

async function deleteTableMapping(id) {
    if (!confirm("Apakah Anda yakin ingin menghapus pemetaan tabel ini beserta konfigurasi kolomnya?")) return;

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

function autoMapColumns() {
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
        alert(`Sukses mencocokkan otomatis ${mapCount} kolom!`);
    } else {
        alert("Tidak ada kolom dengan nama yang sama untuk dicocokkan otomatis.");
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
                alert(`Kolom "${targetColName}" bertipe "Direct" harus memilih kolom asal.`);
                return;
            }
            colMapping.SourceColumnName = srcCol;
        }
        else if (mappingType === 'Constant') {
            const constVal = fieldsContainer.querySelector('.col-constant-input').value.trim();
            if (constVal === '') {
                alert(`Kolom "${targetColName}" bertipe "Constant" harus diisi nilai default.`);
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
                alert(`Kolom "${targetColName}" bertipe "Lookup" harus mengisi tabel referensi, key pencari, ID hasil, dan kolom asal.`);
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
                alert(`Kolom "${targetColName}" bertipe "Expression" harus diisi ekspresi SQL.`);
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
            alert("Semua pemetaan kolom sukses disimpan!");
            closeColumnMappingModal();
        } else {
            const errText = await res.text();
            alert("Gagal menyimpan: " + errText);
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
    if (!confirm(`Apakah Anda yakin ingin memulai migrasi untuk job "${activeJob.JobName || activeJob.jobName}" sekarang?`)) return;

    // Reset State & Dashboard UI
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

    try {
        const res = await fetch(`${API_BASE}/jobs/${activeJob.Id || activeJob.id}/run`, { method: 'POST' });
        if (res.ok) {
            const msg = await res.json();
            const logLine = document.createElement('div');
            logLine.className = 'console-line info';
            logLine.innerText = `[${new Date().toLocaleTimeString()}] ${msg.Message}`;
            logsBox.appendChild(logLine);
        } else {
            alert("Gagal menjalankan migrasi.");
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
            alert("Gagal membatalkan: " + text);
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-ban"></i> Batalkan Migrasi`;
        }
    } catch (err) {
        console.error(err);
        alert("Gagal membatalkan: " + err.message);
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
        alert("Terjadi kesalahan ekspor: " + err.message);
    }
}

// FEAT-004: JSON Import
function triggerImport() {
    document.getElementById('import-file-input').click();
}

function importJsonFile(event) {
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
                alert(`Sukses mengimpor job: ${newJob.JobName || newJob.jobName}`);
                loadJobs();
                selectJob(newJob.Id || newJob.id);
            } else {
                const errText = await res.text();
                alert("Gagal mengimpor job: " + errText);
            }
        } catch (err) {
            console.error(err);
            alert("Gagal membaca file JSON: " + err.message);
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
        if (mappingList) mappingList.style.display = 'flex';
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
            alert("Gagal meng-generate SP: " + text);
            return;
        }
        const data = await res.json();

        document.getElementById('sp-modal-title').innerText = `Generate SP: ${data.SpName}`;
        document.getElementById('sp-sql-textarea').value = data.SqlScript;
        document.getElementById('sp-generator-modal').classList.add('active');
    } catch (err) {
        console.error(err);
        alert("Terjadi kesalahan: " + err.message);
    }
}

function closeSpGeneratorModal() {
    document.getElementById('sp-generator-modal').classList.remove('active');
}

function copySpScript() {
    const textarea = document.getElementById('sp-sql-textarea');
    textarea.select();
    textarea.setSelectionRange(0, 99999); /* For mobile devices */

    navigator.clipboard.writeText(textarea.value)
        .then(() => {
            alert("Script SQL Stored Procedure berhasil disalin ke clipboard!");
        })
        .catch(err => {
            console.error("Gagal menyalin: ", err);
            alert("Gagal menyalin ke clipboard. Silakan salin secara manual.");
        });
}

// ============================================================================
// 7. INNER TAB SWITCHING (Data Migration ↔ Object Migration within a Job)
// ============================================================================
function switchInnerTab(tab) {
    const dataBtn = document.getElementById('inner-tab-data');
    const objBtn = document.getElementById('inner-tab-object');
    const cleanBtn = document.getElementById('inner-tab-clean');
    const dataContent = document.getElementById('inner-content-data');
    const objContent = document.getElementById('inner-content-object');
    const cleanContent = document.getElementById('inner-content-clean');

    if (!dataBtn || !objBtn || !cleanBtn) return;

    // Reset active button state
    dataBtn.classList.remove('active');
    objBtn.classList.remove('active');
    cleanBtn.classList.remove('active');

    // Hide all contents
    if (dataContent) dataContent.style.display = 'none';
    if (objContent) objContent.style.display = 'none';
    if (cleanContent) cleanContent.style.display = 'none';

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

        return `
            <div class="table-item sortable-item" draggable="${isFilterActive ? 'false' : 'true'}" data-sort-id="${itemId}">
                <div class="table-info">
                    ${isFilterActive ? '' : `
                    <div class="drag-handle" title="Geser untuk mengubah urutan">
                        <i class="fa-solid fa-grip-vertical"></i>
                    </div>`}
                    <div class="execution-badge" title="Urutan Eksekusi">${item.ExecutionOrder || item.executionOrder || 1}</div>
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
    if (!confirm("Hapus objek ini dari daftar migrasi?")) return;
    try {
        await fetch(`${API_BASE}/obj-items/${id}`, { method: 'DELETE' });
        if (activeJob) loadObjItems(activeJob.Id || activeJob.id);
    } catch (err) {
        console.error(err);
    }
}

// ============================================================================
// 10. OBJECT SCANNER MODAL
// ============================================================================
function openObjScannerModal() {
    document.getElementById('obj-scanner-modal').classList.add('active');
    startObjScan();
}

function closeObjScannerModal() {
    document.getElementById('obj-scanner-modal').classList.remove('active');
}

async function startObjScan() {
    if (!activeJob) { alert('Silakan pilih Job terlebih dahulu.'); return; }
    const container = document.getElementById('obj-scan-results');
    container.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 2rem;"><i class="fa-solid fa-spinner fa-spin"></i> Memindai objek dari Source DB...</p>`;

    try {
        const res = await fetch(`${API_BASE}/jobs/${activeJob.Id || activeJob.id}/obj-scan`);
        if (!res.ok) {
            container.innerHTML = `<p style="color: var(--color-error); text-align: center; padding: 2rem;">Gagal memindai: ${await res.text()}</p>`;
            return;
        }
        scanResultsCache = await res.json();
        renderScanResults(scanResultsCache);
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
    event.target.classList.add('active');

    if (type === 'ALL') {
        renderScanResults(scanResultsCache);
    } else {
        const filtered = scanResultsCache.filter(i => (i.ObjectType || i.objectType) === type);
        renderScanResults(filtered);
    }
}

function toggleAllScanItems(checked) {
    document.querySelectorAll('.scan-checkbox').forEach(cb => cb.checked = checked);
}

async function addSelectedScanItems() {
    const checkboxes = document.querySelectorAll('.scan-checkbox:checked');
    if (checkboxes.length === 0) {
        alert("Pilih minimal satu objek untuk ditambahkan!");
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
            alert(data.Message || `${items.length} objek ditambahkan.`);
            closeObjScannerModal();
            loadObjItems(jobId);
        } else {
            alert("Gagal menambahkan: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
    }
}

// ============================================================================
// 11. NATIVE SQL MODAL
// ============================================================================
function openObjNativeSqlModal() {
    document.getElementById('native-sql-name').value = '';
    document.getElementById('native-sql-mode').value = 'target';
    document.getElementById('native-sql-script').value = '';
    updateNativeSqlTemplate();
    document.getElementById('obj-native-sql-modal').classList.add('active');
}

function closeObjNativeSqlModal() {
    document.getElementById('obj-native-sql-modal').classList.remove('active');
}

function updateNativeSqlTemplate() {
    const mode = document.getElementById('native-sql-mode').value;
    const textarea = document.getElementById('native-sql-script');
    const hint = document.getElementById('native-sql-hint');

    if (mode === 'source-target') {
        hint.innerHTML = 'Script tetap dieksekusi dari koneksi Target DB. Pakai <code>{{SOURCE_DB}}</code> dan <code>{{TARGET_DB}}</code> untuk nama database. Mode ini bekerja saat Source dan Target berada di SQL Server instance yang sama.';
        if (!textarea.value.trim()) {
            textarea.value = `INSERT INTO {{TARGET_DB}}.dbo.TargetTable (ColumnA, ColumnB)\nSELECT ColumnA, ColumnB\nFROM {{SOURCE_DB}}.dbo.SourceTable\nWHERE 1 = 1;`;
        }
        return;
    }

    hint.innerHTML = 'Cocok untuk UPDATE, ALTER TABLE, CREATE INDEX, cleanup data, atau script lain yang berjalan langsung di Target DB.';
    if (!textarea.value.trim()) {
        textarea.value = `UPDATE dbo.TargetTable\nSET UpdatedAt = GETDATE()\nWHERE UpdatedAt IS NULL;`;
    }
}

async function addNativeSqlItem() {
    if (!activeJob) return;
    const name = document.getElementById('native-sql-name').value.trim();
    const script = document.getElementById('native-sql-script').value.trim();

    if (!name || !script) {
        alert("Harap isi nama dan script SQL!");
        return;
    }

    const payload = {
        JobId: activeJob.Id || activeJob.id,
        ObjectName: name,
        ObjectType: 'NATIVE_SQL',
        NativeSqlScript: script,
        ExecutionOrder: 99,
        IsEnabled: true
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
            alert("Gagal menambahkan: " + await res.text());
        }
    } catch (err) {
        console.error(err);
    }
}

// ============================================================================
// 12. RUN OBJECT MIGRATION
// ============================================================================
async function runObjMigration() {
    if (!activeJob) { alert('Silakan pilih Job terlebih dahulu.'); return; }
    const jobName = activeJob.JobName || activeJob.jobName;
    if (!confirm(`Jalankan migrasi objek untuk job "${jobName}"?\n\nSP/Function/View: akan di-drop & create ulang.\nTable: akan CREATE baru atau ALTER sync kolom.\nNative SQL: akan dieksekusi langsung.\n\nSemua objek yang sudah ada di Target akan di-backup otomatis.`)) return;

    const jobId = activeJob.Id || activeJob.id;

    // Show loading state on button (now inside inner-content-object)
    const btn = document.querySelector('#inner-content-object .btn-primary');
    const originalBtnHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menjalankan...';
        btn.disabled = true;
    }

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/obj-run`, { method: 'POST' });
        if (!res.ok) {
            alert("Gagal menjalankan migrasi: " + await res.text());
            return;
        }

        const data = await res.json();
        const results = data.Results || data.results || [];

        // Show results summary
        let successCount = results.filter(r => r.Status === 'Completed' && r.Message !== 'Skipped (Already migrated)').length;
        let skipCount = results.filter(r => r.Status === 'Completed' && r.Message === 'Skipped (Already migrated)').length;
        let failCount = results.filter(r => r.Status === 'Failed').length;

        let summaryHtml = `<div style="margin-bottom: 1.5rem;">
            <div style="font-family: var(--font-heading); font-size: 1.1rem; font-weight: 600; margin-bottom: 0.75rem;">
                <i class="fa-solid fa-flag-checkered"></i> Hasil Migrasi Objek
            </div>
            <div style="display: flex; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap;">
                <div style="padding: 0.5rem 1rem; background: var(--color-success-glow); border-radius: 10px; color: var(--color-success); font-weight: 600;">
                    ✅ ${successCount} Sukses
                </div>
                ${skipCount > 0 ? `
                <div style="padding: 0.5rem 1rem; background: rgba(59,130,246,0.08); border-radius: 10px; color: var(--accent-indigo); font-weight: 600; border: 1px solid rgba(59,130,246,0.2);">
                    ⏩ ${skipCount} Diskip (Done)
                </div>` : ''}
                <div style="padding: 0.5rem 1rem; background: var(--color-error-glow); border-radius: 10px; color: var(--color-error); font-weight: 600;">
                    ❌ ${failCount} Gagal
                </div>
            </div>
        </div>`;

        summaryHtml += results.map(r => {
            const isOk = r.Status === 'Completed';
            return `<div style="padding: 0.75rem 1rem; border-radius: 10px; margin-bottom: 0.5rem; background: ${isOk ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)'}; border: 1px solid ${isOk ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'};">
                <span style="font-weight: 600; color: ${isOk ? 'var(--color-success)' : 'var(--color-error)'}">${isOk ? '✅' : '❌'} ${r.ObjectName}</span>
                <span style="font-size: 0.8rem; color: var(--text-muted); margin-left: 0.5rem;">${r.Message}</span>
            </div>`;
        }).join('');

        // Replace the items container temporarily with results
        const container = document.getElementById('obj-items-container');
        container.innerHTML = summaryHtml + `
            <div style="margin-top: 1.5rem; text-align: center;">
                <button class="btn btn-secondary" onclick="loadObjItems(${jobId})" style="width: auto; padding: 0.5rem 1.5rem;">
                    <i class="fa-solid fa-arrow-left"></i> Kembali ke Daftar Objek
                </button>
            </div>
        `;

    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
    } finally {
        if (btn) {
            btn.innerHTML = originalBtnHtml;
            btn.disabled = false;
        }
    }
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
        itemsContainer.style.display = 'flex';
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
function applyConnBuilder() {
    const connStr = document.getElementById('cb-preview').value.trim();
    if (!connStr) {
        alert('Connection string kosong. Harap isi minimal Server Name dan Database Name.');
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
        alert('Connection string kosong. Harap isi Server Name dan Database Name terlebih dahulu.');
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
                alert('✅ Koneksi berhasil!\n' + (data.Message || data.message || 'Database dapat diakses.'));
            } else {
                alert('❌ Koneksi gagal:\n' + (data.Message || data.message || 'Tidak dapat terhubung.'));
            }
        } else {
            const errText = await res.text();
            alert('❌ HTTP Error:\n' + errText);
        }
    } catch (err) {
        alert('❌ Error: ' + err.message);
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

async function addCleanTables() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    const singleInput = document.getElementById('clean-table-select');
    const bulkInput = document.getElementById('clean-bulk-textarea');

    const singleVal = singleInput ? singleInput.value.trim() : '';
    const bulkVal = bulkInput ? bulkInput.value.trim() : '';

    let tableNames = '';
    if (singleVal) {
        tableNames = singleVal;
    } else if (bulkVal) {
        tableNames = bulkVal;
    } else {
        alert("Pilih tabel tunggal atau ketik nama tabel massal!");
        return;
    }

    try {
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
            alert(alertMsg);

            // Clear inputs
            if (singleInput) singleInput.value = '';
            if (bulkInput) bulkInput.value = '';

            loadCleanTables(jobId);
        } else {
            alert("Gagal menambahkan: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
    }
}

async function deleteCleanTable(id) {
    if (!confirm("Apakah Anda yakin ingin menghapus tabel ini dari daftar pembersih?")) return;
    try {
        const res = await fetch(`${API_BASE}/clean-tables/${id}`, { method: 'DELETE' });
        if (res.ok) {
            if (activeJob) loadCleanTables(activeJob.Id || activeJob.id);
        } else {
            alert("Gagal menghapus.");
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

    if (!confirm(confirmMsg)) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/clean-tables/run?id=${id}`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            const result = data.Results[0];
            if (result.Status === 'Completed') {
                alert(`✅ Sukses membersihkan tabel ${result.TableName}!\n\n${result.Message}`);
            } else {
                alert(`❌ Gagal membersihkan tabel ${result.TableName}!\n\nDetail: ${result.Message}`);
            }
            loadCleanTables(jobId);
        } else {
            alert("Gagal mengeksekusi pembersihan: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
    }
}

async function runAllClean() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    const connStr = activeJob.TargetConnectionString || activeJob.targetConnectionString || '';
    const dbInfo = parseConnectionStringDb(connStr);

    const rows = [...document.querySelectorAll('#clean-tables-container .table-item')];
    const tableNames = rows.map(row => row.querySelector('.clean-table-name')?.textContent?.trim()).filter(Boolean);

    if (tableNames.length === 0) {
        alert("Tidak ada tabel di daftar untuk dibersihkan.");
        return;
    }

    const confirmMsg = `⚠️ PERINGATAN KESELAMATAN KRITIS PEMBERSIHAN MASSAL ⚠️\n\n` +
        `Anda akan MENGHAPUS SEMUA DATA dari ${tableNames.length} tabel berikut secara berurutan:\n` +
        `${tableNames.map((t, idx) => `  ${idx + 1}. ${t}`).join('\n')}\n\n` +
        `👉 DATABASE TUJUAN: ${dbInfo}\n\n` +
        `Mekanisme:\n` +
        `1. DELETE data di setiap tabel.\n` +
        `2. RESEED Identity ke 0 (jika ada kolom Identity).\n\n` +
        `Apakah Anda benar-benar yakin ingin membersihkan data seluruh tabel ini? Tindakan ini bersifat permanen!`;

    if (!confirm(confirmMsg)) return;

    const btn = document.querySelector('#inner-content-clean .btn-danger');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sedang Membersihkan...';
        btn.disabled = true;
    }

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/clean-tables/run`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            const results = data.Results || [];

            const successCount = results.filter(r => r.Status === 'Completed' && r.Message !== 'Skipped (Already cleaned)').length;
            const skipCount = results.filter(r => r.Status === 'Completed' && r.Message === 'Skipped (Already cleaned)').length;
            const failCount = results.filter(r => r.Status === 'Failed').length;

            let cleanResultMsg = `🧹 Proses pembersihan selesai!\n\n✅ Sukses: ${successCount} tabel\n❌ Gagal: ${failCount} tabel`;
            if (skipCount > 0) {
                cleanResultMsg += `\n⏩ Diskip (Done): ${skipCount} tabel`;
            }
            alert(cleanResultMsg);
            loadCleanTables(jobId);
        } else {
            alert("Gagal mengeksekusi pembersihan: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
    } finally {
        if (btn) {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    }
}

async function generateCleanSpScript() {
    if (!activeJob) {
        alert("Pilih Job terlebih dahulu!");
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
            alert("Gagal meng-generate SP Pembersih: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
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
    if (!confirm(confirmMsg)) return;

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

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/run?mappingId=${mappingId}`, { method: 'POST' });
        if (res.ok) {
            const msg = await res.json();
            const logLine = document.createElement('div');
            logLine.className = 'console-line info';
            logLine.innerText = `[${new Date().toLocaleTimeString()}] ${msg.Message}`;
            logsBox.appendChild(logLine);
        } else {
            alert("Gagal menjalankan migrasi.");
        }
    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
    }
}

async function runSingleObjItem(itemId) {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;

    const row = document.querySelector(`.table-item[data-sort-id="${itemId}"]`);
    const objName = row ? row.querySelector('span[style*="font-weight: 600"]').textContent.trim() : 'Objek terpilih';

    const confirmMsg = `Jalankan migrasi objek "${objName}" sekarang?`;
    if (!confirm(confirmMsg)) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/obj-run?itemId=${itemId}`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            const result = data.Results[0];
            if (result.Status === 'Completed') {
                alert(`✅ Sukses memigrasi objek ${result.ObjectName}!\n\nDetail: ${result.Message}`);
            } else {
                alert(`❌ Gagal memigrasi objek ${result.ObjectName}!\n\nDetail: ${result.Message}`);
            }
            loadObjItems(jobId);
        } else {
            alert("Gagal menjalankan migrasi objek: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
    }
}

async function resetDataStatuses() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    if (!confirm("Apakah Anda yakin ingin me-reset semua status pemetaan data ke 'Pending'?")) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/mappings/reset-status`, { method: 'POST' });
        if (res.ok) {
            alert("Status pemetaan data berhasil di-reset!");
            loadTableMappings(jobId);
        } else {
            alert("Gagal me-reset status: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
    }
}

async function resetObjStatuses() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    if (!confirm("Apakah Anda yakin ingin me-reset semua status objek migrasi ke 'Pending'?")) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/obj-items/reset-status`, { method: 'POST' });
        if (res.ok) {
            alert("Status objek migrasi berhasil di-reset!");
            loadObjItems(jobId);
        } else {
            alert("Gagal me-reset status: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
    }
}

async function resetCleanStatuses() {
    if (!activeJob) return;
    const jobId = activeJob.Id || activeJob.id;
    if (!confirm("Apakah Anda yakin ingin me-reset semua status pembersihan tabel ke 'Pending'?")) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/clean-tables/reset-status`, { method: 'POST' });
        if (res.ok) {
            alert("Status pembersihan tabel berhasil di-reset!");
            loadCleanTables(jobId);
        } else {
            alert("Gagal me-reset status: " + await res.text());
        }
    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
    }
}
