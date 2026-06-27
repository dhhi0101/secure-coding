# UsedHub — 중고거래 플랫폼

**배포 URL: https://usedhub.onrender.com**

> 첫 접속 시 30~60초 대기가 발생할 수 있습니다 (Render 무료 플랜 슬립 모드). 잠시 기다리면 정상 동작합니다.

Node.js 기반 중고거래 플랫폼 과제 구현입니다. 회원 관리, 상품 관리, 실시간 채팅, 신고/차단, 유저 간 송금, 상품 검색, 관리자 대시보드를 모두 포함합니다.

---

## 목차

1. [구현 범위](#1-구현-범위)
2. [기술 스택](#2-기술-스택)
3. [요구사항 반영 결과](#3-요구사항-반영-결과)
4. [시스템 설계](#4-시스템-설계)
5. [개발 과정 정리](#5-개발-과정-정리)
6. [체크리스트 및 테스트 항목](#6-체크리스트-및-테스트-항목)
7. [보안 약점 및 보완 포인트](#7-보안-약점-및-보완-포인트)
8. [환경 설정 및 실행 방법 ← 여기서 시작하세요](#8-환경-설정-및-실행-방법)
9. [배포 방법](#9-배포-방법)
10. [주요 파일](#10-주요-파일)

---

## 1. 구현 범위

- 회원가입, 로그인, 사용자 목록/프로필 조회, 마이페이지 수정
- 상품 등록, 상품 목록/상세 조회, 내 상품 관리
- 상품명/설명 검색 + 카테고리·지역·상태·가격 범위·정렬 기반 상세 검색
- 실시간 전체 채팅 (Socket.IO)
- 실시간 1대1 채팅 (Socket.IO)
- 사용자/상품 신고 및 자동 제재 (신고 3회 누적 시 자동 처리)
- 유저 간 송금 및 거래 내역 조회 (DB 트랜잭션)
- 관리자 대시보드 (유저/상품/신고/채팅/송금 통합 관리)
- Docker 기반 컨테이너 배포 설정
- Render 무료 배포 설정

---

## 2. 기술 스택

| 구분 | 내용 |
|------|------|
| Backend | Node.js (v18+), Express |
| Database | SQLite (better-sqlite3) |
| 인증 | express-session, bcryptjs |
| 실시간 통신 | Socket.IO |
| 파일 업로드 | Multer |
| 배포 | Docker, Render |

---

## 3. 요구사항 반영 결과

### 1. 유저 관리

| 요구사항 | 구현 여부 | 설명 |
|----------|-----------|------|
| 로그인 페이지 | ✅ | `/login` |
| 회원가입 페이지 | ✅ | `/register` |
| 사용자 프로필 조회 | ✅ | `/users/:id` |
| 마이페이지 소개글/비밀번호 수정 | ✅ | `/mypage` |
| 아이디 중복 방지 | ✅ | `users.username UNIQUE` 제약 |
| 유저 정보 DB 관리 | ✅ | SQLite `users` 테이블 |

### 2. 상품 관리

| 요구사항 | 구현 여부 | 설명 |
|----------|-----------|------|
| 상품 등록 페이지 | ✅ | `/product/new` |
| 내 상품 확인 및 관리 | ✅ | `/my-products` |
| 상품명·가격·사진 표시 | ✅ | 상세 페이지에서 모두 표시 |
| 등록 상품 누구나 조회 | ✅ | 비로그인도 `/products` 접근 가능 |
| 상품 정보 DB 관리 | ✅ | SQLite `products` 테이블 |
| 목록에서는 이름만, 클릭하면 상세 페이지 | ✅ | 목록: 이름+사진만 표시, 클릭 → `/products/:id` |

### 3. 사용자 소통

| 요구사항 | 구현 여부 | 설명 |
|----------|-----------|------|
| 실시간 채팅 | ✅ | Socket.IO 기반 실시간 동작 |
| 전체 유저 채팅 | ✅ | `/chat` |
| 1대1 채팅 | ✅ | `/chat/direct/:roomId` |

### 4. 악성 유저/상품 필터링

| 요구사항 | 구현 여부 | 설명 |
|----------|-----------|------|
| 불량 상품/사용자 신고 | ✅ | 상품 상세·프로필 페이지에서 신고 버튼 |
| 신고 사유 입력 필수 | ✅ | 사유 없으면 서버 측 차단 |
| 중복 신고 방지 | ✅ | DB UNIQUE 제약으로 동일 사용자 중복 신고 차단 |
| 상품 신고 3회 → 차단 | ✅ | `enforceModeration()` 자동 처리 |
| 유저 신고 3회 → 휴면 전환 | ✅ | `enforceModeration()` 자동 처리 |

### 5. 유저 간 송금

| 요구사항 | 구현 여부 | 설명 |
|----------|-----------|------|
| 회원별 잔액 관리 | ✅ | 가입 시 100,000원 기본 지급 |
| 유저 간 송금 | ✅ | `/wallet` 에서 대상 선택 후 송금 |
| 잔액 부족 시 차단 | ✅ | 서버 측 잔액 검증 |
| 자기 자신 송금 차단 | ✅ | sender === receiver 시 오류 |
| 송금 내역 저장/조회 | ✅ | `transfers` 테이블, 지갑 페이지에서 최근 20건 조회 |
| DB 트랜잭션 처리 | ✅ | `db.transaction()` 사용 |

### 6. 상품 검색

| 요구사항 | 구현 여부 | 설명 |
|----------|-----------|------|
| 상품명 검색 | ✅ | `LIKE` 쿼리 |
| 설명 검색 | ✅ | `LIKE` 쿼리 |
| 카테고리 필터 | ✅ | 선택 메뉴 |
| 지역 필터 | ✅ | 텍스트 입력 |
| 판매 상태 필터 | ✅ | 판매중/예약중/판매완료 |
| 가격 범위 필터 | ✅ | 최소/최대 가격 |
| 정렬 | ✅ | 최신순/가격낮은순/가격높은순/이름순 |

### 7. 관리자 기능

| 요구사항 | 구현 여부 | 설명 |
|----------|-----------|------|
| 플랫폼 전체 요소 관리 | ✅ | `/admin` 통합 대시보드 |
| 전체 통계 대시보드 | ✅ | 사용자 수·휴면 수·상품 수·차단 수·신고 수·메시지 수·송금 수 |
| 사용자 휴면/복구 제어 | ✅ | 토글 버튼 |
| 상품 차단/해제/삭제 | ✅ | 버튼 제공 |
| 신고 내역 조회 | ✅ | 최근 30건 표시 |
| 채팅 로그 조회 | ✅ | 최근 20건 표시 |
| 송금 로그 조회 | ✅ | 최근 20건 표시 |

---

## 4. 시스템 설계

### 페이지 구성

| 경로 | 설명 |
|------|------|
| `/` | 메인 페이지 (최근 상품 + 플랫폼 통계) |
| `/register` | 회원가입 |
| `/login` | 로그인 |
| `/users` | 사용자 목록 |
| `/users/:id` | 사용자 프로필 (1:1 채팅·송금·신고 버튼 포함) |
| `/mypage` | 소개글·표시 이름·비밀번호 수정 |
| `/wallet` | 지갑 — 잔액 확인·송금·내역 조회 |
| `/products` | 상품 목록 + 상세 검색 필터 |
| `/product/new` | 상품 등록 |
| `/my-products` | 내 상품 관리 |
| `/products/:id` | 상품 상세 (판매자 채팅·송금·신고 버튼 포함) |
| `/chat` | 전체 채팅 |
| `/chat/direct/:roomId` | 1대1 채팅 |
| `/admin` | 관리자 통합 관리 페이지 |
| `/health` | 배포 헬스체크 |

### 데이터베이스 설계

#### users
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | INTEGER PK | 사용자 식별자 |
| username | TEXT UNIQUE | 로그인 아이디 (중복 불가) |
| display_name | TEXT | 화면 표시 이름 |
| password_hash | TEXT | bcrypt 해시 비밀번호 |
| bio | TEXT | 소개글 |
| balance | INTEGER | 잔액 (가입 시 100,000원) |
| is_dormant | INTEGER | 휴면 여부 (0/1) |
| is_admin | INTEGER | 관리자 여부 (0/1) |
| created_at | TEXT | 생성 시각 |

#### products
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | INTEGER PK | 상품 식별자 |
| seller_id | INTEGER FK | 판매자 아이디 |
| name | TEXT | 상품명 |
| description | TEXT | 상품 설명 |
| price | INTEGER | 가격 |
| image_path | TEXT | 이미지 경로 |
| category | TEXT | 카테고리 |
| region | TEXT | 지역 |
| status | TEXT | 판매 상태 |
| is_blocked | INTEGER | 차단 여부 (0/1) |
| created_at | TEXT | 생성 시각 |

#### reports
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | INTEGER PK | 신고 식별자 |
| reporter_id | INTEGER FK | 신고자 아이디 |
| target_type | TEXT | 'user' 또는 'product' |
| target_id | INTEGER | 신고 대상 아이디 |
| reason | TEXT | 신고 사유 |
| created_at | TEXT | 신고 시각 |
| UNIQUE | — | (reporter_id, target_type, target_id) 중복 신고 방지 |

#### direct_rooms
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | INTEGER PK | 채팅방 식별자 |
| user_a_id | INTEGER | 참여자 A |
| user_b_id | INTEGER | 참여자 B |
| created_at | TEXT | 생성 시각 |

#### messages
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | INTEGER PK | 메시지 식별자 |
| room_type | TEXT | 'global' 또는 'direct' |
| room_id | INTEGER | direct 채팅방 식별자 |
| sender_id | INTEGER FK | 보낸 사용자 |
| content | TEXT | 메시지 본문 |
| created_at | TEXT | 전송 시각 |

#### transfers
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | INTEGER PK | 송금 식별자 |
| sender_id | INTEGER FK | 보내는 사용자 |
| receiver_id | INTEGER FK | 받는 사용자 |
| amount | INTEGER | 송금 금액 |
| note | TEXT | 메모 |
| created_at | TEXT | 송금 시각 |

### 핵심 로직 설계

#### 신고 누적 정책
- 상품 신고 3회 이상 → 자동 차단 (`is_blocked = 1`)
- 유저 신고 3회 이상 → 자동 휴면 (`is_dormant = 1`)
- 관리자 페이지에서 수동 복구 가능

#### 송금 처리 정책
- 잔액 검증 → DB 트랜잭션으로 차감/증가 동시 처리
- 휴면 계정은 송금 수신 대상에서 제외
- 자기 자신에게 송금 불가

#### 채팅 처리 정책
- 전체 채팅: Socket.IO `global` room 사용
- 1대1 채팅: `direct_rooms` 기준으로 `direct:{roomId}` room 분리
- 세션 사용자 검증 후 메시지 저장 및 전송
- 휴면 계정은 메시지 전송 불가

---

## 5. 개발 과정 정리

### 요구사항 분석
- 1~4번 기본 요구사항 외에 5~7번도 실제 동작하는 형태로 구현 범위를 확대했다.
- 단순 UI 모형이 아니라 실제 DB 연동, 세션 관리, 실시간 통신까지 포함한 완전 동작형 플랫폼을 목표로 했다.

### 시스템 설계
- 빠르게 시연 가능한 구조를 위해 Express + SQLite를 선택했다.
- 별도 DB 서버 없이 파일 기반 SQLite로 배포 환경의 복잡도를 낮췄다.
- 회원·상품·신고·채팅·송금을 독립 테이블로 분리해 관계형 무결성을 유지했다.
- 관리자 대시보드에서 플랫폼 전체 요소를 한 화면에서 확인·제어할 수 있도록 설계했다.

### 구현
- 회원 가입 시 기본 잔액(100,000원) 자동 지급을 구현했다.
- 송금에 잔액 검사와 DB 트랜잭션(`db.transaction()`)을 적용해 원자성을 보장했다.
- 상품 검색은 키워드·카테고리·지역·상태·가격·정렬을 복합 필터로 구현했다.
- 파일 저장 경로(`data/`)를 환경변수로 분리해 Docker 볼륨 마운트를 지원했다.
- Dockerfile에 `better-sqlite3` 네이티브 모듈 빌드에 필요한 Alpine 패키지(`python3 make g++`)를 추가했다.

### 체크리스트 작성 및 테스트 계획
- 회원·상품·신고·채팅·송금·관리자·배포 체크리스트를 작성했다.
- 실제 배포 전에는 브라우저 2개 이상으로 채팅 실시간성, 신고 누적, 관리자 조작 시나리오를 점검해야 한다.

### 유지보수
- 현재는 단일 파일(`src/app.js`) 서버 구조이며, 확장 시 라우터/서비스/저장소 계층 분리가 필요하다.
- SQLite는 과제/소규모 시연에 적합하며, 장기 운영 시 PostgreSQL 같은 서버형 DB가 적절하다.

---

## 6. 체크리스트 및 테스트 항목

### 기능 체크리스트
- [ ] 회원가입 시 중복 아이디가 차단되는가
- [ ] 로그인/로그아웃이 동작하는가
- [ ] 마이페이지에서 소개글/비밀번호 수정이 되는가
- [ ] 상품 등록 후 목록/상세/내 상품에 반영되는가
- [ ] 상품 목록에서 이름만 보이고 클릭 시 상세 페이지로 이동되는가
- [ ] 상세 검색 필터(카테고리·지역·상태·가격·정렬)가 정상 동작하는가
- [ ] 전체 채팅이 두 브라우저에서 실시간 반영되는가
- [ ] 1대1 채팅이 지정 사용자끼리만 동작하는가
- [ ] 송금 시 잔액이 차감되고 상대 잔액이 증가하는가
- [ ] 잔액 부족 시 송금이 차단되는가
- [ ] 동일 사용자의 중복 신고가 차단되는가
- [ ] 상품 신고 3회 후 차단되는가
- [ ] 사용자 신고 3회 후 휴면 전환되는가
- [ ] 관리자 페이지에서 유저/상품 상태 변경이 되는가
- [ ] 관리자 페이지에서 채팅/송금 로그가 조회되는가

### 배포 체크리스트
- [ ] `npm install`이 성공하는가
- [ ] `npm start`로 서버가 기동되는가
- [ ] `/health`가 200 OK를 반환하는가
- [ ] Docker 이미지 빌드가 성공하는가
- [ ] Render 배포 후 업로드·채팅·송금이 정상 동작하는가

### 수동 테스트 시나리오
1. 일반 사용자 2명 이상 가입
2. 사용자 A가 상품 등록 (이미지 포함)
3. 사용자 B가 상품 목록에서 이름만 보이는 것 확인 후 클릭해 상세 페이지 조회
4. 사용자 B가 검색 필터를 사용해 상품 검색
5. 사용자 B가 사용자 A에게 송금
6. 두 사용자 간 1대1 채팅 송수신 확인
7. 전체 채팅 동시 반영 확인
8. 상품 신고 3회 누적 후 자동 차단 확인
9. 사용자 신고 3회 누적 후 자동 휴면 확인
10. 관리자(`admin/admin1234`)로 로그인해 차단 해제, 상품 삭제, 로그 조회 확인

---

## 7. 보안 약점 및 보완 포인트

### 현재 반영한 보안 조치
- 비밀번호 `bcrypt` 해시 저장 (평문 저장 없음)
- 세션 쿠키 `httpOnly`, `sameSite=lax` 설정
- 로그인 없이 접근 불가한 페이지 미들웨어 분리 (`requireAuth`)
- 관리자 전용 경로 별도 미들웨어 (`requireAdmin`)
- 중복 신고 방지 (DB UNIQUE 제약)
- 송금 서버 측 잔액 검증 (클라이언트 우회 불가)
- 1대1 채팅 방 접근 권한 검증 (방 참여자만 입장 가능)
- 휴면 계정 로그인 및 채팅 전송 차단
- XSS 방지를 위한 서버 측 HTML 이스케이프 (`h()` 함수)
- 파일 업로드 MIME 타입 검사 (`image/*`만 허용)
- 파일명 특수문자 제거 (경로 조작 방지)

### 남아 있는 보안 약점

| 약점 | 설명 | 보완 방법 |
|------|------|----------|
| CSRF 토큰 미적용 | POST 요청에 토큰 검증 없음 | `csurf` 미들웨어 적용 |
| 파일 시그니처 검증 없음 | MIME 타입 우회 가능 | `file-type` 라이브러리로 매직 바이트 검사 |
| 로그인 시도 횟수 제한 없음 | 브루트포스 공격 가능 | `express-rate-limit`으로 IP별 제한 |
| 세션 시크릿 기본값 존재 | 환경변수 미설정 시 취약 | 배포 시 반드시 `SESSION_SECRET` 환경변수 설정 |
| 관리자 단일 레벨 | 세분화된 권한 관리 불가 | 역할(Role) 기반 접근 제어(RBAC) 도입 |
| 감사 로그 없음 | 관리자 조작 이력 추적 불가 | 별도 `audit_logs` 테이블 추가 |

---

## 8. 환경 설정 및 실행 방법

> **멘토님께**: 아래 순서대로 따라 하시면 바로 실행할 수 있습니다. Mac OS / Linux(Codex) 모두 동일하게 동작합니다.

---

### 사전 요구사항

- **Node.js 18 ~ 22** (권장: v20 LTS) — v24 이상은 `better-sqlite3` 네이티브 모듈 호환 문제로 권장하지 않음
- **npm** (Node.js 설치 시 함께 설치됨)

Node.js 버전 확인:

```bash
node --version   # v18.x ~ v22.x 이어야 함
npm --version
```

버전이 맞지 않으면 **nvm**으로 교체하세요:

```bash
# nvm 설치 (Mac / Linux)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.zshrc    # Mac (zsh)
# 또는
source ~/.bashrc   # Linux (bash)

# Node.js 20 LTS 설치 및 활성화
nvm install 20
nvm use 20
node --version   # v20.x.x 확인
```

Mac에서 `npm install` 중 빌드 오류가 나면 Xcode Command Line Tools를 먼저 설치하세요:

```bash
xcode-select --install
# 설치 완료 후 다시 npm install
```

---

### Step 1 — 서버 실행 (로컬)

```bash
# 프로젝트 디렉터리로 이동
cd /path/to/readme-md-1-1-2-3-2

# 의존성 설치 (처음 한 번만)
npm install

# 서버 시작
npm start
```

성공 시 출력:

```
UsedHub server started on http://localhost:3000
```

브라우저에서 `http://localhost:3000` 으로 접속하면 됩니다.

---

### Step 2 — 같은 Wi-Fi 핸드폰으로 접속

서버를 켠 PC/Mac과 핸드폰이 **같은 Wi-Fi**에 연결되어 있으면 로컬 IP로 바로 접속할 수 있습니다.

**로컬 IP 확인 방법:**

```bash
# Mac / Linux
ifconfig | grep "inet " | grep -v 127.0.0.1
# 또는
ip addr show | grep "inet " | grep -v 127.0.0.1
```

출력 예시에서 `192.168.x.x` 형태의 주소를 찾습니다.

**핸드폰 브라우저에서:**

```
http://192.168.x.x:3000
```

> 방화벽이 3000번 포트를 차단하고 있으면 접속이 안 될 수 있습니다. Mac의 경우 시스템 설정 → 방화벽 → 수신 연결 허용에서 Node.js를 허용하거나, 방화벽을 임시로 비활성화하세요.

---

### Step 3 — 인터넷 어디서나 접속 가능한 공개 URL 발급 (localtunnel)

같은 Wi-Fi 없이도 **어디서든 핸드폰으로 접속**하려면 `localtunnel`로 공개 URL을 즉시 발급받을 수 있습니다. 계정 불필요, 무료입니다.

**터미널 1: 서버 실행**

```bash
npm start
```

**터미널 2: 터널 개통**

```bash
npm run tunnel
```

출력 예시:

```
your url is: https://brave-wolf-42.loca.lt
```

이 URL을 핸드폰 브라우저에 입력하면 바로 접속됩니다.

> **주의**: 처음 접속 시 localtunnel 경고 페이지가 나올 수 있습니다. 페이지에 표시된 IP를 입력하거나 **"Click to continue"** 버튼을 누르면 넘어갑니다.

> `npm run tunnel` 대신 `npx localtunnel --port 3000`을 써도 동일합니다.

---

### 기본 관리자 계정

서버 최초 실행 시 관리자 계정이 자동으로 생성됩니다.

| 항목 | 값 |
|------|-----|
| 아이디 | `admin` |
| 비밀번호 | `admin1234` |
| 역할 | 관리자 (관리 메뉴 접근 가능) |

---

### 데이터 초기화 방법

테스트 후 처음 상태로 돌아가려면 `data/` 디렉터리를 삭제하고 서버를 재시작하세요:

```bash
rm -rf data/
npm start
```

---

## 9. 배포 방법 — 영구 무료 공개 서버

`localtunnel`은 서버를 끄면 URL이 사라집니다. **항상 켜져 있는 공개 서버**가 필요하다면 아래 두 가지 무료 서비스를 사용하세요.

---

### 방법 A — Render (권장, 완전 무료)

GitHub 저장소만 있으면 계정 생성 → 배포까지 10분 안에 완료됩니다.

**1단계: GitHub에 코드 올리기**

```bash
# 프로젝트 루트에서
git init
git add .
git commit -m "UsedHub: used goods platform"
# GitHub에서 새 저장소(public or private) 생성 후
git remote add origin https://github.com/<내-아이디>/<저장소명>.git
git push -u origin main
```

**2단계: Render 가입 및 연결**

1. [render.com](https://render.com) 접속 → GitHub 계정으로 가입
2. Dashboard → **New +** → **Blueprint**
3. GitHub 저장소 선택 후 **Connect**
4. 프로젝트 루트의 `render.yaml`이 자동으로 인식되어 서비스가 생성됩니다
5. **Environment** 탭 → `SESSION_SECRET` 값으로 임의의 긴 문자열 입력 (예: `openssl rand -hex 32` 출력값)
6. **Manual Deploy** → **Deploy latest commit** 클릭

**3단계: 공개 URL 확인**

빌드 완료 후 대시보드에서 `https://usedhub.onrender.com` 형태의 공개 URL이 표시됩니다. 이 URL로 핸드폰을 포함한 **어느 기기, 어느 네트워크**에서도 접속 가능합니다.

```
https://usedhub.onrender.com        ← 브라우저/핸드폰에서 접속
https://usedhub.onrender.com/health ← 200 OK 이면 정상 동작 중
```

> **무료 플랜 특성**: 15분간 요청이 없으면 슬립 상태로 전환됩니다. 다음 접속 시 약 30~60초 대기 후 깨어납니다. 데이터(DB, 업로드 이미지)는 영구 디스크에 보존됩니다.

---

### 방법 B — Railway (대안)

Render 가입이 어렵거나 속도가 필요할 때 사용하세요. 매월 $5 크레딧 무료 제공.

**빠른 배포:**

1. [railway.app](https://railway.app) → GitHub 계정으로 가입
2. **New Project** → **Deploy from GitHub repo** → 저장소 선택
3. **Variables** 탭 → `SESSION_SECRET` 추가
4. `PORT` 환경변수는 Railway가 자동으로 주입하므로 별도 설정 불필요
5. 배포 완료 후 **Settings** → **Domains** → **Generate Domain** 으로 공개 URL 발급

> Railway는 영구 디스크가 기본 포함되어 있어 DB와 업로드 파일이 유지됩니다.

---

### Docker로 로컬 배포 (참고)

```bash
# 이미지 빌드
docker build -t usedhub .

# 컨테이너 실행 (데이터 영구 보존)
docker run -p 3000:3000 \
  -e SESSION_SECRET=my-very-long-secret-key \
  -v $(pwd)/data:/app/data \
  usedhub
```

접속: `http://localhost:3000`

---

## 10. 주요 파일

```
readme-md-1-1-2-3-2/
├── src/
│   ├── app.js          # 전체 서버 로직 (라우터, DB, Socket.IO)
│   └── public/
│       └── style.css   # UI 스타일
├── data/               # 실행 시 자동 생성
│   ├── market.db       # SQLite 데이터베이스
│   └── uploads/        # 업로드 이미지 저장 폴더
├── Dockerfile          # Docker 배포 설정
├── render.yaml         # Render 배포 Blueprint
├── package.json        # npm 의존성 및 스크립트
└── README.md           # 이 파일
```

---

## 11. 현재 제약

- 외부 배포 서비스 계정과 네트워크 권한이 없는 로컬 환경에서는 공개 URL 발급까지 자동으로 수행할 수 없다. Render 또는 Railway 계정으로 직접 연결해야 한다.
- SQLite는 단일 파일 DB로 동시 쓰기 부하가 높을 경우 병목이 발생할 수 있다. WAL 모드를 활성화해 완화했으나, 대규모 트래픽 환경에서는 PostgreSQL로 전환을 권장한다.
