# 광주과학고등학교 분실물 보관함

광주과학고 학생을 위한 베타테스트 웹 앱입니다. React·TypeScript·Vite 프런트엔드와 Express·SQLite 로컬 서버, Cloudflare Workers·D1·R2 공개 데모를 지원합니다.

## 로컬 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:5173`을 엽니다. 개발 서버는 기본적으로 이 컴퓨터에서만 접속할 수 있도록 API 서버를 `127.0.0.1:3001`에 바인딩합니다. 종료하려면 실행 중인 터미널에서 `Ctrl+C`를 누릅니다.

프로덕션 빌드와 타입 검사는 다음 명령으로 확인하고, 빌드된 앱은 같은 컴퓨터의 `http://localhost:3001`에서 실행합니다.

```bash
npm run build
npm start
```

Cloudflare Worker를 로컬에서 테스트하려면 로컬 D1 마이그레이션을 적용한 뒤 실행합니다.

```bash
npx wrangler d1 migrations apply lostnfound --local
npm run dev:cloudflare
```

## 무료 Cloudflare 공개 데모

Cloudflare Workers가 프런트엔드와 API를 같은 HTTPS 주소로 제공합니다. 게시글·댓글은 D1에, 사진은 R2에 저장합니다. 새 Cloudflare 데이터베이스는 비어 있는 상태로 시작하며 로컬 `.data/`의 게시글과 사진은 자동 이전되지 않습니다.

1. Cloudflare 계정 이메일을 인증하고 대시보드에서 R2를 활성화한 뒤 Wrangler에 로그인합니다. Workers 배포 및 R2 저장소 생성은 계정 이메일 인증과 R2 최초 활성화가 필요합니다.

   ```bash
   npx wrangler login
   ```

2. Cloudflare에서 데이터베이스와 사진 저장소를 만듭니다.

   ```bash
   npx wrangler d1 create lostnfound
   npx wrangler r2 bucket create lostnfound-uploads
   ```

   D1 생성 결과의 `database_id`를 `wrangler.jsonc`의 `REPLACE_WITH_D1_DATABASE_ID` 자리에 설정합니다.

3. 관리자 최초 설정 토큰, 세션 서명 키, 관리자 아이디 암호화 키를 각각 생성하여 Wrangler Secret으로 등록합니다. 비밀값은 소스 코드나 GitHub에 저장하지 마세요.

   ```bash
   openssl rand -hex 24
   npx wrangler secret put ADMIN_SETUP_TOKEN
   openssl rand -hex 32
   npx wrangler secret put SESSION_SECRET
   openssl rand -hex 32
   npx wrangler secret put ADMIN_ENCRYPTION_KEY
   ```

   각 `secret put` 입력창에 바로 위에서 생성한 값을 입력합니다. `ADMIN_ENCRYPTION_KEY`는 반드시 64자리 16진수여야 합니다. 키를 분실하면 관리자 계정 복구가 필요합니다.

4. 데이터베이스 스키마를 적용하고 앱을 배포합니다.

   ```bash
   npm run deploy:cloudflare
   ```

5. 배포된 `https://<worker-name>.<account>.workers.dev` 주소의 관리자 화면에서 방금 등록한 `ADMIN_SETUP_TOKEN`으로 계정을 만듭니다. 첫 로그인 후에는 관리자 비밀번호를 16자 이상으로 변경해야 관리자 기능을 사용할 수 있습니다.

Cloudflare 무료 플랜 한도는 계정 및 서비스 정책에 따라 바뀔 수 있습니다. 공개 URL을 아는 누구나 앱과 사진을 볼 수 있으므로 개인 식별 정보나 공개해서는 안 되는 정보를 올리지 마세요. 무료 한도 초과 시 요청이 제한될 수 있습니다.

Cloudflare Worker는 현재 이미지 확장자·MIME 유형·파일 시그니처·크기 검증은 유지하지만, 기존 로컬 NSFWJS/TensorFlow 이미지 분류 검열은 실행하지 않습니다. 따라서 Cloudflare 공개 데모의 사진에는 자동 성적 콘텐츠 검열이 적용되지 않습니다. 이 차이를 고려해 테스트용 사진만 등록하고, 자동 사진 검열이 필수라면 별도 검열 서비스를 연결하기 전까지 사진 업로드를 공개적으로 허용하지 마세요.

### 다른 컴퓨터에서 임시로 접속하기

Cloudflare Quick Tunnel을 사용하면 공유기 포트를 열지 않고 임시 HTTPS 주소를 만들 수 있습니다. 이 주소를 아는 누구나 접속하고 게시글을 볼 수 있으므로, **관리자 비밀번호를 먼저 관리자 화면에서 강력한 비밀번호로 변경하고, 공개해도 되는 테스트 데이터만 올린 뒤** 실행하세요.

1. 빌드된 로컬 서버를 실행합니다.

   ```bash
   npm run build
   npm start
   ```

2. 다른 터미널에서 Quick Tunnel을 시작합니다.

   ```bash
   npm run tunnel:quick
   ```

3. 터미널에 표시되는 `https://....trycloudflare.com` 주소를 공유합니다.

Quick Tunnel 주소는 임시 주소라 다시 시작하면 바뀔 수 있습니다. 이 컴퓨터가 켜져 있고 두 터미널이 실행 중이어야 접속됩니다. Quick Tunnel은 베타 테스트용 임시 공유이며, 안정적인 학교 서비스 주소나 상시 가동을 보장하지 않습니다. 앱은 `127.0.0.1`에만 바인딩된 상태로 터널을 사용하며, 서버 포트를 공유기에 직접 개방하지 마세요. 안전을 위해 `npm run tunnel:quick`은 관리자 비밀번호를 16자 이상으로 변경하지 않으면 실행되지 않습니다.

## 저장 데이터와 관리자

- 게시글, 댓글, 비밀번호 해시, 관리자 계정, 금지어는 `.data/lostfound.sqlite`에 저장합니다.
- 사진 파일은 `.data/uploads/`에 저장합니다. 데이터 백업 시 SQLite 파일뿐 아니라 이 폴더도 함께 백업해야 합니다.
- 게시글과 댓글 비밀번호는 scrypt로 해시 저장합니다. 댓글은 댓글 비밀번호로 삭제하고 게시글 수정·삭제·상태 변경·끌어올리기는 게시글 비밀번호를 확인합니다. 댓글에는 대댓글을 달 수 있고, 분실물 게시글 댓글에는 JPG, PNG, WebP 사진을 최대 3장(장당 5MB 이하) 첨부할 수 있습니다.
- 관리자 아이디는 AES-256-GCM으로 암호화하고, 관리자 비밀번호는 scrypt 해시로 저장합니다. 관리자 아이디 암호화 키와 로그인 세션 서명 키는 `.data/` 안의 별도 권한 제한 파일에 저장되므로 `.data/` 전체를 안전하게 백업해야 합니다.
- 사진은 JPG, PNG, WebP 형식만 허용하고 장당 최대 5MB, 게시글·댓글당 최대 3장입니다. 분실물 댓글에 사진을 첨부할 수 있습니다.
- 끌어올리기는 서버 시간을 기준으로 24시간에 한 번만 허용합니다.
- 관리자 화면은 최초 실행 시 서버 터미널에 출력되는 일회용 설정 토큰으로 계정을 만듭니다. 관리자 비밀번호는 12자 이상이어야 합니다. 로그인 후 관리자 화면에서 비밀번호를 변경할 수 있습니다.
- 관리자 화면에서 게시글 상태 변경·삭제와 비공개 금지어 추가·삭제를 할 수 있습니다. 기본 욕설 필터와 관리자 추가 금지어는 게시글, 수정, 댓글의 이름·특징·닉네임에 서버에서 적용합니다.
- 지정된 기본 관리자 비밀번호는 로컬 테스트용으로만 사용하세요. Cloudflare Tunnel을 시작하기 전에 관리자 화면에서 반드시 추측하기 어려운 16자 이상의 비밀번호로 변경하세요. 변경 전에는 관리자 관리 API도 잠겨 있습니다.

`.data/`에는 개인정보와 업로드 파일이 포함되므로 저장소에 올리거나 공개하지 마세요. 이 디렉터리는 `.gitignore`에 포함되어 있습니다.

## 현재 범위

- 습득물·분실물 목록, 검색, 상태 필터, 정렬, 상세 보기, 작성, 댓글, 사용자 비밀번호 기반 관리, 관리자 기능이 동작합니다.
- 로컬 Express 서버는 NSFWJS/TensorFlow.js 모델로 사진을 분류해 성적 콘텐츠 가능성이 높은 이미지를 차단합니다. 모델 로드에 실패하면 사진 업로드가 거부됩니다.
- Cloudflare Worker에서는 Web Crypto API 기반 비밀번호 해시와 관리자 세션을 사용합니다. 로컬 SQLite의 scrypt 비밀번호 해시는 Cloudflare D1로 자동 이전되지 않습니다.
- 학교 서버 배포 전에 정기 백업·복구, HTTPS, 관리자 비밀번호 변경, 금지어·신고 운영 정책을 준비해야 합니다.
