# 自动镜像交互模式 真机 E2E 修复清单 (2026-08-19)

自动镜像交互模式（Claude Code `PreToolUse` hook + relay daemon）真机 E2E 四场景已跑通：

| 场景 | 结果 |
|------|------|
| 只读工具静默放行（risk=0 不弹卡） | ✅ |
| Write 单击 approve 执行 | ✅ |
| Bash rm 双击 reject 拒绝 | ✅（有 Bug 2 瑕疵） |
| 超时 auto-allow（120s） | ✅（有 Bug 1 遗留） |

**状态 (2026-08-19)**：功能链路验证通过，但 UI 终结态回传缺失，眼镜卡片无法正确结束。Bug 1 为最高优先级。

---

## Bug 1: Core 审批终结后不回传状态 + 无超时清理（眼镜卡片永久「处理中」）

**文件**: `middleware-core/internal/approval/`（approval manager）、`middleware-core/internal/device/dispatcher.go`、`middleware-core/cmd/server/`

**现象**:
- 眼镜 approve/reject 后，卡片停在「执行中 / 处理中」，不回显最终结果（已批准 / 已拒绝 / 执行完成）。
- 超时 auto-allow 后，Core 端 approval 永久 `pending`，眼镜卡片一直挂起，无任何终结。

**根因**:
1. Core 在 approval `resolved as approved/rejected` 后，没有向眼镜回传终结态事件。眼镜端收到 approve 后只把卡片切到 `executing_card`（「处理中」），此后没有任何事件能把它推到终态（成功/失败/已拒绝）。
2. 超时 auto-allow 发生在 **relay daemon 端**（`agent-adapter/src/relay.ts` 的 `setTimeout` resolve `'allow'`），Core 完全不知道这次审批已超时放行，approval 记录永远 `pending`，无超时清理机制。

**证据**（Core 日志 `bjk1cyd2d.output`）:
- 场景 2：`17:00:27 needs_approval` → `17:00:38 approve` → `resolved as approved`，此后无任何「执行完成」回传。
- 场景 4：`17:04:44 needs_approval` → `17:04:46 view_details` → 无 approve/reject，approval 永久 pending（auto-allow 在 relay 端，Core 无感）。

**修复方向**（待设计确认）:
1. Core 在 approval resolve 后，向眼镜（及 dashboard）广播终结态事件（如 `approval_resolved` 或 `task_completed`/`task_failed`）。
2. Core 增加 approval 超时（对齐 `AGENTBRIDGE_CORE_TIMEOUT`），超时后自动 resolve 为 `auto_allowed` 并广播 + 清理。
3. 眼镜端卡片状态机补终态：approved → 执行中 → 完成/失败；rejected → 已拒绝。

---

## Bug 2: 双击 reject 产生两次 reject action

**文件**: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainActivity.kt`（手势处理）

**现象**: 场景 3 双击 reject，Core 收到两次 `reject`（`17:03:40` + `17:03:41`），第二次报 `approval resolve failed: approval already resolved`。

**根因**: 双击的两次点击都透传到了 Core，眼镜端没有把「双击」合并成一次 reject action（500ms 消抖仅用于区分单击/双击，未拦截第二次上报）。

**修复方向**: 双击识别后只上报一次 reject，吞掉第二次点击；或 Core 端对 `already resolved` 静默（降日志级别）。

---

## 新需求: agent 文字回复摘要回传眼镜（待 brainstorm）

用户期望：工具审批后，agent 在终端产生的文字回复，摘要后回传到眼镜。

技术难点：交互模式 `PreToolUse`/`PostToolUse` hook 只能拿到工具调用 / 工具结果，拿不到 agent 后续生成的文字回复文本（`Stop` hook 也无文本内容）。需单独 brainstorming 定架构（可能回到 `stream-json` 协议，或探索其他捕获机制）。
