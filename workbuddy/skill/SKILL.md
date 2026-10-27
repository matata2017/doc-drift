---
name: doc-drift
description: 检查需求、文档、代码是否一致（文档漂移）：过时的代码引用、说已删除却还在、断链与错误路径、代码改了文档没跟上、没有文档的接口；初始化项目文档状态，体检出报告，按确认结果修文档，记录结论。用户说"检查文档漂移""文档和代码对不上""体检文档""同步文档"时使用。
---

# doc-drift

## 运行方式

脚本在本技能目录下：`scripts/bin/doc-drift.mjs`（加载本技能时会给出技能所在目录；也可以用 Glob 搜 `**/doc-drift/scripts/bin/doc-drift.mjs`）。

```
node "<技能目录>/scripts/bin/doc-drift.mjs" <命令> --root "<项目根目录>"
```

- 先运行 `node -v`。没有 node 时，用 WorkBuddy 自带的：Glob 搜 `~/.workbuddy/binaries/node/versions/*/node.exe`（Windows）或 `*/bin/node`（macOS/Linux），取版本最高的那个。需要 Node ≥ 18.17 和 git。
- 有 StartLux 密钥（环境变量 `DOC_DRIFT_API_KEY` 或 `BAMBOO_API_KEY`）时，文档分类与"内容是否过时"由 StartLux 判断；**没有密钥时加 `--no-model`**，脚本只做确定性检查，判断由你来做。
- 所有命令只读项目代码；只会在项目里写 `.doc-drift/`（配置、映射、报告、答复）。

## 命令

| 命令 | 作用 |
|---|---|
| `init [--no-model]` | 盘点文档与代码，生成 `.doc-drift/config.json`、`map.json`；有密钥时给文档分类，并列出拿不准的（按目录归组） |
| `questions` | 还没回答的问题 |
| `mark <文档或目录> <current\|historical\|archived>` | 定文档状态：current 现状（要跟代码一致）、historical 历史记录（不要求同步）、archived 已废弃 |
| `answer "<问题>" "<结论>"` | 记下用户的结论（写进 `.doc-drift/answers.md`） |
| `doctor [--no-model] [--max N] [--json]` | 全面体检，报告写到 `.doc-drift/reports/<日期>.md` |
| `ignore <F编号...>` | 这些体检项不用处理，以后不再报 |
| `status` | 概况 |
| `pending` / `resolve <P编号> <done\|skip>` | 日常钩子攒下的待办（只有装了钩子才会有） |

## 没有密钥时你要补的判断

1. **init 之后**：`status` 显示很多文档是 unknown。读 `.doc-drift/config.json` 里 `docInfo` 的路径和标题，按目录判断"现状 / 历史记录 / 已废弃"（标题带版本号、迁移、清理、切流字样的多半是历史记录），整理成问题给用户确认，再 `mark`。
2. **doctor 之后**："内容可能过时"一类只列出了"文档最后更新之后，它描述的代码又改过"的小节。逐条读文档那一节和 `git log -p --since=<文档最后修改时间> -- <相关代码文件>`，判断描述是否仍然准确；只把确实不准确的交给用户。

## 报告里各类问题的处理

- **引用已过时**：代码里已删除/改名（git 历史为证）。找现在对应的代码，改文档；没有替代就删掉或注明"已下线"。
- **说已删除但还在**：问用户——文档写错了，还是代码该删没删。
- **链接路径要改**：报告给出了相对路径，直接替换。
- **断链**：找到正确目标后改，找不到问用户。
- **找不到的引用 / 没有文档的接口**（提示级）：按用户需要处理；不需要的 `ignore`。
- 历史记录、已归档文档里的问题自动降为提示，不要求同步。

改完重跑 `doctor` 确认消掉。
