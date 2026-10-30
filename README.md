# Win Remote — 웹 브라우저 원격 데스크톱

브라우저에서 접속 정보(IP, 계정, 비밀번호)만 입력하면 Windows PC에 원격 데스크톱으로 접속하는 웹 서비스입니다.

- **원격 대상 PC에 아무것도 설치하지 않습니다.** Windows에 기본 내장된 원격 데스크톱(RDP, 3389 포트)을 그대로 사용합니다.
- **접속하는 쪽도 설치가 필요 없습니다.** Windows / macOS / Linux / 태블릿 / 휴대폰 어디서든 최신 브라우저만 있으면 됩니다.

## 동작 구조

```
[브라우저] ──WebSocket──> [이 웹 서버 (Node.js)] ──> [guacd] ──RDP(3389)──> [원격 Windows PC]
 화면 표시/키보드/마우스      접속 토큰 암호화·중계       RDP 프로토콜 처리        (기본 원격 데스크톱)
```

- `guacd` : Apache Guacamole의 프록시 데몬. RDP 프로토콜을 처리해 화면을 웹용으로 변환합니다 (Docker 이미지 사용).
- `server.js` : 접속 폼을 제공하고, 입력된 접속 정보를 AES-256으로 암호화한 일회성 토큰으로 만들어 guacd로 중계합니다. 비밀번호는 브라우저에 다시 노출되거나 서버에 저장되지 않습니다.
- `public/` : 접속 화면과 원격 화면 UI (guacamole-common-js 사용).

## 실행 방법

### Docker Compose (권장)

```bash
SECRET_KEY="$(openssl rand -hex 32)" ACCESS_PASSWORD="원하는비밀번호" docker compose up -d --build
```

브라우저에서 `http://서버주소:8080` 접속.

### 직접 실행 (개발용)

```bash
docker run -d --name guacd -p 4822:4822 guacamole/guacd:1.5.5
npm install
npm start          # http://localhost:8080
```

### 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8080` | 웹 서버 포트 |
| `GUACD_HOST` / `GUACD_PORT` | `127.0.0.1` / `4822` | guacd 주소 |
| `SECRET_KEY` | (실행마다 랜덤) | 접속 토큰 암호화 키 |
| `ACCESS_PASSWORD` | (없음) | 이 서비스 자체의 접근 비밀번호. **인터넷에 공개 시 반드시 설정** |
| `ALLOWED_HOSTS` | (제한 없음) | 접속 허용 호스트 목록. 예: `192.168.0.*,office-pc.local` |
| `TOKEN_TTL` | `60` | 접속 토큰 유효 시간(초) |
| `LOG_LEVEL` | `NORMAL` | `QUIET`, `ERRORS`, `NORMAL`, `VERBOSE`, `DEBUG` |

## 원격 대상 Windows PC 준비 (설치 없음, 설정만)

1. **원격 데스크톱 켜기** : 설정 → 시스템 → 원격 데스크톱 → 켬
   - Windows **Pro / Enterprise / Education / Server** 에디션이 필요합니다. (Home 에디션은 RDP 서버 기능이 없음)
2. **방화벽** : 원격 데스크톱을 켜면 3389 포트가 자동 허용됩니다.
3. **네트워크 경로** : 이 웹 서버(guacd)가 대상 PC의 3389 포트에 접근할 수 있어야 합니다.
   - 같은 사내망/LAN이면 바로 사용 가능
   - 외부에서 접속하려면 웹 서버를 같은 네트워크에 두거나, 공유기 포트포워딩 / VPN을 사용하세요.
4. 비밀번호가 없는 계정은 RDP 로그인이 되지 않습니다.

## 기능

- 접속 정보 입력 후 바로 연결 (주소, 포트, 계정, 도메인, 보안 모드 NLA/TLS/RDP)
- 브라우저 창 크기에 맞춰 원격 해상도 자동 조정
- 키보드 / 마우스 / 터치(모바일) 입력, 원격 커서 표시
- 툴바: `Ctrl+Alt+Del`, `Win` 키, `한/영` 전환(오른쪽 Alt 전송), 클립보드 주고받기, 전체화면, 연결 끊기
- 원격 PC 소리 재생
- 접속 정보 기억 (비밀번호 제외, 브라우저 로컬 저장)
- 연결 실패 시 원인 안내 (로그인 실패, 호스트 연결 불가 등)

## 보안 주의사항

- 이 서버는 사용자가 입력한 주소로 RDP 연결을 만들어 줍니다. 인터넷에 공개한다면 `ACCESS_PASSWORD` 와 `ALLOWED_HOSTS` 를 설정해서 아무나 내부망 PC에 접속을 시도하지 못하게 하세요.
- 운영 환경에서는 Nginx/Caddy 등으로 **HTTPS** 를 적용하세요 (비밀번호가 평문 HTTP로 전송되지 않도록). WebSocket 경로 `/ws` 도 함께 프록시해야 합니다.

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1d;
}
```

## 알려진 제한

- `한/영` 키는 브라우저가 가로채므로 툴바 버튼(오른쪽 Alt 전송)을 사용하세요. 원격 PC 한국어 입력기의 한/영 키가 오른쪽 Alt로 설정되어 있어야 합니다 (한국어 Windows 기본값).
- 파일 전송, 프린터 공유는 아직 지원하지 않습니다.
