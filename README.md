# 광주과학고등학교 분실물 보관함

Vercel이 웹 화면과 도메인을 제공하고, Vercel API 함수가 Google Apps Script를 호출합니다. Apps Script는 게시글·댓글·관리자 데이터를 Google Sheets에, 사진을 Google Drive에 저장합니다. 별도의 서버 컴퓨터를 계속 켜둘 필요가 없습니다.

## 최초 설치 및 배포

### 1. Apps Script 프로젝트 만들기

필요한 계정은 GitHub, Google, Vercel 계정입니다. Google Workspace에서 Apps Script 웹 앱을 외부에 공개할 수 있는지 먼저 확인하세요.

저장소를 내려받은 뒤 프로젝트 루트에서 다음을 실행합니다.

```bash
npm install
npx --yes @google/clasp@3.4.1 login
cd apps-script
npx --yes @google/clasp@3.4.1 create --type standalone --title "광주과학고 분실물 보관함"
cd ..
npm run push:apps-script
```

`clasp login`과 `create`에는 사용할 Google 계정으로 로그인합니다. Clasp에서 Apps Script API를 켜라는 안내가 나오면 [Apps Script 사용자 설정](https://script.google.com/home/usersettings)에서 API를 활성화하세요. `apps-script/.clasp.json`은 해당 Apps Script 프로젝트의 ID를 가리키는 로컬 연결 파일입니다. 지우거나 다른 프로젝트의 파일로 덮어쓰지 마세요. Git에는 올리지 않습니다.

### 2. Google 저장소 초기화

1. [Apps Script 프로젝트 목록](https://script.google.com/home/projects)에서 방금 만든 **광주과학고 분실물 보관함** 프로젝트를 엽니다.
2. 편집기 상단의 함수 목록에서 `setupLostAndFound`를 선택하고 **실행**을 누릅니다.
3. 처음 요청되는 Google Sheets 및 Google Drive 권한을 승인합니다.
4. 왼쪽의 **실행(Executions)** 또는 실행 로그에서 스프레드시트 주소, 사진 폴더 주소, **관리자 최초 설정 토큰**을 확인합니다. 토큰은 최초 관리자 계정을 만들 때 필요하므로 안전하게 보관하세요.

이 함수는 전용 스프레드시트에 `Items`, `Comments`, `Admin`, `BannedWords` 시트를 만들고, Drive에 사진 폴더를 만듭니다. 프로젝트 속성에 저장소 ID를 기록하므로 앱에 DB 주소를 별도로 입력하지 않습니다. 이 프로젝트에서 `setupLostAndFound`를 다시 실행해도 기존 저장소 ID를 사용하고, 새 저장소를 만들지 않습니다. 스프레드시트와 사진 폴더를 **링크가 있는 모든 사용자에게 공유하지 마세요.** 게시판에 표시되는 사진은 링크를 가진 사람이 볼 수 있도록 앱이 설정합니다.

### 3. Vercel 프록시 비밀값 설정

Vercel API 함수만 Apps Script API를 호출하도록 비밀값으로 보호합니다.

1. Mac 터미널에서 다음 명령으로 임의의 비밀값을 만듭니다.

   ```bash
   openssl rand -hex 32
   ```

2. Apps Script 편집기에서 **프로젝트 설정 → 스크립트 속성**에 다음 속성을 추가합니다.
   - 속성: `VERCEL_PROXY_SECRET`
   - 값: 방금 생성한 비밀값
3. 같은 비밀값을 이후 Vercel 프로젝트의 `APPS_SCRIPT_PROXY_SECRET` 환경 변수에도 등록합니다.

이 값은 코드, GitHub, 공개 문서에 넣지 말고 Vercel 환경 변수와 Apps Script 스크립트 속성에만 보관하세요.

### 4. Apps Script 웹 앱 배포

Apps Script 편집기에서 **배포 → 새 배포 → 웹 앱**을 선택합니다.

- **다음 사용자 권한으로 실행:** 나
- **액세스 권한이 있는 사용자:** 앱을 공개하려면 모든 사용자

배포를 완료하면 `/exec`로 끝나는 웹 앱 URL을 복사합니다. 이 주소는 브라우저 화면이 아니라 Vercel API 프록시가 사용합니다. 웹 앱 URL이 공개되더라도 프록시 비밀값이 없으면 API 요청은 거부됩니다.

### 5. Vercel과 도메인 연결

1. GitHub 저장소를 Vercel에 가져옵니다. 프로젝트 루트는 저장소 루트, 프레임워크는 Vite, 빌드 명령은 `npm run build`, 출력 디렉터리는 `dist`로 둡니다.
2. Vercel 프로젝트의 **Settings → Environment Variables**에 다음 값을 등록합니다. Production뿐 아니라 필요한 Preview/Development 환경에도 각각 설정합니다.
   - `APPS_SCRIPT_WEB_APP_URL`: 앞 단계에서 복사한 `/exec` URL
   - `APPS_SCRIPT_PROXY_SECRET`: Apps Script 스크립트 속성에 등록한 동일한 비밀값
3. 프로젝트를 배포하고 배포 URL에서 게시글 목록이 열리는지 확인합니다.
4. Vercel **Settings → Domains**에서 사용할 도메인을 추가합니다. 도메인 등록 기관의 DNS 설정에 Vercel이 화면에 안내하는 레코드를 그대로 입력합니다. DNS 전파가 끝나면 HTTPS로 접속해 확인합니다.
5. 사이트의 관리자 설정 화면에서 사용자 이름, 초기 비밀번호, 앞서 보관한 관리자 최초 설정 토큰을 입력합니다. 첫 설정 후 16자 이상의 새 관리자 비밀번호로 변경합니다.

사진은 한 번의 업로드 요청에서 총 3MB 이하로 등록해야 합니다. 사진은 Google Drive에 저장되며, Apps Script 배포에는 기존 로컬 서버의 NSFWJS 자동 사진 검열 기능이 없습니다. 개인정보가 보이는 사진을 올리지 말고, 공개 게시물을 관리자가 직접 확인하세요.

## 코드 업데이트

### 화면 또는 Vercel API 코드 변경

변경 사항을 GitHub 기본 브랜치에 푸시하면 Vercel이 새 버전을 빌드합니다. API 연결 설정을 바꾸지 않았다면 Apps Script 배포를 수정할 필요가 없습니다.

### Apps Script 코드 변경

프로젝트 루트에서 실행합니다.

```bash
npm run push:apps-script
```

이 명령은 Apps Script 편집기 코드만 업로드합니다. **서비스에 반영하려면** Apps Script 편집기에서 **배포 → 배포 관리 → 기존 배포 수정(연필) → 새 버전 → 배포**를 추가로 실행합니다. 기존 배포를 수정하면 `/exec` 주소를 유지할 수 있습니다. 새 배포를 만들었다면 새 `/exec` 주소로 Vercel의 `APPS_SCRIPT_WEB_APP_URL`을 변경하고 다시 배포하세요. OAuth 권한 범위가 변경된 경우 새 권한 승인도 필요합니다.

### 로컬 개발 및 확인

```bash
npm run dev
```

로컬 Vite 화면에서 실제 API를 시험하려면 Vercel 프로젝트의 API가 사용되도록 다음과 같이 실행합니다.

```bash
VITE_API_PROXY_TARGET=https://<vercel-project-domain> npm run dev
```

Apps Script 코드를 수정한 뒤에는 `npm run test:apps-script`, `npm run typecheck`, `npm run build`로 확인할 수 있습니다.

## 담당자/Google 계정 인수인계

Apps Script에는 이 프로젝트가 사용하는 별도의 Google **서비스 계정**이 없습니다. 웹 앱은 배포 설정의 **“나로 실행”**에 지정된 Google 사용자 권한으로 Sheets와 Drive에 접근합니다. 담당자가 바뀌어도 데이터가 든 프로젝트와 저장소를 새로 만들지 않는 것이 가장 중요합니다.

1. **기존 Apps Script 프로젝트를 유지합니다.** 새 프로젝트를 만들면 Script Properties의 저장소 ID가 없어 새 빈 DB가 만들어질 수 있습니다. 기존 프로젝트의 편집 권한을 후임자에게 주고, 학교 Workspace 정책이 허용하면 프로젝트 소유권을 후임자 계정으로 이전합니다.
2. **Google 저장소 접근을 인계합니다.** 후임자가 스프레드시트와 사진 폴더를 열 수 있고 파일을 추가·수정·휴지통 이동할 수 있도록 권한을 확인합니다. 소유권 이전이 가능하면 스프레드시트와 기존 사진 파일의 소유자도 정책에 맞게 이전합니다. 공유 드라이브나 학교 정책에 따라 소유권 이전이 제한되면 기존 소유자 계정을 유지하거나 관리자와 별도 이전 방법을 협의합니다.
3. **Vercel 설정을 인계합니다.** Vercel 프로젝트와 연결 도메인을 후임자/정보부 팀에 넘깁니다. 환경 변수 `APPS_SCRIPT_WEB_APP_URL`, `APPS_SCRIPT_PROXY_SECRET`이 그대로 있는지 확인합니다. 비밀값이 노출되었거나 인계 정책상 교체해야 한다면 Apps Script 스크립트 속성과 Vercel 환경 변수 양쪽을 같은 새 값으로 바꾸고 재배포합니다.
4. **Clasp를 후임자 계정으로 연결합니다.** 후임자 컴퓨터에 저장소를 내려받고 `npm install`, `npx --yes @google/clasp@3.4.1 login`을 실행합니다. 기존 `apps-script/.clasp.json`의 Script ID가 인계한 프로젝트와 같은지 확인한 뒤 `npm run push:apps-script`를 실행합니다. `.clasp.json`을 지우고 `clasp create`를 다시 실행하지 마세요.
5. **후임자 권한으로 승인 및 재배포합니다.** Apps Script 편집기에서 `setupLostAndFound`를 실행해 기존 저장소 링크가 맞는지 확인하고 Google 권한을 승인합니다. 같은 프로젝트의 속성과 ID가 유지되었다면 이 함수는 기존 Sheets/Drive를 재사용합니다. 웹 앱을 기존 배포의 새 버전으로 배포하고 실행 사용자가 후임자인지 확인합니다. Vercel URL에서 글 목록, 글 작성, 사진, 관리자 로그인까지 점검합니다.
6. **관리자 비밀번호와 복구 정보를 전달합니다.** 비밀번호를 문서나 코드에 적지 말고 안전한 비밀번호 관리 수단을 이용합니다. 인수인계 완료 후 필요하면 관리자 비밀번호를 변경하고, 구 담당자의 Google/Vercel 권한을 회수합니다.

계정이 바뀌었다고 기존 배포가 자동으로 새 사용자 권한으로 실행되는 것은 아닙니다. 실행 사용자를 후임자로 바꾸어 새 버전을 배포하기 전까지는 기존 배포자가 Sheets/Drive 접근 권한과 계정 상태를 계속 관리해야 합니다. 학교 Workspace 계정이 삭제되거나 정지되기 전에 반드시 인수인계를 완료하세요.

## 백업 및 데이터 주의사항

- 정기적으로 스프레드시트와 Drive 사진 폴더의 복구 가능한 사본을 별도 보관하고, 복구 테스트를 해보세요. 원본 시트/폴더 공개 공유는 하지 않습니다.
- 게시판 데이터는 공개 웹 앱을 통해 누구나 볼 수 있습니다. 관리자 비밀번호, 관리자 설정 토큰, 프록시 비밀값을 공개하지 마세요.
- `.data/`에는 이전 로컬 SQLite DB, 사진, 암호화 키가 있을 수 있습니다. Apps Script로 자동 이전되지 않았으며, 이 경로의 기존 데이터는 인계나 백업 여부를 확인하기 전까지 삭제하지 마세요.
- Apps Script와 Google Sheets/Drive에는 실행 시간 및 사용량 제한이 있습니다. 사용량이 늘면 성능과 무료 한도를 확인하세요.
