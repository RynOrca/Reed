---
name: learning-blocks
description: 正文学习块与快捷回复的完整生成规范。在讲解、出题、复习、检查理解时调用 show_learning 展示流程、对比、关键结果、推导、提示、折叠线索、术语和选择题/填空题前读取。
---

# 正文学习块（show_learning）

讲解、出题、复习时用它把关系、步骤和提问放进正文；纯文字段落继续用 Markdown。完整字段与示例见本文件，动手前读一遍可以少走弯路。

## 一、先记住三条硬规则

1. **必须发起真正的工具调用**。`show_learning` 是一个函数工具：在回复过程中调用它，参数是 JSON 对象。把 `<show_learning ...>` 或 `blocks="[...]"` 当作文字写进正文是错的——用户只会看到一串代码，看不到任何组件。实测最稳的写法是标准函数调用：`blocks` 是双引号 JSON 数组，字符串里的 LaTeX 反斜杠按 JSON 规则转义（`"\\equiv"`）；不要用单引号 Python 字面量、不要用 `True/False`。确实无法调用工具时，宁可用普通 Markdown 讲解，也不要输出标记文字。
2. **块跟着正文走**。在同一轮回复里按顺序穿插：先写一段 Markdown 讲解 → 调用 show_learning 放图解或提问 → 再继续写讲解。不要把所有块堆在整条回复的最后。
3. **需要用户回答时，一定用 choices 或 fill**，不要在正文里写“你觉得呢？”然后等用户打字。用户要么点选项、要么填一个空，提交后作为一条正常用户消息发回给你。

## 二、顶层参数

```json
{
  "schemaVersion": 1,
  "fallbackText": "整条消息的可读文字版本：组件无法显示时用户仍能读懂。",
  "blocks": []
}
```

- 每轮最多 8 个块，其中 choices/fill 合计最多 1 个（一次只问一个问题）。
- `blocks` 是**平铺的一维数组**：只有 `flow`、`compare`、`result`、`derivation`、`callout`、`reveal`、`term`、`choices`、`fill` 这九种类型。不要把块嵌进另一个块（例如在块里再写 `nodes`、`items`、`columns`、`blocks`），也不要自造 `type`；参数校验会直接拒绝整次调用。
- 每个块都有 `id`（字母数字，本消息内唯一）、`type`、`fallbackText`（该块的可读降级文字）。
- 可选 `source`：仅当内容来自 search_notes 返回的原文时使用，`{"label":"笔记名 · 第N行","url":"summon-file:...%23L12"}`，url 必须原样复制检索结果，不能自己拼路径。
- 公式：`derivation.expression` 写不含分隔符的 LaTeX（如 `c_1c_2 \\equiv g^{m_1+m_2} \\pmod{n^{2}}`）；正文与其他字段的行内公式用 `$...$`，独立公式用 `$$...$$`。数学一律 LaTeX，不要写 `c1*c2 mod n^2` 这种纯文本公式。不要输出 HTML 或脚本。

## 三、九种块怎么写

| 用它的场合 | type | 必填内容 |
| --- | --- | --- |
| 顺序、因果、数据流 | `flow` | `title`、`nodes[{label,value,note?}]`；纵向时间线加 `layout:"timeline"` |
| 易混概念并排比较 | `compare` | `title`、`columns[{title,body}]`（2–3 列，比较维度要一致） |
| 输入/中间量/输出与不变量 | `result` | `title`、`items[{label,value,note?}]`、可选 `conclusion` |
| 分步推导，公式配依据 | `derivation` | `title`、`steps[{expression,reason}]`（每步都要写清为什么） |
| 易错点、适用条件提醒 | `callout` | `title`、`text`、可选 `tone:"note"｜"warning"` |
| 默认折叠的线索（不发送消息） | `reveal` | `title`、`text` |
| 术语就地解释 | `term` | `term`、`definition`、可选 `before`/`after`（同一句话里的前后文） |
| 让用户选择回答 | `choices` | `title`、`options[{id,label,replyText}]` |
| 让用户填一个空 | `fill` | `title`、`label`（要填的字段或等号左侧）、可选 `placeholder`/`multiline` |

### 数学用 LaTeX，技术字段用代码格式

仅真正的数学表达式使用 LaTeX。字段名、API 参数、函数名、路径和代码用 Markdown 反引号，例如 `raw_content`、`followup_questions`；不要把含下划线的技术名称写成公式。所有字段（不只是 `derivation.expression`）里的数学都写成 LaTeX：标题、`nodes[].label/value/note`、`items[].value`、`columns[].body`、`reason`、`definition`、选项文字、`fill.label` 都一样。行内公式用 `$...$`（例如 `label: "$c_1 c_2 \\bmod n^2$"`、`value: "$m_1 + m_2$"`），独立公式用 `$$...$$`；**不要写 `c1*c2 mod n^2`、`n^2` 这样的纯文本公式，也不要用全角 `＝`**。`fill.label` 写成 `"$c_{\\mathrm{sum}} =$"` 这种等号在公式里的形式。单位与普通文字留在公式外面，例如 `"$n = 15$，模数"`。

单独成行的 `$$...$$` 会居中排布，适合放「一个恒等式撑起整个算法」这种关键式子；正文里的行内公式跟随文字。

### 重点标记

需要点出关键结论、易错处或术语时，用 `==高亮==`（浅色底）或 `++虚线下划线++`；两者都可以在正文和其它字段里用，不要整段都标。深浅主题各有配色，不用自己描述颜色。

`choices` 的每个选项点击后发送的是 `replyText`，写成用户会真实说出口的完整句子，例如“我算出来明文是 3，因为它满足条件”。`fill` 只有一个输入框，用户点“提交回答”才发送。

每个选项必须同时提供 `id`、`label`、`replyText`，例如 `{"id":"a","label":"先看总结","replyText":"请先帮我总结重点，我再写笔记。"}`。`id` 在该题内唯一，`label` 是按钮上显示的短文字；不要只写 `replyText`。需要重读规范时，使用技能目录中给出的完整 `SKILL.md` 路径，不要把技能 ID（如 `builtin-learning-blocks`）当作当前项目的相对目录。

## 四、完整调用示例

讲解同态加法并把“为什么密文相乘等于明文相加”摊开，最后问一个选择题：

```json
{
  "schemaVersion": 1,
  "fallbackText": "密文相乘等于明文相加：$c_1c_2 = g^{m_1+m_2}(r_1r_2)^n \\bmod n^2$，解密后得到 $m_1+m_2$。",
  "blocks": [
    {
      "id": "derive-hom",
      "type": "derivation",
      "title": "为什么密文相乘等于明文相加",
      "fallbackText": "两个密文相乘后指数相加，解密即得明文之和。",
      "steps": [
        {"expression": "c_1c_2 \\equiv g^{m_1}r_1^{n}\\cdot g^{m_2}r_2^{n} \\pmod{n^{2}}", "reason": "代入加密公式 $c = g^m r^n$，两个密文直接相乘"},
        {"expression": "\\equiv g^{m_1+m_2}\\,(r_1r_2)^{n} \\pmod{n^{2}}", "reason": "同底数幂相乘，指数相加；$r_1r_2$ 仍与 $n$ 互质，仍是合法随机掩码"},
        {"expression": "D(c_1c_2) = m_1 + m_2 \\bmod n", "reason": "结果与「加密 $m_1+m_2$ 所得密文」形式完全一致，解密即得明文之和"}
      ]
    },
    {"id": "purpose", "type": "callout", "title": "能力边界", "fallbackText": "仅支持密文相加与密文乘标量，不支持两个未知明文相乘。", "text": "只支持密文相加 $E(m_1)\\cdot E(m_2) \\to m_1+m_2$ 与密文乘标量 $E(m)^k \\to m\\cdot k$，不支持两个未知明文之间的同态乘法，因此是加法部分同态（PHE）。", "tone": "note"},
    {
      "id": "check",
      "type": "choices",
      "title": "如果先做 $c_1\\cdot c_2$，再对结果乘 $3$，解密会得到什么？",
      "fallbackText": "请选择：$3(m_1+m_2)$／$m_1+m_2+3$／无法判断。",
      "options": [
        {"id": "a", "label": "$3(m_1+m_2)$", "replyText": "我选 $3(m_1+m_2)$：密文乘 3 相当于明文加三次。"},
        {"id": "b", "label": "$m_1+m_2+3$", "replyText": "我选 $m_1+m_2+3$：密文乘 3 相当于明文加 3。"},
        {"id": "c", "label": "不确定", "replyText": "我还不确定标量乘法怎么作用到明文。"}
      ]
    }
  ]
}
```

对应的正文写法（文字和图解交替，而不是先写完再塞组件）：

> 你笔记里公式已经记全了，所以我换个重点：讲**为什么**这些公式成立。
>
> （此处调用 show_learning：derivation + callout）
>
> 注意这两步的差别在指数位置：加法藏在指数里，所以密文世界的乘法对应明文世界的加法。
>
> （此处调用 show_learning：choices）
>
> 选完告诉我理由，我再按你的思路补一个变式。

## 五、不要这样

- 不要在正文里粘贴 `<show_learning>` 标签、JSON 字符串或代码块来“表示”组件。
- 不要在用户作答前把参考答案写进同一个块或紧邻的正文里；`reveal` 默认折叠，不当作已掌握。
- 不要一次问多个问题，也不要用 choices 凑版面（“懂了/没懂”这类没有判定依据的选项不要单独出题）。
- 不要编造 `source`，也不要给块加自定义字段（校验会拒绝，整块降级为文字）；块的顺序就是你在正文里想要的出现顺序。
- 不要为了展示组件而强行提问；简单回答只用文字。
