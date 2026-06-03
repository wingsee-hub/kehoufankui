require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- 测试路由：访问根路径时返回简单文字 ----------
app.get('/', (req, res) => {
  res.send('Hello from backend. Server is running.');
});

// ---------- 用户次数存储（内存） ----------
const userCredits = {};

function ensureUser(userId) {
  if (!userCredits[userId]) {
    userCredits[userId] = 10;
    console.log(`新用户 ${userId}，赠送 10 次`);
  }
  return userCredits[userId];
}

// ---------- 调用 DeepSeek API ----------
async function callDeepSeek(messages, maxTokens = 800) {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.6,
      max_tokens: maxTokens
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API 错误 ${response.status}: ${errText}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ---------- 查询剩余次数 ----------
app.get('/api/credits', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: '缺少 userId' });
  res.json({ credits: userCredits[userId] ?? 10 });
});

// ---------- 管理员增加次数 ----------
app.post('/api/add-credits', (req, res) => {
  const { userId, amount, adminSecret } = req.body;
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: '无效的管理员密钥' });
  }
  if (!userId || typeof amount !== 'number') {
    return res.status(400).json({ error: '参数错误' });
  }
  if (!userCredits[userId]) userCredits[userId] = 0;
  userCredits[userId] += amount;
  console.log(`用户 ${userId} 增加 ${amount} 次，当前剩余 ${userCredits[userId]}`);
  res.json({ success: true, newCredits: userCredits[userId] });
});

// ---------- 生成反馈 ----------
app.post('/api/generate', async (req, res) => {
  const { userId, prompt, style, wordCount } = req.body;
  if (!userId || !prompt) return res.status(400).json({ error: '缺少参数' });
  ensureUser(userId);
  if (userCredits[userId] <= 0) {
    return res.status(402).json({ error: '次数不足，请联系管理员充值' });
  }
  try {
    let systemContent = '你是语文教育专家，请撰写家长反馈。';
    if (style === 'formal') systemContent += ' 风格正式专业。';
    else if (style === 'friendly') systemContent += ' 风格温和亲切。';
    else if (style === 'brief') systemContent += ' 风格简洁有力。';
    else if (style === 'literary') systemContent += ' 风格文艺得体。';
    systemContent += ' 禁止使用Markdown格式，纯文本输出。';
    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: prompt }
    ];
    const maxTokens = Math.min(wordCount + 300, 2000);
    const content = await callDeepSeek(messages, maxTokens);
    userCredits[userId]--;
    res.json({ success: true, content, remaining: userCredits[userId] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `生成失败: ${err.message}` });
  }
});

// ---------- 作业批改 ----------
app.post('/api/analyze', async (req, res) => {
  const { userId, ocrText, provideAnswer, answerText } = req.body;
  if (!userId || !ocrText) return res.status(400).json({ error: '缺少参数' });
  ensureUser(userId);
  if (userCredits[userId] <= 0) {
    return res.status(402).json({ error: '次数不足，请联系管理员充值' });
  }
  let prompt = `你是一位语文作业批改专家。请根据以下作业内容进行逐题批改，分析每道题的对错，给出理由和建议。`;
  if (provideAnswer && answerText) {
    prompt += ` 参考答案如下：${answerText}`;
  } else {
    prompt += ` 未提供参考答案，请自主判断题目对错并给出合理解析。`;
  }
  prompt += ` 作业文本：${ocrText}。请以清晰段落输出批改结果。`;
  try {
    const messages = [
      { role: 'system', content: '你严格批改语文作业，指出对错并解释。输出纯文本。' },
      { role: 'user', content: prompt }
    ];
    const analysis = await callDeepSeek(messages, 1200);
    userCredits[userId]--;
    res.json({ success: true, analysis, remaining: userCredits[userId] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `批改失败: ${err.message}` });
  }
});

// ---------- 管理员页面 ----------
app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>充值管理</title><meta charset="UTF-8"></head>
    <body>
      <h2>管理员充值</h2>
      <p>当前用户次数存储（内存，重启后丢失）</p>
      <pre>${JSON.stringify(userCredits, null, 2)}</pre>
      <hr/>
      <h3>增加次数</h3>
      <input id="userId" placeholder="用户ID" />
      <input id="amount" placeholder="增加次数" type="number" />
      <button onclick="add()">增加</button>
      <script>
        async function add(){
          const userId = document.getElementById('userId').value;
          const amount = parseInt(document.getElementById('amount').value);
          const adminSecret = prompt('管理员密钥');
          const res = await fetch('/api/add-credits', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ userId, amount, adminSecret })
          });
          const data = await res.json();
          alert(data.success ? '成功，剩余次数：'+data.newCredits : '失败：'+data.error);
          location.reload();
        }
      </script>
    </body>
    </html>
  `);
});

// ---------- 健康检查 ----------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------- 关键修改：动态端口监听，使用 Railway 注入的 PORT 环境变量 ----------
const PORT = process.env.PORT || 3000;

let server;
try {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[startup] 后端运行在 http://0.0.0.0:${PORT}`);
    console.log(`[startup] NODE_ENV = ${process.env.NODE_ENV || 'development'}`);
    console.log(`[startup] PID = ${process.pid}`);
  });
} catch (err) {
  console.error('[FATAL] 服务器启动失败:', err);
  process.exit(1);
}

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信号，正在关闭服务器...');
  if (server) {
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});
