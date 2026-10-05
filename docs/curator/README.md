# Skill Curator — 검사와 보관

Curator는 AI 내용 평가가 아니라 명시한 기간, 생성·편입 권한, 확인된 사용, 현재 파일 지문으로 판단한다. 새 Pi 프로세스의 `session_start`에서 검사하며, 리소스 발견 전에 실행된다. 이미 열린 Pi의 스킬 목록은 보관 후에도 재로드 전까지 낡아 있을 수 있다. 타이머가 아니므로 Pi를 새로 시작하지 않으면 14일째 즉시 이동하지 않는다.

## 관리 범위

- 확장에서 정상 생성되어 원장과 현재 세대가 일치하는 스킬은 기존 생성 경계로 관리한다.
- 출처를 사용자가 직접 지정한 **기존 스킬**은 별도의 `adopted-archive.json`에 `user-designated-hermes`로 등록한다. 과거 `skill_manage(create)` 기록이나 현재 파일 안의 생성 표식을 위조하지 않는다. 지정 당시의 경로·내용 해시·파일 식별자를 저장하고 보관 직전 다시 검사한다. 파일이 바뀌거나 재생성되면 자동으로 다시 편입하지 않고 보류한다.
- 위치가 `~/.pi/agent` 아래라는 사실, 조회·수정 이력, 기존 사용 보고만으로는 보관 권한을 주지 않는다. repo 안의 스킬과 사용자·외부 설치 스킬은 대상이 아니다.
- `curatorPolicy.pinnedSkillIds`는 보호할 스킬 ID 목록이다. 생성·수정·사용·편입 기간은 명시적으로 설정해야 하며 기본 기간은 없다.

## Pi 명령

```text
/memory-curator status
/memory-curator inventory
/memory-curator dry-run
/memory-curator dry-run --json
/memory-curator archive
```

`dry-run`은 조회만 수행한다. 현재 프로젝트와 전역의 생성 확인 스킬은 후보·보류 이유를, 사용자 지정 기존 스킬은 **전역·전체 프로젝트**의 활성 수·archive 후보·보류 수를 따로 간략히 표시한다. `--json`은 스킬별 판단과 기간 경계, 지정 코호트 요약을 반환한다. 후보 수는 실제 이동 확정 수가 아니다. `remove`는 이전 명령의 호환 별칭이지만 이제 **삭제하지 않고 archive로 옮긴다**. `archive` 역시 검사·잠금·정책을 다시 거쳐 조건을 만족하는 대상만 이동하며 스킬별 승인·알림을 하지 않는다. 자동 복원·purge 기능은 없다.

## 기존 스킬 지정과 사용 관측

기존 사용 보고는 `node scripts/curator-usage.mjs --init`으로 최초 한 번 고정한 `usage-cohort.json`의 스킬에 한정한다. `--report`는 시작 시각 이후 Pi JSONL 세션 기록의 성공한 직접 `read`·`skill_manage(view)` 및 성공한 중첩 `read`를 다시 집계한다. 편입된 코호트의 자동 판단은 `--report --since <편입 ISO 시각>`에 해당하는 기간만 사용한다. 잘못된 JSONL 줄·미완료 중첩 호출·읽지 못한 파일이나 세션 파일 부재가 있으면 판단을 보류한다. `/skill:` 전달 모양의 메시지는 붙여넣기와 구별할 수 없어 `deliveryCandidate`로 따로 기록하고, 보관 판단에서는 사용 가능성으로 보수적으로 취급한다. bash·외부 도구·누락된 세션 등 모든 경로를 관측하지는 못한다. 기록을 읽을 수 없거나 지정된 스킬이 보고서에서 빠지면 **코호트 전체 보관을 보류**한다.

승인받은 기존 스킬 집합만 명시적으로 편입한다. 다음은 77개 코호트와 보호 대상 ID를 확인한 운영 예시이며, 다른 설치에 숫자를 재사용하지 않는다.

```bash
node scripts/curator-adopt.mjs --init \
  --exclude project:scope_1e054c11-8ebc-4858-9bfa-1b3e1fd4ccaf:analyze-prize-point-cohorts \
  --expect 77
node scripts/curator-adopt.mjs --list
```

`--init`은 `curatorPaused: true`일 때만 허용하고, 기존 관찰 목록의 보호 대상 포함 여부·정확한 수·경로와 현재 파일을 검증한다. 실패 또는 반복 실행 시 기존 manifest를 덮어쓰지 않는다. `inventory`는 일치하는 현재 파일을 `source: user-designated-hermes`, `generation: adopted-snapshot`으로 별도 표시하며 이를 과거 생성 성공 이력으로 표현하지 않는다. 성공하면 사용자 지정 시각부터 14일을 센다. 해당 코호트의 `SKILL.md`는 편입 과정에서 수정하지 않는다. `--list`는 편입 시각·활성 수와 나중에 이동된 archive 경로를 보여준다. 보관하지 않기로 한 repo-local 스킬은 홈의 지정 목록에서 제외하며, 별도의 pin으로 재등장도 보호할 수 있다.

## 판정과 이동

- Pi 시작 검사는 생성·수정·확인된 마지막 사용·기존 스킬 지정 시각 이후의 **달력 시간**을 계산한다. Pi를 실행하지 않은 시간도 포함한다. 기존 지정 코호트의 최소 관측·생성·수정·편입 유예는 안전하게 모두 지정 시각 이후 경과 기간으로 적용한다. 최근 확인된 사용이 있으면 미사용 기간을 다시 센다.
- 생성 확인 스킬의 관측 장애는 불확실성 시각 이후 미사용 기간을 다시 세게 한다. pin, 출처·세대 불명, 파일·경로 변경, 링크·하드링크, 검사를 완료하지 못한 대상은 보류한다. 생성 확인 스킬 중 부속 파일의 사용을 관측할 수 없는 번들도 기존대로 보류한다.
- 기존 지정 코호트는 파일 내용·식별자가 등록 당시와 일치할 때만 디렉터리 전체를 보관하므로 부속 파일도 함께 보존한다. 변경된 파일은 그대로 둔다.
- 이동 경로는 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-hermes-memory/curator/archive/{global|project/...}/<스킬 이름>/<UUID>/`이다. 전역·프로젝트 스킬 검색 경로 밖이라 Pi가 자동 로드하지 않는다. 저장소와 같은 파일시스템에서만 원자적 `rename`으로 이동한다. 목적지 충돌이나 경로 이탈·심볼릭 링크가 있으면 보류하거나 실패로 보고하며 다른 사용자 파일을 덮어쓰지 않는다.
- 공유 변경 잠금 안에서 최신 정책·pin·파일·코호트 상태를 다시 확인한다. 중간 실패 시 스킬 디렉터리는 원래 위치 또는 archive에 남아야 하며 재귀 삭제하지 않는다. archive 디렉터리는 자동 삭제되지 않는다. 복원 명령은 아직 없으므로 `--list`로 경로를 찾고 원래 이름의 충돌·파일 내용을 확인한 뒤 수동 복원해야 한다.

`curatorPaused: true`에서는 사전 검사까지만 하고 이동하지 않는다. 기존 Pi 프로세스가 오래 실행 중일 때 안전하게 전환하기 위해 새 설치본은 `curatorArchiveEnabled: true`를 명시하면 **새 코드에서만** 일시정지된 archive 경로를 활성화한다. 구 설치본은 이 설정을 무시하고 `curatorPaused: true`를 계속 존중한다. 값이 불완전하거나 잘못된 정책은 권한을 만들지 않는다. Pi를 새 프로세스로 시작해야 새 자동 검사 코드가 적용된다.

독립 CLI `node scripts/curator.mjs --once` / `--watch`는 이전의 정상 연속 관측·살아 있는 캐시 보호 기준을 유지하되 결과 작업은 동일한 archive 이동이다. 예약 작업은 자동 설치하지 않는다. Pi 시작 검사와 별도 예약을 동시에 둘 필요는 없다.

## 저장과 검증

출처·활동 원장은 `${PI_CODING_AGENT_DIR}/pi-hermes-memory/curator/curator.db`, 사용자 지정 코호트는 별도 `adopted-archive.json`에 저장한다. manifest는 `0600`, 디렉터리는 `0700`으로 보호한다. 파일 이동 중 전원 장애가 나면 archive에 파일이 있는데 manifest가 아직 `active`일 수 있으므로 파일 존재를 확인하고 수동으로 상태를 복구한다. 보고서 수치만으로 누락 파일을 삭제하거나 재등록하지 않는다.

실제 사용자 스킬 대신 임시 agent 디렉터리에서 검사한다.

```bash
npx tsx --test tests/curator/*.test.ts
npm run check
npm run check:production
npm test
```
