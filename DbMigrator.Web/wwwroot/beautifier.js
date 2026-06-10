/* ============================================================================
   SQL / JSON / XML BEAUTIFIER LOGIC - beautifier.js
   ============================================================================ */

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
