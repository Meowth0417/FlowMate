# FlowMate

FlowMate 是一个面向研发协作的多阶段流程原型，把一个需求串成统一工作流：**需求理解 -> 详细设计 -> 前后端开发 -> 功能验证 -> 代码审查 -> 交付沉淀**。

## 项目做了什么

- 用任务流把产品、前端、后端、观察者串在一起，支持按阶段推进、确认、补充、驳回和回流
- 支持前后端分支并行开发，并在开发阶段绑定本地仓库路径
- 支持阶段提示词、过程展示、阶段产物沉淀和时间线记录
- 提供 Agent 选择器，并从本机环境探测 Copilot / Claude / Codex / Gemini 的安装与模型信息
- 使用本地 SQLite 持久化数据

> 当前仍是 **原型**：阶段执行过程和产物生成是内置 mock 流程，尚未真正调用这些 CLI 去完成实际编码。

## 怎么用

1. 打开页面后选择一个演示用户
2. 创建任务，填写标题、描述和负责人
3. 在每个阶段填写提示词、选择 Agent，然后点击“开始执行”
4. 根据阶段结果继续确认、补充、功能验证、代码审查或交付
5. 到前端 / 后端开发阶段时，可绑定本地仓库目录

## 怎么启动

要求：**Node.js 20+**

### 1. 启动后端

```bash
cd server
npm install
npm run dev
```

- 默认地址：`http://localhost:8787`
- 健康检查：`http://localhost:8787/health`
- 数据文件：`server/data/flowmate-v3.sqlite`

### 2. 启动前端

```bash
cd web
npm install
npm run dev
```

- 默认地址：`http://localhost:5173`

### 3. 打开系统

浏览器访问：

```text
http://localhost:5173
```

前端默认会请求同机 `8787` 端口的后端接口。

## 目录

```text
server/  Fastify + SQLite 后端
web/     React + Vite 前端
docs/    设计与 PRD 文档
```
