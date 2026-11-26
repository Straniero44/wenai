# companion

本地运动服务，给已经打开 Wi-Fi 的 SR6 或 OSR2+ 用。没有设备不必启动。进程只绑定 `127.0.0.1`，默认端口 `8787`。启动后进入 `idle`，不会自动播放。

模型每次交互只发一个 `POST /command`，指令只能是 `play`、`reset`、`speed_limit`。响应在指令被接受时返回，不等待动画播完。响应字段与 `GET /debug/state` 相同。

## 启动

在 `companion/` 目录：

```bash
npm start
```

配置文件是 `companion/config.json`。文件不存在时使用内置默认值：HTTP `127.0.0.1:8787`，UDP `tcode.local:8000`，速度上限打开、数值 `5`、天花板 `10`，六轴行程 `0.20–0.80`。仓库里这份文件的主机是 `tcode.local`，`voice.listen` 是 false。有设备时在配置页改地址。进程启动时如果文件里的限速是关着的，会改成打开并且数值为 5，再写回文件。

`http.host` 只能是 `127.0.0.1`。要改服务端口，修改 `http.port` 后重启。限速、行程和设备地址可以在配置页里改，立即生效并写回这个文件。发送周期 `udp.intervalMs` 改完后需要重启。

## 配置界面

浏览器打开服务根路径，例如 `http://127.0.0.1:8787/`。页面由这个进程直接提供，不另开端口。

- 最大限速是滑块，范围到 `speedCap.ceiling`。滑块只改数值。限速开着时，勾选不能关掉。
- 六个轴各有下限和上限滑块，范围是 0 到 1，两端不能相同。
- 设备主机和 UDP 端口在同一页。主机留空保存为 `tcode.local`，端口留空保存为 `8000`。应用前会探测该 UDP 端口。端口拒绝连接、主机无法解析或设备没有响应时，页面报错，不改当前连接，也不写入配置文件。探测通过后才重新连接。

页面读写 `GET /api/config` 和 `POST /api/config`。模型的 `POST /command` 仍然只有播放、复位和限速，不能在那条请求里改地址。

## 语音

`node src/main.js` 或 `npm start` 起来之后，本机麦克风持续听。`config.json` 里 `voice.listen` 为 false 时不听。模型目录和 Python 解释器是 `voice.modelDir`、`voice.python`。缺模型或缺麦只打日志，服务照常接受播放和复位。

听到的句子交给词表。认「太快了」「太慢了」「快一点」「慢一点」「停下来」，以及「太快啦」「有点太快了」「再快一点」「快一些」「停下」「停止」这类说法。否定句和多出来的话不算，例如「不要太快了」「快一点告诉我」。同一句两秒内不重复执行，停下来除外。

太快了把限速设为 2，太慢了设为 5。快一点、慢一点各走一档整数，范围是 1 到天花板。停下来先把运行中的限速设为 2 再复位，回到空闲后写成 5。中途有新的语音指令，或限速被 `speed_limit` 关掉，就不再写成 5。没配模型时只打日志，播放和复位照常。

## 指令

`POST /command`，`Content-Type: application/json`。

播放一项或多项。省略 `bpm` 时为 60，省略 `duration_s` 时为 30 秒。正在播放时再次 `play`，先把速度临时限到 1 满量程单位/秒并继续当前动画 1 秒，再回中，停 1 秒后才播新列表。新动画开始 1 秒后才恢复原来的限速。这段临时限速不会写入配置。一段或一组全部播完后会自动回中，然后进入空闲。段与段之间不回中。

```json
{
  "command": "play",
  "clips": [
    { "name": "orbit-grind" },
    { "name": "long-stroke-1", "bpm": 45, "duration_s": 20 }
  ]
}
```

只回中，完成后进入 `idle`：

```json
{ "command": "reset" }
```

打开夹紧，或关闭夹紧并保留已保存的数值。数值必须大于 0，且不能超过 `speedCap.ceiling`。这条指令不打断当前动画。配置页不能把限速关掉，只有这条指令的 `enabled: false` 可以。

```json
{ "command": "speed_limit", "max_units_per_second": 2.0 }
```

```json
{ "command": "speed_limit", "enabled": false }
```

未知指令、未知字段、未知动画名、空的 `clips`、越界数值都返回 400，并且不执行动作。

## 目标

三条指令都接受一个 `target` 字段，决定这一次报文发到哪里。

```json
{ "command": "play", "clips": [{ "name": "orbit-grind" }], "target": "emulator" }
```

| `target` | 发往 |
| --- | --- |
| 省略 | `config.json` 的 `udp.host:udp.port`，即真机 |
| `"tcode.local"` | 同上 |
| `"emulator"` | `config.json` 的 `emulator.host:emulator.port`，默认 `127.0.0.1:8000` |

只认这两个值，其它（包括 IP、主机名）返回 400 且不执行动作。这是有意的：请求本身不能把服务指向任意地址。

`target` 只作用于当次请求。下一次不带它就回到真机。

模拟器那条路径走独立的未连接 UDP 套接字，桥没起时不会产生错误，也不会把会话打进 `fault`。真机的发送路径和错误处理没有改动。

## 调试

这两条只查询，不会开始播放。

- `GET /debug/strokes`：42 个动画名，`{ "strokes": [ ... ] }`
- `GET /debug/state`：状态、队列、当前片段、BPM、参数、速度上限、UDP 目标、最后一次错误。不含 TCode 原文。

## 依赖

只依赖 Node.js 内置模块和本目录里的文件：没有 `npm install`，没有第三方包，也不读
`../ayvajs`、`../MultiFunPlayer` 或仓库外任何路径。

动画库在 `vendor/ayvajs/`，是 ayvajs 0.19.0 的源码副本（MIT，出处和升级步骤见该目录的
`README.md`）。TCode 组包、`I` 间隔和速度夹紧在 `src/udp-output.js` 里，按 MultiFunPlayer
的 UDP 输出行为实现，不加载它的代码。

把 `companion/` 单独拷走（连同 `config.json`）就能 `npm start`。测试同样不需要参考目录。

## 测试

不连接设备。测试注入假的会话和 UDP。

```bash
cd companion
npm test
```

`test/dependency.test.js` 额外守住依赖边界：相对 import 不得越出 `companion/`、源码里不得出现
本机绝对路径、内置 ayvajs 能真跑一段动画。
