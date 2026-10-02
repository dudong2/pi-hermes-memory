# Orchestrator 통합 — 3단계: Hindsight 연동 흡수

## 목표와 범위

`pi-memory-orchestrator`의 책임을 `pi-hermes-memory`에 단계적으로 흡수하고, 검증
후 기존 확장을 제거한다. 이번 통합은 **Pi 전용**이며 OMP 호환·공유 동작은
범위에서 제외한다.

확장을 하나로 만드는 것이 저장소를 하나로 합치는 것은 아니다. Hermes의 제한된
작업 기억과 Hindsight 장기 기억은 별도로 유지한다. Project는 검색용 이름
공간이고, 실제 기억의 소유자는 Scope다.

## 확인한 문제

세션 `01a0f152-86d9-7244-b3b9-8bfa876db8d4`에서 확인한 원인은 프로젝트 바인딩
불일치다.

- Hermes `0.9.9`는 Git 루트/작업 디렉터리 이름으로 저장 경로를 만든다.
- Orchestrator는 카탈로그의 고유 `scopeId`로 경로를 만든다.
- Orchestrator의 `pi-hermes-memory:resolve-project` 이벤트에 Hermes가 요청하지
  않아 이름 기반 폴더와 ID 기반 폴더가 함께 사용될 수 있다.

최종 해결은 이벤트 후크만 임시 복구하는 것이 아니라, Scope 식별을 공통 기준으로
삼고 내부 모듈로 소유권을 옮기는 것이다.

## 이식 기준

- 원본: `../pi-memory-orchestrator`, `v1.1.11`, commit `539e8bc`.
- 가져온 구성요소: `catalog.ts`, `git.ts`, `marker.ts`, `resolver.ts`와 Scope
  테스트.
- MIT 고지는 `src/scope/ORCHESTRATOR_LICENSE`에 보존한다.
- 카탈로그의 현행 `projects`·`scopes` 형식과 version 2 marker를 유지한다.
- 기존 `scopeId`, `projectId`, `memoryTag`, 별칭, `legacyHermesNames`를
  유지한다. 읽기만으로 이전 형식을 추정하거나 ID를 다시 발급하지 않는다.
- Git remote의 SSH/HTTPS 정규화, linked worktree 식별, 첫 origin 등록 시 local
  ID 승격, 이동 후 marker 복구를 유지한다.
- 기존 remote가 바뀌면 자동 재연결하지 않는다. 명시적인 재연결 동작이 필요하다.
- Project 없는 global Scope와 부모 디렉터리 자동 상속은 지원하지 않는다. 전역
  Hermes 작업 기억의 존속과는 별개다.

## 이식 시 보강한 안전 경계

- `dataDir`는 명시적인 절대 경로로 전달한다. 이 단계의 모듈은 실제 설정·카탈로그
  위치를 자동으로 읽거나 새 카탈로그를 기본 활성화하지 않는다.
- 다른 Project/Scope에 등록된 ID를 덮어쓰지 않는다.
- 카탈로그 변경은 기존 SQLite 잠금 구현을 재사용해 직렬화한다. 새 네이티브
  의존성은 없다.
- 원래 PID 잠금 파일 형식은 유지하지만, 오래됐다는 이유만으로 살아 있는 소유자의
  잠금을 제거하지 않는다. 종료가 확인되는 프로세스만 복구 대상으로 삼는다.
- 새 프로세스끼리 잠금 회수와 등록이 겹쳐도 타인의 등록을 잃지 않도록 보호한다.
- 카탈로그와 marker의 다중 파일 갱신은 단일 원자적 트랜잭션이 아니다. 기존
  재소속 실패 롤백을 유지하되, 실제 전환에서는 동시에 두 확장을 쓰기 소유자로
  활성화하지 않는다.

## 현재 상태와 다음 단계

1. Scope 식별 모듈 흡수와 임시 환경 검사: 구현·검증됨.
2. Hermes 메모리·스킬·세션 검색·Curator의 공통 Scope 바인딩: 구현됨; 설치본
   적용은 아직 없음.
3. Hindsight 검색·저장·outbox·Knowledge/관리 기능 흡수: 구현됨; 운영 전환은 아직
   없음.
4. 동등성 검증 후 기존 확장 비활성화·패키지 제거: 대기.

2단계는 `src/index.ts`의 프로젝트 바인딩·리소스 발견을 공통 Scope 조회에
연결한다. **코드의 catalog 모드에서는 이름 기반 폴더를 다시 만들지 않도록
검증했지만, 현재 설치본·실제 설정에는 아직 적용하지 않았다.** Hindsight 연동은
기존 Orchestrator가 계속 담당한다.

## 2단계 바인딩 계약

- 저장 키와 SQLite의 기존 `project` 필드에는 **`scopeId`**를 사용한다.
  프롬프트에 보이는 이름은 **`Project/Scope`**다. Project 이름을 저장소 소유자로
  취급하지 않는다.
- 메모리는 `projects-memory/<scopeId>/MEMORY.md`, 프로젝트 스킬은 같은
  디렉터리의 `skills/`에 둔다. 스킬 ID의 예는 `project:ws_existing:workflow`다.
- 공통 조회는 `src/scope/project-binding.ts`에 있다. 전환 중에는
  카탈로그·marker를 **읽기만** 하고 새 등록·복구·ID 승격·쓰기 소유권 이전을
  수행하지 않는다.
- 미등록 위치, 손상된 marker·카탈로그, 저장소 identity 불일치에서는 Scope
  메모리·프로젝트 스킬을 사용하지 않는다. cwd 이름으로 돌아가거나 이전 Scope를
  계속 사용하지 않는다.
- 세션 인덱스는 공통 경계에서 Scope ID를 붙인다. 기존 인덱스는 확정할 수 있는
  경로만 다시 라벨링하며, 메시지·세션 ID·원본 JSONL은 바꾸지 않는다. 매핑할 수
  없는 기존 라벨을 임의로 지우지 않는다.
- `memory_search`와 SQLite `session_search`의 명시적인 `project` 필터는 Scope
  ID나 유일한 `Project/Scope` 이름으로 해석한다. 모호한 이름은 거절한다. 기존의
  필터 없는 검색 범위와 JSONL anchors 모드의 cwd 계약은 변경하지 않는다.
- Markdown 미러는 등록 Scope ID의 정본 파일만 동기화한다. 이름 기반 파일·미러를
  자동 병합·삭제하지 않고, 정본 파일이 없는 Scope의 미러도 추정해 지우지 않는다.
- Curator의 리소스·원장·명령·독립 실행기도 Scope ID를 사용한다. catalog 모드의
  실행기는 미등록된 이름 기반 프로젝트 경로를 정리 대상으로 삼지 않는다.

### 설정과 활성화

```json
{
  "projectResolutionMode": "catalog",
  "scopeCatalogDir": "/absolute/path/to/existing/catalog-directory"
}
```

`scopeCatalogDir`는 기존 `scope-catalog.json`이 있는 디렉터리다. 설정을 읽을 때
홈 표기를 확장하고 agent 디렉터리 기준 상대 경로를 절대 경로로 정규화한다. Scope
조회 API 자체에는 절대 경로만 전달한다.

- 기본값 `cwd`는 기존 upstream 동작을 유지한다. 이번 작업은 실제 사용자 설정을
  이 예제로 바꾸지 않는다.
- `catalog`에서 카탈로그 위치가 없거나 유효하지 않으면 프로젝트 바인딩이
  비활성화된다. 이름 기반 fallback은 없다.
- 지원하지 않는 값과 이전 `external` 값은 `disabled`로 처리한다. 설치본 전환 시
  새 모드를 명시해야 하며, 누락된 이벤트 후크를 이름 기반 fallback으로 숨기지
  않는다.
- 코드 적용, 설정 활성화, 기존 데이터 병합은 서로 다른 작업이다. 현재
  구현·검증은 임시 환경에 한정한다.

이번 단계에서 기존 카탈로그·marker·outbox·Hindsight 데이터와 메모리·스킬 파일은
변경하지 않는다. 이름 기반 기억·스킬의 병합은 충돌·출처·Curator 세대를 보존하는
별도 전환이다. 폴더가 비어 보이거나 세션 로그가 없다는 이유로 삭제하지 않는다.

원본 저장소와 현재 설치본은 보존한다. 기존 확장의 제거는 설치된 패키지 퇴역을
뜻하며, 카탈로그·기억·백업이나 소스 저장소 삭제를 뜻하지 않는다.

## 3단계 Hindsight 연동

`src/hindsight/`에 HTTP client, Scope provider, durable outbox, `long_memory`,
성공한 bounded 쓰기 mirror, Knowledge UI, lifecycle·관리 명령을 흡수했다.
`src/scope/query.ts`와 `onboarding.ts`는 기존 Project/Scope 선택·검색 계약을
유지한다.

### 설정과 단일 쓰기 소유자

```json
{
  "projectResolutionMode": "catalog",
  "scopeCatalogDir": "/absolute/path/to/existing/state",
  "hindsightEnabled": true,
  "hindsightSettingsPath": "/absolute/path/to/existing/config.json"
}
```

- **기본값은 `hindsightEnabled: false`다.** 비활성 상태에서는 기존 Hindsight
  설정·자격 증명·outbox를 읽거나 만들지 않고 관련 도구·콜백을 등록하지 않는다.
- `hindsightSettingsPath`를 생략하면 기존 `PI_MEMORY_ORCHESTRATOR_CONFIG` 또는
  `~/.config/pi-memory-orchestrator/config.json`을 재사용한다. `dataDir`, bank,
  API 설정과 원래 자격 증명 파일을 유지하며 새로운 토큰 저장소를 만들지 않는다.
- 서비스 설정의 `dataDir`와 Hermes의 `scopeCatalogDir`가 동일한 카탈로그를
  가리켜야 활성화된다. 다른 위치를 새 저장소로 추정해 시작하지 않는다.
- 활성화는 **기존 Orchestrator 확장을 비활성화한 단일 소유자 전환에서만**
  수행한다. 두 확장을 함께 켜지 않는다. 공유 도구·명령 이름도 기존 계약을
  유지한다.
- Pi 전용이며 새 runtime 설정은 `harness: pi`만 허용한다. 기존 outbox에 남아
  있는 다른 harness의 작업은 삭제하거나 태그·ID를 바꾸지 않는다.
- 실제 서버나 데이터는 이번 구현에서 전환하지 않았다. 설정 예시는 설치·활성화
  승인을 뜻하지 않는다.

### 동작·안전 계약

- `session_start`에서 Scope를 해석하고 필요하면 기존 등록 UI를 제공한 뒤
  Hermes의 초기 스냅샷을 바인딩한다. 등록 취소·미등록 위치에서는 Scope 기억을
  추정하지 않는다.
- `input`에서 미리 recall을 시작하고 `before_agent_start`에서 제한된 시간 내
  결과를 격리된 `<memory-context>` 참고 데이터로 추가한다. 실패해도 대화는
  계속된다.
- 세션 ID·cwd·epoch와 종료 신호를 검사한다. 교체·종료된 세션의 늦은 recall, 완료
  메시지, bounded 쓰기 결과가 새 Scope의 기억이나 사용자 텍스트를 사용하지
  못한다.
- 완료된 대화와 성공한 `memory_add`·`memory_replace`의 project 쓰기는 **현재
  Scope의 태그만** 사용하여 로컬 outbox에 먼저 저장한다. 삭제/FIFO 정리를 장기
  기억 무효화로 간주하지 않는다.
- `long_memory`의 검색은 기존 명시적 교차 Scope 선택을 지원한다. 새 retain은
  현재 Scope에만 기록하며, 다른 대기 작업 하나가 끝났다는 이유로 성공을 알리지
  않고 **그 요청의 operation ID 완료**를 확인한다.
- 수정은 기존 메모리 ID를 사용하고 forget은 `invalidated`로 가역적 무효화한다.
  Knowledge와 Scope 재소속 기능도 기존 ID·태그와 확인·실패 롤백을 유지한다.
- 자격 증명을 담은 URL과 인증 요청의 redirect를 거절한다. 기존 secret scanner로
  새로운 본문과 수정 내용의 실제 자격 증명 패턴을 차단하고 재시도 오류
  기록에서도 민감한 세부 정보를 남기지 않는다.
- Scope metadata 파일만 동기화한다. 이름 기반 메모리·스킬의 자동 병합은 없다.

### Outbox 보존·복구

- 기존 version 1 job의 `id`, `operationId`, 목적 bank, 본문, Scope 태그는 그대로
  처리한다. 이미 대기한 작업의 ID를 재발급하거나 목적 bank를 바꾸지 않는다.
- 새 명시적 작업은 Scope·세션·도구 호출의 식별 범위를 구분해 서로 다른 Scope나
  세션의 호출 ID 재사용이 충돌하지 않게 한다.
- 짧은 파일 상태 변경만 기존 SQLite 잠금으로 직렬화하며 HTTP 대기 동안 잠금을
  잡지 않는다. 새 네이티브 의존성은 없다.
- 나이가 많은 processing claim이라도 소유 프로세스가 살아 있으면 회수하지
  않는다. 종료가 확인된 PID claim만 복구하며 기존 pending 작업을 덮어쓰지
  않는다.
- **소유 PID를 알 수 없는 이전 processing 파일은 그대로 보존한다.** 운영 전환 때
  이전 worker 종료와 해당 작업의 소유권을 별도로 확인해야 하며, 미사용이나
  실패로 추정해 삭제하지 않는다.
- 손상된 ID·본문과 비밀 포함 작업은 안전한 failed 위치로 격리한다. 성공 완료가
  확인되기 전에는 대기 작업을 제거하지 않는다.

## 검증

모든 변경 검사는 임시 디렉터리와 임시 Git 저장소에서만 수행한다.

```bash
npx tsx --test tests/hindsight/*.test.ts tests/scope/*.test.ts
npm run check
git diff --check
npm test
```
