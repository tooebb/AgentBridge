# 线 B 会话交接（Session Handoff）设计文档

> 状态：已批准（2026-08-23）。本 spec 覆盖「PC 开 claude 项目任务 → 出门（同一 WiFi/LAN）→ 眼镜语音 resume 同一个会话继续 vibe coding」。

**Goal:** 让眼镜语音输入不再驱动一个独立的 headless 会话，而是 `resume` 用户在 PC 终端里已经开好的那个项目会话，实现「PC 开任务、眼镜接着跑、审批照旧镜像到眼镜」的顺序交接。

**Architecture:** daemon 起 claude 时把 `cwd` 指向项目根目录，并在首句 `query` 时 `resume` 该项目最近一次会话（按 `.jsonl` 文件 mtime 取最新）。审批链路（canUseTool → needs_approval → 眼镜 approve/reject）不变。

**Tech Stack:** TypeScript (agent-adapter，唯一改动面) / Claude Code SDK（`query({ resume })`）/ Node fs。Core、眼镜、AgentBridgeClient 协议零改动。

## 全局约束

- **不改 Core 协议**：middleware-core 零改动。
- **不改 AgentBridgeClient 消息协议**：`DeviceMessage`/`UnifiedMessage` 字段不变。
- **审批链路不变**：`needs_approval` → approve/reject → 工具执行的既有链路不被触碰（线 B 已用 SDK `canUseTool`，复用即可）。
- **顺序交接，非并发**：一个 Claude 会话同一时间只被一个进程驱动。PC 终端 claude 退出（session 落盘 + 释放锁）后，眼镜 daemon 才 resume。不支持「终端和眼镜同时驱动同一会话」。
- **网络范围 = 同一 WiFi/LAN**：眼镜与 PC 同网（mDNS 直连成立）。异地/不同网络中继是后续独立工作，本 spec 不覆盖。

## 关键发现（设计依据）

1. **会话落盘格式**：Claude Code 会话存在 `~/.claude/projects/<编码后的cwd>/<uuid>.jsonl`，文件名即 session id。已在本机实测确认：
   - `D:\project\5project\AgentBridge-master` → `D--project-5project-AgentBridge-master`
   - `D:\project\5project\AgentBridge-master\agent-adapter` → `D--project-5project-AgentBridge-master-agent-adapter`
   - 编码规则：`:` 和 `\` 都替换为 `-`。
2. **cwd 错位是当前「接不上」的直接原因**：`claude.ts` 的 `cwd: process.cwd()` 让 daemon 的 headless 会话落在 `...-AgentBridge-master-agent-adapter/`（agent-adapter 子目录），而用户 PC 终端会话在 `...-AgentBridge-master/`（项目根）。两套会话分属不同 cwd，互不可见。
3. **resume 跨轮续会话已验证**：spike 已确认 `query({ options: { resume: sessionId } })` 续会话，上下文保留（第 2 轮记得第 1 轮数字）。跨进程（终端 session → daemon resume）依赖同一个磁盘 session 文件，原理成立，见「验证点」。
4. **当前 `resume` 只续 daemon 自己的会话**：`claude.ts` 的 `options.resume = this.lastSessionId`，`lastSessionId` 来自 daemon 自己首轮 `query` 返回的 `session_id`，存在内存里、重启即丢，且不是 PC 终端那个 session。

## 数据流

```
PC 上:  cd 项目 && claude  → 任务跑在 ~/.claude/projects/<编码cwd>/<uuid>.jsonl
        想出门了 → Ctrl+C 退出（session 落盘 + 释放锁）

出门:   眼镜语音 → STT → daemon
        首句: query({ cwd: 项目根, resume: 最新 uuid })   ← 本 spec 新增
        后续: query({ resume: lastSessionId })              ← 现有逻辑
        canUseTool 审批 → 眼镜 approve/reject（不变）
```

---

## 改动 1：session 解析模块（新建）

### 文件

**新建 `agent-adapter/src/session-resolver.ts`**

两个纯函数，无副作用、易单测：

```typescript
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// cwd -> ~/.claude/projects 下的目录名。规则：'\\' 和 ':' 都替换为 '-'。
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[\\:]/g, '-');
}

export function resolveLatestSessionId(
  cwd: string,
  projectsRoot: string = join(homedir(), '.claude', 'projects'),
): string | null {
  const dir = join(projectsRoot, encodeProjectDir(cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null; // 项目还没有任何会话
  }
  let latest: { id: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    try {
      const mtime = statSync(file).mtimeMs;
      if (!latest || mtime > latest.mtime) {
        latest = { id: name.slice(0, -'.jsonl'.length), mtime };
      }
    } catch {
      // 单个文件读不到就跳过
    }
  }
  return latest?.id ?? null;
}
```

- `encodeProjectDir` 用已观测的真实样例做断言（见测试策略）。
- `resolveLatestSessionId` 无会话目录/无 `.jsonl` 时返回 `null`（→ 全新 session）。
- 编码规则只覆盖 ASCII 路径（本机项目均在 `D:\project\...`），非 ASCII（空格/中文）未验证，spec 标注为已知边界。

## 改动 2：`ClaudeCodeAdapter` 支持 cwd + 初始 resume

### 文件

**改 `agent-adapter/src/adapters/claude.ts`**

1. 构造器新增两个可选项，env 兜底：
   ```typescript
   export interface ClaudeAdapterOptions {
     // ...现有字段
     cwd?: string;
     initialSessionId?: string;
   }

   // 构造器内：
   this.cwd = options.cwd || process.env.AGENTBRIDGE_CWD || process.cwd();
   this.initialSessionId = options.initialSessionId || process.env.AGENTBRIDGE_RESUME_SESSION || null;
   ```
   新增私有字段 `private readonly cwd: string;` 和 `private readonly initialSessionId: string | null;`。

2. `send()` 里把 `cwd` 用上，并让首句 resume 目标按优先级解析：
   ```typescript
   const options: Options = {
     abortController,
     canUseTool: this.canUseTool,
     cwd: this.cwd,                         // 原 process.cwd() 改为 this.cwd
     env: claudeRuntimeEnv(),
     pathToClaudeCodeExecutable: this.claudePath,
     permissionMode: 'default',
   };
   if (input.type === 'user_message') {
     const resume = this.lastSessionId
       ?? this.initialSessionId
       ?? resolveLatestSessionId(this.cwd);
     if (resume) options.resume = resume;
   }
   ```
   优先级：本轮已续的 `lastSessionId` > 显式 `initialSessionId` > 项目最近会话。三者皆空则全新 `query`（无 resume）。

## 改动 3：daemon 透传（session.ts 无需改动）

### 结论

`ClaudeCodeAdapter` 在构造器里直接读 env（`AGENTBRIDGE_CWD` / `AGENTBRIDGE_RESUME_SESSION`）作为 options 的兜底，同时保留 options 显式注入（供测试用）。因此 **`session.ts` 的 `main()` 无需改动**——它仍用 `new ClaudeCodeAdapter({ claudePath, sessionId })`，adapter 内部自行解析 cwd 与初始会话。协议不受影响。

## 运行方式

```bash
cd agent-adapter
AGENTBRIDGE_CWD="D:\project\5project\AgentBridge-master" \
AGENTBRIDGE_AUDIO_PORT=8788 \
AGENTBRIDGE_SESSION=default \
npm run start:session
```

- `AGENTBRIDGE_CWD` 必填，指向要 vibe coding 的项目根（daemon 的 claude 在此目录跑，session 也在该 cwd 下定位）。
- `AGENTBRIDGE_RESUME_SESSION` 可选，回到某个旧会话时显式指定。
- 不设 `AGENTBRIDGE_CWD` 时退化为现状（`process.cwd()` = agent-adapter 目录）。

## 验证点

- **跨进程 resume**：PC 终端 claude 退出后，daemon 用 SDK `resume` 该项目最近会话，能否干净续上并继续写同一个 session 文件。这是本 spec 唯一的真机验证点，属 10 分钟 spike 级别，原理上成立（同一磁盘 session 文件），但需实测确认锁已释放。

## 测试策略

- **`session-resolver.test.ts`**（Node，`node --test`）：
  - `encodeProjectDir` 用已观测样例断言：`encodeProjectDir('D:\\project\\5project\\AgentBridge-master') === 'D--project-5project-AgentBridge-master'`，以及 `...\\agent-adapter` 变体。
  - `resolveLatestSessionId`：mock 一个临时 `projectsRoot/<编码>/` 目录，放两个不同 mtime 的 `.jsonl`，断言返回 mtime 最新者的 uuid；空目录/不存在目录返回 `null`。
- **`claude.test.ts` 增补**：注入 `queryFactory` 假工厂，断言首句 `user_message` 时 `options.resume` 等于注入的 `initialSessionId` 或解析出的最近会话、`options.cwd` 等于注入 cwd；第二句用 `lastSessionId` 续。
- **真机 E2E（手动）**：PC 终端 `cd 项目 && claude` 说一句生成会话 → 退出 → 起 daemon（带 `AGENTBRIDGE_CWD`）→ 眼镜语音说「接着刚才的任务…」→ 观察回复是否延续 PC 会话上下文。

## 非目标

- 异地/不同网络中继（公网穿透、隧道），后续独立设计。
- TTS 语音朗读（眼镜音频输出仍 broken）。
- 并发双输入（终端与眼镜同时驱动同一会话）。
- 多项目同时运行/会话选择 UI（本次只做「单项目 + 自动续最近 + 显式覆盖」）。
