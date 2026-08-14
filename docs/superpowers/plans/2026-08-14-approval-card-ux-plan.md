# 审批卡片交互 UX 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让眼镜审批卡在用户 approve/reject 后显示执行反馈并自动清除，同时让 view_details 手势能展开 agent 的 reasoning + 完整工具输入（文件路径/命令）。

**Architecture:** 眼镜本地状态机为主——把 `AgentActionHandler` 的纯状态逻辑抽成 `CardStateMachine`（无 Android 依赖，JUnit 可测），审批后本地切到「执行中/已拒绝」并放松卡片保护；view_details 详情由 adapter 捕获 reasoning + input 随 `needs_approval` 下发，经 Core dispatcher 映射到 `card_details`，眼镜本地 toggle。Core 审批/分发逻辑零改动。

**Tech Stack:** Kotlin (Compose), Go (chi + gorilla/websocket), TypeScript (Node.js, @anthropic-ai/claude-agent-sdk).

## Global Constraints

- 不改 Core 审批/分发逻辑：`approvalMgr`、`relayUserAction`（main.go）保持「只回推 adapter」。
- 不做 Core 端 view_details 回推：`ActionViewDetails` 分支保持 no-op（仅日志）。
- 不启用 `RawEvidence` 既有字段；用 plain `details` 字符串。
- 不新增事件类型、action 类型、设备类型。
- 不改手机端 / 耳机 / dashboard。
- 眼镜端单元测试只能用纯 JUnit（无 Robolectric）；不引入新依赖。
- Adapter 测试框架是 Node 内置 `node --test`（`agent-adapter/src/__tests__/*.test.ts`），不是 jest/vitest。

---

### Task 1: Adapter 捕获 assistant reasoning 并附到 needs_approval

**Files:**
- Modify: `agent-adapter/src/adapters/types.ts:32`（needs_approval 加 `reasoning?`）
- Modify: `agent-adapter/src/adapters/claude.ts:56`（加 `lastAssistantText` 字段）、`:78-79`（send 开头重置）、`:111-118`（消息循环记录 text）、`:239-245`（canUseTool 附 reasoning）
- Test: `agent-adapter/src/__tests__/claude.test.ts`

**Interfaces:**
- Consumes: `mapClaudeSDKMessage`（已导出）、`ClaudeCodeAdapter` 现有 `queryFactory` 注入点。
- Produces: `needs_approval` AgentEvent 新增可选 `reasoning?: string`（Task 2 的 `approvalDetails` 依赖它）。

- [ ] **Step 1: 写失败测试**

在 `claude.test.ts` 顶部已有 `makeQueryFactory`/`permissionDecision`/`sdkInit`/`sdkResult`/`nextValue` 之后追加一个测试与 helper：

```typescript
function sdkAssistant(sessionId: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    session_id: sessionId,
  } as SDKMessage;
}

test('ClaudeCodeAdapter attaches preceding assistant text as reasoning', async () => {
  const decisions: PermissionResult[] = [];
  const adapter = new ClaudeCodeAdapter({
    sessionId: 'session-1',
    queryFactory: makeQueryFactory(async function* (options) {
      yield sdkInit('session-1');
      yield sdkAssistant('session-1', 'I will write the file now.');
      decisions.push(await permissionDecision(options, 'Write', { file_path: 'hello.txt' }, 'req-5'));
      yield sdkResult('session-1', 'wrote file');
    }),
  });

  const iter = adapter.send({ type: 'start_task', text: 'write file', sessionId: 'session-1' })[Symbol.asyncIterator]();

  assert.deepEqual(await nextValue(iter), { type: 'task_started', taskId: 'session-1' });
  assert.deepEqual(await nextValue(iter), { type: 'text', content: 'I will write the file now.' });
  assert.deepEqual(await nextValue(iter), {
    type: 'needs_approval',
    tool: 'Write',
    risk: 0.4,
    taskId: 'session-1',
    input: { file_path: 'hello.txt' },
    reasoning: 'I will write the file now.',
  });

  await adapter.handleUserAction({ type: 'approve', taskId: 'session-1', deviceType: 'glasses' });
  assert.deepEqual(await nextValue(iter), { type: 'task_completed', taskId: 'session-1', summary: 'wrote file' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-adapter && npm run build && node --test dist/__tests__/claude.test.js`
Expected: FAIL — `needs_approval` 实际对象没有 `reasoning` 字段，deepEqual 报 missing `reasoning`。

- [ ] **Step 3: 最小实现**

`adapters/types.ts` 的 needs_approval 联合成员改为：

```typescript
| { type: 'needs_approval'; tool: string; risk: number; taskId?: string; input?: Record<string, unknown>; reasoning?: string }
```

`claude.ts`：

```typescript
// 字段（第 56 行 pendingPermission 附近）
private lastAssistantText = '';
```

```typescript
// send() 里，taskId 赋值之后、currentTaskId 赋值之后（第 78-79 行区域）
const taskId = input.taskId || input.sessionId || this.sessionId;
this.currentTaskId = taskId;
this.lastAssistantText = '';
```

```typescript
// 消息循环（第 113-118 行）
for await (const message of q!) {
  const event = mapClaudeSDKMessage(message, taskId);
  if (event) {
    if (event.type === 'text') {
      this.lastAssistantText = event.content;
    }
    push(event);
  }
}
```

```typescript
// canUseTool 的 emit（第 239-245 行）
this.emit('event', {
  type: 'needs_approval',
  tool: toolName,
  risk,
  taskId,
  input,
  ...(this.lastAssistantText ? { reasoning: this.lastAssistantText } : {}),
} satisfies AgentEvent);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-adapter && npm run build && node --test dist/__tests__/claude.test.js dist/__tests__/risk.test.js dist/__tests__/hub.test.js`
Expected: 全绿（既有 `needs_approval` 测试因条件展开在无 reasoning 时不加字段，仍通过）。

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/src/adapters/types.ts agent-adapter/src/adapters/claude.ts agent-adapter/src/__tests__/claude.test.ts
git commit -m "feat(adapter): needs_approval 携带 assistant reasoning"
```

---

### Task 2: Adapter 生成 needs_approval 的 details 详情载荷

**Files:**
- Modify: `agent-adapter/src/types.ts:20-35`（UnifiedMessage 加 `details?`）
- Modify: `agent-adapter/src/normalizer.ts:140-163`（fromAgentEvent 加 details）、文件底部加 `approvalDetails`
- Modify: `agent-adapter/package.json:9`（test script 加 normalizer.test.js）
- Test: Create `agent-adapter/src/__tests__/normalizer.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `needs_approval.reasoning`。
- Produces: UnifiedMessage 新增可选 `details?: string`（Task 3 Core 侧 `Details` 字段与之对齐）。

- [ ] **Step 1: 写失败测试**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventNormalizer } from '../normalizer.js';
import type { AgentEvent } from '../adapters/types.js';

test('fromAgentEvent generates details for needs_approval', () => {
  const normalizer = new EventNormalizer('session-1');
  const result = normalizer.fromAgentEvent({
    type: 'needs_approval',
    tool: 'Bash',
    risk: 0.3,
    taskId: 'session-1',
    input: { command: 'rm regression_test.txt' },
    reasoning: 'I will remove the leftover file.',
  });

  assert.equal(result.event_type, 'needs_approval');
  assert.match(result.details ?? '', /I will remove the leftover file\./);
  assert.match(result.details ?? '', /Command: rm regression_test\.txt/);
  assert.match(result.details ?? '', /Tool input:/);
});

test('fromAgentEvent leaves details empty for non-approval events', () => {
  const normalizer = new EventNormalizer('session-1');
  const result = normalizer.fromAgentEvent({ type: 'task_completed', taskId: 'session-1', summary: 'done' });
  assert.equal(result.details ?? '', '');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-adapter && npm run build && node --test dist/__tests__/normalizer.test.js`
Expected: FAIL — `result.details` 为 `undefined`（`?? ''` 兜底成 `''`，`assert.match('', /.../)` 失败），且编译期 UnifiedMessage 无 `details` 字段。

- [ ] **Step 3: 最小实现**

`types.ts` 的 `UnifiedMessage` 在 `body: string;` 之后加：

```typescript
  details?: string;
```

`normalizer.ts` 的 `fromAgentEvent` 返回对象里，`body` 之后加：

```typescript
      details: event.type === 'needs_approval' ? approvalDetails(event) : '',
```

`normalizer.ts` 文件底部（`approvalBody` 之后）加：

```typescript
function approvalDetails(event: Extract<AgentEvent, { type: 'needs_approval' }>): string {
  const lines: string[] = [];
  if (event.reasoning) {
    lines.push(event.reasoning);
  }
  const command = event.input && 'command' in event.input ? String(event.input.command) : '';
  if (command) {
    lines.push(`Command: ${command}`);
  }
  if (event.input && Object.keys(event.input).length > 0) {
    lines.push(`Tool input: ${JSON.stringify(event.input)}`);
  }
  return lines.join('\n');
}
```

`package.json` 的 `test` script 末尾追加 ` dist/__tests__/normalizer.test.js`：

```json
"test": "npm run build && node --test dist/__tests__/risk.test.js dist/__tests__/claude.test.js dist/__tests__/hub.test.js dist/__tests__/normalizer.test.js"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-adapter && npm test`
Expected: 全绿（4 个测试文件）。

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/src/types.ts agent-adapter/src/normalizer.ts agent-adapter/src/__tests__/normalizer.test.ts agent-adapter/package.json
git commit -m "feat(adapter): 生成 needs_approval details 详情载荷"
```

---

### Task 3: Core 贯通 details / card_details 到眼镜 DeviceOutput

**Files:**
- Modify: `middleware-core/internal/domain/types.go:90`（UnifiedMessage 加 `Details`）、`:118`（DeviceOutput 加 `CardDetails`）
- Modify: `middleware-core/internal/device/dispatcher.go:110-133`（glassNeedsApproval 填 CardDetails）
- Test: `middleware-core/internal/device/dispatcher_test.go`

**Interfaces:**
- Consumes: Task 2 的 `details` 字段（wire 上 `"details"`）。
- Produces: `DeviceOutput.CardDetails`（`json:"card_details"`，Task 4 眼镜端 `cardDetails` 与之对齐）。

- [ ] **Step 1: 写失败测试**

在 `dispatcher_test.go` 里 `TestForGlass_NeedsApproval_RiskScoreDisplay` 之后加：

```go
func TestForGlass_NeedsApproval_PopulatesCardDetails(t *testing.T) {
	d := NewDispatcher()
	actions := []domain.AvailableAction{
		{ActionType: "approve", Label: "Approve"},
		{ActionType: "reject", Label: "Reject"},
	}
	msg := newMsg(domain.EventNeedsApproval, "Approval required: Write", "Risk score: 0.4\nCommand: rm foo\nTool input: {...}", domain.SeverityWarning, 0.4, actions)
	msg.Details = "I will remove foo\nCommand: rm foo\nTool input: {\"command\":\"rm foo\"}"

	out := d.forGlass(msg)

	if out.CardDetails != msg.Details {
		t.Errorf("CardDetails = %q, want %q", out.CardDetails, msg.Details)
	}
	if contains(out.CardBody, "Command:") {
		t.Errorf("CardBody = %q, should stay a short summary (no Command line)", out.CardBody)
	}
}

func TestForGlass_NeedsApproval_CardDetailsFallsBackToBody(t *testing.T) {
	d := NewDispatcher()
	msg := newMsg(domain.EventNeedsApproval, "Op", "Do something", domain.SeverityWarning, 0.3, nil)

	out := d.forGlass(msg)

	if out.CardDetails == "" {
		t.Error("CardDetails should fall back to Body when Details is empty")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd middleware-core && go test ./internal/device/ -run TestForGlass_NeedsApproval_PopulatesCardDetails -v`
Expected: FAIL — 编译错误 `msg.Details undefined` / `out.CardDetails undefined`。

- [ ] **Step 3: 最小实现**

`domain/types.go`：

```go
// UnifiedMessage，在 Body 之后加：
	Details          string            `json:"details,omitempty"`
```

```go
// DeviceOutput，在 CardBody 之后加：
	CardDetails  string   `json:"card_details,omitempty"`
```

`dispatcher.go` 的 `glassNeedsApproval` 里，`return` 之前加：

```go
	details := msg.Details
	if details == "" {
		details = msg.Body
	}
```

并把 `DeviceOutput{...}` 加 `CardDetails: details,`（放在 `CardBody` 之后）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd middleware-core && go test ./...`
Expected: 全绿（含既有 machine/dispatcher/risk/approval 测试）。

- [ ] **Step 5: Commit**

```bash
git add middleware-core/internal/domain/types.go middleware-core/internal/device/dispatcher.go middleware-core/internal/device/dispatcher_test.go
git commit -m "feat(core): 贯通 details/card_details 到眼镜 DeviceOutput"
```

---

### Task 4: 眼镜端新增协议字段 + 抽取 CardStateMachine 纯状态机

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeProtocol.kt:18-31`（UnifiedMessage 加 `details`）、`:39-46`（DeviceOutput 加 `cardDetails`）、`:63-75`（AgentCardState 加 `decision`/`details`/`detailsVisible`）
- Create: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardStateMachine.kt`
- Test: Create `rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/CardStateMachineTest.kt`

**Interfaces:**
- Consumes: `DeviceOutput.cardDetails`（Task 3）、`UnifiedMessage.details`。
- Produces: `CardStateMachine.reduce(current, message, duplicate): Reduction`（`Reduction(state, ttsText)`）、`onDecision`、`onViewDetails`、`resetToIdle`、`renderHintFor`（Task 5 的 `AgentActionHandler` 依赖）。

- [ ] **Step 1: 写失败测试**

```kotlin
package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CardStateMachineTest {

    private fun approvalMessage(details: String = "Command: rm foo\nTool input: {...}"): DeviceMessage =
        DeviceMessage(
            messageId = "m1",
            sessionId = "default",
            seq = 1,
            event = UnifiedMessage(
                taskId = "default",
                eventType = "needs_approval",
                title = "Approval required: Write",
                body = "Risk score: 0.4",
                details = details,
            ),
            deviceOverrides = mapOf(
                DEVICE_TYPE_AR_GLASSES to DeviceOutput(
                    cardTitle = "⛔ 审批: Approval required: Write",
                    cardBody = "风险: 40% | Risk score: 0.4",
                    cardDetails = details,
                    quickActions = listOf("approve", "reject"),
                    renderHint = "actionable_card",
                )
            )
        )

    private fun statusMessage(seq: Long, eventType: String, title: String, body: String) = DeviceMessage(
        messageId = "m$seq",
        sessionId = "default",
        seq = seq,
        event = UnifiedMessage(taskId = "default", eventType = eventType, title = title, body = body),
        deviceOverrides = mapOf(
            DEVICE_TYPE_AR_GLASSES to DeviceOutput(cardTitle = title, cardBody = body, renderHint = "status_card")
        )
    )

    @Test
    fun reduce_setsActionableCard_withEmptyDecision() {
        val result = CardStateMachine.reduce(AgentCardState(), approvalMessage(), duplicate = false)
        assertEquals("actionable_card", result.state.renderHint)
        assertEquals("", result.state.decision)
        assertEquals("Command: rm foo\nTool input: {...}", result.state.details)
    }

    @Test
    fun reduce_preservesActionableCard_whenStatusEventArrivesBeforeDecision() {
        val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
        val result = CardStateMachine.reduce(approval, statusMessage(2, "task_running", "◉ Agent output", "working"), false)
        assertEquals("actionable_card", result.state.renderHint)
    }

    @Test
    fun reduce_allowsTaskRunningAfterDecision() {
        val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
        val decided = CardStateMachine.onDecision(approval, "approve")
        assertEquals("executing_card", decided.renderHint)
        val result = CardStateMachine.reduce(decided, statusMessage(3, "task_running", "◉ Agent output", "writing..."), false)
        assertEquals("status_card", result.state.renderHint)
        assertEquals("approve", result.state.decision)
    }

    @Test
    fun reduce_allowsTaskCompletedWithoutDecision() {
        val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
        val result = CardStateMachine.reduce(approval, statusMessage(4, "task_completed", "✓ Task completed", "done"), false)
        assertEquals("status_card", result.state.renderHint)
    }

    @Test
    fun onDecision_rejectProducesRejectedCard() {
        val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
        val rejected = CardStateMachine.onDecision(approval, "reject")
        assertEquals("rejected_card", rejected.renderHint)
        assertEquals("reject", rejected.decision)
    }

    @Test
    fun onViewDetails_togglesDetailsVisible() {
        val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
        assertFalse(approval.detailsVisible)
        assertTrue(CardStateMachine.onViewDetails(approval).detailsVisible)
        assertFalse(CardStateMachine.onViewDetails(CardStateMachine.onViewDetails(approval)).detailsVisible)
    }

    @Test
    fun onViewDetails_noopWhenDetailsEmpty() {
        assertFalse(CardStateMachine.onViewDetails(AgentCardState(details = "")).detailsVisible)
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:testDebugUnitTest --tests "com.rokid.cxrswithcxrl.agent.CardStateMachineTest"`
Expected: FAIL — 编译错误（`CardStateMachine` 不存在 / `UnifiedMessage.details`、`DeviceOutput.cardDetails`、`AgentCardState.decision/details/detailsVisible` 未定义）。

- [ ] **Step 3: 最小实现**

`AgentBridgeProtocol.kt`：

```kotlin
// UnifiedMessage，在 body 之后加：
    @SerializedName("details") val details: String = "",
```

```kotlin
// DeviceOutput，在 cardBody 之后加：
    @SerializedName("card_details") val cardDetails: String = "",
```

```kotlin
// AgentCardState，在 quickActions 之前加：
    val decision: String = "",
    val details: String = "",
    val detailsVisible: Boolean = false,
```

新建 `CardStateMachine.kt`：

```kotlin
package com.rokid.cxrswithcxrl.agent

object CardStateMachine {

    data class Reduction(val state: AgentCardState, val ttsText: String)

    private val CARD_PRESERVED_EVENTS = setOf("task_started", "task_running", "heartbeat")

    fun reduce(current: AgentCardState, message: DeviceMessage, duplicate: Boolean): Reduction {
        if (duplicate) {
            return Reduction(
                current.copy(
                    duplicateCount = current.duplicateCount + 1,
                    statusLine = "duplicate ignored, lastAckedSeq=${current.lastAckedSeq}"
                ),
                ""
            )
        }

        val event = message.event
        val output = message.deviceOverrides?.get(DEVICE_TYPE_AR_GLASSES)
        val fallbackActions = event?.availableActions?.mapNotNull { it.actionType.takeIf(String::isNotBlank) }.orEmpty()
        val quickActions = if (event?.riskBlocked == true) {
            listOf("view_details")
        } else {
            output?.quickActions?.takeIf { it.isNotEmpty() } ?: fallbackActions
        }
        val title = output?.cardTitle?.takeIf { it.isNotBlank() } ?: event?.title ?: "AgentBridge"
        val baseBody = output?.cardBody?.takeIf { it.isNotBlank() } ?: event?.body ?: ""
        val body = if (event?.riskBlocked == true) {
            "High risk action blocked on glasses. Return to PC to confirm.\n$baseBody"
        } else {
            baseBody
        }
        val renderHint = output?.renderHint?.takeIf { it.isNotBlank() } ?: renderHintFor(event?.eventType, event?.severity)
        val details = output?.cardDetails?.takeIf { it.isNotBlank() } ?: event?.details ?: ""

        if (current.renderHint == "actionable_card"
            && current.decision.isEmpty()
            && event?.eventType != "task_completed"
            && (renderHint == "status_card" || event?.eventType in CARD_PRESERVED_EVENTS)
        ) {
            return Reduction(
                current.copy(
                    lastAckedSeq = message.seq.coerceAtLeast(current.lastAckedSeq),
                    statusLine = "seq=${message.seq}, replay=${message.isReplay}, card preserved"
                ),
                ""
            )
        }

        val severity = event?.severity ?: current.severity
        val newState = AgentCardState(
            connectionLabel = current.connectionLabel,
            title = title,
            body = body,
            renderHint = renderHint,
            severity = severity,
            taskId = event?.taskId.orEmpty(),
            quickActions = quickActions,
            lastAckedSeq = message.seq.coerceAtLeast(current.lastAckedSeq),
            isReplay = message.isReplay,
            duplicateCount = current.duplicateCount,
            statusLine = "seq=${message.seq}, replay=${message.isReplay}, event=${event?.eventType ?: "unknown"}",
            decision = if (event?.eventType == "needs_approval") "" else current.decision,
            details = details,
            detailsVisible = if (event?.eventType == "needs_approval") false else current.detailsVisible
        )

        val ttsText = if (event?.riskBlocked == true) {
            "高风险操作需要回到电脑确认"
        } else {
            output?.ttsText?.takeIf { it.isNotBlank() } ?: title
        }

        return Reduction(newState, ttsText)
    }

    fun onDecision(current: AgentCardState, action: String): AgentCardState = when (action) {
        "approve" -> current.copy(
            renderHint = "executing_card",
            title = "⏳ 执行中",
            body = "已批准，等待 agent 输出…",
            quickActions = emptyList(),
            decision = "approve"
        )
        "reject" -> current.copy(
            renderHint = "rejected_card",
            title = "⛔ 已拒绝",
            body = "已拒绝该操作，等待 agent 回复…",
            quickActions = emptyList(),
            decision = "reject"
        )
        else -> current
    }

    fun onViewDetails(current: AgentCardState): AgentCardState =
        if (current.details.isNotBlank()) current.copy(detailsVisible = !current.detailsVisible) else current

    fun resetToIdle(current: AgentCardState): AgentCardState =
        AgentCardState(connectionLabel = current.connectionLabel)

    fun renderHintFor(eventType: String?, severity: String?): String = when {
        eventType == "needs_approval" -> "actionable_card"
        severity == "critical" -> "alert_card"
        else -> "status_card"
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:testDebugUnitTest --tests "com.rokid.cxrswithcxrl.agent.CardStateMachineTest"`
Expected: 7 个测试全绿。

- [ ] **Step 5: Commit**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeProtocol.kt rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardStateMachine.kt rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/CardStateMachineTest.kt
git commit -m "refactor(glasses): 抽取 CardStateMachine 纯状态机 + 协议详情字段"
```

---

### Task 5: AgentActionHandler 接入状态机（Feature 1 执行反馈 + 手势统一）

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentActionHandler.kt`

**Interfaces:**
- Consumes: `CardStateMachine`（Task 4）的全部方法。
- Produces: 对外行为不变（`reduce`/`onKey`/`onGestureResult`/`onConnectionChanged`/`close` 签名不变）。

- [ ] **Step 1: 写失败测试**（无新增单测——纯 Android 副作用层；靠 Task 4 的 CardStateMachine 测试兜底，行为用 Step 4 真机验证。此任务无需新测试文件。）

- [ ] **Step 2: 删除旧的 reduce/onKey/onGestureResult 内联逻辑**

把 `AgentActionHandler` 里 `reduce()`（`:25-86`）、`onKey()`（`:93-117`）、`onGestureResult()`（`:119-128`）、`renderHintFor()`（`:146-152`）、`CARD_PRESERVED_EVENTS`（`:156`）替换为委托 `CardStateMachine` 的版本。

- [ ] **Step 3: 实现委托 + 副作用层**

```kotlin
class AgentActionHandler(
    context: Context,
    private val actionSender: (taskId: String, actionType: String) -> Boolean
) : TextToSpeech.OnInitListener {
    private val appContext = context.applicationContext
    private var textToSpeech: TextToSpeech? = TextToSpeech(appContext, this)
    private var ttsReady = false
    private var currentState = AgentCardState()
    private val clearHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var clearRunnable: Runnable? = null

    // onInit 不变

    fun reduce(message: DeviceMessage, duplicate: Boolean): AgentCardState {
        val reduction = CardStateMachine.reduce(currentState, message, duplicate)
        currentState = reduction.state

        val eventType = message.event?.eventType
        if (eventType == "task_completed" && !duplicate) {
            scheduleAutoClear()
        } else if (eventType == "task_started" || eventType == "needs_approval") {
            cancelAutoClear()
        }

        if (!message.isReplay && reduction.ttsText.isNotBlank()) {
            speak(reduction.ttsText)
        }
        return currentState
    }

    fun onConnectionChanged(label: String): AgentCardState {
        currentState = CardStateMachine.resetToIdle(currentState).copy(connectionLabel = label)
        return currentState
    }

    fun onKey(keyType: KeyType): AgentCardState {
        val action = when (keyType) {
            KeyType.CLICK -> pickAction(0) ?: "continue"
            KeyType.DOUBLE_CLICK -> pickAction(1) ?: "pause"
            KeyType.ACTION_TWO_FINGER_SINGLE_TAP -> pickAction(0) ?: "continue"
            KeyType.ACTION_TWO_FINGER_DOUBLE_TAP -> pickAction(1) ?: "pause"
            KeyType.ACTION_TWO_FINGER_SWIPE_FORWARD -> "continue"
            KeyType.ACTION_TWO_FINGER_SWIPE_BACK -> "pause"
            else -> null
        }
        if (action == null) return currentState

        val sent = actionSender(currentState.taskId, action)
        if (sent) {
            currentState = CardStateMachine.onDecision(currentState, action)
        }
        currentState = currentState.copy(
            statusLine = if (sent) "sent action=$action, lastAckedSeq=${currentState.lastAckedSeq}" else "action=$action not sent"
        )
        return currentState
    }

    fun onGestureResult(actionType: String, sent: Boolean): AgentCardState {
        if (sent) {
            currentState = when (actionType) {
                "view_details" -> CardStateMachine.onViewDetails(currentState)
                else -> CardStateMachine.onDecision(currentState, actionType)
            }
        }
        currentState = currentState.copy(
            statusLine = if (sent) "sent action=$actionType, lastAckedSeq=${currentState.lastAckedSeq}" else "action=$actionType not sent"
        )
        return currentState
    }

    private fun scheduleAutoClear() {
        clearRunnable?.let { clearHandler.removeCallbacks(it) }
        val runnable = Runnable { currentState = CardStateMachine.resetToIdle(currentState) }
        clearRunnable = runnable
        clearHandler.postDelayed(runnable, 3000L)
    }

    private fun cancelAutoClear() {
        clearRunnable?.let { clearHandler.removeCallbacks(it) }
        clearRunnable = null
    }

    // close() / pickAction() / speak() 不变
}
```

- [ ] **Step 4: 编译 + 现有单测确认**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:testDebugUnitTest`
Expected: CardStateMachineTest 全绿，无编译错误。

- [ ] **Step 5: Commit**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentActionHandler.kt
git commit -m "feat(glasses): 审批后执行反馈 + 手势统一为滑动 view_details"
```

---

### Task 6: CardRenderer 渲染（反馈卡配色 + view_details 详情 + actionHint 修正）

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardRenderer.kt`

**Interfaces:**
- Consumes: `AgentCardState.decision`/`details`/`detailsVisible`/`renderHint`（Task 4）。

- [ ] **Step 1-2: 无单测（Compose UI，真机验证）；直接改渲染逻辑**

`containerColor`（`:130-137`）改为：

```kotlin
private fun containerColor(card: AgentCardState): Color {
    return when {
        card.renderHint == "alert_card" || card.severity == "critical" -> Color(0xFF6D2932)
        card.renderHint == "actionable_card" -> Color(0xFF224C3A)
        card.renderHint == "executing_card" -> Color(0xFF1F3A5F)
        card.renderHint == "rejected_card" -> Color(0xFF5C2A2A)
        card.severity == "warning" -> Color(0xFF5C4A1F)
        else -> Color(0xFF1F2933)
    }
}
```

`AgentCard`（`:86-128`）的 body `Text` 改为按 `detailsVisible` 切换内容与行数：

```kotlin
Text(
    text = if (card.detailsVisible && card.details.isNotBlank()) card.details else card.body,
    color = Color(0xFFE8EAED),
    style = MaterialTheme.typography.bodyLarge,
    maxLines = if (card.detailsVisible) 10 else 4,
    overflow = TextOverflow.Ellipsis
)
```

`actionHint`（`:139-143`）改为：

```kotlin
private fun actionHint(card: AgentCardState): String {
    return when (card.renderHint) {
        "executing_card" -> "处理中…"
        "rejected_card" -> "已拒绝"
        else -> {
            val click = card.quickActions.getOrNull(0) ?: "continue"
            val doubleClick = card.quickActions.getOrNull(1) ?: "pause"
            "CLICK: $click    DOUBLE: $doubleClick    SWIPE: view_details"
        }
    }
}
```

- [ ] **Step 3: 编译确认**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:compileDebugKotlin`
Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardRenderer.kt
git commit -m "feat(glasses): view_details 详情渲染 + 反馈卡配色"
```

---

### Task 7: 真机 E2E 验证（spec §10 验收矩阵）

**Files:** 无代码改动；仅验证。

按 `docs/superpowers/specs/2026-08-14-approval-card-ux-design.md` §10 的 5 场景真机跑一遍（眼镜 WiFi LAN 直连 `ws://192.168.31.209:8088`，Core 用 `AGENTBRIDGE_ADDR=":8088"`，adapter 用 `AGENTBRIDGE_SESSION=default`）：

| # | 场景 | 预期 |
|---|------|------|
| 1 | 写文件 → 单击 approve | 审批 →「⏳ 执行中」→「◉ Agent output」→「✓ 完成」→ 3s 后消失 |
| 2 | 删除 → 双击 reject | 审批 →「⛔ 已拒绝」→ agent 回复 →「✓ 完成」→ 消失 |
| 3 | 审批中滑动 | 展开详情（reasoning + 命令 + 文件路径）；再滑动收回；单击/双击仍可审批 |
| 4 | 只读工具自动放行 | 无审批卡，直接「◉ Agent output」→「✓ 完成」→ 消失 |
| 5 | 超时自动放行（无手势） | 审批卡冻结期间任务完成后经 task_completed 兜底清除 |

全部通过后，更新 `CLAUDE.md`「Phase 3a」状态段落与 memory 里的 `project_status.md`。

- [ ] **Step 1: 场景 1-2 验证**（approve/reject 反馈卡）
- [ ] **Step 2: 场景 3 验证**（view_details 详情 toggle）
- [ ] **Step 3: 场景 4-5 验证**（自动放行 + 超时兜底）
- [ ] **Step 4: 更新文档与记忆**

---

## 自检（Self-Review）

**Spec 覆盖**：Feature 1（执行反馈）= Task 4/5/6；Feature 2（view_details）= Task 1/2/3/4/6；手势统一 = Task 5/6；验收矩阵 = Task 7。全部覆盖。

**Placeholder 扫描**：无 TBD/TODO；每个代码步骤含实际代码块。Task 5 无新单测是刻意的（Android 副作用层），其行为由 Task 4 的纯逻辑测试 + Task 7 真机覆盖，已在任务内说明。

**类型一致性**：
- `reasoning?`（adapters/types.ts）→ `approvalDetails` 读 `event.reasoning` ✓
- `details`（TS UnifiedMessage）→ Go `Details json:"details"` → Kotlin `@SerializedName("details") details` ✓
- `CardDetails json:"card_details"` → Kotlin `@SerializedName("card_details") cardDetails` ✓
- `CardStateMachine.Reduction(state, ttsText)` 在 Task 4 定义、Task 5 消费 ✓
- `onDecision`/`onViewDetails`/`resetToIdle`/`renderHintFor` 签名一致 ✓
