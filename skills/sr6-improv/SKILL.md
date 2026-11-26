---
name: sr6-improv
description: >
  可选。只有 SR6 或 OSR2+ 已打开 Wi-Fi，并且本机 companion 已在 127.0.0.1:8787
  运行时才用。按这一轮的身体动作决定要不要动设备：要动就只 POST 一次 play，
  停、疼、结束发一次 reset。文字、生图和档案仍走 wenai。没有设备不要加载。
metadata:
  version: "1.0"
  category: 可选硬件 · SR6 / OSR2+
---

# 可选：SR6 / OSR2+（sr6-improv）

没有 SR6 或 OSR2+，或设备没开 Wi-Fi，不要用本技能。它不负责恋爱流程。旁白、生图、落盘仍按 wenai 的 SKILL.md。本文件只决定动不动、动哪一类、怎么发。

两台设备都走本机服务：`POST http://127.0.0.1:8787/command`。先在 `companion/` 里 `npm start`，再在配置页填好设备地址。OSR2+ 没有前后、左右两个平移轴，多出来的轴设备会忽略。模型不写动作脚本，不发明画名，不改行程和限速。

## 一轮

1. 先确定这一下身体在做什么。
2. 按下表决定：不发、`play`、或 `reset`。`play` 和 `reset` 同一轮只发一个。
3. 要发就用 exec 跑那一条 curl。等它返回，再写 wenai 的旁白和生图。
4. 旁白说出第 1 步那一下。不要写动画名、bpm、端口、curl、报错。

## 发不发

| 这一句在做什么 | 发什么 |
|----------------|--------|
| 只接话、亲、抱、问感受、脱衣服、玩胸玩脚，没有在刺激生殖器 | 不发 |
| 上一轮同一大类、同一档，还在那段总时长里 | 不发。再 `play` 会先减速、回中、停一秒 |
| 这句在刺激龟头，没插进去 | `play`，大类 tease |
| 插到大约一半，反复抽，不坐到底 | `play`，大类 down |
| 整根进出 | `play`，大类 long-stroke |
| 整根没入，磨根，或让他忍 | `play`，大类 grind |
| 这句已经准他射出来 | `play`，大类 short |
| 停、疼、麻、不舒服、不做了、射完要结束 | `reset` |

他求射、说快到了，但这句还没准他射：用 grind，不要用 short。
停和射抢在同一句里：发 `reset`。

喊太快：下一轮降一档。已经是 60 还喊太快：这一轮 `reset`，不 `play`。
喊太慢、快一点：下一轮升一档，100 封顶。
不要发 `speed_limit`。限速用配置页。只有 `companion/config.json` 里把 `voice.listen` 设为 true 并配好模型后，麦克风才会听「太快了 / 太慢了 / 快一点 / 慢一点 / 停下来」。

拿不准还在不在播时，可以先 `GET http://127.0.0.1:8787/debug/state`。`playing`、`braking`、`homing` 且大类没变，就不要再 `play`。查询不算那一次动画请求。

## 档位

一场里的档只有 60、80、100。选定后，每一段 bpm 只能是下面三个整数，不能取中间值。

| 档 | 这段允许的 bpm | 什么时候用 |
|----|----------------|------------|
| 60 | 50、60、70 | 开场、tease、还在适应 |
| 80 | 70、80、90 | 正常抽插、down、他已经进入状态的 grind |
| 100 | 90、100、110 | short，或他明确要更快而且上一档是 80 |

让他忍的 grind 用 60 或 80，不用 100。
第一段用档位正中（60、80 或 100）。后面每段都要和前一段的 bpm 不同。名字换了，bpm 也要换。不相邻的段可以重复同一个数。

五段的默认走法：正中，正中+10，正中−10，正中，正中+10。
60 档就是 60、70、50、60、70。

## 组片

一次 `play` 只含一个大类，正好 5 段，每段 `duration_s` 为 10。五段名字互不重复。

- long-stroke 只有 5 个名字，五个都用，顺序可变。
- short 有 6 个，每轮留一个不用，下一轮换一个留下。
- 其余大类从该表抽 5 个。不要每轮都抽同一组、同一顺序。

他这句明确要多忍一会儿：仍是 5 段、同一大类，其中几段可以写成 15，不得超过 20。服务上限是 30，不要写到 30。任何一段都不得小于 10。

跨表的三个名字（`tease-down-back`、`tease-up-down-circle-right`、`tease-up-down-circle-left`）两表都合法。大类按这一句的身体动作定，然后只从那一张表抽。

库里还有 `thrust-forward`、`thrust-forward-swirl`。不要用。

### down

从大约一半的地方反复插入。

`down-forward` · `down-backward` · `back-thrust-down` · `back-thrust-down-swirl` · `lean-forward-thrust-down` · `lean-forward-thrust-down-swirl` · `diagonal-down-back` · `diagonal-down-forward` · `tease-down-back` · `tease-up-down-circle-right` · `tease-up-down-circle-left`

### grind

完全插入，摩擦根部。要他忍的时候优先这一类。

`forward-back-grind` · `orbit-grind` · `grind-circular` · `grind-vortex` · `grind-forward-back` · `grind-forward-back-phased` · `grind-forward-back-tilt` · `grind-forward-tilt`

### tease

挑逗龟头。

`orbit-tease` · `left-right-tease` · `forward-back-tease` · `vortex-tease` · `swirl-tease` · `tease-orbit-right` · `tease-orbit-left` · `tease-left-right-rock` · `tease-down-back` · `tease-back-swirl-right` · `tease-back-swirl-left` · `tease-up-down-circle-right` · `tease-up-down-circle-left`

### long-stroke

常规整根插入。

`long-stroke-1` · `long-stroke-2` · `long-stroke-3` · `long-stroke-4` · `long-stroke-5`

### short

只有这句已经让他射出来才用。

`short-low-roll-forward` · `short-low-roll-backward` · `short-mid-roll-forward` · `short-mid-roll-backward` · `short-high-roll-backward` · `short-high-roll-forward`

## 请求

播放。不要加 `target`、`bpm_mode`、`speed_limit` 或其他字段。

```bash
curl -sS -m 5 -X POST http://127.0.0.1:8787/command \
  -H 'content-type: application/json' \
  -d '{"command":"play","clips":[{"name":"left-right-tease","bpm":60,"duration_s":10},{"name":"tease-back-swirl-right","bpm":70,"duration_s":10},{"name":"tease-back-swirl-left","bpm":60,"duration_s":10},{"name":"tease-down-back","bpm":50,"duration_s":10},{"name":"swirl-tease","bpm":60,"duration_s":10}]}'
```

上面这组是一份合法的 60 档 tease：五段同一大类、每段 10 秒、bpm 只在 50/60/70、相邻不相同。生成时仍用上一节的默认走法（正中、+10、−10、正中、+10），不要照抄这五个名字。

停：

```bash
curl -sS -m 5 -X POST http://127.0.0.1:8787/command \
  -H 'content-type: application/json' \
  -d '{"command":"reset"}'
```

返回里有 `"state"` 就是收下了。响应不等动画播完，收下就继续 wenai 的旁白。

400：名字或字段错了，这一轮什么都没动。改好再发一次，不要连发第三组。
连不上：再试一次。仍失败就不要把这句说成正在被抽插，改成不依赖设备节奏的话。不要把报错写出来。

## 旁白对照

旁白里的动作和发出去的大类必须是同一件事。

| 发出的大类 | 这句要说成 |
|------------|------------|
| tease | 舔、含、刮龟头，没插进去 |
| down | 吃进一半，反复抽，不坐到底 |
| grind | 坐到底磨根，夹着，让他忍 |
| long-stroke | 整根抽出，再整根吃进去 |
| short | 准他射，短而密地套 |
| reset | 拔出来或停下，再抱住 |

不要说设备型号、玩具、动画、档位、bpm。

## 发出前核对

- 这一轮只有一个 `play` 或一个 `reset`，或者两个都不发
- `play` 只有一个大类，5 段，名字都在该表里，互不重复
- 每段 `duration_s` ≥ 10，默认 10，忍久了也不超过 20
- bpm 全是该档的三个整数，相邻两段不同，第一段是档位正中
- 请求里没有多余字段
- 旁白和这个大类是同一下身体动作
