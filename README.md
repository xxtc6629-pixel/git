# 在线双人五子棋 V1.1

一个基于 FastAPI、原生 HTML/CSS/JavaScript 和 WebSocket 的双人五子棋 MVP。账号保存在 SQLite 中；房间与棋局保存在服务进程内存中，服务重启后会清空。

## Docker 启动

```bash
cp .env.example .env
# 编辑 .env：填写初始开发者密码，并为 SESSION_SECRET 生成安全随机字符串
docker compose up -d --build
```

`ADMIN_USERNAME` 默认为 `Lxn`。首次创建数据库时，服务会使用 `.env` 中的 `ADMIN_INITIAL_PASSWORD` 创建开发者账号；数据库已存在时不会用该变量覆盖密码。

可以生成 Session 密钥：

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

浏览器访问 `http://服务器IP:8000`。云服务器需在安全组/防火墙中开放 TCP 8000 端口。

生产环境建议在前面配置 Nginx/Caddy 和 HTTPS；反向代理必须允许 WebSocket Upgrade。

## 本地开发

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export ADMIN_USERNAME=Lxn
export ADMIN_INITIAL_PASSWORD='设置初始密码'
export SESSION_SECRET='设置安全随机字符串'
uvicorn backend.main:app --reload
```

运行规则测试：`python -m unittest discover -s tests -v`。

## V1.1 范围

- 六位房间号、最多两人、先到者执黑
- 15×15 棋盘、轮流落子、四方向五连与平局判断
- WebSocket 实时同步棋盘、回合、结果与聊天
- 9 个快捷聊天按钮
- 手机端固定一屏布局、动态最大棋盘与最近交叉点触摸吸附
- 二次点击确认的本地预落子，降低手机误触
- 临时聊天气泡、未读计数与覆盖式聊天 Bottom Sheet
- 对局结束弹层与双方确认的再来一局（每局交换棋色）
- 服务端权威的每回合 60 秒倒计时、超时判负与重连恢复
- 新一局开始时双方同步清空上一局聊天状态
- SQLite 游戏账号、bcrypt 密码哈希和安全 Cookie Session
- developer 账号管理：创建用户、重置密码、启用与停用
- 无用户自助注册、AI、排行榜和禁手规则

## 对局历史

- 登录用户可从首页进入 `/history`，查看自己参与且已经结束的对局。
- `/history/{game_id}` 显示对局结果、最终只读棋盘和完整落子顺序。
- Developer 可从 `/admin/history` 查看全部对局，并按用户名、房间号、日期和结束方式筛选。
- 历史记录保存在 SQLite 的 `game_history` 与 `game_moves` 表中，不保存聊天内容。
- 每局在第二名玩家加入时生成独立 `game_id`；五连、平局或超时正式结算时，以单个事务保存结果和全部落子。
- Docker 使用的 `/data/gomoku.db` 位于 `gomoku-data` 命名卷中，容器重启后历史仍然保留。
