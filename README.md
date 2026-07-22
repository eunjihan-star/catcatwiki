# 부동산/주택 정보 위키

주소를 입력하면 공공데이터포털(건축물대장)과 네이버 검색 API를 연동해 아래 정보를 보여주는 웹앱입니다.

- 건물 유형 (아파트 / 다세대·연립(빌라) / 오피스텔 / 단독·다가구주택 / 상가 등)
- 사용승인일(준공일)
- 재건축/재개발 관련 뉴스·블로그에서 추출한 사업시행인가일 / 관리처분인가일(최초·변경) / 청약 당첨일 / 조합원 승계일
- 입력 주소(도로명/지번 혼용, 단지명 생략·순서 상이 등) 정제 및 중복 제거

## 폴더 구조

```
real-estate-wiki/
  package.json
  vercel.json          # Vercel 배포 설정 (정적 출력 디렉터리 = public)
  .env.example         # 이 파일을 복사해 .env 로 만들고 키를 채워넣으세요
  api/
    search.js           # Vercel 서버리스 함수 (POST /api/search) - 배포 시 이게 실행됨
  server/
    index.js             # Express 서버 엔트리 (로컬 개발용, npm start)
    searchHandler.js      # 검색 오케스트레이션 순수 로직 (Express·Vercel 공용)
    routes/search.js      # Express 라우트 (searchHandler.js 호출만 함)
    services/
      addressService.js   # 도로명주소 API 연동, 후보 dedup
      buildingService.js  # 건축물대장정보 API 연동, 유형/사용승인일 추출
      naverService.js     # 네이버 검색 API 연동, 재건축 관련 정보 휴리스틱 추출
    utils/
      addressParser.js    # 입력 주소 정제(중복 지번 제거, 동/호 분리 등)
  public/
    index.html          # 프론트엔드 (위키 통합 버전, 별도 빌드 없는 순수 HTML/CSS/JS)
```

로컬 개발(`npm start`)과 Vercel 배포(`api/search.js`)가 동일한 `server/searchHandler.js` 로직을
공유하므로, 검색 동작이 두 환경에서 완전히 동일합니다.

## 1. API 키 발급

세 곳에서 각각 키를 발급받아야 합니다. 모두 무료입니다.

1. **행정안전부 도로명주소 API** (주소 정제/후보 검색용)
   - https://www.juso.go.kr/addrlink/openApi/apiEasyGuide.do → 오픈API 신청
   - 발급받은 승인키를 `JUSO_API_KEY` 에 입력
2. **공공데이터포털 - 국토교통부 건축물대장정보 서비스** (건물유형/사용승인일)
   - https://www.data.go.kr/data/15057200/openapi.do → 활용신청 (승인까지 최대 1~2일 소요될 수 있음)
   - 발급받은 "일반 인증키(Decoding)"를 `BUILDING_REGISTER_API_KEY` 에 입력
3. **네이버 검색 오픈API** (재건축/재개발 뉴스·블로그 검색)
   - https://developers.naver.com/apps/#/register → 애플리케이션 등록 시 "검색" API 체크
   - 발급받은 Client ID / Client Secret 을 `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` 에 입력

## 2. 설치 및 실행

로컬에 [Node.js](https://nodejs.org) (LTS 버전) 설치가 필요합니다.

```bash
cd real-estate-wiki
cp .env.example .env      # 이후 .env 파일에 발급받은 키 입력
npm install
npm start
```

서버 실행 후 브라우저에서 `http://localhost:4000` 접속.

개발 중에는 `npm run dev` (nodemon, 파일 변경 시 자동 재시작) 사용을 권장합니다.

## 3. 동작 방식

1. 사용자가 자유 형식 주소를 입력 (도로명/지번 혼용, 단지명 생략·순서 상이, 동/호 포함 등)
2. `addressParser.js` 가 중복 지번 제거, 동/호 분리 등으로 검색어를 정제
3. `addressService.js` 가 도로명주소 API로 후보를 조회하고 동일 건물 중복을 제거해 가장 유력한 1건을 선택
4. `buildingService.js` 가 선택된 주소의 시군구코드/법정동코드/지번으로 건축물대장 표제부를 조회해 건물유형·사용승인일을 추출
5. `naverService.js` 가 (건물명 또는 지번주소) + "재건축/재개발/관리처분인가/사업시행인가" 키워드로 뉴스·블로그를 검색하고, 키워드 주변의 날짜를 정규식으로 추출해 사업시행인가일/관리처분인가일(최초·변경)/청약 당첨일/조합원 승계일 후보를 구성
6. 프론트엔드는 결과와 함께 참고 원문(뉴스/블로그 링크) 목록을 항상 같이 보여줘서, 자동 추출된 날짜를 사람이 직접 대조 확인할 수 있게 함

## 4. Vercel 배포

프론트엔드(`public/index.html`)와 백엔드(`api/search.js`)를 **같은 Vercel 프로젝트**로 함께 배포합니다.
이렇게 하면 프론트엔드가 같은 도메인의 `/api/search` (상대경로)를 호출하므로, 배포 URL이 무엇이든
(예: `https://your-project.vercel.app`) 별도 설정 없이 그대로 동작합니다.

1. 이 폴더(`real-estate-wiki`)를 GitHub 저장소로 push
2. Vercel 대시보드 → "Add New Project" → 해당 저장소 import
   (Framework Preset은 자동 감지가 안 되면 "Other"로 선택 — 별도 빌드 명령 없이 그대로 배포됨)
3. **Project Settings → Environment Variables** 에 아래 3개 키를 등록 (`.env`에 넣었던 값과 동일):
   - `JUSO_API_KEY`
   - `BUILDING_REGISTER_API_KEY` (승인 전이면 비워둬도 됨 → 목데이터로 동작)
   - `NAVER_CLIENT_ID`
   - `NAVER_CLIENT_SECRET`
   - (등록 후 Redeploy 필요 — 환경변수는 배포 시점에 번들링됨)
4. 배포 완료 후 발급된 URL로 접속해 "부동산정보" 탭에서 조회 테스트

> `.env` 파일 자체는 `.gitignore` 에 포함되어 있어 저장소에 올라가지 않습니다. Vercel에서는
> 반드시 대시보드의 Environment Variables로 키를 등록해야 합니다.

### 위키를 다른 곳(예: 로컬 파일 더블클릭)에서 열 때

`public/index.html`의 부동산정보 검색은 `/api/search` 상대경로를 우선 사용하고,
`file://` 프로토콜로 직접 연 경우에만 `http://localhost:4000` 으로 폴백합니다.
즉 Vercel에 배포된 상태에서는 항상 같은 도메인의 API를 자동으로 사용하고,
로컬에서 파일을 더블클릭해 열었을 때만 `npm start` 로 띄운 로컬 서버를 바라봅니다.

## 5. 한계 및 주의사항

- **재건축/재개발 정보는 100% 정확하지 않습니다.** 네이버 검색 결과 텍스트에서 키워드와 날짜를 정규식으로 매칭하는 휴리스틱 방식이라, 오탐(잘못된 날짜 매칭)이나 누락이 발생할 수 있습니다. 반드시 결과 화면의 "참고 원문 보기"에서 원문 링크로 교차 확인 후 업무에 반영하세요.
- **건축물대장에 등재되지 않은 나대지/신축 전 필지/일부 상가** 등은 건물유형·사용승인일이 조회되지 않을 수 있습니다.
- 도로명주소 API 특성상 **아직 등록되지 않은 최신 주소**이거나, 단지명이 공식 명칭과 크게 다른 경우 검색 결과가 없을 수 있습니다. 이 경우 지번 위주로 다시 입력해보세요.
- 세 API 모두 일일 호출 한도가 있습니다 (기관/서비스별 상이). 대량 조회가 필요하면 각 포털에서 한도 상향을 신청하세요.
- API 키는 `.env` 파일로만 관리되며 `.gitignore` 에 포함되어 있어 저장소에 커밋되지 않습니다. `.env` 파일을 외부에 공유하지 마세요.
