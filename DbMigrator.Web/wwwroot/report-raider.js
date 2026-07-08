/* ============================================================================
   SSRS RAIDER - direct ReportServer database catalog browser
   ============================================================================ */

let reportRaiderConnectionString = localStorage.getItem('reportRaiderConnectionString') || '';
let reportRaiderRoot = null;
let reportRaiderCurrent = null;
let reportRaiderItems = [];
let reportRaiderPathStack = [];
let reportRaiderTreeCache = new Map();
let reportRaiderExpandedFolders = new Set();
let reportRaiderLoadingFolders = new Set();

function initReportRaiderTab() {
    const connInput = document.getElementById('raider-conn-string');
    if (!connInput) return;

    if (reportRaiderConnectionString && !connInput.value) {
        connInput.value = reportRaiderConnectionString;
    }

    if (reportRaiderConnectionString && reportRaiderRoot) {
        showReportRaiderWorkspace();
        renderReportRaiderTree();
        renderReportRaiderBreadcrumbs();
        renderReportRaiderItems(reportRaiderItems);
    }
}

function loadReportRaiderFromQueryState() {
    const server = localStorage.getItem('queryConsoleServerName') || '';
    const auth = localStorage.getItem('queryConsoleAuthType') || 'SQL';
    const login = localStorage.getItem('queryConsoleLogin') || '';
    const password = localStorage.getItem('queryConsolePassword') || '';
    const db = localStorage.getItem('queryConsoleActiveDatabase') || 'ReportServer';

    if (!server) {
        uiAlert('Belum ada koneksi Query Console yang bisa dipakai untuk prefill.', { variant: 'warning' });
        return;
    }

    const parts = [
        `Server=${server}`,
        `Database=${db || 'ReportServer'}`,
        'TrustServerCertificate=True'
    ];

    if (auth.toUpperCase() === 'SQL') {
        parts.push(`User Id=${login}`);
        parts.push(`Password=${password}`);
    } else {
        parts.push('Integrated Security=True');
    }

    document.getElementById('raider-conn-string').value = parts.join(';') + ';';
}

function openReportRaiderConnectionBuilder() {
    const conn = document.getElementById('raider-conn-string')?.value.trim() || reportRaiderConnectionString || '';

    setReportRaiderBuilderValue('raider-cb-server', '');
    setReportRaiderBuilderValue('raider-cb-database', 'ReportServer');
    setReportRaiderBuilderValue('raider-cb-username', '');
    setReportRaiderBuilderValue('raider-cb-password', '');
    setReportRaiderBuilderChecked('raider-cb-trust-cert', true);
    setReportRaiderBuilderChecked('raider-cb-encrypt', false);

    if (conn) {
        parseReportRaiderConnectionToBuilder(conn);
    }

    updateReportRaiderConnectionPreview();
    document.getElementById('raider-conn-builder-modal')?.classList.add('active');
    setTimeout(() => document.getElementById('raider-cb-server')?.focus(), 100);
}

function parseReportRaiderConnectionToBuilder(connStr) {
    const mapping = [
        [['Server', 'Data Source'], 'raider-cb-server'],
        [['Database', 'Initial Catalog'], 'raider-cb-database'],
        [['User Id', 'UID', 'User'], 'raider-cb-username'],
        [['Password', 'PWD'], 'raider-cb-password']
    ];

    mapping.forEach(([keys, id]) => {
        const value = matchConnValue(connStr, keys);
        if (value) setReportRaiderBuilderValue(id, value);
    });

    const trust = matchConnValue(connStr, ['TrustServerCertificate']);
    const encrypt = matchConnValue(connStr, ['Encrypt']);
    if (trust) setReportRaiderBuilderChecked('raider-cb-trust-cert', trust.toLowerCase() === 'true');
    if (encrypt) setReportRaiderBuilderChecked('raider-cb-encrypt', encrypt.toLowerCase() === 'true');
}

function updateReportRaiderConnectionPreview() {
    const server = getReportRaiderBuilderValue('raider-cb-server');
    const database = getReportRaiderBuilderValue('raider-cb-database');
    const username = getReportRaiderBuilderValue('raider-cb-username');
    const password = getReportRaiderBuilderValue('raider-cb-password');
    const trustCert = document.getElementById('raider-cb-trust-cert')?.checked;
    const encrypt = document.getElementById('raider-cb-encrypt')?.checked;

    const parts = [];
    if (server) parts.push(`Server=${server}`);
    if (database) parts.push(`Database=${database}`);
    if (username) parts.push(`User Id=${username}`);
    if (password) parts.push(`Password=${password}`);
    parts.push(`TrustServerCertificate=${trustCert ? 'True' : 'False'}`);
    if (encrypt) parts.push('Encrypt=True');

    setReportRaiderBuilderValue('raider-cb-preview', parts.join(';') + (parts.length ? ';' : ''));
}

function closeReportRaiderConnectionBuilder() {
    document.getElementById('raider-conn-builder-modal')?.classList.remove('active');
}

function toggleReportRaiderBuilderPassword() {
    const input = document.getElementById('raider-cb-password');
    const icon = document.getElementById('raider-cb-password-icon');
    if (!input || !icon) return;

    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    icon.className = visible ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
}

async function testReportRaiderBuilderConnection() {
    const connStr = getReportRaiderBuilderValue('raider-cb-preview');
    if (!isReportRaiderBuilderReady(connStr)) return;

    const btn = document.querySelector('#raider-conn-builder-modal .btn-test-raider-conn');
    const original = btn?.innerHTML || '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Testing...';
    }

    try {
        const data = await postReportRaiderJson('connect', { ConnectionString: connStr });
        if (!(data.Success || data.success)) {
            throw new Error(data.Message || data.message || 'Koneksi gagal.');
        }

        const root = data.Root || data.root;
        const rootName = root ? (root.Name || root.name || 'Root') : 'Root';
        await uiAlert(`Koneksi berhasil. Folder awal: ${rootName}`, { variant: 'success' });
    } catch (err) {
        console.error(err);
        await uiAlert('Koneksi gagal: ' + err.message, { variant: 'error' });
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }
}

async function useReportRaiderBuilderConnection() {
    const connStr = getReportRaiderBuilderValue('raider-cb-preview');
    if (!isReportRaiderBuilderReady(connStr)) return;

    const target = document.getElementById('raider-conn-string');
    if (target) target.value = connStr;
    closeReportRaiderConnectionBuilder();
}

function isReportRaiderBuilderReady(connStr) {
    if (!connStr || !getReportRaiderBuilderValue('raider-cb-server') || !getReportRaiderBuilderValue('raider-cb-database')) {
        uiAlert('Isi minimal Server Name dan Database Name terlebih dahulu.', { variant: 'warning' });
        return false;
    }
    return true;
}

function getReportRaiderBuilderValue(id) {
    return document.getElementById(id)?.value.trim() || '';
}

function setReportRaiderBuilderValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
}

function setReportRaiderBuilderChecked(id, checked) {
    const el = document.getElementById(id);
    if (el) el.checked = checked;
}

async function connectReportRaider() {
    const input = document.getElementById('raider-conn-string');
    const conn = input.value.trim();
    if (!conn) {
        await uiAlert('Connection string ReportServer tidak boleh kosong.', { variant: 'warning' });
        return;
    }

    const btn = document.getElementById('raider-btn-connect');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Connecting...';

    try {
        const data = await postReportRaiderJson('connect', { ConnectionString: conn });
        if (!(data.Success || data.success)) {
            throw new Error(data.Message || data.message || 'Koneksi gagal.');
        }

        reportRaiderConnectionString = conn;
        localStorage.setItem('reportRaiderConnectionString', conn);
        reportRaiderRoot = data.Root || data.root;
        reportRaiderCurrent = reportRaiderRoot;
        reportRaiderPathStack = [reportRaiderRoot];
        reportRaiderTreeCache = new Map();
        reportRaiderExpandedFolders = new Set([getReportRaiderItemId(reportRaiderRoot)]);
        reportRaiderLoadingFolders = new Set();
        showReportRaiderWorkspace();
        renderReportRaiderTree();
        await loadReportRaiderChildren(reportRaiderRoot);
    } catch (err) {
        console.error(err);
        await uiAlert('Gagal connect ReportServer: ' + err.message, { variant: 'error' });
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}

function showReportRaiderWorkspace() {
    document.getElementById('raider-connect-panel').style.display = 'none';
    document.getElementById('raider-workspace').style.display = 'flex';
    updateReportRaiderConnectionBadge();
}

function updateReportRaiderConnectionBadge() {
    const badge = document.getElementById('raider-connection-badge');
    if (!badge) return;

    const server = matchConnValue(reportRaiderConnectionString, ['Server', 'Data Source']) || 'SQL Server';
    const db = matchConnValue(reportRaiderConnectionString, ['Database', 'Initial Catalog']) || 'ReportServer';
    badge.innerHTML = `<i class="fa-solid fa-database"></i> ${escapeHtml(db)} @ ${escapeHtml(server)}`;
}

async function loadReportRaiderChildren(folder) {
    if (!folder) return;
    setReportRaiderLoading(true);
    try {
        reportRaiderCurrent = folder;
        const folderId = getReportRaiderItemId(folder);
        const data = await postReportRaiderJson('children', {
            ConnectionString: reportRaiderConnectionString,
            ParentId: folderId
        });

        if (!(data.Success || data.success)) {
            throw new Error(data.Message || data.message || 'Gagal membaca folder.');
        }

        reportRaiderItems = data.Items || data.items || [];
        reportRaiderTreeCache.set(folderId, reportRaiderItems);
        reportRaiderExpandedFolders.add(folderId);
        renderReportRaiderBreadcrumbs();
        renderReportRaiderTree();
        renderReportRaiderItems(reportRaiderItems);
    } catch (err) {
        console.error(err);
        await uiAlert('Gagal membaca folder: ' + err.message, { variant: 'error' });
    } finally {
        setReportRaiderLoading(false);
    }
}

async function refreshReportRaiderFolder() {
    await loadReportRaiderChildren(reportRaiderCurrent || reportRaiderRoot);
}

function renderReportRaiderTree() {
    const tree = document.getElementById('raider-tree');
    if (!tree || !reportRaiderRoot) return;

    tree.innerHTML = '';
    tree.appendChild(createReportRaiderTreeNode(reportRaiderRoot, 0));
}

function createReportRaiderTreeNode(item, depth) {
    const itemId = getReportRaiderItemId(item);
    const expanded = reportRaiderExpandedFolders.has(itemId);
    const cachedChildren = reportRaiderTreeCache.get(itemId) || [];
    const folders = cachedChildren.filter(isReportRaiderFolder);
    const isLoading = reportRaiderLoadingFolders.has(itemId);

    const wrapper = document.createElement('div');
    wrapper.className = 'raider-tree-entry';

    const node = document.createElement('div');
    node.className = 'raider-tree-node';
    node.style.setProperty('--tree-depth', depth);
    if (sameReportRaiderItem(item, reportRaiderCurrent)) node.classList.add('active');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'raider-tree-toggle';
    toggle.title = expanded ? 'Collapse folder' : 'Expand folder';
    toggle.innerHTML = isLoading
        ? '<i class="fa-solid fa-circle-notch fa-spin"></i>'
        : `<i class="fa-solid ${expanded ? 'fa-chevron-down' : 'fa-chevron-right'}"></i>`;
    toggle.onclick = (event) => {
        event.stopPropagation();
        toggleReportRaiderTreeFolder(item);
    };

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'raider-tree-label';
    label.innerHTML = `<i class="fa-solid fa-folder"></i><span>${escapeHtml(item.Name || item.name || 'Root')}</span>`;
    label.onclick = () => selectReportRaiderTreeFolder(item);

    node.appendChild(toggle);
    node.appendChild(label);
    wrapper.appendChild(node);

    if (expanded && folders.length) {
        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'raider-tree-children';
        folders.forEach(folder => childrenWrap.appendChild(createReportRaiderTreeNode(folder, depth + 1)));
        wrapper.appendChild(childrenWrap);
    }

    return wrapper;
}

async function selectReportRaiderTreeFolder(item) {
    const treePath = findReportRaiderTreePath(getReportRaiderItemId(item));
    reportRaiderPathStack = treePath.length ? treePath : [item];
    await loadReportRaiderChildren(item);
}

async function toggleReportRaiderTreeFolder(item) {
    const itemId = getReportRaiderItemId(item);
    if (reportRaiderExpandedFolders.has(itemId)) {
        reportRaiderExpandedFolders.delete(itemId);
        renderReportRaiderTree();
        return;
    }

    reportRaiderExpandedFolders.add(itemId);
    if (!reportRaiderTreeCache.has(itemId)) {
        await loadReportRaiderTreeBranch(item);
    } else {
        renderReportRaiderTree();
    }
}

async function loadReportRaiderTreeBranch(folder) {
    const folderId = getReportRaiderItemId(folder);
    reportRaiderLoadingFolders.add(folderId);
    renderReportRaiderTree();

    try {
        const data = await postReportRaiderJson('children', {
            ConnectionString: reportRaiderConnectionString,
            ParentId: folderId
        });

        if (!(data.Success || data.success)) {
            throw new Error(data.Message || data.message || 'Gagal membaca folder.');
        }

        reportRaiderTreeCache.set(folderId, data.Items || data.items || []);
    } catch (err) {
        reportRaiderExpandedFolders.delete(folderId);
        console.error(err);
        await uiAlert('Gagal membuka folder tree: ' + err.message, { variant: 'error' });
    } finally {
        reportRaiderLoadingFolders.delete(folderId);
        renderReportRaiderTree();
    }
}

function findReportRaiderTreePath(targetId, item = reportRaiderRoot, path = []) {
    if (!item) return [];

    const nextPath = [...path, item];
    const itemId = getReportRaiderItemId(item);
    if (itemId === targetId) return nextPath;

    const children = (reportRaiderTreeCache.get(itemId) || []).filter(isReportRaiderFolder);
    for (const child of children) {
        const result = findReportRaiderTreePath(targetId, child, nextPath);
        if (result.length) return result;
    }

    return [];
}

function renderReportRaiderBreadcrumbs() {
    const container = document.getElementById('raider-breadcrumbs');
    const upBtn = document.getElementById('raider-btn-up');
    if (!container) return;

    container.innerHTML = '';
    reportRaiderPathStack.forEach((item, index) => {
        if (index > 0) {
            const sep = document.createElement('span');
            sep.className = 'raider-crumb';
            sep.textContent = '/';
            container.appendChild(sep);
        }

        const crumb = document.createElement('span');
        crumb.className = 'raider-crumb' + (index < reportRaiderPathStack.length - 1 ? ' link' : '');
        crumb.textContent = item.Name || item.name || 'Root';
        if (index < reportRaiderPathStack.length - 1) {
            crumb.onclick = () => {
                reportRaiderPathStack = reportRaiderPathStack.slice(0, index + 1);
                loadReportRaiderChildren(item);
            };
        }
        container.appendChild(crumb);
    });

    if (upBtn) {
        upBtn.disabled = reportRaiderPathStack.length <= 1;
        upBtn.style.opacity = reportRaiderPathStack.length <= 1 ? '0.35' : '1';
    }
}

function renderReportRaiderItems(items) {
    const body = document.getElementById('raider-items-body');
    const title = document.getElementById('raider-current-title');
    const selectAll = document.getElementById('raider-select-all');
    if (!body) return;

    if (title) {
        const name = reportRaiderCurrent ? (reportRaiderCurrent.Name || reportRaiderCurrent.name || 'Root') : 'Catalog Items';
        title.innerHTML = `<i class="fa-solid fa-table-list"></i> ${escapeHtml(name)}`;
    }
    if (selectAll) selectAll.checked = false;

    if (!items.length) {
        body.innerHTML = '<tr><td colspan="6" class="raider-empty">Folder ini kosong.</td></tr>';
        updateReportRaiderSelection();
        return;
    }

    body.innerHTML = items.map(item => {
        const id = item.ItemID || item.itemID;
        const name = item.Name || item.name || '';
        const path = item.Path || item.path || '';
        const typeName = item.TypeName || item.typeName || item.TypeStr || item.typeStr || '';
        const size = item.DataLengthText || item.dataLengthText || '';
        const folder = isReportRaiderFolder(item);
        const iconClass = folder ? 'fa-folder folder' : getReportRaiderIconClass(typeName);
        const action = folder
            ? `<button type="button" class="btn btn-secondary raider-action-btn" onclick="openReportRaiderFolder('${id}')"><i class="fa-solid fa-folder-open"></i> Open</button>`
            : `<button type="button" class="btn btn-primary raider-action-btn" onclick="downloadReportRaiderSingle('${id}')"><i class="fa-solid fa-download"></i> Download</button>`;

        return `
            <tr ondblclick="${folder ? `openReportRaiderFolder('${id}')` : `downloadReportRaiderSingle('${id}')`}">
                <td class="raider-check-cell"><input type="checkbox" class="raider-item-check" data-id="${id}" onchange="updateReportRaiderSelection()"></td>
                <td><div class="raider-name-cell"><i class="fa-solid ${iconClass}"></i><span>${escapeHtml(name)}</span></div></td>
                <td><span class="raider-type-badge">${escapeHtml(typeName)}</span></td>
                <td><div class="raider-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div></td>
                <td>${escapeHtml(size)}</td>
                <td>${action}</td>
            </tr>
        `;
    }).join('');
    updateReportRaiderSelection();
}

function filterReportRaiderItems() {
    const term = (document.getElementById('raider-search')?.value || '').trim().toLowerCase();
    if (!term) {
        renderReportRaiderItems(reportRaiderItems);
        return;
    }

    renderReportRaiderItems(reportRaiderItems.filter(item => {
        const name = (item.Name || item.name || '').toLowerCase();
        const path = (item.Path || item.path || '').toLowerCase();
        const typeName = (item.TypeName || item.typeName || '').toLowerCase();
        return name.includes(term) || path.includes(term) || typeName.includes(term);
    }));
}

function openReportRaiderFolder(id) {
    const folder = reportRaiderItems.find(item => (item.ItemID || item.itemID) === id);
    if (!folder) return;
    pushReportRaiderPath(folder);
    loadReportRaiderChildren(folder);
}

function goUpReportRaiderFolder() {
    if (reportRaiderPathStack.length <= 1) return;
    reportRaiderPathStack.pop();
    loadReportRaiderChildren(reportRaiderPathStack[reportRaiderPathStack.length - 1]);
}

function pushReportRaiderPath(item) {
    const id = getReportRaiderItemId(item);
    const existingIndex = reportRaiderPathStack.findIndex(x => (x.ItemID || x.itemID) === id);
    if (existingIndex >= 0) {
        reportRaiderPathStack = reportRaiderPathStack.slice(0, existingIndex + 1);
    } else {
        reportRaiderPathStack.push(item);
    }
}

async function downloadReportRaiderSingle(id) {
    await downloadReportRaiderFile('download', { ItemId: id }, 'report.rdl');
}

async function downloadReportRaiderSelected() {
    const ids = Array.from(document.querySelectorAll('.raider-item-check:checked')).map(cb => cb.dataset.id);
    if (!ids.length) return;
    await downloadReportRaiderFile('download-zip', { ItemIds: ids }, 'ReportRaider_Export.zip');
}

async function downloadReportRaiderFile(action, body, fallbackName) {
    setReportRaiderLoading(true, action === 'download-zip' ? 'Membuat ZIP...' : 'Menyiapkan download...');
    try {
        const response = await fetch(`${API_BASE}/report-raider/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ConnectionString: reportRaiderConnectionString, ...body })
        });

        if (!response.ok) throw new Error(await response.text());

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = getFilenameFromDisposition(response.headers.get('Content-Disposition')) || fallbackName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
    } catch (err) {
        console.error(err);
        await uiAlert('Download gagal: ' + err.message, { variant: 'error' });
    } finally {
        setReportRaiderLoading(false);
    }
}

function toggleReportRaiderSelectAll() {
    const checked = document.getElementById('raider-select-all').checked;
    document.querySelectorAll('.raider-item-check').forEach(cb => cb.checked = checked);
    updateReportRaiderSelection();
}

function updateReportRaiderSelection() {
    const count = document.querySelectorAll('.raider-item-check:checked').length;
    const btn = document.getElementById('raider-download-selected');
    if (!btn) return;
    btn.disabled = count === 0;
    btn.innerHTML = `<i class="fa-solid fa-file-zipper"></i> Download Selected${count ? ` (${count})` : ''}`;
}

function disconnectReportRaider() {
    reportRaiderConnectionString = '';
    reportRaiderRoot = null;
    reportRaiderCurrent = null;
    reportRaiderItems = [];
    reportRaiderPathStack = [];
    reportRaiderTreeCache = new Map();
    reportRaiderExpandedFolders = new Set();
    reportRaiderLoadingFolders = new Set();
    localStorage.removeItem('reportRaiderConnectionString');
    document.getElementById('raider-connect-panel').style.display = 'block';
    document.getElementById('raider-workspace').style.display = 'none';
}

async function postReportRaiderJson(action, body) {
    const res = await fetch(`${API_BASE}/report-raider/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        throw new Error(await res.text());
    }
    return await res.json();
}

function setReportRaiderLoading(show, text) {
    const loading = document.getElementById('raider-loading');
    if (!loading) return;
    if (text) {
        const span = loading.querySelector('span');
        if (span) span.textContent = text;
    } else {
        const span = loading.querySelector('span');
        if (span) span.textContent = 'Membaca katalog SSRS...';
    }
    loading.style.display = show ? 'flex' : 'none';
}

function isReportRaiderFolder(item) {
    return Number(item.Type ?? item.type) === 1 || (item.TypeName || item.typeName) === 'Folder';
}

function sameReportRaiderItem(a, b) {
    if (!a || !b) return false;
    return getReportRaiderItemId(a) === getReportRaiderItemId(b);
}

function getReportRaiderItemId(item) {
    return item?.ItemID || item?.itemID || '';
}

function getReportRaiderIconClass(typeName) {
    const type = (typeName || '').toLowerCase();
    if (type.includes('data source')) return 'fa-network-wired datasource';
    if (type.includes('data set')) return 'fa-database dataset';
    return 'fa-file-lines report';
}

function matchConnValue(conn, keys) {
    const parts = (conn || '').split(';');
    for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const key = part.substring(0, eq).trim().toLowerCase();
        if (keys.some(k => k.toLowerCase() === key)) {
            return part.substring(eq + 1).trim();
        }
    }
    return '';
}

function getFilenameFromDisposition(disposition) {
    if (!disposition) return '';
    const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf) return decodeURIComponent(utf[1].replace(/"/g, ''));
    const normal = disposition.match(/filename="?([^"]+)"?/i);
    return normal ? normal[1] : '';
}
