/* ============================================================================
   QUERY CONSOLE EXECUTION & RESULT RENDERING MODULE - query-execution.js
   ============================================================================ */

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

function renderTableRowsChunk(tableId, queryRunId, rows, headersLength, startIndex, chunkSize = 150) {
    const table = document.getElementById(tableId);
    if (!table) return;
    if (table.getAttribute('data-query-run-id') !== queryRunId) return;

    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    const endIndex = Math.min(startIndex + chunkSize, rows.length);
    const fragment = document.createDocumentFragment();

    const existingRowCount = tbody.children.length;

    for (let i = startIndex; i < endIndex; i++) {
        const row = rows[i];
        const tr = document.createElement('tr');
        const rowNum = existingRowCount + (i - startIndex) + 1;
        let html = `<td class="row-num-cell">${rowNum}</td>`;
        for (let j = 0; j < row.length; j++) {
            const cell = row[j];
            if (cell === null) {
                html += `<td class="null-cell">NULL</td>`;
            } else {
                const strVal = cell.toString();
                html += `<td>${escapeHtml(strVal)}</td>`;
            }
        }
        tr.innerHTML = html;
        fragment.appendChild(tr);
    }

    tbody.appendChild(fragment);

    if (endIndex < rows.length) {
        requestAnimationFrame(() => {
            renderTableRowsChunk(tableId, queryRunId, rows, headersLength, endIndex, chunkSize);
        });
    }
}

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
    }

    // Ensure the tab-specific container is created and cleared
    if (resultsContainer) {
        let tabResultsCont = document.getElementById('query-results-tab-content-' + runningTabId);
        if (!tabResultsCont) {
            tabResultsCont = document.createElement('div');
            tabResultsCont.id = 'query-results-tab-content-' + runningTabId;
            tabResultsCont.className = 'query-tab-results-content';
            resultsContainer.appendChild(tabResultsCont);
        }
        tabResultsCont.innerHTML = "";
        if (queryConsoleActiveTabId === runningTabId) {
            tabResultsCont.classList.remove('inactive');
        } else {
            tabResultsCont.classList.add('inactive');
        }
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
        const queryRunId = Date.now().toString() + Math.random().toString(36).substring(2, 7);
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

            if (resultsContainer) {
                const tabResultsCont = document.getElementById('query-results-tab-content-' + runningTabId);
                if (tabResultsCont) tabResultsCont.innerHTML = '';
            }
            if (queryConsoleActiveTabId === runningTabId) {
                if (statusText) {
                    statusText.textContent = tabData.statusTextHtml;
                    statusText.style.color = tabData.statusTextColor;
                }
                if (rowsCount) rowsCount.textContent = tabData.rowsCountText;
                renderQueryMessages(msgs, execTime, true);
                switchQueryResultsTab('messages');
            }
            return;
        }

        const tables = data.Tables || [];
        if (tables.length === 0 && data.Headers && data.Rows) {
            tables.push({ Headers: data.Headers, Rows: data.Rows });
        }

        // ── Handle PRINT messages & Execution Stats ────────────────────────
        const printMessages = data.PrintMessages || [];
        
        // Auto-generate execution statistics messages for each result set
        const statMessages = [];
        tables.forEach((table) => {
            if (table.Headers.length === 1 && table.Headers[0] === 'Info' && table.Rows.length === 1 && String(table.Rows[0][0]).includes('terpengaruh')) {
                statMessages.push(String(table.Rows[0][0]));
            } else {
                statMessages.push(`(${table.Rows.length} baris dikembalikan)`);
            }
        });
        
        const allMessages = [...printMessages, ...statMessages];
        const msgHtml = getQueryMessagesHtml(allMessages, data.ExecutionTimeMs, false);

        let containerHtml = '';
        if (tables.length > 1) {
            containerHtml += `<div class="query-results-tabs">`;
            tables.forEach((table, index) => {
                const rowCount = table.Rows.length;
                let rowCountText = '';
                if (rowCount === 0) {
                    rowCountText = '0 baris';
                } else if (rowCount > 150) {
                    rowCountText = `${rowCount} baris (150 ditampilkan)`;
                } else {
                    rowCountText = `${rowCount} baris`;
                }
                const colCount = table.Headers ? table.Headers.length : 0;
                const colCountText = `${colCount} kolom`;
                const isFirst = index === 0 ? 'active' : '';
                containerHtml += `
                    <button class="query-tab-btn ${isFirst}" data-tab-idx="${index}" onclick="switchQueryTab('${runningTabId}', ${index})">
                        <i class="fa-solid fa-table"></i> Hasil ${index + 1} (${rowCountText}, ${colCountText})
                    </button>
                `;
            });
            containerHtml += `</div>`;
        }

        tables.forEach((table, index) => {
            const isHidden = (tables.length > 1 && index > 0) ? 'style="display: none;"' : '';
            
            // Only render first 100 rows initially for performance
            const initialRows = table.Rows.slice(0, 100);
            
            containerHtml += `
                <div class="query-results-grid-wrapper query-grid-wrapper" id="query-grid-wrapper-${runningTabId}-${index}" ${isHidden}>
                    <table class="mapper-table query-results-table" id="query-results-table-${runningTabId}-${index}" data-query-run-id="${queryRunId}" style="margin-bottom: 0;">
                        <thead>
                            <tr>
                                <th class="row-num-hdr">#</th>
                                ${table.Headers.map(h => `<th style="position: relative;">${escapeHtml(h)}<div class="resizer"></div></th>`).join('')}
                            </tr>
                        </thead>
                        <tbody>
                            ${table.Rows.length === 0 
                                ? `<tr><td colspan="${table.Headers.length + 1}" style="text-align: center; color: var(--text-muted);">Tidak ada baris yang dikembalikan.</td></tr>`
                                : initialRows.map((row, rIdx) => 
                                    `<tr>
                                        <td class="row-num-cell">${rIdx + 1}</td>
                                        ${row.map(cell => {
                                            if (cell === null) {
                                                return `<td class="null-cell">NULL</td>`;
                                            }
                                            const strVal = cell.toString();
                                            return `<td>${escapeHtml(strVal)}</td>`;
                                        }).join('')}
                                    </tr>`
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
            rowsCountText = `${tables.length} tabel dikembalikan (total ${totalRows} baris) (${formatExecutionTime(data.ExecutionTimeMs)})`;
        } else if (tables.length === 1) {
            const rowCount = tables[0]?.Rows.length ?? 0;
            const colCount = tables[0]?.Headers?.length ?? 0;
            if (rowCount > 150) {
                rowsCountText = `${rowCount} baris (150 ditampilkan), ${colCount} kolom (${formatExecutionTime(data.ExecutionTimeMs)})`;
            } else {
                rowsCountText = `${rowCount} baris, ${colCount} kolom (${formatExecutionTime(data.ExecutionTimeMs)})`;
            }
        } else {
            rowsCountText = `(${formatExecutionTime(data.ExecutionTimeMs)})`;
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
            resultsContainerHtml: '',
            messagesHtml: msgHtml,
            messagesBadgeText: printMessages.length > 0 ? printMessages.length : '',
            messagesBadgeDisplay: printMessages.length > 0 ? 'inline' : 'none',
            activeConsoleTab: activeConsoleTab
        };

        saveQueryRunResult(runningTabId, tabData);

        if (resultsContainer) {
            let tabResultsCont = document.getElementById('query-results-tab-content-' + runningTabId);
            if (!tabResultsCont) {
                tabResultsCont = document.createElement('div');
                tabResultsCont.id = 'query-results-tab-content-' + runningTabId;
                tabResultsCont.className = 'query-tab-results-content';
                resultsContainer.appendChild(tabResultsCont);
            }
            tabResultsCont.innerHTML = containerHtml;
        }

        // Schedule background chunked rendering for rows after the first 100
        tables.forEach((table, index) => {
            if (table.Rows.length > 100) {
                // Limit rendering in the DOM to max 150 total rows for performance
                const remainingRows = table.Rows.slice(100, 150);
                if (remainingRows.length > 0) {
                    const tableDomId = `query-results-table-${runningTabId}-${index}`;
                    requestAnimationFrame(() => {
                        renderTableRowsChunk(tableDomId, queryRunId, remainingRows, table.Headers.length, 0, 150);
                    });
                }
            }
        });

        if (queryConsoleActiveTabId === runningTabId) {
            if (statusText) {
                statusText.innerHTML = tabData.statusTextHtml;
                statusText.style.color = tabData.statusTextColor;
            }
            if (rowsCount) rowsCount.innerHTML = tabData.rowsCountText;

            // Initialize drag-resize columns and infinite scroll
            const tabResultsCont = document.getElementById('query-results-tab-content-' + runningTabId);
            if (tabResultsCont) {
                tabResultsCont.querySelectorAll('.query-results-table').forEach(tbl => {
                    initTableResizers(tbl);
                });

                // Attach infinite scroll event handlers to wrappers
                tabResultsCont.querySelectorAll('.query-results-grid-wrapper').forEach((wrapper, index) => {
                    const tableObj = tables[index];
                    if (!tableObj || tableObj.Rows.length <= 150) return;

                    const tblDom = wrapper.querySelector('.query-results-table');
                    if (!tblDom) return;
                    const qRunId = tblDom.getAttribute('data-query-run-id');

                    let isLoadingMore = false;

                    wrapper.addEventListener('scroll', () => {
                        if (isLoadingMore) return;

                        const threshold = 40; // pixels from the bottom to trigger load
                        const isNearBottom = wrapper.scrollTop + wrapper.clientHeight >= wrapper.scrollHeight - threshold;

                        if (isNearBottom) {
                            const tbody = tblDom.querySelector('tbody');
                            if (!tbody) return;

                            const renderedCount = tbody.children.length;
                            const totalCount = tableObj.Rows.length;

                            if (renderedCount < totalCount) {
                                isLoadingMore = true;

                                const chunkSize = 100;
                                const nextChunk = tableObj.Rows.slice(renderedCount, Math.min(renderedCount + chunkSize, totalCount));

                                const newRenderedCount = renderedCount + nextChunk.length;
                                
                                // Update counts on status bar and buttons
                                updateLoadedRowsDisplay(runningTabId, index, totalCount, newRenderedCount);

                                requestAnimationFrame(() => {
                                    renderTableRowsChunk(tblDom.id, qRunId, nextChunk, tableObj.Headers.length, 0, 100);
                                    isLoadingMore = false;
                                });
                            }
                        }
                    });
                });
            }

            // Sync global cache variables
            window.queryConsoleAllResults = tables;
            window.lastQueryResults = tabData.lastQueryResults;

            // Render messages
            renderQueryMessages(allMessages, data.ExecutionTimeMs, false, printMessages.length);

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

        if (resultsContainer) {
            const tabResultsCont = document.getElementById('query-results-tab-content-' + runningTabId);
            if (tabResultsCont) tabResultsCont.innerHTML = '';
        }

        if (queryConsoleActiveTabId === runningTabId) {
            if (statusText) {
                statusText.textContent = statusTextStr;
                statusText.style.color = statusColorStr;
            }
            if (rowsCount) rowsCount.textContent = rowsCountStr;
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

function switchQueryTab(tabId, index) {
    const tabContent = document.getElementById('query-results-tab-content-' + tabId);
    if (!tabContent) return;

    tabContent.querySelectorAll('.query-tab-btn').forEach(btn => {
        if (parseInt(btn.getAttribute('data-tab-idx')) === index) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    tabContent.querySelectorAll('.query-grid-wrapper').forEach(wrapper => {
        const idStr = `query-grid-wrapper-${tabId}-${index}`;
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
            const msMatch = rowsCount.textContent.match(/\(([^)]+ms)\)/);
            const msStr = msMatch ? ` (${msMatch[1]})` : "";
            const colCount = activeTable.Headers ? activeTable.Headers.length : 0;
            const rowCount = activeTable.Rows.length;
            if (rowCount > 150) {
                rowsCount.innerHTML = `Tabel ${index + 1}: ${rowCount} baris (150 ditampilkan), ${colCount} kolom ditampilkan${msStr}`;
            } else {
                rowsCount.innerHTML = `Tabel ${index + 1}: ${rowCount} baris, ${colCount} kolom ditampilkan${msStr}`;
            }
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

        // Clear the specific DOM container for the active tab
        const currentContainer = document.getElementById('query-results-tab-content-' + queryConsoleActiveTabId);
        if (currentContainer) {
            currentContainer.innerHTML = '';
        }
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
function renderQueryMessages(messages, executionTimeMs, isError, badgeCount) {
    const msgContent = document.getElementById('query-messages-content');
    const badge = document.getElementById('query-tab-messages-badge');
    if (!msgContent) return;

    const html = getQueryMessagesHtml(messages, executionTimeMs, isError);
    msgContent.innerHTML = html;
    
    // Show badge with count if there are print messages
    if (badge) {
        const count = badgeCount !== undefined ? badgeCount : (messages ? messages.length : 0);
        if (count > 0) {
            badge.textContent = count;
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
    window.URL.revokeObjectURL(encodedUri);
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

function updateLoadedRowsDisplay(tabId, tableIndex, totalRows, renderedRowsCount) {
    const rowsCount = document.getElementById('query-rows-count');
    const tab = queryConsoleTabs.find(t => t.id === tabId);
    
    // 1. Update status bar text if it is the currently active tab
    if (rowsCount && queryConsoleActiveTabId === tabId) {
        const msMatch = rowsCount.textContent.match(/\(([^)]+ms)\)/);
        const msStr = msMatch ? ` (${msMatch[1]})` : "";
        
        let colCount = 0;
        if (tab && tab.results && tab.results[tableIndex]) {
            colCount = tab.results[tableIndex].Headers ? tab.results[tableIndex].Headers.length : 0;
        }

        if (tab && tab.results && tab.results.length > 1) {
            rowsCount.innerHTML = `Tabel ${tableIndex + 1}: ${totalRows} baris (${renderedRowsCount} ditampilkan), ${colCount} kolom ditampilkan${msStr}`;
        } else {
            rowsCount.innerHTML = `${totalRows} baris (${renderedRowsCount} ditampilkan), ${colCount} kolom${msStr}`;
        }
        
        // Sync to active tab state
        if (tab) {
            tab.rowsCountText = rowsCount.innerHTML;
        }
    }

    // 2. Update sub-tab button text if multiple tables exist
    const tabResultsCont = document.getElementById('query-results-tab-content-' + tabId);
    if (tabResultsCont) {
        const tabBtn = tabResultsCont.querySelector(`.query-tab-btn[data-tab-idx="${tableIndex}"]`);
        if (tabBtn) {
            let colCount = 0;
            if (tab && tab.results && tab.results[tableIndex]) {
                colCount = tab.results[tableIndex].Headers ? tab.results[tableIndex].Headers.length : 0;
            }
            tabBtn.innerHTML = `<i class="fa-solid fa-table"></i> Hasil ${tableIndex + 1} (${totalRows} baris (${renderedRowsCount} ditampilkan), ${colCount} kolom)`;
        }
    }
}

function initTableResizers(table) {
    if (!table) return;

    // Cap initial column widths and freeze layout in fixed mode to enable ellipsis text-clipping
    const cols = table.querySelectorAll('th');
    
    // Batch read to prevent Layout Thrashing (forced reflow in a loop)
    const widths = Array.from(cols).map(c => c.offsetWidth);
    
    // Batch write
    cols.forEach((c, i) => {
        c.style.width = Math.min(250, Math.max(80, widths[i])) + 'px';
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

function insertScopeIdentity() {
    if (!queryConsoleEditor) return;

    queryConsoleEditor.focus();
    const selection = queryConsoleEditor.getSelection();
    const range = new monaco.Range(
        selection.startLineNumber,
        selection.startColumn,
        selection.endLineNumber,
        selection.endColumn
    );
    const text = "DECLARE @NewID BIGINT = SCOPE_IDENTITY()";
    const op = {
        range: range,
        text: text,
        forceMoveMarkers: true
    };
    queryConsoleEditor.executeEdits("insert-helper", [op]);
}

function insertCurrentDateTime() {
    if (!queryConsoleEditor) return;

    queryConsoleEditor.focus();
    const selection = queryConsoleEditor.getSelection();
    const range = new monaco.Range(
        selection.startLineNumber,
        selection.startColumn,
        selection.endLineNumber,
        selection.endColumn
    );
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateString = `'${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}'`;
    const op = {
        range: range,
        text: dateString,
        forceMoveMarkers: true
    };
    queryConsoleEditor.executeEdits("insert-helper", [op]);
}

// Global listener for copying active results table selection with headers using Ctrl+Shift+C
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return;

        let container = selection.getRangeAt(0).commonAncestorContainer;
        if (container.nodeType === Node.TEXT_NODE) {
            container = container.parentNode;
        }

        const table = container.closest('.query-results-table');
        if (!table) return;

        e.preventDefault();

        const rows = table.querySelectorAll('tbody tr');
        const selectedRows = [];
        rows.forEach(tr => {
            if (selection.containsNode(tr, true)) {
                selectedRows.push(tr);
            }
        });

        if (selectedRows.length === 0) return;

        const selectedColsSet = new Set();
        selectedRows.forEach(tr => {
            const tds = tr.querySelectorAll('td');
            tds.forEach((td, colIdx) => {
                if (colIdx > 0 && selection.containsNode(td, true)) {
                    selectedColsSet.add(colIdx);
                }
            });
        });

        const selectedCols = Array.from(selectedColsSet).sort((a, b) => a - b);
        if (selectedCols.length === 0) return;

        const ths = table.querySelectorAll('thead th');
        const headerRowText = selectedCols.map(colIdx => {
            const th = ths[colIdx];
            return th ? th.textContent.trim() : "";
        }).join("\t");

        const dataRowsText = selectedRows.map(tr => {
            const tds = tr.querySelectorAll('td');
            return selectedCols.map(colIdx => {
                const td = tds[colIdx];
                return td ? td.textContent.trim() : "";
            }).join("\t");
        });

        const finalTsv = [headerRowText, ...dataRowsText].join("\n");

        navigator.clipboard.writeText(finalTsv)
            .then(() => {
                const statusText = document.getElementById('query-status-text');
                if (statusText) {
                    const origText = statusText.innerHTML;
                    const origColor = statusText.style.color;
                    statusText.innerHTML = '<i class="fa-solid fa-circle-check"></i> Baris terpilih berhasil disalin dengan header!';
                    statusText.style.color = 'var(--accent-teal)';
                    setTimeout(() => {
                        statusText.innerHTML = origText;
                        statusText.style.color = origColor;
                    }, 2500);
                }
            })
            .catch(err => {
                console.error("Gagal menyalin dengan header:", err);
            });
    }
});
