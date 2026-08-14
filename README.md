# 在线双人五子棋

一个基于 FastAPI、WebSocket 和原生 HTML/CSS/JavaScript 开发的在线双人五子棋项目，支持手机浏览器与桌面浏览器。

玩家登录后可以创建房间或输入房间号加入对局。棋盘、聊天、倒计时和胜负状态均通过 WebSocket 实时同步。

## 功能

### 对局功能

- 15×15 个合法交叉点的五子棋棋盘
- 两人房间，第一名玩家执黑，第二名玩家执白
- 黑棋先手，服务端验证回合及落子位置
- 横向、纵向和两种斜线五连判断
- 棋盘填满后判定平局
- 每回合 60 秒倒计时及超时判负
- 手机端二次点击确认落子，减少误触
- 游戏结束结果弹层
- 双方确认后再来一局，每局交换黑白棋

### 实时通信

- WebSocket 同步棋盘、回合、倒计时和比赛结果
- 实时文字聊天
- 快捷聊天按钮
- 手机端临时消息气泡
- 新一局开始时清空本局聊天记录
- 聊天内容不会写入长期历史数据库

### 账号和权限

- 登录后才能创建、加入房间或连接 WebSocket
- bcrypt 密码哈希，数据库不保存明文密码
- HttpOnly、SameSite=Lax 的签名 Session Cookie
- `developer` 和 `user` 两种角色
- Developer 可以创建账号、重置密码、停用和启用账号
- 普通用户无法访问 Developer 页面或管理 API
- 唯一启用中的 Developer 账号不能被停用

### 对局历史

- 自动保存五连、超时和平局结果
- 保存完整落子顺序，为以后开发棋局复盘预留数据
- 普通用户只能查看自己参与的对局
- Developer 可以查看所有用户对局
- 支持按用户名、房间号、日期和结束方式筛选
- 历史详情展示只读终局棋盘和落子记录
- 同一房间连续多局会生成独立历史记录
- `game_id UNIQUE` 防止重复保存

## 技术栈

- 后端：Python 3.12、FastAPI
- 实时通信：WebSocket
- 数据库：SQLite
- 密码哈希：bcrypt
- Session：Starlette SessionMiddleware
- 前端：HTML、CSS、原生 JavaScript
- 部署：Docker、Docker Compose

## 项目结构

```text
wuziqi/
├── backend/
│   ├── auth.py          # Session 和权限验证
│   ├── config.py        # 加载项目根目录 .env
│   ├── database.py      # 用户、历史表及数据库操作
│   ├── game.py          # 五子棋规则与胜负判断
│   ├── main.py          # FastAPI 应用和 HTTP/WebSocket 路由
│   ├── room.py          # 房间、计时、再来一局及历史结算
│   └── websocket.py     # WebSocket 消息处理
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── tests/
│   ├── test_auth.py
│   ├── test_game.py
│   ├── test_history.py
│   └── test_room.py
├── .env.example
├── docker-compose.yml
├── Dockerfile
└── requirements.txt
```

## Docker 部署

### 1. 克隆项目

```bash
git clone https://github.com/xxtc6629-pixel/git.git
cd git
```

### 2. 创建环境变量文件

```bash
cp .env.example .env
```

编辑 `.env`：

```env
ADMIN_USERNAME=Lxn
ADMIN_INITIAL_PASSWORD=请设置一个安全的初始密码
SESSION_SECRET=请设置一个足够长的随机字符串
COOKIE_SECURE=false
```

可以使用下面的命令生成 Session 密钥：

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

注意：

- `.env` 已被 Git 忽略，不要提交真实密码或密钥。
- `ADMIN_INITIAL_PASSWORD` 只在管理员账号不存在时使用。
- 管理员已经存在时，重启服务不会重置其密码。
- HTTPS 部署时应设置 `COOKIE_SECURE=true`。

### 3. 启动服务

```bash
docker compose up -d --build
```

默认访问地址：

```text
http://服务器IP:8000
```

查看日志：

```bash
docker compose logs -f
```

停止服务：

```bash
docker compose down
```

SQLite 数据保存在 Docker 命名卷 `gomoku-data` 中。普通的容器重新创建或服务器重启不会清除账号和对局历史。

如果明确需要同时删除数据库，请谨慎执行：

```bash
docker compose down -v
```

## Linux 本地运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env 后启动
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Windows PowerShell 激活虚拟环境：

```powershell
.\.venv\Scripts\Activate.ps1
```

## 初始管理员

应用启动时会执行以下流程：

1. 加载项目根目录 `.env`。
2. 打开 `data/gomoku.db`。
3. 创建不存在的数据库表。
4. 查询 `ADMIN_USERNAME` 是否已存在。
5. 仅在账号不存在时，用 bcrypt 哈希后的密码创建 Developer。

登录 Developer 账号后，可以在“开发者管理”中创建供朋友使用的普通账号。

## 数据库

主要数据表：

- `users`：账号、密码哈希、角色、状态和创建时间
- `game_history`：每局的玩家、胜者、结束原因、时间和总手数
- `game_moves`：每一步的玩家、棋色、坐标和落子时间

房间和正在进行的棋局保存在服务进程内存中，服务重启后未完成的对局不会恢复；已经完成并写入 SQLite 的历史记录不会丢失。

## 页面和权限

- `/`：登录页或游戏首页
- `/history`：当前用户的对局历史
- `/history/{game_id}`：单局历史详情
- `/admin`：Developer 账号管理
- `/admin/history`：Developer 全部对局

历史详情和管理权限均由服务器端验证。仅隐藏前端按钮不会被视为权限保护。

## 运行测试

```bash
python -m unittest discover -s tests -v
```

当前测试覆盖：

- 五连、错误回合和重复位置
- 超时判负及倒计时重置
- 再来一局和棋色交换
- 正确及错误密码登录
- 未登录 HTTP/WebSocket 拒绝访问
- Developer 权限及账号停用
- 历史记录、完整落子顺序和防重复保存
- 普通用户历史权限隔离
- Developer 全部历史查询
- 通过 moves 重建最终棋盘

## 生产部署建议

- 使用 Nginx 或 Caddy 配置 HTTPS
- 反向代理必须支持 WebSocket Upgrade
- 设置强随机 `SESSION_SECRET`
- 设置 `COOKIE_SECURE=true`
- 定期备份 Docker 卷中的 `/data/gomoku.db`
- 不要将 `.env`、数据库文件或密码提交到 Git

## 当前范围

这是一个个人学习项目和可部署 MVP，当前不包含：

- 用户自助注册
- AI 对手
- 排行榜
- 禁手规则
- 动画棋局复盘播放器

## License

本项目暂未指定开源许可证。
