<p align="center">
  <b>🔮 openclaw-mesync</b>
  <br/>
  <sub>mesync 记忆引擎的 OpenClaw 插件：决策 / 认知 / 品味三概念 + 因果链结构化记忆</sub>
</p>

ocms（openclaw-mesync）是 mesync「决策、认知、品味」三概念核心在 **OpenClaw 场景**下的插件实现，面向 **Agent 本体**（而非单一写代码场景）。

---

## 核心能力

- **决策（Decision）**：结构化存储于 SQLite，以因果链（caused_by / supersedes）串联，支持**向量检索**。
- **认知（Cognition）**：Agent「世界是怎么运作的」知识，Markdown 存储。
- **品味（Taste）**：用户/Agent 的审美与判断倾向，Markdown 存储。

**回复前**通过 Active Memory 向量检索相关决策并注入；**回复后**通过 `agent_end` 钩子自动提取并更新三概念。

---

## 设计

完整设计见 [DESIGN.md](./DESIGN.md)。

---

## License

[MIT](./LICENSE) © 2026 wenliangw
