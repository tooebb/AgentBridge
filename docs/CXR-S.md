简介



CXR-S SDK 是运行在 YodaOS-Sprite 上的眼镜端开发工具包，专注于帮助开发者直接在 Rokid Glasses 上创建独立应用。它不仅提供访问眼镜端数据通道的能力，还能与移动端的 CXR-M SDK 建立双向通信，支持自定义协议和指令传输。通过 CXR-S SDK，开发者可以更深入地调用硬件资源，释放设备潜能，打造低延迟的智能体验。

# SDK 与Glasses

![SDK 基础结构图](https://ota.rokidcdn.com/toB/Document/CXR/CXR-M%20Final.png)

# 设备连接管理

开发者可以通过Rokid CXR-S SDK实时监测移动端（Android/iOS）设备的连接/断开状态，并且获取 ARTC 数据传输的健康状态。

# 消息通信

开发者可以通过 Rokid CXR-S SDK 订阅移动端发送的指令消息，并且向移动端发送结构化数据（Caps）或二进制流（byte[]）实现双向通信。

开发环境介绍



# 打开ADB

使用Rokid CXR-S SDK 时，需要通过Rokid AI APP打开Rokid Glasses 上的adb。

![img](https://ota.rokidcdn.com/toB/Document/CXR/1.0.1/0.jpg)

![img](https://ota.rokidcdn.com/toB/Document/CXR/1.0.1/1.jpg)

![img](https://ota.rokidcdn.com/toB/Document/CXR/1.0.1/2.jpg)

![img](https://ota.rokidcdn.com/toB/Document/CXR/1.0.1/3.jpg)

# 使用专用开发线

Rokid Glasses 的磁吸充电口，也可以作为数据口使用。需要使用专门的开发线。

***Tips：默认购买的产品中只有充电线，如果需要开发线，请联系开发者小助理\***

SDK接入



**本章节以使用Kotlin DSL（build.gradle.kts）为例**

# 配置Maven 仓库

CXR-S SDK 采用Maven 在线管理SDK Package。

Maven 仓库地址:（“https://maven.rokid.com/repository/maven-public/”）

找到settings.gradle.kts，并在`dependencyResolutionManagement`节点的`repositories` 中添加Maven仓库。

![cxr_s_sdk_maven](https://ota.rokidcdn.com/toB/Document/mavenSettings.png)

```kotlin
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        maven {
            url = uri("https://maven.rokid.com/repository/maven-public/")
        }
        mavenCentral()
    }
}

rootProject.name = "CXRServiceDemo"
include(":app")
 
```

# 依赖导入

CXR-S SDK Package（“com.rokid.cxr:cxr-service-bridge:1.0-20250519.061355-45”）。

在build.gradle.kts 的`dependencies` 节点中添加依赖。

***注意：SDK 需要设置minSdk≥28\***。

```kotlin
//...Other Settings
android {
    //...Other Settings
    defaultConfig {
        //...Other Settings
        minSdk = 28
    }
   //...Other Settings
    
}
dependencies {
   //...Other Settings
    implementation("com.rokid.cxr:cxr-service-bridge:1.0-20250519.061355-45")
}
```

连接状态管理



**在阅读本章节前，请注意已明确《SDK 导入》章节内容**

# 监听移动端连接状态

CXR-S SDK 可以通过设置`StatusListener`监听来自移动端的连接状态。

```kotlin
private val TAG = "StatusListener"
private val cxrBridge = CXRServiceBridge()
//  连接状态监听
private val statusListener by lazy {
    object : CXRServiceBridge.StatusListener {
        // 连接成功回调
        override fun onConnected(name: String, type: Int) {    
            Log.d(TAG, "Connected to $name $type")
        }
        // 断开连接回调
        override fun onDisconnected() {
            Log.d(TAG, "Disconnected")
        }
        // ARTC状态更新
        override fun onARTCStatus(health: Float, reset: Boolean) {
            Log.d(TAG, "ARTC Status: Health: ${(health * 100).toInt()}%")
        }
    }
}
fun setStatusListener() {
    cxrBridge.setStatusListener(statusListener)
}
```

**参数说明：**

- `name`: 设备名称

- `type`: 设备类型（1-Android，2-iPhone，3-Unknown）

- `health`: 成功发送的ARTC帧百分比（0.0-1.0）

- `reset`: 是否发生了帧队列重置

  消息订阅

  CXR-S SDK 提供两种消息订阅模式，允许眼镜端应用接收来自移动设备的消息：

  1. **普通消息订阅**：单向接收消息
  2. **可回复消息订阅**：接收消息并可发送响应

  # 1 普通消息订阅

  开发者可通过 CXR-S SDK 的 `subscribe(String name, MsgCallback cb)` 方法订阅眼镜端消息。当移动端发送消息时，SDK 会通过 `MsgCallback` 接口的 `onReceive(String name, Caps args, byte[] data)` 回调通知开发者，其中包含消息名称、结构化参数（Caps）及二进制数据（可选）

  ## 1.1 订阅方法

  ```kotlin
  int subscribe(String name, MsgCallback cb)
  ```

  **参数**：

  - `name`：要订阅的消息名称（需与移动端发送的消息名称一致）
  - `cb`：消息回调接口实现

  **返回值**：

  - `0`：订阅成功
  - `-1`：参数错误
  - `-2`：重复订阅

  ## 1.2 回调接口

  ```kotlin
  interface MsgCallback {
      void onReceive(String name, Caps args, byte[] value);
  }
  ```

  **回调参数**：

  - `name`：消息名称
  - `args`：消息参数（Caps 格式）
  - `value`：附加二进制数据，可能为空

  ## 1.3 示例代码

  ```kotlin
   private val cxrBridge = CXRServiceBridge()
  //实现回调接口
  private val msgCallback = object : CXRServiceBridge.MsgCallback {
      override fun onReceive(name: String, args: Caps, value: ByteArray?) {
         Log.i("MessageSubscribe", "Received name: $name ,args: ${args.size()} , value: ${value} ")
      }
  }
  
  //调用subscribe，订阅普通消息
  cxrBridge.subscribe("glass_test", msgCallback)
  ```

  # 2 可回复消息订阅

  开发者可通过 CXR-S SDK 的 `subscribe(String name, MsgReplyCallback cb)` 方法订阅支持回复的消息。当移动端发送消息时，SDK 将通过 `MsgReplyCallback` 接口的 `onReceive(String name, Caps args, byte[] value, Reply reply)` 回调通知开发者

  ## 2.1 订阅方法

  ```kotlin
  int subscribe(String name, MsgReplyCallback cb)
  ```

  **参数说明**：

  - `name`：要订阅的消息名称（需与移动端约定一致）
  - `cb`：实现 `MsgReplyCallback` 接口的实例

  **返回值**：

  - `0`：订阅成功
  - `-1`：参数错误
  - `-2`：重复订阅

  ## 2.2 回调接口

  ```kotlin
   interface MsgReplyCallback {
      void onReceive(String name, Caps args, byte[] value, Reply reply);
  }
  ```

  **回调参数**：

  - `name`：消息名称
  - `args`：结构化参数（Caps 格式）
  - `value`：可选二进制数据，可能为空
  - `reply`：用于向移动端发送响应的 Reply 对象

  开发者可通过 `reply.end(Caps ret)` 方法返回响应数据

  ## 2.3 示例代码

  ```kotlin
  private val cxrBridge = CXRServiceBridge()
  //实现回调接口
  public val replyCallback= object :CXRServiceBridge.MsgReplyCallback {
      override fun onReceive(name: String, args: Caps, value: ByteArray?, reply: Reply?) {
          //接收消息
          Log.d("MessageSubscribe", "Received name: $name ,args: ${args.size()} , value: ${value} ")
          //构造回复消息
          val args = Caps()
          args.write("Received Message and Reply ")
          //回复消息
          reply?.end( args)
      }
  }
  //调用subscribe，订阅普通消息
  cxrBridge.subscribe("glass_test", replyCallback)
  ```

消息发送



CXR-S SDK 提供两种消息发送方法，允许眼镜端应用向连接的移动设备发送数据：

1. **基础消息发送**：发送结构化数据（Caps格式）
2. **二进制消息发送**：发送结构化数据+二进制内容

# 1 基础消息发送

## 1.1 接口定义

```kotlin
int sendMessage(String name, Caps args);
```

**参数说明**：

- `name`：消息名称（需与移动端约定一致）
- `args`：结构化消息参数（Caps对象）

**返回值**：

- `0`：发送成功
- `-1`：参数错误
- `-3`：内部错误

## 1.2 示例代码

```kotlin
//  CXRServiceBridge 已初始化并可用
val cxrServiceBridge = CXRServiceBridge()
 
fun sendExampleMessage() {
    // 1. 创建 Caps 对象并填充数据
    val args = Caps()
    args.write("send_message")  // 写入字符串消息
    args.writeUInt32(5)        // 写入一个无符号32位整数参数（示例值）
 
    // 2. 调用 sendMessage 发送消息（简化版接口）
    val result = cxrServiceBridge.sendMessage(
        "message_channel",  // 消息通道名称（根据实际协议定义）
        args                // 参数对象
    )
 
    // 3. 处理发送结果
    if (result == 0) {
        Log.d("send_message","Send message success")
    } else {
        Log.d("send_message","Send message Error: $result")
    }
}
```

# 2 二进制消息发送

## 2.1 接口定义

```kotlin
int sendMessage(String name, Caps args, byte[] data, int offset, int size);
```

**参数说明**：

- `name`：消息名称（需与移动端约定一致）
- `args`：结构化消息参数（Caps对象）
- `data`：二进制数据数组
- `offset`：数据起始偏移量
- `size`：要发送的数据长度

**返回值**：

- `0`：发送成功
- `-1`：参数错误
- `-3`：内部错误

## 2.2 示例代码

```kotlin
// 假设 CXRServiceBridge 已初始化并可用
val cxrServiceBridge = CXRServiceBridge()

fun sendExampleMessage() {
    // 1. 创建 Caps 对象并填充数据
    val args = Caps()
    args.write("send_message")  // 写入字符串消息
    args.writeUInt32(5)        // 写入一个无符号32位整数参数（示例值）

    // 2. 准备要发送的二进制数据（示例：空数据）
    val data = byteArrayOf()  // 实际场景中替换为需要发送的数据
    val offset = 0            // 数据偏移量
    val size = data.size      // 数据大小
     
    // 3. 调用 sendMessage 发送数据
    val result = cxrServiceBridge.sendMessage(
        "message_channel",  // 消息通道名称（根据实际协议定义）
        args,               // 参数对象
        data,               // 二进制数据
        offset,           // 数据起始偏移量
        size                // 数据长度
    )
     
    // 4. 处理发送结果
    if (result == 0) { 
        Log.d("send_message","Send message success")
    } else {
        Log.d("send_message","Send message Error: $result")
    }
}
```

数据结构



# Caps 数据结构

`Caps` 类是一个用于序列化和反序列化结构化数据的工具类，支持多种基本数据类型和嵌套对象。它通过链表存储数据值，并提供类型安全的访问方法。

## 主要功能

- 支持多种数据类型：布尔值、整数、浮点数、字符串、二进制数据等
- 提供序列化和反序列化功能
- 提供类型安全的访问方法

## 数据写入方法

| 方法签名                                          | 描述                            |
| ------------------------------------------------- | ------------------------------- |
| `void write(boolean v)`                           | 写入布尔值（内部转换为 uint32） |
| `void writeInt32(int v)`                          | 写入 32 位有符号整数            |
| `void writeUInt32(int v)`                         | 写入 32 位无符号整数            |
| `void writeInt64(long v)`                         | 写入 64 位有符号整数            |
| `void write(float v)`                             | 写入单精度浮点数                |
| `void write(double v)`                            | 写入双精度浮点数                |
| `void write(String v)`                            | 写入字符串                      |
| `void write(byte[] data)`                         | 写入字节数组                    |
| `void write(Caps obj)`                            | 写入嵌套的 Caps 对象            |
| `void write(byte[] data, int offset, int length)` | 写入字节数组的指定部分          |

## 数据访问方法

| 方法签名            | 描述                        |
| ------------------- | --------------------------- |
| `int size()`        | 返回存储的值数量            |
| `Value at(int idx)` | 获取指定索引处的 Value 对象 |
| `void clear()`      | 清空所有存储的值            |

## 序列化/反序列化

| 方法签名                                                     | 描述                                     |
| ------------------------------------------------------------ | ---------------------------------------- |
| `byte[] serialize()`                                         | 序列化当前数据为字节数组（native 方法）  |
| `boolean parse(byte[] input, int offset, int length)`        | 从字节数组反序列化数据（native 方法）    |
| `static Caps fromBytes(byte[] input, int offset, int length)` | 从字节数组创建 Caps 对象                 |
| `static Caps fromBytes(byte[] input)`                        | 从字节数组创建 Caps 对象（使用完整数组） |

## 使用示例

### 写入示例

```kotlin
// 1. 创建 Caps 对象并填充数据
val args = Caps()
caps.write("sendmessage");      // 写入字符串
caps.writeUInt32(5);            // 写入无符号32位整数
caps.write(true);               // 写入布尔值
caps.write(3.14f);              // 写入浮点数
```

### 读取数据示例

```kotlin
 private fun parseCapsValue(value: Caps.Value): String {
        return when (value.type()) {
            Caps.Value.TYPE_STRING -> "String: ${value.getString()}"
            Caps.Value.TYPE_INT32 -> "Int32: ${value.getInt()}"
            Caps.Value.TYPE_UINT32 -> "UInt32: ${value.getInt()}"
            Caps.Value.TYPE_INT64 -> "Int64: ${value.getLong()}"
            Caps.Value.TYPE_UINT64 -> "UInt64: ${value.getLong()}"
            Caps.Value.TYPE_FLOAT -> "Float: ${value.getFloat()}"
            Caps.Value.TYPE_DOUBLE -> "Double: ${value.getDouble()}"
            Caps.Value.TYPE_BINARY -> "Binary: ${value.getBinary().length} bytes"
            Caps.Value.TYPE_OBJECT -> "Caps Object"

            // 其他类型解析...
            else -> "Unsupported type"
        }
    }
```