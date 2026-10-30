'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const GuacamoleLite = require('guacamole-lite');

const PORT = parseInt(process.env.PORT || '8080', 10);
const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = parseInt(process.env.GUACD_PORT || '4822', 10);
// 서비스 자체 접근 비밀번호 (비워두면 누구나 접속 폼 사용 가능)
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
// 접속 허용 대상 (쉼표 구분, 비우면 전부 허용). 예: "192.168.0.10,office-pc.local,10.0.0.*"
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// 발급된 토큰의 유효 시간 (초)
const TOKEN_TTL = parseInt(process.env.TOKEN_TTL || '60', 10);

// AES-256-CBC 키는 정확히 32바이트여야 함. 지정하지 않으면 실행 시마다 랜덤 생성.
const SECRET_KEY = process.env.SECRET_KEY
    ? crypto.createHash('sha256').update(process.env.SECRET_KEY).digest()
    : crypto.randomBytes(32);

const CIPHER = 'AES-256-CBC';

const SECURITY_MODES = ['any', 'nla', 'tls', 'rdp', 'vmconnect'];
const KEYBOARD_LAYOUTS = [
    'en-us-qwerty', 'ja-jp-qwerty', 'en-gb-qwerty', 'de-de-qwertz', 'fr-fr-azerty', 'failsafe',
];

/**
 * guacamole-lite 형식의 토큰을 생성한다.
 * guacamole-lite는 복호화 결과를 ASCII로 읽기 때문에, 한글 등 비ASCII 문자는
 * JSON \uXXXX 이스케이프로 변환해서 깨지지 않게 한다.
 */
function encryptToken(payload) {
    const json = JSON.stringify(payload).replace(/[\u0080-￿]/g,
        (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(CIPHER, SECRET_KEY, iv);
    const value = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    return Buffer.from(JSON.stringify({
        iv: iv.toString('base64'),
        value: value.toString('base64'),
    })).toString('base64');
}

function hostAllowed(host) {
    if (ALLOWED_HOSTS.length === 0) return true;
    const h = host.toLowerCase();
    return ALLOWED_HOSTS.some((pattern) => {
        if (pattern === '*') return true;
        if (pattern.endsWith('*')) return h.startsWith(pattern.slice(0, -1));
        return h === pattern;
    });
}

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

// guacamole-common-js 의 CJS 번들을 감싸서 브라우저 전역(window.Guacamole) 스크립트로 제공
const guacClientJs = '(function (module) {\n'
    + fs.readFileSync(path.join(
        path.dirname(require.resolve('guacamole-common-js')), 'guacamole-common.min.js'), 'utf8')
    + '\nwindow.Guacamole = module.exports;\n})({ exports: {} });\n';

app.get('/vendor/guacamole-common.js', (req, res) => {
    res.type('application/javascript').send(guacClientJs);
});

app.get('/api/config', (req, res) => {
    res.json({
        requiresAccessPassword: Boolean(ACCESS_PASSWORD),
        restrictedHosts: ALLOWED_HOSTS.length > 0,
        keyboardLayouts: KEYBOARD_LAYOUTS,
        securityModes: SECURITY_MODES,
    });
});

app.post('/api/connect', (req, res) => {
    const b = req.body || {};

    if (ACCESS_PASSWORD && !safeEqual(b.accessPassword || '', ACCESS_PASSWORD)) {
        return res.status(401).json({ error: '서비스 접근 비밀번호가 올바르지 않습니다.' });
    }

    const hostname = String(b.hostname || '').trim();
    if (!/^[A-Za-z0-9.\-:_\[\]]{1,253}$/.test(hostname)) {
        return res.status(400).json({ error: '호스트 주소가 올바르지 않습니다.' });
    }
    if (!hostAllowed(hostname)) {
        return res.status(403).json({ error: '이 서버에서 접속이 허용되지 않은 호스트입니다.' });
    }

    const security = SECURITY_MODES.includes(b.security) ? b.security : 'any';
    const layout = KEYBOARD_LAYOUTS.includes(b.keyboardLayout) ? b.keyboardLayout : 'en-us-qwerty';

    const settings = {
        hostname: hostname.replace(/^\[|\]$/g, ''),
        port: String(clampInt(b.port, 1, 65535, 3389)),
        username: String(b.username || '').slice(0, 256),
        password: String(b.password || '').slice(0, 512),
        domain: String(b.domain || '').slice(0, 256),
        security,
        'ignore-cert': b.ignoreCert !== false,
        'server-layout': layout,
        'resize-method': 'display-update',
        'enable-wallpaper': Boolean(b.enableWallpaper),
        'enable-font-smoothing': true,
        'enable-audio-input': false,
        'disable-audio': !b.enableAudio,
        'color-depth': clampInt(b.colorDepth, 8, 32, 24),
    };

    const token = encryptToken({
        connection: { type: 'rdp', settings },
        expires: Date.now() + TOKEN_TTL * 1000,
    });

    res.json({ token });
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const server = http.createServer(app);

const guacServer = new GuacamoleLite(
    { server, path: '/ws' },
    { host: GUACD_HOST, port: GUACD_PORT },
    {
        crypt: { cypher: CIPHER, key: SECRET_KEY },
        // 클라이언트가 쿼리스트링으로 덮어쓸 수 있는 값은 화면 크기 관련만 허용
        allowedUnencryptedConnectionSettings: {
            rdp: ['width', 'height', 'dpi', 'audio', 'video', 'image', 'timezone'],
        },
        maxInactivityTime: 20000,
        log: { level: process.env.LOG_LEVEL || 'NORMAL' },
    },
    {
        processConnectionSettings(settings, callback) {
            if (!settings.expires || Date.now() > settings.expires) {
                return callback(new Error('토큰이 만료되었습니다. 다시 접속하세요.'));
            }
            callback(null, settings);
        },
    },
);

guacServer.on('error', (conn, err) => {
    console.error('[guac] error:', err && err.message);
});

server.listen(PORT, () => {
    console.log(`Web RDP listening on http://0.0.0.0:${PORT} (guacd ${GUACD_HOST}:${GUACD_PORT})`);
    if (!process.env.SECRET_KEY) console.log('SECRET_KEY 미설정: 임시 키를 사용합니다.');
    if (!ACCESS_PASSWORD) console.log('경고: ACCESS_PASSWORD 미설정 - 누구나 이 서버를 통해 RDP 접속을 시도할 수 있습니다.');
});
