# AgentBridge 日常使用手册

眼镜作为 Claude Code 的语音/审批控制台：语音发起会话、手势审批工具，出门/回家双向接力同一个会话。

## 角色与前置

| 设备 | 作用 |
|------|------|
| PC | Core(:8088) + STT(:8790) + session daemon(:8788 音频) + Claude Code 终端 |
| 手机 | CXR 生命周期：**每次冷启动点一次**「启动眼镜 App」 |
| 眼镜 | 数据面：mDNS 无线连 Core；语音输入 + 手势审批 |

## 一、冷启动（关机 → 可用）

1. 眼镜开机（重启后系统会关 WiFi）
2. 开眼镜 WiFi 一次：watchdog 自动 `svc wifi enable`，或手动 adb。App 起来后 WiFiLock 锁住 WiFi，之后纯无线、不用再开
3. 手机连眼镜 → CXRLSample 点「启动眼镜 App」（CXR appStart）
4. PC 一条命令起底座+会话：

   ```powershell
   .\scripts\start-all.ps1
   ```

   自动：Core + STT(首次 ~15s 载模型) + watchdog + session.js；等日志出现 `audio server listening on :8788`

5. 眼镜自动连 Core（NsdManager 发现 PC 的 mDNS，无线直连，无需填 IP）

## 二、出门接力（PC → 眼镜）

1. PC 终端 Ctrl+C 停掉 `claude`（释放会话 `.jsonl` 锁）
2. 确认 Core 还在：`netstat -ano | findstr :8088`
3. 项目根跑：`.\scripts\start-session.ps1` → 自动 resume 落盘会话，前台跑 session.js
4. 眼镜连上即可继续

## 三、回家接力（眼镜 → PC）

1. 停掉 session.js daemon（在 start-session 那个窗口 Ctrl+C）
   - ⚠️ 该脚本会把提示符留在 `agent-adapter`，先 `cd ..` 回项目根
2. 项目根跑：`.\scripts\resume-glasses.ps1` → 读 `.agentbridge-current-session` → `claude -r <id>`，PC 终端接回会话
3. 在 PC 终端继续

## 四、切换项目（不重启底座）

```powershell
# Ctrl+C 停当前会话 → cd 目标项目 →
.\scripts\start-session.ps1
```

Core/STT/watchdog 不动，只切 session.js 的项目 cwd。

## 五、关底座

```powershell
.\scripts\stop-core.ps1   # 停 watchdog+STT+Core（session.js 单独 Ctrl+C）
```

## 关键约束（踩过的坑）

- **接力是顺序的，不是并发的**：同一会话 `.jsonl` 不能被两个进程同时写，切换前先停掉 hold 会话的进程
- 两个脚本 + `.agentbridge-current-session` 都在**项目根**，不在 agent-adapter
- `start-session.ps1` 跑完提示符留在 agent-adapter，回家接力前先 `cd ..`
- Core 是常驻服务，跟窗口无关；判断标准是 `netstat -ano | findstr :8088`

## 无线相关提醒

`svc wifi enable` 依赖 ADB 够得着眼镜。若要**全程无 USB**，第一次开 WiFi 得趁眼镜 USB 插着时开、或先 `adb connect <眼镜IP>` 转 adb-over-wifi；App 起来后用 WiFiLock 锁住 WiFi，之后就能纯无线了。

## 语音 / 手势速查

| 场景 | 手势 |
|------|------|
| 无任务时开始/停止录音 | 单击 |
| 审批卡 approve | 单击 |
| 审批卡 reject | 双击 |
| 展开详情 | 滑动（view_details） |

语音链路：眼镜麦克风 → VAD 切句 → faster-whisper 识别 → 注入 Claude Code 会话 → 文字回传眼镜。当前 TTS 语音输出未通，回复以文字卡片显示。
