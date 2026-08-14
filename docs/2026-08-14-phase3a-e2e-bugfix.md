# Phase 3a 真机 E2E 修复清单 (2026-08-14)

真机链路 `claude 工具调用 → canUseTool 风控 → needs_approval 卡片 → Core → 眼镜(WiFi LAN) → 手势 → Core → adapter → allow/deny → 工具执行/拒绝` 已跑通，spec §9.3 四场景全部通过。

**状态 (2026-08-14 回归后)**：Bug 1–4 已由 Codex 修复（commit `db30e04`）并通过真机回归验证（四场景重跑全部 ✅）。Bug 5 已完成 Core 侧状态机修复，待真机/Mock Device 复跑验证。

---

## Bug 1: task_id 不一致（session_id vs requestId）

**文件**: `agent-adapter/src/adapters/claude.ts`

**现象**: 同一个会话里，`task_started` 与 `needs_approval` 使用不同的 `task_id`，导致 Core 状态机碎片化，approval 状态与 "back to running" 落在错误 key 上。

**根因**:
- `mapClaudeSDKMessage()`（第 325–352 行）里 `task_started`/`task_failed`/`task_completed` 用 `message.session_id`（SDK 内部 UUID）作为 taskId。
- `canUseTool`（第 194–241 行）里 `needs_approval` 用 `options.requestId || options.toolUseID`（每次工具调用的 request ID）。
- 两者都不是 `send()` 里算出的会话级 taskId（`input.taskId || input.sessionId || this.sessionId`）。

**后果**: Core `handleAgentEvent` 用 `msg.TaskID` 做状态机转换 + `approvalMgr.Create/GetByTask` 都以 task_id 为 key。task_started(task_id=UUID) 和 needs_approval(task_id=requestId) 是两个不同 key → 状态机记录 `invalid transition`（只记日志不拒绝，功能勉强跑通），approve 后 `Transition(requestId, task_running)` 也是落错 key。

**修复建议**: 统一用一个会话级 taskId。在 `send()` 开头把算出的 `taskId` 存为实例字段（如 `this.currentTaskId`），`mapClaudeSDKMessage` 和 `canUseTool` 都读它，不再用 `message.session_id` / `options.requestId`。这与 `normalizer.ts` 第 120 行「默认一个 session 一个 task」的语义一致。

---

## Bug 2: Core 风险分语义缺口（adapter 传 0.3，Core 重算成 0.00）

**文件**: `middleware-core/internal/risk/assessor.go` + `middleware-core/cmd/server/main.go`

**现象**: adapter 在 `needs_approval` 的 `msg.RiskScore` 传了 `assessRisk()` 的分（Write=0.4 / Bash=0.3 / rm=0.9），但 Core 眼镜卡片显示 risk=0.00。

**根因**: `main.go` 第 125 行 `s.riskEng.Evaluate(&msg)` 无条件从 title/body 文本重新解析并覆盖 `msg.RiskScore`。而 adapter 的 `needs_approval` title=`Approval required: <tool>`、body=`Risk score: 0.3`（`normalizer.ts` 第 254 行），Core 的规则只认命令文本（`rm -rf`/`DROP`/`deploy` 等），匹配不到 → 得 0.00。

**后果**: 卡片显示的风险分错误，Core 侧 `RiskBlocked` 判断失效（虽然 adapter 已用自己的阈值拦截，但用户看到的分数是错的，且 Core 侧审批记录的 risk 也为 0）。

**修复建议**（两处都做）:
1. **Core 侧**: `Evaluate` 前先看 `msg.RiskScore > 0` 就沿用（adapter 传来的权威分），否则才重新解析；或加一个「adapter 已评估」字段避免二次覆盖。
2. **Adapter 侧**: 让卡片真正显示「在审批什么」。`needs_approval` 的 `AgentEvent` 目前只有 `{tool, risk, taskId}`，没有 tool input（`adapters/types.ts` 第 32 行）。把 tool 的输入参数（尤其 `command`）加进 event 和 body，用户才能在眼镜上看到实际命令。

---

## Bug 3: 默认审批超时 30s 太短

**文件**: `agent-adapter/src/adapters/claude.ts` 第 65 行

**现象**: `AGENTBRIDGE_CORE_TIMEOUT` 默认 30_000ms。真机场景卡片渲染 + 用户看到 + 手势回传 round-trip 约 50s，30s 就到点 auto-allow，用户还没点工具就执行了（场景 2 首跑即复现）。

**修复建议**: 默认改 120_000ms（或 60–120s），并在 spec/README 明确「真机联调时设置 `AGENTBRIDGE_CORE_TIMEOUT=120000`」。当前测试是手动 export 该变量绕过的。

---

## Bug 4 (minor): findWindowsGitBashPath 漏检非 Program Files 路径

**文件**: `agent-adapter/src/adapters/claude.ts` 第 315–323 行

**现象**: `findWindowsGitBashPath()` 只查 `C:\Program Files\Git\...` 和 `C:\Program Files (x86)\Git\...`。用户 Git 装在 `D:/Software/Git`，自动检测不到，靠手动 `export CLAUDE_CODE_GIT_BASH_PATH="D:/Software/Git/bin/bash.exe"` 绕过。

**修复建议**: 用 `where.exe bash` / `git --exec-path` 动态探测，或至少追加常见非默认路径候选。环境变量覆盖已有，只需让自动检测更可靠。

---

## Bug 5: 状态机 terminal 态不复位（复用 taskID 后卡在 completed）

**文件**: `middleware-core/internal/statemachine/machine.go`

**状态**: 已按 Core 侧最小修复落地：`TaskStateCompleted` / `TaskStateFailed` 收到新的 `task_started` 时重新进入 `starting`。已补单测覆盖同一 taskID 的第二个 turn 从 `completed` 回到 `starting` 并继续进入 `awaiting_approval`；仍需 E2E 复跑确认。

**现象**: task_id 统一为 session 级（`default`）后，同一会话的第二个 turn（新 prompt）复用相同 taskID，但 Core 状态机已停在 `completed`，导致后续所有事件都打 `invalid transition: no transitions defined from state "completed"`。

**根因**: `validTransitions`（第 17–47 行）里 `TaskStateCompleted` 和 `TaskStateFailed` 没有任何 outgoing transition，是 terminal 态。`Transition()` 第 79 行查 `validTransitions[current]` 时 completed 无转换表 → 报错并返回 current。adapter 的模型是「一个 session 一个 taskID、多 turn」，但状态机假设「一个 taskID 一个生命周期」，新 turn 无法 restart。

**后果**: 状态机内部状态追踪失效（`awaiting_approval` 态永远进不去），dashboard 的 `task_state` 一直卡在 completed。**非阻塞**——审批走 `approvalMgr` + `dispatcher`，与状态机独立，approve/reject/分发/回传都正常（回归四场景已证明）。

**修复建议**（二选一）:
1. **Core 侧（推荐，最小改动）**: 在 `validTransitions` 给 `TaskStateCompleted` 和 `TaskStateFailed` 增加 `EventTaskStarted → TaskStateStarting`，把新 task_started 视为重新开始一个生命周期。
2. **Adapter 侧**: 每个 turn 生成唯一 taskID（如 `${session}:${Date.now()}`），task_started/needs_approval/task_completed 在同一 turn 内一致、跨 turn 唯一。改动更大，但语义更清晰（「一个 taskID = 一次 turn」）。
