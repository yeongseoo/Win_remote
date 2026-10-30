/* global Guacamole */
(function () {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const loginView = $('#login-view');
    const sessionView = $('#session-view');
    const form = $('#login-form');
    const loginError = $('#login-error');
    const connectBtn = $('#connect-btn');
    const statusEl = $('#status');
    const wrap = $('#display-wrap');
    const clipboardDialog = $('#clipboard-dialog');
    const clipboardText = $('#clipboard-text');

    const STORAGE_KEY = 'webrdp.connection';
    const REMEMBERED_FIELDS = ['hostname', 'port', 'username', 'domain', 'security',
        'colorDepth', 'keyboardLayout', 'ignoreCert', 'enableAudio', 'enableWallpaper'];

    const KEY = {
        CTRL: 0xFFE3, ALT: 0xFFE9, ALT_R: 0xFFEA, DELETE: 0xFFFF, SUPER: 0xFFEB,
    };

    // Guacamole 상태 코드 → 사용자 메시지
    const ERROR_MESSAGES = {
        0x0200: '원격 PC 연결 중 서버 오류가 발생했습니다.',
        0x0201: '원격 PC가 응답하지 않습니다.',
        0x0202: '원격 PC 연결 시간이 초과되었습니다.',
        0x0203: '원격 PC에서 오류가 발생했습니다.',
        0x0204: '원격 PC를 찾을 수 없습니다. 주소/포트와 원격 데스크톱 활성화 여부를 확인하세요.',
        0x0205: '원격 PC가 사용 중입니다 (다른 사용자가 접속 중일 수 있음).',
        0x0206: '원격 PC가 연결을 종료했습니다.',
        0x0207: '원격 PC에 연결할 수 없습니다. 주소/포트, 방화벽, 원격 데스크톱 활성화 여부를 확인하세요.',
        0x0208: '원격 PC가 연결을 거부했습니다.',
        0x0209: '다른 세션과 충돌하여 연결이 끊어졌습니다.',
        0x020D: '세션이 다른 곳에서 열려 연결이 종료되었습니다.',
        0x0301: '로그인 실패: 사용자 이름 또는 비밀번호가 올바르지 않습니다.',
        0x0303: '접근이 거부되었습니다.',
        0x0308: '세션 시간이 초과되었습니다.',
        0x031D: '너무 많은 연결이 시도되었습니다.',
    };

    // 모바일 화상 키보드 입력을 받기 위한 숨은 입력창 (Guacamole.Keyboard 가 document 에서 이벤트를 받음)
    const inputSink = new Guacamole.InputSink();
    document.body.appendChild(inputSink.getElement());

    let client = null;
    let keyboard = null;
    let resizeTimer = null;
    let config = { requiresAccessPassword: false };

    // ---------------- 저장된 접속 정보 ----------------

    function loadRemembered() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (!saved) return;
            REMEMBERED_FIELDS.forEach((name) => {
                const el = form.elements[name];
                if (!el || !(name in saved)) return;
                if (el.type === 'checkbox') el.checked = Boolean(saved[name]);
                else el.value = saved[name];
            });
            form.elements.remember.checked = true;
        } catch (e) { /* 저장소 사용 불가 */ }
    }

    function saveRemembered(data) {
        try {
            if (!form.elements.remember.checked) {
                localStorage.removeItem(STORAGE_KEY);
                return;
            }
            const toSave = {};
            REMEMBERED_FIELDS.forEach((name) => { toSave[name] = data[name]; });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
        } catch (e) { /* 저장소 사용 불가 */ }
    }

    function readForm() {
        const f = form.elements;
        return {
            hostname: f.hostname.value.trim(),
            port: f.port.value,
            username: f.username.value,
            password: f.password.value,
            domain: f.domain.value,
            security: f.security.value,
            colorDepth: f.colorDepth.value,
            keyboardLayout: f.keyboardLayout.value,
            ignoreCert: f.ignoreCert.checked,
            enableAudio: f.enableAudio.checked,
            enableWallpaper: f.enableWallpaper.checked,
            accessPassword: f.accessPassword.value,
        };
    }

    // ---------------- 연결 ----------------

    async function requestToken(data) {
        const res = await fetch('api/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `서버 오류 (${res.status})`);
        return body.token;
    }

    // 휴대폰처럼 작은 화면에서는 Windows 화면이 너무 좁아지지 않도록
    // 화면 비율은 유지하면서 가로 1024px 이상으로 요청하고 축소해서 보여준다.
    function displaySize() {
        const w = Math.max(1, wrap.clientWidth);
        const h = Math.max(1, wrap.clientHeight);
        const factor = Math.max(1, 1024 / w);
        return {
            width: Math.floor(w * factor),
            height: Math.max(480, Math.min(2048, Math.floor(h * factor))),
        };
    }

    function rescale() {
        if (!client) return;
        const display = client.getDisplay();
        const dw = display.getWidth();
        const dh = display.getHeight();
        if (!dw || !dh) return;
        display.scale(Math.min(wrap.clientWidth / dw, wrap.clientHeight / dh));
    }

    function startSession(token, hostname) {
        loginView.classList.add('hidden');
        sessionView.classList.remove('hidden');
        setStatus(`${hostname} 연결 중…`);

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const basePath = location.pathname.replace(/[^/]*$/, '');
        const tunnel = new Guacamole.WebSocketTunnel(`${proto}//${location.host}${basePath}ws`);
        client = new Guacamole.Client(tunnel);

        const display = client.getDisplay();
        const displayEl = display.getElement();
        wrap.innerHTML = '';
        wrap.appendChild(displayEl);

        // 원격 커서를 브라우저 커서로 사용 (지연 없는 커서)
        display.showCursor(false);
        display.oncursor = (canvas, x, y) => {
            displayEl.style.cursor = `url(${canvas.toDataURL('image/png')}) ${x} ${y}, auto`;
        };
        display.onresize = rescale;

        let lastError = null;

        client.onstatechange = (state) => {
            switch (state) {
                case 1: setStatus(`${hostname} 연결 중…`); break;
                case 2: setStatus(`${hostname} 응답 대기 중…`); break;
                case 3:
                    setStatus(`${hostname} 연결됨`);
                    wrap.focus();
                    break;
                case 5: endSession(lastError); break;
                default: break;
            }
        };

        client.onerror = (status) => {
            lastError = ERROR_MESSAGES[status.code] || status.message || '연결 오류가 발생했습니다.';
        };
        tunnel.onerror = (status) => {
            lastError = lastError || ERROR_MESSAGES[status.code] || '서버와의 연결이 끊어졌습니다.';
        };

        // 원격 → 브라우저 클립보드
        client.onclipboard = (stream, mimetype) => {
            if (!/^text\//.test(mimetype)) return;
            const reader = new Guacamole.StringReader(stream);
            let text = '';
            reader.ontext = (chunk) => { text += chunk; };
            reader.onend = () => {
                clipboardText.value = text;
                if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(text).catch(() => {});
                }
            };
        };

        // 마우스 / 터치
        const sendMouse = (e) => client.sendMouseState(e.state, true);
        const mouse = new Guacamole.Mouse(displayEl);
        mouse.onEach(['mousedown', 'mousemove', 'mouseup'], sendMouse);
        const touch = new Guacamole.Mouse.Touchscreen(displayEl);
        touch.onEach(['mousedown', 'mousemove', 'mouseup'], sendMouse);

        // 키보드
        keyboard = new Guacamole.Keyboard(document);
        keyboard.onkeydown = (keysym) => {
            if (clipboardDialog.open) return true;
            client.sendKeyEvent(1, keysym);
            return false;
        };
        keyboard.onkeyup = (keysym) => {
            if (clipboardDialog.open) return;
            client.sendKeyEvent(0, keysym);
        };

        const size = displaySize();
        const params = new URLSearchParams({
            token,
            width: String(size.width),
            height: String(size.height),
            dpi: '96',
        });
        client.connect(params.toString());
    }

    function endSession(errorMessage) {
        if (keyboard) {
            keyboard.onkeydown = null;
            keyboard.onkeyup = null;
            keyboard.reset();
            keyboard = null;
        }
        if (client) {
            const c = client;
            client = null;
            c.onstatechange = null;
            try { c.disconnect(); } catch (e) { /* 이미 끊김 */ }
        }
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        wrap.innerHTML = '';
        sessionView.classList.add('hidden');
        loginView.classList.remove('hidden');
        loginError.textContent = errorMessage || '';
        connectBtn.disabled = false;
        form.elements.password.focus();
    }

    function setStatus(text) {
        statusEl.textContent = text;
    }

    function sendKeys(keysyms) {
        if (!client) return;
        keysyms.forEach((k) => client.sendKeyEvent(1, k));
        keysyms.slice().reverse().forEach((k) => client.sendKeyEvent(0, k));
        wrap.focus();
    }

    // ---------------- 이벤트 ----------------

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.textContent = '';
        const data = readForm();
        if (!data.hostname) {
            loginError.textContent = '호스트 주소를 입력하세요.';
            return;
        }
        connectBtn.disabled = true;
        try {
            const token = await requestToken(data);
            saveRemembered(data);
            startSession(token, data.hostname);
        } catch (err) {
            loginError.textContent = err.message;
            connectBtn.disabled = false;
        }
    });

    $('#toolbar').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn || !client) return;
        switch (btn.dataset.action) {
            // 모바일 브라우저는 탭 이벤트 안에서 바로 focus 해야 화상 키보드를 띄워줌
            case 'keyboard': inputSink.getElement().focus(); return;
            case 'cad': sendKeys([KEY.CTRL, KEY.ALT, KEY.DELETE]); break;
            case 'winkey': sendKeys([KEY.SUPER]); break;
            case 'hangul': sendKeys([KEY.ALT_R]); break;
            case 'fullscreen':
                if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
                else await sessionView.requestFullscreen().catch(() => {});
                wrap.focus();
                break;
            case 'clipboard':
                if (navigator.clipboard && window.isSecureContext) {
                    try { clipboardText.value = await navigator.clipboard.readText(); } catch (err) { /* 권한 없음 */ }
                }
                clipboardDialog.showModal();
                clipboardText.focus();
                break;
            case 'disconnect': endSession(''); break;
            default: break;
        }
    });

    clipboardDialog.addEventListener('close', () => {
        if (clipboardDialog.returnValue === 'send' && client) {
            const stream = client.createClipboardStream('text/plain');
            const writer = new Guacamole.StringWriter(stream);
            writer.sendText(clipboardText.value);
            writer.sendEnd();
        }
        if (keyboard) keyboard.reset();
        wrap.focus();
    });

    window.addEventListener('resize', () => {
        rescale();
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (!client) return;
            const size = displaySize();
            client.sendSize(size.width, size.height);
        }, 400);
    });

    // 창이 포커스를 잃으면 눌린 키 상태 초기화 (Alt+Tab 등으로 키가 눌린 채 남는 문제 방지)
    window.addEventListener('blur', () => { if (keyboard) keyboard.reset(); });

    window.addEventListener('beforeunload', () => {
        if (client) client.disconnect();
    });

    // ---------------- 초기화 ----------------

    fetch('api/config')
        .then((r) => r.json())
        .then((c) => {
            config = c;
            if (config.requiresAccessPassword) {
                $('#access-password-field').classList.remove('hidden');
            }
        })
        .catch(() => {});

    loadRemembered();
})();
