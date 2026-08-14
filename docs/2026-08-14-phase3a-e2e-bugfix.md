# Phase 3a 真机 E2E 修复清单 (2026-08-14)

真机链路 `claude 工具调用 → canUseTool 风控 → needs_approval 卡片 → Core → 眼镜(WiFi LAN) → 手势 → Core → adapter → allow/deny → 工具执行/拒绝` 已跑通，spec §9.3 四场景全部通过。测试中发现 3 个 bug + 1 个可移植性缺口，供 Codex 修复。

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
