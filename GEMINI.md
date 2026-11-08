# RedNote Manager 项目规范与记忆

## 提交与发布工作流规则
1. **自动 Git Commit**：每次功能更新或 Bug 修复并通过测试后，可以自动执行 `git commit`（及推送到远程 `origin/main`），保持代码库同步。
2. **不自动发布 Release**：平时更新代码时**不要**自动创建 GitHub Release / Git Tag，仅在用户明确提出发布 Release 需求时再执行。
3. **不自动打包商店 dist 包**：日常更新时**不要**自动运行 `npm run package` 生成 `dist/` 压缩包（应用商店 `cws.zip` 与发布包）。仅在用户明确需要发包时再执行。
